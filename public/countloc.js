/* ميزان — جرد بالموقع.
   عدّ المخزون موقع-بموقع على الموبايل: امسح الباركود أو اختر الرف، اكتب المعدود (باليد أو بالعبوة 📦)،
   وميزان يحفظ فاتورة جرد (count) ويسوّي الفروقات بمتوسط التكلفة — نفس محرك التسوية الموجود.
   ورقة جرد مرتّبة بالموقع للعدّ على الورق. */
(function () {
  let CL = { store: MAIN, loc: '__all', counts: {}, q: '' };
  const r2 = n => Math.round((+n || 0) * 100) / 100;

  function locData() {
    const m = new Map(); let none = 0;
    for (const p of L('products')) {
      const k = (p.loc || '').trim();
      if (!k) { none++; continue; }
      m.set(k, (m.get(k) || 0) + 1);
    }
    const arr = [...m.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(k => ({ k, n: m.get(k) }));
    return { arr, none };
  }
  function prodsFor(loc) {
    let list = L('products');
    if (loc === '__none') list = list.filter(p => !(p.loc || '').trim());
    else if (loc && loc !== '__all') list = list.filter(p => (p.loc || '').trim() === loc);
    return list.sort((a, b) =>
      String(a.loc || '~~~').localeCompare(String(b.loc || '~~~'), undefined, { numeric: true }) ||
      String(a.name || '').localeCompare(String(b.name || ''), 'ar'));
  }
  const matchP = (p, q) => {
    q = String(q || '').trim(); if (!q) return true;
    const nq = (typeof norm === 'function' ? norm(q) : q.toLowerCase());
    return (typeof norm === 'function' ? norm(p.name) : (p.name || '').toLowerCase()).includes(nq)
      || String(p.code || '').includes(q)
      || String(p.barcode || '').includes(q)
      || (p.loc || '').toLowerCase().includes(q.toLowerCase());
  };
  const countedIn = loc => prodsFor(loc).filter(p => CL.counts[p.id] != null).length;

  window.vCountLoc = function () {
    setTitle('جرد بالموقع');
    const { arr, none } = locData();
    const sts = stores();
    let list = prodsFor(CL.loc).filter(p => matchP(p, CL.q));
    const totCounted = Object.keys(CL.counts).length;

    const chip = (k, label, n) => {
      const cc = countedIn(k);
      return `<button class="btn s ${CL.loc === k ? 'p' : ''}" data-loc="${esc(k)}">${esc(label)} <span class="small muted">${cc}/${n}</span></button>`;
    };

    $('#view').innerHTML = `<div class="wrap">
     <div class="card" style="margin-bottom:12px">
       <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
         <div class="psearch" style="flex:1 1 280px;margin:0">${ic('search')}<input class="in" id="clScan" placeholder="امسح الباركود أو اكتب اسم/كود الصنف ثم Enter" autocomplete="off" inputmode="search"></div>
         ${sts.length > 1 ? `<label class="f" style="margin:0">المخزن<select class="in" id="clStore" style="min-width:150px">${sts.map(s => `<option value="${esc(s.id)}" ${CL.store === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
         <span class="tag ok" id="clProg">معدود: ${totCounted} صنف</span>
         <span class="sp"></span>
         <button class="btn" id="clSheet">${ic('print')}ورقة جرد</button>
         <button class="btn" id="clClr" ${totCounted ? '' : 'disabled'}>مسح العدّ</button>
         <button class="btn p" id="clSave" ${totCounted && !S.ro ? '' : 'disabled'}>حفظ الجرد وتسوية</button>
       </div>
       <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:12px">
         ${chip('__all', 'الكل', L('products').length)}
         ${arr.map(x => chip(x.k, '📍 ' + x.k, x.n)).join('')}
         ${none ? chip('__none', 'بدون موقع', none) : ''}
       </div>
     </div>

     <div class="tw"><table class="t" id="clt"><thead><tr>
       <th style="min-width:70px">الموقع</th><th style="min-width:180px">الصنف</th>
       <th class="n">الرصيد الدفتري</th><th>المعدود</th><th class="n">الفرق</th></tr></thead><tbody>
       ${list.slice(0, 600).map(p => clRow(p)).join('') || `<tr><td colspan="5"><div class="empty" style="padding:24px"><b>مفيش أصناف هنا</b>اختر رف تاني أو امسح باركود صنف.</div></td></tr>`}
     </tbody></table></div>
     ${list.length > 600 ? `<p class="small muted">بيظهر أول 600 صنف — استخدم البحث أو اختر رف.</p>` : ''}
     <p class="small muted" style="margin-top:10px">العدّ بيسوّي رصيد كل صنف عدّيته للرقم المعدود (بمتوسط التكلفة). الأصناف اللي ماعدّتهاش مش بتتغير. خلّي لكل صنف <b>موقع واحد</b> عشان العدّ يبقى مظبوط.</p>
    </div>`;

    const store = CL.store;
    function updProg() { const n = Object.keys(CL.counts).length; const e = $('#clProg'); if (e) e.textContent = 'معدود: ' + n + ' صنف'; const sv = $('#clSave'); if (sv) sv.disabled = !(n && !S.ro); const cl = $('#clClr'); if (cl) cl.disabled = !n; }
    function updRow(pid) {
      const d = $(`[data-diff="${pid}"]`); if (!d) return;
      const v = CL.counts[pid];
      if (v == null) { d.textContent = '—'; d.className = 'n muted'; return; }
      const df = r2(+v - qtyIn(pid, store));
      d.innerHTML = `<b>${df > 0 ? '+' : ''}${fq(df)}</b>`;
      d.className = 'n ' + (df < 0 ? 'neg' : df > 0 ? 'pos' : 'muted');
    }

    $('#clt').addEventListener('change', e => {
      const el = e.target; const pid = el.dataset.cl; if (!pid) return;
      const raw = el.value.trim();
      if (raw === '') { delete CL.counts[pid]; } else { CL.counts[pid] = Math.max(0, numIn(raw)); }
      updRow(pid); updProg();
      // تحديث عدّاد الرف الحالي بدون إعادة رسم كامل
      const b = $(`[data-loc="${CL.loc}"] .muted`); if (b) b.textContent = countedIn(CL.loc) + '/' + prodsFor(CL.loc).length;
    });
    $('#clt').addEventListener('click', e => {
      const b = e.target.closest('[data-pk]'); if (b) countPack(b.dataset.pk, store, updRow, updProg);
    });

    $$('[data-loc]').forEach(b => b.onclick = () => { CL.loc = b.dataset.loc; CL.q = ''; render(); });

    const sel = $('#clStore'); if (sel) sel.onchange = e => { CL.store = e.target.value; render(); };

    const scan = $('#clScan');
    scan.onkeydown = e => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const v = scan.value.trim(); if (!v) return;
      let hit = L('products').find(p => bcMatch(p, v, true));
      if (!hit) { const r = pSearch(v, 1); hit = r && r[0]; }
      if (!hit) { toast('مفيش صنف بالكود/الاسم ده', 'err'); scan.select(); return; }
      scan.value = '';
      const loc = (hit.loc || '').trim() ? (hit.loc || '').trim() : '__none';
      if (CL.loc !== loc && CL.loc !== '__all') { CL.loc = loc; render(); }
      setTimeout(() => {
        const inp = $(`[data-cl="${hit.id}"]`);
        if (inp) { inp.scrollIntoView({ block: 'center' }); inp.focus(); inp.select(); toast('📍 ' + hit.name, 'ok'); }
        else { CL.loc = '__all'; CL.q = hit.name; render(); }
        const s2 = $('#clScan'); if (s2) s2.focus();
      }, 30);
    };

    $('#clClr').onclick = async () => { if (await confirmBox('مسح كل الأرقام المعدودة؟ (الأصناف نفسها مش هتتغير)', 'مسح')) { CL.counts = {}; render(); } };
    $('#clSheet').onclick = () => printSheet();
    $('#clSave').onclick = () => saveCount();
  };

  function clRow(p) {
    const store = CL.store;
    const v = CL.counts[p.id];
    const book = qtyIn(p.id, store);
    const df = v == null ? null : r2(+v - book);
    return `<tr>
      <td class="num">${p.loc ? esc(p.loc) : '<span class="muted">—</span>'}</td>
      <td><b>${esc(p.name)}</b>${p.code ? `<div class="small muted num">كود ${esc(p.code)}</div>` : ''}</td>
      <td class="n num">${fq(book)}</td>
      <td><div class="row" style="gap:6px;flex-wrap:nowrap"><input class="cell n" style="min-width:72px;font-size:16px" inputmode="decimal" data-cl="${p.id}" value="${v != null ? v : ''}" placeholder="عدّ"><button type="button" class="btn s" data-pk="${p.id}" title="عدّ بالعبوة">📦</button></div></td>
      <td class="n num" data-diff="${p.id}">${df == null ? '<span class="muted">—</span>' : `<b class="${df < 0 ? 'neg' : df > 0 ? 'pos' : 'muted'}">${df > 0 ? '+' : ''}${fq(df)}</b>`}</td>
    </tr>`;
  }

  // عدّاد بالعبوة: عدد العبوات × القطع في العبوة + قطع فاضية = الإجمالي المعدود
  function countPack(pid, store, updRow, updProg) {
    const p = G('products', pid); if (!p) return;
    modal(`<h2>📦 عدّ بالعبوة — ${esc(p.name)}</h2>
     <p class="small muted" style="margin-top:-6px">اكتب عدد الكراتين/الدست اللي على الرف، والقطع الفاضية، وميزان يجمعها.</p>
     <div class="row" style="gap:10px;flex-wrap:wrap">
       <label class="f" style="flex:1 1 120px">عدد العبوات<input class="in n" id="ckN" inputmode="decimal" value=""></label>
       <label class="f" style="flex:1 1 120px">القطع في العبوة<input class="in n" id="ckP" inputmode="decimal" value="12"></label>
       <label class="f" style="flex:1 1 120px">قطع فاضية (كسر)<input class="in n" id="ckL" inputmode="decimal" value="0"></label>
     </div>
     <div class="row" style="gap:6px;flex-wrap:wrap;margin:-2px 0 6px">${[['قطعة', 1], ['دستة (12)', 12], ['2 دستة (24)', 24], ['كرتونة 5د (60)', 60], ['×6', 6], ['×4×25 (100)', 100]].map(([t, v]) => `<button type="button" class="btn s" data-ckp="${v}">${t}</button>`).join('')}</div>
     <div class="card" id="ckOut" style="padding:10px 12px;margin-top:4px"></div>
     <div class="row" style="margin-top:12px"><button class="btn p" id="ckApply">تطبيق</button><span class="sp"></span><button class="btn" data-close>إلغاء</button></div>`, true);
    const calc = () => {
      const N = numIn($('#ckN').value), P = numIn($('#ckP').value) || 1, Lo = numIn($('#ckL').value);
      const tot = Math.round((N * P + Lo) * 1000) / 1000;
      $('#ckOut').innerHTML = `الإجمالي المعدود: <b style="font-size:17px">${fq(tot)}</b> قطعة <span class="small muted">(${fq(N)} × ${fq(P)}${Lo ? ' + ' + fq(Lo) : ''})</span>`;
      return tot;
    };
    ['ckN', 'ckP', 'ckL'].forEach(id => { const e = $('#' + id); if (e) e.oninput = calc; });
    $$('[data-ckp]').forEach(b => b.onclick = () => { $('#ckP').value = b.dataset.ckp; calc(); });
    calc();
    $('#ckApply').onclick = () => {
      const tot = calc();
      CL.counts[pid] = Math.max(0, tot);
      const inp = $(`[data-cl="${pid}"]`); if (inp) inp.value = tot;
      updRow && updRow(pid); updProg && updProg();
      closeModal(); toast('اتعدّ: ' + fq(tot) + ' قطعة', 'ok');
    };
  }

  async function saveCount() {
    if (S.ro) return;
    const store = CL.store;
    const pids = Object.keys(CL.counts);
    if (!pids.length) { toast('اكتب الأرقام المعدودة الأول', 'err'); return; }
    const lines = []; let plus = 0, minus = 0, nDiff = 0;
    for (const pid of pids) {
      const q = Math.max(0, +CL.counts[pid] || 0);
      const book = qtyIn(pid, store);
      const df = r2(q - book);
      if (Math.abs(df) > 0.0001) { nDiff++; if (df > 0) plus++; else minus++; }
      lines.push({ pid, qty: q, price: r2(avgCost(pid)), disc: 0, cost: '' });
    }
    const ok = await confirmBox(
      `حفظ الجرد؟<br>• <b>${lines.length}</b> صنف معدود.<br>• فروقات: <b>${nDiff}</b> (زيادة ${plus} · عجز ${minus}).<br>الرصيد هيتسوّى للرقم المعدود بمتوسط التكلفة.`,
      'حفظ الجرد');
    if (!ok) return;
    const mx = L('invoices').filter(i => i.type === 'count').reduce((m, i) => Math.max(m, +i.no || 0), 0);
    const id = uid();
    const locs = [...new Set(pids.map(pid => (G('products', pid)?.loc || '').trim()).filter(Boolean))];
    await put('invoices', id, {
      type: 'count', no: mx + 1, date: today(), storeId: store, lines,
      discount: 0, taxRate: 0, paid: 0,
      notes: 'جرد بالموقع' + (locs.length ? ' — ' + locs.slice(0, 20).join('، ') + (locs.length > 20 ? ' …' : '') : ''),
      createdAt: new Date().toISOString(), createdBy: (S.me && S.me.id) || ''
    });
    try { await audit('invoice', id, 'جرد بالموقع', '', `${lines.length} صنف — ${nDiff} فرق`, ''); } catch (e) {}
    CL.counts = {};
    toast(`اتحفظ الجرد: ${lines.length} صنف، ${nDiff} فرق`, 'ok');
    go('inv/' + id);
  }

  function printSheet() {
    const list = prodsFor(CL.loc === '__all' ? '__all' : CL.loc);
    if (!list.length) { toast('مفيش أصناف للطباعة', 'err'); return; }
    const s = settings();
    const title = CL.loc === '__all' ? 'كل المواقع' : CL.loc === '__none' ? 'بدون موقع' : 'الرف ' + CL.loc;
    const rows = list.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.loc || '')}</td><td>${esc(p.code || '')}</td><td>${esc(p.name)}</td><td style="text-align:left">${fq(qtyIn(p.id, CL.store))}</td><td style="min-width:70px"></td></tr>`).join('');
    const pr = $('#print'); pr.className = '';
    pr.innerHTML = `<style>@page{size:A4 portrait;margin:10mm}#print td:last-child{min-width:70px}</style>
     <div style="display:flex;justify-content:space-between;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:8px">
       <div><h2 style="margin:0">ورقة جرد — ${esc(title)}</h2><div>${esc(s.company || '')}</div></div>
       <div style="text-align:left">${esc(storeName ? storeName(CL.store) : '')}<br>${today()}</div></div>
     <table><thead><tr><th>م</th><th>الموقع</th><th>الكود</th><th>الصنف</th><th>الرصيد الدفتري</th><th>المعدود</th></tr></thead><tbody>${rows}</tbody></table>`;
    setTimeout(() => { try { window.print(); } catch (e) { toast('الطباعة غير متاحة هنا', 'err'); } }, 60);
  }
})();
