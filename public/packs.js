/* ميزان — الشنط والكراتين (الطرود).
   كل شنطة/كرتونة ليها ملصق بباركود: اسم الصيدلية، «شنطة 2 من 4»، أرقام الفواتير، والمندوب ورقم المحطة.
   الطرد بيتمسح 3 مرات: وقت التغليف (مراجعة التحضير)، وقت تحميل العربية، ووقت التسليم في الصيدلية —
   وأي شنطة تبع صيدلية تانية بتطلع تنبيه فوري، وأي شنطة ناقصة مش بتعدي من غير سبب. */
(function () {
  'use strict';
  const PK = { cur: {} }; window.MZ_PK = PK;
  const nowIso = () => new Date().toISOString();
  const who = () => (S.me && S.me.name) || '';
  const KIND = { bag: ['شنطة', '👜'], box: ['كرتونة', '📦'] };

  /* ---------- البيانات ---------- */
  const keyOfInv = inv => inv.partyId ? inv.partyId + '|' + inv.date : 'inv:' + inv.id;
  const partyOfKey = k => k.startsWith('inv:') ? '' : k.split('|')[0];
  const all = () => L('pkgs').filter(p => !p.voided);
  const ofKey = k => all().filter(p => p.key === k).sort((a, b) => a.seq - b.seq);
  const invsOfKey = k => { if (k.startsWith('inv:')) { const i = L('invoices').find(x => x.id === k.slice(4)); return i ? [i] : []; } const [pid, d] = k.split('|'); return L('invoices').filter(i => i.type === 'sale' && i.partyId === pid && i.date === d).sort((a, b) => (+a.no) - (+b.no)); };
  const nameOfKey = k => { const pid = partyOfKey(k); return pid ? partyName(pid) : 'عميل نقدي'; };
  // كود الطرد أرقام بس (98 + 8 أرقام) علشان الماسح يقراه صح حتى لو الكيبورد عربي
  function code() { let c = '98'; for (let i = 0; i < 8; i++) c += Math.floor(Math.random() * 10); return G('pkgs', c) ? code() : c; }
  async function create(inv, kind) {
    const k = keyOfInv(inv); const seq = ofKey(k).reduce((m, p) => Math.max(m, p.seq || 0), 0) + 1; const id = code();
    const d = { key: k, partyId: inv.partyId || '', date: inv.date, invIds: invsOfKey(k).map(i => i.id), kind, seq, items: {}, st: 'packed', by: who(), at: nowIso() };
    await put('pkgs', id, d); PK.cur[k] = id; return { id, ...d };
  }
  async function patch(id, fn) { const c = G('pkgs', id); if (!c) return; const d = { ...c }; delete d.id; fn(d); d.upd = nowIso(); await put('pkgs', id, d); }
  const addItem = (id, pid, q) => patch(id, d => { d.items = d.items || {}; d.items[pid] = Math.round(((d.items[pid] || 0) + q) * 1000) / 1000; if (d.items[pid] <= 0) delete d.items[pid]; });
  const nItems = p => Object.values(p.items || {}).reduce((s, q) => s + q, 0);
  function fromScan(raw) { const v = fixBc(String(raw || '').trim()).toUpperCase().replace(/\s/g, ''); const m = v.match(/^PKG-?([0-9A-Z]{5,8})$/) || v.match(/^(98\d{8})$/); if (!m) return null; const p = G('pkgs', m[1]); if (!p && /^98\d{8}$/.test(v)) return null; return p ? { id: m[1], ...p } : { id: m[1], missing: true }; }
  const label = p => `${KIND[p.kind] ? KIND[p.kind][0] : 'طرد'} ${p.seq} من ${ofKey(p.key).length}`;

  /* ---------- صوت ---------- */
  let AC = null;
  function beep(kind) { try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); const seq = kind === 'err' ? [[200, .25], [0, .06], [200, .3]] : kind === 'done' ? [[660, .1], [880, .1], [1320, .18]] : [[880, .08]]; let t = AC.currentTime; for (const [f, d] of seq) { if (f) { const o = AC.createOscillator(), g = AC.createGain(); o.type = kind === 'err' ? 'square' : 'sine'; o.frequency.value = f; g.gain.setValueAtTime(.18, t); g.gain.exponentialRampToValueAtTime(.001, t + d); o.connect(g).connect(AC.destination); o.start(t); o.stop(t + d); } t += d + .02; } } catch (e) {} try { navigator.vibrate && navigator.vibrate(kind === 'err' ? [250, 80, 250] : 40); } catch (e) {} }
  PK.beep = beep;

  /* ---------- الملصقات ---------- */
  const SZ = () => { try { return localStorage.getItem('mz_lbl') || 's'; } catch (e) { return 's'; } };
  function stopInfo(p) {
    const runs = L('runs').filter(r => r.status !== 'cancel' && (r.stops || []).some(s => (p.invIds || []).includes(s.invId)));
    const r = runs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0]; if (!r) return null;
    const vs = []; for (const s of r.stops) { if (!vs.length || vs[vs.length - 1] !== s.partyId) vs.push(s.partyId); }
    return { driver: r.driverName || '', stop: vs.indexOf(p.partyId) + 1, of: vs.length, run: r.name };
  }
  function labelHTML(p) {
    const pt = p.partyId ? G('parties', p.partyId) || {} : {}; const tot = ofKey(p.key).length; const si = stopInfo(p);
    const invs = (p.invIds || []).map(id => L('invoices').find(i => i.id === id)).filter(Boolean);
    return `<div class="pk-lbl"><div class="pk-top"><div class="pk-name">${esc(pt.name || 'عميل نقدي')}</div><div class="pk-n"><b>${p.seq}</b><span>من ${tot}</span></div></div>
      <div class="pk-kind">${KIND[p.kind] ? KIND[p.kind][1] + ' ' + KIND[p.kind][0] : 'طرد'} ${p.seq} من ${tot}${nItems(p) ? ` — ${fq(nItems(p))} قطعة` : ''}</div>
      <div class="pk-sub">${pt.address ? esc(pt.address) + '<br>' : ''}فواتير: ${invs.map(i => '#' + esc(i.no)).join(' ')} — ${esc(p.date)}${si ? `<br>🚚 ${esc(si.driver)} — محطة ${si.stop} من ${si.of}` : ''}</div>
      <svg data-pkbc="${esc(/^\d+$/.test(p.id) ? p.id : 'PKG-' + p.id)}"></svg><div class="pk-code">${esc(/^\d+$/.test(p.id) ? p.id : 'PKG-' + p.id)}</div></div>`;
  }
  function printLabels(list) {
    if (!list.length) return; const sz = SZ();
    const css = `<style>@page{size:${sz === 's' ? '100mm 70mm' : 'A4'};margin:${sz === 's' ? '2mm' : '8mm'}}
      .pk-lbl{box-sizing:border-box;border:2px solid #000;border-radius:3mm;padding:3mm 4mm;font-family:system-ui,Tahoma,sans-serif;direction:rtl;${sz === 's' ? 'width:96mm;height:66mm;page-break-after:always;break-after:page' : 'width:92mm;height:64mm;display:inline-block;margin:2mm;vertical-align:top;break-inside:avoid'};overflow:hidden;text-align:right}
      .pk-top{display:flex;justify-content:space-between;align-items:flex-start;gap:3mm}.pk-name{font-size:17pt;font-weight:800;line-height:1.15}
      .pk-n{border:2px solid #000;border-radius:2mm;padding:1mm 3mm;text-align:center;min-width:16mm}.pk-n b{display:block;font-size:24pt;line-height:1}.pk-n span{font-size:9pt}
      .pk-kind{font-size:12pt;font-weight:700;margin:1.5mm 0}.pk-sub{font-size:9pt;line-height:1.35}
      .pk-lbl svg{display:block;margin:1.5mm auto 0;height:15mm;max-width:100%}.pk-code{text-align:center;font:700 10pt monospace;letter-spacing:1px}</style>`;
    const el = document.getElementById('print'); el.className = ''; el.innerHTML = css + list.map(labelHTML).join('');
    el.querySelectorAll('svg[data-pkbc]').forEach(s => { try { JsBarcode(s, s.dataset.pkbc, { format: 'CODE128', height: 46, width: 2, displayValue: false, margin: 0 }); } catch (e) {} });
    list.forEach(p => patch(p.id, d => { d.printed = (d.printed || 0) + 1; }).catch(() => {}));
    setTimeout(() => { try { window.print(); } catch (e) { toast('الطباعة غير متاحة هنا', 'err'); } }, 60);
  }
  PK.printLabels = printLabels;

  /* ---------- كاميرا ---------- */
  async function camScan(onVal, title) {
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices) { toast('الكاميرا مش متاحة هنا — افتح ميزان من المتصفح على https أو استخدم الماسح', 'err'); return; }
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch (e) { toast('اسمح بإذن الكاميرا', 'err'); return; }
    const wrap = document.createElement('div'); wrap.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;gap:10px';
    wrap.innerHTML = `<div style="color:#fff;font-weight:700">${esc(title || 'وجّه الكاميرا على الباركود')}</div><video playsinline muted style="width:min(520px,100%);border-radius:14px;background:#000"></video><div class="pkcam-s" style="color:#fff;min-height:20px"></div><button class="btn" type="button">قفل</button>`;
    document.body.appendChild(wrap); const v = wrap.querySelector('video'); v.srcObject = stream; await v.play().catch(() => {});
    let alive = true, last = '', lastT = 0; const stop = () => { alive = false; stream.getTracks().forEach(t => t.stop()); wrap.remove(); };
    wrap.querySelector('button').onclick = stop;
    const det = new window.BarcodeDetector({ formats: ['code_128', 'ean_13', 'ean_8', 'code_39', 'qr_code', 'upc_a', 'itf'] });
    const tick = async () => { if (!alive) return; try { const r = await det.detect(v); if (r[0] && (r[0].rawValue !== last || Date.now() - lastT > 1500)) { last = r[0].rawValue; lastT = Date.now(); const msg = onVal(last); wrap.querySelector('.pkcam-s').textContent = msg || last; if (msg === false) { stop(); return; } } } catch (e) {} setTimeout(tick, 180); };
    tick(); return stop;
  }
  PK.camScan = camScan;

  /* ---------- لوحة التغليف في شاشة المراجعة ---------- */
  PK.reviewPanel = function (inv) {
    if (!inv || inv.type !== 'sale') return '';
    const k = keyOfInv(inv); const ps = ofKey(k); const invs = invsOfKey(k); const cur = PK.cur[k] && ps.find(p => p.id === PK.cur[k]) ? PK.cur[k] : (ps.length ? ps[ps.length - 1].id : '');
    if (cur) PK.cur[k] = cur;
    const unprinted = ps.filter(p => !p.printed).length;
    return `<div class="card" style="margin-top:14px" id="pkBox"><div class="row"><h3 style="margin:0">📦 الشنط والكراتين — ${esc(nameOfKey(k))}</h3><span class="small muted">${invs.length > 1 ? `بتجمع ${invs.length} فواتير: ${invs.map(i => '#' + esc(i.no)).join(' ')}` : ''}</span><span class="sp"></span>
        <button class="btn s" data-pkadd="bag">+ 👜 شنطة</button><button class="btn s" data-pkadd="box">+ 📦 كرتونة</button>${ps.length ? `<button class="btn s ${unprinted ? 'p' : ''}" id="pkPrint">${ic('print')}اطبع الملصقات (${ps.length})</button>` : ''}
        <select class="in" id="pkSz" style="width:auto;padding:4px 8px;font-size:12.5px" title="مقاس الملصق"><option value="s" ${SZ() === 's' ? 'selected' : ''}>ملصق 10×7 سم</option><option value="a4" ${SZ() === 'a4' ? 'selected' : ''}>ورق A4</option></select></div>
      ${ps.length ? `<div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">${ps.map(p => `<button type="button" class="pk-chip ${p.id === cur ? 'on' : ''}" data-pksel="${p.id}" title="الأصناف اللي تتمسح بعد كده هتتحسب في الطرد ده">${KIND[p.kind][1]} <b>${KIND[p.kind][0]} ${p.seq}</b> <span class="muted">${fq(nItems(p))} قطعة${p.printed ? '' : ' — لسه ملصقها ماتطبعش'}</span>${p.st === 'packed' ? `<span class="pk-x" data-pkdel="${p.id}" title="إلغاء الطرد">✕</span>` : ''}</button>`).join('')}</div>
        <p class="small muted" style="margin:8px 0 0">اختار الشنطة اللي بتحط فيها وبعدين امسح الأصناف. ${unprinted && ps.length ? '<b>اطبع الملصقات بعد آخر شنطة</b> علشان «X من Y» تطلع صح.' : ''} ولو مسحت ملصق شنطة تبع صيدلية تانية هيطلعلك تحذير.</p>`
        : `<p class="small muted" style="margin:8px 0 0">لسه مفيش شنط للأوردر ده. ضيف شنطة أو كرتونة، وكل اللي هتمسحه بعدها هيتسجّل جواها — أو سيبها وهسألك على العدد لما تخلّص المراجعة.</p>`}</div>`;
  };
  PK.bindReview = function (inv, rerender) {
    if (!inv) return; const k = keyOfInv(inv);
    $$('[data-pkadd]').forEach(b => b.onclick = async () => { const p = await create(inv, b.dataset.pkadd); toast(`اتعمل ${KIND[p.kind][0]} ${p.seq} — امسح الأصناف اللي فيها`); rerender(); });
    $$('[data-pksel]').forEach(b => b.onclick = e => { if (e.target.closest('[data-pkdel]')) return; PK.cur[k] = b.dataset.pksel; rerender(); });
    $$('[data-pkdel]').forEach(x => x.onclick = async e => { e.stopPropagation(); if (!(await confirmBox('إلغاء الطرد ده؟ الأرقام بتاعة الباقيين هتتظبط.', 'إلغاء الطرد', true))) return; await patch(x.dataset.pkdel, d => { d.voided = true; }); const left = ofKey(k); for (let i = 0; i < left.length; i++) if (left[i].seq !== i + 1) await patch(left[i].id, d => { d.seq = i + 1; }); if (PK.cur[k] === x.dataset.pkdel) PK.cur[k] = ''; rerender(); });
    const pr = document.getElementById('pkPrint'); if (pr) pr.onclick = () => printLabels(ofKey(k));
    const sz = document.getElementById('pkSz'); if (sz) sz.onchange = () => { try { localStorage.setItem('mz_lbl', sz.value); } catch (e) {} };
  };
  // بيتنده من مراجعة التحضير: مسح ملصق شنطة، أو صنف اتمسح صح
  PK.onReviewScan = function (inv, raw) {
    const p = fromScan(raw); if (!p) return null;
    if (p.missing || p.voided) return { kind: 'err', text: 'ملصق شنطة مش معروف أو اتلغى', sub: raw };
    if (!inv) return { kind: 'warn', text: `ده ملصق ${label(p)} — ${nameOfKey(p.key)}`, sub: 'افتح فاتورة الأول' };
    const k = keyOfInv(inv);
    if (p.key !== k) { beep('err'); return { kind: 'err', text: `⛔ دي ${label(p)} تبع ${nameOfKey(p.key)} — مش الأوردر ده!`, sub: `متحطش أصناف ${nameOfKey(k)} فيها` }; }
    PK.cur[k] = p.id; return { kind: 'ok', text: `بقيت بتعبّي ${label(p)}`, sub: 'الأصناف اللي هتتمسح هتتحسب جواها' };
  };
  PK.onItem = function (inv, pid, q) { if (!inv || inv.type !== 'sale') return; const k = keyOfInv(inv); const id = PK.cur[k]; if (id && G('pkgs', id)) addItem(id, pid, q).catch(() => {}); };
  PK.has = inv => inv && ofKey(keyOfInv(inv)).length > 0;
  PK.quickModal = function (inv, after) {
    const k = keyOfInv(inv);
    modal(`<h2>📦 اتحضّر في كام شنطة / كرتونة؟</h2><p class="small muted" style="margin-top:-6px">${esc(nameOfKey(k))} — كل فواتير النهارده ليها مع بعض</p>
      <div class="grid g2"><label class="f">👜 شنط<input class="in n" id="pk_b" inputmode="numeric" value="1"></label><label class="f">📦 كراتين<input class="in n" id="pk_c" inputmode="numeric" value="0"></label></div>
      <div class="row" style="margin-top:14px"><button class="btn p" id="pk_ok">${ic('print')}اعملهم واطبع الملصقات</button><button class="btn" id="pk_skip">من غير شنط</button></div>`);
    document.getElementById('pk_ok').onclick = async () => { const nb = Math.max(0, Math.min(40, parseInt(document.getElementById('pk_b').value) || 0)), nc = Math.max(0, Math.min(40, parseInt(document.getElementById('pk_c').value) || 0)); for (let i = 0; i < nb; i++) await create(inv, 'bag'); for (let i = 0; i < nc; i++) await create(inv, 'box'); closeModal(); if (nb + nc) printLabels(ofKey(k)); after && after(); };
    document.getElementById('pk_skip').onclick = () => { closeModal(); after && after(); };
  };

  /* ---------- التوصيل: التحميل والتسليم ---------- */
  const runKeys = r => { const ks = new Set(); (r.stops || []).forEach(s => { const i = L('invoices').find(x => x.id === s.invId); if (i) ks.add(keyOfInv(i)); }); return ks; };
  const runPkgs = r => { const ks = runKeys(r); return all().filter(p => ks.has(p.key)); };
  const stopKeys = (r, partyId) => { const ks = new Set(); (r.stops || []).filter(s => s.partyId === partyId).forEach(s => { const i = L('invoices').find(x => x.id === s.invId); if (i) ks.add(keyOfInv(i)); }); return ks; };
  PK.runPkgs = runPkgs; PK.stopPkgs = (r, partyId) => { const ks = stopKeys(r, partyId); return all().filter(p => ks.has(p.key)); };
  PK.label = label; PK.nameOfKey = nameOfKey;
  // المندوب بيمسح شنطة: تحميل (قبل البداية) أو تسليم (في المحطة)
  PK.driverScan = async function (r, raw, curPartyId) {
    const p = fromScan(raw); if (!p) return null;
    if (p.missing || p.voided) { beep('err'); return { kind: 'err', text: 'ملصق مش معروف' }; }
    const mine = runPkgs(r).some(x => x.id === p.id);
    if (!mine) { beep('err'); return { kind: 'err', text: `⛔ ${label(p)} تبع ${nameOfKey(p.key)} — مش في خط السير بتاعك!`, sub: 'رجّعها المخزن' }; }
    if (r.status === 'planned' || !curPartyId) {
      if (p.st === 'delivered') { beep('err'); return { kind: 'err', text: `⛔ ${label(p)} تبع ${nameOfKey(p.key)} اتسلّمت قبل كده!`, sub: 'متتحمّلش تاني' }; }
      if (p.st === 'packed' || p.runId !== r.id) await patch(p.id, d => { d.st = 'loaded'; d.loadAt = nowIso(); d.loadBy = who(); d.runId = r.id; });
      const ps = runPkgs(r); const n = ps.filter(x => (x.st !== 'packed' && (x.runId === r.id || x.st === 'delivered')) || x.id === p.id).length; beep(n === ps.length ? 'done' : 'ok');
      return { kind: 'ok', text: `✓ اتحمّلت ${label(p)} — ${nameOfKey(p.key)}`, sub: `${n} من ${ps.length} في العربية` };
    }
    if (p.partyId !== curPartyId) { beep('err'); return { kind: 'err', text: `⛔ دي ${label(p)} تبع ${nameOfKey(p.key)} — مش للصيدلية دي!`, sub: 'متسلّمهاش هنا' }; }
    PK.scanned = PK.scanned || new Set(); PK.scanned.add(p.id);
    const sp = PK.stopPkgs(r, curPartyId); const n = sp.filter(x => PK.scanned.has(x.id)).length; beep(n === sp.length ? 'done' : 'ok');
    return { kind: n === sp.length ? 'done' : 'ok', text: `✓ ${label(p)}`, sub: n === sp.length ? 'كل الشنط تمام — دوس «اتسلّم»' : `${n} من ${sp.length} — كمّل` };
  };
  PK.markDelivered = async (ids, runId) => { for (const id of ids) await patch(id, d => { d.st = 'delivered'; d.delAt = nowIso(); d.delBy = who(); d.runId = runId; }); };

  /* ---------- CSS ---------- */
  const st = document.createElement('style'); st.textContent = `
  .pk-chip{display:inline-flex;align-items:center;gap:6px;border:1.5px solid var(--line);background:var(--surface);color:var(--ink);border-radius:10px;padding:7px 11px;font:inherit;font-size:13.5px;cursor:pointer}
  .pk-chip.on{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 18%,transparent);background:color-mix(in srgb,var(--brand) 8%,var(--surface))}
  .pk-x{margin-inline-start:4px;color:var(--danger);font-weight:700;padding:0 3px}
  .pk-list{display:flex;flex-wrap:wrap;gap:6px}.pk-t{border:1px solid var(--line);border-radius:8px;padding:3px 8px;font-size:12.5px}.pk-t.ok{background:#d9f2df;border-color:#9fd6ad}.pk-t.no{background:#fde2de;border-color:#f0a99f}
  @media (prefers-color-scheme:dark){.pk-t.ok{background:#143524}.pk-t.no{background:#4a1d17}}`;
  document.head.appendChild(st);
})();
