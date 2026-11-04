/* ميزان — حساب صفحة الصيدلية من كارت العميل (للمالك والمدير العام) */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function card(el, partyId, party) {
    const say = (m, bad) => { const s = el.querySelector('#shMsg'); if (s) { s.textContent = m; s.style.color = bad ? 'var(--danger)' : 'var(--ok)'; } };
    const draw = async () => {
      let list;
      try { list = await MZ.api('/api/shop/accounts?partyId=' + encodeURIComponent(partyId)); }
      catch (e) { el.innerHTML = '<span class="small muted">مش قادر أجيب حساب الصيدلية دلوقتي</span>'; return; }
      const a = list[0];
      const noTier = !party.tier ? '<p class="small" style="color:var(--danger);margin:6px 0 0">العميل ده مالوش شريحة أسعار — مش هيقدر يشتري لحد ما تحددها.</p>' : '';
      if (!a) {
        el.innerHTML = `<b>حساب صفحة الصيدلية</b>${noTier}
          <div class="grid g2" style="margin-top:8px"><label class="f">اسم الدخول<input class="in" id="shU" dir="ltr" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
          <label class="f">كلمة المرور<input class="in" id="shP" dir="ltr" autocomplete="new-password"></label></div>
          <div class="row" style="margin-top:8px;gap:8px"><button class="btn s p" type="button" id="shAdd">عمل الحساب</button><span class="small" id="shMsg"></span></div>`;
        el.querySelector('#shAdd').onclick = async () => {
          try { await MZ.post('/api/shop/accounts', { partyId, username: el.querySelector('#shU').value, password: el.querySelector('#shP').value }); await draw(); say('تم عمل الحساب ✓'); }
          catch (e) { say(e.message, true); }
        };
        return;
      }
      el.innerHTML = `<b>حساب صفحة الصيدلية</b> ${a.disabled ? '<span class="tag bad">موقوف</span>' : '<span class="tag ok">شغال</span>'}${noTier}
        <p class="small" style="margin:6px 0">اسم الدخول: <b class="num" dir="ltr">${esc(a.username)}</b></p>
        <div class="row" style="gap:8px;flex-wrap:wrap"><input class="in" id="shP" dir="ltr" autocomplete="new-password" placeholder="كلمة مرور جديدة" style="max-width:190px">
        <button class="btn s" type="button" id="shPw">تغيير كلمة المرور</button><button class="btn s ${a.disabled ? '' : 'd'}" type="button" id="shDs">${a.disabled ? 'تفعيل' : 'إيقاف'}</button><span class="small" id="shMsg"></span></div>`;
      el.querySelector('#shPw').onclick = async () => {
        try { await MZ.patch('/api/users/' + encodeURIComponent(a.id), { password: el.querySelector('#shP').value }); await draw(); say('تم تغيير كلمة المرور ✓'); }
        catch (e) { say(e.message, true); }
      };
      el.querySelector('#shDs').onclick = async () => {
        try { await MZ.patch('/api/users/' + encodeURIComponent(a.id), { disabled: !a.disabled }); await draw(); }
        catch (e) { say(e.message, true); }
      };
    };
    await draw();
  }
  window.MZ_SHOP = { card };
})();
