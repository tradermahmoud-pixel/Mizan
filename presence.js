'use strict';
/* مين شغال دلوقتي: كل جهاز مفتوح عليه ميزان بيبعت نبضة كل ~20 ثانية فيها الشاشة اللي هو عليها،
   والسيرفر بيسجّل آخر العمليات اللي كل مستخدم عملها (حفظ فاتورة، سند، طباعة...). المالك بس اللي يشوف. */
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const TY = { sale: 'فاتورة بيع', sret: 'مرتجع مبيعات', purchase: 'فاتورة شراء', pret: 'مرتجع مشتريات', adj: 'تسوية جردية', reval: 'تقييم مخزون', count: 'جرد', transfer: 'تحويل مخازن', open: 'رصيد أول', porder: 'أمر توريد', quote: 'عرض سعر' };
const COL = { x_products: 'صنف', x_parties: 'عميل/مورد', x_cheques: 'شيك', x_attendance: 'حضور', x_leads: 'عميل CRM', x_pkgs: 'شنطة/كرتونة', x_rets: 'إذن مرتجع', runs: 'خط سير', employees: 'موظف', settings: 'الإعدادات', safes: 'خزينة', journal: 'قيد يومية', stores: 'مخزن', roles: 'صلاحيات', roledefs: 'أدوار' };
const SKIP = new Set(['x_audit', 'members', 'notifs']);

const sess = new Map();   // sid -> {uid, name, route, title, detail, idle, mobile, at, since, ip}
const acts = new Map();   // uid -> [{at, t}]
const names = new Map();
const ONLINE_MS = 75e3;

function addAct(uid, t) {
  const a = acts.get(uid) || []; const now = Date.now();
  if (a[0] && a[0].t === t && now - a[0].at < 30e3) { a[0].at = now; a[0].n = (a[0].n || 1) + 1; }
  else a.unshift({ at: now, t });
  acts.set(uid, a.slice(0, 15));
}

/* بيوصف التغيير اللي اتكتب في /api/write بكلام مفهوم */
function describe(col, base, patch) {
  const out = [];
  if (SKIP.has(col)) return out;
  if (col === 'x_invoices' && isObj(patch.items)) {
    for (const [id, v] of Object.entries(patch.items)) {
      const o = base && isObj(base[id]) ? base[id] : null;
      if (v === null) { if (o) out.push(`حذف ${TY[o.type] || 'فاتورة'} #${o.no || ''}`); continue; }
      if (!isObj(v)) continue;
      const nm = TY[v.type] || 'فاتورة'; const n = Array.isArray(v.lines) ? v.lines.length : 0;
      out.push(o ? `تعديل ${nm} #${v.no || ''}` : `${nm} جديدة #${v.no || ''} (${n} صنف)`);
    }
    return out;
  }
  if (col === 'x_cash' && isObj(patch.items)) {
    for (const [id, v] of Object.entries(patch.items)) {
      const o = base && isObj(base[id]) ? base[id] : null;
      if (v === null) { if (o) out.push('حذف حركة خزينة'); continue; }
      if (!isObj(v)) continue;
      const k = v.kind === 'in' ? 'تحصيل' : v.kind === 'out' ? 'صرف' : 'تحويل خزينة';
      out.push(`${o ? 'تعديل ' : ''}${k} ${(+v.amount || 0).toLocaleString('en-US')} ج${v.category ? ' — ' + v.category : ''}`);
    }
    return out;
  }
  if (col === 'x_prints' && isObj(patch.items)) {
    const ids = Object.keys(patch.items).filter(id => isObj(patch.items[id]));
    const pr = ids.filter(id => (+patch.items[id].n || 0) > ((base && isObj(base[id]) && +base[id].n) || 0)).length;
    const prep = ids.filter(id => patch.items[id].prepAt && !(base && isObj(base[id]) && base[id].prepAt)).length;
    if (pr) out.push(pr > 1 ? `طباعة ${pr} فواتير` : 'طباعة فاتورة');
    if (prep) out.push(prep > 1 ? `تحضير ${prep} فواتير` : 'تحضير فاتورة');
    return out;
  }
  if (col === 'x_picks' && isObj(patch.items)) {
    for (const v of Object.values(patch.items)) if (isObj(v)) out.push(v.status === 'ok' ? 'خلّص مراجعة تحضير' : v.status === 'open' ? 'بيراجع تحضير فاتورة' : 'مراجعة تحضير');
    return out.slice(0, 1);
  }
  if (COL[col]) {
    const items = isObj(patch.items) ? Object.entries(patch.items) : null;
    if (items) { const n = items.filter(([, v]) => v !== null).length, d = items.length - n; if (n) out.push(`حفظ ${COL[col]}${n > 1 ? ' (' + n + ')' : ''}`); if (d) out.push(`حذف ${COL[col]}`); }
    else out.push(`حفظ ${COL[col]}`);
  }
  return out;
}
function record(user, list) { if (list.length) names.set(user.id, user.name); for (const t of list.slice(0, 5)) addAct(user.id, t); }

function mount(app, { auth }) {
  app.post('/api/presence', auth(false), (req, res) => {
    const b = req.body || {}; const sid = String(b.sid || '').slice(0, 40);
    if (!/^[a-z0-9]{6,40}$/i.test(sid)) return res.status(400).json({ error: 'bad sid' });
    if (b.bye) { sess.delete(sid); return res.json({ ok: true }); }
    const cur = sess.get(sid);
    const s = { uid: req.user.id, name: req.user.name, owner: !!req.user.owner,
      route: String(b.route || '').slice(0, 60), title: String(b.title || '').slice(0, 80), detail: String(b.detail || '').slice(0, 160),
      idle: !!b.idle, mobile: !!b.mobile, at: Date.now(), since: cur && cur.uid === req.user.id ? cur.since : Date.now(), ip: req.ip || '' };
    if (cur && cur.route !== s.route) s.routeAt = Date.now(); else s.routeAt = (cur && cur.routeAt) || Date.now();
    sess.set(sid, s);
    res.json({ ok: true });
  });
  app.get('/api/presence', auth(false), (req, res) => {
    if (!req.user.owner) return res.status(403).json({ error: 'للمالك بس' });
    const now = Date.now(); const by = new Map();
    for (const [sid, s] of sess) {
      if (now - s.at > 10 * 60e3) { sess.delete(sid); continue; }
      if (now - s.at > ONLINE_MS) continue;
      const u = by.get(s.uid) || { id: s.uid, name: s.name, owner: s.owner, devices: [] };
      u.devices.push({ route: s.route, title: s.title, detail: s.detail, idle: s.idle, mobile: s.mobile, since: s.since, routeAt: s.routeAt, seen: s.at, me: s.uid === req.user.id && sid === String(req.query.sid || '') });
      by.set(s.uid, u);
    }
    const users = [...by.values()].map(u => ({ ...u, idle: u.devices.every(d => d.idle), acts: (acts.get(u.id) || []).slice(0, 8) }));
    users.sort((a, b) => (a.idle - b.idle) || a.name.localeCompare(b.name, 'ar'));
    // اللي مش فاتح دلوقتي بس عمل حاجة النهارده
    const recent = [...acts.entries()].filter(([uid, a]) => !by.has(uid) && a[0] && now - a[0].at < 12 * 3600e3).map(([uid, a]) => ({ id: uid, name: names.get(uid) || '', last: a[0] }));
    res.json({ now, users, recent });
  });
}

module.exports = { mount, describe, record };
