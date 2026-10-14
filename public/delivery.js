/* ميزان — التوصيل وخطوط السير.
   - لوكيشن لكل صيدلية (لينك جوجل ماب / إحداثيات / موقعي الحالي / اختيار على الخريطة، وبيتعلّم لوحده من أول تسليم).
   - خط سير ذكي لمجموعة أوردرات: أقصر ترتيب (أقرب جار + تحسين 2-opt) من المخزن، بمسافة ووقت وصول متوقّع.
   - شاشة المندوب: المحطة الجاية، ملاحة، وصلت، اتسلّم (وتحصيل)، مشكلة — مع GPS وتنبيه لو سلّم بعيد عن الصيدلية.
   - المدير: خريطة لايف فيها مكان المندوب ومساره، واللي اتسلّم واللي لسه، والوقت المتوقع للخلاص.
   ملحوظة: الـ L في الملف ده هي دالة ميزان؛ مكتبة الخرايط اسمها LF. */
(function () {
  'use strict';
  const D = { tab: 'today', date: '', sel: new Set(), mapView: {}, watch: null, lastSent: null, wake: null, plan: null };
  window.MZ_DLV = D;
  const nowIso = () => new Date().toISOString();
  const who = () => (S.me && S.me.name) || '';
  const isMgr = () => S.isAdmin || can('deliveryManage');
  const isDrv = () => can('delivery');
  const canSee = () => isMgr() || isDrv();
  const SPEED = 22, SERVICE = 8; // كم/ساعة داخل المدينة، ودقايق عند كل صيدلية
  const RFACT = 1.35; // الطريق الفعلي أطول من الخط المستقيم

  /* ---------- أدوات ---------- */
  const rad = x => x * Math.PI / 180;
  function km(a, b) { if (!a || !b) return 0; const R = 6371, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
  const road = (a, b) => km(a, b) * RFACT;
  const okLoc = l => l && isFinite(+l.lat) && isFinite(+l.lng) && Math.abs(+l.lat) <= 90 && Math.abs(+l.lng) <= 180 && !(+l.lat === 0 && +l.lng === 0);
  const pLoc = pid => { const p = pid && G('parties', pid); return p && okLoc(p.loc) ? p.loc : null; };
  const depot = () => { const d = settings().depot; return okLoc(d) ? d : null; };
  const fkm = v => (v < 1 ? Math.round(v * 1000) + ' م' : (Math.round(v * 10) / 10) + ' كم');
  const fmin = m => m < 60 ? Math.round(m) + ' د' : Math.floor(m / 60) + ' س ' + Math.round(m % 60) + ' د';
  const hm = d => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false }).format(d); } catch (e) { return ''; } };
  const ago = iso => { if (!iso) return '—'; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'دلوقتي' : m < 60 ? `من ${m} د` : `من ${Math.floor(m / 60)} س`; };
  const gmaps = l => `https://www.google.com/maps/dir/?api=1&destination=${l.lat},${l.lng}&travelmode=driving`;
  const gmapsPin = l => `https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lng}`;
  function parseLoc(t) {
    t = decodeURIComponent(String(t || '')).replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632).replace(/،/g, ',');
    const pats = [/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, /[?&](?:q|query|ll|destination|center|daddr)=(?:loc:)?(-?\d{1,2}\.\d+),\s*\+?(-?\d{1,3}\.\d+)/, /(-?\d{1,2}\.\d{3,})\s*[, ]\s*\+?(-?\d{1,3}\.\d{3,})/];
    for (const re of pats) { const m = t.match(re); if (m) { const o = { lat: +m[1], lng: +m[2] }; if (okLoc(o)) return o; } }
    return null;
  }
  async function resolveLoc(t) {
    t = String(t || '').trim(); const d = parseLoc(t); if (d) return d;
    const u = (t.match(/https:\/\/\S+/) || [])[0];
    if (u) { const r = await fetch('/api/geo/expand?u=' + encodeURIComponent(u), { credentials: 'same-origin', headers: { 'X-Mizan': '1' } }); const j = await r.json().catch(() => ({})); if (r.ok && okLoc(j)) return { lat: j.lat, lng: j.lng }; throw new Error(j.error || 'مقدرتش أقرا اللينك'); }
    throw new Error('اكتب لينك جوجل ماب أو الإحداثيات (مثلًا 30.0444, 31.2357)');
  }
  function gps(timeout = 9000) {
    return new Promise(res => { if (!navigator.geolocation) return res(null); let done = false; const tm = setTimeout(() => { if (!done) { done = true; res(null); } }, timeout);
      navigator.geolocation.getCurrentPosition(p => { if (done) return; done = true; clearTimeout(tm); res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) }); }, () => { if (done) return; done = true; clearTimeout(tm); res(null); }, { enableHighAccuracy: true, timeout: timeout - 500, maximumAge: 15000 }); });
  }
  async function setPartyLoc(pid, loc, src) {
    const cur = G('parties', pid); if (!cur) return; const d = { ...cur }; delete d.id;
    const old = d.loc; d.loc = { lat: +(+loc.lat).toFixed(6), lng: +(+loc.lng).toFixed(6), ...(loc.acc ? { acc: loc.acc } : {}), src: src || 'manual', at: nowIso(), by: who() };
    await put('parties', pid, d);
    try { await audit('parties', pid, 'اللوكيشن', old ? `${old.lat},${old.lng}` : '', `${d.loc.lat},${d.loc.lng}`, cur.name); } catch (e) {}
  }

  /* ---------- الخرايط ---------- */
  let LFp = null;
  function lf() {
    if (window.__LF) return Promise.resolve(window.__LF); if (LFp) return LFp;
    LFp = (async () => {
      if (!document.getElementById('lfcss')) { const l = document.createElement('link'); l.id = 'lfcss'; l.rel = 'stylesheet'; l.href = '/vendor/leaflet/leaflet.css'; document.head.appendChild(l); }
      const code = await (await fetch('/vendor/leaflet/leaflet.js', { credentials: 'same-origin' })).text();
      const prev = Object.getOwnPropertyDescriptor(window, 'L'); const exp = {}; const mod = { exports: exp };
      new Function('exports', 'module', code)(exp, mod); // بنحمّلها كموديول عشان متلعبش في اسم L بتاع ميزان
      const LF = mod.exports && mod.exports.map ? mod.exports : exp;
      if (prev) Object.defineProperty(window, 'L', prev); else { try { delete window.L; } catch (e) {} }
      LF.Icon.Default.imagePath = '/vendor/leaflet/images/';
      window.__LF = LF; return LF;
    })(); return LFp;
  }
  function baseMap(LF, el, key) {
    const m = LF.map(el, { zoomControl: true, attributionControl: true });
    // مصادر الخرايط المجانية من غير مفتاح. بنجرّب بلاطة واحدة من كل مصدر (fetch بيرجّع رقم الحالة الحقيقي)
    // وبنستخدم أول واحد شغّال، وبنبعت اسم الموقع بس زي ما سياسة OpenStreetMap بتطلب.
    const SRC = D.SRC || (D.SRC = [
      ['https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }, 'https://tile.openstreetmap.org/3/4/3.png'],
      ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors' }, 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/3/3/4'],
      ['https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc', attribution: '© OpenStreetMap contributors, Humanitarian OSM Team' }, 'https://a.tile.openstreetmap.fr/hot/3/4/3.png'],
    ]);
    let layer = null;
    const use = i => { if (layer) m.removeLayer(layer); layer = LF.tileLayer(SRC[i][0], Object.assign({ referrerPolicy: 'strict-origin-when-cross-origin' }, SRC[i][1])).addTo(m); };
    if (D.srcOk == null) {
      use(0);
      (D.srcProbe || (D.srcProbe = (async () => { for (let i = 0; i < SRC.length; i++) { try { const r = await fetch(SRC[i][2], { referrerPolicy: 'strict-origin-when-cross-origin', cache: 'no-store' }); if (r.ok) return i; } catch (e) {} } return 0; })()))
        .then(i => { D.srcOk = i; if (i !== 0) use(i); });
    } else use(D.srcOk);
    const v = key && D.mapView[key]; if (v) m.setView(v.c, v.z); else m.setView([30.0444, 31.2357], 11);
    if (key) m.on('moveend', () => { D.mapView[key] = { c: m.getCenter(), z: m.getZoom(), user: true }; });
    return m;
  }
  const pin = (LF, txt, cls) => LF.divIcon({ className: '', html: `<div class="dv-pin ${cls || ''}">${txt}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });

  /* ---------- نافذة تحديد اللوكيشن ---------- */
  async function locModal(pid, after) {
    const p = G('parties', pid); if (!p) return;
    if (!(isMgr() || isDrv() || can('parties'))) { toast('مالكش صلاحية تعديل اللوكيشن', 'err'); return; }
    const cur = okLoc(p.loc) ? p.loc : null; let pick = cur ? { lat: cur.lat, lng: cur.lng } : null;
    modal(`<h2>📍 لوكيشن ${esc(p.name)}</h2>
      <p class="small muted" style="margin-top:-6px">${p.address ? esc(p.address) + ' — ' : ''}${cur ? `محدد (${cur.src === 'delivery' ? 'اتعلّم من تسليم' : cur.src === 'gps' ? 'من GPS' : 'يدوي'} ${esc(ltm(cur.at))})` : 'مش محدد لسه'}</p>
      <div class="row" style="gap:6px;flex-wrap:nowrap"><input class="in" id="dl_t" dir="ltr" placeholder="الصق لينك جوجل ماب أو 30.0444, 31.2357" style="flex:1"><button class="btn" id="dl_g" type="button">قراءة</button></div>
      <div class="row" style="margin:8px 0;gap:6px"><button class="btn s" id="dl_me" type="button">📡 موقعي الحالي (وأنا في الصيدلية)</button><span class="small muted">أو دوس على الخريطة لتحديد المكان</span></div>
      <div id="dl_map" style="height:300px;border-radius:12px;border:1px solid var(--line)"></div>
      <p class="small" id="dl_s" style="min-height:18px;margin:6px 0 0"></p>
      <div class="row" style="margin-top:10px"><button class="btn p" id="dl_sv" type="button">حفظ اللوكيشن</button><button class="btn" data-close type="button">إلغاء</button><span class="sp"></span>${cur ? `<a class="btn s" target="_blank" rel="noopener" href="${gmapsPin(cur)}">فتح في جوجل ماب</a>` : ''}</div>`, true);
    const msg = (t, bad) => { const e = document.getElementById('dl_s'); if (e) { e.textContent = t; e.style.color = bad ? 'var(--danger)' : 'var(--brand)'; } };
    let map = null, mk = null, LF = null;
    const setPick = (l, zoom) => { pick = { lat: +l.lat, lng: +l.lng, acc: l.acc }; if (map) { if (!mk) mk = LF.marker([pick.lat, pick.lng], { draggable: true }).addTo(map).on('dragend', e => { const ll = e.target.getLatLng(); pick = { lat: ll.lat, lng: ll.lng }; msg(`${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`); }); else mk.setLatLng([pick.lat, pick.lng]); map.setView([pick.lat, pick.lng], zoom || Math.max(map.getZoom(), 16)); } msg(`${pick.lat.toFixed(5)}, ${pick.lng.toFixed(5)}${l.acc ? ` — دقة ${l.acc} م` : ''}`); };
    try { LF = await lf(); const el = document.getElementById('dl_map'); if (el) { map = baseMap(LF, el); const dp = depot(); if (pick) setPick(pick, 16); else if (dp) map.setView([dp.lat, dp.lng], 12); map.on('click', e => setPick({ lat: e.latlng.lat, lng: e.latlng.lng })); setTimeout(() => map.invalidateSize(), 120); } } catch (e) { const el = document.getElementById('dl_map'); if (el) el.innerHTML = '<div class="empty small">الخريطة مش متاحة دلوقتي — استخدم اللينك أو موقعك الحالي</div>'; }
    document.getElementById('dl_g').onclick = async () => { try { msg('بقرا…'); setPick(await resolveLoc(document.getElementById('dl_t').value), 17); } catch (e) { msg(e.message, true); } };
    document.getElementById('dl_t').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('dl_g').click(); } };
    document.getElementById('dl_me').onclick = async () => { msg('بجيب موقعك…'); const g = await gps(); if (!g) { msg('مقدرتش أجيب الموقع — شغّل الـ GPS واسمح للمتصفح', true); return; } setPick(g, 18); if (g.acc > 80) msg(`دقة الموقع ضعيفة (${g.acc} م) — اتأكد على الخريطة`, true); };
    document.getElementById('dl_sv').onclick = async () => { if (!pick) { msg('حدد المكان الأول', true); return; } await setPartyLoc(pid, pick, pick.acc ? 'gps' : 'manual'); closeModal(); toast('اتحفظ لوكيشن ' + p.name); if (after) after(); };
  }
  D.locModal = locModal;

  /* ---------- التخطيط الذكي ---------- */
  function optimize(start, pts, ret) {
    // pts: [{key, loc}] — أقرب جار، وبعدين 2-opt
    const n = pts.length; if (n <= 1) return pts.slice();
    const dist = (a, b) => road(a, b);
    let cur = start || pts[0].loc, left = pts.slice(), out = [];
    if (!start) { out.push(left.shift()); cur = out[0].loc; }
    while (left.length) { let bi = 0, bd = Infinity; left.forEach((p, i) => { const d = dist(cur, p.loc); if (d < bd) { bd = d; bi = i; } }); const p = left.splice(bi, 1)[0]; out.push(p); cur = p.loc; }
    const len = a => { let s = 0, c = start || a[0].loc; for (const p of a) { s += dist(c, p.loc); c = p.loc; } if (ret && start) s += dist(c, start); return s; };
    let best = len(out), improved = true, guard = 0;
    while (improved && guard++ < 60) { improved = false; for (let i = 0; i < out.length - 1; i++) for (let k = i + 1; k < out.length; k++) { const t = out.slice(0, i).concat(out.slice(i, k + 1).reverse(), out.slice(k + 1)); const L2 = len(t); if (L2 + 1e-9 < best) { out = t; best = L2; improved = true; } } }
    return out;
  }
  // المحطة = صيدلية (ممكن فيها أكتر من فاتورة)
  function visits(run) {
    const out = []; for (const st of run.stops || []) { const last = out[out.length - 1]; if (last && last.partyId === st.partyId) last.stops.push(st); else out.push({ partyId: st.partyId, stops: [st] }); }
    out.forEach(v => { const ss = v.stops.map(x => x.status); v.status = ss.every(x => x === 'delivered') ? 'delivered' : ss.some(x => x === 'pending' || x === 'arrived') ? (ss.some(x => x === 'arrived') ? 'arrived' : 'pending') : ss.some(x => x === 'failed') ? 'failed' : 'delivered';
      v.loc = v.stops.map(x => x.loc).find(okLoc) || pLoc(v.partyId); v.cash = v.stops.reduce((a, x) => a + (+x.cash || 0), 0); v.open = ['pending', 'arrived'].includes(v.status); });
    return out;
  }
  function stats(run, fromLive) {
    const vs = visits(run); let c = fromLive && run.live && okLoc(run.live) ? run.live : (okLoc(run.start) ? run.start : depot());
    let kmT = 0, mins = 0; const eta = {};
    for (const v of vs) { if (!v.open || !v.loc) continue; const d = c ? road(c, v.loc) : 0; kmT += d; mins += d / SPEED * 60; const t = new Date(Date.now() + mins * 60000); v.stops.forEach(x => eta[x.invId] = t); mins += SERVICE; c = v.loc; }
    let planned = 0, c2 = okLoc(run.start) ? run.start : depot(); for (const v of vs) { if (!v.loc) continue; if (c2) planned += road(c2, v.loc); c2 = v.loc; } if (run.ret && c2 && okLoc(run.start)) planned += road(c2, run.start);
    const cnt = { pending: 0, arrived: 0, delivered: 0, failed: 0 }; vs.forEach(v => cnt[v.status] = (cnt[v.status] || 0) + 1);
    return { kmLeft: kmT, minLeft: mins, eta, planned, cnt, total: vs.length, invs: (run.stops || []).length, done: cnt.delivered + cnt.failed, cash: vs.reduce((a, v) => a + v.cash, 0), vs };
  }
  const runs = () => L('runs');
  const myRuns = () => runs().filter(r => r.driverId === S.me.id && r.status !== 'done' && r.status !== 'cancel');
  const invOf = id => L('invoices').find(i => i.id === id) || G('invoices', id);
  const inRun = invId => runs().find(r => r.status !== 'cancel' && (r.stops || []).some(s => s.invId === invId));
  function freshRun(id) { const r = G('runs', id); return r ? { ...r, id } : null; }
  async function saveRun(r) { const d = { ...r }; delete d.id; d.upd = nowIso(); await put('runs', r.id, d); }
  async function patchRun(id, fn) { const r = freshRun(id); if (!r) return null; fn(r); await saveRun(r); return r; }

  /* ---------- تتبّع المندوب ---------- */
  function trackTick() {
    const act = myRuns().find(r => r.status === 'active');
    if (!act) { if (D.watch != null) { navigator.geolocation.clearWatch(D.watch); D.watch = null; } return; }
    if (D.watch != null || !navigator.geolocation) return;
    D.watch = navigator.geolocation.watchPosition(async p => {
      const g = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy), at: nowIso(), spd: p.coords.speed != null ? Math.round(p.coords.speed * 3.6) : undefined };
      D.me = g; const ls = D.lastSent; const moved = ls ? km(ls, g) * 1000 : 1e9; const age = ls ? Date.now() - new Date(ls.at) : 1e9;
      if (g.acc > 250 || (moved < 120 && age < 60000) || (moved < 30 && age < 180000)) return;
      D.lastSent = g; const r = myRuns().find(x => x.status === 'active'); if (!r) return;
      try { await patchRun(r.id, x => { x.live = g; x.trail = (x.trail || []).concat([[g.lat, g.lng, Date.now()]]).slice(-400); }); } catch (e) {}
    }, () => {}, { enableHighAccuracy: true, maximumAge: 20000, timeout: 30000 });
  }
  async function wake(on) { try { if (on && 'wakeLock' in navigator) D.wake = await navigator.wakeLock.request('screen'); else if (!on && D.wake) { await D.wake.release(); D.wake = null; } } catch (e) {} }

  /* ---------- الشاشات ---------- */
  const css = `
  .dv-pin{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font:700 13px/1 system-ui;color:#fff;background:#6b7a75;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35)}
  .dv-pin.delivered{background:#118a5c}.dv-pin.failed{background:#c0402c}.dv-pin.arrived{background:#c49a4c}.dv-pin.next{background:#1f6fd1;transform:scale(1.15)}.dv-pin.depot{background:#0a2420;border-radius:8px}
  .dv-pin.me{background:#1f6fd1;width:22px;height:22px;box-shadow:0 0 0 8px rgba(31,111,209,.25)}
  .dv-map{height:420px;border-radius:14px;border:1px solid var(--line);overflow:hidden}
  .dv-stop{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
  .dv-stop .n{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:700;background:var(--surface2,#eef2f0)}
  .dv-stop.delivered{opacity:.7}.dv-stop.delivered .n{background:#118a5c;color:#fff}.dv-stop.failed .n{background:#c0402c;color:#fff}.dv-stop.arrived .n{background:#c49a4c;color:#fff}
  .dv-stop.next{border:2px solid #1f6fd1;box-shadow:0 0 0 4px rgba(31,111,209,.12)}
  .dv-list{display:grid;gap:8px}
  .dv-cur{border:2px solid var(--brand);border-radius:16px;padding:16px;background:var(--surface)}
  .dv-cur h2{margin:2px 0 6px;font:700 24px/1.3 var(--display,inherit)}
  .dv-acts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.dv-acts .btn{padding:14px;font-size:16px;justify-content:center}
  .dv-warn{color:var(--danger);font-weight:600}
  @media (max-width:860px){.dv-map{height:300px}.dv-cur h2{font-size:20px}}`;
  function ensureCss() { if (!document.getElementById('dvcss')) { const s = document.createElement('style'); s.id = 'dvcss'; s.textContent = css; document.head.appendChild(s); } }

  window.vRoutes = function () {
    ensureCss(); setTitle('التوصيل وخطوط السير');
    if (!canSee()) { denied('ليس لديك صلاحية التوصيل'); return; }
    const a = route().a;
    if (a[0] === 'new' && isMgr()) return planView();
    if (a[0]) return runView(a[0]);
    if (!isMgr()) { const mine = myRuns(); if (mine.length === 1) { history.replaceState(null, '', '#/routes/' + mine[0].id); return runView(mine[0].id); } }
    listView();
  };

  function listView() {
    const t = today(); const day = D.date || t;
    const xs = runs().filter(r => (isMgr() || r.driverId === S.me.id) && (r.date === day || (day === t && r.status === 'active'))).sort((a, b) => (a.status === 'active' ? -1 : 0) - (b.status === 'active' ? -1 : 0) || (b.createdAt || '').localeCompare(a.createdAt || ''));
    const noLoc = isMgr() ? pendingOrders(t).filter(i => !pLoc(i.partyId) && i.partyId).length : 0;
    $('#view').innerHTML = `<div class="wrap">
      <div class="row" style="margin-bottom:14px"><input class="in" type="date" id="dvD" value="${esc(day)}" style="width:170px"><span class="sp"></span>${isMgr() ? `<button class="btn" id="dvDepot">${ic('home')}${depot() ? 'موقع المخزن' : 'حدد موقع المخزن'}</button><a class="btn p" href="#/routes/new">${ic('plus')}خط سير جديد</a>` : ''}</div>
      ${isMgr() && !depot() ? `<div class="card" style="margin-bottom:12px;border-color:var(--gold)">حدد موقع المخزن الأول علشان الترتيب يبدأ منه — دوس «حدد موقع المخزن».</div>` : ''}
      ${noLoc ? `<div class="card" style="margin-bottom:12px;border-color:var(--danger)"><b>${noLoc}</b> أوردر النهارده لصيدليات مالهاش لوكيشن — هتظهر لك في «خط سير جديد» تحددها من هناك، أو هتتعلّم لوحدها من أول تسليم.</div>` : ''}
      ${xs.length ? `<div class="grid g2">${xs.map(r => { const s = stats(r, true); return `<a class="card" href="#/routes/${esc(r.id)}" style="color:inherit;text-decoration:none;display:block"><div class="row"><b style="font-size:17px">${esc(r.name || 'خط سير')}</b><span class="sp"></span>${r.status === 'active' ? '<span class="tag purchase">في الطريق</span>' : r.status === 'done' ? '<span class="tag ok">خلص</span>' : '<span class="tag">متجهز</span>'}</div>
        <div class="small muted" style="margin:4px 0 8px">${esc(r.driverName || '')} — ${s.total} محطة — ${fkm(s.planned)}${r.live && r.status === 'active' ? ` — آخر مكان ${ago(r.live.at)}` : ''}</div>
        <div class="rv-prog" style="height:10px;border-radius:99px;background:var(--line);overflow:hidden"><i style="display:block;height:100%;width:${s.total ? Math.round(s.done / s.total * 100) : 0}%;background:var(--brand)"></i></div>
        <div class="row small" style="margin-top:8px;gap:6px"><span class="tag ok">اتسلّم ${s.cnt.delivered}</span><span class="tag">لسه ${s.cnt.pending + s.cnt.arrived}</span>${s.cnt.failed ? `<span class="tag bad">مشكلة ${s.cnt.failed}</span>` : ''}${s.cash ? `<span class="tag purchase">تحصيل ${fmt(s.cash)}</span>` : ''}${r.status === 'active' && s.minLeft ? `<span class="muted">يخلص حوالي ${hm(new Date(Date.now() + s.minLeft * 60000))}</span>` : ''}</div></a>`; }).join('')}</div>` : `<div class="empty card"><b>${isMgr() ? 'مفيش خطوط سير في اليوم ده' : 'مفيش رحلات متسجّلة ليك'}</b>${isMgr() ? '<a href="#/routes/new">اعمل خط سير جديد</a>' : ''}</div>`}</div>`;
    $('#dvD').onchange = e => { D.date = e.target.value; render(); };
    const dp = $('#dvDepot'); if (dp) dp.onclick = depotModal;
  }
  async function depotModal() {
    if (!S.isAdmin) { toast('موقع المخزن بيتحدد من المدير', 'err'); return; }
    const cur = depot(); let pick = cur ? { ...cur } : null;
    modal(`<h2>موقع المخزن (نقطة البداية)</h2><div class="row" style="gap:6px;flex-wrap:nowrap"><input class="in" id="dp_t" dir="ltr" placeholder="لينك جوجل ماب أو إحداثيات" style="flex:1"><button class="btn" id="dp_g" type="button">قراءة</button><button class="btn" id="dp_me" type="button">📡 موقعي</button></div>
      <div id="dp_map" style="height:300px;border-radius:12px;border:1px solid var(--line);margin-top:8px"></div><p class="small" id="dp_s"></p>
      <div class="row"><button class="btn p" id="dp_sv" type="button">حفظ</button><button class="btn" data-close type="button">إلغاء</button></div>`, true);
    let map, mk, LF; const msg = t => { const e = document.getElementById('dp_s'); if (e) e.textContent = t; };
    const setP = (l, z) => { pick = { lat: +l.lat, lng: +l.lng }; if (map) { if (!mk) mk = LF.marker([pick.lat, pick.lng], { draggable: true }).addTo(map).on('dragend', e => { const ll = e.target.getLatLng(); pick = { lat: ll.lat, lng: ll.lng }; }); else mk.setLatLng([pick.lat, pick.lng]); map.setView([pick.lat, pick.lng], z || 16); } msg(`${pick.lat.toFixed(5)}, ${pick.lng.toFixed(5)}`); };
    try { LF = await lf(); map = baseMap(LF, document.getElementById('dp_map')); if (pick) setP(pick); map.on('click', e => setP(e.latlng, map.getZoom())); setTimeout(() => map.invalidateSize(), 120); } catch (e) {}
    document.getElementById('dp_g').onclick = async () => { try { setP(await resolveLoc(document.getElementById('dp_t').value)); } catch (e) { msg(e.message); } };
    document.getElementById('dp_me').onclick = async () => { const g = await gps(); if (g) setP(g, 17); else msg('مقدرتش أجيب الموقع'); };
    document.getElementById('dp_sv').onclick = async () => { if (!pick) return; await put('settings', 'main', { ...settings(), depot: { lat: pick.lat, lng: pick.lng } }); closeModal(); toast('اتحفظ موقع المخزن'); render(); };
  }

  /* ---------- خط سير جديد ---------- */
  function pendingOrders(from) {
    return L('invoices').filter(i => i.type === 'sale' && i.partyId && (i.date || '') >= from && !inRun(i.id));
  }
  function drivers() {
    const roles = L('roles'); const rd = (typeof roleDefs === 'function') ? roleDefs() : {};
    const ids = new Set(L('members').map(m => m.id)); (window.MZ && MZ.users || []).forEach(u => ids.add(u.id));
    const out = [...ids].filter(Boolean).map(id => { const r = roles.find(x => x.id === id); const perms = r && rd[r.role] ? rd[r.role].perms || [] : []; return { id, name: whoName(id), drv: perms.includes('delivery') }; });
    return out.sort((a, b) => (b.drv - a.drv) || a.name.localeCompare(b.name, 'ar'));
  }
  function planView() {
    const P = D.plan || (D.plan = { days: 1, sel: new Set(), ret: false, driver: '', onlyPrep: false });
    const from = addDays(today(), -(P.days - 1));
    let xs = pendingOrders(from); if (P.onlyPrep) xs = xs.filter(i => { const p = G('prints', i.id); return p && p.prepAt; });
    xs.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    const byP = new Map(); xs.forEach(i => { const k = i.partyId; byP.set(k, (byP.get(k) || []).concat([i])); });
    const dv = drivers(); const R = calc();
    const selInv = xs.filter(i => P.sel.has(i.id)); const selParties = [...new Set(selInv.map(i => i.partyId))];
    const missing = selParties.filter(pid => !pLoc(pid));
    $('#view').innerHTML = `<div class="wrap">
      <div class="card"><div class="row"><h3 style="margin:0">خط سير جديد</h3><span class="sp"></span>
        <div class="seg">${[[1, 'أوردرات النهارده'], [2, 'من امبارح'], [3, 'آخر 3 أيام']].map(([d, t]) => `<button data-dvd="${d}" class="${P.days == d ? 'on' : ''}">${t}</button>`).join('')}</div>
        <label class="row small" style="gap:6px"><input type="checkbox" id="dvOP" ${P.onlyPrep ? 'checked' : ''}>اللي اتحضّرت بس</label></div>
        <div class="grid g2" style="margin-top:12px"><label class="f">المندوب<select class="in" id="dvDr">${opts(dv.map(d => [d.id, d.name + (d.drv ? ' — مندوب توصيل' : '')]), P.driver, '— اختار المندوب —')}</select></label>
        <label class="f">اسم الخط (اختياري)<input class="in" id="dvNm" value="${esc(P.name || '')}" placeholder="مثلًا: مدينة نصر والتجمع"></label></div>
        <label class="row small" style="gap:6px;margin-top:8px"><input type="checkbox" id="dvRet" ${P.ret ? 'checked' : ''}>يرجع المخزن في الآخر (بيأثر على الترتيب)</label></div>
      <div class="card" style="margin-top:14px"><div class="row"><h3 style="margin:0">اختار الأوردرات</h3><span class="tag">${xs.length} أوردر — ${byP.size} صيدلية</span><span class="sp"></span><button class="btn s" id="dvAll">اختار الكل اللي ليهم لوكيشن</button><button class="btn s" id="dvNone">إلغاء الاختيار</button></div>
        ${missing.length ? `<p class="dv-warn small" style="margin:10px 0 0">⚠️ ${missing.length} صيدلية مختارة مالهاش لوكيشن — هتتحط في آخر الخط لحد ما تحددها أو تتعلّم من التسليم.</p>` : ''}
        <div class="tw" style="margin-top:10px"><table class="t"><thead><tr><th style="width:30px"><input type="checkbox" id="dvChk"></th><th>الصيدلية</th><th>الأوردرات</th><th class="n">الإجمالي</th><th class="n">الرصيد</th><th>اللوكيشن</th></tr></thead><tbody>
        ${[...byP.entries()].map(([pid, ivs]) => { const l = pLoc(pid); const p = G('parties', pid) || {}; const all = ivs.every(i => P.sel.has(i.id)); return `<tr><td><input type="checkbox" data-dvp="${esc(pid)}" ${all ? 'checked' : ''}></td><td><b>${esc(p.name || '')}</b><div class="small muted">${esc(p.address || '')}</div></td><td class="small">${ivs.map(i => `#${esc(i.no)}${G('prints', i.id) && G('prints', i.id).prepAt ? ' ✓' : ''}`).join(' ')}</td><td class="n">${fmt(ivs.reduce((s, i) => s + ((R.inv[i.id] || {}).total || 0), 0))}</td><td class="n">${fmt(R.party[pid] || 0)}</td><td>${l ? `<button class="btn s" data-dvl="${esc(pid)}" title="تغيير اللوكيشن">📍 محدد — تغيير</button>` : `<button class="btn s p" data-dvl="${esc(pid)}">📍 حدد</button>`}</td></tr>`; }).join('') || '<tr><td colspan="6"><div class="empty"><b>مفيش أوردرات مستنية توصيل</b><span class="small muted">الأوردرات اللي في خط سير تاني مش بتظهر هنا</span></div></td></tr>'}</tbody></table></div></div>
      <div class="card" style="margin-top:14px"><div class="row"><h3 style="margin:0">الترتيب المقترح</h3><span class="sp"></span><button class="btn" id="dvOpt" ${selInv.length ? '' : 'disabled'}>🧠 رتّب أقصر طريق</button><button class="btn p" id="dvSave" ${selInv.length && P.driver ? '' : 'disabled'}>حفظ وإرسال للمندوب</button></div>
        <div id="dvPrev" style="margin-top:12px">${P.order ? prevHTML(P) : `<p class="muted small">اختار الأوردرات والمندوب، ودوس «رتّب أقصر طريق».</p>`}</div>
        <div class="dv-map" id="dvMap" style="margin-top:12px${P.order ? '' : ';display:none'}"></div></div></div>`;
    $$('[data-dvd]').forEach(b => b.onclick = () => { P.days = +b.dataset.dvd; P.order = null; render(); });
    $('#dvOP').onchange = e => { P.onlyPrep = e.target.checked; render(); };
    $('#dvDr').onchange = e => { P.driver = e.target.value; render(); };
    $('#dvNm').oninput = e => { P.name = e.target.value; };
    $('#dvRet').onchange = e => { P.ret = e.target.checked; if (P.order) doOpt(); else render(); };
    $$('[data-dvp]').forEach(c => c.onchange = () => { (byP.get(c.dataset.dvp) || []).forEach(i => c.checked ? P.sel.add(i.id) : P.sel.delete(i.id)); P.order = null; render(); });
    $('#dvChk').onchange = e => { xs.forEach(i => e.target.checked ? P.sel.add(i.id) : P.sel.delete(i.id)); P.order = null; render(); };
    $('#dvAll').onclick = () => { xs.forEach(i => { if (pLoc(i.partyId)) P.sel.add(i.id); }); P.order = null; render(); };
    $('#dvNone').onclick = () => { P.sel.clear(); P.order = null; render(); };
    $$('[data-dvl]').forEach(b => b.onclick = () => locModal(b.dataset.dvl, () => { P.order = null; render(); }));
    const doOpt = () => {
      const sel = xs.filter(i => P.sel.has(i.id)); const groups = new Map(); sel.forEach(i => groups.set(i.partyId, (groups.get(i.partyId) || []).concat([i.id])));
      const withL = [...groups.keys()].filter(pid => pLoc(pid)).map(pid => ({ key: pid, loc: pLoc(pid) })), noL = [...groups.keys()].filter(pid => !pLoc(pid));
      const ord = optimize(depot(), withL, P.ret).map(x => x.key).concat(noL);
      P.order = ord.map(pid => ({ pid, invs: groups.get(pid) })); render();
    };
    $('#dvOpt').onclick = doOpt;
    $$('[data-dvmv]').forEach(b => b.onclick = () => { const [i, d] = b.dataset.dvmv.split(':').map(Number); const j = i + d; if (j < 0 || j >= P.order.length) return; const t = P.order[i]; P.order[i] = P.order[j]; P.order[j] = t; render(); });
    $('#dvSave').onclick = async () => {
      if (!P.order) doOpt();
      const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const stops = []; P.order.forEach(g => g.invs.forEach(invId => stops.push({ invId, partyId: g.pid, status: 'pending', ...(pLoc(g.pid) ? { loc: { lat: pLoc(g.pid).lat, lng: pLoc(g.pid).lng } } : {}) })));
      const run = { id, date: today(), name: P.name || `خط ${whoName(P.driver)} — ${today()}`, driverId: P.driver, driverName: whoName(P.driver), status: 'planned', ret: !!P.ret, start: depot() || null, stops, createdBy: who(), createdAt: nowIso() };
      await saveRun(run); D.plan = null; toast('اتحفظ خط السير واتبعت للمندوب'); go('routes/' + id);
    };
    if (P.order) drawMap('dvMap', 'plan', { start: depot(), ret: P.ret, stops: P.order.map((g, i) => ({ seq: i + 1, loc: pLoc(g.pid), status: 'pending', name: (G('parties', g.pid) || {}).name })) });
  }
  function prevHTML(P) {
    let c = depot(), tot = 0, t = 0; const rows = P.order.map((g, i) => { const l = pLoc(g.pid); let d = null; if (l && c) { d = road(c, l); tot += d; t += d / SPEED * 60 + SERVICE; c = l; } else if (l) c = l; const p = G('parties', g.pid) || {}; return `<div class="dv-stop"><div class="n">${i + 1}</div><div><b>${esc(p.name || '')}</b><div class="small muted">${g.invs.map(id => '#' + esc((invOf(id) || {}).no)).join(' ')} ${d != null ? '— ' + fkm(d) : l ? '' : '— <span class="dv-warn">مالهاش لوكيشن</span>'}</div></div><div class="row" style="gap:4px"><button class="btn ic s" data-dvmv="${i}:-1" title="لفوق">▲</button><button class="btn ic s" data-dvmv="${i}:1" title="لتحت">▼</button></div></div>`; });
    if (P.ret && c && depot()) tot += road(c, depot());
    return `<div class="row small" style="margin-bottom:8px;gap:8px"><span class="tag ok">${P.order.length} محطة</span><span class="tag">حوالي ${fkm(tot)}</span><span class="tag">حوالي ${fmin(t)} بالتسليم</span><span class="muted">(تقدير — الطريق الفعلي ممكن يختلف)</span></div><div class="dv-list">${rows.join('')}</div>`;
  }

  /* ---------- خريطة ---------- */
  async function drawMap(elId, key, o) {
    let LF; try { LF = await lf(); } catch (e) { const el = document.getElementById(elId); if (el) el.innerHTML = '<div class="empty small">الخريطة مش متاحة</div>'; return; }
    const el = document.getElementById(elId); if (!el || el._lf) return; el._lf = 1;
    const m = baseMap(LF, el, key); const pts = [];
    if (okLoc(o.start)) { LF.marker([o.start.lat, o.start.lng], { icon: pin(LF, '🏠', 'depot') }).addTo(m).bindTooltip('المخزن'); pts.push([o.start.lat, o.start.lng]); }
    const line = okLoc(o.start) ? [[o.start.lat, o.start.lng]] : [];
    o.stops.forEach(s => { if (!okLoc(s.loc)) return; const ll = [s.loc.lat, s.loc.lng]; pts.push(ll); line.push(ll); LF.marker(ll, { icon: pin(LF, s.seq, s.next ? 'next' : s.status) }).addTo(m).bindTooltip(`${s.seq}. ${s.name || ''}${s.sub ? ' — ' + s.sub : ''}`); });
    if (o.ret && okLoc(o.start) && line.length > 1) line.push([o.start.lat, o.start.lng]);
    if (line.length > 1) LF.polyline(line, { color: '#0d7a60', weight: 3, opacity: .55, dashArray: '6 6' }).addTo(m);
    if (o.trail && o.trail.length > 1) LF.polyline(o.trail.map(p => [p[0], p[1]]), { color: '#1f6fd1', weight: 4, opacity: .8 }).addTo(m);
    if (o.live && okLoc(o.live)) { LF.marker([o.live.lat, o.live.lng], { icon: pin(LF, '', 'me'), zIndexOffset: 1000 }).addTo(m).bindTooltip(`${o.liveName || 'المندوب'} — ${ago(o.live.at)}`, { permanent: true, direction: 'top', offset: [0, -12] }); pts.push([o.live.lat, o.live.lng]); }
    const v = D.mapView[key]; if (!(v && v.user) && pts.length) { if (pts.length === 1) m.setView(pts[0], 15); else m.fitBounds(pts, { padding: [30, 30] }); }
    setTimeout(() => m.invalidateSize(), 80);
  }

  /* ---------- شاشة الرحلة ---------- */
  function runView(id) {
    const r = freshRun(id); if (!r) { $('#view').innerHTML = '<div class="empty"><b>خط السير مش موجود</b><a href="#/routes">رجوع</a></div>'; return; }
    const mine = r.driverId === S.me.id; if (!isMgr() && !mine) { denied('خط السير ده مش ليك'); return; }
    if (mine && (D.mode || 'drv') === 'drv' && r.status !== 'done') return driverView(r);
    managerView(r);
  }
  function stopRows(r, s0) {
    const R = calc();
    return visits(r).map((v, i) => { const p = G('parties', v.partyId) || {}; const next = s0 && v.stops.includes(s0); const l = v.loc; const f = v.stops[0]; const tot = v.stops.reduce((a, x) => a + ((R.inv[x.invId] || {}).total || 0), 0);
      const fail = v.stops.find(x => x.status === 'failed'); const dl = v.stops.find(x => x.status === 'delivered'); const far = v.stops.map(x => x.far).find(Boolean); const note = v.stops.map(x => x.note).find(Boolean);
      const unposted = isMgr() && can('cash') ? v.stops.filter(x => x.cash && !L('cash').some(c => c.ref === 'run:' + r.id + ':' + x.invId)) : [];
      return `<div class="dv-stop ${v.status} ${next ? 'next' : ''}"><div class="n">${i + 1}</div><div style="min-width:0"><b>${esc(p.name || '')}</b> <span class="small muted">${v.stops.map(x => '#' + esc((invOf(x.invId) || {}).no)).join(' ')} — ${fmt(tot)}</span>
        <div class="small ${v.status === 'failed' ? 'dv-warn' : 'muted'}">${v.status === 'delivered' ? `✓ اتسلّم ${esc(hm(new Date(dl.at)))}${v.cash ? ` — حصّل ${fmt(v.cash)}` : ''}${far ? ` — <span class="dv-warn">اتسجّل على بعد ${fkm(far)} من الصيدلية</span>` : ''}${note ? ' — ' + esc(note) : ''}` : v.status === 'failed' ? `✕ ${esc(fail.reason || 'مشكلة')} ${esc(hm(new Date(fail.at)))}${fail.note ? ' — ' + esc(fail.note) : ''}` : v.status === 'arrived' ? `وصل ${esc(hm(new Date(v.stops.find(x => x.arrivedAt).arrivedAt)))} — مستني التسليم` : (l ? '' : '<span class="dv-warn">مالهاش لوكيشن</span>')}${v.open && D._eta && D._eta[f.invId] ? ` — متوقع ${hm(D._eta[f.invId])}` : ''}${f.postponed ? ' — اتأجلت ' + f.postponed + ' مرة' : ''}</div></div>
        <div class="row" style="gap:4px">${l ? `<a class="btn ic s" target="_blank" rel="noopener" href="${gmaps(l)}" title="ملاحة">🧭</a>` : ''}${p.phone ? `<a class="btn ic s" href="tel:${esc(p.phone)}" title="اتصال">📞</a>` : ''}${unposted.map(x => `<button class="btn s" data-dvcash="${esc(x.invId)}">سجّل التحصيل ${fmt(x.cash)}</button>`).join('')}</div></div>`; }).join('');
  }
  const markers = (r, cur) => visits(r).map((v, i) => ({ seq: i + 1, loc: v.loc, status: v.status, next: cur && v.stops.includes(cur), name: (G('parties', v.partyId) || {}).name, sub: v.status === 'delivered' ? 'اتسلّم ' + hm(new Date(v.stops.find(x => x.at).at)) : v.status === 'failed' ? (v.stops.find(x => x.reason) || {}).reason : '' }));
  function managerView(r) {
    const s = stats(r, true); D._eta = s.eta; const nxt = (r.stops || []).find(x => ['pending', 'arrived'].includes(x.status));
    const live = r.live && okLoc(r.live) ? r.live : null; const stale = live && Date.now() - new Date(live.at) > 10 * 60000;
    $('#view').innerHTML = `<div class="wrap">
      <div class="row" style="margin-bottom:12px"><a href="#/routes" class="btn s">→ خطوط السير</a><span class="sp"></span>${r.driverId === S.me.id && r.status !== 'done' ? `<button class="btn s" id="dvMode">وضع المندوب</button>` : ''}${isMgr() && r.status !== 'done' ? `<button class="btn s" id="dvReopt">🧠 أعد ترتيب الباقي</button><button class="btn s" id="dvClose">قفل الخط</button>` : ''}${isMgr() ? `<button class="btn s" id="dvDel">حذف</button>` : ''}</div>
      <div class="card"><div class="row"><div style="flex:1;min-width:220px"><div class="small muted">${esc(r.date)} — المندوب: <b>${esc(r.driverName || '')}</b> — ${r.status === 'active' ? 'في الطريق' : r.status === 'done' ? 'خلص' : 'لسه مبدأش'}</div><h2 style="margin:4px 0">${esc(r.name || '')}</h2></div>
        <div class="row" style="gap:6px"><span class="tag ok">اتسلّم ${s.cnt.delivered}</span><span class="tag">لسه ${s.cnt.pending + s.cnt.arrived}</span>${s.cnt.failed ? `<span class="tag bad">مشكلة ${s.cnt.failed}</span>` : ''}${s.cash ? `<span class="tag purchase">تحصيل ${fmt(s.cash)}</span>` : ''}</div></div>
        <div class="rv-prog" style="height:12px;border-radius:99px;background:var(--line);overflow:hidden;margin-top:8px"><i style="display:block;height:100%;width:${s.total ? Math.round(s.done / s.total * 100) : 0}%;background:var(--brand)"></i></div>
        <div class="row small" style="margin-top:8px;gap:12px"><span>📍 ${live ? `آخر مكان للمندوب ${ago(live.at)}${live.spd != null ? ` — ${live.spd} كم/س` : ''}` : 'لسه مفيش مكان للمندوب'}</span>${stale && r.status === 'active' ? '<span class="dv-warn">مفيش تحديث من أكتر من 10 دقايق — ممكن الموبايل قفل البرنامج</span>' : ''}${nxt ? `<span>المحطة الجاية: <b>${esc((G('parties', nxt.partyId) || {}).name || '')}</b>${s.eta[nxt.invId] ? ' — متوقع ' + hm(s.eta[nxt.invId]) : ''}</span>` : ''}${s.minLeft && r.status === 'active' ? `<span>يخلص حوالي <b>${hm(new Date(Date.now() + s.minLeft * 60000))}</b> (${fkm(s.kmLeft)} باقيين)</span>` : `<span>المسافة المخططة ${fkm(s.planned)}</span>`}</div></div>
      <div class="grid g2" style="margin-top:14px;align-items:start"><div class="dv-map" id="dvMap" style="position:sticky;top:80px"></div><div class="dv-list">${stopRows(r, nxt)}</div></div></div>`;
    drawMap('dvMap', 'run:' + r.id, { start: r.start, ret: r.ret, live, liveName: r.driverName, trail: r.trail, stops: markers(r, nxt) });
    const md = $('#dvMode'); if (md) md.onclick = () => { D.mode = 'drv'; render(); };
    const ro = $('#dvReopt'); if (ro) ro.onclick = async () => { await reopt(r.id, live); toast('اترتّب الباقي من آخر مكان للمندوب'); };
    const cl = $('#dvClose'); if (cl) cl.onclick = async () => { if (!(await confirmBox('قفل خط السير؟ الأوردرات اللي لسه هترجع تبان في «خط سير جديد».', 'قفل'))) return; await patchRun(r.id, x => { x.status = 'done'; x.endAt = nowIso(); x.stops = x.stops.filter(s => s.status !== 'pending'); }); render(); };
    const dl = $('#dvDel'); if (dl) dl.onclick = async () => { if (!(await confirmBox('حذف خط السير نهائيًا؟', 'حذف', true))) return; await del('runs', r.id); go('routes'); };
    $$('[data-dvcash]').forEach(b => b.onclick = () => { const st = r.stops.find(x => x.invId === b.dataset.dvcash); cashModal({ kind: 'in', category: 'تحصيل من عميل', amount: st.cash, partyId: st.partyId, note: `تحصيل ${r.driverName || 'المندوب'} — فاتورة #${(invOf(st.invId) || {}).no}`, ref: 'run:' + r.id + ':' + st.invId }); });
  }
  async function reopt(id, from) {
    await patchRun(id, x => {
      const done = x.stops.filter(s => !['pending', 'arrived'].includes(s.status)), left = x.stops.filter(s => ['pending', 'arrived'].includes(s.status));
      const groups = new Map(); left.forEach(s => groups.set(s.partyId, (groups.get(s.partyId) || []).concat([s])));
      const wl = [...groups.keys()].filter(p => pLoc(p) || groups.get(p)[0].loc).map(p => ({ key: p, loc: pLoc(p) || groups.get(p)[0].loc })), nl = [...groups.keys()].filter(p => !(pLoc(p) || groups.get(p)[0].loc));
      const ord = optimize(okLoc(from) ? from : (okLoc(x.start) ? x.start : null), wl, x.ret).map(o => o.key).concat(nl);
      x.stops = done.concat(ord.flatMap(p => groups.get(p)));
    });
  }

  /* ---------- وضع المندوب ---------- */
  function driverView(r) {
    const s = stats(r, true); D._eta = s.eta;
    const cur = (r.stops || []).find(x => ['pending', 'arrived'].includes(x.status));
    const R = calc();
    let curHTML = '';
    if (r.status === 'planned') curHTML = `<div class="dv-cur"><div class="small muted">${s.total} محطة — حوالي ${fkm(s.planned)}</div><h2>${esc(r.name || '')}</h2><p class="small muted">أول ما تتحرك دوس «ابدأ الرحلة» — مكانك هيتبعت للمدير طول ما البرنامج مفتوح.</p><div class="dv-acts"><button class="btn p" id="dvStart" style="grid-column:1/-1">🚚 ابدأ الرحلة</button></div></div>`;
    else if (cur) {
      const inv = invOf(cur.invId) || {}; const p = G('parties', cur.partyId) || {}; const l = okLoc(cur.loc) ? cur.loc : pLoc(cur.partyId);
      const same = (r.stops || []).filter(x => x.partyId === cur.partyId && ['pending', 'arrived'].includes(x.status));
      const tot = same.reduce((a, x) => a + ((R.inv[x.invId] || {}).total || 0), 0); const bal = R.party[cur.partyId] || 0;
      const dHere = D.me && l ? km(D.me, l) : null;
      curHTML = `<div class="dv-cur"><div class="small muted">المحطة ${s.vs.findIndex(v => v.stops.includes(cur)) + 1} من ${s.total}${s.eta[cur.invId] ? ' — متوقع ' + hm(s.eta[cur.invId]) : ''}${dHere != null ? ' — على بعد ' + fkm(dHere * RFACT) : ''}</div>
        <h2>${esc(p.name || '')}</h2><div class="small">${esc(p.address || '')}</div>
        <div class="row small" style="margin-top:8px;gap:6px"><span class="tag">${same.map(x => '#' + esc((invOf(x.invId) || {}).no)).join(' ')}</span><span class="tag purchase">الفواتير ${fmt(tot)}</span><span class="tag ${bal > 0 ? 'bad' : 'ok'}">رصيده ${fmt(bal)}</span></div>
        <div class="dv-acts">${l ? `<a class="btn" target="_blank" rel="noopener" href="${gmaps(l)}">🧭 الملاحة</a>` : `<button class="btn" id="dvSetL">📍 حدد اللوكيشن</button>`}${p.phone ? `<a class="btn" href="tel:${esc(p.phone)}">📞 اتصال</a>` : '<span></span>'}
          ${cur.status === 'pending' ? `<button class="btn" id="dvArr" style="grid-column:1/-1">📍 وصلت</button>` : ''}
          <button class="btn p" id="dvDone">✓ اتسلّم</button><button class="btn d" id="dvFail">✕ مشكلة</button></div></div>`;
    } else curHTML = `<div class="dv-cur" style="border-color:var(--brand)"><h2>🎉 خلّصت كل المحطات</h2><p>اتسلّم ${s.cnt.delivered}${s.cnt.failed ? ` — فيه ${s.cnt.failed} مشكلة` : ''}${s.cash ? ` — حصّلت ${fmt(s.cash)}` : ''}.</p><div class="dv-acts"><button class="btn p" id="dvEnd" style="grid-column:1/-1">إنهاء الرحلة</button></div></div>`;
    $('#view').innerHTML = `<div class="wrap" style="max-width:760px">
      <div class="row" style="margin-bottom:10px"><b>${esc(r.name || '')}</b><span class="sp"></span>${isMgr() ? `<button class="btn s" id="dvMode">وضع المدير</button>` : ''}</div>
      <div class="rv-prog" style="height:10px;border-radius:99px;background:var(--line);overflow:hidden;margin-bottom:12px"><i style="display:block;height:100%;width:${s.total ? Math.round(s.done / s.total * 100) : 0}%;background:var(--brand)"></i></div>
      ${curHTML}
      ${r.status === 'active' ? `<div class="row small muted" style="margin:8px 0">📡 ${D.watch != null ? 'مكانك بيتبعت للمدير' : 'مستني إذن الموقع…'} — خلي الشاشة دي مفتوحة وانت ماشي. <span class="sp"></span><button class="btn s" id="dvReopt2">🧠 رتّب الباقي من مكاني</button></div>` : ''}
      <div class="dv-map" id="dvMap" style="margin:12px 0"></div>
      <div class="dv-list">${stopRows(r, cur)}</div></div>`;
    drawMap('dvMap', 'drv:' + r.id, { start: r.start, ret: r.ret, live: D.me || r.live, liveName: 'انت', stops: markers(r, cur) });
    const md = $('#dvMode'); if (md) md.onclick = () => { D.mode = 'mgr'; render(); };
    const st = $('#dvStart'); if (st) st.onclick = async () => { const g = await gps(); await patchRun(r.id, x => { x.status = 'active'; x.startAt = nowIso(); if (g) { x.live = { ...g, at: nowIso() }; x.trail = [[g.lat, g.lng, Date.now()]]; } }); wake(true); trackTick(); toast('بالتوفيق 🚚 — مكانك بيتبعت للمدير'); };
    const ro = $('#dvReopt2'); if (ro) ro.onclick = async () => { const g = D.me || await gps(); await reopt(r.id, g); toast('اترتّب الباقي من مكانك'); };
    const sl = $('#dvSetL'); if (sl) sl.onclick = () => locModal(cur.partyId, () => render());
    const ar = $('#dvArr'); if (ar) ar.onclick = async () => { const g = await gps(); await patchRun(r.id, x => { x.stops.filter(y => y.partyId === cur.partyId && y.status === 'pending').forEach(y => { y.status = 'arrived'; y.arrivedAt = nowIso(); if (g) y.arrGps = g; }); if (g) x.live = { ...g, at: nowIso() }; }); };
    const dn = $('#dvDone'); if (dn) dn.onclick = () => deliverModal(r, cur);
    const fl = $('#dvFail'); if (fl) fl.onclick = () => failModal(r, cur);
    const en = $('#dvEnd'); if (en) en.onclick = async () => { await patchRun(r.id, x => { x.status = 'done'; x.endAt = nowIso(); }); wake(false); trackTick(); toast('الرحلة خلصت — شكرًا 🌿'); go('routes'); };
  }
  function deliverModal(r, cur) {
    const p = G('parties', cur.partyId) || {}; const same = r.stops.filter(x => x.partyId === cur.partyId && ['pending', 'arrived'].includes(x.status));
    modal(`<h2>تسليم ${esc(p.name || '')}</h2><p class="small muted" style="margin-top:-6px">${same.map(x => '#' + esc((invOf(x.invId) || {}).no)).join(' ')}</p>
      <label class="f">حصّلت كام؟ (سيبها فاضية لو مفيش)<input class="in n" id="dv_c" inputmode="decimal" placeholder="0"></label>
      <label class="f" style="margin-top:8px">ملاحظة<input class="in" id="dv_n" placeholder="مثلًا: استلم د. أحمد"></label>
      <p class="small" id="dv_s" style="min-height:18px"></p>
      <div class="row"><button class="btn p" id="dv_ok">تأكيد التسليم</button><button class="btn" data-close>رجوع</button></div>`);
    document.getElementById('dv_ok').onclick = async () => {
      const b = document.getElementById('dv_ok'); b.disabled = true; document.getElementById('dv_s').textContent = 'بسجّل مكانك…';
      const g = await gps(); const cash = numIn(document.getElementById('dv_c').value) || 0; const note = document.getElementById('dv_n').value.trim();
      const pl = pLoc(cur.partyId); let far = null; if (g && pl) { const d = km(g, pl); if (d > 0.4) far = Math.round(d * 100) / 100; }
      await patchRun(r.id, x => { let first = true; x.stops.filter(y => y.partyId === cur.partyId && ['pending', 'arrived'].includes(y.status)).forEach(y => { y.status = 'delivered'; y.at = nowIso(); if (g) y.gps = g; if (far) y.far = far; if (first && cash) y.cash = cash; if (note) y.note = note; first = false; }); if (g) { x.live = { ...g, at: nowIso() }; x.trail = (x.trail || []).concat([[g.lat, g.lng, Date.now()]]).slice(-400); } if (!x.stops.some(y => ['pending', 'arrived'].includes(y.status))) x.allDoneAt = nowIso(); });
      closeModal();
      if (g && !pl && g.acc <= 120) { await setPartyLoc(cur.partyId, g, 'delivery'); toast(`اتسلّم ✓ — واتحفظ لوكيشن ${p.name} من مكانك للمرات الجاية`); }
      else toast(far ? `اتسلّم ✓ — ملحوظة: انت على بعد ${fkm(far)} من لوكيشن الصيدلية المتسجّل` : 'اتسلّم ✓', far ? 'err' : '');
      try { navigator.vibrate && navigator.vibrate(60); } catch (e) {}
    };
  }
  function failModal(r, cur) {
    const p = G('parties', cur.partyId) || {}; const reasons = ['الصيدلية مقفولة', 'رفض الاستلام', 'مرتجع / فيه صنف غلط', 'تأجيل لوقت تاني', 'مش لاقي العنوان', 'أخرى'];
    modal(`<h2>مشكلة في ${esc(p.name || '')}</h2><div class="grid g2">${reasons.map(x => `<button class="btn" data-dvr="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      <label class="f" style="margin-top:10px">تفاصيل<input class="in" id="dv_fn"></label>
      <label class="row small" style="gap:6px;margin-top:8px"><input type="checkbox" id="dv_lt">أرجعلها آخر الخط بدل ما أقفلها</label>
      <div class="row" style="margin-top:12px"><button class="btn" data-close>رجوع</button></div>`);
    $$('[data-dvr]').forEach(b => b.onclick = async () => {
      const reason = b.dataset.dvr, note = document.getElementById('dv_fn').value.trim(), later = document.getElementById('dv_lt').checked; const g = await gps(5000);
      await patchRun(r.id, x => { const mine = x.stops.filter(y => y.partyId === cur.partyId && ['pending', 'arrived'].includes(y.status));
        if (later) { x.stops = x.stops.filter(y => !mine.includes(y)).concat(mine.map(y => ({ ...y, status: 'pending', postponed: (y.postponed || 0) + 1, note: reason + (note ? ' — ' + note : '') }))); }
        else mine.forEach(y => { y.status = 'failed'; y.reason = reason; y.at = nowIso(); if (note) y.note = note; if (g) y.gps = g; }); });
      closeModal(); toast(later ? 'اترجعت لآخر الخط' : 'اتسجّلت المشكلة — المدير هيشوفها', 'err');
    });
  }

  /* ---------- كارت الرئيسية ---------- */
  D.card = function () {
    if (!canSee()) return '';
    const t = today();
    if (isMgr()) {
      const xs = runs().filter(r => r.status === 'active' || (r.date === t && r.status !== 'cancel'));
      if (!xs.length) return '';
      return `<div class="card" style="margin-bottom:18px"><div class="row"><h3 style="margin:0">🚚 التوصيل النهارده</h3><span class="sp"></span><a class="small" href="#/routes">كل الخطوط</a></div><div class="dv-list" style="margin-top:10px">${xs.map(r => { const s = stats(r, true); return `<a class="dv-stop" href="#/routes/${esc(r.id)}" style="color:inherit;text-decoration:none;grid-template-columns:minmax(0,1fr) auto"><div><b>${esc(r.driverName || '')}</b> <span class="small muted">— ${esc(r.name || '')}</span><div class="small muted">${r.status === 'active' ? (r.live ? '📍 آخر مكان ' + ago(r.live.at) : 'في الطريق') : r.status === 'done' ? 'خلص' : 'لسه مبدأش'}${r.status === 'active' && s.minLeft ? ' — يخلص حوالي ' + hm(new Date(Date.now() + s.minLeft * 60000)) : ''}</div></div><div class="row" style="gap:6px"><span class="tag ok">${s.cnt.delivered}/${s.total}</span>${s.cnt.failed ? `<span class="tag bad">${s.cnt.failed} مشكلة</span>` : ''}</div></a>`; }).join('')}</div></div>`;
    }
    const mine = myRuns(); if (!mine.length) return '';
    const r = mine[0]; const s = stats(r, true);
    return `<a class="card" href="#/routes/${esc(r.id)}" style="display:block;margin-bottom:18px;border:2px solid var(--brand);color:inherit;text-decoration:none"><div class="row"><h3 style="margin:0">🚚 رحلتك: ${esc(r.name || '')}</h3><span class="sp"></span><span class="tag ok">${s.cnt.delivered}/${s.total}</span></div><div class="small muted" style="margin-top:6px">${r.status === 'planned' ? 'دوس هنا وابدأ الرحلة' : 'كمّل المحطة الجاية'}</div></a>`;
  };

  // بيشتغل مع كل رسم للشاشة: يشغّل/يوقف التتبع
  D.tick = function () { try { if (isDrv() || S.isAdmin) trackTick(); } catch (e) {} };
  D.summary = function () {
    const xs = runs().filter(r => r.status === 'active' || (r.date === today() && r.status !== 'cancel')).filter(r => isMgr() || r.driverId === S.me.id);
    if (!xs.length) return null;
    return xs.map(r => { const s = stats(r, true); const nx = s.vs.find(v => v.open); const left = s.vs.filter(v => v.open).map(v => (G('parties', v.partyId) || {}).name); const done = s.vs.filter(v => v.status === 'delivered').map(v => (G('parties', v.partyId) || {}).name); const bad = s.vs.filter(v => v.status === 'failed').map(v => (G('parties', v.partyId) || {}).name + ' (' + ((v.stops.find(x => x.reason) || {}).reason || '') + ')');
      return { id: r.id, md: `**${r.driverName || ''} — ${r.name || ''}** (${r.status === 'active' ? 'في الطريق' : r.status === 'done' ? 'خلص' : 'لسه مبدأش'})\n- 📍 آخر مكان: ${r.live ? ago(r.live.at) : 'مفيش'}${nx ? `\n- الجاية: **${(G('parties', nx.partyId) || {}).name || ''}**${s.eta[nx.stops[0].invId] ? ' متوقع ' + hm(s.eta[nx.stops[0].invId]) : ''}` : ''}\n- ✓ اتسلّم (${done.length}): ${done.join('، ') || '—'}\n- ⏳ لسه (${left.length}): ${left.join('، ') || '—'}${bad.length ? `\n- ✕ مشاكل: ${bad.join('، ')}` : ''}${s.cash ? `\n- 💰 حصّل: ${fmt(s.cash)}` : ''}${r.status === 'active' && s.minLeft ? `\n- يخلص حوالي ${hm(new Date(Date.now() + s.minLeft * 60000))}` : ''}` }; });
  };
  D.km = km; D.optimize = optimize; D.parseLoc = parseLoc; D.stats = stats;
})();
