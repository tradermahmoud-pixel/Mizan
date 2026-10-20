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
const notify = require('./notify');
const SESSION_DAYS = 30;
const COOKIE = 'mz_s';
// رقم النسخة: الأجهزة المفتوحة بتعرف إن فيه تحديث وبتعمل reload
const BUILD = String(process.env.RENDER_GIT_COMMIT || Date.now()).slice(0, 12);

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
    CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb);
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
/* صلاحيات المستخدم على السيرفر (نفس منطق البرنامج) — علشان قيود الفواتير متتكسرش من برّه البرنامج */
const DEF_PERMS = { manager: '*', accountant: ['sell', 'buy', 'editPrice', 'editInv', 'seeCost', 'parties', 'cash', 'reports', 'accounting'], cashier: ['sell', 'parties'], store: ['buy', 'products'], sales: ['crm'], prep: ['prep'], driver: ['delivery'], salesmgr: ['crm', 'crmManage', 'parties', 'reports', 'sell'] };
async function permsOf(u, db) {
  if (await isAdmin(u)) return '*';
  const role = await roleOf(u.id); if (!role) return [];
  const { rows } = await db.query(`SELECT data FROM docs WHERE col='roledefs' AND id='main' AND NOT deleted`);
  const d = rows[0] && rows[0].data;
  if (d && isObj(d.roles)) {
    const def = d.roles[role]; if (def) return Array.isArray(def.perms) ? def.perms : [];
    if (['sales', 'salesmgr', 'prep', 'driver'].includes(role) && !(d.removed || []).includes(role)) return DEF_PERMS[role];
    return [];
  }
  return DEF_PERMS[role] || [];
}
const INV_KEYS = ['type', 'date', 'partyId', 'storeId', 'toStoreId', 'discount', 'taxRate'];
function invSig(v) {
  if (!isObj(v)) return null; const o = {};
  for (const k of INV_KEYS) { const x = v[k]; o[k] = x == null || x === '' ? '' : String(x); }
  o.lines = (Array.isArray(v.lines) ? v.lines : []).map(l => [String((l && l.pid) || ''), +(l && l.qty) || 0, +(l && l.price) || 0, +(l && l.disc) || 0]);
  return JSON.stringify(o);
}
// أي تعديل أو حذف لفاتورة محفوظة: محتاج صلاحية «تعديل الفواتير»، والفاتورة اللي مع المندوب أو اتسلّمت مقفولة (إلا للمالك/المدير العام)
async function guardInvoices(db, user, changes, ctx) {
  for (const [id, ov, nv] of changes) {
    if (!isObj(ov)) continue;
    if (nv !== null && invSig(nv) === invSig(ov)) continue;
    if (ctx.admin) continue;
    if (ctx.perms === undefined) ctx.perms = await permsOf(user, db);
    if (ctx.perms !== '*' && !ctx.perms.includes('editInv')) throw Object.assign(new Error('ليس لديك صلاحية تعديل أو حذف الفواتير المحفوظة'), { status: 403 });
    if (ov.type !== 'sale') continue;
    const { rows } = await db.query(`SELECT r.data->>'status' st, s->>'status' ss FROM docs r, jsonb_array_elements(CASE WHEN jsonb_typeof(r.data->'stops')='array' THEN r.data->'stops' ELSE '[]'::jsonb END) s
      WHERE r.col='runs' AND NOT r.deleted AND COALESCE(r.data->>'status','')<>'cancel' AND s->>'invId'=$1`, [id]);
    if (rows.some(x => x.ss === 'delivered')) throw Object.assign(new Error(`الفاتورة #${ov.no || ''} اتسلّمت للعميل — مينفعش تتعدل أو تتحذف. اعمل فاتورة مرتجع`), { status: 409 });
    if (rows.some(x => x.st === 'active' && (x.ss === 'pending' || x.ss === 'arrived'))) throw Object.assign(new Error(`الفاتورة #${ov.no || ''} مع المندوب في الطريق — مينفعش تتعدل أو تتحذف دلوقتي`), { status: 409 });
  }
}
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
  res.setHeader('X-Mizan-Build', BUILD);
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
  const view = await viewOf(u, pool);
  res.json({ id: u.id, username: u.username, name: u.name, owner: u.owner, admin: view.admin, costHidden: view.costHidden });
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

/* رقم الفاتورة الجاي — بيتحجز على السيرفر علشان مايتكررش لو اتنين حفظوا في نفس اللحظة */
app.post('/api/next-no', auth(false), async (req, res, next) => {
  const type = String(req.body.type || '');
  if (!NUM_TYPES.has(type)) return res.status(400).json({ error: 'bad type' });
  const client = await pool.connect();
  try { await client.query('BEGIN'); const no = await reserveNo(client, type); await client.query('COMMIT'); res.json({ no }); }
  catch (e) { await client.query('ROLLBACK').catch(() => {}); next(e); } finally { client.release(); }
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
    const view = await viewOf(req.user, pool);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const parts = ['{"seq":', String(seq), ',"full":', since === 0 ? 'true' : 'false', ',"docs":['];
    let first = true;
    rows.forEach(r => { if (r.col === 'notifs' && !r.deleted && !(r.data && Array.isArray(r.data.to) && r.data.to.includes(req.user.id))) return; parts.push((first ? '' : ',') + JSON.stringify({ c: r.col, i: r.id, s: Number(r.seq), d: r.deleted ? null : viewDoc(r.col, r.data, view), x: r.deleted ? 1 : 0 })); first = false; });
    if (view.costHidden && (since === 0 || rows.some(r => PX_COLS.has(r.col)))) parts.push((first ? '' : ',') + JSON.stringify({ c: '_px', i: 'main', s: seq, d: await tierPrices(pool), x: 0 }));
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
    if (o.c === 'notifs') return res.status(403).json({ error: 'forbidden' }); // التنبيهات بيعملها السيرفر بس
    if (o.op === 'delete' && o.c.startsWith('x_') && !admin) return res.status(403).json({ error: 'forbidden' });
  }
  const gctx = { admin, seenNo: new Set(), renumbered: [], cashEv: [] };
  const view = admin ? { admin: true, costHidden: false } : await viewOf(req.user, pool);
  for (const o of ops) {
    // كتابة chunk كامل (set) بتمسح اللي فيه — للمالك بس (البرنامج نفسه بيكتب update دايمًا)
    if (!admin && o.op === 'set' && o.c.startsWith('x_')) return res.status(403).json({ error: 'forbidden' });
    if (view.costHidden && o.c === 'x_products') return res.status(403).json({ error: 'ليس لديك صلاحية تعديل الأصناف' });
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
      if (o.op === 'update' || o.c === 'x_invoices') {
        const cur = await client.query('SELECT data,deleted FROM docs WHERE col=$1 AND id=$2 FOR UPDATE', [o.c, o.i]);
        const base = cur.rows[0] && !cur.rows[0].deleted ? cur.rows[0].data : {};
        if (o.c === 'x_invoices') {
          const bi = isObj(base.items) ? base.items : {}; const ni = isObj(o.d.items) ? o.d.items : {};
          if (!admin && Object.keys(bi).length) {
            const ids = o.op === 'update' ? Object.keys(ni) : [...new Set([...Object.keys(bi), ...Object.keys(ni)])];
            await guardInvoices(client, req.user, ids.map(id => [id, bi[id], isObj(ni[id]) ? ni[id] : null]), gctx);
          }
          if (view.costHidden) for (const [id, nv] of Object.entries(ni)) {
            const ov = bi[id];
            if ((isObj(nv) && PUR_TYPES.has(nv.type)) || (isObj(ov) && PUR_TYPES.has(ov.type))) throw Object.assign(new Error('ليس لديك صلاحية فواتير الشراء والجرد'), { status: 403 });
            // التكلفة اليدوية في سطور البيع: اللي مالوش صلاحية التكلفة ميقدرش يكتبها، والقديمة بتفضل زي ما هي
            if (isObj(nv) && Array.isArray(nv.lines)) nv.lines = nv.lines.map((l, i) => { if (!isObj(l)) return l; const ol = isObj(ov) && Array.isArray(ov.lines) ? ov.lines[i] : null; return { ...l, cost: ol && ol.pid === l.pid && ol.cost != null ? ol.cost : '' }; });
          }
          await numberNewInvoices(client, ni, bi, o.i, gctx);
        }
        if (o.op === 'update') data = mergeDoc(base, o.d);
        if ((o.c === 'x_cash' || o.c === 'x_invoices') && isObj(o.d.items)) gctx.cashEv.push(...notify.detect(o.c, isObj(base.items) ? base.items : {}, o.d.items, 'mizan'));
      }
      const r = await client.query(
        `INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by) VALUES($1,$2,$3,false,nextval('doc_seq'),$4,$5)
         ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data,deleted=false,seq=nextval('doc_seq'),updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by
         RETURNING seq`, [o.c, o.i, JSON.stringify(data), now(), req.user.id]);
      out.push({ c: o.c, i: o.i, s: Number(r.rows[0].seq), d: viewDoc(o.c, data, view), x: 0 });
    }
    if (gctx.cashEv.length) await notify.emit(client, gctx.cashEv, { id: req.user.id, name: req.user.name });
    await client.query('COMMIT');
    if (view.costHidden && out.some(d => PX_COLS.has(d.c))) { try { out.push({ c: '_px', i: 'main', s: 0, d: await tierPrices(pool), x: 0 }); } catch (e) {} }
    res.json({ ok: true, docs: out, ...(gctx.renumbered.length ? { renumbered: gctx.renumbered } : {}) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  } finally { client.release(); }
});

/* ============ ربط أورجا (اتجاه واحد: أورجا ← ميزان) ============ */
require('./orga')(app, { pool, auth, now, notify });
notify.mount(app, { pool, auth });

/* ============ ترقيم الفواتير على السيرفر ============ */
const NUM_TYPES = new Set(['sale', 'sret', 'purchase', 'pret', 'adj', 'reval', 'count', 'transfer', 'open', 'porder', 'quote']);
const ITEMS_SQL = `jsonb_each(CASE WHEN jsonb_typeof(d.data->'items')='object' THEN d.data->'items' ELSE '{}'::jsonb END) e(k,v)`;
async function dbMaxNo(db, type) {
  const { rows } = await db.query(`SELECT COALESCE(max((e.v->>'no')::numeric),0)::bigint n FROM docs d, ${ITEMS_SQL}
    WHERE d.col='x_invoices' AND NOT d.deleted AND jsonb_typeof(e.v)='object' AND e.v->>'type'=$1 AND (e.v->>'no') ~ '^[0-9]{1,15}$'`, [type]);
  return Number(rows[0].n) || 0;
}
// بيحجز الرقم الجاي لنوع الفاتورة (داخل transaction): قفل على عداد النوع في kv، فمستحيل اتنين ياخدوا نفس الرقم
async function reserveNo(db, type) {
  const k = 'no:' + type;
  await db.query(`INSERT INTO kv(k,v) VALUES($1,'{"n":0}') ON CONFLICT (k) DO NOTHING`, [k]);
  const { rows } = await db.query(`SELECT v FROM kv WHERE k=$1 FOR UPDATE`, [k]);
  const cur = Number(rows[0] && rows[0].v && rows[0].v.n) || 0;
  const n = Math.max(cur, await dbMaxNo(db, type)) + 1;
  await db.query(`UPDATE kv SET v=$2 WHERE k=$1`, [k, JSON.stringify({ n })]);
  return n;
}
async function bumpNo(db, type, no) {
  const k = 'no:' + type;
  await db.query(`INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=jsonb_build_object('n', GREATEST(COALESCE((kv.v->>'n')::bigint,0), $3::bigint))`, [k, JSON.stringify({ n: no }), no]);
}
// فاتورة جديدة برقم مستخدم قبل كده (مثلًا اتحفظت والنت فاصل) → بتاخد رقم جديد تلقائيًا
async function numberNewInvoices(db, items, base, chunkId, ctx) {
  for (const [id, nv] of Object.entries(items)) {
    if (!isObj(nv) || isObj(base[id]) || !NUM_TYPES.has(nv.type)) continue;
    const no = Number(nv.no);
    const key = nv.type + ':' + no;
    let dup = !(no > 0) || ctx.seenNo.has(key);
    if (!dup) {
      const { rows } = await db.query(`SELECT 1 FROM docs d, ${ITEMS_SQL} WHERE d.col='x_invoices' AND NOT d.deleted AND jsonb_typeof(e.v)='object'
        AND e.v->>'type'=$1 AND e.v->>'no'=$2 AND NOT (d.id=$3 AND e.k=$4) LIMIT 1`, [nv.type, String(no), chunkId, id]);
      dup = rows.length > 0;
    }
    if (dup) { nv.no = await reserveNo(db, nv.type); ctx.renumbered.push({ id, type: nv.type, from: no || null, to: nv.no }); }
    else await bumpNo(db, nv.type, no);
    ctx.seenNo.add(nv.type + ':' + Number(nv.no));
  }
}

/* ============ التكلفة مش بتوصل لجهاز اللي مالوش صلاحيتها ============
   المستخدم اللي مالوش «رؤية التكلفة» ولا «الشراء» ولا «الأصناف» (كاشير، مدير مبيعات...) مش بيوصله:
   أسعار فواتير الشراء والجرد والتسويات، تكلفة الأصناف، التكلفة اليدوية في سطور البيع، وسجل التعديلات.
   أسعار الشرايح (التكلفة + النسبة) بتتحسب على السيرفر وبتوصله كأسعار بيع جاهزة. */
const PUR_TYPES = new Set(['purchase', 'pret', 'open', 'porder', 'adj', 'count', 'reval']);
const DOC_TYPES = new Set(['porder', 'quote']);
const DEF_TIERS = [{ id: 't_cash', name: 'صيدلي نقدي', markup: 7, days: 0 }, { id: 't_vip', name: 'كبار العملاء', markup: 3, days: 0 }, { id: 't_credit', name: 'آجل 15 يوم', markup: 10, days: 15 }];
async function viewOf(user, db) {
  if (await isAdmin(user)) return { admin: true, costHidden: false };
  const perms = await permsOf(user, db);
  const has = p => perms === '*' || perms.includes(p);
  return { admin: false, perms, costHidden: !has('seeCost') && !has('buy') && !has('products') };
}
function stripInv(v) {
  if (!isObj(v)) return v;
  if (PUR_TYPES.has(v.type)) {
    return { ...v, discount: 0, taxRate: 0, paid: 0, lines: (Array.isArray(v.lines) ? v.lines : []).map(l => isObj(l) ? { pid: l.pid, qty: l.qty, price: 0, disc: 0, cost: '', ...(l.bonus ? { bonus: true } : {}) } : l) };
  }
  if (Array.isArray(v.lines) && v.lines.some(l => isObj(l) && l.cost !== '' && l.cost != null)) return { ...v, lines: v.lines.map(l => isObj(l) ? { ...l, cost: '' } : l) };
  return v;
}
function viewDoc(c, data, view) {
  if (!view.costHidden || !isObj(data)) return data;
  if (c === 'x_audit') return { ...data, items: {} };
  if (c === 'x_invoices' && isObj(data.items)) { const it = {}; for (const [k, v] of Object.entries(data.items)) it[k] = stripInv(v); return { ...data, items: it }; }
  if (c === 'x_products' && isObj(data.items)) { const it = {}; for (const [k, v] of Object.entries(data.items)) { if (isObj(v)) { const { cost, ...rest } = v; it[k] = rest; } else it[k] = v; } return { ...data, items: it }; }
  return data;
}
// متوسط التكلفة لكل صنف — نفس حسبة البرنامج بالظبط — ومنه أسعار الشرايح
let PX = { key: '', px: null };
async function tierPrices(db) {
  const k = await db.query(`SELECT COALESCE(max(seq),0)::bigint s FROM docs WHERE col IN ('x_invoices','x_products','settings')`);
  const key = String(k.rows[0].s);
  if (PX.key === key && PX.px) return PX.px;
  const { rows } = await db.query(`SELECT col,id,data FROM docs WHERE col IN ('x_invoices','x_products') AND NOT deleted`);
  const prods = {}, invs = [];
  for (const r of rows) { const it = r.data && isObj(r.data.items) ? r.data.items : {}; for (const [id, v] of Object.entries(it)) { if (!isObj(v)) continue; if (r.col === 'x_products') prods[id] = v; else invs.push(v); } }
  const st = {}; const S = id => st[id] || (st[id] = { qty: 0, value: 0, by: {}, last: +(prods[id] && prods[id].cost) || 0 });
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  invs.sort((a, b) => cmp(a.date || '', b.date || '') || cmp(a.createdAt || '', b.createdAt || ''));
  for (const inv of invs) {
    if (DOC_TYPES.has(inv.type)) continue; const store = inv.storeId || 'main';
    for (const l of Array.isArray(inv.lines) ? inv.lines : []) {
      if (!isObj(l) || !l.pid) continue;
      const q = +l.qty || 0, s = S(l.pid), unit = (+l.price || 0) * (1 - (+l.disc || 0) / 100);
      const avg = s.qty > 0.0001 ? s.value / s.qty : s.last; const net = q * unit; const man = l.cost !== '' && l.cost != null; let cost = avg;
      const add = (sid, dq) => { s.by[sid] = (s.by[sid] || 0) + dq; };
      switch (inv.type) {
        case 'purchase': case 'open': s.qty += q; s.value += net; if (unit) s.last = unit; add(store, q); break;
        case 'sale': s.qty -= q; s.value -= q * avg; add(store, -q); break;
        case 'sret': cost = man ? +l.cost : avg; s.qty += q; s.value += q * cost; add(store, q); break;
        case 'pret': s.qty -= q; s.value -= q * avg; add(store, -q); break;
        case 'transfer': add(store, -q); add(inv.toStoreId || 'main', q); break;
        case 'reval': cost = +l.cost || 0; if (s.qty > 0.0001) s.value = s.qty * cost; else s.value = 0; if (cost) s.last = cost; break;
        case 'adj': cost = man ? +l.cost : ((+l.price) || avg); s.qty += q; s.value += q * cost; add(store, q); break;
        case 'count': { const book = s.by[store] || 0; const d = q - book; s.by[store] = q; s.qty += d; s.value += d * avg; break; }
      }
      if (s.qty <= 0.0001) s.value = s.qty * (avg || s.last);
    }
  }
  const sr = await db.query(`SELECT data FROM docs WHERE col='settings' AND id='main' AND NOT deleted`);
  const set = sr.rows[0] && sr.rows[0].data || {}; const tiers = Array.isArray(set.tiers) && set.tiers.length ? set.tiers : DEF_TIERS;
  const r2 = n => Math.round(n * 100) / 100; const t = {};
  for (const tr of tiers) { if (!tr || !tr.id) continue; const m = {}; for (const pid of Object.keys(prods)) { const s = st[pid]; const c = s ? (s.qty > 0.0001 ? s.value / s.qty : s.last) : (+prods[pid].cost || 0); if (c > 0) m[pid] = r2(c * (1 + (+tr.markup || 0) / 100)); } t[tr.id] = m; }
  PX = { key, px: { v: key, t } }; return PX.px;
}
const PX_COLS = new Set(['x_invoices', 'x_products', 'settings']);

/* ---------------- AI assistant (OpenAI-compatible providers, key stays on the server) ---------------- */
const AI_PRESETS = {
  local: { name: 'المساعد المدمج (مجاني — بدون مفتاح)', url: '', model: '' },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
  gemini: { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
  anthropic: { name: 'Claude (Anthropic)', url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' },
  openai: { name: 'OpenAI (مدفوع)', url: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: '' },
  custom: { name: 'مخصص', url: '', model: '' },
};
async function aiCfg() {
  let c = {};
  try { const { rows } = await pool.query(`SELECT v FROM kv WHERE k='ai'`); if (rows[0]) c = rows[0].v || {}; } catch (e) {}
  const provider = c.provider || process.env.AI_PROVIDER || ((c.key || process.env.AI_KEY) ? 'groq' : 'local');
  const pre = AI_PRESETS[provider] || AI_PRESETS.custom;
  return {
    provider, enabled: c.enabled !== false,
    url: (c.url || process.env.AI_URL || pre.url || '').replace(/\/+$/, ''),
    model: c.model || process.env.AI_MODEL || pre.model,
    key: c.key || process.env.AI_KEY || '',
    workspace: c.workspace || process.env.AI_WORKSPACE || '',
  };
}
const aiUse = new Map();
function aiLimit(uid) {
  const t = now(), a = aiUse.get(uid) || { m: [], d: 0, day: new Date().toISOString().slice(0, 10) };
  const day = new Date().toISOString().slice(0, 10); if (a.day !== day) { a.day = day; a.d = 0; }
  a.m = a.m.filter(x => t - x < 60e3);
  if (a.m.length >= 20) return 'طلبات كتير في دقيقة واحدة — استنى شوية وجرب تاني';
  if (a.d >= 400) return 'خلص الحد اليومي للمساعد لحسابك — جرب بكرة';
  a.m.push(t); a.d++; aiUse.set(uid, a); return null;
}
async function aiFetch(cfg, pathPart, body) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 90e3);
  try {
    const r = await fetch(cfg.url + pathPart, {
      method: body ? 'POST' : 'GET', signal: ac.signal,
      headers: Object.assign({ Authorization: 'Bearer ' + cfg.key }, body ? { 'Content-Type': 'application/json' } : {},
        cfg.provider === 'openrouter' ? { 'HTTP-Referer': 'https://mizan.app', 'X-Title': 'Mizan' } : {},
        cfg.provider === 'anthropic' ? Object.assign({ 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' }, cfg.workspace ? { 'anthropic-workspace-id': cfg.workspace } : {}) : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; const txt = await r.text(); try { j = JSON.parse(txt); } catch (e) {}
    return { status: r.status, ok: r.ok, j, txt };
  } finally { clearTimeout(to); }
}
function aiErr(r) {
  const m = (r.j && (r.j.error && (r.j.error.message || r.j.error) || r.j.message)) || r.txt || '';
  if (/workspace/i.test(r.txt || '') && /scoped/i.test(r.txt || '')) return 'المفتاح ده مش تابع لـ Workspace — حط «رقم الـ Workspace» في الإعدادات (من console.anthropic.com ← Settings ← Workspaces، بيبدأ بـ wrkspc_)، أو اعمل مفتاح جديد من جوّه Workspace معيّن';
  if (r.status === 401 || r.status === 403) return 'مفتاح الذكاء الاصطناعي غير صحيح أو مش مفعّل — راجع الإعدادات';
  if (r.status === 429 && /quota|billing|insufficient/i.test(r.txt || '')) return 'رصيد حساب الذكاء الاصطناعي خلص أو مفيش وسيلة دفع — اشحن رصيد من موقع المزوّد (Billing)';
  if (r.status === 429) return 'وصلت لحد الاستخدام المجاني عند مزوّد الذكاء الاصطناعي — استنى دقيقة وجرب تاني';
  if (r.status === 529 || r.status === 503) return 'مزوّد الذكاء الاصطناعي مشغول دلوقتي — جرب تاني بعد شوية';
  if (r.status === 404) return 'اسم الموديل غير موجود عند المزوّد — اختار موديل تاني من الإعدادات';
  return 'خطأ من مزوّد الذكاء الاصطناعي: ' + String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 300);
}
app.get('/api/ai/config', auth(false), async (req, res, next) => {
  try {
    const c = await aiCfg(); const adm = await isAdmin(req.user);
    const o = { enabled: c.provider === 'local' ? c.enabled : (c.enabled && !!c.key && !!c.model && !!c.url), provider: c.provider, model: c.provider === 'local' ? '' : c.model };
    if (adm) Object.assign(o, { admin: true, url: c.url, hasKey: !!c.key, keyHint: c.key ? '…' + c.key.slice(-4) : '', on: c.enabled, workspace: c.workspace || '', presets: AI_PRESETS });
    res.json(o);
  } catch (e) { next(e); }
});
app.post('/api/ai/config', auth(true), async (req, res, next) => {
  try {
    const b = req.body || {}; const cur = await aiCfg();
    const { rows } = await pool.query(`SELECT v FROM kv WHERE k='ai'`); const old = (rows[0] && rows[0].v) || {};
    const n = Object.assign({}, old);
    if (b.provider !== undefined) { if (!AI_PRESETS[b.provider]) return res.status(400).json({ error: 'مزوّد غير معروف' }); n.provider = b.provider; }
    if (b.url !== undefined) { const u = String(b.url || '').trim(); if (u && !/^https:\/\/[^\s]+$/.test(u)) return res.status(400).json({ error: 'الرابط لازم يبدأ بـ https://' }); n.url = u; }
    if (b.model !== undefined) n.model = String(b.model || '').trim().slice(0, 120);
    if (b.workspace !== undefined) { const w = String(b.workspace || '').trim(); if (w && !/^[A-Za-z0-9_-]{3,80}$/.test(w)) return res.status(400).json({ error: 'رقم الـ Workspace مش مظبوط — بيبدأ غالبًا بـ wrkspc_' }); n.workspace = w; }
    if (typeof b.key === 'string' && b.key.trim()) { const k = b.key.trim(); if (k.length < 20 || /\s/.test(k)) return res.status(400).json({ error: 'المفتاح ده مش صحيح — الصق مفتاح الـ API من موقع المزوّد' }); n.key = k.slice(0, 400); }
    if (b.key === null) delete n.key;
    if (b.enabled !== undefined) n.enabled = !!b.enabled;
    await pool.query(`INSERT INTO kv(k,v) VALUES('ai',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [n]);
    void cur; res.json({ ok: true });
  } catch (e) { next(e); }
});
/* ---------------- Geo: expand Google Maps share links to coordinates ---------------- */
function geoParse(u) {
  u = decodeURIComponent(String(u || ''));
  const pats = [/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, /[?&](?:q|query|ll|destination|center|daddr)=(?:loc:)?(-?\d{1,2}\.\d+),\s*\+?(-?\d{1,3}\.\d+)/, /(-?\d{1,2}\.\d{3,}),\s*\+?(-?\d{1,3}\.\d{3,})/];
  for (const re of pats) { const m = u.match(re); if (m) { const lat = +m[1], lng = +m[2]; if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng }; } }
  return null;
}
app.get('/api/geo/expand', auth(false), async (req, res) => {
  try {
    let u = String(req.query.u || '').trim(); if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl|maps\.google\.[a-z.]+|www\.google\.[a-z.]+|google\.[a-z.]+)\//i.test(u)) return res.status(400).json({ error: 'ده مش لينك خرائط جوجل' });
    let hit = geoParse(u);
    for (let i = 0; i < 5 && !hit; i++) {
      const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile' } });
      const loc = r.headers.get('location');
      if (loc) { u = new URL(loc, u).toString(); hit = geoParse(u); continue; }
      const txt = await r.text(); hit = geoParse(txt.slice(0, 400000)); break;
    }
    if (!hit) return res.status(422).json({ error: 'مقدرتش أطلّع الإحداثيات من اللينك — افتح اللينك واضغط مطوّلًا على المكان وانسخ الأرقام' });
    res.json(Object.assign({ url: u }, hit));
  } catch (e) { res.status(502).json({ error: 'مقدرتش أفتح اللينك' }); }
});
app.get('/api/ai/models', auth(true), async (req, res, next) => {
  try {
    const c = await aiCfg(); if (!c.key || !c.url) return res.status(400).json({ error: 'حط المفتاح الأول' });
    const r = await aiFetch(c, '/models');
    if (!r.ok) return res.status(502).json({ error: aiErr(r) });
    const ids = ((r.j && (r.j.data || r.j.models)) || []).map(m => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean).sort();
    res.json({ models: ids });
  } catch (e) { if (e.name === 'AbortError') return res.status(504).json({ error: 'المزوّد ما ردّش' }); next(e); }
});
app.post('/api/ai/chat', auth(false), async (req, res, next) => {
  try {
    const c = await aiCfg();
    if (!(c.enabled && c.key && c.model && c.url)) return res.status(400).json({ error: 'المساعد مش متفعّل — المدير يفعّله من الإعدادات' });
    const lim = aiLimit(req.user.id); if (lim) return res.status(429).json({ error: lim });
    const b = req.body || {};
    if (!Array.isArray(b.messages) || !b.messages.length) return res.status(400).json({ error: 'رسالة فاضية' });
    const size = JSON.stringify(b).length; if (size > 120000) return res.status(413).json({ error: 'المحادثة طويلة قوي — ابدأ محادثة جديدة' });
    const body = { model: c.model, messages: b.messages, temperature: 0.2, max_tokens: 1800 };
    if (c.provider === 'anthropic') { delete body.temperature; body.max_tokens = 3000; body.messages = body.messages.map(m => (m && m.role === 'assistant' && m.tool_calls && !m.content) ? Object.assign({}, m, { content: null }) : m); }
    if (c.provider === 'openai') { delete body.temperature; delete body.max_tokens; body.max_completion_tokens = 4000; }
    if (Array.isArray(b.tools) && b.tools.length) { body.tools = b.tools; body.tool_choice = 'auto'; }
    const t0 = now();
    let r = await aiFetch(c, '/chat/completions', body);
    if (!r.ok && r.status === 400 && /temperature|max_tokens/i.test(r.txt || '')) {
      delete body.temperature; if (body.max_tokens) { body.max_completion_tokens = 4000; delete body.max_tokens; }
      r = await aiFetch(c, '/chat/completions', body);
    }
    if (!r.ok && r.status === 400 && body.tools && /tool/i.test(r.txt || '')) { delete body.tools; delete body.tool_choice; r = await aiFetch(c, '/chat/completions', body); }
    if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: aiErr(r) });
    const ch = r.j && r.j.choices && r.j.choices[0];
    if (!ch || !ch.message) return res.status(502).json({ error: 'رد غير مفهوم من المزوّد' });
    const m = ch.message;
    res.json({ message: { role: 'assistant', content: m.content || '', tool_calls: m.tool_calls || undefined }, usage: r.j.usage || null, ms: now() - t0 });
  } catch (e) { if (e.name === 'AbortError') return res.status(504).json({ error: 'المزوّد اتأخر في الرد — جرب تاني' }); next(e); }
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
app.use(express.static(PUB, { index: false, maxAge: '1h', setHeaders: (res, f) => { if (/\.(js|html|css)$/.test(f) && !f.includes(`${path.sep}vendor${path.sep}`)) res.setHeader('Cache-Control', 'no-cache'); } }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'خطأ في السيرفر' });
});

/* one-time CRM seed: encrypted file in the repo, key only in the server env (CRM_SEED_KEY). Runs only if there are no leads yet. */
async function seedCrm() {
  const pass = process.env.CRM_SEED_KEY; const file = path.join(__dirname, 'seed', 'crm.enc');
  if (!pass || !fs.existsSync(file)) return;
  const { rows } = await pool.query(`SELECT count(*)::int n FROM docs WHERE col='x_leads' AND NOT deleted`);
  if (rows[0].n > 0) { console.log('CRM seed: leads already exist, skipped'); return; }
  let p;
  try {
    const buf = fs.readFileSync(file); const key = crypto.createHash('sha256').update(pass).digest();
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28));
    p = JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(28)), d.final()])).toString('utf8'));
  } catch (e) { console.error('CRM seed: cannot decrypt', e.message); return; }
  const client = await pool.connect(); const u = now();
  try {
    await client.query('BEGIN');
    const up = (c, i, data) => client.query(`INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by) VALUES($1,$2,$3,false,nextval('doc_seq'),$4,'seed')
      ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data,deleted=false,seq=nextval('doc_seq'),updated_at=EXCLUDED.updated_at,updated_by='seed'`, [c, i, JSON.stringify(data), u]);
    let n = 0;
    for (const [cid, items] of Object.entries(p.chunks || {})) { await up('x_leads', cid, { items, u }); n += Object.keys(items).length; }
    for (const [rid, r] of Object.entries(p.reps || {})) {
      const ex = await client.query(`SELECT 1 FROM docs WHERE col='crm_reps' AND id=$1 AND NOT deleted`, [rid]);
      if (!ex.rows.length) await up('crm_reps', rid, r);
    }
    if (p.settings) {
      const cur = await client.query(`SELECT data FROM docs WHERE col='settings' AND id='main' AND NOT deleted`);
      await up('settings', 'main', Object.assign({}, (cur.rows[0] && cur.rows[0].data) || {}, p.settings));
    }
    await client.query('COMMIT');
    console.log('CRM seed: imported', n, 'leads and', Object.keys(p.reps || {}).length, 'reps');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('CRM seed failed', e.message); }
  finally { client.release(); }
}

migrate().then(seedCrm).then(() => app.listen(PORT, () => console.log('ميزان يعمل على المنفذ', PORT)))
  .catch(e => { console.error('startup failed', e); process.exit(1); });
