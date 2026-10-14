/* ميزان — مراجعة التحضير بالباركود.
   المراجع بيفتح الفاتورة (بمسح الباركود المطبوع عليها أو برقمها)، وبيمسح كل صنف وهو بيحطه في الشنطة.
   البرنامج بيتأكد إن الصنف في الأوردر وبالكمية الصح، وبينبّه بصوت ولون من غير ما يوقف الماسح،
   وبيسجّل المراجعة (مين، إمتى، قد إيه، والأخطاء) في collection اسمها picks، وبيعلّم الفاتورة «اتحضرت» لما تطابق. */
(function () {
  'use strict';
  const RV = { inv: null, lines: [], log: [], start: '', mult: 1, last: null, flash: null, hideDone: false, tab: 'work', hist: 1, dirty: false, saveT: 0 };
  window.MZ_RV = RV;
  const canRev = () => S.isAdmin || can('prep') || can('sell');
  const pk = id => G('picks', id) || null;
  const who = () => (S.me && S.me.name) || '';
  const nowIso = () => new Date().toISOString();
  const mins = (a, b) => Math.max(0, Math.round((new Date(b || nowIso()) - new Date(a)) / 60000));
  const durTxt = (a, b) => { const s = Math.max(0, Math.round((new Date(b || nowIso()) - new Date(a)) / 1000)); return s < 60 ? s + ' ث' : s < 3600 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' د' : Math.floor(s / 3600) + ' س ' + Math.floor(s % 3600 / 60) + ' د'; };
  const RVT = ['sale', 'transfer'];

  /* ---------- صوت واهتزاز ---------- */
  let AC = null;
  function beep(kind) {
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      const seq = { ok: [[880, 0.07]], line: [[880, 0.07], [1320, 0.1]], done: [[660, 0.1], [880, 0.1], [1320, 0.18]], err: [[200, 0.22], [0, 0.06], [200, 0.3]], warn: [[440, 0.15], [330, 0.2]] }[kind] || [[600, 0.08]];
      let t = AC.currentTime;
      for (const [f, d] of seq) { if (f) { const o = AC.createOscillator(), g = AC.createGain(); o.type = kind === 'err' ? 'square' : 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + d); o.connect(g).connect(AC.destination); o.start(t); o.stop(t + d); } t += d + 0.02; }
    } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(kind === 'err' ? [200, 80, 200] : kind === 'warn' ? [120, 60, 120] : 40); } catch (e) {}
  }

  /* ---------- الباركود ---------- */
  let IDX = null, IDXn = -1;
  function index() {
    const ps = L('products'); if (IDX && IDXn === ps.length) return IDX;
    const bc = new Map(), code = new Map();
    for (const p of ps) { const add = v => { v = String(v || '').trim(); if (v && !bc.has(v)) bc.set(v, p.id); if (v && !bc.has(v.toLowerCase())) bc.set(v.toLowerCase(), p.id); }; add(p.barcode); (p.barcodes || []).forEach(add); if (p.code) code.set(String(p.code).trim(), p.id); }
    IDX = { bc, code }; IDXn = ps.length; return IDX;
  }
  function resolve(raw) {
    const v0 = String(raw || '').trim(); if (!v0) return null; const I = index();
    for (const v of [v0, fixBc(v0)]) { if (!v) continue; const id = I.bc.get(v) || I.bc.get(v.toLowerCase()); if (id) return id; }
    for (const v of [v0, fixBc(v0)]) { const id = I.code.get(v); if (id) return id; }
    // باركود EAN بصفر ناقص أو زيادة
    const d = fixBc(v0).replace(/^0+/, ''); if (d.length >= 6) for (const [k, id] of I.bc) if (k.replace(/^0+/, '') === d) return id;
    return null;
  }
  const invCode = inv => (inv.type === 'transfer' ? 'TRF-' : 'INV-') + inv.no;
  function invFromScan(raw) {
    const v = fixBc(String(raw || '').trim()).toUpperCase();
    let m = v.match(/^(INV|TRF)-?(\d+)$/); if (m) return findInv(m[2], m[1] === 'TRF' ? 'transfer' : 'sale');
    return null;
  }
  function findInv(no, type) {
    const xs = L('invoices').filter(i => String(i.no) === String(no) && (type ? i.type === type : RVT.includes(i.type)));
    return xs.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] || null;
  }

  /* ---------- الحالة ---------- */
  function linesOf(inv) {
    const m = new Map();
    for (const l of inv.lines || []) { if (!l.pid) continue; const x = m.get(l.pid) || { pid: l.pid, req: 0, got: 0 }; x.req += +l.qty || 0; m.set(l.pid, x); }
    return [...m.values()].sort((a, b) => pname(a.pid).localeCompare(pname(b.pid), 'ar'));
  }
  const st = l => { const r = Math.round(l.req * 1000), g = Math.round(l.got * 1000); return g === 0 ? 'pending' : g < r ? 'partial' : g === r ? 'done' : 'excess'; };
  const ST_T = { pending: 'لم يبدأ', partial: 'ناقص', done: 'مطابق ✓', excess: 'زيادة ⚠' };
  function sums() {
    const c = { pending: 0, partial: 0, done: 0, excess: 0 }; let req = 0, got = 0;
    RV.lines.forEach(l => { c[st(l)]++; req += l.req; got += Math.min(l.got, l.req); });
    const errs = RV.log.filter(x => ['notin', 'unknown', 'over'].includes(x.k)).length;
    return { c, req, got, pct: req ? Math.round(got / req * 100) : 0, all: RV.lines.length, ok: RV.lines.length > 0 && c.done === RV.lines.length, errs };
  }
  function docOf(status) {
    const s = sums(); const inv = RV.inv;
    return { invId: inv.id, no: inv.no, type: inv.type, partyId: inv.partyId || '', date: inv.date, status, by: who(), byId: S.me.id || '', start: RV.start, end: status === 'open' ? '' : nowIso(), upd: nowIso(),
      lines: Object.fromEntries(RV.lines.map(l => [l.pid, { req: l.req, got: l.got }])), errs: s.errs, units: s.req, log: RV.log.slice(0, 80), ...(RV.reason ? { reason: RV.reason } : {}) };
  }
  function saveSoon() { RV.dirty = true; clearTimeout(RV.saveT); RV.saveT = setTimeout(saveNow, 900); }
  async function saveNow() { if (!RV.inv || !RV.dirty) return; RV.dirty = false; try { await put('picks', RV.inv.id, docOf('open')); } catch (e) { RV.dirty = true; } }
  window.addEventListener('beforeunload', () => { if (RV.dirty) saveNow(); });

  function open(inv, opt = {}) {
    if (!inv) return;
    if (!RVT.includes(inv.type)) { flash('err', `دي ${TYPES[inv.type].full} — المراجعة لفواتير البيع والتحويلات بس`); return; }
    const p = pk(inv.id);
    RV.inv = inv; RV.lines = linesOf(inv); RV.log = []; RV.start = nowIso(); RV.mult = 1; RV.last = null; RV.reason = '';
    if (p && p.status === 'open' && !opt.fresh) { // كمّل مراجعة مفتوحة (حتى من جهاز تاني)
      RV.lines.forEach(l => { const x = p.lines && p.lines[l.pid]; if (x) l.got = +x.got || 0; }); RV.log = p.log || []; RV.start = p.start || RV.start;
      flash('ok', `كمّلت المراجعة اللي بدأها ${p.by || ''} — ${sums().pct}% خلصان`);
    } else if (p && p.status !== 'open' && !opt.fresh) {
      flash('warn', `الفاتورة دي اتراجعت قبل كده (${p.status === 'ok' ? 'مطابقة' : 'بنواقص'}) بواسطة ${p.by || ''} ${ltm(p.end)} — بتبدأ مراجعة جديدة`);
    } else flash('ok', `فتحت ${TYPES[inv.type].full} رقم ${inv.no} — ${RV.lines.length} صنف. امسح الأصناف.`);
    RV.log.unshift({ at: nowIso(), k: 'open', by: who() });
    if (route().p !== 'pick' || route().a[0] !== inv.id) history.replaceState(null, '', '#/pick/' + inv.id);
    saveSoon(); render();
  }
  function close() { RV.inv = null; RV.lines = []; RV.log = []; RV.last = null; if (route().a[0]) history.replaceState(null, '', '#/pick'); render(); }

  function flash(kind, text, sub) { RV.flash = { kind, text, sub: sub || '', at: Date.now() }; beep(kind === 'ok' ? 'ok' : kind); }

  function scan(raw) {
    raw = String(raw || '').trim(); if (!raw) return;
    // 12* أو x12 قبل المسح = كمية
    let m = raw.match(/^(\d+(?:\.\d+)?)\s*[*xX×]$/); if (m) { RV.mult = +m[1] || 1; flash('ok', `المسحة الجاية هتتحسب ×${RV.mult}`); render(); return; }
    let mult = RV.mult; m = raw.match(/^(\d+(?:\.\d+)?)\s*[*xX×]\s*(.+)$/); if (m) { mult = +m[1] || 1; raw = m[2].trim(); }
    { const pkr = window.MZ_PK && MZ_PK.onReviewScan(RV.inv, raw); if (pkr) { RV.flash = { ...pkr, sub: pkr.sub || '', at: Date.now() }; if (pkr.kind !== 'err') beep(pkr.kind === 'warn' ? 'warn' : 'ok'); render(); return; } }
    const iv = invFromScan(raw);
    if (iv) {
      if (RV.inv && iv.id !== RV.inv.id && !sums().ok && RV.lines.some(l => l.got)) { flash('warn', `ده باركود فاتورة تانية (#${iv.no}) — خلّص أو اقفل الأوردر ده الأول`); RV.pendingOpen = iv.id; render(); return; }
      if (RV.inv && iv.id === RV.inv.id) { flash('ok', 'دي نفس الفاتورة المفتوحة'); render(); return; }
      open(iv); return;
    }
    if (!RV.inv) { // من غير أوردر: رقم الفاتورة
      const no = fixBc(raw).replace(/\D/g, ''); const inv = no && findInv(no);
      if (inv) { open(inv); return; }
      flash('err', 'مفيش فاتورة بالرقم ده', raw); render(); return;
    }
    const pid = resolve(raw);
    if (!pid) { RV.log.unshift({ at: nowIso(), k: 'unknown', code: raw }); flash('err', 'باركود مش معروف في الأصناف', raw); RV.last = null; saveSoon(); render(); return; }
    const l = RV.lines.find(x => x.pid === pid);
    if (!l) { RV.log.unshift({ at: nowIso(), k: 'notin', pid, code: raw }); flash('err', '⛔ الصنف ده مش في الأوردر — متحطّوش في الشنطة!', pname(pid)); RV.last = null; saveSoon(); render(); return; }
    const before = st(l); l.got = Math.round((l.got + mult) * 1000) / 1000; RV.mult = 1; RV.last = pid;
    const s2 = st(l);
    RV.log.unshift({ at: nowIso(), k: s2 === 'excess' ? 'over' : 'ok', pid, q: mult });
    if (window.MZ_PK) MZ_PK.onItem(RV.inv, pid, mult);
    if (s2 === 'excess') flash('warn', `⚠ زيادة! ${pname(pid)}`, `المطلوب ${fq(l.req)} — اتمسح ${fq(l.got)}. شيل ${fq(l.got - l.req)} من الشنطة`);
    else if (sums().ok) { flash('done', `✅ الأوردر كامل ومطابق 100% (${RV.lines.length} صنف)`, 'دوس «إنهاء المراجعة» أو امسح باركود الفاتورة الجاية'); beep('done'); }
    else if (s2 === 'done' && before !== 'done') { RV.flash = { kind: 'ok', text: `✓ ${pname(pid)} — كمل (${fq(l.req)})`, sub: '', at: Date.now() }; beep('line'); }
    else { RV.flash = { kind: 'ok', text: `${pname(pid)}`, sub: `${fq(l.got)} من ${fq(l.req)} — باقي ${fq(l.req - l.got)}`, at: Date.now() }; beep('ok'); }
    saveSoon(); render();
  }
  function adjust(pid, d, abs) {
    const l = RV.lines.find(x => x.pid === pid); if (!l) return;
    const old = l.got; l.got = Math.max(0, abs != null ? +abs || 0 : Math.round((l.got + d) * 1000) / 1000);
    if (l.got === old) return;
    RV.log.unshift({ at: nowIso(), k: d < 0 || (abs != null && l.got < old) ? 'undo' : 'manual', pid, q: Math.round((l.got - old) * 1000) / 1000 }); if (window.MZ_PK) MZ_PK.onItem(RV.inv, pid, Math.round((l.got - old) * 1000) / 1000);
    RV.last = pid; saveSoon(); render();
  }
  function undoLast() {
    const i = RV.log.findIndex(x => (x.k === 'ok' || x.k === 'over' || x.k === 'manual') && x.pid && !x.undone); if (i < 0) { flash('warn', 'مفيش مسحة أرجّعها'); render(); return; }
    const x = RV.log[i]; x.undone = true; const l = RV.lines.find(y => y.pid === x.pid); if (l) l.got = Math.max(0, Math.round((l.got - (x.q || 1)) * 1000) / 1000);
    RV.log.unshift({ at: nowIso(), k: 'undo', pid: x.pid, q: -(x.q || 1) }); if (window.MZ_PK) MZ_PK.onItem(RV.inv, x.pid, -(x.q || 1)); flash('ok', `اترجّعت آخر مسحة: ${pname(x.pid)}`); saveSoon(); render();
  }
  async function finish() {
    if (!RV.inv) return; const s = sums();
    const bad = RV.lines.filter(l => st(l) !== 'done');
    const markPrep = async () => { const c = prn(RV.inv.id) || {}; await put('prints', RV.inv.id, { ...c, prepAt: nowIso(), prepBy: who(), reviewed: true }); };
    if (s.ok) {
      const inv = RV.inv; RV.reason = ''; await put('picks', inv.id, docOf('ok')); RV.dirty = false; await markPrep().catch(() => {});
      toast(`✓ المراجعة اتسجّلت — ${TYPES[inv.type].full} ${inv.no} مطابقة واتعلّمت «اتحضرت»`); beep('done');
      const next = queue().find(i => i.id !== inv.id); RV.inv = null; RV.lines = []; RV.log = [];
      RV.flash = { kind: 'done', text: `✓ #${inv.no} اتقفلت مطابقة`, sub: next ? `الجاية في الطابور: #${next.no} — ${partyName(next.partyId) || 'نقدي'}` : 'الطابور فاضي 👌', at: Date.now() };
      history.replaceState(null, '', '#/pick'); render();
      if (window.MZ_PK && inv.type === 'sale' && !MZ_PK.has(inv)) MZ_PK.quickModal(inv);
      return;
    }
    modal(`<h2>الأوردر لسه مش مطابق</h2>
      <div class="tw" style="max-height:40vh;overflow:auto"><table class="t"><thead><tr><th>الصنف</th><th class="n">المطلوب</th><th class="n">اتمسح</th><th>الحالة</th></tr></thead><tbody>${bad.map(l => `<tr class="rv-${st(l)}"><td>${esc(pname(l.pid))}</td><td class="n">${fq(l.req)}</td><td class="n">${fq(l.got)}</td><td>${st(l) === 'excess' ? 'زيادة ' + fq(l.got - l.req) : 'ناقص ' + fq(l.req - l.got)}</td></tr>`).join('')}</tbody></table></div>
      <label class="f" style="margin-top:12px">السبب (مطلوب لو هتقفلها كده)<input class="in" id="rv_r" placeholder="مثلًا: الصنف خلصان على الرف — هيتبعت بكره"></label>
      <div class="row" style="margin-top:14px"><button class="btn" data-close>رجوع للمراجعة</button><span class="sp"></span><button class="btn s" id="rv_pp">${ic('print')}اطبع النواقص</button><button class="btn d" id="rv_sv">اقفلها بالنواقص</button></div>`);
    document.getElementById('rv_pp').onclick = () => printReport(true);
    document.getElementById('rv_sv').onclick = async () => {
      const r = document.getElementById('rv_r').value.trim(); if (!r) { toast('اكتب السبب', 'err'); return; }
      RV.reason = r; const inv = RV.inv; const status = RV.lines.some(l => st(l) === 'excess') ? 'over' : 'short';
      await put('picks', inv.id, docOf(status)); RV.dirty = false; closeModal(); toast(`اتسجّلت المراجعة ${status === 'over' ? 'بزيادة' : 'بنواقص'} — السبب: ${r}`, 'err');
      RV.inv = null; RV.lines = []; RV.log = []; RV.flash = { kind: 'warn', text: `#${inv.no} اتقفلت ${status === 'over' ? 'بزيادة' : 'بنواقص'}`, sub: r, at: Date.now() }; history.replaceState(null, '', '#/pick'); render();
    };
  }
  async function pause() { await saveNow(); RV.flash = { kind: 'ok', text: `#${RV.inv.no} اتعلّقت — تقدر تكمّلها بعدين من أي جهاز`, sub: '', at: Date.now() }; RV.inv = null; RV.lines = []; RV.log = []; history.replaceState(null, '', '#/pick'); render(); }

  /* ---------- الطابور ---------- */
  function queue() {
    const from = addDays(today(), -2);
    return L('invoices').filter(i => RVT.includes(i.type) && (i.date || '') >= from && !(prn(i.id) && prn(i.id).prepAt) && !(pk(i.id) && pk(i.id).status && pk(i.id).status !== 'open'))
      .sort((a, b) => ((prn(b.id) && prn(b.id).n ? 1 : 0) - (prn(a.id) && prn(a.id).n ? 1 : 0)) || (a.createdAt || '').localeCompare(b.createdAt || ''));
  }

  /* ---------- تقرير المراجعة ---------- */
  function reportHTML(p, onlyBad) {
    const inv = L('invoices').find(i => i.id === p.invId) || {}; const ls = Object.entries(p.lines || {}).map(([pid, x]) => ({ pid, ...x })).sort((a, b) => pname(a.pid).localeCompare(pname(b.pid), 'ar'));
    const rows = (onlyBad ? ls.filter(l => Math.abs(l.got - l.req) > 0.0001) : ls);
    const errs = (p.log || []).filter(x => ['notin', 'unknown', 'over'].includes(x.k));
    const s = settings(); const ttl = { ok: 'مطابقة ✓', short: 'بنواقص', over: 'بزيادة', open: 'لسه مفتوحة' }[p.status] || '';
    return `<div style="border-bottom:2px solid #000;padding-bottom:6px;display:flex;justify-content:space-between"><div><h2 style="margin:0">${esc(s.company || '')}</h2><div>${onlyBad ? 'قائمة النواقص والزيادات' : 'تقرير مراجعة التحضير'}</div></div>
      <div style="text-align:left"><h2 style="margin:0">${esc((TYPES[p.type] || {}).full || '')} رقم ${esc(p.no)}</h2><div>${esc(partyName(p.partyId) || 'نقدي')} — ${esc(p.date || '')}</div></div></div>
      <p>المراجع: <b>${esc(p.by || '')}</b> — البداية ${esc(ltm(p.start))}${p.end ? ' — النهاية ' + esc(ltm(p.end)) + ' — المدة ' + durTxt(p.start, p.end) : ''} — النتيجة: <b>${ttl}</b>${p.reason ? ' — السبب: ' + esc(p.reason) : ''}</p>
      <table><thead><tr><th>م</th><th>الصنف</th><th>المطلوب</th><th>اتجهز</th><th>الفرق</th></tr></thead><tbody>${rows.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(pname(l.pid))}</td><td>${fq(l.req)}</td><td>${fq(l.got)}</td><td>${Math.abs(l.got - l.req) < 0.0001 ? '✓' : (l.got > l.req ? '+' : '') + fq(l.got - l.req)}</td></tr>`).join('') || '<tr><td colspan="5">مفيش فروقات ✓</td></tr>'}</tbody></table>
      ${errs.length && !onlyBad ? `<h3>الأخطاء اللي اتمسكت وقت المراجعة (${errs.length})</h3><table><tbody>${errs.map(x => `<tr><td>${esc(ltm(x.at).slice(11))}</td><td>${x.k === 'notin' ? 'صنف مش في الأوردر' : x.k === 'unknown' ? 'باركود مش معروف' : 'كمية زيادة'}</td><td>${esc(x.pid ? pname(x.pid) : x.code || '')}</td></tr>`).join('')}</tbody></table>` : ''}
      <div style="display:flex;justify-content:space-between;margin-top:30px"><div>توقيع المراجع: ..............</div><div>توقيع المستلم: ..............</div></div>`;
  }
  function printReport(onlyBad, p) {
    p = p || (RV.inv ? docOf('open') : null); if (!p) return;
    const el = document.getElementById('print'); el.className = ''; el.innerHTML = reportHTML(p, onlyBad); setTimeout(() => { try { window.print(); } catch (e) {} }, 50);
  }

  /* ---------- الشاشة ---------- */
  const css = `
  .rv-scan{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .rv-scan input{flex:1 1 280px;font-size:22px;padding:14px 16px;text-align:center;border:2px solid var(--brand);border-radius:14px;background:var(--surface);color:var(--ink);font-family:inherit}
  .rv-scan input:focus{outline:none;box-shadow:0 0 0 5px color-mix(in srgb,var(--brand) 20%,transparent)}
  .rv-flash{margin:12px 0;padding:14px 18px;border-radius:14px;font-size:20px;font-weight:700;display:flex;flex-direction:column;gap:2px;animation:rvpop .25s ease-out}
  .rv-flash small{font-size:14px;font-weight:500;opacity:.9}
  .rv-flash.ok{background:color-mix(in srgb,var(--brand) 14%,var(--surface));color:var(--brand);border:2px solid color-mix(in srgb,var(--brand) 40%,transparent)}
  .rv-flash.done{background:var(--brand);color:#fff}
  .rv-flash.warn{background:#fff3cd;color:#7a5200;border:2px solid #e0b040}
  .rv-flash.err{background:var(--danger);color:#fff;animation:rvshake .45s}
  @keyframes rvpop{from{transform:scale(.97);opacity:.4}to{transform:none;opacity:1}}
  @keyframes rvshake{0%,100%{transform:none}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
  .rv-prog{height:12px;border-radius:99px;background:var(--line);overflow:hidden;margin-top:8px}.rv-prog i{display:block;height:100%;background:linear-gradient(90deg,var(--brand),var(--brand2,var(--brand)));transition:width .3s}
  #rvT tr.rv-pending td{background:transparent}
  #rvT tr.rv-partial td,.rv-partial td{background:#fff6cc}
  #rvT tr.rv-done td,.rv-done td{background:#d9f2df}
  #rvT tr.rv-excess td,.rv-excess td{background:#f8d0cb}
  #rvT tr.rv-last td{box-shadow:inset 0 2px 0 var(--brand),inset 0 -2px 0 var(--brand)}
  @media (prefers-color-scheme:dark){#rvT tr.rv-partial td,.rv-partial td{background:#3d3412}#rvT tr.rv-done td,.rv-done td{background:#143524}#rvT tr.rv-excess td,.rv-excess td{background:#4a1d17}.rv-flash.warn{background:#3d3412;color:#f3d27a}}
  .rv-q{display:flex;align-items:center;gap:4px;justify-content:center}.rv-q input{width:64px;text-align:center}
  .rv-big{font:700 30px/1 var(--display,inherit)}
  .rv-mult{background:var(--gold,#c49a4c);color:#1e1606;border-radius:10px;padding:8px 12px;font-weight:700}
  @media (max-width:860px){.rv-scan input{font-size:19px;padding:12px}.rv-flash{font-size:17px}.rv-hide-m{display:none}}`;
  function ensureCss() { if (!document.getElementById('rvcss')) { const s = document.createElement('style'); s.id = 'rvcss'; s.textContent = css; document.head.appendChild(s); } }

  window.vPick = function () {
    const keep = document.getElementById('rvI'); const keepV = keep ? keep.value : '';
    ensureCss(); setTitle('مراجعة التحضير');
    if (!canRev()) { denied('ليس لديك صلاحية مراجعة التحضير'); return; }
    const a = route().a; if (a[0] && (!RV.inv || RV.inv.id !== a[0])) { const inv = L('invoices').find(i => i.id === a[0]); if (inv) { open(inv); return; } }
    if (RV.inv) { const fresh = L('invoices').find(i => i.id === RV.inv.id); if (fresh && fresh.updatedAt !== RV.inv.updatedAt) { // الفاتورة اتعدلت وانت بتراجع
        const got = new Map(RV.lines.map(l => [l.pid, l.got])); RV.inv = fresh; RV.lines = linesOf(fresh); RV.lines.forEach(l => l.got = got.get(l.pid) || 0); RV.flash = { kind: 'warn', text: '⚠ الفاتورة اتعدّلت وانت بتراجع — الكميات المطلوبة اتحدّثت', sub: '', at: Date.now() }; beep('warn'); } }
    const tabs = `<div class="seg" style="margin-bottom:14px"><button data-rt="work" class="${RV.tab === 'work' ? 'on' : ''}">المراجعة</button><button data-rt="hist" class="${RV.tab === 'hist' ? 'on' : ''}">سجل المراجعات والأداء</button></div>`;
    const fl = RV.flash && Date.now() - RV.flash.at < 60000 ? `<div class="rv-flash ${RV.flash.kind}" id="rvF">${esc(RV.flash.text)}${RV.flash.sub ? `<small>${esc(RV.flash.sub)}</small>` : ''}</div>` : '';
    let body = '';
    if (RV.tab === 'hist') body = histHTML();
    else if (!RV.inv) {
      const q = queue(); const openOnes = L('picks').filter(p => p.status === 'open' && (p.upd || '') >= addDays(today(), -2));
      body = `<div class="card"><h3 style="margin-top:0">${ic('bar', 'style="width:20px;height:20px;vertical-align:-4px"')} امسح باركود الفاتورة المطبوعة أو اكتب رقمها</h3>
        <div class="rv-scan"><input id="rvI" autocomplete="off" inputmode="text" placeholder="باركود الفاتورة / رقمها ثم Enter">${camBtn()}</div>${fl}
        <p class="small muted" style="margin-bottom:0">الفواتير المطبوعة من ميزان عليها باركود — امسحه يفتح الأوردر على طول.</p></div>
        ${openOnes.length ? `<div class="card" style="margin-top:14px"><h3 style="margin-top:0">مراجعات متعلّقة — كمّلها</h3><div class="tw"><table class="t"><thead><tr><th>رقم</th><th>العميل</th><th>بدأها</th><th>آخر تحديث</th><th class="n">التقدّم</th><th></th></tr></thead><tbody>${openOnes.map(p => { const ls = Object.values(p.lines || {}); const r = ls.reduce((s, x) => s + x.req, 0), g = ls.reduce((s, x) => s + Math.min(x.got, x.req), 0); return `<tr><td class="num"><b>${esc(p.no)}</b></td><td>${esc(partyName(p.partyId) || 'نقدي')}</td><td>${esc(p.by || '')}</td><td class="small">${esc(ltm(p.upd))}</td><td class="n">${r ? Math.round(g / r * 100) : 0}%</td><td><button class="btn s p" data-rvo="${p.invId}">كمّل</button></td></tr>`; }).join('')}</tbody></table></div></div>` : ''}
        <div class="card" style="margin-top:14px"><div class="row"><h3 style="margin:0">طابور التحضير</h3><span class="tag ${q.length ? 'bad' : 'ok'}">${q.length} فاتورة مستنية مراجعة</span><span class="sp"></span><span class="small muted">آخر 3 أيام — اللي اتطبعت الأول</span></div>
        ${q.length ? `<div class="tw" style="margin-top:10px"><table class="t"><thead><tr><th>رقم</th><th>الوقت</th><th>العميل</th><th class="n">أصناف</th><th class="n">قطع</th><th>الطباعة</th><th></th></tr></thead><tbody>${q.slice(0, 60).map(i => { const p = prn(i.id); const n = (i.lines || []).reduce((s, l) => s + (+l.qty || 0), 0); return `<tr><td class="num"><b>${esc(i.no)}</b>${i.type !== 'sale' ? ` <span class="tag ${i.type}">${TYPES[i.type].t}</span>` : ''}</td><td class="small num">${i.date !== today() ? esc(i.date) + ' ' : ''}${esc(ltm(i.createdAt).slice(11, 16))}</td><td>${esc(partyName(i.partyId) || 'نقدي')}</td><td class="n">${linesOf(i).length}</td><td class="n">${fq(n)}</td><td>${p && p.n ? '<span class="tag ok">اتطبعت</span>' : '<span class="tag">لسه</span>'}</td><td><button class="btn s p" data-rvo="${i.id}">راجع</button></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">مفيش فواتير مستنية مراجعة 👌</p>'}</div>`;
    } else {
      const inv = RV.inv, s = sums(); const showLines = RV.lines.filter(l => !RV.hideDone || st(l) !== 'done');
      const order = { excess: 0, partial: 1, pending: 2, done: 3 };
      const sorted = showLines.slice().sort((x, y) => (x.pid === RV.last ? -1 : y.pid === RV.last ? 1 : 0) || order[st(x)] - order[st(y)] || pname(x.pid).localeCompare(pname(y.pid), 'ar'));
      const errs = RV.log.filter(x => ['notin', 'unknown', 'over'].includes(x.k));
      body = `<div class="card" style="padding:14px 16px"><div class="row" style="align-items:flex-start">
          <div style="flex:1;min-width:220px"><div class="small muted">${esc(TYPES[inv.type].full)} — ${esc(inv.date)} — المدة ${durTxt(RV.start)}</div>
            <div class="rv-big">#${esc(inv.no)} — ${esc(partyName(inv.partyId) || (inv.type === 'transfer' ? storeName(inv.storeId) + ' ← ' + storeName(inv.toStoreId) : 'عميل نقدي'))}</div>
            <div class="rv-prog"><i style="width:${s.pct}%"></i></div>
            <div class="row small" style="margin-top:8px;gap:6px"><span class="tag ok">مطابق ${s.c.done}</span><span class="tag purchase">ناقص ${s.c.partial}</span><span class="tag">لم يبدأ ${s.c.pending}</span>${s.c.excess ? `<span class="tag bad">زيادة ${s.c.excess}</span>` : ''}<span class="muted">— ${fq(s.got)} من ${fq(s.req)} قطعة (${s.pct}%)</span>${s.errs ? `<span class="tag bad">أخطاء اتمسكت ${s.errs}</span>` : ''}</div></div>
          <div class="row" style="gap:6px"><button class="btn ${s.ok ? 'p' : ''}" id="rvFin">${s.ok ? '✓ إنهاء المراجعة' : 'إنهاء المراجعة'}</button><button class="btn s" id="rvPause" title="تقفلها مؤقتًا وتكملها بعدين">تعليق</button><button class="btn s" id="rvRep">${ic('print')}تقرير</button><button class="btn s" id="rvRestart" title="تصفير العدّ والبدء من الأول">من الأول</button></div></div>
        <div class="rv-scan" style="margin-top:12px">${RV.mult > 1 ? `<span class="rv-mult">×${RV.mult}</span>` : ''}<input id="rvI" autocomplete="off" placeholder="امسح باركود الصنف"><button class="btn" id="rvUndo" title="تراجع عن آخر مسحة">↶ تراجع</button>${camBtn()}</div>${fl}
        <div class="small muted" style="margin-top:6px">لكمية كبيرة: اكتب العدد و* (مثلًا 12*) وبعدين امسح الصنف مرة واحدة.</div>${RV.pendingOpen ? `<div class="row small" style="margin-top:-4px"><button class="btn s" id="rvGoPend">افتح الفاتورة التانية برضه</button></div>` : ''}</div>
        <div class="row" style="margin:12px 0 8px"><label class="row small" style="gap:6px"><input type="checkbox" id="rvHide" ${RV.hideDone ? 'checked' : ''}>اخفي الأصناف المطابقة</label><span class="sp"></span><span class="small muted">الأصناف اللي فيها مشكلة بتطلع فوق، وآخر صنف اتمسح أول سطر</span></div>
        <div class="tw"><table class="t" id="rvT"><thead><tr><th>الصنف</th><th class="rv-hide-m">الباركود</th><th class="n">المطلوب</th><th class="n" style="text-align:center">اتجهز</th><th class="n">باقي</th><th>الحالة</th></tr></thead><tbody>
        ${sorted.map(l => { const p = G('products', l.pid) || {}; const k = st(l); return `<tr class="rv-${k} ${l.pid === RV.last ? 'rv-last' : ''}"><td><b>${esc(pname(l.pid))}</b><div class="small muted">${esc(p.code || '')}${p.unit ? ' · ' + esc(p.unit) : ''}</div></td><td class="small num rv-hide-m">${esc(p.barcode || '—')}</td><td class="n"><b>${fq(l.req)}</b></td>
          <td><div class="rv-q"><button class="btn ic s" data-rvm="${l.pid}" title="ناقص واحد">−</button><input class="cell n" data-rvs="${l.pid}" value="${fq(l.got)}" inputmode="decimal"><button class="btn ic s" data-rvp="${l.pid}" title="زود واحد">+</button></div></td>
          <td class="n ${l.got > l.req ? 'neg' : ''}">${l.got > l.req ? '+' + fq(l.got - l.req) : fq(l.req - l.got)}</td><td><b>${ST_T[k]}</b></td></tr>`; }).join('') || '<tr><td colspan="6"><div class="empty"><b>كل الأصناف مطابقة ✓</b></div></td></tr>'}</tbody></table></div>
        ${window.MZ_PK ? MZ_PK.reviewPanel(inv) : ''}
        ${errs.length ? `<div class="card" style="margin-top:14px;border-color:var(--danger)"><h3 style="margin-top:0;color:var(--danger)">أخطاء اتمسكت في الأوردر ده (${errs.length})</h3><table class="t"><tbody>${errs.slice(0, 20).map(x => `<tr><td class="small num">${esc(ltm(x.at).slice(11))}</td><td>${x.k === 'notin' ? '⛔ صنف مش في الأوردر' : x.k === 'unknown' ? '❓ باركود مش معروف' : '⚠ كمية زيادة'}</td><td>${esc(x.pid ? pname(x.pid) : x.code || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    }
    $('#view').innerHTML = `<div class="wrap">${tabs}${body}</div>`;
    if (keepV) { const ni = document.getElementById('rvI'); if (ni) ni.value = keepV; }
    bind();
  };
  function camBtn() { return 'BarcodeDetector' in window ? `<button class="btn" id="rvCam" title="امسح بكاميرا الموبايل">📷 كاميرا</button>` : ''; }

  function histHTML() {
    const from = addDays(today(), -(RV.hist - 1));
    const xs = L('picks').filter(p => p.status && p.status !== 'open' && (p.end || '').slice(0, 10) >= from).sort((a, b) => (b.end || '').localeCompare(a.end || ''));
    const by = {}; xs.forEach(p => { const o = by[p.by || '—'] || (by[p.by || '—'] = { n: 0, ok: 0, errs: 0, min: 0, units: 0 }); o.n++; if (p.status === 'ok') o.ok++; o.errs += p.errs || 0; o.min += mins(p.start, p.end); o.units += p.units || 0; });
    const tot = xs.length, ok = xs.filter(p => p.status === 'ok').length, errs = xs.reduce((s, p) => s + (p.errs || 0), 0);
    return `<div class="row" style="margin-bottom:12px"><div class="seg">${[[1, 'النهارده'], [7, 'آخر أسبوع'], [30, 'آخر شهر']].map(([d, t]) => `<button data-rh="${d}" class="${RV.hist == d ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="strip" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px"><div><div class="k">أوردرات اتراجعت</div><div class="v">${tot}</div></div><div><div class="k">مطابقة من أول مرة</div><div class="v pos">${tot ? Math.round(ok / tot * 100) : 0}%</div><div class="s">${ok} من ${tot}</div></div><div><div class="k">أخطاء اتمسكت قبل الشنطة</div><div class="v">${errs}</div><div class="s">صنف غلط أو زيادة اتلحق</div></div></div>
      <div class="card"><h3 style="margin-top:0">أداء المراجعين</h3><div class="tw"><table class="t"><thead><tr><th>المراجع</th><th class="n">أوردرات</th><th class="n">مطابقة</th><th class="n">قطع</th><th class="n">متوسط الوقت</th><th class="n">أخطاء اتمسكت</th></tr></thead><tbody>${Object.entries(by).sort((a, b) => b[1].n - a[1].n).map(([k, o]) => `<tr><td><b>${esc(k)}</b></td><td class="n">${o.n}</td><td class="n">${o.ok}</td><td class="n">${fq(o.units)}</td><td class="n">${o.n ? Math.round(o.min / o.n * 10) / 10 : 0} د</td><td class="n">${o.errs}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">مفيش مراجعات في الفترة دي</td></tr>'}</tbody></table></div></div>
      <div class="card" style="margin-top:14px"><h3 style="margin-top:0">المراجعات</h3><div class="tw"><table class="t"><thead><tr><th>رقم</th><th>العميل</th><th>المراجع</th><th>انتهت</th><th class="n">المدة</th><th>النتيجة</th><th class="n">أخطاء</th><th></th></tr></thead><tbody>${xs.slice(0, 200).map(p => `<tr><td class="num"><b>${esc(p.no)}</b></td><td>${esc(partyName(p.partyId) || 'نقدي')}</td><td>${esc(p.by || '')}</td><td class="small">${esc(ltm(p.end))}</td><td class="n">${durTxt(p.start, p.end)}</td><td>${p.status === 'ok' ? '<span class="tag ok">مطابقة</span>' : `<span class="tag bad" title="${esc(p.reason || '')}">${p.status === 'over' ? 'بزيادة' : 'بنواقص'}</span>`}</td><td class="n">${p.errs || 0}</td><td style="white-space:nowrap"><button class="btn s" data-rvr="${p.invId}">${ic('print')}تقرير</button> <button class="btn s" data-rvo="${p.invId}">مراجعة تاني</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">مفيش</td></tr>'}</tbody></table></div></div>`;
  }

  function bind() {
    if (window.MZ_PK && RV.inv) MZ_PK.bindReview(RV.inv, render);
    const I = document.getElementById('rvI');
    if (I) {
      I.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); const v = I.value; I.value = ''; scan(v); } };
      setTimeout(() => { if (!document.getElementById('modal').classList.contains('on')) I.focus(); }, 30);
      I.onblur = () => setTimeout(() => { const a = document.activeElement; if (route().p === 'pick' && RV.tab === 'work' && document.getElementById('rvI') === I && !document.getElementById('modal').classList.contains('on') && (!a || a === document.body || a.tagName === 'BUTTON')) I.focus(); }, 250);
    }
    $$('[data-rt]').forEach(b => b.onclick = () => { RV.tab = b.dataset.rt; render(); });
    $$('[data-rh]').forEach(b => b.onclick = () => { RV.hist = +b.dataset.rh; render(); });
    $$('[data-rvo]').forEach(b => b.onclick = () => { RV.tab = 'work'; const inv = L('invoices').find(i => i.id === b.dataset.rvo); const p = pk(b.dataset.rvo); open(inv, { fresh: p && p.status !== 'open' }); });
    $$('[data-rvr]').forEach(b => b.onclick = () => printReport(false, pk(b.dataset.rvr)));
    $$('[data-rvp]').forEach(b => b.onclick = () => adjust(b.dataset.rvp, 1));
    $$('[data-rvm]').forEach(b => b.onclick = () => adjust(b.dataset.rvm, -1));
    $$('[data-rvs]').forEach(x => { x.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); x.blur(); } }; x.onchange = () => adjust(x.dataset.rvs, 0, String(x.value).replace(/[^\d.]/g, '')); });
    const h = document.getElementById('rvHide'); if (h) h.onchange = () => { RV.hideDone = h.checked; render(); };
    const f = document.getElementById('rvFin'); if (f) f.onclick = finish;
    const ps = document.getElementById('rvPause'); if (ps) ps.onclick = pause;
    const rp = document.getElementById('rvRep'); if (rp) rp.onclick = () => printReport(false);
    const u = document.getElementById('rvUndo'); if (u) u.onclick = undoLast;
    const rs = document.getElementById('rvRestart'); if (rs) rs.onclick = async () => { if (!(await confirmBox('تصفير كل الكميات اللي اتمسحت والبدء من الأول؟', 'تصفير', true))) return; RV.lines.forEach(l => l.got = 0); RV.log.unshift({ at: nowIso(), k: 'reset' }); RV.last = null; saveSoon(); render(); };
    const gp = document.getElementById('rvGoPend'); if (gp) gp.onclick = async () => { const id = RV.pendingOpen; RV.pendingOpen = null; await saveNow(); open(L('invoices').find(i => i.id === id)); };
    const cm = document.getElementById('rvCam'); if (cm) cm.onclick = camera;
  }

  /* ---------- كاميرا الموبايل ---------- */
  async function camera() {
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch (e) { toast('مقدرتش أفتح الكاميرا — اسمح بالإذن من المتصفح', 'err'); return; }
    modal(`<h2>وجّه الكاميرا على الباركود</h2><video id="rvV" playsinline muted style="width:100%;border-radius:12px;background:#000"></video><p class="small muted" id="rvVs">بدوّر…</p><div class="row"><span class="sp"></span><button class="btn" data-close id="rvVc">قفل</button></div>`);
    const v = document.getElementById('rvV'); v.srcObject = stream; await v.play().catch(() => {});
    const det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf', 'qr_code'] });
    let alive = true, lastV = '', lastT = 0;
    const stop = () => { alive = false; stream.getTracks().forEach(t => t.stop()); };
    const mo = new MutationObserver(() => { if (!document.getElementById('rvV')) { stop(); mo.disconnect(); } }); mo.observe(document.getElementById('modal'), { childList: true });
    const tick = async () => { if (!alive) return; try { const r = await det.detect(v); if (r[0]) { const val = r[0].rawValue; if (val !== lastV || Date.now() - lastT > 1500) { lastV = val; lastT = Date.now(); const s = document.getElementById('rvVs'); if (s) s.textContent = 'اتقري: ' + val; const wasOpen = !!RV.inv; scan(val); if (!wasOpen && RV.inv) { closeModal(); return; } } } } catch (e) {} setTimeout(tick, 180); };
    tick();
  }

  /* ---------- باركود على الفاتورة المطبوعة ---------- */
  window.MZ_RV_code = invCode;
  window.MZ_RV_bc = function (root) {
    try { (root || document).querySelectorAll('svg[data-invbc]').forEach(el => { try { JsBarcode(el, el.dataset.invbc, { format: 'CODE128', height: 34, width: 1.4, displayValue: true, fontSize: 11, margin: 0, textMargin: 1 }); } catch (e) { el.remove(); } }); } catch (e) {}
  };
  // للمساعد
  AI_hook();
  function AI_hook() { const A = window.MZ_AI; if (A) A.review = { open: inv => { go('pick/' + inv.id); }, queue }; }
  window.MZ_RV_api = { scan, open, finish, queue, resolve, sums, close };
})();
