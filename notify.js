'use strict';
/* تنبيهات استلام النقدية في الخزينة الرئيسية.
   أي استلام فلوس في خزينة متراقبة (سند تحصيل، فاتورة بيع مدفوعة، تحويل داخل للخزينة، أو حركة جاية من أورجا)
   بيعمل تنبيه للناس المحددين (افتراضيًا: المالك + المديرين + أحمد عبد الرازق).
   التنبيه بيتخزن في collection «notifs» وبيوصل بس للي هو موجّه ليهم. */
const crypto = require('crypto');
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const norm = s => String(s || '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[\sـ]+/g, '').toLowerCase();
const MATCH_NAMES = ['احمدعبدالرازق'];
const DAY = 864e5;

async function cfg(db) {
  const [st, sf, us, rl] = await Promise.all([
    db.query(`SELECT data FROM docs WHERE col='settings' AND id='main' AND NOT deleted`),
    db.query(`SELECT id, data FROM docs WHERE col='safes' AND NOT deleted`),
    db.query(`SELECT id, name, username, owner, disabled FROM users`),
    db.query(`SELECT id, data FROM docs WHERE col='roles' AND NOT deleted`),
  ]);
  const s = (st.rows[0] && st.rows[0].data) || {};
  const ca = isObj(s.cashAlert) ? s.cashAlert : {};
  const safes = new Map(sf.rows.map(r => [r.id, (r.data && r.data.name) || r.id]));
  if (!safes.has('main') && !sf.rows.length) safes.set('main', 'الخزينة الرئيسية');
  const roles = new Map(rl.rows.map(r => [r.id, (r.data && r.data.role) || '']));
  const users = us.rows.filter(u => !u.disabled);
  const watch = Array.isArray(ca.safes) && ca.safes.length ? new Set(ca.safes)
    : new Set([...safes].filter(([id, n]) => id === 'main' || /رئيسي/.test(n)).map(([id]) => id));
  const to = Array.isArray(ca.users) && ca.users.length ? ca.users.filter(id => users.some(u => u.id === id))
    : users.filter(u => u.owner || ['full', 'manager'].includes(roles.get(u.id)) || MATCH_NAMES.some(m => norm(u.name).includes(m) || norm(u.username).includes(m))).map(u => u.id);
  return { off: ca.off === true, watch, to, safes, users, defSafe: s.defaultSafe || 'main' };
}

/* بيدوّر في التغيير على استلامات نقدية جديدة. base/next = items قبل وبعد. */
function detect(col, base, next, src) {
  const ev = [];
  for (const [id, v] of Object.entries(next || {})) {
    if (!isObj(v) || isObj(base && base[id])) continue; // جديد بس
    if (col === 'x_cash') {
      const amt = +v.amount || 0; if (!(amt > 0) || v.nocash) continue;
      if (v.kind === 'in') ev.push({ id, kind: 'in', safe: v.safe, amount: amt, v });
      else if (v.kind === 'xfer' && v.to) ev.push({ id, kind: 'xfer', safe: v.to, from: v.from, amount: amt, v });
    } else if (col === 'x_invoices') {
      if (v.type !== 'sale') continue;
      const amt = +v.paid || 0; if (!(amt > 0)) continue;
      ev.push({ id, kind: 'sale', safe: v.safe || '', amount: amt, v });
    }
  }
  return ev.map(e => ({ ...e, src }));
}

async function partyNames(db, ids) {
  const m = new Map(); ids = [...new Set(ids.filter(Boolean))]; if (!ids.length) return m;
  const { rows } = await db.query(`SELECT e.k, e.v->>'name' n FROM docs d CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(d.data->'items')='object' THEN d.data->'items' ELSE '{}'::jsonb END) e(k,v)
    WHERE d.col='x_parties' AND NOT d.deleted AND e.k = ANY($1)`, [ids]);
  for (const r of rows) m.set(r.k, r.n); return m;
}

/* بيكتب التنبيهات (جوه نفس الـ transaction). actor = {id,name} أو null لأورجا */
async function emit(db, events, actor) {
  if (!events.length) return 0;
  const c = await cfg(db);
  if (c.off || !c.to.length) return 0;
  const evs = events.map(e => ({ ...e, safe: e.safe || c.defSafe })).filter(e => c.watch.has(e.safe));
  if (!evs.length) return 0;
  const pn = await partyNames(db, evs.map(e => e.v.partyId));
  const now = Date.now(); let n = 0;
  for (const e of evs) {
    // حركات أورجا القديمة (أول مزامنة) مش بتعمل تنبيه — بس اللي تاريخها آخر يومين
    if (e.src === 'orga' && e.v.date && Date.parse(e.v.date) < now - 2 * DAY) continue;
    const to = c.to.filter(id => !actor || id !== actor.id);
    if (!to.length) continue;
    const by = actor ? actor.name : (e.v.orgaUser ? e.v.orgaUser + ' (أورجا)' : 'أورجا');
    const d = {
      kind: 'cash', at: now, to, seen: {}, src: e.src, by, byId: actor ? actor.id : '',
      amount: e.amount, safe: e.safe, safeName: c.safes.get(e.safe) || e.safe,
      what: e.kind === 'sale' ? 'فاتورة بيع مدفوعة' : e.kind === 'xfer' ? 'تحويل للخزينة من ' + (c.safes.get(e.from) || e.from || '') : (e.v.category || 'تحصيل'),
      party: e.v.partyId ? (pn.get(e.v.partyId) || '') : '', partyId: e.v.partyId || '',
      no: e.v.no || e.v.invNo || '', note: String(e.v.note || e.v.notes || '').slice(0, 300), date: e.v.date || '',
      ref: { c: e.kind === 'sale' ? 'invoices' : 'cash', id: e.id },
    };
    await db.query(`INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by) VALUES('notifs',$1,$2,false,nextval('doc_seq'),$3,$4)`,
      ['n' + now.toString(36) + crypto.randomBytes(4).toString('hex'), JSON.stringify(d), now, actor ? actor.id : 'orga-sync']);
    n++;
  }
  return n;
}

function mount(app, { pool, auth }) {
  // «شفته»: كل واحد يعلّم على تنبيهاته هو بس
  app.post('/api/notifs/seen', auth(false), async (req, res, next) => {
    try {
      const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).filter(x => typeof x === 'string' && /^n[a-z0-9]{6,40}$/.test(x)).slice(0, 200);
      if (!ids.length) return res.status(400).json({ error: 'bad id' });
      const { rows } = await pool.query(`UPDATE docs SET data=jsonb_set(data,'{seen}', COALESCE(data->'seen','{}'::jsonb) || jsonb_build_object($2::text, $3::bigint)), seq=nextval('doc_seq'), updated_at=$3
        WHERE col='notifs' AND id = ANY($1) AND NOT deleted AND data->'to' ? $2 RETURNING id`, [ids, req.user.id, Date.now()]);
      res.json({ ok: true, n: rows.length });
    } catch (e) { next(e); }
  });
  // تجربة التنبيه من الإعدادات
  app.post('/api/notifs/test', auth(true), async (req, res, next) => {
    try {
      const c = await cfg(pool);
      if (!c.to.length) return res.status(400).json({ error: 'مفيش حد متحدد يستلم التنبيه' });
      const now = Date.now();
      await pool.query(`INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by) VALUES('notifs',$1,$2,false,nextval('doc_seq'),$3,$4)`,
        ['n' + now.toString(36) + crypto.randomBytes(4).toString('hex'), JSON.stringify({ kind: 'cash', test: true, at: now, to: c.to, seen: {}, src: 'mizan', by: req.user.name, byId: req.user.id, amount: 1000, safe: [...c.watch][0] || 'main', safeName: c.safes.get([...c.watch][0]) || 'الخزينة الرئيسية', what: 'تجربة تنبيه', party: '', no: '', note: 'ده تنبيه تجربة من الإعدادات', date: new Date().toISOString().slice(0, 10) }), now, req.user.id]);
      res.json({ ok: true, to: c.to.length });
    } catch (e) { next(e); }
  });
  // آخر التنبيهات (للمراجعة: اتعمل تنبيه ولا لأ، ومين شافه)
  app.get('/api/notifs/recent', auth(true), async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT id, data FROM docs WHERE col='notifs' AND NOT deleted ORDER BY seq DESC LIMIT 15`);
      const { rows: us } = await pool.query(`SELECT id, name FROM users`); const nm = new Map(us.map(u => [u.id, u.name]));
      res.json(rows.map(r => ({ id: r.id, at: r.data.at, amount: r.data.amount, by: r.data.by, safeName: r.data.safeName, what: r.data.what, test: !!r.data.test, to: (r.data.to || []).map(id => ({ name: nm.get(id) || id, seen: !!(r.data.seen && r.data.seen[id]) })) })));
    } catch (e) { next(e); }
  });
  app.get('/api/notifs/config', auth(true), async (req, res, next) => {
    try { const c = await cfg(pool); res.json({ off: c.off, watch: [...c.watch], to: c.to, safes: [...c.safes].map(([id, name]) => ({ id, name })), users: c.users.map(u => ({ id: u.id, name: u.name, owner: u.owner })) }); } catch (e) { next(e); }
  });
}

module.exports = { detect, emit, mount };
