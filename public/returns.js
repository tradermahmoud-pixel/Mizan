/* ميزان — استلام المرتجعات من الصيدليات.
   ١) المندوب في الصيدلية: يمسح/يدوّر على الأصناف الراجعة بكمياتها وسبب كل صنف → إذن مرتجع برقم (R-1234) يكتبه على الشنطة،
      وإيصال للصيدلية على واتساب. ممكن المدير يطلب المرتجع مسبقًا كمحطة في خط السير.
   ٢) المخزن لما المندوب يرجع: يفتح الإذن بالرقم، يعدّ اللي وصل فعلًا بالباركود، ويحدد حالة كل صنف (صالح / تالف / منتهي / مرفوض).
      أي فرق بين اللي المندوب سجّله واللي وصل بيظهر بالأحمر ويتسجّل.
   ٣) الاعتماد: بيفتح فاتورة مرتجع المبيعات متعبّية بآخر سعر اتباع بيه للصيدلية — الصالح على المخزن الرئيسي والتالف على مخزن التالف —
      وكل قيود البرنامج بتشتغل (مايرجعش أكتر من اللي اتباع، الفترات المقفولة...). وبعد الحفظ رصيد الصيدلية بيتظبط لوحده. */
(function () {
  'use strict';
  const RT = { tab: 'collected', cur: null, form: null, recv: null }; window.MZ_RT = RT;
  const nowIso = () => new Date().toISOString();
  const who = () => (S.me && S.me.name) || '';
  const REASONS = [['exp', 'منتهي الصلاحية'], ['near', 'قرب ينتهي'], ['dmg', 'تالف / مكسور'], ['wrong', 'غلط في الطلب'], ['extra', 'زيادة / مش محتاجه'], ['slow', 'مبيتباعش عنده'], ['other', 'أخرى']];
  const RNAME = Object.fromEntries(REASONS);
  const COND = [['good', 'صالح للبيع'], ['bad', 'تالف'], ['exp', 'منتهي'], ['reject', 'مرفوض — يرجع للصيدلية']];
  const CNAME = Object.fromEntries(COND);
  const ST = { requested: ['مطلوب استلامه', 'purchase'], collected: ['مع المندوب', 'bad'], received: ['اتستلم في المخزن', 'purchase'], done: ['اتعمل مرتجع', 'ok'], cancel: ['اتلغى', ''] };
  const isDrv = () => can('delivery');
  const canRecv = () => S.isAdmin || can('buy') || can('products') || can('prep');
  const canApprove = () => S.isAdmin || can('sell');
  const canSee = () => isDrv() || canRecv() || canApprove() || can('deliveryManage');
  const all = () => L('rets');
  const get = id => { const d = G('rets', id); return d ? { ...d, id } : null; };
  async function save(r) { const d = { ...r }; delete d.id; d.upd = nowIso(); await put('rets', r.id, d); }
  function newCode() { let c; do { c = 'R-' + (1000 + Math.floor(Math.random() * 9000)); } while (all().some(x => x.code === c && x.status !== 'done')); return c; }
  const fromCode = raw => { const v = fixBc(String(raw || '').trim()).toUpperCase().replace(/\s/g, ''); const m = v.match(/^R-?(\d{4})$/); return m ? all().filter(x => x.code === 'R-' + m[1]).sort((a, b) => (b.at || '').localeCompare(a.at || ''))[0] : null; };
  function resolveBc(raw) { const v = String(raw || '').trim(); if (!v) return null; const ps = L('products'); for (const x of [v, fixBc(v)]) { const p = ps.find(p => bcEq(p, x)); if (p) return p.id; } return null; }
  const price = (pid, partyId) => { const d = lastDeal(pid, { type: 'sret', partyId }); if (d) return { price: d.price, disc: d.disc, cost: d.cost, inv: d.inv }; const p = G('products', pid); return { price: p ? salePrice(p, partyId) : 0, disc: 0, cost: null, inv: null }; };
  const valOf = r => (r.lines || []).reduce((s, l) => s + (+l.qty || 0) * price(l.pid, r.partyId).price, 0);
  async function gps() { try { return await new Promise(res => { if (!navigator.geolocation) return res(null); const t = setTimeout(() => res(null), 6000); navigator.geolocation.getCurrentPosition(p => { clearTimeout(t); res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) }); }, () => { clearTimeout(t); res(null); }, { enableHighAccuracy: true, timeout: 5500, maximumAge: 30000 }); }); } catch (e) { return null; } }
  const beep = k => { try { window.MZ_PK && MZ_PK.beep(k); } catch (e) {} };

  /* ---------- ١) المندوب: إذن استلام مرتجع ---------- */
  // ctx: {partyId, runId, reqId}
  RT.collect = function (ctx) {
    const req = ctx.reqId ? get(ctx.reqId) : null;
    RT.form = { partyId: ctx.partyId || (req && req.partyId) || '', runId: ctx.runId || (req && req.runId) || '', reqId: req ? req.id : '', lines: [], note: req && req.reqNote ? '' : '', reason: 'exp' };
    drawForm();
  };
  function drawForm() {
    const F = RT.form; const p = F.partyId ? G('parties', F.partyId) || {} : null; const req = F.reqId ? get(F.reqId) : null;
    const custs = L('parties').filter(x => x.kind !== 'vendor').sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    modal(`<h2>↩️ استلام مرتجع${p ? ' — ' + esc(p.name) : ''}</h2>
      ${req && req.reqNote ? `<div class="card" style="padding:8px 12px;margin-bottom:8px;border-color:var(--gold)">طلب المدير: ${esc(req.reqNote)}</div>` : ''}
      ${p ? '' : `<label class="f">الصيدلية<select class="in" id="rt_p">${opts(custs.map(c => [c.id, c.name]), '', '— اختار الصيدلية —')}</select></label>`}
      <div class="row" style="gap:6px;margin-top:8px;flex-wrap:nowrap"><input class="in" id="rt_s" autocomplete="off" placeholder="امسح باركود الصنف أو اكتب اسمه" style="flex:1">${'BarcodeDetector' in window ? '<button class="btn" id="rt_cam" type="button">📷</button>' : ''}</div>
      <div class="sugg" id="rt_sg" hidden style="position:static;max-height:200px;overflow:auto;margin-top:4px"></div>
      <div class="row small" style="margin-top:6px;gap:6px">السبب للأصناف الجاية:<select class="in" id="rt_r" style="width:auto;padding:4px 8px">${opts(REASONS, F.reason)}</select></div>
      <div id="rt_l" style="margin-top:8px"></div>
      <label class="f" style="margin-top:8px">ملاحظة<input class="in" id="rt_n" value="${esc(F.note || '')}" placeholder="مثلًا: د. أحمد سلّم المرتجع"></label>
      <p class="small" id="rt_m" style="min-height:18px;margin:6px 0"></p>
      <div class="row"><button class="btn p" id="rt_ok">حفظ إذن المرتجع</button><button class="btn" data-close>إلغاء</button></div>`, true);
    const msg = (t, bad) => { const e = document.getElementById('rt_m'); if (e) { e.textContent = t; e.style.color = bad ? 'var(--danger)' : 'var(--brand)'; } };
    const drawLines = () => {
      const el = document.getElementById('rt_l'); if (!el) return;
      el.innerHTML = F.lines.length ? `<div class="tw"><table class="t"><thead><tr><th>الصنف</th><th style="text-align:center">الكمية</th><th>السبب</th><th>الصلاحية</th><th></th></tr></thead><tbody>${F.lines.map((l, i) => `<tr><td><b>${esc(pname(l.pid))}</b></td>
        <td><div class="rv-q" style="display:flex;gap:4px;align-items:center;justify-content:center"><button class="btn ic s" type="button" data-rq="${i}:-1">−</button><input class="cell n" style="width:56px;text-align:center" data-rqv="${i}" value="${fq(l.qty)}" inputmode="decimal"><button class="btn ic s" type="button" data-rq="${i}:1">+</button></div></td>
        <td><select class="in" data-rr="${i}" style="padding:3px 6px;font-size:13px">${opts(REASONS, l.reason)}</select></td><td><input class="in" type="month" data-re="${i}" value="${esc(l.exp || '')}" style="padding:3px 6px;font-size:13px;width:130px"></td>
        <td><button class="btn ic s" type="button" data-rx="${i}">✕</button></td></tr>`).join('')}</tbody></table></div><div class="small muted" style="margin-top:4px">${F.lines.length} صنف — ${fq(F.lines.reduce((s, l) => s + l.qty, 0))} قطعة${F.partyId ? ` — تقريبًا ${fmt(F.lines.reduce((s, l) => s + l.qty * price(l.pid, F.partyId).price, 0))}` : ''}</div>` : '<div class="small muted">امسح أول صنف راجع…</div>';
      el.querySelectorAll('[data-rq]').forEach(b => b.onclick = () => { const [i, d] = b.dataset.rq.split(':').map(Number); F.lines[i].qty = Math.max(0, F.lines[i].qty + d); if (!F.lines[i].qty) F.lines.splice(i, 1); drawLines(); });
      el.querySelectorAll('[data-rqv]').forEach(x => x.onchange = () => { const i = +x.dataset.rqv; F.lines[i].qty = Math.max(0, numIn(x.value)); if (!F.lines[i].qty) F.lines.splice(i, 1); drawLines(); });
      el.querySelectorAll('[data-rr]').forEach(x => x.onchange = () => { F.lines[+x.dataset.rr].reason = x.value; });
      el.querySelectorAll('[data-re]').forEach(x => x.onchange = () => { F.lines[+x.dataset.re].exp = x.value; });
      el.querySelectorAll('[data-rx]').forEach(b => b.onclick = () => { F.lines.splice(+b.dataset.rx, 1); drawLines(); });
    };
    const add = (pid, q) => { const r = document.getElementById('rt_r').value; F.reason = r; const ex = F.lines.find(l => l.pid === pid && l.reason === r); if (ex) ex.qty += q || 1; else F.lines.unshift({ pid, qty: q || 1, reason: r }); drawLines(); beep('ok');
      if (F.partyId && !lastDeal(pid, { type: 'sret', partyId: F.partyId })) msg(`⚠️ «${pname(pid)}» مش لاقي إنه اتباع للصيدلية دي قبل كده — اتأكد إنه بتاعنا`, true); else msg(`✓ ${pname(pid)}`); };
    const sIn = document.getElementById('rt_s'), sg = document.getElementById('rt_sg');
    let hits = [];
    sIn.oninput = () => { const q = sIn.value.trim(); if (q.length < 2 || /^\d{6,}$/.test(q)) { sg.hidden = true; return; } hits = pSearch(q, 12); sg.hidden = !hits.length; sg.innerHTML = hits.map((p, k) => `<button type="button" data-k="${k}" style="display:flex;width:100%;text-align:right;padding:6px 8px;border:0;background:none;color:inherit;cursor:pointer;border-bottom:1px solid var(--line)"><b style="flex:1">${esc(p.name)}</b><span class="small muted">${esc(p.code || '')}</span></button>`).join(''); sg.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { add(hits[+b.dataset.k].id); sIn.value = ''; sg.hidden = true; sIn.focus(); }); };
    sIn.onkeydown = e => { if (e.key !== 'Enter') return; e.preventDefault(); let v = sIn.value.trim(); if (!v) return; let q = 1; const m = v.match(/^(\d+)\s*[*xX×]\s*(.+)$/); if (m) { q = +m[1]; v = m[2]; } const pid = resolveBc(v); if (pid) { add(pid, q); sIn.value = ''; sg.hidden = true; return; } if (hits.length) { add(hits[0].id, q); sIn.value = ''; sg.hidden = true; return; } beep('err'); msg('الباركود ده مش معروف — دوّر بالاسم', true); };
    const cam = document.getElementById('rt_cam'); if (cam) cam.onclick = () => MZ_PK.camScan(v => { const pid = resolveBc(v); if (pid) { add(pid, 1); return '✓ ' + pname(pid); } beep('err'); return 'مش معروف: ' + v; }, 'امسح الأصناف الراجعة');
    const ps = document.getElementById('rt_p'); if (ps) ps.onchange = () => { F.partyId = ps.value; };
    document.getElementById('rt_n').oninput = e => { F.note = e.target.value; };
    drawLines(); setTimeout(() => sIn.focus(), 60);
    document.getElementById('rt_ok').onclick = async () => {
      if (!F.partyId) { msg('اختار الصيدلية', true); return; } if (!F.lines.length) { msg('ضيف صنف واحد على الأقل', true); return; }
      const b = document.getElementById('rt_ok'); b.disabled = true; msg('بحفظ…'); const g = await gps();
      const id = F.reqId || ('rt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
      const old = F.reqId ? get(F.reqId) || {} : {};
      const r = { ...old, id, code: old.code || newCode(), partyId: F.partyId, runId: F.runId || old.runId || '', status: 'collected', lines: F.lines.map(l => ({ pid: l.pid, qty: l.qty, reason: l.reason, ...(l.exp ? { exp: l.exp } : {}) })), note: F.note || '', by: who(), byId: S.me.id || '', at: nowIso(), ...(g ? { gps: g } : {}) };
      await save(r);
      if (r.runId) { const run = G('runs', r.runId); if (run) { const d = { ...run }; delete d.id; let ch = false; (d.stops || []).forEach(s => { if (s.kind === 'pickup' && s.partyId === r.partyId && ['pending', 'arrived'].includes(s.status)) { s.status = 'delivered'; s.at = nowIso(); s.retId = id; ch = true; } }); if (ch) { d.upd = nowIso(); await put('runs', r.runId, d); } } }
      receipt(r);
    };
  }
  function receipt(r) {
    const p = G('parties', r.partyId) || {}; const qty = r.lines.reduce((s, l) => s + l.qty, 0);
    const txt = `إيصال استلام مرتجع ${r.code}\n${settings().company || ''}\nالصيدلية: ${p.name || ''}\nالتاريخ: ${ltm(r.at)}\n` + r.lines.map(l => `- ${pname(l.pid)} × ${fq(l.qty)} (${RNAME[l.reason] || ''})`).join('\n') + `\nالإجمالي: ${r.lines.length} صنف / ${fq(qty)} قطعة\nالمستلم: ${r.by}\n* المرتجع بيتراجع في المخزن وبعدها بيتخصم من حسابكم.`;
    const ph = String(p.phone || '').replace(/\D/g, ''); const wa = 'https://wa.me/' + (ph ? (ph.startsWith('0') ? '2' + ph : ph) : '') + '?text=' + encodeURIComponent(txt);
    modal(`<h2>✓ اتسجّل إذن المرتجع</h2><div style="text-align:center;margin:10px 0"><div class="small muted">اكتب الرقم ده على شنطة المرتجع</div><div style="font:800 46px/1.1 monospace;letter-spacing:3px;border:3px dashed var(--brand);border-radius:14px;padding:10px;margin-top:6px">${esc(r.code)}</div></div>
      <p class="small">${esc(p.name || '')} — ${r.lines.length} صنف / ${fq(qty)} قطعة. المخزن هيعدّه لما ترجع، وبعدها بيتخصم من حساب الصيدلية.</p>
      <div class="row"><a class="btn p" target="_blank" rel="noopener" href="${wa}">📲 ابعت الإيصال للصيدلية واتساب</a><button class="btn" data-close>تمام</button></div>`);
  }

  /* ---------- طلب استلام مرتجع (من المدير) كمحطة في خط السير ---------- */
  RT.request = async function (runId) {
    const run = runId && G('runs', runId);
    const custs = L('parties').filter(x => x.kind !== 'vendor').sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    modal(`<h2>↩️ مرتجع مطلوب استلامه</h2><label class="f">الصيدلية<select class="in" id="rq_p">${opts(custs.map(c => [c.id, c.name]), '', '— اختار —')}</select></label>
      <label class="f" style="margin-top:8px">التفاصيل للمندوب<input class="in" id="rq_n" placeholder="مثلًا: 3 علب بانتين منتهية — اتصلت الصبح"></label>
      ${run ? '<p class="small muted">هتتضاف كمحطة في خط السير ده، وهيترتّب الباقي.</p>' : ''}
      <div class="row" style="margin-top:12px"><button class="btn p" id="rq_ok">إضافة</button><button class="btn" data-close>إلغاء</button></div>`);
    document.getElementById('rq_ok').onclick = async () => {
      const pid = document.getElementById('rq_p').value; if (!pid) return; const note = document.getElementById('rq_n').value.trim();
      const id = 'rt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      await save({ id, code: newCode(), partyId: pid, runId: runId || '', status: 'requested', reqNote: note, reqBy: who(), at: nowIso(), lines: [] });
      if (run) { const d = { ...run }; delete d.id; const p = G('parties', pid) || {}; const st = { invId: 'ret:' + id, partyId: pid, kind: 'pickup', retId: id, status: 'pending', note, ...(p.loc && p.loc.lat ? { loc: { lat: p.loc.lat, lng: p.loc.lng } } : {}) };
        const i = (d.stops || []).map(s => s.partyId).lastIndexOf(pid); if (i >= 0) d.stops.splice(i + 1, 0, st); else d.stops.push(st); d.upd = nowIso(); await put('runs', runId, d); }
      closeModal(); toast('اتضاف طلب استلام المرتجع');
    };
  };

  /* ---------- ٢) المخزن: الاستلام والعدّ ---------- */
  function recvView(r) {
    if (!RT.recv || RT.recv.id !== r.id) { const base = r.recv && r.recv.lines ? r.recv.lines.map(x => ({ ...x })) : r.lines.map(l => ({ pid: l.pid, decl: l.qty, qty: 0, cond: l.reason === 'dmg' ? 'bad' : l.reason === 'exp' ? 'exp' : 'good' })); RT.recv = { id: r.id, lines: base, flash: null }; }
    const V = RT.recv; const p = G('parties', r.partyId) || {}; const done = r.status === 'received' || r.status === 'done';
    const diff = V.lines.filter(l => Math.abs((l.qty || 0) - (l.decl || 0)) > 0.0001);
    const parts = partsOf(r);
    $('#view').innerHTML = `<div class="wrap">
      <div class="row" style="margin-bottom:12px"><a href="#/rets" class="btn s">→ المرتجعات</a><span class="sp"></span><button class="btn s" id="rtPrint">${ic('print')}طباعة الإذن</button>${r.status !== 'done' && canRecv() ? '<button class="btn s" id="rtCancel">إلغاء الإذن</button>' : ''}</div>
      <div class="card"><div class="row"><div style="flex:1"><div class="small muted">${esc(ltm(r.at))} — استلمه ${esc(r.by || '')}${r.runId ? ' (خط سير)' : ''}${r.gps ? ' — 📍' : ''}</div><h2 style="margin:4px 0">${esc(r.code)} — ${esc(p.name || '')}</h2>${r.note ? `<div class="small">${esc(r.note)}</div>` : ''}</div><span class="tag ${ST[r.status][1]}">${ST[r.status][0]}</span></div></div>
      ${!done && canRecv() ? `<div class="card" style="margin-top:12px"><b>عُدّ اللي وصل فعلًا</b> <span class="small muted">— امسح كل قطعة أو اكتب العدد، وحدد حالتها</span>
        <div class="rv-scan" style="margin-top:8px;display:flex;gap:8px"><input class="in" id="rtI" autocomplete="off" placeholder="امسح باركود الصنف" style="flex:1;font-size:20px;padding:12px;text-align:center;border:2px solid var(--brand);border-radius:12px"></div>
        ${V.flash ? `<div class="rv-flash ${V.flash.k}" style="margin-top:10px;padding:12px 14px;border-radius:12px;font-weight:700;${V.flash.k === 'err' ? 'background:var(--danger);color:#fff' : 'background:color-mix(in srgb,var(--brand) 14%,var(--surface));color:var(--brand)'}">${esc(V.flash.t)}</div>` : ''}</div>` : ''}
      <div class="tw" style="margin-top:12px"><table class="t"><thead><tr><th>الصنف</th><th class="n">المندوب سجّل</th><th class="n" style="text-align:center">وصل فعلًا</th><th>الحالة</th><th>سبب الصيدلية</th><th class="n">سعر المرتجع</th></tr></thead><tbody>
      ${V.lines.map((l, i) => { const d = (l.qty || 0) - (l.decl || 0); const rl = r.lines.find(x => x.pid === l.pid) || {}; const pr = price(l.pid, r.partyId); const sold = !!pr.inv;
        return `<tr style="${Math.abs(d) > 0.0001 && (l.qty || done) ? 'background:color-mix(in srgb,var(--danger) 10%,transparent)' : (l.qty && Math.abs(d) < 0.0001 ? 'background:color-mix(in srgb,var(--brand) 9%,transparent)' : '')}"><td><b>${esc(pname(l.pid))}</b>${!l.decl ? ' <span class="tag bad">مش متسجّل عند المندوب</span>' : ''}${!sold ? ' <span class="tag bad" title="مفيش فاتورة بيع للصنف ده للصيدلية دي">مش لاقي بيع ليه</span>' : ''}</td><td class="n">${fq(l.decl || 0)}</td>
          <td>${done ? `<b>${fq(l.qty)}</b>` : `<div style="display:flex;gap:4px;align-items:center;justify-content:center"><button class="btn ic s" data-vq="${i}:-1">−</button><input class="cell n" style="width:60px;text-align:center" data-vv="${i}" value="${fq(l.qty || 0)}" inputmode="decimal"><button class="btn ic s" data-vq="${i}:1">+</button></div>`}${Math.abs(d) > 0.0001 && (l.qty || done) ? `<div class="small dv-warn" style="text-align:center;color:var(--danger)">${d > 0 ? '+' : ''}${fq(d)}</div>` : ''}</td>
          <td>${done ? esc(CNAME[l.cond]) : `<select class="in" data-vc="${i}" style="padding:3px 6px;font-size:13px">${opts(COND, l.cond)}</select>`}</td><td class="small">${esc(RNAME[rl.reason] || '')}${rl.exp ? ' — ' + esc(rl.exp) : ''}</td><td class="n small">${fmt(pr.price)}${pr.inv ? `<div class="muted">من #${esc(pr.inv.no)}</div>` : ''}</td></tr>`; }).join('')}</tbody></table></div>
      ${!done && canRecv() ? `<div class="row" style="margin-top:12px"><span class="small ${diff.length ? 'dv-warn' : 'muted'}" style="${diff.length ? 'color:var(--danger);font-weight:600' : ''}">${diff.length ? `⚠️ فيه ${diff.length} صنف مختلف عن اللي المندوب سجّله — هيتسجّل الفرق باسمه` : 'العدّ مطابق لإذن المندوب'}</span><span class="sp"></span><button class="btn p" id="rtRecv">تأكيد الاستلام في المخزن</button></div>` : ''}
      ${done ? approveHTML(r, parts) : ''}</div>`;
    bindRecv(r);
  }
  function partsOf(r) {
    const invs = L('invoices').filter(i => i.retRef === r.id);
    const lines = (r.recv && r.recv.lines) || [];
    const need = { good: lines.some(l => l.qty > 0 && l.cond === 'good'), bad: lines.some(l => l.qty > 0 && (l.cond === 'bad' || l.cond === 'exp')) };
    return { need, good: invs.find(i => i.retPart === 'good'), bad: invs.find(i => i.retPart === 'bad'), rej: lines.filter(l => l.qty > 0 && l.cond === 'reject') };
  }
  const badStore = () => stores().find(s => /تالف|هالك|منتهي/.test(s.name || ''));
  function approveHTML(r, P) {
    const rv = r.recv || {}; const card = (k, t, inv, extra) => P.need[k] ? `<div class="dv-stop" style="grid-template-columns:minmax(0,1fr) auto"><div><b>${t}</b><div class="small muted">${extra || ''}</div></div>${inv ? `<a class="btn s" href="#/inv/${esc(inv.id)}">✓ مرتجع رقم ${esc(inv.no)}</a>` : canApprove() ? `<button class="btn s p" data-ap="${k}">اعمل فاتورة المرتجع</button>` : '<span class="small muted">مستني اعتماد اللي عنده صلاحية البيع</span>'}</div>` : '';
    const bs = badStore();
    return `<div class="card" style="margin-top:14px"><h3 style="margin-top:0">الاعتماد</h3><p class="small muted" style="margin-top:-6px">اتستلم في المخزن بواسطة ${esc(rv.by || '')} ${esc(ltm(rv.at))}${rv.diff ? ` — <span style="color:var(--danger)">فرق ${rv.diff} صنف عن إذن المندوب</span>` : ''}</p>
      <div class="dv-list">${card('good', 'الصالح للبيع ← المخزن الرئيسي', P.good)}${card('bad', 'التالف والمنتهي ← ' + (bs ? esc(bs.name) : 'مخزن التالف'), P.bad, bs ? '' : 'مفيش مخزن تالف — هيتعمل لوحده أول مرة')}</div>
      ${P.rej.length ? `<p class="small" style="margin-top:10px">مرفوض ويرجع للصيدلية: ${P.rej.map(l => esc(pname(l.pid)) + ' × ' + fq(l.qty)).join('، ')}</p>` : ''}
      ${!P.need.good && !P.need.bad ? '<p class="small muted">مفيش أصناف تتعمل لها فاتورة مرتجع.</p>' : ''}</div>`;
  }
  function bindRecv(r) {
    const V = RT.recv; const rr = () => recvView(get(r.id) || r);
    const I = document.getElementById('rtI');
    if (I) { setTimeout(() => I.focus(), 40); I.onkeydown = e => { if (e.key !== 'Enter') return; e.preventDefault(); let v = I.value.trim(); I.value = ''; if (!v) return; let q = 1; const m = v.match(/^(\d+)\s*[*xX×]\s*(.+)$/); if (m) { q = +m[1]; v = m[2]; }
      const pid = resolveBc(v); if (!pid) { beep('err'); V.flash = { k: 'err', t: 'باركود مش معروف: ' + v }; rr(); return; }
      let l = V.lines.find(x => x.pid === pid); if (!l) { l = { pid, decl: 0, qty: 0, cond: 'good' }; V.lines.push(l); beep('err'); V.flash = { k: 'err', t: `⚠️ ${pname(pid)} — مش متسجّل في إذن المندوب، اتضاف` }; } else { beep('ok'); V.flash = { k: 'ok', t: `✓ ${pname(pid)} — ${fq(l.qty + q)} من ${fq(l.decl)}` }; }
      l.qty = Math.round((l.qty + q) * 1000) / 1000; if (l.qty > l.decl && l.decl) V.flash = { k: 'err', t: `⚠️ ${pname(pid)} زيادة عن إذن المندوب (${fq(l.qty)} من ${fq(l.decl)})` }; rr(); }; }
    $$('[data-vq]').forEach(b => b.onclick = () => { const [i, d] = b.dataset.vq.split(':').map(Number); V.lines[i].qty = Math.max(0, (V.lines[i].qty || 0) + d); rr(); });
    $$('[data-vv]').forEach(x => x.onchange = () => { V.lines[+x.dataset.vv].qty = Math.max(0, numIn(x.value)); rr(); });
    $$('[data-vc]').forEach(x => x.onchange = () => { V.lines[+x.dataset.vc].cond = x.value; });
    const rc = document.getElementById('rtRecv'); if (rc) rc.onclick = async () => {
      if (!V.lines.some(l => l.qty > 0)) { if (!(await confirmBox('مفيش ولا صنف اتعدّ — كده المرتجع وصل فاضي. تأكيد؟', 'تأكيد'))) return; }
      const diff = V.lines.filter(l => Math.abs((l.qty || 0) - (l.decl || 0)) > 0.0001).length;
      const cur = get(r.id); cur.recv = { by: who(), byId: S.me.id || '', at: nowIso(), lines: V.lines.filter(l => l.qty > 0 || l.decl).map(l => ({ pid: l.pid, decl: l.decl || 0, qty: l.qty || 0, cond: l.cond })), diff }; cur.status = 'received';
      await save(cur); toast(diff ? `اتستلم — واتسجّل فرق ${diff} صنف` : 'اتستلم في المخزن ✓', diff ? 'err' : ''); rr();
    };
    $$('[data-ap]').forEach(b => b.onclick = () => approve(get(r.id), b.dataset.ap));
    const pr = document.getElementById('rtPrint'); if (pr) pr.onclick = () => printRet(get(r.id));
    const cn = document.getElementById('rtCancel'); if (cn) cn.onclick = async () => { if (!(await confirmBox('إلغاء إذن المرتجع ده؟', 'إلغاء الإذن', true))) return; const c = get(r.id); c.status = 'cancel'; c.cancelBy = who(); await save(c); go('rets'); };
  }
  async function approve(r, part) {
    if (!canApprove()) { toast('محتاج صلاحية البيع', 'err'); return; }
    const lines = (r.recv.lines || []).filter(l => l.qty > 0 && (part === 'good' ? l.cond === 'good' : (l.cond === 'bad' || l.cond === 'exp')));
    if (!lines.length) return;
    let store = MAIN;
    if (part === 'bad') { let bs = badStore(); if (!bs) { const id = uid(); await put('stores', id, { name: 'مخزن التالف' }); bs = { id }; toast('اتعمل «مخزن التالف»'); } store = bs.id; }
    ED = { id: null, inv: newInv('sret'), grp: 'sret' }; const inv = ED.inv;
    inv.partyId = r.partyId; inv.storeId = store; inv.retRef = r.id; inv.retPart = part; inv.payFull = false; inv.paid = 0;
    inv.notes = `مرتجع ${r.code} — استلمه ${r.by || ''}${part === 'bad' ? ' — تالف/منتهي' : ''}`;
    inv.lines = lines.map(l => { const p = price(l.pid, r.partyId); return { pid: l.pid, qty: l.qty, price: p.price, disc: p.disc || 0, cost: p.cost != null && !(window.MZ && MZ.costHidden) ? p.cost : '' }; });
    inv.lines.sort((a, b) => pname(a.pid).localeCompare(pname(b.pid)));
    go('sret'); setTimeout(() => toast(`راجع فاتورة المرتجع (${part === 'good' ? 'الصالح' : 'التالف'}) واحفظ بـ Ctrl+S — بعد الحفظ هتتربط بإذن ${r.code}`), 300);
  }
  function printRet(r) {
    const p = G('parties', r.partyId) || {}; const rv = r.recv;
    const el = document.getElementById('print'); el.className = '';
    el.innerHTML = `<div style="display:flex;justify-content:space-between;border-bottom:2px solid #000;padding-bottom:6px"><div><h2 style="margin:0">${esc(settings().company || '')}</h2><div>إذن استلام مرتجع</div></div><div style="text-align:left"><h2 style="margin:0;font-family:monospace">${esc(r.code)}</h2><div>${esc(ltm(r.at))}</div></div></div>
      <p><b>الصيدلية:</b> ${esc(p.name || '')} ${p.phone ? '— ' + esc(p.phone) : ''}<br><b>المندوب:</b> ${esc(r.by || '')}${rv ? `<br><b>استلام المخزن:</b> ${esc(rv.by || '')} ${esc(ltm(rv.at))}` : ''}</p>
      <table><thead><tr><th>م</th><th>الصنف</th><th>سجّله المندوب</th>${rv ? '<th>وصل المخزن</th><th>الحالة</th>' : ''}<th>السبب</th></tr></thead><tbody>${(rv ? rv.lines : r.lines.map(l => ({ pid: l.pid, decl: l.qty }))).map((l, i) => { const rl = r.lines.find(x => x.pid === l.pid) || {}; return `<tr><td>${i + 1}</td><td>${esc(pname(l.pid))}</td><td>${fq(l.decl)}</td>${rv ? `<td>${fq(l.qty)}${Math.abs(l.qty - l.decl) > 0.0001 ? ' ⚠️' : ''}</td><td>${esc(CNAME[l.cond] || '')}</td>` : ''}<td>${esc(RNAME[rl.reason] || '')}${rl.exp ? ' ' + esc(rl.exp) : ''}</td></tr>`; }).join('')}</tbody></table>
      <div style="display:flex;justify-content:space-between;margin-top:30px"><div>توقيع الصيدلية: ..............</div><div>توقيع المندوب: ..............</div><div>توقيع المخزن: ..............</div></div>`;
    setTimeout(() => { try { window.print(); } catch (e) {} }, 50);
  }

  /* ---------- الشاشة الرئيسية للمرتجعات ---------- */
  window.vRets = function () {
    setTitle('استلام المرتجعات'); if (!canSee()) { denied('ليس لديك صلاحية المرتجعات'); return; }
    const a = route().a; if (a[0]) { const r = get(a[0]); if (r) return recvView(r); }
    const mineOnly = isDrv() && !canRecv() && !canApprove() && !S.isAdmin;
    let xs = all().filter(r => !mineOnly || r.byId === S.me.id || (r.status === 'requested' && L('runs').some(x => x.id === r.runId && x.driverId === S.me.id)));
    const cnt = k => xs.filter(r => r.status === k).length;
    const tabs = [['collected', 'مع المناديب'], ['received', 'مستني الاعتماد'], ['requested', 'مطلوب استلامه'], ['done', 'اتعمل مرتجع']];
    if (!tabs.some(t => t[0] === RT.tab)) RT.tab = 'collected';
    const shown = xs.filter(r => r.status === RT.tab).sort((x, y) => (y.at || '').localeCompare(x.at || '')).slice(0, 200);
    $('#view').innerHTML = `<div class="wrap">
      <div class="row" style="margin-bottom:12px"><div class="seg">${tabs.map(([k, t]) => `<button data-rtt="${k}" class="${RT.tab === k ? 'on' : ''}">${t} <span class="small muted num">${cnt(k)}</span></button>`).join('')}</div><span class="sp"></span>
        ${canRecv() ? `<input class="in" id="rtC" placeholder="رقم الإذن R-1234" style="width:170px;font-family:monospace" autocomplete="off">` : ''}${isDrv() || canApprove() || S.isAdmin ? `<button class="btn p" id="rtNew">↩️ استلام مرتجع جديد</button>` : ''}${can('deliveryManage') || S.isAdmin ? `<button class="btn" id="rtReq">+ مرتجع مطلوب</button>` : ''}</div>
      ${RT.tab === 'collected' && cnt('collected') && canRecv() ? `<div class="card" style="margin-bottom:12px;border-color:var(--gold)">لما المندوب يرجع: اكتب أو امسح رقم الإذن المكتوب على الشنطة، وعُدّ اللي فيها.</div>` : ''}
      ${shown.length ? `<div class="tw"><table class="t"><thead><tr><th>الإذن</th><th>الصيدلية</th><th>المندوب</th><th>الوقت</th><th class="n">أصناف</th><th class="n">قطع</th><th class="n">القيمة التقريبية</th><th></th></tr></thead><tbody>${shown.map(r => { const ls = r.recv ? r.recv.lines : r.lines; const q = (ls || []).reduce((s, l) => s + (+l.qty || 0), 0); return `<tr class="click" data-rto="${esc(r.id)}"><td class="num"><b>${esc(r.code)}</b></td><td>${esc(partyName(r.partyId))}${r.reqNote ? `<div class="small muted">${esc(r.reqNote)}</div>` : ''}</td><td>${esc(r.by || r.reqBy || '')}</td><td class="small">${esc(ltm(r.at))}</td><td class="n">${(ls || []).length}</td><td class="n">${fq(q)}</td><td class="n">${fmt(valOf({ ...r, lines: (ls || []).map(l => ({ pid: l.pid, qty: l.qty })) }))}</td><td>${r.recv && r.recv.diff ? `<span class="tag bad">فرق ${r.recv.diff}</span>` : ''}<span class="tag ${ST[r.status][1]}">${ST[r.status][0]}</span></td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty card"><b>مفيش حاجة هنا</b></div>'}</div>`;
    $$('[data-rtt]').forEach(b => b.onclick = () => { RT.tab = b.dataset.rtt; render(); });
    $$('[data-rto]').forEach(t => t.onclick = () => { const r = get(t.dataset.rto); if (r.status === 'requested' && isDrv()) RT.collect({ reqId: r.id }); else go('rets/' + r.id); });
    const nw = document.getElementById('rtNew'); if (nw) nw.onclick = () => RT.collect({});
    const rq = document.getElementById('rtReq'); if (rq) rq.onclick = () => RT.request('');
    const c = document.getElementById('rtC'); if (c) { c.onkeydown = e => { if (e.key !== 'Enter') return; e.preventDefault(); const r = fromCode(c.value); if (r) go('rets/' + r.id); else { beep('err'); toast('مفيش إذن بالرقم ده', 'err'); } }; if (RT.tab === 'collected') setTimeout(() => c.focus(), 40); }
  };
  // ربط الفاتورة بالإذن بعد حفظ المرتجع
  RT.tick = function () {
    try { for (const r of all()) { if (r.status !== 'received') continue; const P = partsOf(r); if ((!P.need.good || P.good) && (!P.need.bad || P.bad) && (P.need.good || P.need.bad)) { const c = get(r.id); c.status = 'done'; c.doneAt = nowIso(); c.sretIds = [P.good && P.good.id, P.bad && P.bad.id].filter(Boolean); save(c).catch(() => {}); } } } catch (e) {}
  };
  RT.card = function () {
    if (!canRecv() && !canApprove()) return ''; const n1 = all().filter(r => r.status === 'collected').length, n2 = all().filter(r => r.status === 'received').length; if (!n1 && !n2) return '';
    return `<a class="card" href="#/rets" style="display:block;margin-bottom:18px;color:inherit;text-decoration:none;border-color:var(--gold)"><div class="row"><h3 style="margin:0">↩️ المرتجعات</h3><span class="sp"></span>${n1 ? `<span class="tag bad">${n1} مع المناديب</span>` : ''}${n2 ? `<span class="tag purchase">${n2} مستني الاعتماد</span>` : ''}</div></a>`;
  };
  RT.forStop = (runId, partyId) => all().filter(r => r.runId === runId && r.partyId === partyId && r.status !== 'cancel');
})();
