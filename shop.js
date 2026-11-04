'use strict';
/* صفحة الصيدليات: كل صيدلية ليها حساب مربوط بعميل واحد، وبتعمل فواتير لنفسها بس.
   الحساب ده ممنوع من كل مسارات البرنامج (الفلتر في auth جوه server.js) — مسموح له بالمسارات اللي هنا بس.
   الأسعار والرصيد بيتحسبوا هنا على السيرفر، وأي سعر جاي من المتصفح بيستخدم للمقارنة بس (لو اتغير نبلّغه). */
const crypto = require('crypto');

const MAX_LINES = 10;      // أقصى أصناف في الفاتورة الواحدة
const MAX_INVOICES = 20;   // أقصى عدد فواتير في حفظة واحدة
const MAX_QTY = 100000;
const RESULTS = 30;
const LOCK_ID = 771001;    // حفظ واحد في المرة علشان مراجعة الرصيد تبقى مظبوطة
const INV_CHUNKS = 256;    // نفس تقسيم الفواتير في البرنامج
const TZ = 'Africa/Cairo';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const r2 = n => Math.round(n * 100) / 100;
const fnv = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const chunkFor = id => 'b' + String(fnv(id) % INV_CHUNKS).padStart(3, '0');
const digits = s => String(s == null ? '' : s).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
const norm = s => digits(s).toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, ' ').trim();
const todayCairo = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const oops = (status, error, extra) => Object.assign(new Error(error), { status, extra });
// بحث مرن: تحمّل غلطة إملائية واحدة لكل كلمة + مطابقة الحروف بالترتيب
const near1 = (a, b) => {
  if (a === b) return true;
  const la = a.length, lb = b.length; if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, ed = 0;
  while (i < la && j < lb) { if (a[i] === b[j]) { i++; j++; } else { if (++ed > 1) return false; if (la > lb) i++; else if (lb > la) j++; else { i++; j++; } } }
  return ed + (la - i) + (lb - j) <= 1;
};
const fuzzyWord = (w, n) => { if (n.includes(w)) return true; if (w.length < 4) return false; for (const t of n.split(' ')) if (near1(w, t)) return true; return false; };
const subseq = (q, n) => { let i = 0; for (let j = 0; j < n.length && i < q.length; j++) if (n[j] === q[i]) i++; return i === q.length; };

module.exports = function (app, { pool, auth, sessionUser, priceData, reserveNo, hashPw, DEF_TIERS, now }) {
  async function partyOf(db, id) {
    const { rows } = await db.query(`SELECT data->'items'->$1::text v FROM docs WHERE col='x_parties' AND NOT deleted AND jsonb_typeof(data->'items'->$1::text)='object' LIMIT 1`, [id]);
    return rows[0] ? rows[0].v : null;
  }
  async function tierOf(db, party) {
    if (!party || !party.tier) return null;
    const { rows } = await db.query(`SELECT data FROM docs WHERE col='settings' AND id='main' AND NOT deleted`);
    const set = (rows[0] && rows[0].data) || {};
    const list = Array.isArray(set.tiers) && set.tiers.length ? set.tiers : DEF_TIERS;
    return list.find(t => t && t.id === party.tier) || null;
  }
  const portal = async (req, res, next) => {
    try {
      const u = await sessionUser(req);
      if (!u) return res.status(401).json({ error: 'login' });
      if (!u.portal_party) return res.status(403).json({ error: 'forbidden' });
      req.user = u;
      req.party = await partyOf(pool, u.portal_party);
      req.tier = await tierOf(pool, req.party);
      res.setHeader('Cache-Control', 'no-store');
      next();
    } catch (e) { next(e); }
  };
  // الصنف بيظهر بس لو ليه سعر شريحة ورصيد في المخزن الرئيسي؛ بنبعت المتاح (وحدات كاملة) للعميل علشان ميطلبش أكتر
  const offer = (pd, tier, pid) => {
    const p = pd.prods[pid]; if (!p) return null;
    const price = pd.px.t[tier.id] && pd.px.t[tier.id][pid];
    const st = pd.stock(pid);
    if (!(price > 0) || !(st > 0.0001)) return null;
    return { id: pid, name: p.name, consumer: +p.consumer || +p.price || 0, price, avail: Math.max(0, Math.floor(st)) };
  };

  app.get('/api/shop/me', portal, (req, res) => {
    res.json({ name: (req.party && req.party.name) || req.user.name, ready: !!req.tier, tier: req.tier ? req.tier.name : '', days: req.tier ? +req.tier.days || 0 : 0, maxLines: MAX_LINES });
  });

  app.get('/api/shop/search', portal, async (req, res, next) => {
    try {
      if (!req.tier) return res.json({ items: [] });
      const raw = digits(req.query.q).trim().slice(0, 80);
      if (!raw) return res.json({ items: [] });
      const pd = await priceData(pool);
      const q = norm(raw); const words = q.split(' ').filter(Boolean);
      const qc = q.replace(/ /g, '');
      const exact = String(req.query.exact || '') === '1';
      const need = Math.max(1, Math.ceil(words.length * 0.7));
      const hits = [];
      for (const c of pd.index()) {
        let score = -1;
        if (c.codes.includes(raw)) score = 0;
        else if (!exact) {
          if (c.n.startsWith(q)) score = 1;
          else if (words.every(w => c.n.includes(w))) score = 2;
          else if (raw.length >= 4 && c.codes.some(b => b.includes(raw))) score = 3;
          else if (words.length > 1 && words.filter(w => c.n.includes(w)).length >= need) score = 4; // أغلب الكلمات
          else if (words.every(w => fuzzyWord(w, c.n))) score = 5;                                   // تحمّل غلطة إملائية
          else if (qc.length >= 4 && subseq(qc, c.n.replace(/ /g, ''))) score = 6;                    // الحروف بالترتيب
        }
        if (score < 0) continue;
        const o = offer(pd, req.tier, c.id);
        if (o) hits.push([score, o]);
      }
      hits.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'ar'));
      res.json({ items: hits.slice(0, RESULTS).map(h => h[1]) });
    } catch (e) { next(e); }
  });

  app.post('/api/shop/invoices', portal, async (req, res, next) => {
    const key = String(req.body.key || '');
    const list = req.body.invoices;
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key) || !Array.isArray(list) || !list.length || list.length > MAX_INVOICES) return res.status(400).json({ error: 'البيانات مش سليمة' });
    if (!req.tier) return res.status(403).json({ error: 'حسابك لسه مش جاهز — كلم الشركة' });
    for (const inv of list) {
      const lines = isObj(inv) && Array.isArray(inv.lines) ? inv.lines : null;
      if (!lines || !lines.length) return res.status(400).json({ error: 'فيه فاتورة فاضية' });
      if (lines.length > MAX_LINES) return res.status(400).json({ error: `الفاتورة ماتزيدش عن ${MAX_LINES} أصناف` });
      const seen = new Set();
      for (const l of lines) {
        if (!isObj(l) || typeof l.pid !== 'string' || seen.has(l.pid)) return res.status(400).json({ error: 'فيه صنف متكرر في الفاتورة' });
        seen.add(l.pid);
        if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_QTY) return res.status(400).json({ error: 'الكمية لازم تكون رقم صحيح أكبر من صفر' });
      }
    }
    const u = req.user; const kvKey = 'shop:' + u.id + ':' + key;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      // نفس الحفظة وصلت مرتين (دوسة مكررة أو إعادة محاولة بعد انقطاع النت)
      const dup = await client.query('SELECT v FROM kv WHERE k=$1', [kvKey]);
      if (dup.rows[0]) { await client.query('COMMIT'); return res.json(dup.rows[0].v); }

      const party = await partyOf(client, u.portal_party);
      const tier = await tierOf(client, party);
      if (!tier) throw oops(403, 'حسابك لسه مش جاهز — كلم الشركة');
      const pd = await priceData(client);
      const wanted = {}; const gone = new Map(); const changed = new Map();
      for (const inv of list) for (const l of inv.lines) wanted[l.pid] = (wanted[l.pid] || 0) + l.qty;
      for (const [pid, q] of Object.entries(wanted)) {
        const name = (pd.prods[pid] && pd.prods[pid].name) || '';
        const o = offer(pd, tier, pid);
        if (!o || pd.stock(pid) + 0.0001 < q) { gone.set(pid, { pid, name }); continue; }
        // الكود اللي بيوصل من المتصفح مابيحددش السعر — لو اختلف بنبلّغه يراجع
        for (const inv of list) for (const l of inv.lines) if (l.pid === pid && Math.abs((+l.price || 0) - o.price) > 0.004) changed.set(pid, { pid, name, price: o.price, consumer: o.consumer });
      }
      if (gone.size) throw oops(409, 'فيه أصناف الكمية المطلوبة منها مش متاحة', { gone: [...gone.values()] });
      if (changed.size) throw oops(409, 'فيه أصناف سعرها اتغير — راجع الفاتورة واحفظ تاني', { changed: [...changed.values()] });

      const date = todayCairo(); const iso = new Date().toISOString(); const t = now();
      const out = [];
      for (const inv of list) {
        const id = 'sh' + crypto.randomBytes(12).toString('base64url');
        const no = await reserveNo(client, 'sale');
        const lines = inv.lines.map(l => { const o = offer(pd, tier, l.pid); return { pid: l.pid, qty: l.qty, price: o.price, disc: 0, cost: '', consumer: o.consumer }; });
        const doc = { type: 'sale', date, partyId: u.portal_party, storeId: 'main', toStoreId: '', empId: '', lines, discount: 0, taxRate: 0, paid: 0, payFull: false, notes: 'فاتورة من صفحة الصيدلية', portal: true, no, createdAt: iso, createdBy: u.id };
        if (+tier.days) doc.dueDate = addDays(date, +tier.days);
        const cid = chunkFor(id);
        const cur = await client.query('SELECT data,deleted FROM docs WHERE col=$1 AND id=$2 FOR UPDATE', ['x_invoices', cid]);
        const base = cur.rows[0] && !cur.rows[0].deleted && isObj(cur.rows[0].data) ? cur.rows[0].data : {};
        const data = { ...base, items: { ...(isObj(base.items) ? base.items : {}), [id]: doc }, u: t };
        await client.query(`INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by) VALUES($1,$2,$3,false,nextval('doc_seq'),$4,$5)
          ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data,deleted=false,seq=nextval('doc_seq'),updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by`, ['x_invoices', cid, JSON.stringify(data), t, u.id]);
        out.push({ id, no, total: r2(lines.reduce((s, l) => s + l.qty * l.price, 0)), lines: lines.length });
      }
      const result = { ok: true, invoices: out.map(({ no, total, lines }) => ({ no, total, lines })) };
      // تنبيه واحد للمالك لكل حفظة
      const owners = await client.query('SELECT id FROM users WHERE owner AND NOT disabled');
      if (owners.rows.length) {
        const nid = 'n' + t.toString(36) + crypto.randomBytes(4).toString('hex');
        await client.query(`INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by) VALUES('notifs',$1,$2,false,nextval('doc_seq'),$3,$4)`, [nid, JSON.stringify({
          kind: 'shop', at: t, to: owners.rows.map(r => r.id), seen: {}, src: 'mizan', by: (party && party.name) || u.name, byId: u.id,
          amount: r2(out.reduce((s, x) => s + x.total, 0)), safeName: 'صفحة الصيدلية', what: 'فاتورة صيدلية جديدة',
          party: (party && party.name) || '', partyId: u.portal_party, no: out.map(x => x.no).join('، '), date,
          invs: out.map(x => ({ id: x.id, no: x.no, total: x.total })), ref: { c: 'invoices', id: out[0].id },
        }), t, u.id]);
      }
      await client.query('INSERT INTO kv(k,v) VALUES($1,$2)', [kvKey, JSON.stringify(result)]);
      await client.query('COMMIT');
      res.json(result);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.status) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
      next(e);
    } finally { client.release(); }
  });

  /* إدارة الحسابات من كارت العميل (تغيير الباسورد والإيقاف بيستخدموا PATCH /api/users/:id) */
  app.get('/api/shop/accounts', auth(true), async (req, res, next) => {
    try {
      const { rows } = await pool.query('SELECT id,username,disabled FROM users WHERE portal_party=$1 ORDER BY created_at', [String(req.query.partyId || '')]);
      res.json(rows);
    } catch (e) { next(e); }
  });
  app.post('/api/shop/accounts', auth(true), async (req, res, next) => {
    try {
      const partyId = String(req.body.partyId || '');
      const username = String(req.body.username || '').trim().toLowerCase();
      const pw = String(req.body.password || '');
      const party = await partyOf(pool, partyId);
      if (!party || party.kind === 'vendor') return res.status(400).json({ error: 'العميل مش موجود' });
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: 'اسم الدخول: 3 حروف إنجليزي أو أرقام على الأقل، بدون مسافات' });
      if (pw.length < 6) return res.status(400).json({ error: 'كلمة المرور 6 حروف على الأقل' });
      const ex = await pool.query('SELECT 1 FROM users WHERE portal_party=$1 LIMIT 1', [partyId]);
      if (ex.rows.length) return res.status(400).json({ error: 'العميل ده ليه حساب بالفعل' });
      const id = 'u_' + crypto.randomBytes(16).toString('base64url').slice(0, 22);
      await pool.query('INSERT INTO users(id,username,name,pass,created_at,portal_party) VALUES($1,$2,$3,$4,$5,$6)', [id, username, party.name || username, hashPw(pw), now(), partyId]);
      res.json({ id, username });
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'اسم الدخول مستخدم بالفعل' });
      next(e);
    }
  });
};
