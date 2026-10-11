/* ميزان — المحاسبة: شجرة الحسابات، القيود الآلية من كل الحركات، القيود اليدوية،
   دفتر الأستاذ، ميزان المراجعة، قائمة الدخل، الميزانية العمومية، والفترات المحاسبية.
   القيود الآلية بتتولّد من الفواتير والسندات والشيكات والأرصدة الافتتاحية وقت العرض (مش متخزنة)،
   فبتفضل دايمًا مطابقة لأرصدة البرنامج. القيود اليدوية بس هي اللي بتتخزن (collection: journal). */
(function () {
  'use strict';
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const EPS = 0.005;

  /* ---------------- chart of accounts ---------------- */
  // type: asset | liability | equity | revenue | expense ; g = group (لا يقبل قيود)
  const DEF = [
    ['1', 'الأصول', 'asset', '', 1], ['11', 'الأصول المتداولة', 'asset', '1', 1],
    ['1101', 'النقدية والخزائن', 'asset', '11', 1], ['1102', 'العملاء', 'asset', '11'], ['1103', 'أوراق القبض (شيكات تحت التحصيل)', 'asset', '11'],
    ['1104', 'المخزون', 'asset', '11'], ['1105', 'سلف الموظفين', 'asset', '11'], ['1106', 'مدينون متنوعون', 'asset', '11'],
    ['12', 'الأصول الثابتة', 'asset', '1', 1], ['1201', 'الأثاث والتجهيزات', 'asset', '12'], ['1202', 'السيارات', 'asset', '12'], ['1203', 'الأجهزة والكمبيوتر', 'asset', '12'], ['1209', 'مجمع الإهلاك', 'asset', '12'],
    ['2', 'الخصوم', 'liability', '', 1], ['21', 'الخصوم المتداولة', 'liability', '2', 1],
    ['2101', 'الموردون', 'liability', '21'], ['2102', 'أوراق الدفع (شيكات صادرة)', 'liability', '21'], ['2103', 'ضريبة القيمة المضافة', 'liability', '21'],
    ['2104', 'مصروفات مستحقة', 'liability', '21'], ['2105', 'دائنون متنوعون', 'liability', '21'],
    ['22', 'الخصوم طويلة الأجل', 'liability', '2', 1], ['2201', 'قروض', 'liability', '22'],
    ['3', 'حقوق الملكية', 'equity', '', 1], ['3101', 'رأس المال', 'equity', '3'], ['3102', 'جاري الشركاء والمسحوبات', 'equity', '3'],
    ['3103', 'أرصدة افتتاحية', 'equity', '3'], ['3104', 'أرباح مرحّلة', 'equity', '3'],
    ['4', 'الإيرادات', 'revenue', '', 1], ['4101', 'المبيعات', 'revenue', '4'], ['4102', 'مردودات المبيعات', 'revenue', '4'], ['4103', 'الخصم المسموح به', 'revenue', '4'],
    ['4201', 'الخصم المكتسب', 'revenue', '4'], ['4202', 'فروق مرتجعات المشتريات', 'revenue', '4'], ['4301', 'إيرادات أخرى', 'revenue', '4'],
    ['5', 'التكاليف والمصروفات', 'expense', '', 1], ['5101', 'تكلفة البضاعة المباعة', 'expense', '5'], ['5102', 'عجز وزيادة المخزون', 'expense', '5'],
    ['5103', 'فروق تقييم المخزون', 'expense', '5'], ['5201', 'الرواتب والأجور', 'expense', '5'], ['5301', 'المصروفات العمومية والإدارية', 'expense', '5', 1],
    ['5399', 'مصروفات أخرى', 'expense', '5'], ['5401', 'الإهلاك', 'expense', '5'],
  ];
  const TYPE_T = { asset: 'أصول', liability: 'خصوم', equity: 'حقوق ملكية', revenue: 'إيرادات', expense: 'مصروفات' };
  const debitNature = t => t === 'asset' || t === 'expense';

  let GL = null;
  const glKey = () => calcKey() + '|' + (CV.journal || 0) + '|' + (CV.accounts || 0) + '|' + (CV.employees || 0);

  function chart(extraCats) {
    const A = new Map();
    for (const [id, name, type, parent, g] of DEF) A.set(id, { id, code: id, name, type, parent, g: !!g, sys: true });
    // safes
    const sf = safes(); const ids = new Set(sf.map(s => s.id));
    for (const k of extraCats.safes) ids.add(k);
    let i = 1; for (const sid of ids) { const id = 'safe:' + sid; A.set(id, { id, code: '1101' + String(i++).padStart(2, '0'), name: safeName(sid), type: 'asset', parent: '1101', sys: true, auto: 'safe' }); }
    i = 1; for (const cat of [...extraCats.exp].sort((a, b) => a.localeCompare(b))) { const id = 'cat:' + cat; A.set(id, { id, code: '5301' + String(i++).padStart(2, '0'), name: cat, type: 'expense', parent: '5301', sys: true, auto: 'cat' }); }
    // user accounts / renames
    for (const d of L('accounts')) {
      if (A.has(d.id)) { const a = A.get(d.id); if (d.name) a.name = d.name; continue; }
      const p = A.get(d.parent); if (!p) continue;
      A.set(d.id, { id: d.id, code: d.code || d.id, name: d.name || 'حساب', type: p.type, parent: d.parent, g: !!d.g, user: true });
    }
    for (const a of A.values()) { const p = a.parent && A.get(a.parent); if (p && !p.g && (p.user || p.id.length >= 4)) p.g = true; }
    return A;
  }

  /* ---------------- journal generation ---------------- */
  const CAT_IN = { 'إيداع / رأس مال': '3101', 'إيرادات أخرى': '4301', 'سلفة موظف': '1105', 'سداد سلفة': '1105', 'تسويات': '3103' };
  const CAT_OUT = { 'سلفة موظف': '1105', 'رواتب': '5201', 'مسحوبات': '3102', 'تسويات': '3103', 'أصول ثابتة': '1201', 'شراء أصول': '1201' };
  function build() {
    if (GL && GL.k === glKey()) return GL;
    const R = calc(); const DS = defSafe(); const E = []; const cats = { safes: new Set(), exp: new Set() };
    const safeAcc = s => { s = s || DS; cats.safes.add(s); return 'safe:' + s; };
    const pAcc = (pid, fallback) => { const p = pid && G('parties', pid); return p ? (p.kind === 'vendor' ? '2101' : '1102') : fallback; };
    const expAcc = c => { const k = (c || 'مصروفات').trim() || 'مصروفات'; cats.exp.add(k); return 'cat:' + k; };
    const push = (e, lines) => {
      const ls = lines.filter(x => x && Math.abs(x[1]) > 1e-9).map(([a, v, p]) => ({ a, v: +v, p: p || '' }));
      if (!ls.length) return; e.lines = ls; e.sum = ls.reduce((s, l) => s + l.v, 0); E.push(e);
    };
    // opening balances
    const oc = +(settings().openCash || 0);
    const op = [];
    if (oc) op.push([safeAcc(DS), oc], ['3103', -oc]);
    for (const p of L('parties')) { const o = +p.openBalance || 0; if (!o) continue; if (p.kind === 'vendor') op.push(['2101', -o, p.id], ['3103', o]); else op.push(['1102', o, p.id], ['3103', -o]); }
    if (op.length) push({ id: 'open', date: '', src: 'open', label: 'أرصدة أول المدة (خزينة وعملاء وموردين)' }, op);
    // invoices
    for (const inv of L('invoices')) {
      const T = TYPES[inv.type]; if (!T || T.doc) continue; const x = R.inv[inv.id]; if (!x) continue;
      const sub = x.sub, disc = +inv.discount || 0, tax = x.tax, total = x.total, paid = +inv.paid || 0, iv = x.ival || 0, cogs = x.cogs || 0;
      const pid = inv.partyId || ''; const base = { id: 'inv:' + inv.id, date: inv.date || '', src: 'inv', ref: inv.id, type: inv.type, no: inv.no, label: `${T.full} #${inv.no}${pid ? ' — ' + partyName(pid) : ''}` };
      const sa = safeAcc(inv.safe);
      switch (inv.type) {
        case 'sale': push(base, [['1102', total, pid], ['4101', -sub], ['4103', disc], ['2103', -tax], [sa, paid], ['1102', -paid, pid], ['5101', cogs], ['1104', iv], ['5103', -cogs - iv]]); break;
        case 'sret': push(base, [['1102', -total, pid], ['4102', sub], ['4103', -disc], ['2103', tax], [sa, -paid], ['1102', paid, pid], ['5101', cogs], ['1104', iv], ['5103', -cogs - iv]]); break;
        case 'purchase': push(base, [['1104', iv], ['2103', tax], ['4201', -disc], ['2101', -total, pid], ['5103', sub - iv], [sa, -paid], ['2101', paid, pid]]); break;
        case 'pret': push(base, [['2101', total, pid], ['2103', -tax], ['1104', iv], ['4202', -(total - tax + iv)], [sa, paid], ['2101', -paid, pid]]); break;
        case 'open': push(base, [['1104', iv], ['3103', -iv]]); break;
        case 'adj': case 'count': push(base, [['1104', iv], ['5102', -iv]]); break;
        case 'reval': case 'transfer': push(base, [['1104', iv], ['5103', -iv]]); break;
      }
    }
    // cash vouchers
    for (const c of L('cash')) {
      const a = +c.amount || 0; if (!a) continue; const base = { id: 'cash:' + c.id, date: c.date || '', src: 'cash', ref: c.id, no: c.no };
      if (c.kind === 'xfer') { push({ ...base, label: `تحويل من ${safeName(c.from)} إلى ${safeName(c.to)}` }, [[safeAcc(c.to), a], [safeAcc(c.from), -a]]); continue; }
      const pk = c.partyId && G('parties', c.partyId) ? G('parties', c.partyId).kind : '';
      const who = c.partyId ? partyName(c.partyId) : (c.empId ? empName(c.empId) : '');
      const label = `${c.nocash ? (c.category || 'إشعار') : (c.kind === 'in' ? 'سند قبض' : 'سند صرف')}${c.no ? ' #' + c.no : ''}${who ? ' — ' + who : ''}${c.note ? ' (' + c.note + ')' : ''}`;
      if (c.nocash) {
        if (!c.partyId) continue;
        const pa = pAcc(c.partyId, '1102'), other = pk === 'vendor' ? '4201' : '4103';
        if (c.kind === 'in') push({ ...base, label }, [[pa, -a, c.partyId], [other, a]]); else push({ ...base, label }, [[pa, a, c.partyId], [other, -a]]);
        continue;
      }
      const sa = safeAcc(c.safe);
      let ca;
      if (c.partyId) ca = pAcc(c.partyId, '1102');
      else if (c.kind === 'in') ca = CAT_IN[c.category] || (c.category === 'تحصيل من عميل' ? '1102' : c.category === 'سداد لمورد' ? '2101' : (c.empId && /سلف/.test(c.category || '') ? '1105' : '4301'));
      else ca = (c.sal ? '5201' : CAT_OUT[c.category]) || (c.category === 'سداد لمورد' ? '2101' : c.category === 'تحصيل من عميل' ? '1102' : expAcc(c.category === 'أخرى' ? 'مصروفات أخرى' : c.category));
      if (c.kind === 'in') push({ ...base, label }, [[sa, a], [ca, -a, c.partyId]]); else push({ ...base, label }, [[ca, a, c.partyId], [sa, -a]]);
    }
    // cheques
    for (const c of L('cheques')) {
      const a = +c.amount || 0; if (!a) continue; const st = c.status || 'pending'; const pd = c.partyId || '';
      const d0 = c.issueDate || c.dueDate || (c.createdAt || '').slice(0, 10); const lb = `شيك ${c.dir === 'in' ? 'وارد' : 'صادر'} رقم ${c.no || ''}${pd ? ' — ' + partyName(pd) : ''}`;
      const base = { src: 'chq', ref: c.id, no: c.no };
      if (c.dir === 'in') {
        if (st !== 'bounced') push({ ...base, id: 'chq:' + c.id, date: d0, label: lb }, [['1103', a], [pAcc(pd, '1102'), -a, pd]]);
        if (st === 'collected') push({ ...base, id: 'chq2:' + c.id, date: c.clearedAt || c.dueDate || d0, label: 'تحصيل ' + lb }, [[safeAcc(c.safe), a], ['1103', -a]]);
        if (st === 'endorsed' && c.endorsedTo) push({ ...base, id: 'chq2:' + c.id, date: c.endorsedAt || d0, label: `تظهير ${lb} إلى ${partyName(c.endorsedTo)}` }, [[pAcc(c.endorsedTo, '2101'), a, c.endorsedTo], ['1103', -a]]);
      } else {
        if (st !== 'bounced') push({ ...base, id: 'chq:' + c.id, date: d0, label: lb }, [[pAcc(pd, '2101'), a, pd], ['2102', -a]]);
        if (st === 'paid') push({ ...base, id: 'chq2:' + c.id, date: c.clearedAt || c.dueDate || d0, label: 'صرف ' + lb }, [['2102', a], [safeAcc(c.safe), -a]]);
      }
    }
    // manual journal
    for (const j of L('journal')) {
      const ls = (j.lines || []).map(l => [l.a, (+l.dr || 0) - (+l.cr || 0), l.p]);
      push({ id: 'man:' + j.id, date: j.date || '', src: 'man', ref: j.id, no: j.no, label: `قيد يدوي #${j.no || ''}${j.note ? ' — ' + j.note : ''}` }, ls);
    }
    E.sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.src).localeCompare(String(b.src)));
    const A = chart(cats);
    for (const e of E) for (const l of e.lines) if (!A.has(l.a)) A.set(l.a, { id: l.a, code: l.a, name: 'حساب محذوف (' + l.a + ')', type: 'asset', parent: '11', orphan: true });
    const bad = E.filter(e => Math.abs(e.sum) > 0.01);
    GL = { k: glKey(), E, A, bad };
    return GL;
  }

  /* ---------------- balances ---------------- */
  const kids = A => { const m = new Map(); for (const a of A.values()) { if (!m.has(a.parent)) m.set(a.parent, []); m.get(a.parent).push(a); } for (const v of m.values()) v.sort((x, y) => String(x.code).localeCompare(String(y.code), undefined, { numeric: true })); return m; };
  function sums(from, to, filt) {
    const { E, A } = build(); const o = {}, d = {}, c = {};
    for (const e of E) {
      const dt = e.date || '';
      if (to && dt > to) continue;
      const before = from && dt < from;
      for (const l of e.lines) { if (filt && !filt(l, e)) continue;
        if (before) o[l.a] = (o[l.a] || 0) + l.v;
        else if (l.v > 0) d[l.a] = (d[l.a] || 0) + l.v; else c[l.a] = (c[l.a] || 0) - l.v;
      }
    }
    // roll up
    const K = kids(A); const roll = (m) => { const out = {}; const walk = a => { let s = m[a.id] || 0; for (const ch of (K.get(a.id) || [])) s += walk(ch); out[a.id] = s; return s; }; for (const a of K.get('') || []) walk(a); for (const a of A.values()) if (!(a.id in out)) out[a.id] = m[a.id] || 0; return out; };
    return { o: roll(o), d: roll(d), c: roll(c), K, A };
  }
  const fyStartMD = () => (settings().fyStart || '01-01');
  function fyStartOf(date) { const md = fyStartMD(); const y = +(date || today()).slice(0, 4); let s = y + '-' + md; if (s > (date || today())) s = (y - 1) + '-' + md; return s; }
  const fyEndOf = s => addDays((+s.slice(0, 4) + 1) + s.slice(4), -1);

  /* ---------------- UI ---------------- */
  const AF = { tab: 'tb', from: '', to: '', acc: '1102', party: '', src: '', q: '', depth: 4, asof: '' };
  const TABS = [['tb', 'ميزان المراجعة'], ['is', 'قائمة الدخل'], ['bs', 'الميزانية العمومية'], ['ledger', 'دفتر الأستاذ'], ['journal', 'دفتر اليومية'], ['chart', 'شجرة الحسابات'], ['periods', 'الفترات المحاسبية']];
  const SRC = { inv: 'فاتورة', cash: 'سند', chq: 'شيك', open: 'افتتاحي', man: 'يدوي' };
  const money = v => Math.abs(v) < EPS ? '—' : fmt(v);
  const dc = (v, deb) => { v = r2(v); return deb ? (v >= 0 ? [v, 0] : [0, -v]) : (v <= 0 ? [0, -v] : [v, 0]); };
  function defaults() { if (!AF.from) { AF.from = fyStartOf(today()); AF.to = today(); } if (!AF.asof) AF.asof = today(); }
  function rangeBar(extra) {
    return `<div class="card" style="padding:12px 14px;margin-bottom:14px"><div class="row">
      <input class="in" type="date" style="width:150px" data-af="from" value="${AF.from}"><span class="small muted">إلى</span><input class="in" type="date" style="width:150px" data-af="to" value="${AF.to}">
      <div class="seg">${[['m', 'الشهر'], ['pm', 'الشهر السابق'], ['q', 'الربع'], ['y', 'السنة المالية'], ['py', 'السنة السابقة'], ['a', 'الكل']].map(([k, t]) => `<button data-ar="${k}">${t}</button>`).join('')}</div>
      ${extra || ''}<span class="sp"></span><button class="btn" id="aX">${ic('dl')}Excel</button><button class="btn" id="aP">${ic('print')}طباعة</button></div></div>`;
  }
  function bindRange() {
    $$('[data-af]').forEach(i => i.onchange = () => { AF[i.dataset.af] = i.value; render(); });
    $$('[data-ar]').forEach(b => b.onclick = () => { const t = today(); const k = b.dataset.ar;
      if (k === 'm') { AF.from = t.slice(0, 8) + '01'; AF.to = t; }
      if (k === 'pm') { const d = new Date(t.slice(0, 8) + '01T12:00:00'); d.setMonth(d.getMonth() - 1); const s = d.toISOString().slice(0, 8) + '01'; AF.from = s; AF.to = addDays(t.slice(0, 8) + '01', -1); }
      if (k === 'q') { const m = +t.slice(5, 7); const qs = Math.floor((m - 1) / 3) * 3 + 1; AF.from = t.slice(0, 5) + String(qs).padStart(2, '0') + '-01'; AF.to = t; }
      if (k === 'y') { AF.from = fyStartOf(t); AF.to = t; }
      if (k === 'py') { const s = fyStartOf(addDays(fyStartOf(t), -1)); AF.from = s; AF.to = fyEndOf(s); }
      if (k === 'a') { AF.from = ''; AF.to = t; }
      render(); });
  }
  function printHTML(title, sub, html) {
    const s = settings(); const pr = $('#print'); pr.className = '';
    pr.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:12px"><div><h2 style="margin:0">${esc(s.company || 'ميزان')}</h2><div>${esc(s.address || '')} ${esc(s.phone || '')}</div></div><div style="text-align:left"><h3 style="margin:0">${esc(title)}</h3><div>${esc(sub)}</div></div></div>${html}<p style="margin-top:14px;font-size:11px">طُبع من ميزان — ${today()}</p>`;
    setTimeout(() => window.print(), 50);
  }
  const accName = (A, id) => { const a = A.get(id); return a ? a.name : id; };
  const accLabel = a => `${a.code} — ${a.name}`;

  window.vAccounts = function () {
    defaults();
    const tab = route().a[0] || AF.tab; AF.tab = tab;
    setTitle('المحاسبة والقوائم المالية');
    const { bad } = build();
    const head = `<div class="row" style="margin-bottom:14px"><div class="seg">${TABS.map(([k, t]) => `<button data-at="${k}" class="${k === tab ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      ${bad.length ? `<div class="card" style="border-color:var(--danger);margin-bottom:14px;color:var(--danger)">فيه ${bad.length} قيد مش متوازن — غالبًا بيانات قديمة ناقصة. أول واحد: ${esc(bad[0].label)}</div>` : ''}`;
    const V = { tb: vTB, is: vIS, bs: vBS, ledger: vLedger, journal: vJournal, chart: vChart, periods: vPeriods }[tab] || vTB;
    $('#view').innerHTML = `<div class="wrap">${head}<div id="acc"></div></div>`;
    $$('[data-at]').forEach(b => b.onclick = () => go('accounts/' + b.dataset.at));
    V($('#acc'));
  };

  /* ---- trial balance ---- */
  function vTB(el) {
    const { o, d, c, K, A } = sums(AF.from, AF.to);
    const depth = +AF.depth || 4; const rows = [];
    const lvl = a => { let n = 0, p = a.parent; while (p) { n++; p = (A.get(p) || {}).parent; } return n; };
    const walk = (a) => { const L_ = lvl(a); const deb = debitNature(a.type);
      const ob = o[a.id] || 0, dd = d[a.id] || 0, cc = c[a.id] || 0, cb = ob + dd - cc;
      if (Math.abs(ob) > EPS || dd > EPS || cc > EPS) rows.push({ a, L: L_, ob, dd, cc, cb, deb, grp: (K.get(a.id) || []).length > 0 });
      if (L_ + 1 < depth) for (const ch of (K.get(a.id) || [])) walk(ch); };
    for (const a of K.get('') || []) walk(a);
    let tO = 0, tD = 0, tC = 0, tB = 0; for (const a of K.get('') || []) { tO += o[a.id] || 0; tD += d[a.id] || 0; tC += c[a.id] || 0; }
    tB = tO + tD - tC;
    const sideCols = (v) => { const [x, y] = dc(v, true); return `<td class="n">${money(x)}</td><td class="n">${money(y)}</td>`; };
    el.innerHTML = rangeBar(`<label class="row small" style="gap:6px">المستوى<select class="in" style="width:110px" id="aD">${opts([[2, 'رئيسي'], [3, 'فرعي'], [4, 'تفصيلي'], [9, 'الكل']], String(depth))}</select></label>`) +
      `<div class="tw"><table class="t" id="tbT"><thead><tr><th rowspan="2">الحساب</th><th colspan="2" style="text-align:center">رصيد أول الفترة</th><th colspan="2" style="text-align:center">حركة الفترة</th><th colspan="2" style="text-align:center">رصيد آخر الفترة</th></tr>
      <tr><th class="n">مدين</th><th class="n">دائن</th><th class="n">مدين</th><th class="n">دائن</th><th class="n">مدين</th><th class="n">دائن</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="click" data-acc="${esc(r.a.id)}" style="${r.grp ? 'font-weight:600;background:var(--surface2)' : ''}"><td style="padding-inline-start:${12 + r.L * 18}px"><span class="muted num small">${esc(r.a.code)}</span> ${esc(r.a.name)}</td>${sideCols(r.ob)}<td class="n">${money(r.dd)}</td><td class="n">${money(r.cc)}</td>${sideCols(r.cb)}</tr>`).join('') || '<tr><td colspan="7" class="muted">مفيش حركات في الفترة دي</td></tr>'}
      </tbody><tfoot><tr><td>الإجمالي ${Math.abs(tB) < 0.05 && Math.abs(tO) < 0.05 ? '<span class="tag ok">متوازن ✓</span>' : '<span class="tag bad">غير متوازن</span>'}</td>${sideCols(tO)}<td class="n">${fmt(tD)}</td><td class="n">${fmt(tC)}</td>${sideCols(tB)}</tr></tfoot></table></div>
      <p class="small muted">الأرصدة محسوبة من كل الحركات: الفواتير والسندات والشيكات والأرصدة الافتتاحية والقيود اليدوية. اضغط على أي حساب تفتح دفتر الأستاذ بتاعه.</p>`;
    bindRange(); $('#aD').onchange = e => { AF.depth = e.target.value; render(); };
    $$('#tbT [data-acc]').forEach(tr => tr.onclick = () => { AF.acc = tr.dataset.acc; AF.party = ''; go('accounts/ledger'); });
    const rt = `من ${AF.from || 'البداية'} إلى ${AF.to}`;
    $('#aX').onclick = () => xlsxOut('ميزان_المراجعة_' + today() + '.xlsx', [['ميزان المراجعة — ' + rt], ['الكود', 'الحساب', 'رصيد أول مدين', 'رصيد أول دائن', 'حركة مدين', 'حركة دائن', 'رصيد آخر مدين', 'رصيد آخر دائن'],
      ...rows.map(r => { const [a, b] = dc(r.ob, true), [x, y] = dc(r.cb, true); return [r.a.code, '  '.repeat(r.L) + r.a.name, a, b, r2(r.dd), r2(r.cc), x, y]; })], 'ميزان المراجعة');
    $('#aP').onclick = () => printHTML('ميزان المراجعة', rt, $('#tbT').outerHTML);
  }

  /* ---- income statement ---- */
  function isData(from, to) {
    const { d, c, K, A } = sums(from, to); const bal = id => (d[id] || 0) - (c[id] || 0); // debit-positive movement
    const leafRows = (pid, sign) => { const out = []; const walk = a => { const ch = K.get(a.id) || []; if (!ch.length) { const v = sign * bal(a.id); if (Math.abs(v) > EPS) out.push([a, v]); } else ch.forEach(walk); }; (K.get(pid) || []).forEach(walk); return out; };
    const sales = -bal('4101'), ret = bal('4102'), allow = bal('4103'), net = sales - ret - allow;
    const cogs = bal('5101'), gross = net - cogs;
    const otherRev = leafRows('4', -1).filter(([a]) => !['4101', '4102', '4103'].includes(a.id));
    const exps = leafRows('5', 1).filter(([a]) => a.id !== '5101');
    const tOR = otherRev.reduce((s, x) => s + x[1], 0), tEx = exps.reduce((s, x) => s + x[1], 0);
    return { sales, ret, allow, net, cogs, gross, otherRev, exps, tOR, tEx, profit: gross + tOR - tEx };
  }
  function vIS(el) {
    const x = isData(AF.from, AF.to);
    const row = (t, v, b, ind, acc) => `<tr ${acc ? `class="click" data-acc="${esc(acc)}"` : ''} style="${b ? 'font-weight:700;background:var(--surface2)' : ''}"><td style="padding-inline-start:${ind ? 34 : 12}px">${t}</td><td class="n ${v < -EPS ? 'neg' : ''}">${money(v)}</td></tr>`;
    const html = `<table class="t" id="isT"><thead><tr><th>البند</th><th class="n">القيمة</th></tr></thead><tbody>
      ${row('المبيعات', x.sales, 0, 0, '4101')}${row('(−) مردودات المبيعات', -x.ret, 0, 1, '4102')}${row('(−) الخصم المسموح به', -x.allow, 0, 1, '4103')}
      ${row('صافي المبيعات', x.net, 1)}${row('(−) تكلفة البضاعة المباعة', -x.cogs, 0, 1, '5101')}${row('مجمل الربح', x.gross, 1)}
      ${x.otherRev.map(([a, v]) => row('(+) ' + esc(a.name), v, 0, 1, a.id)).join('')}
      ${x.exps.map(([a, v]) => row('(−) ' + esc(a.name), -v, 0, 1, a.id)).join('')}
      ${row('صافي الربح', x.profit, 1)}${x.net ? row('هامش صافي الربح', 0, 0, 1).replace('>—<', `>${fmt(x.profit / x.net * 100)}%<`) : ''}</tbody></table>`;
    el.innerHTML = rangeBar() + `<div class="strip" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px"><div><div class="k">صافي المبيعات</div><div class="v">${fmt(x.net)}</div></div><div><div class="k">مجمل الربح</div><div class="v">${fmt(x.gross)}</div><div class="s">${x.net ? fmt(x.gross / x.net * 100) + '%' : ''}</div></div><div><div class="k">صافي الربح</div><div class="v ${x.profit < 0 ? 'neg' : ''}">${fmt(x.profit)}</div></div></div><div class="tw" style="max-width:760px">${html}</div>`;
    bindRange(); $$('#isT [data-acc]').forEach(tr => tr.onclick = () => { AF.acc = tr.dataset.acc; go('accounts/ledger'); });
    const rt = `من ${AF.from || 'البداية'} إلى ${AF.to}`;
    $('#aX').onclick = () => xlsxOut('قائمة_الدخل_' + today() + '.xlsx', [['قائمة الدخل — ' + rt], ['البند', 'القيمة'], ...[...$('#isT').querySelectorAll('tbody tr')].map(tr => [tr.cells[0].textContent.trim(), tr.cells[1].textContent.trim()])], 'قائمة الدخل');
    $('#aP').onclick = () => printHTML('قائمة الدخل', rt, $('#isT').outerHTML);
  }

  /* ---- balance sheet ---- */
  function vBS(el) {
    const asof = AF.asof || today(); const fy = fyStartOf(asof);
    const { o, d, c, K, A } = sums('', asof); const bal = id => (o[id] || 0) + (d[id] || 0) - (c[id] || 0);
    const cur = isData(fy, asof).profit; const prior = -(bal('4') + bal('5')) - cur; // كل الإيرادات والمصروفات قبل بداية السنة المالية
    const sec = (rootId, sign) => { const out = []; const walk = (a, L_) => { const v = sign * bal(a.id); const ch = K.get(a.id) || [];
      if (Math.abs(v) > EPS || ch.some(x => Math.abs(bal(x.id)) > EPS)) { out.push({ a, v, L: L_, grp: ch.length > 0 }); if (L_ < 3) ch.forEach(x => walk(x, L_ + 1)); } };
      (K.get(rootId) || []).forEach(x => walk(x, 0)); return out; };
    const assets = sec('1', 1), liab = sec('2', -1), eq = sec('3', -1);
    const tA = bal('1'), tL = -bal('2'), tE = -bal('3') + prior + cur;
    const r = (x) => `<tr class="click" data-acc="${esc(x.a.id)}" style="${x.grp ? 'font-weight:600' : ''}"><td style="padding-inline-start:${12 + x.L * 18}px">${esc(x.a.name)}</td><td class="n ${x.v < -EPS ? 'neg' : ''}">${money(x.v)}</td></tr>`;
    const tot = (t, v) => `<tr style="font-weight:700;background:var(--surface2)"><td>${t}</td><td class="n">${fmt(v)}</td></tr>`;
    const ok = Math.abs(tA - tL - tE) < 0.05;
    const html = `<div class="grid g2" id="bsT" style="align-items:start">
      <div class="tw"><table class="t"><thead><tr><th>الأصول</th><th class="n">القيمة</th></tr></thead><tbody>${assets.map(r).join('')}${tot('إجمالي الأصول', tA)}</tbody></table></div>
      <div class="tw"><table class="t"><thead><tr><th>الخصوم وحقوق الملكية</th><th class="n">القيمة</th></tr></thead><tbody>
        ${liab.map(r).join('')}${tot('إجمالي الخصوم', tL)}
        ${eq.map(r).join('')}<tr><td style="padding-inline-start:12px">أرباح مرحّلة من السنين اللي فاتت</td><td class="n ${prior < 0 ? 'neg' : ''}">${money(prior)}</td></tr>
        <tr><td style="padding-inline-start:12px">صافي ربح السنة الحالية (من ${fy})</td><td class="n ${cur < 0 ? 'neg' : ''}">${money(cur)}</td></tr>
        ${tot('إجمالي حقوق الملكية', tE)}${tot('إجمالي الخصوم وحقوق الملكية', tL + tE)}</tbody></table></div></div>`;
    el.innerHTML = `<div class="card" style="padding:12px 14px;margin-bottom:14px"><div class="row"><label class="row small" style="gap:6px">الميزانية في تاريخ<input class="in" type="date" style="width:160px" id="aAs" value="${asof}"></label>
      <span class="tag ${ok ? 'ok' : 'bad'}">${ok ? 'الأصول = الخصوم + حقوق الملكية ✓' : 'غير متوازنة — فرق ' + fmt(tA - tL - tE)}</span><span class="sp"></span><button class="btn" id="aX">${ic('dl')}Excel</button><button class="btn" id="aP">${ic('print')}طباعة</button></div></div>${html}
      <p class="small muted">الإيرادات والمصروفات بتتقفل تلقائيًا في حقوق الملكية: اللي قبل بداية السنة المالية بيظهر «أرباح مرحّلة»، واللي من أولها لحد التاريخ ده بيظهر «صافي ربح السنة». تقدر تغيّر بداية السنة المالية من «الفترات المحاسبية».</p>`;
    $('#aAs').onchange = e => { AF.asof = e.target.value || today(); render(); };
    $$('#bsT [data-acc]').forEach(tr => tr.onclick = () => { AF.acc = tr.dataset.acc; AF.to = asof; go('accounts/ledger'); });
    const aoa = [['الميزانية العمومية في ' + asof], ['البند', 'القيمة']]; $$('#bsT tr').forEach(tr => { if (tr.cells.length === 2) aoa.push([tr.cells[0].textContent.trim(), tr.cells[1].textContent.trim()]); });
    $('#aX').onclick = () => xlsxOut('الميزانية_' + asof + '.xlsx', aoa, 'الميزانية');
    $('#aP').onclick = () => printHTML('الميزانية العمومية', 'في ' + asof, $('#bsT').outerHTML.replace('class="grid g2"', 'style="display:grid;grid-template-columns:1fr 1fr;gap:12px"'));
  }

  /* ---- ledger ---- */
  function vLedger(el) {
    const { E, A } = build(); const K = kids(A);
    const leafUnder = id => { const out = new Set([id]); const w = x => (K.get(x) || []).forEach(ch => { out.add(ch.id); w(ch.id); }); w(id); return out; };
    if (!A.has(AF.acc)) AF.acc = '1102';
    const acc = A.get(AF.acc); const set = leafUnder(AF.acc); const deb = debitNature(acc.type);
    const isP = ['1102', '2101'].includes(AF.acc);
    let open = 0; const rows = []; let tD = 0, tC = 0;
    for (const e of E) { const dt = e.date || '';
      if (AF.to && dt > AF.to) continue;
      let v = 0; for (const l of e.lines) if (set.has(l.a) && (!AF.party || l.p === AF.party)) v += l.v;
      if (Math.abs(v) < 0.0001) continue;
      if (AF.from && dt < AF.from) { open += v; continue; }
      rows.push({ e, v }); if (v > 0) tD += v; else tC -= v; }
    let run = open; const sg = deb ? 1 : -1;
    const opts_ = [...A.values()].sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true })).map(a => [a.id, accLabel(a)]);
    const parties = isP ? L('parties').filter(p => (AF.acc === '1102' ? p.kind !== 'vendor' : p.kind === 'vendor')).sort((a, b) => a.name.localeCompare(b.name)) : [];
    const shown = rows.slice(-2000);
    if (rows.length > shown.length) for (const r of rows.slice(0, rows.length - shown.length)) run += r.v;
    el.innerHTML = rangeBar(`<select class="in" style="width:260px" id="aA">${opts(opts_, AF.acc)}</select>${isP ? `<select class="in" style="width:200px" id="aPa">${opts(parties.map(p => [p.id, p.name]), AF.party, 'كل ' + (AF.acc === '1102' ? 'العملاء' : 'الموردين'))}</select>` : ''}`) +
      `<div class="strip" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px"><div><div class="k">${esc(acc.name)} — رصيد أول الفترة</div><div class="v">${fmt(sg * open)}</div></div><div><div class="k">مدين</div><div class="v">${fmt(tD)}</div></div><div><div class="k">دائن</div><div class="v">${fmt(tC)}</div></div><div><div class="k">رصيد آخر الفترة</div><div class="v">${fmt(sg * (open + tD - tC))}</div><div class="s">${deb ? 'طبيعته مدين' : 'طبيعته دائن'}</div></div></div>
      <div class="tw"><table class="t" id="lgT"><thead><tr><th>التاريخ</th><th>النوع</th><th>البيان</th><th class="n">مدين</th><th class="n">دائن</th><th class="n">الرصيد</th></tr></thead><tbody>
      <tr><td></td><td></td><td class="muted">رصيد أول الفترة</td><td></td><td></td><td class="n">${fmt(sg * open)}</td></tr>
      ${shown.map(({ e, v }) => { run += v; return `<tr class="click" data-src="${e.src}" data-ref="${esc(e.ref || '')}"><td class="num">${e.date || 'افتتاحي'}</td><td><span class="tag">${SRC[e.src]}</span></td><td>${esc(e.label)}</td><td class="n">${v > 0 ? fmt(v) : ''}</td><td class="n">${v < 0 ? fmt(-v) : ''}</td><td class="n">${fmt(sg * run)}</td></tr>`; }).join('')}
      </tbody></table></div>${rows.length > shown.length ? `<p class="small muted">معروض آخر ${shown.length} حركة من ${rows.length} — ضيّق الفترة أو صدّر Excel.</p>` : ''}`;
    bindRange();
    $('#aA').onchange = e => { AF.acc = e.target.value; AF.party = ''; render(); };
    const ap = $('#aPa'); if (ap) ap.onchange = e => { AF.party = e.target.value; render(); };
    $$('#lgT [data-src]').forEach(tr => tr.onclick = () => openSrc(tr.dataset.src, tr.dataset.ref));
    const rt = `${accLabel(acc)}${AF.party ? ' — ' + partyName(AF.party) : ''} — من ${AF.from || 'البداية'} إلى ${AF.to}`;
    $('#aX').onclick = () => { let rr = open; xlsxOut('دفتر_الأستاذ_' + today() + '.xlsx', [['دفتر الأستاذ — ' + rt], ['التاريخ', 'النوع', 'البيان', 'مدين', 'دائن', 'الرصيد'], ['', '', 'رصيد أول الفترة', '', '', r2(sg * open)], ...rows.map(({ e, v }) => { rr += v; return [e.date, SRC[e.src], e.label, v > 0 ? r2(v) : '', v < 0 ? r2(-v) : '', r2(sg * rr)]; })], 'الأستاذ'); };
    $('#aP').onclick = () => printHTML('دفتر الأستاذ', rt, $('#lgT').outerHTML);
  }
  function openSrc(src, ref) {
    if (src === 'inv' && ref) go('inv/' + ref);
    else if (src === 'cash') go('cash');
    else if (src === 'chq') go('cheques');
    else if (src === 'man' && ref) jeModal(G('journal', ref) ? { id: ref, ...G('journal', ref) } : null);
  }

  /* ---- journal ---- */
  function vJournal(el) {
    const { E, A } = build();
    const q = norm(AF.q || '');
    let xs = E.filter(e => (!AF.from || (e.date || '') >= AF.from) && (!AF.to || (e.date || '') <= AF.to) && (!AF.src || e.src === AF.src) && (!q || norm(e.label).includes(q) || String(e.no || '') === AF.q));
    xs = xs.slice().reverse(); const tot = xs.length; xs = xs.slice(0, 300);
    el.innerHTML = rangeBar(`<select class="in" style="width:150px" id="aS">${opts(Object.entries(SRC), AF.src, 'كل القيود')}</select><input class="in" style="width:180px" id="aQ" placeholder="بحث في البيان أو الرقم" value="${esc(AF.q || '')}">${can('accounting') && !S.ro ? `<button class="btn p" id="aN">${ic('plus')}قيد يدوي</button>` : ''}`) +
      `<div id="jl">${xs.map(e => `<div class="card" style="margin-bottom:10px;padding:12px 14px"><div class="row" style="margin-bottom:6px"><b class="num">${e.date || 'افتتاحي'}</b><span class="tag">${SRC[e.src]}</span><span>${esc(e.label)}</span><span class="sp"></span>${Math.abs(e.sum) > 0.01 ? '<span class="tag bad">غير متوازن</span>' : ''}<button class="btn s" data-src="${e.src}" data-ref="${esc(e.ref || '')}">${e.src === 'man' ? 'تعديل' : 'فتح المستند'}</button></div>
        <table class="t" style="font-size:13.5px"><tbody>${e.lines.filter(l => Math.abs(l.v) >= 0.005).map(l => `<tr><td style="${l.v < 0 ? 'padding-inline-start:40px' : ''}">${l.v < 0 ? 'إلى ' : 'من '}${esc(accName(A, l.a))}${l.p ? ` <span class="muted small">(${esc(partyName(l.p))})</span>` : ''}</td><td class="n" style="width:130px">${l.v > 0 ? fmt(l.v) : ''}</td><td class="n" style="width:130px">${l.v < 0 ? fmt(-l.v) : ''}</td></tr>`).join('')}</tbody></table></div>`).join('') || '<div class="empty card"><b>مفيش قيود في الفترة دي</b></div>'}</div>
      ${tot > xs.length ? `<p class="small muted">معروض أحدث ${xs.length} قيد من ${tot}.</p>` : ''}`;
    bindRange();
    $('#aS').onchange = e => { AF.src = e.target.value; render(); };
    $('#aQ').onchange = e => { AF.q = e.target.value.trim(); render(); };
    const n = $('#aN'); if (n) n.onclick = () => jeModal(null);
    $$('#jl [data-src]').forEach(b => b.onclick = () => openSrc(b.dataset.src, b.dataset.ref));
    $('#aX').onclick = () => { const all = E.filter(e => (!AF.from || (e.date || '') >= AF.from) && (!AF.to || (e.date || '') <= AF.to) && (!AF.src || e.src === AF.src)); const out = [['دفتر اليومية — من ' + (AF.from || 'البداية') + ' إلى ' + AF.to], ['التاريخ', 'النوع', 'البيان', 'الحساب', 'الطرف', 'مدين', 'دائن']];
      for (const e of all) for (const l of e.lines) out.push([e.date, SRC[e.src], e.label, accName(A, l.a), l.p ? partyName(l.p) : '', l.v > 0 ? r2(l.v) : '', l.v < 0 ? r2(-l.v) : '']); xlsxOut('دفتر_اليومية_' + today() + '.xlsx', out, 'اليومية'); };
    $('#aP').onclick = () => printHTML('دفتر اليومية', `من ${AF.from || 'البداية'} إلى ${AF.to}`, $('#jl').innerHTML.replace(/<button[^>]*>.*?<\/button>/g, ''));
  }
  function jeModal(j) {
    if (!can('accounting') || S.ro) { toast('ليس لديك صلاحية القيود', 'err'); return; }
    const { A } = build(); const K = kids(A);
    const leaves = [...A.values()].filter(a => !(K.get(a.id) || []).length && !a.g && !a.orphan).sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
    const e = j ? clone(j) : { date: today(), note: '', lines: [{ a: '', dr: '', cr: '' }, { a: '', dr: '', cr: '' }] };
    const parties = L('parties').sort((a, b) => a.name.localeCompare(b.name));
    const draw = () => {
      let td = 0, tc = 0; e.lines.forEach(l => { td += +l.dr || 0; tc += +l.cr || 0; });
      modal(`<h2>${j ? 'تعديل قيد يدوي #' + (e.no || '') : 'قيد يومية يدوي'}</h2>
        <div class="grid g2"><label class="f">التاريخ<input class="in" type="date" id="je_d" value="${e.date}"></label><label class="f">البيان<input class="in" id="je_n" value="${esc(e.note || '')}" placeholder="مثال: إثبات شراء أثاث للمحل"></label></div>
        <div class="tw" style="margin-top:12px"><table class="t"><thead><tr><th>الحساب</th><th>الطرف (اختياري)</th><th class="n">مدين</th><th class="n">دائن</th><th></th></tr></thead><tbody>
        ${e.lines.map((l, i) => `<tr><td><select class="in" data-jl="${i}" data-k="a" style="min-width:220px">${opts(leaves.map(a => [a.id, accLabel(a)]), l.a, '— اختر الحساب —')}</select></td>
          <td>${['1102', '2101'].includes(l.a) ? `<select class="in" data-jl="${i}" data-k="p">${opts(parties.filter(p => l.a === '1102' ? p.kind !== 'vendor' : p.kind === 'vendor').map(p => [p.id, p.name]), l.p || '', '—')}</select>` : ''}</td>
          <td><input class="in n" style="width:120px" inputmode="decimal" data-jl="${i}" data-k="dr" value="${l.dr || ''}"></td><td><input class="in n" style="width:120px" inputmode="decimal" data-jl="${i}" data-k="cr" value="${l.cr || ''}"></td>
          <td>${e.lines.length > 2 ? `<button class="btn ic s" data-jx="${i}" aria-label="حذف السطر">${ic('x')}</button>` : ''}</td></tr>`).join('')}
        </tbody><tfoot><tr><td><button class="btn s" id="je_add">${ic('plus')}سطر</button></td><td></td><td class="n">${fmt(td)}</td><td class="n">${fmt(tc)}</td><td></td></tr></tfoot></table></div>
        <p class="small ${Math.abs(td - tc) < 0.005 && td > 0 ? 'pos' : 'neg'}" style="margin-bottom:0">${Math.abs(td - tc) < 0.005 && td > 0 ? 'القيد متوازن ✓' : 'الفرق: ' + fmt(td - tc) + ' — المدين لازم يساوي الدائن'}</p>
        <div class="row" style="margin-top:14px"><button class="btn p" id="je_s">حفظ القيد</button><button class="btn" data-close>إلغاء</button><span class="sp"></span>${j ? '<button class="btn d" id="je_del">حذف القيد</button>' : ''}</div>`);
      $$('[data-jl]').forEach(x => x.onchange = () => { const i = +x.dataset.jl, k = x.dataset.k; e.lines[i][k] = k === 'dr' || k === 'cr' ? (x.value === '' ? '' : numIn(x.value)) : x.value; if (k === 'dr' && +x.value) e.lines[i].cr = ''; if (k === 'cr' && +x.value) e.lines[i].dr = ''; if (k === 'a') e.lines[i].p = ''; e.date = $('#je_d').value; e.note = $('#je_n').value; draw(); });
      $$('[data-jx]').forEach(b => b.onclick = () => { e.lines.splice(+b.dataset.jx, 1); e.date = $('#je_d').value; e.note = $('#je_n').value; draw(); });
      $('#je_add').onclick = () => { e.lines.push({ a: '', dr: '', cr: '' }); e.date = $('#je_d').value; e.note = $('#je_n').value; draw(); };
      $('#je_s').onclick = async () => {
        e.date = $('#je_d').value || today(); e.note = $('#je_n').value.trim();
        const ls = e.lines.filter(l => l.a && ((+l.dr || 0) > 0 || (+l.cr || 0) > 0)).map(l => ({ a: l.a, dr: r2(l.dr), cr: r2(l.cr), ...(l.p ? { p: l.p } : {}) }));
        if (ls.length < 2) { toast('القيد محتاج سطرين على الأقل بحساب ومبلغ', 'err'); return; }
        if (ls.some(l => l.dr < 0 || l.cr < 0)) { toast('مفيش مبالغ بالسالب', 'err'); return; }
        const d_ = ls.reduce((s, l) => s + l.dr, 0), c_ = ls.reduce((s, l) => s + l.cr, 0);
        if (Math.abs(d_ - c_) > 0.005) { toast('القيد مش متوازن — المدين ' + fmt(d_) + ' والدائن ' + fmt(c_), 'err'); return; }
        if (isLocked(e.date) || (j && isLocked(j.date))) { toast(`الفترة مقفولة حتى ${settings().lockDate}`, 'err'); return; }
        const id = j ? j.id : uid(); const no = j ? j.no : (Math.max(0, ...L('journal').map(x => +x.no || 0)) + 1);
        const doc = { date: e.date, no, note: e.note, lines: ls, createdAt: (j && j.createdAt) || new Date().toISOString(), createdBy: (j && j.createdBy) || S.me.id || '', ...(j ? { updatedAt: new Date().toISOString() } : {}) };
        await put('journal', id, doc); await audit('journal', id, j ? 'تعديل قيد' : 'قيد جديد', j ? fmt(j.lines.reduce((s, l) => s + (+l.dr || 0), 0)) : '', fmt(d_), 'قيد يدوي #' + no);
        closeModal(); toast('تم حفظ القيد #' + no);
      };
      const dl = $('#je_del'); if (dl) dl.onclick = async () => { if (isLocked(j.date)) { toast('الفترة مقفولة', 'err'); return; } if (!(await confirmBox('حذف القيد #' + j.no + ' نهائيًا؟', 'حذف', true))) return; await del('journal', j.id); await audit('journal', j.id, 'حذف قيد', '', '', 'قيد يدوي #' + j.no); toast('تم حذف القيد'); };
    };
    draw();
  }

  /* ---- chart of accounts ---- */
  function vChart(el) {
    const { A } = build(); const K = kids(A); const { o, d, c } = sums('', today());
    const bal = id => (o[id] || 0) + (d[id] || 0) - (c[id] || 0);
    const rows = []; const walk = (a, L_) => { rows.push({ a, L: L_, grp: (K.get(a.id) || []).length > 0 || a.g }); (K.get(a.id) || []).forEach(ch => walk(ch, L_ + 1)); };
    (K.get('') || []).forEach(a => walk(a, 0));
    const ed = can('accounting') && !S.ro;
    el.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="muted" style="margin:0;flex:1">الحسابات الأساسية ثابتة عشان القيود الآلية بتتسجّل عليها — تقدر تغيّر أسماءها وتضيف تحتها حسابات فرعية (أصول ثابتة، بنوك، قروض، مصروفات…). الخزائن وبنود المصروفات بتتضاف تلقائيًا.</p>
      <button class="btn" id="aX">${ic('dl')}Excel</button></div>
      <div class="tw"><table class="t" id="chT"><thead><tr><th>الكود</th><th>الحساب</th><th>النوع</th><th class="n">الرصيد الحالي</th><th></th></tr></thead><tbody>
      ${rows.map(r => { const v = bal(r.a.id) * (debitNature(r.a.type) ? 1 : -1);
        return `<tr style="${r.grp ? 'font-weight:600;background:var(--surface2)' : ''}"><td class="num muted">${esc(r.a.code)}</td><td style="padding-inline-start:${12 + r.L * 20}px">${esc(r.a.name)}${r.a.auto ? ' <span class="tag">تلقائي</span>' : ''}${r.a.user ? ' <span class="tag sale">مضاف</span>' : ''}</td><td class="small muted">${TYPE_T[r.a.type]}</td>
          <td class="n ${v < -EPS ? 'neg' : ''}">${money(v)}</td><td style="white-space:nowrap">${ed ? `${r.a.auto ? '' : `<button class="btn s" data-ren="${esc(r.a.id)}">تسمية</button>`} ${(r.grp || r.a.user || SUBOK.includes(r.a.id)) && !r.a.auto && r.a.id !== '1101' && r.a.id !== '5301' ? `<button class="btn s" data-sub="${esc(r.a.id)}">${ic('plus')}فرعي</button>` : ''} ${r.a.user ? `<button class="btn s d" data-rm="${esc(r.a.id)}">حذف</button>` : ''}` : ''}<button class="btn s" data-lg="${esc(r.a.id)}">الأستاذ</button></td></tr>`; }).join('')}
      </tbody></table></div>`;
    $$('[data-lg]').forEach(b => b.onclick = () => { AF.acc = b.dataset.lg; AF.party = ''; go('accounts/ledger'); });
    $$('[data-ren]').forEach(b => b.onclick = () => { const a = A.get(b.dataset.ren); accModal({ mode: 'ren', a }); });
    $$('[data-sub]').forEach(b => b.onclick = () => { const p = A.get(b.dataset.sub); accModal({ mode: 'sub', p, K }); });
    $$('[data-rm]').forEach(b => b.onclick = async () => { const id = b.dataset.rm; const { E } = build(); if (E.some(e => e.lines.some(l => l.a === id))) { toast('الحساب عليه قيود — مينفعش يتحذف', 'err'); return; } if ((K.get(id) || []).length) { toast('الحساب تحته حسابات فرعية', 'err'); return; } if (!(await confirmBox('حذف الحساب ' + A.get(id).name + '؟', 'حذف', true))) return; await del('accounts', id); toast('تم حذف الحساب'); });
    $('#aX').onclick = () => xlsxOut('شجرة_الحسابات.xlsx', [['الكود', 'الحساب', 'النوع', 'الرصيد'], ...rows.map(r => [r.a.code, '  '.repeat(r.L) + r.a.name, TYPE_T[r.a.type], r2(bal(r.a.id) * (debitNature(r.a.type) ? 1 : -1))])], 'شجرة الحسابات');
  }
  const SUBOK = ['1106', '1201', '1202', '1203', '2104', '2105', '2201', '3101', '3102', '4301', '5399', '5401'];
  function accModal({ mode, a, p, K }) {
    if (mode === 'ren') {
      modal(`<h2>تسمية الحساب ${esc(a.code)}</h2><label class="f">الاسم<input class="in" id="ac_n" value="${esc(a.name)}"></label><div class="row" style="margin-top:14px"><button class="btn p" id="ac_s">حفظ</button><button class="btn" data-close>إلغاء</button></div>`);
      $('#ac_s').onclick = async () => { const n = $('#ac_n').value.trim(); if (!n) return; const cur = G('accounts', a.id) || {}; await put('accounts', a.id, { ...cur, name: n, ...(a.user ? {} : { rename: true }) }); closeModal(); toast('تم تغيير الاسم'); };
      return;
    }
    const sib = (K.get(p.id) || []).map(x => String(x.code)); let n = 1, code; do { code = p.code + String(n++).padStart(p.code.length >= 4 ? 2 : 2, '0'); } while (sib.includes(code));
    modal(`<h2>حساب فرعي تحت: ${esc(p.name)}</h2><div class="grid g2"><label class="f">الكود<input class="in n" id="ac_c" value="${code}"></label><label class="f">اسم الحساب<input class="in" id="ac_n" placeholder="مثال: بنك مصر"></label></div>
      <p class="small muted">النوع: ${TYPE_T[p.type]} — الحساب الرئيسي هيتحوّل لحساب تجميعي، والقيود تتسجّل على الفرعي.</p><div class="row" style="margin-top:14px"><button class="btn p" id="ac_s">إضافة</button><button class="btn" data-close>إلغاء</button></div>`);
    $('#ac_s').onclick = async () => { const nm = $('#ac_n').value.trim(), cd = $('#ac_c').value.trim(); if (!nm || !cd) { toast('اكتب الكود والاسم', 'err'); return; }
      const { A, E } = build(); if ([...A.values()].some(x => String(x.code) === cd)) { toast('الكود ده مستخدم', 'err'); return; }
      if (E.some(e => e.lines.some(l => l.a === p.id)) && !p.g && !(K.get(p.id) || []).length) { toast('الحساب الرئيسي عليه قيود مباشرة — أضف الحساب الفرعي تحت حساب تاني أو استخدمه كما هو', 'err'); return; }
      await put('accounts', 'u' + uid().slice(-10), { code: cd, name: nm, parent: p.id }); closeModal(); toast('تمت إضافة الحساب'); };
  }

  /* ---- periods ---- */
  function vPeriods(el) {
    const s = settings(); const t = today(); const fy = fyStartOf(t); const pfy = fyStartOf(addDays(fy, -1)); const pEnd = addDays(fy, -1);
    const adm = S.isAdmin && !S.ro;
    const cur = isData(fy, t), prev = isData(pfy, pEnd);
    const MONTHS_ = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
    el.innerHTML = `<div class="grid g2" style="align-items:start">
      <div class="card"><h3>غلق وفتح الفترات</h3>
        <p class="small muted" style="margin-top:0">بعد ما تخلّص الجرد أو تقفل الشهر، اقفل الفترة: محدش غير المالك يقدر يضيف أو يعدّل أو يحذف فواتير أو سندات أو قيود بتاريخ قبل أو يساوي تاريخ الغلق.</p>
        <div style="font-size:15px;margin-bottom:12px">${s.lockDate ? `<span class="tag purchase">مقفول حتى ${s.lockDate}</span>` : '<span class="tag ok">كل الفترات مفتوحة</span>'}</div>
        ${adm ? `<div class="row"><input class="in" type="date" id="pl_d" style="width:170px" value="${s.lockDate || addDays(t.slice(0, 8) + '01', -1)}"><button class="btn p" id="pl_s">${s.lockDate ? 'تحديث الغلق' : 'غلق الفترة'}</button>${s.lockDate ? '<button class="btn" id="pl_x">فتح كل الفترات</button>' : ''}</div>
          <div class="row" style="margin-top:10px"><button class="btn s" id="pl_m">اقفل لحد آخر الشهر اللي فات (${addDays(t.slice(0, 8) + '01', -1)})</button><button class="btn s" id="pl_y">اقفل السنة المالية اللي فاتت (${pEnd})</button></div>` : '<p class="small muted">الغلق والفتح للمدير بس.</p>'}
      </div>
      <div class="card"><h3>السنة المالية</h3>
        <p class="small muted" style="margin-top:0">إقفال الإيرادات والمصروفات بيتم تلقائيًا: أول ما السنة تخلص، صافي ربحها بيترحّل لـ«أرباح مرحّلة» في الميزانية.</p>
        <label class="f">بداية السنة المالية<div class="row">${adm ? `<select class="in" id="fy_m" style="width:110px">${opts(MONTHS_.map((m, i) => [m, MONTHS[i] || m]), fyStartMD().slice(0, 2))}</select><span class="small muted">يوم 1</span><button class="btn s" id="fy_s">حفظ</button>` : `<b>${fyStartMD()}</b>`}</div></label>
        <div class="tw" style="margin-top:12px"><table class="t"><thead><tr><th>السنة</th><th class="n">صافي المبيعات</th><th class="n">صافي الربح</th></tr></thead><tbody>
          <tr><td>الحالية: ${fy} ← ${t}</td><td class="n">${fmt(cur.net)}</td><td class="n ${cur.profit < 0 ? 'neg' : ''}">${fmt(cur.profit)}</td></tr>
          <tr><td>اللي فاتت: ${pfy} ← ${pEnd}</td><td class="n">${fmt(prev.net)}</td><td class="n ${prev.profit < 0 ? 'neg' : ''}">${fmt(prev.profit)}</td></tr></tbody></table></div>
      </div></div>`;
    if (!adm) return;
    const lock = async d => { if (!d) { toast('اختار تاريخ الغلق', 'err'); return; } await put('settings', 'main', { ...settings(), lockDate: d }); await audit('settings', 'main', 'غلق الفترة', s.lockDate || '', d, 'المحاسبة'); toast('تم غلق الفترة حتى ' + d); };
    $('#pl_s').onclick = () => lock($('#pl_d').value);
    $('#pl_m').onclick = () => lock(addDays(t.slice(0, 8) + '01', -1));
    $('#pl_y').onclick = () => lock(pEnd);
    const x = $('#pl_x'); if (x) x.onclick = async () => { if (!(await confirmBox('فتح كل الفترات المقفولة؟', 'فتح'))) return; const n = { ...settings() }; delete n.lockDate; await put('settings', 'main', n); await audit('settings', 'main', 'غلق الفترة', s.lockDate, 'مفتوح', 'المحاسبة'); toast('تم فتح الفترات'); };
    $('#fy_s').onclick = async () => { await put('settings', 'main', { ...settings(), fyStart: $('#fy_m').value + '-01' }); AF.from = ''; toast('تم حفظ بداية السنة المالية'); };
  }

  // تقرير قائمة الدخل في مركز التقارير يعتمد على نفس القيود، عشان الرقم يبقى واحد في كل مكان
  try {
    const rep = REPS.find(r => r.id === 'pnl');
    if (rep) {
      rep.d = 'من المبيعات لصافي الربح — محسوبة من القيود المحاسبية (نفس أرقام قائمة الدخل في المحاسبة)';
      rep.run = function () {
        const x = isData(RF.from, RF.to);
        const L_ = (label, v, b, ind) => ({ label: (ind ? '\u00a0\u00a0\u00a0\u00a0' : '') + label, v, b });
        const rows = [L_('المبيعات', x.sales), L_('(−) مرتجعات المبيعات', -x.ret, 0, 1), L_('(−) الخصم المسموح به', -x.allow, 0, 1), L_('صافي المبيعات', x.net, 1), L_('(−) تكلفة البضاعة المباعة', -x.cogs, 0, 1), L_('مجمل الربح', x.gross, 1),
          ...x.otherRev.map(([a, v]) => L_('(+) ' + a.name, v, 0, 1)), ...x.exps.map(([a, v]) => L_('(−) ' + a.name, -v, 0, 1)), L_('صافي الربح', x.profit, 1), L_('هامش صافي الربح %', x.net ? x.profit / x.net * 100 : 0, 0, 1)];
        return { cols: [['label', 'البند', 't'], ['v', 'القيمة', 'm', 0, 1]], rows: rows.map(r => ({ ...r, label: r.b ? `<b>${esc(r.label)}</b>` : esc(r.label) })), html: ['label'], nosort: true,
          kpi: [['صافي المبيعات', fmt(x.net)], ['مجمل الربح', fmt(x.gross)], ['صافي الربح', fmt(x.profit)]], note: 'التفاصيل والقيود من شاشة المحاسبة والقوائم المالية.' };
      };
    }
  } catch (e) {}
  window.MZ_GL = { build, sums, isData, fyStartOf };
})();
