/* ميزان — تكويد الأصناف في أورجا من Excel + تعديل صنف متكوّد.
   - رفع شيت → ربط أعمدة مرن (الاسم/كود ماستر/التكلفة/المستهلك) → معاينة →
     «كوّد في أورجا»: بيروح الطابور، والوكيل 1.10.0+ بينشئ الكروت في PRODUCTS (ترميز win1256 خام،
     التريجر يكوّد PROD_ID، ومنع التكرار بكود ماستر) ويرجّع الأكواد.
   - تعديل: تختار صنف متزامن (له كود أورجا) وتغيّر الاسم/المستهلك/التكلفة → الوكيل يعدّلها في أورجا. */
(function () {
  const OC = {
    mode: 'create',
    rows: null, headers: [], map: { name: null, master: null, cost: null, cons: null }, file: '', busy: false,
    sent: null,      // { refToRow } خريطة المرجع
    results: {},     // ref -> {status, prod, dup, error, name, master}
    poll: null,
    edit: { q: '', pid: '', name: '', cons: '', cost: '', orig: null, busy: false, res: null }
  };
  const numIn = window.numIn || (v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, '')); return isFinite(n) ? n : 0; });

  const HKEYS = {
    name: ['اسم', 'الصنف', 'صنف', 'البيان', 'بيان', 'وصف', 'name', 'desc', 'item', 'product'],
    master: ['ماستر', 'كود ماستر', 'كود المورد', 'كود', 'code', 'master', 'sku', 'ref'],
    cost: ['تكلفة', 'شراء', 'الصافي', 'صافي', 'cost', 'buy', 'net'],
    cons: ['مستهلك', 'جمهور', 'قطاعي', 'بيع', 'consumer', 'retail', 'price', 'sell']
  };
  function autoMapOC(headers) {
    const m = { name: null, master: null, cost: null, cons: null };
    const H = headers.map(h => String(h || '').trim().toLowerCase());
    for (const f of Object.keys(HKEYS)) {
      for (let i = 0; i < H.length; i++) { if (HKEYS[f].some(k => H[i].includes(k.toLowerCase()))) { m[f] = i; break; } }
    }
    // «الاسم» ما يتاخدش لو اتحجز كـ ماستر والعكس
    if (m.master != null && m.master === m.name) m.master = null;
    return m;
  }

  function readFileOC(f) {
    if (!window.XLSX) { toast('مكتبة Excel لم تُحمَّل — تأكد من الاتصال', 'err'); return; }
    const r = new FileReader();
    r.onload = () => {
      try {
        const wb = XLSX.read(new Uint8Array(r.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true }).filter(row => row.some(c => String(c).trim() !== ''));
        if (aoa.length < 2) { toast('الشيت فاضي أو مفيهوش غير صف العناوين', 'err'); return; }
        let hr = 0;
        for (let i = 0; i < Math.min(6, aoa.length); i++) { const mm = autoMapOC(aoa[i].map(String)); if (mm.name != null) { hr = i; break; } }
        OC.headers = aoa[hr].map(h => String(h).trim());
        OC.rows = aoa.slice(hr + 1);
        OC.map = autoMapOC(OC.headers);
        OC.file = f.name; OC.results = {}; OC.sent = null; OC.busy = false;
        if (OC.map.name == null) toast('مقدرتش أحدد عمود اسم الصنف — اختاره يدويًا', 'err');
        render();
      } catch (e) { toast('تعذّر قراءة الملف: تأكد إنه Excel سليم', 'err'); console.error(e); }
    };
    r.readAsArrayBuffer(f);
  }

  // بناء صفوف المعاينة من الربط الحالي
  function ocRows() {
    const m = OC.map; const out = [];
    if (!OC.rows || m.name == null) return out;
    const seenMaster = new Set();
    OC.rows.forEach((row, i) => {
      const name = String(row[m.name] == null ? '' : row[m.name]).trim();
      if (!name) return;
      const master = m.master != null ? String(row[m.master] == null ? '' : row[m.master]).trim() : '';
      const cost = m.cost != null ? numIn(row[m.cost]) : 0;
      const cons = m.cons != null ? numIn(row[m.cons]) : 0;
      const ref = 'r' + i;
      let err = '';
      if (master && seenMaster.has(master)) err = 'كود ماستر مكرر في الشيت';
      if (master) seenMaster.add(master);
      out.push({ ref, name: name.slice(0, 50), master: master.slice(0, 25), cost, cons, err });
    });
    return out;
  }

  async function doCode(rows) {
    rows = rows.filter(r => !r.err);
    if (!rows.length) { toast('مفيش صفوف صالحة', 'err'); return; }
    OC.busy = true; OC.results = {}; render();
    const items = rows.map(r => ({ ref: r.ref, name: r.name, master: r.master, cons: r.cons, cost: r.cost }));
    try {
      const resp = await MZ.post('/api/orga/products/add', { items });
      if (!resp || !resp.queued) { OC.busy = false; toast('مفيش أصناف اتضافت للطابور', 'err'); render(); return; }
      toast('اتبعت ' + resp.queued + ' صنف للطابور — جاري التكويد في أورجا…');
      startPoll();
    } catch (e) { OC.busy = false; toast('تعذّر الإرسال: ' + (e && e.message || e), 'err'); render(); }
  }

  function startPoll() {
    stopPoll();
    OC.poll = setInterval(pollStatus, 3000);
    pollStatus();
  }
  function stopPoll() { if (OC.poll) { clearInterval(OC.poll); OC.poll = null; } }

  async function pollStatus() {
    let j = {};
    try { const r = await fetch('/api/orga/products/status', { credentials: 'same-origin', headers: { 'X-Mizan': '1' } }); if (r.ok) j = await r.json(); } catch (e) { return; }
    const res = {};
    for (const x of (j.results || [])) if (x.ref) res[x.ref] = x;
    OC.results = res;
    const left = (j.counts && ((j.counts.pending || 0) + (j.counts.sending || 0))) || 0;
    if (left === 0) { OC.busy = false; stopPoll(); }
    if (OC.mode === 'create') render();
  }

  // ========= تعديل صنف متكوّد =========
  async function doEdit() {
    const e = OC.edit;
    const prod = +e.pid;
    if (!(prod > 0)) { toast('اختر صنف متزامن له كود أورجا', 'err'); return; }
    const payload = { prod };
    const nm = String(e.name || '').trim();
    if (nm && (!e.orig || nm !== e.orig.name)) payload.name = nm.slice(0, 50);
    const prices = {};
    if (e.cons !== '' && e.cons != null) prices.CONSUMER = numIn(e.cons);
    if (e.cost !== '' && e.cost != null) { prices.PRIC_COST = numIn(e.cost); prices.COST_AV = numIn(e.cost); }
    if (Object.keys(prices).length) payload.prices = prices;
    if (!payload.name && !payload.prices) { toast('غيّر الاسم أو قيمة الأول', 'err'); return; }
    e.busy = true; e.res = null; render();
    try {
      const r = await MZ.post('/api/orga/products/edit', { items: [payload] });
      if (!r || !r.queued) { e.busy = false; toast('مفيش تعديل اتضاف', 'err'); render(); return; }
      toast('اتبعت التعديل — جاري تطبيقه في أورجا…');
      // استنى نتيجة التعديل
      let tries = 0;
      const iv = setInterval(async () => {
        tries++;
        let j = {}; try { const rr = await fetch('/api/orga/products/status', { credentials: 'same-origin', headers: { 'X-Mizan': '1' } }); if (rr.ok) j = await rr.json(); } catch (x) {}
        const ec = (j.edits && j.edits.counts) || {};
        const left = (ec.pending || 0) + (ec.sending || 0);
        if (left === 0 || tries > 40) {
          clearInterval(iv); e.busy = false;
          const errs = (j.edits && j.edits.errors) || [];
          const mine = errs.find(x => +x.prod === prod);
          if (mine) { e.res = { ok: false, error: mine.error }; toast('فشل التعديل: ' + mine.error, 'err'); }
          else { e.res = { ok: true }; toast('تم تعديل الصنف في أورجا ✓'); }
          render();
        }
      }, 2500);
    } catch (x) { e.busy = false; toast('تعذّر الإرسال: ' + (x && x.message || x), 'err'); render(); }
  }

  function exportResults(rows) {
    const data = [['كود ماستر', 'اسم الصنف', 'كود أورجا', 'الحالة']];
    for (const r of rows) {
      const rr = OC.results[r.ref];
      const st = rr ? (rr.status === 'done' ? (rr.dup ? 'موجود قبل كده' : 'اتعمل') : rr.status === 'error' ? 'خطأ: ' + rr.error : rr.status) : '';
      data.push([r.master, r.name, rr && rr.prod ? rr.prod : '', st]);
    }
    xlsxOut('أكواد-أورجا.xlsx', data, 'الأكواد');
  }

  window.vOrgaCode = function () {
    setTitle('تكويد الأصناف في أورجا');
    stopPoll();
    if (!canOrgaWrite()) { $('#view').innerHTML = `<div class="wrap"><div class="empty card"><b>مش متاح لصلاحيتك</b>تكويد الأصناف في أورجا محتاج صلاحية الكتابة لأورجا.</div></div>`; return; }
    const tabs = `<div class="seg" style="margin-bottom:14px">
      <button data-ocm="create" class="${OC.mode === 'create' ? 'on' : ''}">رفع شيت وتكويد</button>
      <button data-ocm="edit" class="${OC.mode === 'edit' ? 'on' : ''}">تعديل صنف متكوّد</button></div>`;

    if (OC.mode === 'edit') { renderEdit(tabs); bindCommon(); return; }

    // ===== وضع الرفع =====
    if (!OC.rows) {
      $('#view').innerHTML = `<div class="wrap" style="max-width:860px">${tabs}
       <div class="drop" id="ocDrop" tabindex="0" role="button"><div style="color:var(--brand);margin-bottom:8px">${ic('up', 'style="width:42px;height:42px"')}</div><b>اسحب شيت Excel هنا أو اضغط للاختيار</b><span class="muted">xlsx / xls / csv — أول صف عناوين الأعمدة</span><input type="file" id="ocFile" accept=".xlsx,.xls,.csv" hidden></div>
       <div class="card" style="margin-top:18px"><h3>إيه اللي هيحصل؟</h3><p class="muted small" style="margin:0">هترفع أي شيت وتحدد بنفسك أنهي عمود الاسم وأنهي كود الماستر والتكلفة والمستهلك. ميزان يبعت الأصناف للوكيل، والوكيل ينشئها في أورجا بأكواد صحيحة وأسماء عربية سليمة، ويرجّعلك كود أورجا لكل صنف. الصنف اللي كود الماستر بتاعه موجود قبل كده مابيتكررش.</p></div>
       <div class="card" style="margin-top:14px"><h3>معندكش شيت؟</h3><button class="btn" id="ocTpl">${ic('dl')}تنزيل قالب</button></div></div>`;
      const dr = $('#ocDrop'), fi = $('#ocFile');
      dr.onclick = () => fi.click(); dr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') fi.click(); };
      dr.ondragover = e => { e.preventDefault(); dr.classList.add('over'); }; dr.ondragleave = () => dr.classList.remove('over');
      dr.ondrop = e => { e.preventDefault(); dr.classList.remove('over'); if (e.dataTransfer.files[0]) readFileOC(e.dataTransfer.files[0]); };
      fi.onchange = () => fi.files[0] && readFileOC(fi.files[0]);
      $('#ocTpl').onclick = () => xlsxOut('قالب-تكويد-اصناف.xlsx', [['اسم الصنف', 'كود ماستر', 'التكلفة', 'سعر المستهلك'], ['مثال: ببرونة 125 مل', '22037', 156.54, 255]], 'اصناف');
      bindCommon();
      return;
    }

    const rows = ocRows();
    const nOk = rows.filter(r => !r.err).length, nErr = rows.filter(r => r.err).length;
    const done = rows.filter(r => OC.results[r.ref] && OC.results[r.ref].status === 'done').length;
    const errd = rows.filter(r => OC.results[r.ref] && OC.results[r.ref].status === 'error').length;
    const working = OC.busy;
    const FIELDS = [['name', 'اسم الصنف *'], ['master', 'كود ماستر'], ['cost', 'التكلفة'], ['cons', 'سعر المستهلك']];
    $('#view').innerHTML = `<div class="wrap">${tabs}
     <div class="row" style="margin-bottom:12px"><b>${esc(OC.file)}</b><span class="tag">${rows.length} صف</span><span class="tag ok">${nOk} صالح</span>${nErr ? `<span class="tag bad">${nErr} مكرر</span>` : ''}${done ? `<span class="tag purchase">${done} اتكوّد</span>` : ''}${errd ? `<span class="tag bad">${errd} فشل</span>` : ''}<span class="sp"></span><button class="btn" id="ocReset">ملف آخر</button></div>
     <div class="card" style="margin-bottom:14px"><h3>ربط الأعمدة</h3><div class="maprow">${FIELDS.map(([k, t]) => `<label class="f">${t}<select class="in" data-ocmap="${k}">${opts(OC.headers.map((h, i) => [i, h || ('عمود ' + (i + 1))]), OC.map[k], '— تجاهل —')}</select></label>`).join('')}</div></div>
     <div class="tw" style="max-height:52vh;overflow:auto"><table class="t"><thead><tr><th>الحالة</th><th>اسم الصنف</th><th>كود ماستر</th><th class="n">التكلفة</th><th class="n">المستهلك</th><th>كود أورجا</th></tr></thead><tbody>
     ${rows.slice(0, 500).map(r => { const rr = OC.results[r.ref]; const st = r.err ? `<span class="tag bad">${r.err}</span>` : rr ? (rr.status === 'done' ? `<span class="tag ${rr.dup ? '' : 'ok'}">${rr.dup ? 'موجود' : 'اتكوّد'}</span>` : rr.status === 'error' ? `<span class="tag bad" title="${esc(rr.error)}">فشل</span>` : `<span class="tag">${rr.status === 'sending' ? 'جاري…' : 'في الطابور'}</span>`) : (working ? '<span class="tag">…</span>' : '<span class="muted">—</span>'); return `<tr><td>${st}</td><td>${esc(r.name)}</td><td class="num">${esc(r.master)}</td><td class="n">${r.cost ? fmt(r.cost) : '<span class="muted">—</span>'}</td><td class="n">${r.cons ? fmt(r.cons) : '<span class="muted">—</span>'}</td><td class="num"><b>${rr && rr.prod ? rr.prod : ''}</b>${rr && rr.status === 'error' ? `<br><span class="small" style="color:var(--danger)">${esc(rr.error)}</span>` : ''}</td></tr>`; }).join('')}</tbody></table></div>
     ${rows.length > 500 ? `<p class="small muted">معروض أول 500 — التكويد بيشمل الكل (${rows.length}).</p>` : ''}
     <div class="stickybar">${working ? `<div style="flex:1"><div class="progress"><i style="width:${rows.length ? (done + errd) / nOk * 100 : 0}%"></i></div><div class="small muted" style="margin-top:6px">جاري التكويد… ${done + errd} / ${nOk}</div></div>` : `<button class="btn p" id="ocGo" ${S.ro || !nOk ? 'disabled' : ''}>كوّد ${nOk} صنف في أورجا</button>${(done || errd) ? `<button class="btn s" id="ocExp">${ic('dl')}تصدير الأكواد</button>` : ''}<span class="small muted">المكرر هيتجاهل.</span>`}</div></div>`;

    $('#ocReset').onclick = () => { OC.rows = null; OC.results = {}; render(); };
    $$('[data-ocmap]').forEach(s => s.onchange = () => { OC.map[s.dataset.ocmap] = s.value === '' ? null : +s.value; render(); });
    const go2 = $('#ocGo'); if (go2) go2.onclick = () => doCode(rows);
    const ex = $('#ocExp'); if (ex) ex.onclick = () => exportResults(rows);
    bindCommon();
  };

  function renderEdit(tabs) {
    const e = OC.edit;
    const q = String(e.q || '').trim().toLowerCase();
    let list = [];
    if (q) list = (window.L ? L('products') : []).filter(p => +p.orga > 0 && !p.inactive && (String(p.name || '').toLowerCase().includes(q) || String(p.orga).includes(q) || String(p.code || '').includes(q))).slice(0, 30);
    const sel = e.pid ? (window.G ? null : null) : null;
    $('#view').innerHTML = `<div class="wrap" style="max-width:720px">${tabs}
     <div class="card" style="margin-bottom:14px"><h3>اختر الصنف المتكوّد</h3>
       <label class="f">ابحث بالاسم أو كود أورجا<input class="in" id="ocEq" value="${esc(e.q)}" placeholder="اكتب اسم الصنف أو كوده في أورجا"></label>
       ${q ? (list.length ? `<div class="tw" style="max-height:30vh;overflow:auto;margin-top:8px"><table class="t"><tbody>${list.map(p => `<tr style="cursor:pointer" data-pick="${esc(p.id)}"><td class="num">${esc(p.orga)}</td><td><b>${esc(p.name)}</b></td><td class="small muted">مستهلك ${fmt(consOf ? consOf(p) : (p.cons || p.price || 0))}</td></tr>`).join('')}</tbody></table></div>` : `<p class="small muted" style="margin-top:8px">مفيش صنف متزامن مطابق.</p>`) : `<p class="small muted" style="margin-top:8px">الأصناف المتزامنة من أورجا بس هي اللي ينفع تتعدّل هنا.</p>`}
     </div>
     ${e.pid ? `<div class="card"><h3>تعديل البيانات <span class="small muted">كود أورجا ${esc(e.pid)}</span></h3>
       <div class="grid g2">
         <label class="f">اسم الصنف<input class="in" id="ocEn" value="${esc(e.name)}"></label>
         <label class="f">سعر المستهلك<input class="in n" id="ocEc" inputmode="decimal" value="${esc(e.cons)}"></label>
         <label class="f">التكلفة<input class="in n" id="ocEcost" inputmode="decimal" value="${esc(e.cost)}"></label>
       </div>
       <p class="small muted" style="margin:6px 0 0">سيب الخانة فاضية لو مش عاوز تغيّرها. التغيير بيروح لأورجا عن طريق الوكيل.</p>
       <div class="stickybar">${e.busy ? `<div class="small muted">جاري التعديل في أورجا…</div>` : `<button class="btn p" id="ocEsave" ${S.ro ? 'disabled' : ''}>احفظ التعديل في أورجا</button><button class="btn s" id="ocEclr">إلغاء</button>`}${e.res && e.res.ok ? `<span class="tag ok">اتعدّل ✓</span>` : e.res && !e.res.ok ? `<span class="tag bad">${esc(e.res.error || 'فشل')}</span>` : ''}</div>
     </div>` : ''}</div>`;

    const eq = $('#ocEq'); if (eq) { eq.oninput = () => { e.q = eq.value; e.pid = e.pid; renderDebounce(); }; }
    $$('[data-pick]').forEach(tr => tr.onclick = () => {
      const p = G('products', tr.dataset.pick); if (!p) return;
      e.pid = String(p.orga); e.name = p.name || ''; e.cons = (consOf ? consOf(p) : (p.cons || p.price || '')) || ''; e.cost = (p.cost != null ? p.cost : ''); e.orig = { name: p.name || '' }; e.res = null; render();
    });
    const en = $('#ocEn'); if (en) en.oninput = () => e.name = en.value;
    const ec = $('#ocEc'); if (ec) ec.oninput = () => e.cons = ec.value;
    const ecost = $('#ocEcost'); if (ecost) ecost.oninput = () => e.cost = ecost.value;
    const sv = $('#ocEsave'); if (sv) sv.onclick = doEdit;
    const cl = $('#ocEclr'); if (cl) cl.onclick = () => { e.pid = ''; e.orig = null; e.res = null; render(); };
  }

  let _dt = null;
  function renderDebounce() { clearTimeout(_dt); _dt = setTimeout(render, 220); }

  function bindCommon() {
    $$('[data-ocm]').forEach(b => b.onclick = () => { OC.mode = b.dataset.ocm; stopPoll(); render(); });
  }
})();
