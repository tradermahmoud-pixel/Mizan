/* ميزان — كارت «ربط أورجا» في الإعدادات (للمالك بس) */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const H = { 'Content-Type': 'application/json', 'X-Mizan': '1' };
  const ago = t => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'دلوقتي' : m < 60 ? `من ${m} دقيقة` : m < 1440 ? `من ${Math.round(m / 60)} ساعة` : new Date(t).toLocaleString('ar-EG'); };
  const NAMES = { products: 'الأصناف', parties: 'العملاء والموردين', invoices: 'الفواتير', cash: 'الخزينة', safes: 'الخزائن' };
  async function call(p, method) {
    const r = await fetch(p, { method: method || 'GET', credentials: 'same-origin', headers: H });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }
  function stale(s) { return s.active && s.lastAt && Date.now() - s.lastAt > 20 * 60e3; }
  function draw(el, s, token) {
    const st = s.stats || {};
    const state = !s.active ? '<span class="tag">مش مربوط</span>'
      : !s.lastAt ? '<span class="tag purchase">المفتاح جاهز — مستني البرنامج على جهاز أورجا</span>'
      : stale(s) ? `<span class="tag bad">آخر مزامنة ${esc(ago(s.lastAt))} — اتأكد إن جهاز أورجا شغال</span>`
      : `<span class="tag ok">شغال ✓ — آخر مزامنة ${esc(ago(s.lastAt))}</span>`;
    el.innerHTML = `<h3>ربط أورجا</h3>
      <p class="small muted" style="margin-top:0">برنامج صغير على جهاز أورجا بيقرا ملف ORGA.GDB <b>قراءة بس</b> كل 5 دقايق، ويبعت لميزان الأصناف والأسعار والعملاء والموردين والفواتير والخزينة اللي اتغيّرت.
      الاتصال مشفّر (HTTPS) بمفتاح ربط خاص — المفتاح يقدر يكتب بيانات أورجا بس، ومش بيلمس أي حاجة اتعملت في ميزان (المواقع، الشرائح، التحضير، خطوط السير…).</p>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">${state}${s.active ? `<span class="small muted">مفتاح ينتهي بـ <b class="num">${esc(s.hint)}</b> · اتعمل ${esc(ago(s.createdAt))}${s.agent && s.agent.host ? ' · الجهاز: ' + esc(s.agent.host) : ''}</span>` : ''}</div>
      ${s.lastErr ? `<p class="small" style="color:var(--danger)">⚠ ${esc(s.lastErr)}</p>` : ''}
      ${Object.keys(st).length ? `<div class="tw" style="margin-top:10px"><table class="t"><thead><tr><th>البيانات</th><th class="n">اتحدّث (إجمالي)</th><th class="n">اتحذف</th><th>آخر مزامنة</th></tr></thead><tbody>${Object.entries(st).map(([k, v]) => `<tr><td>${esc(NAMES[k] || k)}</td><td class="n num">${v.written || 0}</td><td class="n num">${v.deleted || 0}</td><td class="small">${esc(ago(v.at))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${token ? `<div class="card" style="margin-top:12px;border-color:var(--gold)"><b>مفتاح الربط الجديد</b> — انسخه دلوقتي، <u>مش هيظهر تاني</u>:
        <div class="row" style="margin-top:8px"><input class="in num" id="ogTok" readonly value="${esc(token)}" style="flex:1;direction:ltr"><button class="btn s p" id="ogCp">نسخ</button></div>
        <p class="small muted" style="margin-bottom:0">على جهاز أورجا: شغّل <b>setup.bat</b> والصق المفتاح لما يطلبه. متبعتوش في شات أو واتساب.</p></div>` : ''}
      <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
        <a class="btn s" href="/dl/mizan-orga-agent.zip" download>تحميل برنامج الربط</a>
        <button class="btn s ${s.active ? '' : 'p'}" id="ogNew">${s.active ? 'مفتاح جديد (القديم يبطل)' : 'إنشاء مفتاح ربط'}</button>
        ${s.active ? '<button class="btn s d" id="ogOff">إلغاء الربط</button>' : ''}
        <button class="btn s" id="ogRf">تحديث</button></div>
      ${s.active ? '<div id="ogPurge" style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px"></div>' : ''}`;
    const cp = el.querySelector('#ogCp');
    if (cp) cp.onclick = async () => { const i = el.querySelector('#ogTok'); i.select(); try { await navigator.clipboard.writeText(i.value); } catch (e) { document.execCommand('copy'); } cp.textContent = 'اتنسخ ✓'; };
    el.querySelector('#ogRf').onclick = () => load(el);
    const pz = el.querySelector('#ogPurge');
    if (pz) call('/api/orga/purge').then(p => {
      const done = s.purgedAt ? `<p class="small" style="color:var(--ok)">✓ اتعمل قبل كده ${esc(ago(s.purgedAt))} — ميزان دلوقتي فيه بيانات أورجا بس.</p>` : '';
      pz.innerHTML = `<b>ميزان = أورجا بس</b>
        <p class="small muted" style="margin:4px 0 8px">بيمسح كل الأصناف والعملاء والموردين والفواتير وحركات الخزينة والخزائن اللي <b>مش موجودة في أورجا دلوقتي</b> (اللي اتعملت في ميزان أو اتمسحت من أورجا)، ومعاها التحضير والشنط وخطوط السير والمرتجعات والشيكات بتاعتها.
        المستخدمين والصلاحيات والإعدادات والشرايح والموظفين والـ CRM بيفضلوا. <b style="color:var(--danger)">مفيش رجوع.</b></p>${done}
        ${p.ready ? `<p class="small muted">قايمة أورجا جاهزة (${esc(ago(p.at))}): ${Object.entries(p.n).map(([k, v]) => esc(NAMES[k] || k) + ' ' + v).join(' · ')}</p><button class="btn s d" id="ogPg">امسح كل حاجة مش من أورجا</button>`
          : '<p class="small muted">⏳ مستني أول مزامنة كاملة من البرنامج الجديد (1.2) على جهاز أورجا علشان يبعت قايمة سجلات أورجا.</p>'}`;
      const b = pz.querySelector('#ogPg'); if (!b) return;
      b.onclick = async () => {
        const v = window.prompt('المسح ده مفيش منه رجوع. اكتب: أورجا بس');
        if ((v || '').trim() !== 'أورجا بس') { if (v != null) window.toast('ماتكتبتش صح — المسح اتلغى', 'err'); return; }
        b.disabled = true; b.textContent = 'جارٍ المسح…';
        try {
          const r = await fetch('/api/orga/purge', { method: 'POST', credentials: 'same-origin', headers: H, body: JSON.stringify({ confirm: 'أورجا بس' }) });
          const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
          const R = j.removed || {}; window.toast(`اتمسح: ${R.products || 0} صنف، ${R.parties || 0} عميل/مورد، ${R.invoices || 0} فاتورة، ${R.cash || 0} حركة خزينة`);
          load(el);
        } catch (e) { window.toast(e.message, 'err'); b.disabled = false; b.textContent = 'امسح كل حاجة مش من أورجا'; }
      };
    }).catch(() => {});
    el.querySelector('#ogNew').onclick = async () => {
      if (s.active && !(await window.confirmBox('مفتاح جديد؟ البرنامج اللي على جهاز أورجا هيقف لحد ما تحط المفتاح الجديد فيه (setup.bat).', 'مفتاح جديد', true))) return;
      try { const r = await call('/api/orga/key', 'POST'); draw(el, r, r.token); } catch (e) { window.toast(e.message, 'err'); }
    };
    const off = el.querySelector('#ogOff');
    if (off) off.onclick = async () => {
      if (!(await window.confirmBox('إلغاء الربط؟ ميزان هيرفض أي بيانات من جهاز أورجا لحد ما تعمل مفتاح جديد. البيانات اللي اتنقلت قبل كده بتفضل.', 'إلغاء الربط', true))) return;
      try { draw(el, await call('/api/orga/revoke', 'POST')); window.toast('اتلغى الربط'); } catch (e) { window.toast(e.message, 'err'); }
    };
  }
  async function load(el) {
    try { draw(el, await call('/api/orga/status')); }
    catch (e) { el.innerHTML = `<h3>ربط أورجا</h3><p class="small muted">${esc(e.message)}</p>`; }
  }
  window.MZ_ORGA = { settingsCard: load };
})();
