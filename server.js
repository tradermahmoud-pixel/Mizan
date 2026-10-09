'use strict';
/* ميزان — standalone server: Postgres document store, login sessions, live sync. */
const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1|\/tmp|host=\//.test(DATABASE_URL) || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: 8,
});

const ADMIN_ONLY = new Set(['roles', 'roledefs', 'settings']);
const SESSION_DAYS = 30;
const COOKIE = 'mz_s';

/* ---------------- helpers ---------------- */
const now = () => Date.now();
const uidGen = (p = 'u_') => p + crypto.randomBytes(16).toString('base64url').slice(0, 22);
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}
function checkPw(pw, stored) {
  try {
    const [, s, h] = String(stored).split('$');
    const want = Buffer.from(h, 'base64');
    const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(want, got);
  } catch (e) { return false; }
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
/* update = shallow merge; a map field (e.g. items) is merged one level deep so each entry is replaced whole */
function mergeDoc(cur, patch) {
  const out = isObj(cur) ? { ...cur } : {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (isObj(v) && isObj(out[k])) out[k] = { ...out[k], ...v };
    else out[k] = v;
  }
  return out;
}
function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}

/* ---------------- schema ---------------- */
async function migrate() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS doc_seq;
    CREATE TABLE IF NOT EXISTS docs (
      col text NOT NULL, id text NOT NULL, data jsonb, deleted boolean NOT NULL DEFAULT false,
      seq bigint NOT NULL DEFAULT nextval('doc_seq'), updated_at bigint NOT NULL DEFAULT 0, updated_by text,
      PRIMARY KEY (col, id));
    CREATE INDEX IF NOT EXISTS docs_seq_idx ON docs (seq);
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY, username text UNIQUE NOT NULL, name text NOT NULL, pass text NOT NULL,
      owner boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false, created_at bigint NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (
      token text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at bigint NOT NULL, last_seen bigint NOT NULL);
  `);
  const { rows } = await pool.query('SELECT count(*)::int n FROM users');
  if (rows[0].n === 0) {
    const u = (process.env.ADMIN_USER || 'admin').trim().toLowerCase();
    const p = process.env.ADMIN_PASSWORD;
    if (!p || p.length < 8) { console.error('First start needs ADMIN_PASSWORD (8+ chars) to create the owner account'); process.exit(1); }
    const id = process.env.ADMIN_ID || uidGen();
    await pool.query('INSERT INTO users(id,username,name,pass,owner,created_at) VALUES($1,$2,$3,$4,true,$5)',
      [id, u, process.env.ADMIN_NAME || 'المالك', hashPw(p), now()]);
    console.log('Owner account created:', u);
  }
}

/* ---------------- auth ---------------- */
async function sessionUser(req) {
  const t = cookies(req)[COOKIE];
  if (!t || t.length < 20) return null;
  const { rows } = await pool.query(
    `SELECT u.id,u.username,u.name,u.owner,u.disabled,s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1`, [t]);
  const u = rows[0];
  if (!u || u.disabled) return null;
  if (now() - Number(u.last_seen) > SESSION_DAYS * 864e5) { await pool.query('DELETE FROM sessions WHERE token=$1', [t]); return null; }
  if (now() - Number(u.last_seen) > 3600e3) pool.query('UPDATE sessions SET last_seen=$2 WHERE token=$1', [t, now()]).catch(() => {});
  u.token = t;
  return u;
}
async function roleOf(userId) {
  const { rows } = await pool.query(`SELECT data FROM docs WHERE col='roles' AND id=$1 AND NOT deleted`, [userId]);
  return rows[0] && rows[0].data ? rows[0].data.role || '' : '';
}
async function isAdmin(u) { return u.owner || (await roleOf(u.id)) === 'full'; }
const auth = (needAdmin) => async (req, res, next) => {
  try {
    const u = await sessionUser(req);
    if (!u) return res.status(401).json({ error: 'login' });
    req.user = u;
    if (needAdmin && !(await isAdmin(u))) return res.status(403).json({ error: 'forbidden' });
    next();
  } catch (e) { next(e); }
};
function setCookie(req, res, token, maxAgeSec) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}
const attempts = new Map();
function throttled(key) {
  const a = attempts.get(key) || { n: 0, t: now() };
  if (now() - a.t > 15 * 60e3) { a.n = 0; a.t = now(); }
  return a;
}

/* ---------------- app ---------------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression({ threshold: 1024 }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use('/api', express.json({ limit: '80mb' }));
/* simple CSRF guard: state-changing API calls must come from our own pages */
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  if (req.headers['x-mizan'] !== '1') return res.status(403).json({ error: 'bad request' });
  next();
});

app.get('/healthz', (req, res) => res.send('ok'));

app.post('/api/login', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const key = req.ip + '|' + username;
    const a = throttled(key);
    if (a.n >= 8) return res.status(429).json({ error: 'محاولات كثيرة — حاول بعد ربع ساعة' });
    const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    const u = rows[0];
    if (!u || u.disabled || !checkPw(password, u.pass)) {
      a.n++; attempts.set(key, a);
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    attempts.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO sessions(token,user_id,created_at,last_seen) VALUES($1,$2,$3,$3)', [token, u.id, now()]);
    setCookie(req, res, token, SESSION_DAYS * 86400);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/logout', async (req, res) => {
  const t = cookies(req)[COOKIE];
  if (t) await pool.query('DELETE FROM sessions WHERE token=$1', [t]).catch(() => {});
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});
app.get('/api/me', auth(false), async (req, res) => {
  const u = req.user;
  res.json({ id: u.id, username: u.username, name: u.name, owner: u.owner, admin: await isAdmin(u) });
});
app.post('/api/password', auth(false), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT pass FROM users WHERE id=$1', [req.user.id]);
    if (!checkPw(String(req.body.old || ''), rows[0].pass)) return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
    const np = String(req.body.new || '');
    if (np.length < 6) return res.status(400).json({ error: 'كلمة المرور الجديدة 6 حروف على الأقل' });
    await pool.query('UPDATE users SET pass=$2 WHERE id=$1', [req.user.id, hashPw(np)]);
    await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token<>$2', [req.user.id, req.user.token]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* users: everyone logged in may see names; admins manage */
app.get('/api/users', auth(false), async (req, res) => {
  const { rows } = await pool.query('SELECT id,username,name,owner,disabled,created_at FROM users ORDER BY created_at');
  res.json(rows);
});
app.post('/api/users', auth(true), async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    const pw = String(req.body.password || '');
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: 'اسم المستخدم: 3 حروف إنجليزي أو أرقام على الأقل، بدون مسافات' });
    if (!name) return res.status(400).json({ error: 'اكتب الاسم' });
    if (pw.length < 6) return res.status(400).json({ error: 'كلمة المرور 6 حروف على الأقل' });
    const id = uidGen();
    await pool.query('INSERT INTO users(id,username,name,pass,created_at) VALUES($1,$2,$3,$4,$5)', [id, username, name, hashPw(pw), now()]);
    res.json({ id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'اسم المستخدم مستخدم بالفعل' });
    next(e);
  }
});
app.patch('/api/users/:id', auth(true), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    const t = rows[0];
    if (!t) return res.status(404).json({ error: 'غير موجود' });
    if (t.owner && !req.user.owner) return res.status(403).json({ error: 'لا يمكن تعديل حساب المالك' });
    if (t.owner && req.body.disabled) return res.status(400).json({ error: 'لا يمكن إيقاف حساب المالك' });
    if (req.body.name != null) await pool.query('UPDATE users SET name=$2 WHERE id=$1', [t.id, String(req.body.name).trim() || t.name]);
    if (req.body.password != null) {
      const pw = String(req.body.password);
      if (pw.length < 6) return res.status(400).json({ error: 'كلمة المرور 6 حروف على الأقل' });
      await pool.query('UPDATE users SET pass=$2 WHERE id=$1', [t.id, hashPw(pw)]);
      await pool.query('DELETE FROM sessions WHERE user_id=$1', [t.id]);
    }
    if (req.body.disabled != null) {
      await pool.query('UPDATE users SET disabled=$2 WHERE id=$1', [t.id, !!req.body.disabled]);
      if (req.body.disabled) await pool.query('DELETE FROM sessions WHERE user_id=$1', [t.id]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* sync: everything changed after `since` */
app.get('/api/sync', auth(false), async (req, res, next) => {
  try {
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    const { rows } = since === 0
      ? await pool.query('SELECT col,id,data,deleted,seq FROM docs WHERE NOT deleted ORDER BY seq')
      : await pool.query('SELECT col,id,data,deleted,seq FROM docs WHERE seq>$1 ORDER BY seq', [since]);
    const top = await pool.query(`SELECT COALESCE(max(seq),0)::bigint s FROM docs`);
    const seq = Number(top.rows[0].s);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const parts = ['{"seq":', String(seq), ',"full":', since === 0 ? 'true' : 'false', ',"docs":['];
    rows.forEach((r, i) => parts.push((i ? ',' : '') + JSON.stringify({ c: r.col, i: r.id, s: Number(r.seq), d: r.deleted ? null : r.data, x: r.deleted ? 1 : 0 })));
    parts.push(']}');
    res.end(parts.join(''));
  } catch (e) { next(e); }
});

/* writes: batch of set / update / delete, applied atomically */
app.post('/api/write', auth(false), async (req, res, next) => {
  const ops = Array.isArray(req.body.ops) ? req.body.ops : [];
  if (!ops.length || ops.length > 500) return res.status(400).json({ error: 'bad ops' });
  const admin = await isAdmin(req.user);
  for (const o of ops) {
    if (!o || typeof o.c !== 'string' || typeof o.i !== 'string' || !/^[A-Za-z0-9_.:@+~-]{1,200}$/.test(o.c) || !/^[A-Za-z0-9_.:@+~-]{1,200}$/.test(o.i)) return res.status(400).json({ error: 'bad op' });
    if (!['set', 'update', 'delete'].includes(o.op)) return res.status(400).json({ error: 'bad op' });
    if (ADMIN_ONLY.has(o.c) && !admin) return res.status(403).json({ error: 'forbidden', code: 'permission_denied' });
    if (o.c === 'members' && o.i !== req.user.id && !admin) return res.status(403).json({ error: 'forbidden' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = [];
    for (const o of ops) {
      if (o.op === 'delete') {
        const r = await client.query(`UPDATE docs SET deleted=true,data=NULL,seq=nextval('doc_seq'),updated_at=$3,updated_by=$4 WHERE col=$1 AND id=$2 RETURNING seq`, [o.c, o.i, now(), req.user.id]);
        if (r.rows[0]) out.push({ c: o.c, i: o.i, s: Number(r.rows[0].seq), d: null, x: 1 });
        continue;
      }
      if (!isObj(o.d)) throw Object.assign(new Error('bad data'), { status: 400 });
      let data = o.d;
      if (o.op === 'update') {
        const cur = await client.query('SELECT data,deleted FROM docs WHERE col=$1 AND id=$2 FOR UPDATE', [o.c, o.i]);
        const base = cur.rows[0] && !cur.rows[0].deleted ? cur.rows[0].data : {};
        data = mergeDoc(base, o.d);
      }
      const r = await client.query(
        `INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by) VALUES($1,$2,$3,false,nextval('doc_seq'),$4,$5)
         ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data,deleted=false,seq=nextval('doc_seq'),updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by
         RETURNING seq`, [o.c, o.i, JSON.stringify(data), now(), req.user.id]);
      out.push({ c: o.c, i: o.i, s: Number(r.rows[0].seq), d: data, x: 0 });
    }
    await client.query('COMMIT');
    res.json({ ok: true, docs: out });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  } finally { client.release(); }
});

/* backup / restore */
app.get('/api/backup', auth(true), async (req, res, next) => {
  try {
    const docs = await pool.query('SELECT col,id,data FROM docs WHERE NOT deleted ORDER BY col,id');
    const users = await pool.query('SELECT id,username,name,pass,owner,disabled,created_at FROM users');
    const body = JSON.stringify({ app: 'mizan', version: 1, at: new Date().toISOString(), users: users.rows, docs: docs.rows.map(r => [r.col, r.id, r.data]) });
    const gz = zlib.gzipSync(body);
    const name = `mizan-backup-${new Date().toISOString().slice(0, 10)}.json.gz`;
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.end(gz);
  } catch (e) { next(e); }
});
app.post('/api/restore', auth(true), express.raw({ type: '*/*', limit: '120mb' }), async (req, res, next) => {
  if (!req.user.owner) return res.status(403).json({ error: 'الاسترجاع للمالك فقط' });
  let b;
  try {
    let buf = req.body;
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(JSON.stringify(req.body));
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    b = JSON.parse(buf.toString('utf8'));
    if (b.app !== 'mizan' || !Array.isArray(b.docs)) throw new Error('x');
  } catch (e) { return res.status(400).json({ error: 'ملف النسخة غير صالح' }); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM docs');
    for (let k = 0; k < b.docs.length; k += 200) {
      const chunk = b.docs.slice(k, k + 200);
      const vals = [], params = [];
      chunk.forEach(([c, i, d], j) => { vals.push(`($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3},false,nextval('doc_seq'),${now()})`); params.push(c, i, JSON.stringify(d)); });
      await client.query(`INSERT INTO docs(col,id,data,deleted,seq,updated_at) VALUES ${vals.join(',')}`, params);
    }
    if (Array.isArray(b.users) && b.users.length) {
      for (const u of b.users) {
        if (u.id === req.user.id) continue; // keep the restoring owner's own login
        await client.query(`INSERT INTO users(id,username,name,pass,owner,disabled,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username,name=EXCLUDED.name,pass=EXCLUDED.pass,disabled=EXCLUDED.disabled`,
          [u.id, u.username, u.name, u.pass, false, !!u.disabled, Number(u.created_at) || now()]).catch(() => {});
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, docs: b.docs.length });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); next(e); } finally { client.release(); }
});

/* pages */
const PUB = path.join(__dirname, 'public');
app.get('/login', (req, res) => res.sendFile(path.join(PUB, 'login.html')));
app.get(['/', '/index.html'], async (req, res, next) => {
  try {
    const u = await sessionUser(req);
    if (!u) return res.redirect('/login');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUB, 'app.html'));
  } catch (e) { next(e); }
});
app.use(express.static(PUB, { index: false, maxAge: '1h' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'خطأ في السيرفر' });
});

migrate().then(() => app.listen(PORT, () => console.log('ميزان يعمل على المنفذ', PORT)))
  .catch(e => { console.error('startup failed', e); process.exit(1); });
