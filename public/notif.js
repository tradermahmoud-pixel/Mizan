/* ميزان — تنبيه استلام نقدية في الخزينة الرئيسية (شاشة كبيرة + صوت + إشعار المتصفح) */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const H = { 'Content-Type': 'application/json', 'X-Mizan': '1' };
  const money = n => (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const tm = t => new Date(t).toLocaleString('ar-EG-u-nu-latn', { weekday: 'long', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'long' });
  const N = { all: new Map(), shown: null, me: null, queue: [], told: new Set() };
  window.MZ_NOTIF = N;

  const css = `
  #mzN{position:fixed;inset:0;z-index:9999;background:rgba(10,12,10,.62);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(3px)}
  #mzN .box{width:min(520px,100%);background:var(--surface,#fff);color:var(--ink,#111);border-radius:18px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.45);border:3px solid #d4a72c;animation:mzNin .35s ease-out, mzNglow 1.4s ease-in-out infinite}
  #mzN .hd{background:linear-gradient(135deg,#b8860b,#e2b23a);color:#1b1400;padding:16px 18px;display:flex;align-items:center;gap:12px}
  #mzN .hd .ic{font-size:34px;line-height:1;animation:mzNbell 1s ease-in-out infinite}
  #mzN .hd b{display:block;font-size:18px}
  #mzN .hd span{font-size:13px;opacity:.85}
  #mzN .amt{font:800 40px/1.1 var(--display,inherit);text-align:center;padding:18px 12px 6px;color:#0a7a3a;direction:rtl}
  #mzN .amt small{font-size:16px;font-weight:600;color:var(--muted,#666)}
  #mzN table{width:100%;border-collapse:collapse;font-size:15px}
  #mzN td{padding:9px 18px;border-top:1px solid var(--line,#e5e5e5);vertical-align:top}
  #mzN td:first-child{color:var(--muted,#666);width:34%;white-space:nowrap}
  #mzN td:last-child{font-weight:600}
  #mzN .ft{display:flex;gap:8px;align-items:center;padding:14px 18px;border-top:1px solid var(--line,#e5e5e5)}
  #mzN .ft .sp{flex:1}
  #mzN .ok{background:#0a7a3a;color:#fff;border:0;border-radius:10px;padding:11px 22px;font:700 16px inherit;cursor:pointer}
  #mzN .lnk{background:none;border:1px solid var(--line,#ccc);color:inherit;border-radius:10px;padding:10px 14px;cursor:pointer;font:inherit}
  #mzN .cnt{font-size:13px;color:var(--muted,#666)}
  @keyframes mzNin{from{transform:scale(.85);opacity:0}to{transform:none;opacity:1}}
  @keyframes mzNglow{0%,100%{box-shadow:0 20px 60px rgba(0,0,0,.45),0 0 0 0 rgba(226,178,58,.7)}50%{box-shadow:0 20px 60px rgba(0,0,0,.45),0 0 0 14px rgba(226,178,58,0)}}
  @keyframes mzNbell{0%,100%{transform:rotate(0)}20%{transform:rotate(-16deg)}40%{transform:rotate(14deg)}60%{transform:rotate(-8deg)}}`;
  function ensureCss() { if (document.getElementById('mzNcss')) return; const s = document.createElement('style'); s.id = 'mzNcss'; s.textContent = css; document.head.appendChild(s); }

  /* صوت تنبيه (من غير ملفات) */
  let actx = null;
  function chime() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t0 = actx.currentTime;
      [0, 0.18, 0.36, 0.9, 1.08, 1.26].forEach((d, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'triangle'; o.frequency.value = [880, 1175, 1568][i % 3];
        g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.35, t0 + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.3);
        o.connect(g); g.connect(actx.destination); o.start(t0 + d); o.stop(t0 + d + 0.32);
      });
    } catch (e) {}
    try { navigator.vibrate && navigator.vibrate([300, 120, 300, 120, 500]); } catch (e) {}
  }
  // المتصفح بيمنع الصوت قبل أول ضغطة — بنجهّزه مع أول تفاعل، ونطلب إذن الإشعارات
  document.addEventListener('pointerdown', function once() {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) {}
    try { if (window.Notification && Notification.permission === 'default' && N.me && N.isTarget) Notification.requestPermission(); } catch (e) {}
    document.removeEventListener('pointerdown', once);
  });

  let titleT = null; const baseTitle = document.title;
  function flashTitle(on) {
    clearInterval(titleT); if (!on) { document.title = baseTitle; return; }
    let k = 0; titleT = setInterval(() => { document.title = (k++ % 2) ? '💰 استلام نقدية!' : baseTitle; }, 900);
  }

  const pending = () => [...N.all.values()].filter(n => n && N.me && Array.isArray(n.to) && n.to.includes(N.me) && !(n.seen && n.seen[N.me]) && Date.now() - (n.at || 0) < 7 * 864e5).sort((a, b) => a.at - b.at);

  function render() {
    const list = pending();
    const box = document.getElementById('mzN');
    if (!list.length) { if (box) box.remove(); flashTitle(false); N.shown = null; return; }
    const n = list[0];
    if (box && N.shown === n.id) { const c = box.querySelector('.cnt'); if (c) c.textContent = list.length > 1 ? `فيه ${list.length - 1} تنبيه تاني` : ''; return; }
    N.shown = n.id; ensureCss();
    const rows = [
      ['استلمها', esc(n.by || '—')],
      ['الخزينة', esc(n.safeName || n.safe)],
      ['العملية', esc(n.what || '')],
      n.party ? ['من', esc(n.party)] : null,
      n.no ? [n.ref && n.ref.c === 'invoices' ? 'رقم الفاتورة' : 'رقم السند', '<span class="num">' + esc(n.no) + '</span>'] : null,
      n.note ? ['البيان', esc(n.note)] : null,
      ['الوقت', esc(tm(n.at))],
      n.src === 'orga' ? ['المصدر', 'أورجا'] : null,
    ].filter(Boolean);
    const html = `<div class="box" role="alertdialog" aria-live="assertive">
      <div class="hd"><div class="ic">🔔</div><div><b>${n.test ? 'تجربة — ' : ''}استلام نقدية في ${esc(n.safeName || 'الخزينة')}</b><span>تنبيه فوري لكل عملية استلام فلوس</span></div></div>
      <div class="amt">${money(n.amount)} <small>ج.م</small></div>
      <table><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</tbody></table>
      <div class="ft"><button class="ok" id="mzNok">تمام، شفتها ✓</button>${n.ref && !n.test ? '<button class="lnk" id="mzNgo">افتح العملية</button>' : ''}<span class="sp"></span><span class="cnt">${list.length > 1 ? `فيه ${list.length - 1} تنبيه تاني` : ''}</span></div></div>`;
    let el = box; if (!el) { el = document.createElement('div'); el.id = 'mzN'; document.body.appendChild(el); }
    el.innerHTML = html;
    el.querySelector('#mzNok').onclick = () => seen(n.id);
    const go = el.querySelector('#mzNgo');
    if (go) go.onclick = () => { seen(n.id); location.hash = n.ref.c === 'invoices' ? '#/sale/' + n.ref.id : '#/cash'; };
    if (!N.told.has(n.id)) {
      N.told.add(n.id); chime(); flashTitle(true);
      try { if (document.hidden && window.Notification && Notification.permission === 'granted') new Notification('💰 استلام نقدية — ' + money(n.amount) + ' ج.م', { body: `${n.by || ''} • ${n.safeName || ''}${n.party ? ' • ' + n.party : ''}`, tag: n.id, requireInteraction: true }); } catch (e) {}
    }
  }
  async function seen(id) {
    const n = N.all.get(id); if (n) n.seen = { ...(n.seen || {}), [N.me]: Date.now() };
    render();
    try { await fetch('/api/notifs/seen', { method: 'POST', credentials: 'same-origin', headers: H, body: JSON.stringify({ id }) }); } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !pending().length) flashTitle(false); });

  async function start() {
    try {
      const db = await window.claude.use('db'); const u = await window.claude.use('user');
      N.me = await u.id();
      db.collection('notifs').onSnapshot(s => {
        for (const ch of s.docChanges()) { if (ch.type === 'removed') N.all.delete(ch.doc.id); else N.all.set(ch.doc.id, { ...ch.doc.data(), id: ch.doc.id }); }
        N.isTarget = N.isTarget || [...N.all.values()].some(n => n && Array.isArray(n.to) && n.to.includes(N.me));
        render();
      });
    } catch (e) {}
  }
  if (window.MZ_STANDALONE) start(); else window.addEventListener('load', () => window.MZ_STANDALONE && start());

  /* كارت الإعدادات */
  N.settingsCard = async function (el, A) {
    try {
      const r = await fetch('/api/notifs/config', { credentials: 'same-origin' }); const c = await r.json(); if (!r.ok) throw new Error(c.error || 'HTTP ' + r.status);
      el.innerHTML = `<h3>🔔 تنبيه استلام النقدية</h3>
        <p class="small muted" style="margin-top:0">أي حد يستلم فلوس في الخزينة المختارة (سند تحصيل، فاتورة بيع مدفوعة، تحويل داخل، أو حركة جاية من أورجا) بيظهر للناس دول تنبيه كبير بصوت على الشاشة بكل التفاصيل، ويفضل ظاهر لحد ما يدوسوا «شفتها».</p>
        <label class="row small" style="gap:8px;margin-bottom:8px"><input type="checkbox" id="naOn" ${c.off ? '' : 'checked'}> التنبيه شغال</label>
        <div class="grid g2"><div><b class="small">الخزائن المتراقبة</b>${c.safes.map(s => `<label class="row small" style="gap:8px;padding:3px 0"><input type="checkbox" data-nas="${esc(s.id)}" ${c.watch.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div>
        <div><b class="small">يستلم التنبيه</b>${c.users.map(u => `<label class="row small" style="gap:8px;padding:3px 0"><input type="checkbox" data-nau="${esc(u.id)}" ${c.to.includes(u.id) ? 'checked' : ''}> ${esc(u.name)}${u.owner ? ' <span class="tag">المالك</span>' : ''}</label>`).join('')}</div></div>
        <div class="row" style="margin-top:10px;gap:8px"><button class="btn s p" id="naSv">حفظ</button><button class="btn s" id="naT">ابعت تنبيه تجربة</button></div>`;
      el.querySelector('#naSv').onclick = async () => {
        const safes = [...el.querySelectorAll('[data-nas]')].filter(x => x.checked).map(x => x.dataset.nas);
        const users = [...el.querySelectorAll('[data-nau]')].filter(x => x.checked).map(x => x.dataset.nau);
        if (!safes.length || !users.length) { window.toast('اختار خزينة واحدة وشخص واحد على الأقل', 'err'); return; }
        await A.put('settings', 'main', { ...A.settings(), cashAlert: { off: !el.querySelector('#naOn').checked, safes, users } });
        window.toast('اتحفظ');
      };
      el.querySelector('#naT').onclick = async () => {
        const r2 = await fetch('/api/notifs/test', { method: 'POST', credentials: 'same-origin', headers: H, body: '{}' }); const j = await r2.json().catch(() => ({}));
        window.toast(r2.ok ? `اتبعت لـ ${j.to} — هيظهر خلال ثواني` : (j.error || 'فشل'), r2.ok ? '' : 'err');
      };
    } catch (e) { el.innerHTML = `<h3>🔔 تنبيه استلام النقدية</h3><p class="small muted">${esc(e.message)}</p>`; }
  };
})();
