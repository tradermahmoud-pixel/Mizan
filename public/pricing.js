/* ميزان — تسعير الشرائح.
   تختار فواتير (قديمة أو جديدة) → ميزان يجمع أصنافها → تكتب نسبة خصم لكل شريحة →
   يحسب سعر كل شريحة (القيمة مش النسبة) = السعر الأساسي × (1 − الخصم) ويعرضه ويصدّره Excel.
   الإرسال المباشر لأورجا خطوة تانية (محتاج تحديث الوكيل). */
(function () {
  // ترتيب الشرائح حسب أعمدة أورجا PRICE_1..4 (قطاعي = الجمهور، مش بيتغيّر)
  const TIERS = [
    { n: 1, label: 'كبار العملاء', col: 'PRICE_5' },
    { n: 2, label: 'آجل', col: 'PRICE_4' },
    { n: 4, label: 'آجل 15 يوم', col: 'PRICE_3' },
    { n: 3, label: 'صيدلي نقدي', col: 'PRICE_2' },
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

  // ===== مراجعة فروق الأسعار مع أورجا (عرض فقط — بدون إرسال) =====
  let DR = { mk: { 1: '3', 2: '12', 4: '10', 3: '7' }, tol: '1', only: true, stock: false, q: '', group: 'all', costbase: 'orga', sel: new Set() };
  // أساس التكلفة: orga = تكلفة أورجا الرسمية (p.cost) — mizan = متوسط ميزان المحسوب
  const drCost = p => DR.costbase === 'orga' ? (+p.cost || avgCost(p.id) || 0) : (avgCost(p.id) || +p.cost || 0);
  const r2 = v => Math.round((+v || 0) * 100) / 100;
  const colN = c => String(c).split('_')[1];
  const GNAME = { paper: 'ورقيات', supplies: 'مستلزمات', other: 'غير' };
  let PG = null; // خريطة المجموعات { كود أورجا: paper|supplies }
  function loadGroups(cb) {
    if (PG) { cb && cb(); return; }
    fetch('/groups.json', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : {}).then(j => { PG = j || {}; cb && cb(); }).catch(() => { PG = {}; cb && cb(); });
  }
  const groupOf = p => (PG && PG[String(p.code || p.orga || '')]) || 'other';

  function driftRows() {
    const q = (DR.q || '').trim().toLowerCase();
    const tol = Math.max(0, numIn(DR.tol));
    const out = [];
    for (const p of L('products')) {
      if (!(+p.orga > 0) || p.inactive) continue;
      const cost = drCost(p);
      if (!(cost > 0)) continue;
      const bal = (typeof qtyIn === 'function' ? +qtyIn(p.id) : 0) || 0;
      if (DR.stock && !(bal > 0)) continue;
      if (DR.group !== 'all' && groupOf(p) !== DR.group) continue;
      if (q && !(String(p.name || '').toLowerCase().includes(q) || String(p.code || '').includes(q))) continue;
      const pr = p.prices || {};
      const cells = TIERS.map(t => {
        const mk = numIn(DR.mk[t.n]);
        const miz = r2(cost * (1 + mk / 100));
        const orga = +pr[colN(t.col)] || 0;
        const diff = orga > 0 ? r2(miz - orga) : null;
        return { n: t.n, label: t.label, miz, orga, diff };
      });
      const flags = cells.filter(c => c.diff == null || Math.abs(c.diff) > tol).length;
      const maxAbs = Math.max(0, ...cells.filter(c => c.diff != null).map(c => Math.abs(c.diff)));
      out.push({ p, cost, bal, grp: groupOf(p), cells, flags, maxAbs });
    }
    out.sort((a, b) => b.maxAbs - a.maxAbs || String(a.p.name || '').localeCompare(String(b.p.name || ''), 'ar'));
    return out;
  }

  window.vDrift = function () {
    setTitle('مراجعة فروق الأسعار');
    if (PG === null) { $('#view').innerHTML = '<div class="wrap"><div class="card" style="padding:28px;text-align:center" class="muted">بحمّل المجموعات…</div></div>'; loadGroups(() => window.vDrift()); return; }
    const all = driftRows();
    const flagged = all.filter(r => r.flags > 0);
    const list = DR.only ? flagged : all;
    const tol = Math.max(0, numIn(DR.tol));
    const cell = c => {
      if (!(c.orga > 0)) return `<td class="n" style="color:var(--gold)">${fmt(c.miz)}<br><span class="small">مفيش بأورجا</span></td>`;
      const bad = Math.abs(c.diff) > tol;
      const col = bad ? 'var(--danger)' : '#1a7f37';
      const sign = c.diff > 0 ? '+' : '';
      return `<td class="n"><b>${fmt(c.miz)}</b> <span class="muted">/ ${fmt(c.orga)}</span><br><span style="color:${col};font-weight:700">(${sign}${fmt(c.diff)})</span></td>`;
    };
    $('#view').innerHTML = `<div class="wrap">
      <div class="card" style="padding:16px;margin-bottom:12px">
        <h2 style="margin:0 0 4px">مراجعة فروق الأسعار مع أورجا</h2>
        <p class="small muted" style="margin:0 0 12px">بتقارن <b>سعر ميزان المحسوب</b> (متوسط التكلفة × (1 + نسبة الشريحة)) بـ<b>السعر المخزّن في أورجا</b> لكل صنف. للمراجعة بس — <b>مفيش إرسال</b> من الشاشة دي.</p>
        <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
          ${TIERS.map(t => `<label class="f" style="margin:0;flex:0 1 125px">${t.label} % ربح
            <input class="in n" data-mk="${t.n}" inputmode="decimal" value="${esc(DR.mk[t.n])}" style="width:78px"></label>`).join('')}
          <label class="f" style="margin:0;flex:0 1 120px">حد الفرق (جنيه)
            <input class="in n" id="drTol" inputmode="decimal" value="${esc(DR.tol)}" style="width:78px"></label>
          <button class="btn s ${DR.only ? 'p' : ''}" id="drOnly" style="white-space:nowrap">${DR.only ? '✓ اللي فيها فرق بس' : 'عرض الكل'}</button>
          <button class="btn s ${DR.stock ? 'p' : ''}" id="drStock" style="white-space:nowrap">${DR.stock ? '✓ اللي ليه رصيد بس' : 'كل الأرصدة'}</button>
          <label class="f" style="margin:0;flex:0 1 160px">المجموعة<select class="in" id="drGroup">
            <option value="all" ${DR.group === 'all' ? 'selected' : ''}>الكل</option>
            <option value="paper" ${DR.group === 'paper' ? 'selected' : ''}>ورقيات</option>
            <option value="supplies" ${DR.group === 'supplies' ? 'selected' : ''}>مستلزمات</option>
            <option value="other" ${DR.group === 'other' ? 'selected' : ''}>غير</option>
          </select></label>
          <label class="f" style="margin:0;flex:0 1 180px">أساس التكلفة<select class="in" id="drCostBase">
            <option value="orga" ${DR.costbase === 'orga' ? 'selected' : ''}>تكلفة أورجا الرسمية</option>
            <option value="mizan" ${DR.costbase === 'mizan' ? 'selected' : ''}>متوسط ميزان</option>
          </select></label>
        </div>
        <label class="f" style="margin:10px 0 0;max-width:320px">بحث بالاسم أو الكود<input class="in" id="drQ" value="${esc(DR.q)}" placeholder="اكتب ثم Enter"></label>
      </div>
      <div class="row" style="gap:10px;margin-bottom:10px;align-items:center;flex-wrap:wrap">
        <span class="tag bad">${flagged.length} صنف فيه فرق</span>
        <span class="tag">${all.length} إجمالي</span>
        <span class="tag ok" id="drSelN">${DR.sel.size} مختار</span>
        <span style="flex:1"></span>
        <button class="btn" id="drXls" ${list.length ? '' : 'disabled'}>📊 تصدير Excel</button>
        ${canOrgaWrite() && !S.ro ? `<button class="btn s" id="drTest">🧪 جرّب أول 3 من المختار</button><button class="btn g" id="drSend">⬆ إرسال المختار لأورجا</button><button class="btn s" id="drStat">حالة الإرسال</button>` : ''}
      </div>
      <div class="tw"><table class="t"><thead><tr><th style="width:34px"><input type="checkbox" id="drAll" title="اختر كل الظاهر"></th><th>الكود</th><th>الصنف</th><th class="n">الرصيد</th><th class="n">التكلفة</th>${TIERS.map(t => `<th class="n">${t.label}<br><span class="small muted">ميزان / أورجا</span></th>`).join('')}</tr></thead><tbody>
        ${list.length ? list.slice(0, 400).map(r => `<tr><td style="text-align:center"><input type="checkbox" data-sel="${esc(r.p.id)}" ${DR.sel.has(r.p.id) ? 'checked' : ''}></td><td class="num">${esc(r.p.code || r.p.orga || '')}</td><td><b>${esc(r.p.name)}</b>${r.grp !== 'other' ? ` <span style="display:inline-block;width:9px;height:9px;border-radius:50%;vertical-align:middle;background:${r.grp === 'paper' ? '#8e5bd0' : '#e0b400'}" title="${GNAME[r.grp]}"></span>` : ''}</td><td class="n num" style="${r.bal > 0 ? '' : 'color:var(--gold)'}">${fmt(r.bal)}</td><td class="n num">${fmt(r.cost)}</td>${r.cells.map(cell).join('')}</tr>`).join('') : `<tr><td colspan="${5 + TIERS.length}"><div class="empty" style="padding:30px"><b>مفيش نتايج</b>غيّر الفلاتر وجرّب تاني</div></td></tr>`}
      </tbody></table></div>
      ${list.length > 400 ? `<p class="small muted">بيظهر أول 400 — التصدير بيشمل الكل.</p>` : ''}
      <p class="small muted" style="margin-top:10px">التسعير = النسب اللي فوق على <b>متوسط التكلفة</b>. حدّد الأصناف، ابدأ بـ«🧪 جرّب أول 3» وتأكد في أورجا، وبعدين «⬆ إرسال المختار». الإرسال بيكتب الشرائح اللي فيها نسبة بس. محتاج وكيل إصدار 1.8.0+.</p>
    </div>`;
    $$('[data-mk]').forEach(i => { i.oninput = () => { DR.mk[+i.dataset.mk] = i.value; }; i.onchange = () => window.vDrift(); });
    const t = $('#drTol'); if (t) t.onchange = () => { DR.tol = t.value; window.vDrift(); };
    const o = $('#drOnly'); if (o) o.onclick = () => { DR.only = !DR.only; window.vDrift(); };
    const sk = $('#drStock'); if (sk) sk.onclick = () => { DR.stock = !DR.stock; window.vDrift(); };
    const gs = $('#drGroup'); if (gs) gs.onchange = () => { DR.group = gs.value; window.vDrift(); };
    const cb = $('#drCostBase'); if (cb) cb.onchange = () => { DR.costbase = cb.value; window.vDrift(); };
    const q = $('#drQ'); if (q) q.onkeydown = e => { if (e.key === 'Enter') { DR.q = q.value; window.vDrift(); } };
    const xb = $('#drXls'); if (xb) xb.onclick = driftXls;
    const updSel = () => { const n = $('#drSelN'); if (n) n.textContent = DR.sel.size + ' مختار'; };
    $$('[data-sel]').forEach(cb => cb.onchange = () => { cb.checked ? DR.sel.add(cb.dataset.sel) : DR.sel.delete(cb.dataset.sel); updSel(); });
    const allc = $('#drAll'); if (allc) allc.onclick = () => { const on = allc.checked; for (const r of list) on ? DR.sel.add(r.p.id) : DR.sel.delete(r.p.id); window.vDrift(); };
    const tb = $('#drTest'); if (tb) tb.onclick = () => sendDrift(3);
    const sb = $('#drSend'); if (sb) sb.onclick = () => sendDrift(0);
    const stb = $('#drStat'); if (stb) stb.onclick = showStatus;
  };

  async function sendDrift(limit) {
    if (!DR.sel.size) { toast('حدّد أصناف الأول', 'err'); return; }
    const active = TIERS.filter(t => String(DR.mk[t.n]).trim() !== '');
    if (!active.length) { toast('اكتب نسبة شريحة واحدة على الأقل', 'err'); return; }
    const items = []; let skipped = 0;
    for (const id of DR.sel) {
      const p = G('products', id); if (!p) continue;
      const cost = drCost(p);
      if (!(+p.orga > 0) || !(cost > 0)) { skipped++; continue; }
      const prices = {};
      for (const t of active) prices[t.col] = r2(cost * (1 + numIn(DR.mk[t.n]) / 100));
      items.push({ prod: +p.orga, prices });
      if (limit && items.length >= limit) break;
    }
    if (!items.length) { toast('مفيش أصناف صالحة للإرسال (لازم كود أورجا وتكلفة)', 'err'); return; }
    const names = active.map(t => t.label).join('، ');
    const msg = limit
      ? `تجربة: هيتبعت أول <b>${items.length}</b> صنف من المختار لأورجا (الشرائح: ${names}).<br>بعد دقيقة افحص صنف منهم في أورجا وتأكد إن السعر دخل الشريحة الصح قبل ما تبعت الكل.`
      : `هيتكتب أسعار <b>${items.length}</b> صنف مختار في أورجا — الشرائح: ${names}.${skipped ? `<br><span style="color:var(--gold)">(${skipped} صنف اتخطّى لعدم وجود كود أورجا أو تكلفة)</span>` : ''}<br>ده بيحدّث الأسعار دي مباشرة في جدول أصناف أورجا. متأكد؟`;
    if (!(await confirmHtml(msg, limit ? 'جرّب' : 'إرسال المختار', !limit))) return;
    try {
      const r = await MZ.post('/api/orga/prices/add', { items });
      toast(`اتضاف ${r.queued} صنف لطابور الأسعار — هيتكتبوا في أورجا خلال دقيقة`, 'ok');
      setTimeout(showStatus, 1800);
    } catch (e) { toast(e.message || 'مقدرتش أبعت', 'err'); }
  }

  function driftXls() {
    const list = driftRows().filter(r => DR.only ? r.flags > 0 : true);
    if (!list.length) { toast('مفيش بيانات', 'err'); return; }
    const head = ['كود أورجا', 'الصنف', 'المجموعة', 'الرصيد', 'التكلفة'];
    for (const t of TIERS) head.push(t.label + ' ميزان', t.label + ' أورجا', t.label + ' فرق');
    const rows = list.map(r => {
      const base = [r.p.code || r.p.orga || '', r.p.name, GNAME[r.grp] || 'غير', +(+r.bal || 0).toFixed(2), +r.cost.toFixed(2)];
      for (const c of r.cells) base.push(+c.miz.toFixed(2), c.orga > 0 ? +c.orga.toFixed(2) : '', c.diff != null ? +c.diff.toFixed(2) : '');
      return base;
    });
    xlsxOut('فروق_الأسعار_' + today() + '.xlsx', [head, ...rows], 'الفروق');
    toast('اتصدّر ملف الفروق', 'ok');
  }

  // ===== مراجعة أسعار المستهلك الشاذة =====
  let CR = { minMargin: '10', mode: 'all', q: '', stock: false, sugg: '20', sel: new Set(), edit: {} };
  function crRows() {
    const q = (CR.q || '').trim().toLowerCase();
    const minM = numIn(CR.minMargin);
    const out = [];
    for (const p of L('products')) {
      if (!(+p.orga > 0) || p.inactive) continue;
      const cost = drCost(p);
      const cons = consOf(p) || +p.price || 0;
      if (q && !(String(p.name || '').toLowerCase().includes(q) || String(p.code || '').includes(q))) continue;
      let flag = '', sev = 0;
      const margin = cost > 0 ? (cons - cost) / cost * 100 : (cons > 0 ? 999 : -100);
      if (cons <= 0) { flag = 'سالب/صفر'; sev = 3; }
      else if (cost > 0 && cons < cost) { flag = 'تحت التكلفة'; sev = 2; }
      else if (cost > 0 && margin < minM) { flag = 'هامش ضعيف'; sev = 1; }
      if (!flag) continue;
      if (CR.mode === 'neg' && sev !== 3) continue;
      if (CR.mode === 'below' && sev < 2) continue;
      if (CR.mode === 'weak' && sev !== 1) continue;
      if (CR.stock) { const bal = (typeof qtyIn === 'function' ? +qtyIn(p.id) : 0) || 0; if (!(bal > 0)) continue; }
      out.push({ p, cost, cons, margin, flag, sev });
    }
    out.sort((a, b) => b.sev - a.sev || a.margin - b.margin);
    return out;
  }
  const crSugg = r => { const s = numIn(CR.sugg); return r.cost > 0 ? Math.round(r.cost * (1 + s / 100) * 100) / 100 : r.cons; };

  window.vConsRev = function () {
    setTitle('مراجعة أسعار المستهلك');
    const all = crRows();
    const list = all;
    const val = r => { const e = CR.edit[r.p.id]; return e != null && e !== '' ? e : fmt(r.cons); };
    $('#view').innerHTML = `<div class="wrap">
      <div class="card" style="padding:16px;margin-bottom:12px">
        <h2 style="margin:0 0 4px">مراجعة أسعار المستهلك الشاذة</h2>
        <p class="small muted" style="margin:0 0 12px">بتحصر أصناف سعر مستهلكها <b>سالب / صفر / تحت التكلفة / هامشه ضعيف</b>. عدّل القيمة أو اعتمد الحالية، حدّد، وابعت لأورجا (سعر المستهلك).</p>
        <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
          <label class="f" style="margin:0;flex:0 1 150px">نوع الشذوذ<select class="in" id="crMode">
            <option value="all" ${CR.mode === 'all' ? 'selected' : ''}>الكل</option>
            <option value="neg" ${CR.mode === 'neg' ? 'selected' : ''}>سالب / صفر</option>
            <option value="below" ${CR.mode === 'below' ? 'selected' : ''}>تحت التكلفة</option>
            <option value="weak" ${CR.mode === 'weak' ? 'selected' : ''}>هامش ضعيف</option>
          </select></label>
          <label class="f" style="margin:0;flex:0 1 130px">أقل هامش مقبول %<input class="in n" id="crMin" inputmode="decimal" value="${esc(CR.minMargin)}" style="width:80px"></label>
          <label class="f" style="margin:0;flex:0 1 160px">هامش القيمة المقترحة %<input class="in n" id="crSugg" inputmode="decimal" value="${esc(CR.sugg)}" style="width:80px"></label>
          <button class="btn s ${CR.stock ? 'p' : ''}" id="crStock" style="white-space:nowrap">${CR.stock ? '✓ اللي ليه رصيد بس' : 'كل الأرصدة'}</button>
          <button class="btn s" id="crFill" title="يملأ القيم بالمقترح = التكلفة + الهامش">⚡ اقترح للكل</button>
        </div>
        <label class="f" style="margin:10px 0 0;max-width:320px">بحث بالاسم أو الكود<input class="in" id="crQ" value="${esc(CR.q)}" placeholder="اكتب ثم Enter"></label>
      </div>
      <div class="row" style="gap:10px;margin-bottom:10px;align-items:center;flex-wrap:wrap">
        <span class="tag bad">${all.length} صنف شاذ</span>
        <span class="tag ok" id="crSelN">${CR.sel.size} مختار</span>
        <span style="flex:1"></span>
        <button class="btn" id="crXls" ${list.length ? '' : 'disabled'}>📊 تصدير Excel</button>
        ${canOrgaWrite() && !S.ro ? `<button class="btn s" id="crTest">🧪 جرّب أول 3</button><button class="btn g" id="crSend">⬆ إرسال المحدد لأورجا</button><button class="btn s" id="crStat">حالة الإرسال</button>` : ''}
      </div>
      <div class="tw"><table class="t"><thead><tr><th style="width:34px"><input type="checkbox" id="crAll"></th><th>الكود</th><th>الصنف</th><th class="n">التكلفة</th><th class="n">المستهلك الحالي</th><th class="n">الهامش</th><th>الحالة</th><th class="n">القيمة الجديدة</th></tr></thead><tbody>
        ${list.length ? list.slice(0, 400).map(r => `<tr><td style="text-align:center"><input type="checkbox" data-csel="${esc(r.p.id)}" ${CR.sel.has(r.p.id) ? 'checked' : ''}></td><td class="num">${esc(r.p.code || r.p.orga || '')}</td><td><b>${esc(r.p.name)}</b></td><td class="n num">${fmt(r.cost)}</td><td class="n num" style="${r.sev >= 2 ? 'color:var(--danger)' : ''}">${fmt(r.cons)}</td><td class="n num" style="${r.sev >= 2 ? 'color:var(--danger)' : r.sev === 1 ? 'color:var(--gold)' : ''}">${r.cost > 0 ? fmt(r.margin) + '%' : '—'}</td><td><span class="tag ${r.sev >= 2 ? 'bad' : ''}">${r.flag}</span></td><td class="n"><input class="in n" data-cedit="${esc(r.p.id)}" inputmode="decimal" value="${esc(val(r))}" placeholder="${fmt(crSugg(r))}" style="width:90px"></td></tr>`).join('') : `<tr><td colspan="8"><div class="empty" style="padding:30px"><b>مفيش قيم شاذة</b>كل أسعار المستهلك منطقية</div></td></tr>`}
      </tbody></table></div>
      ${list.length > 400 ? `<p class="small muted">بيظهر أول 400 — التصدير بيشمل الكل.</p>` : ''}
      <p class="small muted" style="margin-top:10px">القيمة الجديدة متعبّية بالسعر الحالي — غيّرها لو عايز، أو سيبها (اعتماد). «اقترح للكل» بيحطّ التكلفة + الهامش. الإرسال بيكتب <b>سعر المستهلك</b> في أورجا. محتاج وكيل إصدار 1.9.0+.</p>
    </div>`;
    $$('[data-cedit]').forEach(i => i.oninput = () => { CR.edit[i.dataset.cedit] = i.value; });
    const upd = () => { const n = $('#crSelN'); if (n) n.textContent = CR.sel.size + ' مختار'; };
    $$('[data-csel]').forEach(cb => cb.onchange = () => { cb.checked ? CR.sel.add(cb.dataset.csel) : CR.sel.delete(cb.dataset.csel); upd(); });
    const allc = $('#crAll'); if (allc) allc.onclick = () => { const on = allc.checked; for (const r of list) on ? CR.sel.add(r.p.id) : CR.sel.delete(r.p.id); window.vConsRev(); };
    const md = $('#crMode'); if (md) md.onchange = () => { CR.mode = md.value; window.vConsRev(); };
    const mn = $('#crMin'); if (mn) mn.onchange = () => { CR.minMargin = mn.value; window.vConsRev(); };
    const sg = $('#crSugg'); if (sg) sg.onchange = () => { CR.sugg = sg.value; window.vConsRev(); };
    const sk = $('#crStock'); if (sk) sk.onclick = () => { CR.stock = !CR.stock; window.vConsRev(); };
    const q = $('#crQ'); if (q) q.onkeydown = e => { if (e.key === 'Enter') { CR.q = q.value; window.vConsRev(); } };
    const fill = $('#crFill'); if (fill) fill.onclick = () => { for (const r of list) CR.edit[r.p.id] = String(crSugg(r)); window.vConsRev(); };
    const xb = $('#crXls'); if (xb) xb.onclick = crXls;
    const tb = $('#crTest'); if (tb) tb.onclick = () => crSend(3);
    const sb = $('#crSend'); if (sb) sb.onclick = () => crSend(0);
    const stb = $('#crStat'); if (stb) stb.onclick = showStatus;
  };

  async function crSend(limit) {
    if (!CR.sel.size) { toast('حدّد أصناف الأول', 'err'); return; }
    const items = []; let bad = 0;
    for (const id of CR.sel) {
      const p = G('products', id); if (!p || !(+p.orga > 0)) { bad++; continue; }
      const raw = CR.edit[id]; const v = raw != null && raw !== '' ? numIn(raw) : (consOf(p) || +p.price || 0);
      if (!(v > 0)) { bad++; continue; }
      items.push({ prod: +p.orga, prices: { CONSUMER: Math.round(v * 100) / 100 } });
      if (limit && items.length >= limit) break;
    }
    if (!items.length) { toast('مفيش قيم صالحة (لازم كود أورجا وقيمة أكبر من صفر)', 'err'); return; }
    const msg = limit
      ? `تجربة: هيتبعت سعر المستهلك لأول <b>${items.length}</b> صنف لأورجا.<br>بعد دقيقة افحص صنف وتأكد قبل الكل.`
      : `هيتكتب سعر المستهلك لـ <b>${items.length}</b> صنف مختار في أورجا.${bad ? `<br><span style="color:var(--gold)">(${bad} اتخطّى)</span>` : ''}<br>متأكد؟`;
    if (!(await confirmHtml(msg, limit ? 'جرّب' : 'إرسال', !limit))) return;
    try {
      const r = await MZ.post('/api/orga/prices/add', { items });
      toast(`اتضاف ${r.queued} صنف لطابور الأسعار — هيتكتبوا خلال دقيقة`, 'ok');
      setTimeout(showStatus, 1800);
    } catch (e) { toast(e.message || 'مقدرتش أبعت', 'err'); }
  }

  function crXls() {
    const list = crRows();
    if (!list.length) { toast('مفيش بيانات', 'err'); return; }
    const head = ['كود أورجا', 'الصنف', 'التكلفة', 'المستهلك الحالي', 'الهامش%', 'الحالة', 'المقترح'];
    const rows = list.map(r => [r.p.code || r.p.orga || '', r.p.name, +r.cost.toFixed(2), +r.cons.toFixed(2), r.cost > 0 ? +r.margin.toFixed(1) : '', r.flag, +crSugg(r).toFixed(2)]);
    xlsxOut('أسعار_مستهلك_شاذة_' + today() + '.xlsx', [head, ...rows], 'شاذة');
    toast('اتصدّر الملف', 'ok');
  }

  // ===== مراجعة التكلفة: مقارنة تكلفة أورجا (PRIC_COST) بمتوسط ميزان المحسوب =====
  let CO = { mode: 'all', tol: '5', stock: true, q: '', sel: new Set(), edit: {}, busy: false, showDone: false,
    done: (function () { try { return JSON.parse(localStorage.getItem('mz_costrev_done') || '{}'); } catch (e) { return {}; } })() };
  const coSaveDone = () => { try { localStorage.setItem('mz_costrev_done', JSON.stringify(CO.done)); } catch (e) {} };
  function coRows() {
    const q = (CO.q || '').trim().toLowerCase();
    const tolRaw = numIn(CO.tol);
    const tol = tolRaw > 0 ? tolRaw : 5;   // فاضي/صفر = 5% (مش نفلّج كله)
    const out = [];
    for (const p of L('products')) {
      if (!(+p.orga > 0) || p.inactive) continue;
      if (q && !(String(p.name || '').toLowerCase().includes(q) || String(p.code || '').includes(q))) continue;
      const bal = (typeof qtyIn === 'function' ? +qtyIn(p.id) : 0) || 0;
      if (CO.stock && !(bal > 0)) continue;
      const orga = +p.cost || 0;              // تكلفة أورجا الرسمية (PRIC_COST)
      const miz = +avgCost(p.id) || 0;        // متوسط ميزان المحسوب من حركة المخزون
      const cons = consOf(p) || +p.price || 0;
      const diff = miz - orga;
      const pct = orga > 0 ? (diff / orga * 100) : (miz > 0 ? 999 : 0);
      let flag = '', sev = 0;
      if (orga <= 0 && miz > 0) { flag = 'مفيش تكلفة في أورجا'; sev = 3; }
      else if (miz <= 0 && orga > 0 && bal > 0) { flag = 'مفيش متوسط في ميزان'; sev = 2; }
      else if (orga > 0 && cons > 0 && orga > cons) { flag = 'التكلفة أعلى من المستهلك'; sev = 3; }
      else if (orga > 0 && miz > 0 && Math.abs(diff) > 0.01 && Math.abs(pct) >= tol) { flag = diff > 0 ? 'ميزان أعلى' : 'أورجا أعلى'; sev = 1; }
      if (!flag) continue;
      if (CO.mode === 'nocost' && sev !== 3) continue;
      if (CO.mode === 'diff' && flag.indexOf('أعلى') < 0) continue;
      if (CO.mode === 'overcons' && flag !== 'التكلفة أعلى من المستهلك') continue;
      const isDone = !!CO.done[p.id];
      if (isDone && !CO.showDone) continue;      // اتراجع خلاص — مايظهرش إلا لو طلبت المُراجَع
      out.push({ p, orga, miz, cons, diff, pct, bal, flag, sev, isDone });
    }
    out.sort((a, b) => b.sev - a.sev || Math.abs(b.pct) - Math.abs(a.pct));
    return out;
  }
  const coSugg = r => r.miz > 0 ? Math.round(r.miz * 100) / 100 : r.orga;   // المقترح = متوسط ميزان

  window.vCostRev = function () {
    setTitle('مراجعة التكلفة');
    const all = coRows();
    const list = all;
    const brokenN = coBroken().length;
    const val = r => { const e = CO.edit[r.p.id]; return e != null && e !== '' ? e : fmt(coSugg(r)); };
    $('#view').innerHTML = `<div class="wrap">
      <div class="card" style="padding:16px;margin-bottom:12px">
        <h2 style="margin:0 0 4px">مراجعة التكلفة — أورجا مقابل ميزان</h2>
        <p class="small muted" style="margin:0 0 12px">بتقارن <b>تكلفة أورجا الرسمية</b> (آخر تكلفة) بـ<b>متوسط ميزان المحسوب</b> من حركة المخزون، وتطلّع القيم الشاذة. عدّل القيمة أو اعتمد المقترح (= متوسط ميزان)، حدّد، وابعت لأورجا (بيكتب آخر تكلفة + متوسط التكلفة).</p>
        <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
          <label class="f" style="margin:0;flex:0 1 170px">نوع الشذوذ<select class="in" id="coMode">
            <option value="all" ${CO.mode === 'all' ? 'selected' : ''}>الكل</option>
            <option value="diff" ${CO.mode === 'diff' ? 'selected' : ''}>فرق كبير</option>
            <option value="nocost" ${CO.mode === 'nocost' ? 'selected' : ''}>مفيش تكلفة في أورجا</option>
            <option value="overcons" ${CO.mode === 'overcons' ? 'selected' : ''}>التكلفة أعلى من المستهلك</option>
          </select></label>
          <label class="f" style="margin:0;flex:0 1 140px">حد الفرق %<input class="in n" id="coTol" inputmode="decimal" value="${esc(CO.tol)}" style="width:80px"></label>
          <button class="btn s ${CO.stock ? 'p' : ''}" id="coStock" style="white-space:nowrap">${CO.stock ? '✓ اللي ليه رصيد بس' : 'كل الأرصدة'}</button>
          <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center;flex:1 1 auto"><span class="small muted" style="white-space:nowrap">⚡ اعتمد للكل:</span><button class="btn s" data-cofill="max">الأعلى</button><button class="btn s" data-cofill="min">الأقل</button><button class="btn s" data-cofill="miz">متوسط ميزان</button><button class="btn s" data-cofill="orga">تكلفة أورجا</button></div>
        </div>
        <label class="f" style="margin:10px 0 0;max-width:320px">بحث بالاسم أو الكود<input class="in" id="coQ" value="${esc(CO.q)}" placeholder="اكتب ثم Enter"></label>
      </div>
      <div class="row" style="gap:10px;margin-bottom:10px;align-items:center;flex-wrap:wrap">
        <span class="tag bad">${all.length} صنف شاذ</span>
        <span class="tag ok" id="coSelN">${CO.sel.size} مختار</span>
        ${brokenN && canOrgaWrite() && !S.ro ? `<button class="btn g" id="coFix" title="يصلّح قيمة المخزون للأصناف اللي قيمتها سالبة بتكلفة أورجا">🔧 تسوية قيمة المخزون (${brokenN})</button>` : ''}
        <span style="flex:1"></span>
        <button class="btn" id="coXls" ${list.length ? '' : 'disabled'}>📊 تصدير Excel</button>
        <button class="btn s" id="coMark" title="${CO.showDone ? 'يرجّع المحدد لقائمة الشاذ' : 'يشيل المحدد من قائمة الشاذ (للأصناف اللي راجعتها أو مالهاش حل من ميزان)'}">${CO.showDone ? '↺ رجّع المحدد للشاذ' : '✓ علّم المحدد كمراجَع'}</button>
        <button class="btn s ${CO.showDone ? 'p' : ''}" id="coShowDone">${CO.showDone ? '✓ بيعرض المُراجَع' : 'إظهار المُراجَع' + (Object.keys(CO.done).length ? ' (' + Object.keys(CO.done).length + ')' : '')}</button>
        ${canOrgaWrite() && !S.ro ? `<button class="btn s" id="coTest">🧪 جرّب أول 3</button><button class="btn g" id="coSend">⬆ إرسال المحدد لأورجا</button><button class="btn s" id="coStat">حالة الإرسال</button>` : ''}
      </div>
      <div class="tw"><table class="t"><thead><tr><th style="width:34px"><input type="checkbox" id="coAll"></th><th>الكود</th><th>الصنف</th><th class="n">الرصيد</th><th class="n">تكلفة أورجا</th><th class="n">متوسط ميزان</th><th class="n">الفرق</th><th class="n">%</th><th class="n">المستهلك</th><th>الحالة</th><th class="n">التكلفة الجديدة</th></tr></thead><tbody>
        ${list.length ? list.slice(0, 400).map(r => `<tr><td style="text-align:center"><input type="checkbox" data-osel="${esc(r.p.id)}" ${CO.sel.has(r.p.id) ? 'checked' : ''}></td><td class="num">${esc(r.p.code || r.p.orga || '')}</td><td><b>${esc(r.p.name)}</b></td><td class="n num" style="${r.bal > 0 ? '' : 'color:var(--gold)'}">${fmt(r.bal)}</td><td class="n num">${fmt(r.orga)}</td><td class="n num">${fmt(r.miz)}</td><td class="n num" style="color:${r.diff > 0 ? 'var(--danger)' : r.diff < 0 ? 'var(--gold)' : ''}">${fmt(r.diff)}</td><td class="n num" style="color:${Math.abs(r.pct) >= numIn(CO.tol) ? 'var(--danger)' : ''}">${r.orga > 0 ? (r.pct > 900 ? '—' : fmt(r.pct) + '%') : '—'}</td><td class="n num">${fmt(r.cons)}</td><td><span class="tag ${r.sev >= 3 ? 'bad' : r.sev === 2 ? '' : ''}">${r.flag}</span></td><td class="n"><input class="in n" data-oedit="${esc(r.p.id)}" inputmode="decimal" value="${esc(val(r))}" placeholder="${fmt(coSugg(r))}" style="width:95px"></td></tr>`).join('') : `<tr><td colspan="11"><div class="empty" style="padding:30px"><b>مفيش قيم شاذة</b>التكلفة متطابقة بين أورجا وميزان</div></td></tr>`}
      </tbody></table></div>
      ${list.length > 400 ? `<p class="small muted">بيظهر أول 400 — التصدير بيشمل الكل.</p>` : ''}
      <p class="small muted" style="margin-top:10px">المقترح = <b>متوسط ميزان</b>. الإرسال بيكتب <b>آخر التكلفة + متوسط التكلفة</b>، ويعيد تقييم طبقات المخزون، ويصفّر «خصم مرجح» — فالتكلفة تظهر صح في أورجا. محتاج وكيل <b>1.12.0+</b>.</p>
    </div>`;
    $$('[data-oedit]').forEach(i => i.oninput = () => { CO.edit[i.dataset.oedit] = i.value; });
    const upd = () => { const n = $('#coSelN'); if (n) n.textContent = CO.sel.size + ' مختار'; };
    $$('[data-osel]').forEach(cb => cb.onchange = () => { cb.checked ? CO.sel.add(cb.dataset.osel) : CO.sel.delete(cb.dataset.osel); upd(); });
    const allc = $('#coAll'); if (allc) allc.onclick = () => { const on = allc.checked; for (const r of list) on ? CO.sel.add(r.p.id) : CO.sel.delete(r.p.id); window.vCostRev(); };
    const md = $('#coMode'); if (md) md.onchange = () => { CO.mode = md.value; window.vCostRev(); };
    const tl = $('#coTol'); if (tl) tl.onchange = () => { CO.tol = tl.value; window.vCostRev(); };
    const sk = $('#coStock'); if (sk) sk.onclick = () => { CO.stock = !CO.stock; window.vCostRev(); };
    const q = $('#coQ'); if (q) q.onkeydown = e => { if (e.key === 'Enter') { CO.q = q.value; window.vCostRev(); } };
    $$('[data-cofill]').forEach(b => b.onclick = () => {
      const m = b.dataset.cofill; let n = 0;
      for (const r of list) { const vals = [r.orga, r.miz].filter(x => x > 0); if (!vals.length) continue; let v; if (m === 'miz') v = r.miz > 0 ? r.miz : r.orga; else if (m === 'orga') v = r.orga > 0 ? r.orga : r.miz; else if (m === 'max') v = Math.max(...vals); else v = Math.min(...vals); CO.edit[r.p.id] = String(Math.round(v * 100) / 100); CO.sel.add(r.p.id); n++; }
      toast('اتعبّت واتحدّدت ' + n + ' صنف — راجعها وابعت', 'ok');
      window.vCostRev();
    });
    const xb = $('#coXls'); if (xb) xb.onclick = coXls;
    const mk = $('#coMark'); if (mk) mk.onclick = () => {
      if (!CO.sel.size) { toast('حدّد أصناف الأول', 'err'); return; }
      let n = 0; for (const id of CO.sel) { if (CO.showDone) delete CO.done[id]; else CO.done[id] = Date.now(); n++; } CO.sel.clear(); coSaveDone();
      toast(CO.showDone ? ('رجّعنا ' + n + ' صنف للشاذ') : ('اتعلّم ' + n + ' صنف كمراجَع — اختفوا من القايمة'), 'ok'); window.vCostRev();
    };
    const sd = $('#coShowDone'); if (sd) sd.onclick = () => { CO.showDone = !CO.showDone; window.vCostRev(); };
    const fx = $('#coFix'); if (fx) fx.onclick = coReconcile;
    const tb = $('#coTest'); if (tb) tb.onclick = () => coSend(3);
    const sb = $('#coSend'); if (sb) sb.onclick = () => coSend(0);
    const stb = $('#coStat'); if (stb) stb.onclick = coStatus;
  };

  async function coSend(limit) {
    if (!CO.sel.size) { toast('حدّد أصناف الأول', 'err'); return; }
    const items = []; const sentIds = []; let bad = 0;
    for (const id of CO.sel) {
      const p = G('products', id); if (!p || !(+p.orga > 0)) { bad++; continue; }
      const raw = CO.edit[id]; const v = raw != null && raw !== '' ? numIn(raw) : (+avgCost(p.id) || 0);
      if (!(v > 0)) { bad++; continue; }
      const c = Math.round(v * 100) / 100;
      items.push({ prod: +p.orga, cost: c });   // الوكيل يكتب PRIC_COST+COST_AV ويعيد تقييم المخزون ويصفّر خصم مرجح
      sentIds.push(id);
      if (limit && items.length >= limit) break;
    }
    if (!items.length) { toast('مفيش قيم صالحة (لازم كود أورجا وتكلفة أكبر من صفر)', 'err'); return; }
    const msg = limit
      ? `تجربة: هتتكتب التكلفة لأول <b>${items.length}</b> صنف في أورجا (آخر تكلفة + متوسط + إعادة تقييم المخزون + تصفير خصم مرجح).<br>بعد دقيقة افحص الصنف في أورجا وتأكد قبل الكل.`
      : `هتتكتب التكلفة الجديدة لـ <b>${items.length}</b> صنف في أورجا — تكتب آخر تكلفة + متوسط التكلفة، وتعيد تقييم طبقات المخزون، وتصفّر «خصم مرجح».${bad ? `<br><span style="color:var(--gold)">(${bad} اتخطّى)</span>` : ''}<br><span style="color:var(--danger)">⚠ ده بيغيّر تقييم المخزون في أورجا. محتاج وكيل 1.12.0+.</span><br>متأكد؟`;
    if (!(await confirmHtml(msg, limit ? 'جرّب' : 'إرسال', !limit))) return;
    try {
      const r = await MZ.post('/api/orga/products/edit', { items });
      toast(`اتضاف ${r.queued} صنف لطابور التعديل — هيتكتبوا خلال دقيقة`, 'ok');
      if (!limit) { for (const id of sentIds) CO.done[id] = Date.now(); coSaveDone(); CO.sel.clear(); window.vCostRev(); } // اتبعتوا → يختفوا من الشاذ
      setTimeout(coStatus, 2000);
    } catch (e) { toast(e.message || 'مقدرتش أبعت', 'err'); }
  }

  async function coStatus() {
    try {
      const r = await fetch('/api/orga/products/status', { credentials: 'same-origin', headers: { 'X-Mizan': '1' } });
      const j = await r.json(); const e = (j.edits && j.edits.counts) || {};
      const errs = (j.edits && j.edits.errors) || [];
      const em = errs.length ? '<br><br>أمثلة أخطاء:<br>' + errs.slice(0, 5).map(x => `• كود ${x.prod}: ${esc(x.error)}`).join('<br>') : '';
      await confirmHtml(`<b>حالة تعديلات التكلفة في أورجا:</b><br>في الطابور: ${e.pending || 0}<br>بتتكتب: ${e.sending || 0}<br>اتكتبت: ${e.done || 0}<br>فشلت: ${e.error || 0}${em}`, 'تمام', false);
    } catch (e) { toast('مقدرتش أجيب الحالة', 'err'); }
  }

  // الأصناف اللي قيمة مخزونها في ميزان سالبة/صفر رغم إن ليها رصيد — محتاجة تسوية
  function coBroken() {
    const st = (typeof calc === 'function') ? (calc().stock || {}) : {};
    const out = [];
    for (const p of L('products')) {
      if (!(+p.orga > 0) || p.inactive) continue;
      const s = st[p.id]; if (!s) continue;
      const q = s.qty; if (!(q > 0.0001)) continue;
      const rawAvg = s.value / q;
      if (rawAvg > 0) continue;                 // قيمته سليمة
      const oc = +p.cost || 0; if (!(oc > 0)) continue;   // لازم تكلفة أورجا عشان نسوّي بيها
      out.push({ p, qty: q, rawAvg, oc });
    }
    return out;
  }
  async function coReconcile() {
    const broken = coBroken();
    if (!broken.length) { toast('مفيش أصناف قيمتها سالبة — المخزون سليم', 'ok'); return; }
    const sample = broken.slice(0, 8).map(b => `• ${esc(b.p.name)} — رصيد ${fmt(b.qty)} × تكلفة أورجا ${fmt(b.oc)}`).join('<br>');
    const ok = await confirmHtml(
      `<b>تسوية قيمة المخزون</b><br>فيه <b>${broken.length}</b> صنف قيمتها في ميزان سالبة (اتباعت من غير ما يتسجّل شراء/رصيد أول).<br><br>هنعمل <b>فاتورة تقييم</b> تخلّي قيمة كل صنف = الرصيد × <b>تكلفة أورجا</b> — فالمتوسط يبقى موجب وصح.<br><br>${sample}${broken.length > 8 ? `<br>… و${broken.length - 8} صنف تاني` : ''}<br><br><span style="color:var(--danger)">ده بيغيّر تقييم المخزون في ميزان (مش في أورجا). متأكد؟</span>`,
      'اعمل التسوية', true);
    if (!ok) return;
    const lines = broken.map(b => ({ pid: b.p.id, qty: Math.round(b.qty * 1000) / 1000, price: 0, disc: 0, cost: Math.round(b.oc * 100) / 100 }));
    try {
      await put('invoices', uid(), { type: 'reval', no: 0, date: today(), storeId: (typeof MAIN !== 'undefined' ? MAIN : 1), lines, discount: 0, taxRate: 0, paid: 0, notes: 'تسوية قيمة المخزون مع تكلفة أورجا (' + broken.length + ' صنف)', createdAt: new Date().toISOString(), createdBy: (S.me && S.me.id) || '' });
      toast('اتعملت تسوية لـ ' + broken.length + ' صنف — قيمة المخزون بقت صح', 'ok');
      window.vCostRev();
    } catch (e) { toast('مقدرتش أعمل التسوية: ' + (e && e.message || e), 'err'); }
  }

  function coXls() {
    const list = coRows();
    if (!list.length) { toast('مفيش بيانات', 'err'); return; }
    const head = ['كود أورجا', 'الصنف', 'الرصيد', 'تكلفة أورجا', 'متوسط ميزان', 'الفرق', 'الفرق %', 'المستهلك', 'الحالة', 'المقترح'];
    const rows = list.map(r => [r.p.code || r.p.orga || '', r.p.name, +r.bal.toFixed(2), +r.orga.toFixed(2), +r.miz.toFixed(2), +r.diff.toFixed(2), r.orga > 0 && r.pct <= 900 ? +r.pct.toFixed(1) : '', +r.cons.toFixed(2), r.flag, +coSugg(r).toFixed(2)]);
    xlsxOut('مراجعة_التكلفة_' + today() + '.xlsx', [head, ...rows], 'تكلفة');
    toast('اتصدّر الملف', 'ok');
  }
})();
