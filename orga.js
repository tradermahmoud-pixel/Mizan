'use strict';
/* ربط أورجا → ميزان (اتجاه واحد).
   برنامج صغير على جهاز أورجا بيقرا ORGA.GDB قراءة بس، وبيبعت اللي اتغيّر هنا بمفتاح ربط خاص.
   المفتاح: المالك بس اللي يطلّعه أو يلغيه، ومتخزن هنا كـ hash (مش المفتاح نفسه).
   المفتاح يقدر يكتب سجلات أورجا بس (ids بتبدأ بـ o… وخزائن s<رقم>) — ومش بيلمس أي حاجة اتعملت في ميزان. */
const crypto = require('crypto');

const KV = 'orga:sync';
const CHUNKS = { products: 64, parties: 16, invoices: 256, cash: 32 };
const IDRX = {
  products: /^op\d{1,9}$/,
  parties: /^oa\d{1,9}$/,
  invoices: /^o(?:s|r|pu|pr|o|a|v)\d{1,9}$/,
  cash: /^oc[ipdt]\d{1,9}$/,
  safes: /^s\d{1,6}$/,
};
const INV_TYPES = new Set(['sale', 'sret', 'purchase', 'pret', 'open', 'adj', 'reval']);
const CASH_KINDS = new Set(['in', 'out', 'xfer']);
const PARTY_KINDS = new Set(['customer', 'vendor']);
const KEYRX = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const MAX_ITEM = 4 * 1024 * 1024;
const fnv = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const chunkFor = (c, id) => 'b' + String(fnv(id) % CHUNKS[c]).padStart(3, '0');
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
// سجل اتعمل من أورجا (مش من ميزان) — ده بس اللي الربط يقدر يعدّله أو يحذفه
const fromOrga = v => isObj(v) && (v.orga != null || v.orgaUser != null);
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : isObj(v) ? '{' + Object.keys(v).filter(k => v[k] != null).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v === undefined ? null : v);
const same = (a, b) => stable(a) === stable(b);

function validItem(col, v) {
  if (!isObj(v)) return 'not object';
  if (JSON.stringify(v).length > MAX_ITEM) return 'too big';
  for (const k of Object.keys(v)) if (!KEYRX.test(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') return 'bad key ' + k;
  if (col === 'invoices') { if (!INV_TYPES.has(v.type)) return 'bad type'; if (!Array.isArray(v.lines)) return 'no lines'; if (v.orgaUser == null) return 'no orgaUser'; }
  if (col === 'cash') { if (!CASH_KINDS.has(v.kind)) return 'bad kind'; if (v.orgaUser == null) return 'no orgaUser'; }
  if (col === 'parties') { if (!PARTY_KINDS.has(v.kind)) return 'bad kind'; if (v.orga == null) return 'no orga'; }
  if (col === 'products' && v.orga == null) return 'no orga';
  if (col === 'safes') { if (typeof v.name !== 'string' || v.orga == null) return 'bad safe'; }
  return '';
}

module.exports = function mountOrga(app, { pool, auth, now, notify }) {
  async function getCfg(db = pool) { const { rows } = await db.query(`SELECT v FROM kv WHERE k=$1`, [KV]); return (rows[0] && rows[0].v) || {}; }
  async function setCfg(v, db = pool) { await db.query(`INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [KV, JSON.stringify(v)]); }
  const ownerOnly = (req, res, next) => (req.user && req.user.owner ? next() : res.status(403).json({ error: 'للمالك بس' }));
  const pub = c => ({ active: !!c.hash, hint: c.hint || '', createdAt: c.createdAt || 0, createdBy: c.createdBy || '', lastAt: c.lastAt || 0, lastIp: c.lastIp || '', agent: c.agent || null, stats: c.stats || {}, lastErr: c.lastErr || '', purgedAt: c.purgedAt || 0 });

  /* ---- إدارة المفتاح (المالك بس) ---- */
  app.get('/api/orga/status', auth(false), ownerOnly, async (req, res, next) => { try { res.json(pub(await getCfg())); } catch (e) { next(e); } });
  app.post('/api/orga/key', auth(false), ownerOnly, async (req, res, next) => {
    try {
      const token = 'mzo_' + crypto.randomBytes(32).toString('base64url');
      const old = await getCfg();
      // مفتاح جديد = القديم بيبطل فورًا
      await setCfg({ hash: sha(token), hint: token.slice(-4), createdAt: now(), createdBy: req.user.name || req.user.username, stats: old.stats || {} });
      res.json({ token, ...pub(await getCfg()) });
    } catch (e) { next(e); }
  });
  app.post('/api/orga/revoke', auth(false), ownerOnly, async (req, res, next) => {
    try { const c = await getCfg(); delete c.hash; c.revokedAt = now(); await setCfg(c); res.json(pub(c)); } catch (e) { next(e); }
  });

  /* ---- تحقق مفتاح البرنامج ---- */
  const fails = new Map(), hits = new Map();
  async function agentAuth(req, res, next) {
    try {
      const ip = req.ip || '';
      const f = fails.get(ip) || { n: 0, t: now() };
      if (now() - f.t > 15 * 60e3) { f.n = 0; f.t = now(); }
      if (f.n >= 20) return res.status(429).json({ error: 'محاولات كتير — استنى ربع ساعة' });
      const m = /^Bearer (mzo_[A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
      const c = await getCfg();
      const ok = m && c.hash && crypto.timingSafeEqual(Buffer.from(sha(m[1]), 'hex'), Buffer.from(c.hash, 'hex'));
      if (!ok) { f.n++; fails.set(ip, f); return res.status(401).json({ error: 'مفتاح الربط غلط أو اتلغى — طلّع مفتاح جديد من إعدادات ميزان' }); }
      const h = hits.get('k') || { n: 0, t: now() };
      if (now() - h.t > 60e3) { h.n = 0; h.t = now(); }
      if (++h.n > 240) { hits.set('k', h); return res.status(429).json({ error: 'طلبات كتير — استنى دقيقة' }); }
      hits.set('k', h);
      req.orga = c; next();
    } catch (e) { next(e); }
  }
  async function touch(req, patch) {
    try {
      const c = await getCfg();
      if (!c.hash || c.hash !== req.orga.hash) return;
      c.lastAt = now(); c.lastIp = req.ip || '';
      if (isObj(req.body && req.body.agent)) c.agent = { ver: String(req.body.agent.ver || '').slice(0, 20), host: String(req.body.agent.host || '').slice(0, 60) };
      Object.assign(c, patch || {});
      await setCfg(c);
    } catch (e) {}
  }

  app.post('/api/orga/ping', agentAuth, async (req, res) => { await touch(req, {}); res.json({ ok: true, at: now() }); });

  /* ==================================================================
     قايمة انتظار الكتابة: ميزان ← أورجا (فواتير الشراء)
     - المالك/المدير بيضيف فاتورة شراء للطابور (/outbox/add)
     - الوكيل بياخد المعلّق (/outbox) ويكتبه في أورجا «مفتوح» ويبلّغ بالنتيجة (/outbox/done)
     - الواجهة بتجيب الحالة لكل أمر شراء (/outbox/status)
     مخزّنة في kv (مش في docs) علشان متتزامنش لكل المستخدمين وتسرّب التكلفة.
     ================================================================== */
  const OUT_KV = 'orga:outbox';
  async function canWrite(u) {
    if (!u) return false; if (u.owner) return true;
    const { rows } = await pool.query(`SELECT data FROM docs WHERE col='roles' AND id=$1 AND NOT deleted`, [u.id]);
    const role = rows[0] && rows[0].data && rows[0].data.role;
    return role === 'full' || role === 'manager';
  }
  const writeOnly = async (req, res, next) => { try { (await canWrite(req.user)) ? next() : res.status(403).json({ error: 'الكتابة في أورجا للمالك والمديرين بس' }); } catch (e) { next(e); } };
  // قراءة/تعديل الطابور داخل transaction (قفل الصف)
  async function withOut(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT v FROM kv WHERE k=$1 FOR UPDATE`, [OUT_KV]);
      const st = (rows[0] && rows[0].v) || { seq: 0, jobs: {} };
      if (!isObj(st.jobs)) st.jobs = {};
      const out = await fn(st);
      await client.query(`INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [OUT_KV, JSON.stringify(st)]);
      await client.query('COMMIT');
      return out;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }
  const posInt = x => { const n = Math.trunc(+x); return Number.isFinite(n) && n > 0 ? n : 0; };
  const nn = x => { const n = +x; return Number.isFinite(n) ? n : 0; };
  function cleanLines(arr) {
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (const l of arr.slice(0, 500)) {
      if (!isObj(l)) continue;
      const prod = posInt(l.prod); const qty = nn(l.qty);
      if (!prod || !(qty > 0)) return null;
      const o = { prod, qty, cost: Math.max(0, nn(l.cost)), consumer: Math.max(0, nn(l.consumer)) };
      if (nn(l.price)) o.price = Math.max(0, nn(l.price)); // سعر البيع (للبيع)
      if (l.bonus) o.bonus = 1;
      for (const k of ['disc1', 'disc2', 'disc3', 'disc4']) if (nn(l[k])) o[k] = nn(l[k]);
      if (l.expire && /^\d{4}-\d{2}-\d{2}$/.test(String(l.expire).slice(0, 10))) o.expire = String(l.expire).slice(0, 10);
      out.push(o);
    }
    return out.length ? out : null;
  }

  // إضافة فاتورة شراء للطابور (المالك/المدير)
  app.post('/api/orga/outbox/add', auth(false), writeOnly, async (req, res, next) => {
    try {
      const b = req.body || {};
      const account = posInt(b.account);
      if (!account) return res.status(400).json({ error: 'مفيش كود مورّد في أورجا للطرف ده' });
      const lines = cleanLines(b.lines);
      if (!lines) return res.status(400).json({ error: 'سطور الفاتورة غير صالحة (لازم أصناف لها كود أورجا وكمية أكبر من صفر)' });
      const store = posInt(b.store) || 1;
      const poId = String(b.poId || '').slice(0, 64);
      const poNo = String(b.poNo || '').slice(0, 40);
      const usersId = posInt(b.usersId) || 0;
      const kind = b.kind === 'sale' ? 'sale' : 'purchase';
      const accType = Number.isFinite(+b.accType) ? +b.accType : undefined;
      const job = await withOut(st => {
        // منع التكرار: لو نفس المستند لسه معلّق/شغال أو اتكتب خلاص في أورجا
        if (poId) for (const j of Object.values(st.jobs)) if (j.poId === poId && (j.status === 'pending' || j.status === 'sending' || j.status === 'done')) return { dup: j.id, status: j.status, orderHId: j.orderHId || null };
        const id = 'j' + (++st.seq);
        st.jobs[id] = { id, kind, poId, poNo, account, store, usersId, lines, mark: '[MZ#' + id + ']', status: 'pending', createdAt: now(), createdBy: req.user.name || req.user.username || '' };
        if (accType !== undefined) st.jobs[id].accType = accType;
        return { id };
      });
      if (job.dup) return res.json({ ok: true, jobId: job.dup, dup: true, status: job.status, orderHId: job.orderHId });
      res.json({ ok: true, jobId: job.id });
    } catch (e) { next(e); }
  });

  // الوكيل بياخد المعلّق
  app.post('/api/orga/outbox', agentAuth, async (req, res, next) => {
    try {
      await touch(req, {});
      // نسخة الوكيل — البيع يتكتب بس من وكيل 1.7.0+ (القديم يكتب الشراء بس)
      const av = String((req.body && req.body.agent && req.body.agent.ver) || '0').split('.').map(n => +n || 0);
      const saleOk = (av[0] > 1) || (av[0] === 1 && av[1] >= 7);
      const jobs = await withOut(st => {
        const take = [];
        for (const j of Object.values(st.jobs)) {
          if (j.kind === 'sale' && !saleOk) continue; // وكيل قديم: سيب فواتير البيع للوكيل الجديد
          if (j.status === 'pending' || (j.status === 'sending' && now() - (j.sentAt || 0) > 5 * 60e3)) {
            j.status = 'sending'; j.sentAt = now();
            take.push({ id: j.id, kind: j.kind || 'purchase', account: j.account, store: j.store, usersId: j.usersId, usersName: 'MIZAN', mark: j.mark, lines: j.lines, accType: j.accType });
          }
        }
        return take;
      });
      res.json({ jobs });
    } catch (e) { next(e); }
  });

  // الوكيل بيبلّغ بالنتيجة
  app.post('/api/orga/outbox/done', agentAuth, async (req, res, next) => {
    try {
      await touch(req, {});
      const results = Array.isArray(req.body && req.body.results) ? req.body.results : [];
      await withOut(st => {
        for (const r of results) {
          const j = st.jobs[String(r.jobId)]; if (!j) continue;
          if (r.ok) { j.status = 'done'; j.orderHId = posInt(r.orderHId) || null; j.accHId = posInt(r.accHId) || null; j.doneAt = now(); delete j.error; }
          else { j.status = 'error'; j.error = String(r.error || 'خطأ').slice(0, 300); j.doneAt = now(); }
        }
        // تنضيف: شيل اللي خلصوا بقالهم أكتر من 7 أيام
        for (const [id, j] of Object.entries(st.jobs)) if (j.status === 'done' && now() - (j.doneAt || 0) > 7 * 864e5) delete st.jobs[id];
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // الواجهة بتجيب حالة الطابور (المالك/المدير)
  app.get('/api/orga/outbox/status', auth(false), writeOnly, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT v FROM kv WHERE k=$1`, [OUT_KV]);
      const jobs = (rows[0] && rows[0].v && rows[0].v.jobs) || {};
      const byPo = {}; const list = [];
      for (const j of Object.values(jobs)) {
        const o = { id: j.id, kind: j.kind || 'purchase', poId: j.poId, poNo: j.poNo, status: j.status, orderHId: j.orderHId || null, error: j.error || '', createdAt: j.createdAt, createdBy: j.createdBy, doneAt: j.doneAt || 0 };
        list.push(o); if (j.poId) byPo[j.poId] = o;
      }
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      res.json({ byPo, list: list.slice(0, 200), enabled: true });
    } catch (e) { next(e); }
  });

  // إعادة محاولة فاتورة فشلت
  app.post('/api/orga/outbox/retry', auth(false), writeOnly, async (req, res, next) => {
    try {
      const id = String(req.body && req.body.jobId || '');
      await withOut(st => { const j = st.jobs[id]; if (j && j.status === 'error') { j.status = 'pending'; delete j.error; delete j.sentAt; } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* ---- استقبال التغييرات ----
     body: { col, keys:[حقول أورجا], up:{id:doc}, del:[id], agent:{ver,host}, allowMass } */
  app.post('/api/orga/push', agentAuth, async (req, res, next) => {
    const b = req.body || {};
    const col = b.col;
    if (!IDRX[col]) return res.status(400).json({ error: 'bad col' });
    const up = isObj(b.up) ? b.up : {};
    const del = Array.isArray(b.del) ? b.del : [];
    const keys = Array.isArray(b.keys) ? b.keys.filter(k => typeof k === 'string' && KEYRX.test(k) && k !== '__proto__').slice(0, 60) : [];
    const ids = Object.keys(up);
    if (ids.length + del.length > 5000) return res.status(400).json({ error: 'batch too big' });
    for (const id of ids) { if (!IDRX[col].test(id)) return res.status(400).json({ error: 'bad id ' + id }); const e = validItem(col, up[id]); if (e) return res.status(400).json({ error: id + ': ' + e }); }
    for (const id of del) if (typeof id !== 'string' || !IDRX[col].test(id) || id in up) return res.status(400).json({ error: 'bad delete id' });
    if (col === 'safes' && del.length) return res.status(400).json({ error: 'الخزائن مش بتتحذف من الربط' });

    const st = { written: 0, same: 0, kept: 0, deleted: 0 }; const cashEv = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (col === 'safes') {
        // الخزائن: بتتضاف لو مش موجودة بس — الاسم اللي اتعدّل في ميزان بيفضل
        for (const id of ids) {
          const cur = await client.query(`SELECT data,deleted FROM docs WHERE col='safes' AND id=$1 FOR UPDATE`, [id]);
          if (cur.rows[0] && !cur.rows[0].deleted) { st.same++; continue; }
          await client.query(`INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by) VALUES('safes',$1,$2,false,nextval('doc_seq'),$3,'orga-sync')
            ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data,deleted=false,seq=nextval('doc_seq'),updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by`,
            [id, JSON.stringify({ name: up[id].name.slice(0, 80), orga: up[id].orga }), now()]);
          st.written++;
        }
      } else {
        const X = 'x_' + col;
        const all = [...ids, ...del];
        // مكان كل سجل موجود (أي chunk — زي ما البرنامج بيعمل)
        const loc = new Map();
        if (all.length) {
          const { rows } = await client.query(`SELECT d.id cid, e.k FROM docs d CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(d.data->'items')='object' THEN d.data->'items' ELSE '{}'::jsonb END) e(k)
            WHERE d.col=$1 AND NOT d.deleted AND e.k = ANY($2)`, [X, all]);
          for (const r of rows) if (!loc.has(r.k)) loc.set(r.k, r.cid);
        }
        // حماية من حذف بالجملة (لو الملف اتغيّر أو اتمسح بالغلط)
        if (del.length > 30 && !b.allowMass) {
          const { rows } = await client.query(`SELECT count(*)::int n FROM docs d CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(d.data->'items')='object' THEN d.data->'items' ELSE '{}'::jsonb END) e(k) WHERE d.col=$1 AND NOT d.deleted AND e.k LIKE 'o%'`, [X]);
          if (del.length > rows[0].n * 0.02) { await client.query('ROLLBACK'); await touch(req, { lastErr: `اترفض حذف ${del.length} سجل من ${col} مرة واحدة` }); return res.status(409).json({ error: `الربط عاوز يحذف ${del.length} سجل مرة واحدة — اترفض للأمان`, code: 'mass_delete' }); }
        }
        const byChunk = new Map();
        const add = (id, v) => { const cid = loc.get(id) || chunkFor(col, id); if (!byChunk.has(cid)) byChunk.set(cid, []); byChunk.get(cid).push([id, v]); };
        for (const id of ids) add(id, up[id]);
        for (const id of del) if (loc.has(id)) add(id, null);
        for (const cid of [...byChunk.keys()].sort()) {
          const cur = await client.query(`SELECT data,deleted FROM docs WHERE col=$1 AND id=$2 FOR UPDATE`, [X, cid]);
          const base = cur.rows[0] && !cur.rows[0].deleted && isObj(cur.rows[0].data) ? cur.rows[0].data : {};
          const items = isObj(base.items) ? { ...base.items } : {};
          let changed = false;
          for (const [id, v] of byChunk.get(cid)) {
            const old = items[id];
            if (isObj(old) && !fromOrga(old)) { st.kept++; continue; } // سجل اتعمل في ميزان بنفس الـ id — مش بنلمسه
            if (v === null) { if (old != null) { items[id] = null; changed = true; st.deleted++; } continue; }
            // دمج: حقول أورجا بتتحدّث، وحقول ميزان (الموقع، الشريحة، …) بتفضل
            const nv = isObj(old) ? { ...old } : {};
            for (const k of keys) delete nv[k];
            Object.assign(nv, v);
            for (const k of Object.keys(nv)) if (nv[k] === null || nv[k] === undefined) delete nv[k];
            if (isObj(old) && same(old, nv)) { st.same++; continue; }
            if (notify && (col === 'cash' || col === 'invoices') && !isObj(old)) cashEv.push(...notify.detect('x_' + col, {}, { [id]: nv }, 'orga'));
            items[id] = nv; changed = true; st.written++;
          }
          if (!changed) continue;
          await client.query(`INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by) VALUES($1,$2,$3,false,nextval('doc_seq'),$4,'orga-sync')
            ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data,deleted=false,seq=nextval('doc_seq'),updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by`,
            [X, cid, JSON.stringify({ ...base, items, u: now() }), now()]);
        }
      }
      if (cashEv.length) await notify.emit(client, cashEv, null);
      await client.query('COMMIT');
      const c = await getCfg(); const stats = c.stats || {}; const s0 = stats[col] || {};
      stats[col] = { at: now(), written: (s0.written || 0) + st.written, deleted: (s0.deleted || 0) + st.deleted, kept: st.kept };
      await touch(req, { stats, lastErr: '' });
      res.json({ ok: true, ...st });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      next(e);
    } finally { client.release(); }
  });
  /* ---- قايمة كل سجلات أورجا (البرنامج بيبعتها بعد كل مراجعة كاملة) — بتتستخدم في «ميزان = أورجا بس» ---- */
  app.post('/api/orga/manifest', agentAuth, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!IDRX[b.col] || !Array.isArray(b.ids) || b.ids.length > 200000) return res.status(400).json({ error: 'bad manifest' });
      if (!b.ids.every(id => typeof id === 'string' && IDRX[b.col].test(id))) return res.status(400).json({ error: 'bad id' });
      await pool.query(`INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, ['orga:manifest:' + b.col, JSON.stringify({ at: now(), ids: b.ids })]);
      await touch(req, {}); res.json({ ok: true, n: b.ids.length });
    } catch (e) { next(e); }
  });

  /* ---- «ميزان = أورجا بس»: المالك بيمسح كل الأصناف/العملاء/الفواتير/الخزينة اللي مش موجودة في أورجا دلوقتي،
         ومعاها التحضير والشنط وخطوط السير والمرتجعات بتاعتها. المستخدمين والإعدادات والشرايح والموظفين والـ CRM بيفضلوا. ---- */
  async function manifests(db) {
    const { rows } = await db.query(`SELECT k, v FROM kv WHERE k LIKE 'orga:manifest:%'`);
    const m = {}; for (const r of rows) m[r.k.slice(14)] = r.v; return m;
  }
  app.get('/api/orga/purge', auth(false), ownerOnly, async (req, res, next) => {
    try { const m = await manifests(pool); res.json({ ready: Object.keys(IDRX).every(c => m[c] && now() - m[c].at < 26 * 3600e3), at: Math.min(...Object.keys(IDRX).map(c => (m[c] && m[c].at) || 0)), n: Object.fromEntries(Object.entries(m).map(([c, v]) => [c, (v.ids || []).length])) }); } catch (e) { next(e); }
  });
  app.post('/api/orga/purge', auth(false), ownerOnly, async (req, res, next) => {
    if ((req.body || {}).confirm !== 'أورجا بس') return res.status(400).json({ error: 'اكتب «أورجا بس» للتأكيد' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const m = await manifests(client);
      for (const c of Object.keys(IDRX)) if (!m[c] || now() - m[c].at > 26 * 3600e3 || !(m[c].ids || []).length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'لسه مفيش قايمة كاملة حديثة من أورجا — استنى أول مزامنة كاملة تخلص (أو شغّل run.bat على جهاز أورجا)' }); }
      const keep = Object.fromEntries(Object.keys(IDRX).map(c => [c, new Set(m[c].ids)]));
      // أمان: لو القايمة أصغر بكتير من سجلات أورجا اللي في ميزان (ملف غلط أو قديم) → رفض
      for (const col of ['products', 'parties', 'invoices', 'cash']) {
        const { rows } = await client.query(`SELECT count(*)::int n FROM docs d CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(d.data->'items')='object' THEN d.data->'items' ELSE '{}'::jsonb END) e(k,v) WHERE d.col=$1 AND NOT d.deleted AND jsonb_typeof(e.v)='object' AND (e.v ? 'orga' OR e.v ? 'orgaUser')`, ['x_' + col]);
        if (keep[col].size < rows[0].n * 0.5) { await client.query('ROLLBACK'); return res.status(409).json({ error: `قايمة أورجا فيها ${keep[col].size} بس من ${col} وميزان فيه ${rows[0].n} من أورجا — غالبًا الملف غلط، المسح اتلغى` }); }
      }
      const out = {};
      const write = (col, id, data) => client.query(`UPDATE docs SET data=$3,seq=nextval('doc_seq'),updated_at=$4,updated_by='orga-purge' WHERE col=$1 AND id=$2`, [col, id, JSON.stringify(data), now()]);
      const kill = (col, id) => client.query(`UPDATE docs SET deleted=true,data=NULL,seq=nextval('doc_seq'),updated_at=$3,updated_by='orga-purge' WHERE col=$1 AND id=$2`, [col, id, now()]);
      // خطوة 1: الجداول اللي جاية من أورجا
      const left = {};
      for (const col of ['products', 'parties', 'invoices', 'cash']) {
        const { rows } = await client.query(`SELECT id, data FROM docs WHERE col=$1 AND NOT deleted FOR UPDATE`, ['x_' + col]);
        let n = 0; left[col] = new Set();
        for (const r of rows) {
          const items = isObj(r.data && r.data.items) ? { ...r.data.items } : {}; let ch = false;
          for (const [id, v] of Object.entries(items)) { if (!isObj(v)) continue; if (keep[col].has(id) || (col === 'invoices' && /^ov\d+$/.test(id))) { // ov = تقييم المخزون من أورجا وقت النقلة
            left[col].add(id); continue; } items[id] = null; ch = true; n++; }
          if (ch) await write('x_' + col, r.id, { ...r.data, items, u: now() });
        }
        out[col] = n;
      }
      { const { rows } = await client.query(`SELECT id FROM docs WHERE col='safes' AND NOT deleted FOR UPDATE`); let n = 0; for (const r of rows) if (!keep.safes.has(r.id)) { await kill('safes', r.id); n++; } out.safes = n; }
      // خطوة 2: اللي مربوط بالفواتير والعملاء اللي اتمسحت
      const inv = left.invoices, par = left.parties;
      for (const col of ['prints', 'picks']) { // مفتاحهم = رقم الفاتورة
        const { rows } = await client.query(`SELECT id, data FROM docs WHERE col=$1 AND NOT deleted FOR UPDATE`, ['x_' + col]);
        let n = 0; for (const r of rows) { const items = isObj(r.data && r.data.items) ? { ...r.data.items } : {}; let ch = false; for (const [id, v] of Object.entries(items)) if (v != null && !inv.has(id)) { items[id] = null; ch = true; n++; } if (ch) await write('x_' + col, r.id, { ...r.data, items, u: now() }); }
        out[col] = n;
      }
      { const { rows } = await client.query(`SELECT id, data FROM docs WHERE col='x_pkgs' AND NOT deleted FOR UPDATE`); let n = 0;
        for (const r of rows) { const items = isObj(r.data && r.data.items) ? { ...r.data.items } : {}; let ch = false;
          for (const [id, v] of Object.entries(items)) { if (!isObj(v)) continue; const ids = (v.invIds || []).filter(x => inv.has(x)); if (!ids.length) { items[id] = null; ch = true; n++; } else if (ids.length !== (v.invIds || []).length) { items[id] = { ...v, invIds: ids }; ch = true; } }
          if (ch) await write('x_pkgs', r.id, { ...r.data, items, u: now() }); } out.pkgs = n; }
      { const { rows } = await client.query(`SELECT id, data FROM docs WHERE col='runs' AND NOT deleted FOR UPDATE`); let n = 0;
        for (const r of rows) { const st = Array.isArray(r.data && r.data.stops) ? r.data.stops : []; const ok = st.filter(x => inv.has(x.invId)); if (!ok.length) { await kill('runs', r.id); n++; } else if (ok.length !== st.length) await write('runs', r.id, { ...r.data, stops: ok }); } out.runs = n; }
      for (const col of ['rets', 'cheques']) { // مرتجعات وشيكات لعملاء اتمسحوا
        const { rows } = await client.query(`SELECT id, data FROM docs WHERE col=$1 AND NOT deleted FOR UPDATE`, ['x_' + col]);
        let n = 0; for (const r of rows) { const items = isObj(r.data && r.data.items) ? { ...r.data.items } : {}; let ch = false; for (const [id, v] of Object.entries(items)) if (isObj(v) && v.partyId && !par.has(v.partyId)) { items[id] = null; ch = true; n++; } if (ch) await write('x_' + col, r.id, { ...r.data, items, u: now() }); }
        out[col] = n;
      }
      // الترقيم يكمّل من آخر رقم في أورجا
      await client.query(`DELETE FROM kv WHERE k LIKE 'no:%'`);
      await client.query('COMMIT');
      const c = await getCfg(); c.purgedAt = now(); c.purged = out; await setCfg(c);
      res.json({ ok: true, removed: out });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); next(e); }
    finally { client.release(); }
  });
};
