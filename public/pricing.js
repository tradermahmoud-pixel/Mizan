/* ميزان — تسعير الشرائح.
   تختار فواتير (قديمة أو جديدة) → ميزان يجمع أصنافها → تكتب نسبة خصم لكل شريحة →
   يحسب سعر كل شريحة (القيمة مش النسبة) = السعر الأساسي × (1 − الخصم) ويعرضه ويصدّره Excel.
   الإرسال المباشر لأورجا خطوة تانية (محتاج تحديث الوكيل). */
(function () {
  // ترتيب الشرائح حسب أعمدة أورجا PRICE_1..4 (قطاعي = الجمهور، مش بيتغيّر)
  const TIERS = [
    { n: 1, label: 'كبار العملاء', col: 'PRICE_1' },
    { n: 2, label: 'آجل', col: 'PRICE_2' },
    { n: 3, label: 'صيدلي نقدي', col: 'PRICE_3' },
    { n: 4, label: 'آجل 15 يوم', col: 'PRICE_4' },
  ];
  let PR = { inv: new Set(), disc: { 1: '', 2: '', 3: '', 4: '' }, base: 'cost', round: 'none' };

  const rnd = v => { v = +v || 0; if (PR.round === 'pound') return Math.round(v); if (PR.round === 'half') return Math.round(v * 2) / 2; if (PR.round === 'quarter') return Math.round(v * 4) / 4; return Math.round(v * 100) / 100; };
  // تكلفة الشراء من الفواتير المختارة (صافي سطر الفاتورة بعد الخصم) — مش متوسط المخزون
  function costMap() {
    const key = [...PR.inv].join(',');
    if (costMap._k === key) return costMap._m;
    const m = {};
    for (const iid of PR.inv) {
      const v = G('invoices', iid); if (!v || !v.lines) continue;
      let f = 1; try { const tt = invTotals(v); if (tt && tt.sub > 0) f = tt.after / tt.sub; } catch (e) {}
      for (const l of v.lines) {
        if (!l.pid || l.bonus) continue;
        const unit = (+l.price || 0) * (1 - (+l.disc || 0) / 100) * f;
        if (unit > 0) m[l.pid] = Math.round(unit * 10000) / 10000;
      }
    }
    costMap._k = key; costMap._m = m; return m;
  }
  const costOf = p => { const c = costMap()[p.id]; return c != null ? c : (avgCost(p.id) || +p.cost || 0); };
  const baseOf = p => PR.base === 'cost' ? costOf(p) : (consOf(p) || +p.price || 0);
  const tierPrice = (p, n) => { const b = baseOf(p); if (!(b > 0)) return 0; const d = numIn(PR.disc[n]); const v = PR.base === 'cost' ? b * (1 + d / 100) : b * (1 - d / 100); return rnd(v); };

  const recentPur = () => L('invoices').filter(v => v.type === 'purchase' && !v.orgaGone).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.no).localeCompare(String(a.no))).slice(0, 24);
  function chosenProds() {
    const ids = new Set();
    for (const iid of PR.inv) { const v = G('invoices', iid); if (v && v.lines) for (const l of v.lines) if (l.pid) ids.add(l.pid); }
    return [...ids].map(id => G('products', id)).filter(Boolean).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ar'));
  }

  window.vPricing = function () {
    setTitle('تسعير الشرائح');
    const list = chosenProds();
    const rec = recentPur();
    const selInvs = [...PR.inv].map(id => G('invoices', id)).filter(Boolean);

    $('#view').innerHTML = `<div class="wrap">
      <div class="card" style="padding:16px;margin-bottom:12px">
        <h2 style="margin:0 0 4px">تسعير الشرائح</h2>
        <p class="small muted" style="margin:0 0 12px">اختر فواتير الشراء، اكتب نسبة كل شريحة، وميزان يحسب سعرها لكل صنف.<br><b>وضع التكلفة:</b> السعر = التكلفة × (1 + نسبة الربح) — مثال 82.62 + 7% = 88.40.<br><b>وضع الجمهور:</b> السعر = سعر الجمهور × (1 − نسبة الخصم).</p>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
          <label class="f" style="margin:0;flex:1 1 220px">أضف فاتورة شراء برقمها<input class="in" id="prNo" inputmode="numeric" placeholder="رقم الفاتورة ثم Enter"></label>
          <button class="btn" id="prAdd">أضف</button>
          ${PR.inv.size ? `<button class="btn s" id="prClr">مسح الكل</button>` : ''}
        </div>
        ${selInvs.length ? `<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:10px">${selInvs.map(v => `<span class="tag">#${esc(v.no)} · ${esc(v.date || '')} <button data-rm="${esc(v.id)}" style="border:0;background:none;color:var(--danger);cursor:pointer;font-size:15px">×</button></span>`).join('')}</div>` : ''}
        <div class="small muted" style="margin-top:10px">${rec.length ? 'أحدث فواتير الشراء (دوس عليها للاختيار):' : 'مفيش فواتير شراء لسه.'}</div>
        <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px">${rec.map(v => `<button class="btn s ${PR.inv.has(v.id) ? 'p' : ''}" data-inv="${esc(v.id)}">#${esc(v.no)} <span class="small muted">${esc(v.date || '')} · ${v.lines ? v.lines.length : 0}صنف</span></button>`).join('')}</div>
      </div>

      <div class="card" style="padding:16px;margin-bottom:12px">
        <div class="row" style="gap:18px;flex-wrap:wrap;align-items:flex-end">
          <div><div class="small muted" style="margin-bottom:4px">أساس الحساب</div>
            <div class="row" style="gap:0">
              <button class="btn s ${PR.base === 'cost' ? 'p' : ''}" data-base="cost" style="border-radius:0 8px 8px 0">التكلفة (ربح)</button>
              <button class="btn s ${PR.base === 'consumer' ? 'p' : ''}" data-base="consumer" style="border-radius:8px 0 0 8px">سعر الجمهور (خصم)</button>
            </div></div>
          <label class="f" style="margin:0">التقريب<select class="in" id="prRound" style="width:auto">
            <option value="none" ${PR.round === 'none' ? 'selected' : ''}>بدون (رقمين)</option>
            <option value="pound" ${PR.round === 'pound' ? 'selected' : ''}>أقرب جنيه</option>
            <option value="half" ${PR.round === 'half' ? 'selected' : ''}>أقرب 50 قرش</option>
            <option value="quarter" ${PR.round === 'quarter' ? 'selected' : ''}>أقرب 25 قرش</option>
          </select></label>
          <div style="flex:1"></div>
        </div>
        <div class="row" style="gap:10px;flex-wrap:wrap;margin-top:14px">
          ${TIERS.map(t => `<label class="f" style="margin:0;flex:1 1 150px">${t.label} <span class="small muted">(${t.col})</span>
            <div class="row" style="gap:6px;align-items:center"><input class="in n" data-disc="${t.n}" inputmode="decimal" value="${esc(PR.disc[t.n])}" placeholder="0" style="width:90px"><span class="muted">${PR.base === 'cost' ? '% ربح' : '% خصم'}</span></div></label>`).join('')}
        </div>
      </div>

      <div class="row" style="gap:10px;margin-bottom:10px;align-items:center">
        <b>${list.length}</b><span class="muted">صنف للتسعير</span><span style="flex:1"></span>
        <button class="btn" id="prXls" ${list.length ? '' : 'disabled'}>📊 تصدير Excel</button>
        ${canOrgaWrite() && !S.ro ? `<button class="btn s" id="prTest" ${list.length ? '' : 'disabled'}>🧪 جرّب أول 3</button><button class="btn g" id="prSend" ${list.length ? '' : 'disabled'}>⬆ إرسال الكل لأورجا</button><button class="btn s" id="prStat">حالة الإرسال</button>` : ''}
      </div>
      <div class="tw"><table class="t"><thead><tr><th>الكود</th><th>الصنف</th><th class="n">التكلفة</th><th class="n">سعر الجمهور</th>${TIERS.map(t => `<th class="n">${t.label}</th>`).join('')}</tr></thead><tbody id="prBody">
        ${list.length ? list.slice(0, 500).map(p => prRow(p)).join('') : `<tr><td colspan="${4 + TIERS.length}"><div class="empty" style="padding:30px"><b>اختر فاتورة شراء الأول</b>هتظهر أصنافها هنا للتسعير</div></td></tr>`}
      </tbody></table></div>
      ${list.length > 500 ? `<p class="small muted">بيظهر أول 500 صنف — التصدير بيشمل الكل.</p>` : ''}
      <p class="small muted" style="margin-top:10px">الإرسال بيكتب أسعار الشرائح اللي عبّيتها بس (الفاضية مش بتتغير) في أورجا مباشرة. ابدأ بـ«🧪 جرّب أول 3» وتأكد في أورجا إن السعر دخل الشريحة الصح، وبعدين «إرسال الكل». محتاج وكيل إصدار 1.8.0+.</p>
    </div>`;

    // تفاعل
    $$('[data-inv]').forEach(b => b.onclick = () => { const id = b.dataset.inv; PR.inv.has(id) ? PR.inv.delete(id) : PR.inv.add(id); render(); });
    $$('[data-rm]').forEach(b => b.onclick = () => { PR.inv.delete(b.dataset.rm); render(); });
    $$('[data-base]').forEach(b => b.onclick = () => { PR.base = b.dataset.base; render(); });
    const rs = $('#prRound'); if (rs) rs.onchange = e => { PR.round = e.target.value; repaint(); };
    const clr = $('#prClr'); if (clr) clr.onclick = () => { PR.inv.clear(); render(); };
    const addBtn = $('#prAdd'), no = $('#prNo');
    const add = () => { const n = (no.value || '').trim(); if (!n) return; const v = L('invoices').find(x => x.type === 'purchase' && String(x.no) === n); if (!v) { toast('مفيش فاتورة شراء رقم ' + n, 'err'); return; } PR.inv.add(v.id); no.value = ''; render(); };
    if (addBtn) addBtn.onclick = add;
    if (no) no.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
    $$('[data-disc]').forEach(inp => inp.oninput = () => { PR.disc[+inp.dataset.disc] = inp.value; repaint(); });
    const xb = $('#prXls'); if (xb) xb.onclick = exportXls;
    const tb = $('#prTest'); if (tb) tb.onclick = () => sendOrga(3);
    const sb = $('#prSend'); if (sb) sb.onclick = () => sendOrga(0);
    const stb = $('#prStat'); if (stb) stb.onclick = showStatus;
  };

  function buildItems(limit) {
    const items = [];
    for (const p of chosenProds()) {
      if (!(+p.orga > 0)) continue; // لازم كود أورجا (صنف متزامن من أورجا)
      const prices = {};
      for (const t of TIERS) if (String(PR.disc[t.n]).trim() !== '') prices[t.col] = tierPrice(p, t.n);
      if (Object.keys(prices).length) items.push({ prod: +p.orga, prices });
      if (limit && items.length >= limit) break;
    }
    return items;
  }
  async function sendOrga(limit) {
    const tiers = TIERS.filter(t => String(PR.disc[t.n]).trim() !== '');
    if (!tiers.length) { toast('اكتب نسبة شريحة واحدة على الأقل', 'err'); return; }
    const items = buildItems(limit);
    if (!items.length) { toast('مفيش أصناف بكود أورجا', 'err'); return; }
    const names = tiers.map(t => t.label).join('، ');
    const msg = limit
      ? `تجربة: هيتبعت أول <b>${items.length}</b> صنف لأورجا (الشرائح: ${names}).<br>بعد دقيقة افحص صنف منهم في أورجا وتأكد إن السعر دخل الشريحة الصح قبل ما تبعت الكل.`
      : `هيتكتب أسعار <b>${items.length}</b> صنف في أورجا — الشرائح: ${names}.<br>ده بيحدّث الأسعار دي مباشرة في جدول أصناف أورجا. متأكد؟`;
    if (!(await confirmHtml(msg, limit ? 'جرّب' : 'إرسال الكل', !limit))) return;
    try {
      const r = await MZ.post('/api/orga/prices/add', { items });
      toast(`اتضاف ${r.queued} صنف لطابور الأسعار — هيتكتبوا في أورجا خلال دقيقة`, 'ok');
      setTimeout(showStatus, 1800);
    } catch (e) { toast(e.message || 'مقدرتش أبعت', 'err'); }
  }
  async function showStatus() {
    let j = {}; try { const r = await fetch('/api/orga/prices/status', { credentials: 'same-origin', headers: { 'X-Mizan': '1' } }); if (r.ok) j = await r.json(); } catch (e) {}
    const c = j.counts || {};
    modal(`<h2>حالة إرسال الأسعار لأورجا</h2>
      <div class="row" style="gap:12px;flex-wrap:wrap;margin:10px 0">
        <span class="tag">⏳ في الطابور: ${(c.pending || 0) + (c.sending || 0)}</span>
        <span class="tag ok">✓ اتكتبت: ${c.done || 0}</span>
        ${c.error ? `<span class="tag bad">✗ فشلت: ${c.error}</span>` : ''}
      </div>
      ${(j.errors && j.errors.length) ? `<div class="small muted" style="margin-bottom:4px">أمثلة أخطاء:</div><ul class="small" style="margin:0">${j.errors.map(e => `<li>صنف ${esc(e.prod)}: ${esc(e.error)}</li>`).join('')}</ul>` : ''}
      <div class="row" style="margin-top:16px"><button class="btn" id="stRef">تحديث</button><span class="sp"></span><button class="btn" data-close>تمام</button></div>`, true);
    const rf = $('#stRef'); if (rf) rf.onclick = () => { closeModal(); showStatus(); };
  }

  function prRow(p) {
    const cost = costOf(p), cons = consOf(p) || +p.price || 0;
    return `<tr><td class="num">${esc(p.code || '')}</td><td><b>${esc(p.name)}</b></td>
      <td class="n num">${fmt(cost)}</td><td class="n num">${fmt(cons)}</td>
      ${TIERS.map(t => `<td class="n num" data-pc="${p.id}:${t.n}"><b>${fmt(tierPrice(p, t.n))}</b></td>`).join('')}</tr>`;
  }
  function repaint() {
    for (const p of chosenProds()) for (const t of TIERS) { const c = document.querySelector(`[data-pc="${p.id}:${t.n}"]`); if (c) c.innerHTML = `<b>${fmt(tierPrice(p, t.n))}</b>`; }
  }

  function exportXls() {
    const list = chosenProds(); if (!list.length) { toast('مفيش أصناف', 'err'); return; }
    const head = ['كود أورجا', 'الصنف', 'التكلفة', 'سعر الجمهور', ...TIERS.map(t => t.label + ' (' + t.col + ')')];
    const rows = list.map(p => [p.code || p.orga || '', p.name, +costOf(p).toFixed(2), +(consOf(p) || +p.price || 0).toFixed(2), ...TIERS.map(t => tierPrice(p, t.n))]);
    xlsxOut('تسعير_الشرائح_' + today() + '.xlsx', [head, ...rows], 'التسعير');
    toast('اتصدّر ملف التسعير', 'ok');
  }
})();
