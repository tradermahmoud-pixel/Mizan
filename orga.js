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

  /* ---- علامة الربط على مستند ميزان نفسه (بتتزامن لكل الأجهزة) ----
     orgaJob/orgaAt/orgaBy = اتبعت لأورجا · orgaOut = رقمه في أورجا (INVOICES_H_ID / ORDER_H_ID) · orgaErr = فشل
     orgaGone = اتحذف من أورجا بعد ما اتكتب. السيرفر بس اللي بيكتب الحقول دي (server.js بيحميها من تعديل الأجهزة). */
  const MZ_ID = /^[A-Za-z0-9_-]{4,64}$/;
  async function markInv(id, patch) {
    id = String(id || '');
    if (!MZ_ID.test(id) || IDRX.invoices.test(id)) return null; // مستند ميزان بس — مش سجل جاي من أورجا
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const f = await client.query(`SELECT id FROM docs WHERE col='x_invoices' AND NOT deleted AND jsonb_typeof(data->'items'->$1::text)='object' LIMIT 1`, [id]);
      if (!f.rows[0]) { await client.query('ROLLBACK'); return null; }
      const cid = f.rows[0].id;
      const cur = await client.query(`SELECT data FROM docs WHERE col='x_invoices' AND id=$1 AND NOT deleted FOR UPDATE`, [cid]);
      const data = cur.rows[0] && cur.rows[0].data;
      const it = data && isObj(data.items) ? data.items[id] : null;
      if (!isObj(it)) { await client.query('ROLLBACK'); return null; }
      const nv = { ...it }; let ch = false;
      for (const [k, v] of Object.entries(patch)) {
        if (v == null) { if (k in nv) { delete nv[k]; ch = true; } }
        else if (nv[k] !== v) { nv[k] = v; ch = true; }
      }
      if (ch) await client.query(`UPDATE docs SET data=$2,seq=nextval('doc_seq'),updated_at=$3,updated_by='orga-out' WHERE col='x_invoices' AND id=$1`,
        [cid, JSON.stringify({ ...data, items: { ...data.items, [id]: nv }, u: now() }), now()]);
      await client.query('COMMIT');
      return nv;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }
  const markSafe = (id, patch) => markInv(id, patch).catch(e => { console.error('orga mark', id, e.message); return null; });
  // كل مستندات ميزان اللي ليها رقم في أورجا (لاكتشاف الحذف من أورجا)
  async function linkedDocs(extraWhere = '', params = []) {
    const { rows } = await pool.query(`SELECT e.k AS id, e.v->>'orgaOut' AS n, e.v->>'orgaOutAt' AS oat, (e.v ? 'orgaGone') AS gone, e.v->>'type' AS t
      FROM docs d, jsonb_each(CASE WHEN jsonb_typeof(d.data->'items')='object' THEN d.data->'items' ELSE '{}'::jsonb END) e(k,v)
      WHERE d.col='x_invoices' AND NOT d.deleted AND jsonb_typeof(e.v)='object' AND e.v ? 'orgaOut' AND e.v->>'type' IN ('sale','quote','purchase') ${extraWhere}`, params);
    return rows.filter(r => !IDRX.invoices.test(r.id));
  }
  // تعليم الفواتير القديمة (اللي اتبعتت قبل التحديث ده) من الطابور — مرة واحدة
  let backfilled = false;
  async function backfillMarks() {
    if (backfilled) return; backfilled = true;
    try {
      const flag = await pool.query(`SELECT 1 FROM kv WHERE k='orga:outmark:v1'`);
      if (flag.rows.length) return; // اتعملت قبل كده
      const { rows } = await pool.query(`SELECT v FROM kv WHERE k=$1`, [OUT_KV]);
      const jobs = (rows[0] && rows[0].v && rows[0].v.jobs) || {};
      for (const j of Object.values(jobs)) {
        if (!j.poId || j.poId.includes('#')) continue;
        const p = { orgaJob: j.id, orgaAt: j.createdAt || now(), orgaBy: j.createdBy || '' };
        if (j.status === 'done' && j.orderHId) Object.assign(p, { orgaOut: +j.orderHId, orgaOutAt: j.doneAt || now() });
        if (j.status === 'error') p.orgaErr = String(j.error || 'خطأ').slice(0, 120);
        await markSafe(j.poId, p);
      }
      await pool.query(`INSERT INTO kv(k,v) VALUES('orga:outmark:v1',$1) ON CONFLICT (k) DO NOTHING`, [JSON.stringify({ at: now() })]);
    } catch (e) { backfilled = false; console.error('orga backfill', e.message); }
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

  // فاتورة ميزان (للتأكد قبل الإرسال ومنع التكرار)
  async function getInv(id) {
    id = String(id || '');
    if (!MZ_ID.test(id) || IDRX.invoices.test(id)) return null;
    const { rows } = await pool.query(`SELECT data->'items'->$1::text v FROM docs WHERE col='x_invoices' AND NOT deleted AND jsonb_typeof(data->'items'->$1::text)='object' LIMIT 1`, [id]);
    return rows[0] ? rows[0].v : null;
  }
  // إضافة فاتورة للطابور (المالك/المدير): أمر توريد → شراء، عرض سعر أو فاتورة بيع من ميزان → بيع
  app.post('/api/orga/outbox/add', auth(false), writeOnly, async (req, res, next) => {
    try {
      const b = req.body || {};
      const account = posInt(b.account);
      if (!account) return res.status(400).json({ error: 'مفيش كود أورجا للطرف ده (العميل/المورّد)' });
      const lines = cleanLines(b.lines);
      if (!lines) return res.status(400).json({ error: 'سطور الفاتورة غير صالحة (لازم أصناف لها كود أورجا وكمية أكبر من صفر)' });
      const store = posInt(b.store) || 1;
      const poId = String(b.poId || '').slice(0, 64);
      const poNo = String(b.poNo || '').slice(0, 40);
      const usersId = posInt(b.usersId) || 0;
      const kind = b.kind === 'sale' ? 'sale' : 'purchase';
      const src = kind === 'purchase' ? (b.src === 'purchase' ? 'purchase' : 'porder') : (b.src === 'sale' ? 'sale' : 'quote');
      const accType = Number.isFinite(+b.accType) ? +b.accType : undefined;
      const note = String(b.note || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 24); // مرجع فاتورة المورّد (يتكتب في NOTS_ بأورجا)
      // المستند نفسه في ميزان (لو مش جزء من استلام مجمّع)
      const whole = poId && !poId.includes('#');
      const inv = whole ? await getInv(poId) : null;
      if (src === 'sale' || src === 'purchase') {
        if (!poId || IDRX.invoices.test(poId)) return res.status(400).json({ error: 'الفاتورة دي جاية من أورجا أصلًا — مش محتاجة تتبعت' });
        if (!inv) return res.status(409).json({ error: 'الفاتورة لسه ما وصلتش للسيرفر — استنى ثانيتين وجرّب تاني' });
        if (inv.type !== src) return res.status(400).json({ error: src === 'purchase' ? 'ده مش فاتورة شراء' : 'ده مش فاتورة بيع' });
        if (inv.orgaUser != null || inv.orga != null) return res.status(400).json({ error: 'الفاتورة دي جاية من أورجا أصلًا — مش محتاجة تتبعت' });
      }
      const gone = !!(inv && inv.orgaGone);
      // اتكتبت في أورجا قبل كده (حتى لو الطابور اتنضف بعد 7 أيام)
      if (inv && +inv.orgaOut && !gone) return res.json({ ok: true, jobId: inv.orgaJob || '', dup: true, status: 'done', orderHId: +inv.orgaOut });
      const by = req.user.name || req.user.username || '';
      const job = await withOut(st => {
        // منع التكرار: لو نفس المستند لسه معلّق/شغال أو اتكتب خلاص في أورجا (إلا لو اتحذف من أورجا بعدها)
        if (poId) for (const j of Object.values(st.jobs)) if (j.poId === poId && (j.status === 'pending' || j.status === 'sending' || (j.status === 'done' && !gone))) return { dup: j.id, status: j.status, orderHId: j.orderHId || null };
        // محاولات فاشلة قديمة لنفس المستند ملهاش لازمة بعد الإرسال الجديد
        if (poId) for (const [k, j] of Object.entries(st.jobs)) if (j.poId === poId && j.status === 'error') delete st.jobs[k];
        const id = 'j' + (++st.seq);
        st.jobs[id] = { id, kind, src, poId, poNo, account, store, usersId, lines, mark: '[MZ#' + id + ']' + (note ? ' ' + note : ''), status: 'pending', createdAt: now(), createdBy: by };
        if (accType !== undefined) st.jobs[id].accType = accType;
        return { id };
      });
      if (job.dup) return res.json({ ok: true, jobId: job.dup, dup: true, status: job.status, orderHId: job.orderHId });
      if (whole) await markSafe(poId, { orgaJob: job.id, orgaAt: now(), orgaBy: by, orgaErr: null, orgaGone: null, orgaOut: null, orgaOutAt: null });
      res.json({ ok: true, jobId: job.id });
    } catch (e) { next(e); }
  });

  // تحديث أسعار الشرائح في أورجا: المالك/المدير بيضيف أصناف للطابور (كل صنف PRICE_1..5)
  app.post('/api/orga/prices/add', auth(false), writeOnly, async (req, res, next) => {
    try {
      await touch(req, {});
      const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 5000) : [];
      const by = (req.user && (req.user.name || req.user.id)) || '';
      let queued = 0;
      await withOut(st => {
        if (!isObj(st.prices)) st.prices = {};
        st.seq = st.seq || 0;
        for (const it of items) {
          const prod = posInt(it && it.prod); if (!prod) continue;
          const prices = {};
          if (isObj(it.prices)) for (const k of Object.keys(it.prices)) {
            if (/^PRICE_[1-5]$/.test(k)) { const v = +it.prices[k]; if (isFinite(v) && v >= 0) prices[k] = Math.round(v * 10000) / 10000; }
          }
          if (!Object.keys(prices).length) continue;
          const id = String(++st.seq);
          st.prices[id] = { id, prod, prices, status: 'pending', createdAt: now(), createdBy: by };
          queued++;
        }
      });
      res.json({ queued });
    } catch (e) { next(e); }
  });

  // حالة طابور الأسعار (المالك/المدير)
  app.get('/api/orga/prices/status', auth(false), writeOnly, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT v FROM kv WHERE k=$1`, [OUT_KV]);
      const st = (rows[0] && rows[0].v) || {};
      const ps = isObj(st.prices) ? Object.values(st.prices) : [];
      const counts = { pending: 0, sending: 0, done: 0, error: 0 };
      const errors = [];
      for (const j of ps) { counts[j.status] = (counts[j.status] || 0) + 1; if (j.status === 'error' && errors.length < 10) errors.push({ prod: j.prod, error: j.error }); }
      res.json({ total: ps.length, counts, errors });
    } catch (e) { next(e); }
  });

  // الوكيل بياخد المعلّق
  app.post('/api/orga/outbox', agentAuth, async (req, res, next) => {
    try {
      await touch(req, {});
      // نسخة الوكيل — البيع يتكتب بس من وكيل 1.7.0+ (القديم يكتب الشراء بس)
      const av = String((req.body && req.body.agent && req.body.agent.ver) || '0').split('.').map(n => +n || 0);
      const saleOk = (av[0] > 1) || (av[0] === 1 && av[1] >= 7);
      const priceOk = (av[0] > 1) || (av[0] === 1 && av[1] >= 8); // تحديث الأسعار من وكيل 1.8.0+
      const out = await withOut(st => {
        const take = [];
        for (const j of Object.values(st.jobs)) {
          if (j.kind === 'sale' && !saleOk) continue; // وكيل قديم: سيب فواتير البيع للوكيل الجديد
          if (j.status === 'pending' || (j.status === 'sending' && now() - (j.sentAt || 0) > 5 * 60e3)) {
            j.status = 'sending'; j.sentAt = now();
            take.push({ id: j.id, kind: j.kind || 'purchase', account: j.account, store: j.store, usersId: j.usersId, usersName: 'MIZAN', mark: j.mark, lines: j.lines, accType: j.accType });
          }
        }
        const prices = [];
        if (priceOk && isObj(st.prices)) {
          for (const j of Object.values(st.prices)) {
            if (j.status === 'pending' || (j.status === 'sending' && now() - (j.sentAt || 0) > 5 * 60e3)) {
              j.status = 'sending'; j.sentAt = now();
              prices.push({ id: j.id, prod: j.prod, prices: j.prices });
              if (prices.length >= 150) break; // دفعة في كل مرة
            }
          }
        }
        return { jobs: take, prices };
      });
      res.json({ jobs: out.jobs, prices: out.prices });
    } catch (e) { next(e); }
  });

  // الوكيل بيبلّغ بالنتيجة
  app.post('/api/orga/outbox/done', agentAuth, async (req, res, next) => {
    try {
      await touch(req, {});
      const results = Array.isArray(req.body && req.body.results) ? req.body.results : [];
      const priceDone = Array.isArray(req.body && req.body.priceDone) ? req.body.priceDone : [];
      const marks = [];
      await withOut(st => {
        for (const r of results) {
          const j = st.jobs[String(r.jobId)]; if (!j) continue;
          if (r.ok) { j.status = 'done'; j.orderHId = posInt(r.orderHId) || null; j.accHId = posInt(r.accHId) || null; j.doneAt = now(); delete j.error; }
          else { j.status = 'error'; j.error = String(r.error || 'خطأ').slice(0, 300); j.doneAt = now(); }
          if (j.poId && !j.poId.includes('#')) marks.push([j.poId, r.ok
            ? { orgaJob: j.id, orgaOut: j.orderHId, orgaOutAt: now(), orgaErr: null, orgaGone: null }
            : { orgaJob: j.id, orgaErr: j.error.slice(0, 120) }]);
        }
        if (isObj(st.prices)) for (const r of priceDone) {
          const j = st.prices[String(r.id)]; if (!j) continue;
          if (r.ok) { j.status = 'done'; j.doneAt = now(); delete j.error; }
          else { j.status = 'error'; j.error = String(r.error || 'خطأ').slice(0, 200); j.doneAt = now(); }
        }
        // تنضيف: شيل اللي خلصوا بقالهم أكتر من 7 أيام (الربط نفسه بيفضل متسجّل على المستند)
        for (const [id, j] of Object.entries(st.jobs)) if (j.status === 'done' && now() - (j.doneAt || 0) > 7 * 864e5) delete st.jobs[id];
        if (isObj(st.prices)) for (const [id, j] of Object.entries(st.prices)) if (j.status === 'done' && now() - (j.doneAt || 0) > 2 * 864e5) delete st.prices[id];
      });
      for (const [id, p] of marks) await markSafe(id, p);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // الواجهة بتجيب حالة الطابور (المالك/المدير)
  app.get('/api/orga/outbox/status', auth(false), writeOnly, async (req, res, next) => {
    try {
      backfillMarks().catch(() => {});
      const { rows } = await pool.query(`SELECT v FROM kv WHERE k=$1`, [OUT_KV]);
      const jobs = (rows[0] && rows[0].v && rows[0].v.jobs) || {};
      const byPo = {}; const list = [];
      for (const j of Object.values(jobs)) {
        const o = { id: j.id, kind: j.kind || 'purchase', src: j.src || (j.kind === 'sale' ? 'quote' : 'porder'), poId: j.poId, poNo: j.poNo, status: j.status, orderHId: j.orderHId || null, error: j.error || '', createdAt: j.createdAt, createdBy: j.createdBy, doneAt: j.doneAt || 0 };
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
      const po = await withOut(st => { const j = st.jobs[id]; if (j && j.status === 'error') { j.status = 'pending'; delete j.error; delete j.sentAt; return j.poId; } return null; });
      if (po && !po.includes('#')) await markSafe(po, { orgaErr: null });
      res.json({ ok: true, retried: !!po });
    } catch (e) { next(e); }
  });

  // إلغاء إرسال لسه ماتاخدش (مثلًا جهاز أورجا مقفول وعاوز تعدّل الفاتورة)
  app.post('/api/orga/outbox/cancel', auth(false), writeOnly, async (req, res, next) => {
    try {
      const poId = String(req.body && req.body.poId || '').slice(0, 64);
      if (!poId) return res.status(400).json({ error: 'bad poId' });
      const r = await withOut(st => {
        const js = Object.values(st.jobs).filter(j => j.poId === poId);
        if (js.some(j => j.status === 'sending')) return 'busy';
        if (js.some(j => j.status === 'done')) return 'done';
        let n = 0; for (const j of js) if (j.status === 'pending' || j.status === 'error') { delete st.jobs[j.id]; n++; }
        return n;
      });
      if (r === 'busy') return res.status(409).json({ error: 'جهاز أورجا بدأ يكتبها دلوقتي — استنى النتيجة' });
      if (r === 'done') return res.status(409).json({ error: 'اتكتبت في أورجا خلاص — لو عاوز تلغيها احذفها من أورجا' });
      if (!poId.includes('#')) await markSafe(poId, { orgaJob: null, orgaAt: null, orgaBy: null, orgaErr: null });
      res.json({ ok: true, removed: r });
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
      // فاتورة بيع اتبعتت من ميزان واتحذفت من أورجا → تتعلّم «اتحذفت من أورجا» (وميزان مايحسبهاش)
      if (col === 'invoices') {
        const gone = del.filter(id => /^os\d+$/.test(id)).map(id => id.slice(2));
        if (gone.length) { try { for (const r of await linkedDocs(`AND e.v->>'orgaOut' = ANY($1::text[])`, [gone])) if (!r.gone) await markSafe(r.id, { orgaGone: now() }); } catch (e) { console.error('orga gone', e.message); } }
      }
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
      // المراجعة اليومية: أي فاتورة متصدّرة نسختها اختفت من أورجا (أو رجعت) — بعد ما يعدّي وقت كفاية على كتابتها
      if (b.col === 'invoices' && b.ids.length) {
        try {
          const has = new Set(b.ids);
          for (const r of await linkedDocs()) {
            const inOrga = has.has((r.t === 'purchase' ? 'opu' : 'os') + r.n);
            if (!inOrga && !r.gone && now() - (+r.oat || 0) > 30 * 60e3) await markSafe(r.id, { orgaGone: now() });
            else if (inOrga && r.gone) await markSafe(r.id, { orgaGone: null });
          }
        } catch (e) { console.error('orga manifest marks', e.message); }
      }
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
          for (const [id, v] of Object.entries(items)) { if (!isObj(v)) continue; if (keep[col].has(id) || (col === 'invoices' && /^ov\d+$/.test(id)) // ov = تقييم المخزون من أورجا وقت النقلة
            || (col === 'invoices' && v.type === 'sale' && +v.orgaOut && keep.invoices.has('os' + v.orgaOut)) // فاتورة بيع من ميزان اتكتبت في أورجا ونسختها موجودة هناك
            || (col === 'invoices' && v.type === 'purchase' && +v.orgaOut && keep.invoices.has('opu' + v.orgaOut))) { // فاتورة شراء من ميزان اتكتبت في أورجا
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
