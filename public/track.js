/* ميزان — متابعة حركة صنف (كارت الصنف الكامل).
   كل حركة على الصنف بالترتيب برصيد جاري (لكل المخازن أو لمخزن واحد)، مع فلاتر للفترة ونوع الحركة والطرف،
   وملخص ذكي: رصيد أول/آخر المدة، الوارد والمنصرف، المبيعات والربح، آخر شراء وآخر بيع، معدل البيع اليومي ويكفي لكام يوم،
   ورسم شهري للوارد والمنصرف، وأكتر العملاء/الموردين للصنف، وتصدير Excel وطباعة. */
(function () {
  'use strict';
  const TK = { pid: '', range: 'all', from: '', to: '', store: '', kind: 'all', party: '', hi: 0 };
  window.MZ_TK = TK;
  const sc = () => can('seeCost');
  const RECENT_K = 'mz_trk_recent';
  const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_K) || '[]').filter(id => G('products', id)); } catch (e) { return []; } };
  const pushRecent = id => { try { const r = [id, ...recent().filter(x => x !== id)].slice(0, 8); localStorage.setItem(RECENT_K, JSON.stringify(r)); } catch (e) {} };
  const KINDS = [['all', 'الكل'], ['in', 'وارد'], ['out', 'منصرف'], ['sale', 'بيع'], ['purchase', 'شراء'], ['ret', 'مرتجعات'], ['transfer', 'تحويل'], ['count', 'جرد وتسوية']];
  function range() {
    const t = today();
    switch (TK.range) {
      case 'month': return { from: t.slice(0, 8) + '01', to: t };
      case '3m': return { from: addDays(t, -89), to: t };
      case 'year': return { from: t.slice(0, 5) + '01-01', to: t };
      case 'custom': return { from: TK.from || '', to: TK.to || '' };
      default: return { from: '', to: '' };
    }
  }
  // حركة الصنف لكل مخزن: قيمة موجبة = داخل، سالبة = خارج
  function deltas(m) {
    const inv = m.inv, q = +m.q || 0, s = inv.storeId || MAIN, ts = inv.toStoreId || MAIN, o = {};
    switch (inv.type) {
      case 'purchase': case 'open': case 'sret': o[s] = q; break;
      case 'sale': case 'pret': o[s] = -q; break;
      case 'transfer': o[s] = -q; o[ts] = (o[ts] || 0) + q; break;
      case 'count': case 'adj': o[s] = +m.d || 0; break;
    }
    return o;
  }
  function moves(pid) {
    const R = calc(); const mv = (R.pmove[pid] || []).filter(m => m.inv.type !== 'reval');
    return mv.map(m => { const dl = deltas(m); const net = TK.store ? (dl[TK.store] || 0) : Object.values(dl).reduce((a, b) => a + b, 0); const x = R.line[m.inv.id + ':' + m.i] || {}; return { ...m, dl, net, cost: x.cost, profit: x.profit, lnet: x.net }; })
      .filter(m => !TK.store || m.dl[TK.store] !== undefined);
  }
  const kindOk = (m) => { const t = m.inv.type; switch (TK.kind) { case 'in': return m.net > 0; case 'out': return m.net < 0; case 'sale': return t === 'sale'; case 'purchase': return t === 'purchase' || t === 'open'; case 'ret': return t === 'sret' || t === 'pret'; case 'transfer': return t === 'transfer'; case 'count': return t === 'count' || t === 'adj'; default: return true; } };
  const partyOk = m => { if (!TK.party) return true; const q = norm(TK.party); const n = m.inv.type === 'transfer' ? storeName(m.inv.storeId) + ' ' + storeName(m.inv.toStoreId) : partyName(m.inv.partyId) || ''; return norm(n).includes(q); };
  function compute(pid) {
    const all = moves(pid); const { from, to } = range();
    let open = 0, bal = 0; const rows = [];
    const S = { inQ: 0, outQ: 0, saleQ: 0, saleV: 0, profit: 0, buyQ: 0, buyV: 0, sretQ: 0, pretQ: 0 }; const cust = {}, vend = {}; const months = {};
    for (const m of all) {
      const d = m.inv.date || '';
      if (from && d < from) { open += m.net; bal += m.net; continue; }
      if (to && d > to) continue;
      bal += m.net; m.run = bal;
      if (m.net > 0) S.inQ += m.net; else S.outQ += -m.net;
      const t = m.inv.type; const ym = d.slice(0, 7); const mo = months[ym] || (months[ym] = { i: 0, o: 0 }); if (m.net > 0) mo.i += m.net; else mo.o += -m.net;
      if (t === 'sale') { S.saleQ += m.q; S.saleV += m.lnet || 0; S.profit += m.profit || 0; const k = m.inv.partyId || '_'; const c = cust[k] || (cust[k] = { q: 0, v: 0, n: 0, last: '' }); c.q += m.q; c.v += m.lnet || 0; c.n++; if (d > c.last) c.last = d; }
      if (t === 'sret') { S.sretQ += m.q; S.saleQ -= m.q; S.saleV -= m.lnet || 0; S.profit += m.profit || 0; const k = m.inv.partyId || '_'; const c = cust[k] || (cust[k] = { q: 0, v: 0, n: 0, last: '' }); c.q -= m.q; c.v -= m.lnet || 0; }
      if (t === 'purchase' || t === 'open') { S.buyQ += m.q; S.buyV += m.q * (m.unit || 0); if (t === 'purchase') { const k = m.inv.partyId || '_'; const v = vend[k] || (vend[k] = { q: 0, v: 0, n: 0, last: '', price: 0 }); v.q += m.q; v.v += m.q * (m.unit || 0); v.n++; if (d >= v.last) { v.last = d; v.price = m.unit; } } }
      if (t === 'pret') S.pretQ += m.q;
      if (kindOk(m) && partyOk(m)) rows.push(m);
    }
    const lastBuy = [...all].reverse().find(m => m.inv.type === 'purchase'); const lastSale = [...all].reverse().find(m => m.inv.type === 'sale');
    // معدل البيع آخر 60 يوم
    const t0 = addDays(today(), -59); const sold60 = all.filter(m => m.inv.type === 'sale' && (m.inv.date || '') >= t0).reduce((s, m) => s + m.q, 0) - all.filter(m => m.inv.type === 'sret' && (m.inv.date || '') >= t0).reduce((s, m) => s + m.q, 0);
    return { all, rows, open, close: bal, S, cust, vend, months, lastBuy, lastSale, rate: Math.max(0, sold60) / 60 };
  }

  /* ---------- البحث ---------- */
  function pickerHTML() {
    const rc = recent();
    return `<div class="card" style="margin-bottom:14px"><div class="row" style="gap:8px"><div class="psearch" style="flex:1 1 320px;margin:0;position:relative">${ic('search')}<input class="in" id="tkQ" autocomplete="off" placeholder="اكتب اسم الصنف أو الكود أو امسح الباركود — ↓↑ ثم Enter"><div class="sugg" id="tkS" hidden></div></div></div>
      ${rc.length ? `<div class="row small" style="margin-top:8px;gap:6px"><span class="muted">آخر أصناف:</span>${rc.map(id => `<button type="button" class="pk-chip ${id === TK.pid ? 'on' : ''}" data-tkr="${esc(id)}" style="padding:4px 9px;font-size:12.5px">${esc(pname(id))}</button>`).join('')}</div>` : ''}</div>`;
  }
  function bindPicker() {
    const q = document.getElementById('tkQ'), sg = document.getElementById('tkS'); if (!q) return; let hits = [], hi = 0;
    const draw = () => { if (!hits.length) { sg.hidden = true; return; } sg.hidden = false; sg.innerHTML = hits.map((p, k) => `<button type="button" data-k="${k}" class="${k === hi ? 'on' : ''}"><b style="flex:1;text-align:right">${esc(p.name)}</b><span class="small muted">${esc(p.code || '')} · رصيد ${fq(qtyIn(p.id))}</span></button>`).join(''); sg.querySelectorAll('[data-k]').forEach(b => b.onmousedown = e => { e.preventDefault(); choose(hits[+b.dataset.k].id); }); const on = sg.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' }); };
    q.oninput = () => { const v = q.value.trim(); hits = v ? pFind(v, SMODE(), 30) : []; hi = 0; draw(); };
    q.onkeydown = e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(hi + 1, hits.length - 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(0, hi - 1); draw(); }
      else if (e.key === 'Escape') { sg.hidden = true; }
      else if (e.key === 'Enter') { e.preventDefault(); const v = q.value.trim(); const bc = L('products').find(p => bcMatch(p, v, true)); if (bc) return choose(bc.id); if (hits[hi]) choose(hits[hi].id); }
    };
    q.onblur = () => setTimeout(() => { sg.hidden = true; }, 150);
    $$('[data-tkr]').forEach(b => b.onclick = () => choose(b.dataset.tkr));
    if (!TK.pid) setTimeout(() => q.focus(), 40);
  }
  function choose(pid) { TK.pid = pid; pushRecent(pid); go('track/' + pid); }
  TK.open = pid => choose(pid);

  /* ---------- الشاشة ---------- */
  window.vTrack = function () {
    setTitle('متابعة حركة صنف');
    if (!(can('products') || can('sell') || can('buy') || can('reports'))) { denied('ليس لديك صلاحية'); return; }
    const a = route().a; if (a[0] && G('products', a[0])) { if (TK.pid !== a[0]) { TK.pid = a[0]; pushRecent(a[0]); } } else if (a[0]) TK.pid = '';
    if (!TK.pid) { $('#view').innerHTML = `<div class="wrap">${pickerHTML()}<div class="empty card"><b>اختار صنف علشان تشوف كل حركته</b><span class="small muted">بيع، شراء، مرتجعات، تحويلات، جرد — برصيد جاري بعد كل حركة</span></div></div>`; bindPicker(); return; }
    const pid = TK.pid, p = G('products', pid) || {}; const C = compute(pid); const st = calc().stock[pid] || { by: {} }; const { from, to } = range();
    const cover = C.rate > 0 ? Math.round(qtyIn(pid, TK.store || undefined) / C.rate) : null;
    const rows = C.rows.slice().reverse();
    const months = Object.entries(C.months).sort((x, y) => x[0].localeCompare(y[0])).slice(-12);
    const mx = Math.max(1, ...months.map(([, v]) => Math.max(v.i, v.o)));
    const topC = Object.entries(C.cust).filter(([, v]) => v.q > 0).sort((x, y) => y[1].q - x[1].q).slice(0, 8);
    const topV = Object.entries(C.vend).sort((x, y) => y[1].q - x[1].q).slice(0, 5);
    const minQ = p.minQty !== '' && p.minQty != null ? +p.minQty : null; const curQ = qtyIn(pid, TK.store || undefined);
    $('#view').innerHTML = `<div class="wrap">${pickerHTML()}
      <div class="card"><div class="row" style="align-items:flex-start"><div style="flex:1;min-width:240px"><h2 style="margin:0 0 4px">${esc(p.name || '')}</h2>
        <div class="small muted">${esc(p.code || '')}${p.barcode ? ' · ' + esc(p.barcode) : ''}${p.group ? ' · ' + esc(p.group) : ''}${p.unit ? ' · ' + esc(p.unit) : ''}</div>
        <div class="row small" style="margin-top:8px;gap:6px">${stores().map(s => `<span class="tag ${(st.by[s.id] || 0) < 0 ? 'bad' : ''}">${esc(s.name)}: <b class="num">${fq(st.by[s.id] || 0)}</b></span>`).join('')}${minQ != null ? `<span class="tag ${curQ <= minQ ? 'bad' : ''}">حد الطلب ${fq(minQ)}</span>` : ''}</div></div>
        <div class="row" style="gap:6px">${can('products') ? `<button class="btn s" id="tkEdit">تعديل الصنف</button>` : ''}<button class="btn s" id="tkXls">${ic('up')}Excel</button><button class="btn s" id="tkPrn">${ic('print')}طباعة</button></div></div></div>
      <div class="card" style="margin-top:12px;padding:12px 14px"><div class="row" style="gap:8px">
        <div class="seg">${[['all', 'كل الوقت'], ['month', 'الشهر ده'], ['3m', 'آخر 3 شهور'], ['year', 'السنة دي'], ['custom', 'فترة']].map(([k, t]) => `<button data-tkg="${k}" class="${TK.range === k ? 'on' : ''}">${t}</button>`).join('')}</div>
        ${TK.range === 'custom' ? `<input class="in" type="date" id="tkF" value="${esc(TK.from)}" style="width:150px"><span class="small">لـ</span><input class="in" type="date" id="tkT" value="${esc(TK.to)}" style="width:150px">` : ''}
        <select class="in" id="tkSt" style="width:170px">${opts(stores().map(s => [s.id, s.name]), TK.store, 'كل المخازن')}</select>
        <select class="in" id="tkK" style="width:150px">${opts(KINDS, TK.kind)}</select>
        <input class="in" id="tkP" style="width:170px" placeholder="عميل / مورد" value="${esc(TK.party)}"></div></div>
      <div class="strip" style="margin-top:12px;grid-template-columns:repeat(4,1fr)">
        <div><div class="k">رصيد أول المدة</div><div class="v">${fq(C.open)}</div><div class="s">${from ? 'قبل ' + esc(from) : 'من البداية'}</div></div>
        <div><div class="k">الوارد</div><div class="v pos">${fq(C.S.inQ)}</div><div class="s">شراء ${fq(C.S.buyQ)}${C.S.sretQ ? ' · مرتجع بيع ' + fq(C.S.sretQ) : ''}</div></div>
        <div><div class="k">المنصرف</div><div class="v neg">${fq(C.S.outQ)}</div><div class="s">بيع ${fq(C.S.saleQ + C.S.sretQ)}${C.S.pretQ ? ' · مرتجع شراء ' + fq(C.S.pretQ) : ''}</div></div>
        <div><div class="k">رصيد آخر المدة</div><div class="v">${fq(C.close)}</div><div class="s">${to ? 'لحد ' + esc(to) : 'دلوقتي'}</div></div></div>
      <div class="grid g2" style="margin-top:12px;align-items:start">
        <div class="card"><h3 style="margin-top:0">ملخص</h3><table class="t"><tbody>
          <tr><td>صافي المبيعات</td><td class="n"><b>${fq(C.S.saleQ)}</b> قطعة — ${fmt(C.S.saleV)}</td></tr>
          ${sc() ? `<tr><td>الربح</td><td class="n ${C.S.profit < 0 ? 'neg' : 'pos'}">${fmt(C.S.profit)}${C.S.saleV ? ` (${fmt(C.S.profit / C.S.saleV * 100)}%)` : ''}</td></tr><tr><td>متوسط التكلفة الحالي</td><td class="n">${fmt(avgCost(pid))}</td></tr>` : ''}
          <tr><td>سعر المستهلك</td><td class="n">${fmt(consOf(p))}</td></tr>
          <tr><td>آخر شراء</td><td class="n">${C.lastBuy ? `${esc(C.lastBuy.inv.date)} — ${esc(partyName(C.lastBuy.inv.partyId) || '')}${sc() ? ' — ' + fmt(C.lastBuy.unit) : ''}` : '—'}</td></tr>
          <tr><td>آخر بيع</td><td class="n">${C.lastSale ? `${esc(C.lastSale.inv.date)} — ${esc(partyName(C.lastSale.inv.partyId) || 'نقدي')} (منذ ${daysBetween(C.lastSale.inv.date, today())} يوم)` : '—'}</td></tr>
          <tr><td>معدل البيع (آخر 60 يوم)</td><td class="n">${C.rate ? fq(Math.round(C.rate * 10) / 10) + ' في اليوم' : 'مفيش بيع'}</td></tr>
          <tr><td>الرصيد يكفي</td><td class="n ${cover != null && cover < 14 ? 'neg' : ''}">${cover == null ? (curQ > 0 ? '<span class="dv-warn" style="color:var(--danger)">راكد — مفيش بيع آخر 60 يوم</span>' : '—') : cover + ' يوم تقريبًا'}</td></tr></tbody></table></div>
        <div class="card"><h3 style="margin-top:0">الوارد والمنصرف شهريًا</h3>${months.length ? `<div class="tk-ch">${months.map(([k, v]) => `<div class="tk-m" title="${k}: وارد ${fq(v.i)} — منصرف ${fq(v.o)}"><div class="tk-b"><i class="in" style="height:${v.i / mx * 100}%"></i><i class="out" style="height:${v.o / mx * 100}%"></i></div><small>${esc(k.slice(5))}/${esc(k.slice(2, 4))}</small></div>`).join('')}</div><div class="small muted"><span class="dot" style="background:var(--brand)"></span> وارد <span class="dot" style="background:var(--danger);margin-inline-start:10px"></span> منصرف</div>` : '<p class="muted small">مفيش حركة في الفترة</p>'}</div></div>
      ${topC.length || topV.length ? `<div class="grid g2" style="margin-top:12px;align-items:start">
        <div class="card"><h3 style="margin-top:0">أكتر العملاء سحبًا للصنف</h3>${topC.length ? `<table class="t"><thead><tr><th>العميل</th><th class="n">الكمية</th><th class="n">القيمة</th><th>آخر مرة</th></tr></thead><tbody>${topC.map(([k, v]) => `<tr><td>${esc(k === '_' ? 'نقدي' : partyName(k))}</td><td class="n">${fq(v.q)}</td><td class="n">${fmt(v.v)}</td><td class="small">${esc(v.last)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">مفيش</p>'}</div>
        <div class="card"><h3 style="margin-top:0">الموردين</h3>${topV.length ? `<table class="t"><thead><tr><th>المورد</th><th class="n">الكمية</th>${sc() ? '<th class="n">آخر سعر</th>' : ''}<th>آخر مرة</th></tr></thead><tbody>${topV.map(([k, v]) => `<tr><td>${esc(k === '_' ? '—' : partyName(k))}</td><td class="n">${fq(v.q)}</td>${sc() ? `<td class="n">${fmt(v.price)}</td>` : ''}<td class="small">${esc(v.last)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">مفيش</p>'}</div></div>` : ''}
      <div class="card" style="margin-top:12px"><div class="row"><h3 style="margin:0">الحركات</h3><span class="tag">${rows.length} حركة</span><span class="sp"></span><span class="small muted">الأحدث فوق — دوس على أي حركة تفتح الفاتورة · ↓↑ و Enter</span></div>
        <div class="tw" style="margin-top:10px;max-height:65vh;overflow:auto" id="tkW"><table class="t" id="tkT"><thead><tr><th>التاريخ</th><th>الحركة</th><th>رقم</th><th>الطرف / المخزن</th><th class="n">وارد</th><th class="n">منصرف</th><th class="n">السعر</th>${sc() ? '<th class="n">التكلفة</th><th class="n">الربح</th>' : ''}<th class="n">الرصيد بعد</th><th>بواسطة</th></tr></thead><tbody>
        ${rows.slice(0, 1500).map((m, k) => { const inv = m.inv; const tr = inv.type === 'transfer'; const isS = inv.type === 'sale' || inv.type === 'sret';
          return `<tr class="click" data-tki="${esc(inv.id)}" data-k="${k}"><td class="num small">${esc(inv.date)}</td><td><span class="tag ${inv.type}">${esc(TYPES[inv.type].t)}</span></td><td class="num">${esc(inv.no)}</td><td>${esc(tr ? storeName(inv.storeId) + ' ← ' + storeName(inv.toStoreId) : partyName(inv.partyId) || (TYPES[inv.type].party ? 'نقدي' : '—'))}</td>
            <td class="n pos">${m.net > 0 ? fq(m.net) : tr && !TK.store ? fq(m.q) : ''}</td><td class="n neg">${m.net < 0 ? fq(-m.net) : tr && !TK.store ? fq(m.q) : ''}</td><td class="n">${inv.type === 'count' ? '' : fmt(m.unit)}</td>
            ${sc() ? `<td class="n muted">${m.cost != null ? fmt(m.cost) : ''}</td><td class="n ${m.profit < 0 ? 'neg' : ''}">${isS && m.profit != null ? fmt(m.profit) : ''}</td>` : ''}<td class="n"><b>${fq(m.run)}</b></td><td class="small muted">${esc(whoName(inv.createdBy) || inv.orgaUser || '')}</td></tr>`; }).join('') || `<tr><td colspan="11"><div class="empty"><b>مفيش حركات بالفلاتر دي</b></div></td></tr>`}</tbody></table></div>
        ${rows.length > 1500 ? '<p class="small muted">بيظهر أحدث 1500 حركة — صدّر Excel للكل.</p>' : ''}</div></div>`;
    bindPicker();
    $$('[data-tkg]').forEach(b => b.onclick = () => { TK.range = b.dataset.tkg; render(); });
    const f = document.getElementById('tkF'), t = document.getElementById('tkT'); if (f) f.onchange = () => { TK.from = f.value; render(); }; if (t) t.onchange = () => { TK.to = t.value; render(); };
    document.getElementById('tkSt').onchange = e => { TK.store = e.target.value; render(); };
    document.getElementById('tkK').onchange = e => { TK.kind = e.target.value; render(); };
    let pt; document.getElementById('tkP').oninput = e => { clearTimeout(pt); pt = setTimeout(() => { TK.party = e.target.value.trim(); render(); setTimeout(() => { const x = document.getElementById('tkP'); if (x) { x.focus(); x.setSelectionRange(x.value.length, x.value.length); } }, 0); }, 350); };
    $$('[data-tki]').forEach(r => r.onclick = () => { window.MZ_FOCUS_LINE = { inv: r.dataset.tki, pid, at: Date.now(), back: true }; go('inv/' + r.dataset.tki); });
    const ed = document.getElementById('tkEdit'); if (ed) ed.onclick = () => productModal(pid);
    document.getElementById('tkXls').onclick = () => xlsxOut(`حركة_${(p.name || 'صنف').slice(0, 40)}.xlsx`, [['التاريخ', 'الحركة', 'رقم', 'الطرف / المخزن', 'وارد', 'منصرف', 'السعر', ...(sc() ? ['التكلفة', 'الربح'] : []), 'الرصيد بعد', 'بواسطة'],
      ...C.rows.map(m => { const inv = m.inv; const tr = inv.type === 'transfer'; return [inv.date, TYPES[inv.type].t, inv.no, tr ? storeName(inv.storeId) + ' ← ' + storeName(inv.toStoreId) : partyName(inv.partyId) || '', m.net > 0 ? m.net : '', m.net < 0 ? -m.net : '', inv.type === 'count' ? '' : +(m.unit || 0).toFixed(2), ...(sc() ? [m.cost != null ? +(+m.cost).toFixed(2) : '', m.profit != null && (inv.type === 'sale' || inv.type === 'sret') ? +(+m.profit).toFixed(2) : ''] : []), m.run, whoName(inv.createdBy) || '']; })], 'الحركة');
    document.getElementById('tkPrn').onclick = () => printTrack(pid, C);
    // كيبورد على جدول الحركات
    const tw = document.getElementById('tkW'); const trs = () => $$('#tkT tr[data-k]');
    const mark = () => { const rs = trs(); if (!rs.length) return; TK.hi = Math.max(0, Math.min(TK.hi, rs.length - 1)); rs.forEach((r, k) => r.classList.toggle('ws-on', k === TK.hi)); rs[TK.hi].scrollIntoView({ block: 'nearest' }); };
    tw.tabIndex = 0; tw.onkeydown = e => { const rs = trs(); if (e.key === 'ArrowDown') { e.preventDefault(); TK.hi++; mark(); } else if (e.key === 'ArrowUp') { e.preventDefault(); TK.hi--; mark(); } else if (e.key === 'PageDown') { e.preventDefault(); TK.hi += 10; mark(); } else if (e.key === 'PageUp') { e.preventDefault(); TK.hi -= 10; mark(); } else if (e.key === 'Enter' && rs[TK.hi]) { e.preventDefault(); rs[TK.hi].click(); } };
    tw.onfocus = () => mark();
  };
  function printTrack(pid, C) {
    const p = G('products', pid) || {}; const { from, to } = range(); const el = document.getElementById('print'); el.className = '';
    el.innerHTML = `<div style="border-bottom:2px solid #000;padding-bottom:6px;display:flex;justify-content:space-between"><div><h2 style="margin:0">${esc(settings().company || '')}</h2><div>كارت حركة صنف</div></div><div style="text-align:left"><h3 style="margin:0">${esc(p.name || '')}</h3><div>${esc(p.code || '')} — ${from || 'من البداية'} ← ${to || today()}${TK.store ? ' — ' + esc(storeName(TK.store)) : ''}</div></div></div>
      <p>رصيد أول المدة: <b>${fq(C.open)}</b> — وارد: <b>${fq(C.S.inQ)}</b> — منصرف: <b>${fq(C.S.outQ)}</b> — رصيد آخر المدة: <b>${fq(C.close)}</b></p>
      <table><thead><tr><th>التاريخ</th><th>الحركة</th><th>رقم</th><th>الطرف</th><th>وارد</th><th>منصرف</th><th>السعر</th><th>الرصيد</th></tr></thead><tbody>${C.rows.map(m => { const inv = m.inv; const tr = inv.type === 'transfer'; return `<tr><td>${esc(inv.date)}</td><td>${esc(TYPES[inv.type].t)}</td><td>${esc(inv.no)}</td><td>${esc(tr ? storeName(inv.storeId) + ' ← ' + storeName(inv.toStoreId) : partyName(inv.partyId) || '')}</td><td>${m.net > 0 ? fq(m.net) : ''}</td><td>${m.net < 0 ? fq(-m.net) : ''}</td><td>${inv.type === 'count' ? '' : fmt(m.unit)}</td><td><b>${fq(m.run)}</b></td></tr>`; }).join('')}</tbody></table>`;
    setTimeout(() => { try { window.print(); } catch (e) {} }, 50);
  }
  TK.compute = compute;
  window.itemCard = pid => { try { closeModal(); } catch (e) {} TK.open(pid); };
  const st = document.createElement('style'); st.textContent = `
  .tk-ch{display:flex;align-items:flex-end;gap:6px;height:150px;padding-top:8px}.tk-m{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%}
  .tk-b{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center;gap:2px}.tk-b i{display:block;width:42%;border-radius:4px 4px 0 0;min-height:1px}.tk-b i.in{background:var(--brand)}.tk-b i.out{background:var(--danger)}
  .tk-m small{font-size:10.5px;color:var(--muted)}#tkW:focus{outline:2px solid var(--brand);outline-offset:2px}
  #tkT tr.ws-on td{background:color-mix(in srgb,var(--brand) 18%,var(--surface))!important}`;
  document.head.appendChild(st);
})();
