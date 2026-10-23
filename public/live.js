/* ميزان — مين شغال دلوقتي (للمالك) + نبضة كل جهاز */
(function () {
  'use strict';
  if (!window.MZ_STANDALONE) return;
  const H = { 'Content-Type': 'application/json', 'X-Mizan': '1' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let sid = ''; try { sid = sessionStorage.getItem('mz.sid') || ''; } catch (e) {}
  if (!sid) { sid = Math.random().toString(36).slice(2) + Date.now().toString(36); try { sessionStorage.setItem('mz.sid', sid); } catch (e) {} }
  let lastInput = Date.now();
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(e => document.addEventListener(e, () => { const was = idle(); lastInput = Date.now(); if (was) beat(); }, { passive: true }));
  const idle = () => document.hidden || Date.now() - lastInput > 3 * 60e3;
  const mobile = () => matchMedia('(max-width: 860px)').matches || matchMedia('(pointer: coarse)').matches;

  // وصف اللي الشخص بيعمله دلوقتي
  function detail() {
    try {
      const h = location.hash || '';
      const pn = id => (typeof partyName === 'function' && id ? partyName(id) : '');
      if (typeof ED !== 'undefined' && ED && ED.inv && document.getElementById('ps')) {
        const T = (typeof TYPES !== 'undefined' && TYPES[ED.inv.type]) || {}; const n = (ED.inv.lines || []).filter(l => l.pid).length;
        return `${T.full || 'فاتورة'}${ED.id ? ' #' + (ED.inv.no || '') : ' جديدة'}${ED.inv.partyId ? ' — ' + pn(ED.inv.partyId) : ''} — ${n} صنف`;
      }
      if (window.MZ_RV && MZ_RV.inv && /^#\/pick/.test(h)) {
        const ls = MZ_RV.lines || []; const done = ls.filter(l => Math.round(l.got * 1000) === Math.round(l.req * 1000)).length;
        return `بيراجع تحضير #${MZ_RV.inv.no} — ${pn(MZ_RV.inv.partyId)} (${done}/${ls.length} صنف)`;
      }
      const m = document.getElementById('modal');
      if (m && m.classList.contains('on')) { const t = m.querySelector('h2'); if (t) return 'فاتح: ' + t.textContent.trim().slice(0, 80); }
    } catch (e) {}
    return '';
  }
  let busy = false;
  async function beat() {
    if (busy) return; busy = true;
    try {
      const t = document.getElementById('title');
      await fetch('/api/presence', { method: 'POST', credentials: 'same-origin', headers: H, keepalive: true,
        body: JSON.stringify({ sid, route: (location.hash || '#/').slice(0, 60), title: t ? t.textContent.trim() : '', detail: detail(), idle: idle(), mobile: mobile() }) });
    } catch (e) {}
    busy = false;
  }
  setInterval(beat, 20e3);
  let hT = null; window.addEventListener('hashchange', () => { clearTimeout(hT); hT = setTimeout(beat, 1200); });
  document.addEventListener('visibilitychange', () => setTimeout(beat, 300));
  window.addEventListener('pagehide', () => { try { fetch('/api/presence', { method: 'POST', credentials: 'same-origin', headers: H, keepalive: true, body: JSON.stringify({ sid, bye: 1 }) }); } catch (e) {} });
  setTimeout(beat, 2500);

  /* ---------- شاشة المالك ---------- */
  const ago = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? 'دلوقتي' : s < 3600 ? `من ${Math.round(s / 60)} د` : `من ${Math.floor(s / 3600)} س ${Math.round((s % 3600) / 60)} د`; };
  const dur = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'أقل من دقيقة' : m < 60 ? m + ' د' : Math.floor(m / 60) + ' س ' + (m % 60) + ' د'; };
  const hm = t => new Date(t).toLocaleTimeString('ar-EG-u-nu-latn', { hour: 'numeric', minute: '2-digit' });
  async function load() { const r = await fetch('/api/presence?sid=' + sid, { credentials: 'same-origin' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
  let isOwner = false, openT = null;
  function pill(n, idleN) {
    let el = document.getElementById('livePill');
    if (!el) {
      const sync = document.getElementById('sync'); if (!sync) return;
      el = document.createElement('button'); el.id = 'livePill'; el.type = 'button'; el.className = 'pqpill';
      el.style.cssText = 'background:var(--brand-soft);color:var(--brand-ink,var(--brand));border:1px solid color-mix(in srgb,var(--brand) 35%,transparent);cursor:pointer';
      el.title = 'مين شغال دلوقتي'; el.onclick = show; sync.insertAdjacentElement('beforebegin', el);
    }
    el.innerHTML = `👥 <b class="num">${n}</b> شغال${idleN ? ` <span class="small" style="opacity:.7">(${idleN} مش نشط)</span>` : ''}`;
  }
  async function refreshPill() { if (!isOwner) return; try { const d = await load(); pill(d.users.length, d.users.filter(u => u.idle).length); } catch (e) {} }
  function draw(d) {
    const box = document.getElementById('liveBox'); if (!box) return false;
    const act = d.users.filter(u => !u.idle).length;
    box.innerHTML = `<p class="small muted" style="margin:0 0 10px">${d.users.length} مستخدم فاتح ميزان دلوقتي — ${act} شغال فعلًا${d.users.length - act ? `، ${d.users.length - act} سايب الشاشة` : ''}. بيتحدّث كل 10 ثواني.</p>
      ${d.users.map(u => `<div class="card" style="padding:10px 12px;margin-bottom:8px;${u.idle ? 'opacity:.72' : ''}">
        <div class="row" style="gap:8px"><span style="width:10px;height:10px;border-radius:50%;background:${u.idle ? '#c9a227' : '#16a34a'};display:inline-block"></span><b>${esc(u.name)}</b>${u.owner ? '<span class="tag">المالك</span>' : ''}<span class="small muted">${u.idle ? 'مش نشط' : 'شغال'}</span><span class="sp"></span><span class="small muted">${u.devices.length > 1 ? u.devices.length + ' أجهزة' : ''}</span></div>
        ${u.devices.map(dv => `<div class="small" style="margin-top:6px;padding-inline-start:18px">${dv.mobile ? '📱' : '💻'} على شاشة <b>${esc(dv.title || dv.route)}</b> <span class="muted">(${dur(dv.routeAt || dv.since)})</span>${dv.detail ? `<div style="margin-top:2px">✏️ ${esc(dv.detail)}</div>` : ''}<div class="muted">فاتح من ${dur(dv.since)}${dv.idle ? ' — آخر حركة ' + ago(dv.seen) : ''}${dv.me ? ' — الجهاز ده' : ''}</div></div>`).join('')}
        ${u.acts.length ? `<div class="small" style="margin-top:8px;padding-inline-start:18px;border-top:1px dashed var(--line);padding-top:6px"><span class="muted">آخر حاجات عملها:</span>${u.acts.map(a => `<div><span class="muted num">${esc(hm(a.at))}</span> — ${esc(a.t)}${a.n > 1 ? ` <span class="muted">×${a.n}</span>` : ''}</div>`).join('')}</div>` : ''}
      </div>`).join('') || '<div class="empty"><b>محدش فاتح ميزان دلوقتي غيرك</b></div>'}
      ${d.recent.length ? `<div class="small muted" style="margin-top:6px"><b>اشتغلوا النهارده وقافلين دلوقتي:</b> ${d.recent.map(r => `${esc(r.name || '')} (آخر حاجة ${esc(hm(r.last.at))}: ${esc(r.last.t)})`).join(' · ')}</div>` : ''}`;
    pill(d.users.length, d.users.filter(u => u.idle).length);
    return true;
  }
  async function show() {
    if (typeof modal !== 'function') return;
    modal('<h2>👥 مين شغال دلوقتي</h2><div id="liveBox" style="max-height:65vh;overflow:auto"><p class="small muted">جارٍ التحميل…</p></div><div class="row" style="margin-top:10px"><span class="sp"></span><button class="btn" data-close>قفل</button></div>', true);
    clearInterval(openT);
    const tick = async () => { try { if (!draw(await load())) clearInterval(openT); } catch (e) { clearInterval(openT); } };
    tick(); openT = setInterval(tick, 10e3);
  }
  window.MZ_LIVE = { show, beat };
  (async () => {
    try { const u = await window.claude.use('user'); isOwner = await u.isOwner(); } catch (e) {}
    if (!isOwner) return;
    refreshPill(); setInterval(refreshPill, 30e3);
    new MutationObserver(() => { if (!document.getElementById('livePill')) refreshPill(); }).observe(document.body, { childList: true, subtree: false });
  })();
})();
