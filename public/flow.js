/* ميزان — دورة الأوردر من البيع لحد التسليم والتسوية.
   كل فاتورة بيع ليها «مرحلة» بتتحسب لوحدها من اللي اتعمل فعلًا (مفيش خطوة زيادة على حد):
     اتسجّلت ← اتطبعت ← اتحضرت (مراجعة بالباركود + الشنط) ← في خط سير ← مع المندوب ← اتسلّمت ← اتسوّت (الفلوس والشنط رجعت)
   ومعاها:
     - شاشة واحدة «متابعة الأوردرات» فيها كل فاتورة في أنهي مرحلة، وزرار واحد للخطوة الجاية، وتنفيذ جماعي.
     - مسار كل فاتورة (مين عمل إيه وإمتى) جوه الفاتورة نفسها.
     - قيود: الفاتورة اللي مع المندوب أو اتسلّمت متتعدلش (والسيرفر بيرفض كمان)، والتعديل بعد الطباعة بيرجّعها للمراجعة.
     - تسوية المندوب لما يرجع: التحصيل يتسجّل في الخزينة مرة واحدة، والشنط اللي ماتسلّمتش ترجع المخزن بالمسح. */
(function () {
  'use strict';
  const F = { days: 1, st: 'open', q: '', sel: new Set() }; window.MZ_FLOW = F;
  const nowIso = () => new Date().toISOString();
  const who = () => (S.me && S.me.name) || '';
  const strict = () => !settings().flowLoose;
  const isMgr = () => S.isAdmin || can('deliveryManage');
  const canSeeFlow = () => S.isAdmin || can('sell') || can('prep') || can('deliveryManage');
  F.canSee = canSeeFlow; F.strict = strict;

  const STG = {
    new: ['اتسجّلت', 'لسه ماتطبعتش', ''],
    printed: ['اتطبعت', 'مستنية التحضير', 'purchase'],
    short: ['نواقص', 'التحضير مش مطابق', 'bad'],
    ready: ['اتحضرت', 'جاهزة للتوصيل', 'ok'],
    planned: ['في خط سير', 'المندوب لسه ماتحركش', 'purchase'],
    out: ['مع المندوب', 'في الطريق', 'purchase'],
    failed: ['مشكلة توصيل', 'رجعت أو اتأجلت', 'bad'],
    delivered: ['اتسلّمت', '', 'ok'],
  };
  const ORDER = ['new', 'printed', 'short', 'ready', 'planned', 'out', 'failed', 'delivered'];
  const OPEN = new Set(['new', 'printed', 'short', 'ready', 'planned', 'out', 'failed']);
  F.STG = STG;

  /* ---------- فهرس سريع (بيتبني مرة لكل تغيير في البيانات) ---------- */
  let IX = null;
  function idx() {
    const v = [CV.runs, CV.pkgs, CV.invoices, CV.rets].join('|');
    if (IX && IX.v === v) return IX;
    const run = new Map();
    for (const r of L('runs')) {
      if (r.status === 'cancel') continue;
      for (const s of r.stops || []) {
        if (!s.invId || s.kind === 'pickup') continue;
        const o = run.get(s.invId);
        // آخر خط سير للفاتورة هو اللي بيحدد حالتها (لو اتأجلت ورجعت في خط تاني)
        if (!o || (r.createdAt || '') > (o.run.createdAt || '')) run.set(s.invId, { run: r, stop: s });
      }
    }
    const pk = new Map(); for (const p of L('pkgs')) { if (p.voided) continue; const a = pk.get(p.key) || []; a.push(p); pk.set(p.key, a); }
    const ret = new Map(); for (const i of L('invoices')) if (i.type === 'sret' && i.fromInv) { const a = ret.get(i.fromInv) || []; a.push(i); ret.set(i.fromInv, a); }
    IX = { v, run, pk, ret }; return IX;
  }
  const keyOf = inv => inv.partyId ? inv.partyId + '|' + inv.date : 'inv:' + inv.id;
  F.runOf = id => idx().run.get(id) || null;

  /* ---------- مرحلة الفاتورة ---------- */
  function of(inv) {
    const I = idx(); const p = G('prints', inv.id) || null; const k = G('picks', inv.id) || null; const rr = I.run.get(inv.id);
    const printed = !!(p && p.n), prep = !!(p && p.prepAt), pick = k && k.status;
    let st = 'new';
    if (printed) st = 'printed';
    if (!prep && (pick === 'short' || pick === 'over')) st = 'short';
    if (prep) st = 'ready';
    if (inv.type === 'sale' && rr) { const s = rr.stop.status; st = s === 'delivered' ? 'delivered' : s === 'failed' ? 'failed' : rr.run.status === 'active' ? 'out' : rr.run.status === 'done' ? 'failed' : 'planned'; }
    else if (prep && (inv.type === 'transfer' || !inv.partyId)) st = 'delivered';
    const flags = [];
    if (p && p.edited) flags.push(['edit', p.edited === 'qty' ? 'اتعدّلت بعد الطباعة' : 'السعر اتعدّل بعد الطباعة', 'اطبع نسخة جديدة']);
    if (pick === 'redo') flags.push(['redo', 'محتاجة مراجعة تاني', 'الكميات اتغيرت بعد التحضير']);
    if (rr && !prep && rr.stop.status !== 'delivered') flags.push(['unprep', 'في خط سير ولسه ماتحضرتش', '']);
    const rets = I.ret.get(inv.id) || []; if (rets.length) flags.push(['ret', 'عليها مرتجع ' + rets.map(x => '#' + x.no).join(' '), '']);
    if (rr && rr.stop.far) flags.push(['far', `اتسلّمت على بعد ${rr.stop.far} كم من الصيدلية`, '']);
    if (rr && rr.stop.pkMiss) flags.push(['pkmiss', 'اتسلّمت من غير مسح كل الشنط', rr.stop.pkWhy || '']);
    const bags = inv.type === 'sale' ? (I.pk.get(keyOf(inv)) || []) : [];
    return { st, p, k, rr, bags, flags, late: OPEN.has(st) && st !== 'delivered' && (inv.date || '') < today() };
  }
  F.of = of;

  /* ---------- الخطوات (للمسار) ---------- */
  function steps(inv) {
    const o = of(inv); const { p, k, rr, bags } = o; const out = [];
    out.push({ k: 'sale', t: 'اتسجّلت', done: true, at: inv.createdAt, by: whoName(inv.createdBy) || inv.orgaUser || '' });
    out.push({ k: 'print', t: 'اتطبعت', done: !!(p && p.n), at: p && p.first, by: p && ((p.log || [])[(p.log || []).length - 1] || {}).by, sub: p && p.n > 1 ? `${p.n} نسخ — آخرها ${ltm(p.last)}` : '' });
    const pkSub = k && k.status && k.status !== 'open' ? (k.status === 'ok' ? 'مطابقة بالباركود' + (k.adjusted ? ' (بعد تعديل الفاتورة)' : '') : k.status === 'redo' ? 'محتاجة مراجعة تاني' : (k.status === 'over' ? 'بزيادة' : 'بنواقص') + (k.reason ? ' — ' + k.reason : '')) : (p && p.prepAt && !p.reviewed ? 'اتعلّمت يدوي من غير مسح' : '');
    out.push({ k: 'prep', t: 'اتحضرت', done: !!(p && p.prepAt), at: p && p.prepAt || (k && k.end), by: (p && p.prepBy) || (k && k.by), sub: [pkSub, bags.length ? `${bags.length} ${bags.length === 1 ? 'شنطة/كرتونة' : 'شنط/كراتين'}` : ''].filter(Boolean).join(' — '), bad: !(p && p.prepAt) && k && (k.status === 'short' || k.status === 'over') });
    if (inv.type !== 'sale' || !inv.partyId) { out.push({ k: 'hand', t: inv.type === 'transfer' ? 'اتحوّلت' : 'اتسلّمت من المخزن', done: !!(p && p.prepAt), at: p && p.prepAt }); return out; }
    const r = rr && rr.run, s = rr && rr.stop;
    out.push({ k: 'run', t: 'في خط سير', done: !!r, at: r && r.createdAt, by: r && r.createdBy, sub: r ? `${r.name || ''} — المندوب ${r.driverName || ''}` : '' });
    const ld = bags.filter(b => r && b.runId === r.id && b.loadAt).map(b => b.loadAt).sort()[0];
    out.push({ k: 'out', t: 'خرجت مع المندوب', done: !!(r && (r.status === 'active' || r.status === 'done')), at: ld || (r && r.startAt), by: r && r.driverName, sub: bags.length && r ? `اتحمّل ${bags.filter(b => b.runId === r.id && b.st !== 'packed').length} من ${bags.length}` : '' });
    out.push({ k: 'deliver', t: s && s.status === 'failed' ? 'مااتسلّمتش' : 'اتسلّمت', done: !!(s && s.status === 'delivered'), bad: !!(s && s.status === 'failed'), at: s && s.at, by: r && r.driverName, sub: s ? (s.status === 'failed' ? (s.reason || '') + (s.note ? ' — ' + s.note : '') : [s.cash ? 'حصّل ' + fmt(s.cash) : '', s.note || '', s.far ? `⚠ على بعد ${s.far} كم` : ''].filter(Boolean).join(' — ')) : '' });
    out.push({ k: 'settle', t: 'اتسوّت', done: !!(r && r.settled), at: r && r.settled && r.settled.at, by: r && r.settled && r.settled.by, sub: r && r.settled ? (r.settled.cash ? 'التحصيل اتسجّل في الخزينة' : '') : '' });
    return out;
  }
  F.steps = steps;

  /* ---------- شريط المسار جوه الفاتورة ---------- */
  F.strip = function (inv) {
    if (!inv || !['sale', 'transfer'].includes(inv.type)) return '';
    const o = of(inv); const ss = steps(inv); const cur = ss.findIndex(x => !x.done);
    return `<div class="card fl-strip" id="flStrip" title="دوس علشان تشوف المسار بالتفصيل"><div class="fl-steps">${ss.map((x, i) => `<div class="fl-st ${x.done ? 'done' : x.bad ? 'bad' : i === cur ? 'cur' : ''}"><i>${x.done ? '✓' : x.bad ? '!' : i + 1}</i><span>${esc(x.t)}</span>${x.done && x.at ? `<small>${esc(ltm(x.at).slice(5))}</small>` : ''}</div>`).join('<b class="fl-ln"></b>')}</div>
      ${o.flags.length ? `<div class="row small" style="gap:6px;margin-top:8px">${o.flags.map(f => `<span class="tag ${['ret', 'far'].includes(f[0]) ? 'purchase' : 'bad'}" title="${esc(f[2] || '')}">${esc(f[1])}</span>`).join('')}</div>` : ''}</div>`;
  };
  F.bindStrip = function (inv) { const el = document.getElementById('flStrip'); if (el) el.onclick = () => F.timeline(inv.id); };

  F.timeline = function (id) {
    const inv = L('invoices').find(i => i.id === id); if (!inv) return;
    const o = of(inv); const ss = steps(inv); const p = o.p;
    const ev = [];
    if (inv.updatedAt) ev.push({ at: inv.updatedAt, t: 'اتعدّلت الفاتورة', by: whoName(inv.updatedBy) });
    (p && p.edits || []).forEach(e => ev.push({ at: e.at, t: e.kind === 'qty' ? 'الكميات اتغيرت بعد الطباعة/التحضير' : 'الأسعار اتغيرت بعد الطباعة', by: e.by }));
    (idx().ret.get(id) || []).forEach(r => ev.push({ at: r.createdAt, t: `مرتجع #${r.no} — ${fmt(invTotals(r).total)}`, by: whoName(r.createdBy), link: 'inv/' + r.id }));
    const nx = nextAct(inv, o);
    modal(`<h2>مسار ${esc(TYPES[inv.type].full)} #${esc(inv.no)}</h2><p class="small muted" style="margin-top:-6px">${esc(partyName(inv.partyId) || 'عميل نقدي')} — ${esc(inv.date)} — <span class="tag ${STG[o.st][2]}">${STG[o.st][0]}</span></p>
      <div class="fl-tl">${ss.map(x => `<div class="fl-ti ${x.done ? 'done' : x.bad ? 'bad' : ''}"><i>${x.done ? '✓' : x.bad ? '!' : '○'}</i><div><b>${esc(x.t)}</b>${x.at && (x.done || x.bad) ? ` <span class="small muted">${esc(ltm(x.at))}${x.by ? ' — ' + esc(x.by) : ''}</span>` : ''}${x.sub ? `<div class="small">${esc(x.sub)}</div>` : ''}</div></div>`).join('')}</div>
      ${ev.length ? `<h3 style="margin:14px 0 6px">أحداث تانية</h3><div class="small">${ev.sort((a, b) => (a.at || '').localeCompare(b.at || '')).map(e => `<div style="padding:3px 0">${esc(ltm(e.at))} — ${e.link ? `<a href="#/${esc(e.link)}" data-close>${esc(e.t)}</a>` : esc(e.t)}${e.by ? ' — ' + esc(e.by) : ''}</div>`).join('')}</div>` : ''}
      ${o.flags.length ? `<div class="row small" style="gap:6px;margin-top:10px">${o.flags.map(f => `<span class="tag bad">${esc(f[1])}${f[2] ? ' — ' + esc(f[2]) : ''}</span>`).join('')}</div>` : ''}
      <div class="row" style="margin-top:14px">${nx ? `<button class="btn p" id="flTlGo">${esc(nx.t)}</button>` : ''}<a class="btn" href="#/inv/${esc(id)}" data-close>فتح الفاتورة</a><span class="sp"></span><button class="btn" data-close>قفل</button></div>`);
    const b = document.getElementById('flTlGo'); if (b) b.onclick = () => { closeModal(); nx.fn(); };
  };

  /* ---------- الخطوة الجاية ---------- */
  function nextAct(inv, o) {
    o = o || of(inv); const id = inv.id;
    switch (o.st) {
      case 'new': return canPrintQ() ? { t: 'اطبع', p: 1, fn: () => printInv(id) } : null;
      case 'printed': return (can('prep') || can('sell')) ? { t: o.flags.some(f => f[0] === 'redo') ? 'راجع تاني' : 'راجع بالباركود', p: 1, fn: () => go('pick/' + id) } : null;
      case 'short': return can('editInv') ? { t: 'عدّل الفاتورة على المُحضّر', p: 1, fn: () => F.fixToPick(id) } : { t: 'راجع تاني', fn: () => go('pick/' + id) };
      case 'ready': return isMgr() && inv.type === 'sale' && inv.partyId ? { t: 'خط سير', fn: () => F.plan([id]) } : null;
      case 'planned': case 'out': return { t: 'تابع المندوب', fn: () => go('routes/' + o.rr.run.id) };
      case 'failed': return isMgr() ? { t: 'رجّعها للتوصيل', p: 1, fn: () => F.plan([id]) } : null;
      default: return o.flags.some(f => f[0] === 'edit') && canPrintQ() && !(o.rr && o.rr.stop.status === 'delivered') ? { t: 'اطبع نسخة جديدة', fn: () => printInv(id, { force: true }) } : null;
    }
  }
  F.next = nextAct;

  /* ---------- خط سير بفواتير مختارة ---------- */
  F.plan = function (ids) {
    const ok = ids.filter(id => { const i = L('invoices').find(x => x.id === id); return i && i.type === 'sale' && i.partyId; });
    if (!ok.length) { toast('اختار فواتير بيع لعملاء', 'err'); return; }
    const oldest = ok.map(id => (L('invoices').find(x => x.id === id) || {}).date || today()).sort()[0];
    const days = Math.min(3, Math.max(1, Math.round((new Date(today()) - new Date(oldest)) / 864e5) + 1));
    window.MZ_DLV.plan = { days, sel: new Set(ok), ret: false, driver: '', onlyPrep: false, auto: true };
    go('routes/new');
  };

  /* ---------- تعديل الفاتورة على اللي اتحضر فعلًا ---------- */
  F.fixToPick = function (id) {
    const o = G('invoices', id), k = G('picks', id); if (!o || !k || !k.lines) return;
    if (!can('editInv')) { toast('محتاج صلاحية تعديل الفواتير', 'err'); return; }
    const inv = clone(o); const left = {}; for (const [pid, x] of Object.entries(k.lines)) left[pid] = Math.min(+x.got || 0, +x.req || 0);
    const changes = [];
    inv.lines = inv.lines.map(l => { if (!l.pid || !(l.pid in left)) return l; const q = Math.min(+l.qty || 0, left[l.pid]); left[l.pid] = Math.round((left[l.pid] - q) * 1000) / 1000; if (Math.abs(q - (+l.qty || 0)) > 0.0001) changes.push(`${pname(l.pid)}: ${fq(l.qty)} ← ${fq(q)}`); return { ...l, qty: Math.round(q * 1000) / 1000 }; }).filter(l => !l.pid || (+l.qty || 0) > 0);
    if (!changes.length) { toast('الفاتورة مطابقة للمُحضّر أصلًا'); return; }
    ED = { id, inv, orig: clone(o), fixPick: true }; go('inv/' + id);
    setTimeout(() => toast(`اتظبطت ${changes.length} سطر على اللي اتحضر فعلًا — راجع واحفظ (Ctrl+S)`), 250);
  };

  /* ---------- قيود التعديل والحذف ---------- */
  const qmap = x => { const m = {}; (x.lines || []).forEach(l => { if (l.pid) m[l.pid] = Math.round(((m[l.pid] || 0) + (+l.qty || 0)) * 1000) / 1000; }); return m; };
  const sameMap = (a, b) => { const ks = new Set([...Object.keys(a), ...Object.keys(b)]); for (const k of ks) if (Math.abs((a[k] || 0) - (b[k] || 0)) > 0.0001) return false; return true; };
  const priceSig = x => JSON.stringify([(x.lines || []).map(l => [l.pid, +l.price || 0, +l.disc || 0]), +x.discount || 0, +x.taxRate || 0, x.partyId || '']);
  F.lockMsg = function (inv) {
    if (!inv || inv.type !== 'sale') return '';
    const s = of(inv).st;
    if (s === 'out') return 'الفاتورة دي مع المندوب في الطريق — مينفعش تتعدل أو تتحذف دلوقتي. لو العميل عايز تغيير، سلّم واعمل مرتجع، أو رجّعها من خط السير الأول.';
    if (s === 'delivered') return 'الفاتورة دي اتسلّمت للعميل — مينفعش تتعدل أو تتحذف. أي تغيير يبقى بفاتورة مرتجع.';
    return '';
  };
  F.beforeSave = async function (orig, doc) {
    if (!orig || !['sale', 'transfer'].includes(orig.type)) return true;
    const qtyCh = !sameMap(qmap(orig), qmap(doc)), prCh = priceSig(orig) !== priceSig(doc) || orig.storeId !== doc.storeId;
    if (!qtyCh && !prCh) return true;
    const lm = F.lockMsg(orig);
    if (lm) { if (!S.isAdmin) { toast(lm, 'err'); return false; } if (!(await confirmBox('⚠ ' + lm + ' — انت مدير وتقدر تعدّل، بس الورق اللي مع العميل هيبقى مختلف. تكمّل؟', 'تعديل رغم ذلك', true))) return false; }
    const o = of(orig);
    if (ED && ED.fixPick && o.k && o.k.lines && sameMap(qmap(doc), Object.fromEntries(Object.entries(o.k.lines).map(([pid, x]) => [pid, Math.min(+x.got || 0, +x.req || 0)]).filter(([, q]) => q > 0)))) return true;
    if (o.st === 'planned' && qtyCh) { if (!(await confirmBox(`الفاتورة في خط سير «${o.rr.run.name || ''}» مع ${o.rr.run.driverName || 'المندوب'} — تغيير الكميات هيرجّعها للمراجعة والشنط ممكن تتغير. تكمّل؟`, 'تعديل'))) return false; }
    else if (qtyCh && o.p && o.p.prepAt) { if (!(await confirmBox('الفاتورة اتحضرت خلاص — تغيير الكميات هيرجّعها لطابور المراجعة ولازم تتطبع وتتراجع تاني. تكمّل؟', 'تعديل'))) return false; }
    else if (o.p && o.p.n && !(await confirmBox(`الفاتورة اتطبعت ${o.p.n === 1 ? 'مرة' : o.p.n + ' مرات'} — بعد التعديل اطبع نسخة جديدة علشان الورق يطابق.${qtyCh ? ' وهترجع لطابور المراجعة.' : ''} تكمّل؟`, 'تعديل'))) return false;
    return true;
  };
  F.afterSave = async function (id, orig, doc) {
    if (!orig || !['sale', 'transfer'].includes(doc.type)) return;
    const qa = qmap(orig), qb = qmap(doc); const qtyCh = !sameMap(qa, qb), prCh = priceSig(orig) !== priceSig(doc) || orig.storeId !== doc.storeId;
    if (!qtyCh && !prCh) return;
    const p = G('prints', id), k = G('picks', id); const at = nowIso(), by = who(); const W = [];
    const picked = k && k.lines ? Object.fromEntries(Object.entries(k.lines).map(([pid, x]) => [pid, Math.min(+x.got || 0, +x.req || 0)])) : null;
    if (qtyCh && picked && k.status !== 'open' && sameMap(qb, Object.fromEntries(Object.entries(picked).filter(([, q]) => q > 0)))) {
      // الفاتورة اتعدلت على اللي اتحضر بالظبط → تبقى متحضرة ومطابقة
      W.push(put('picks', id, { ...k, status: 'ok', adjusted: { at, by, from: k.status }, lines: Object.fromEntries(Object.entries(k.lines).map(([pid, x]) => [pid, { req: Math.min(+x.got || 0, +x.req || 0), got: Math.min(+x.got || 0, +x.req || 0) }])) }));
      W.push(put('prints', id, { ...(p || {}), prepAt: (p && p.prepAt) || at, prepBy: (p && p.prepBy) || k.by || by, reviewed: true, ...(p && p.n ? { edited: 'qty' } : {}), edits: [{ at, by, kind: 'qty', fix: true }, ...((p && p.edits) || [])].slice(0, 10) }));
      toast('اتعدّلت الفاتورة على المُحضّر واتعلّمت «اتحضرت» — اطبع نسخة جديدة للعميل');
    } else if (p && (p.n || p.prepAt)) {
      const d = { ...p, edits: [{ at, by, kind: qtyCh ? 'qty' : 'price' }, ...(p.edits || [])].slice(0, 10) };
      if (p.n) d.edited = qtyCh ? 'qty' : (p.edited || 'price');
      if (qtyCh && p.prepAt) { d.prepUndo = { at: p.prepAt, by: p.prepBy || '' }; delete d.prepAt; delete d.prepBy; d.reviewed = false; }
      W.push(put('prints', id, d));
      if (qtyCh && k && k.status !== 'open') W.push(put('picks', id, { ...k, status: 'redo', redoAt: at, redoBy: by, prevStatus: k.status }));
      if (qtyCh) toast('الكميات اتغيرت — الفاتورة رجعت لطابور المراجعة. اطبع نسخة جديدة', 'err');
      else if (p.n) toast('اتغير السعر بعد الطباعة — اطبع نسخة جديدة للعميل', 'err');
    }
    // لو في خط سير لسه مبدأش: الملصقات محتاجة تتطبع تاني (مش بنشيلها من الخط)
    await Promise.allSettled(W);
  };
  F.beforeDelete = async function (inv) {
    if (!inv || inv.type !== 'sale') return true;
    const lm = F.lockMsg(inv); if (lm) { if (!S.isAdmin) { toast(lm, 'err'); return false; } if (!(await confirmBox('⚠ ' + lm + ' — تحذفها برضه؟', 'حذف رغم ذلك', true))) return false; }
    const o = of(inv);
    if (o.st === 'planned') { if (!(await confirmBox(`الفاتورة في خط سير «${o.rr.run.name || ''}» — هتتشال من الخط مع الحذف. تكمّل؟`, 'حذف', true))) return false; }
    return true;
  };
  F.afterDelete = async function (id) {
    const rr = idx().run.get(id); if (!rr || rr.run.status !== 'planned') return;
    const r = G('runs', rr.run.id); if (!r) return; const d = { ...r }; delete d.id; d.stops = (d.stops || []).filter(s => s.invId !== id); d.upd = nowIso(); await put('runs', rr.run.id, d).catch(() => {});
  };

  /* ---------- تسوية المندوب ---------- */
  F.settleInfo = function (r) {
    const stops = (r.stops || []).filter(s => s.kind !== 'pickup');
    const cash = stops.filter(s => +s.cash > 0).map(s => ({ s, posted: L('cash').some(c => c.ref === 'run:' + r.id + ':' + s.invId) }));
    const failedKeys = new Set(); stops.filter(s => s.status === 'failed' || s.status === 'pending' || s.status === 'arrived').forEach(s => { const i = L('invoices').find(x => x.id === s.invId); if (i) failedKeys.add(keyOf(i)); });
    const deliveredKeys = new Set(); stops.filter(s => s.status === 'delivered').forEach(s => { const i = L('invoices').find(x => x.id === s.invId); if (i) deliveredKeys.add(keyOf(i)); });
    const back = L('pkgs').filter(p => !p.voided && failedKeys.has(p.key) && !deliveredKeys.has(p.key) && p.runId === r.id && p.st === 'loaded');
    const rets = window.MZ_RT ? L('rets').filter(x => x.runId === r.id && x.status === 'collected') : [];
    const open = stops.some(s => s.status === 'pending' || s.status === 'arrived');
    return { cash, toPost: cash.filter(x => !x.posted), total: cash.reduce((a, x) => a + (+x.s.cash || 0), 0), back, rets, open };
  };
  F.settleHTML = function (r) {
    if (!isMgr() || r.status === 'planned') return '';
    const I = F.settleInfo(r);
    if (r.settled) return `<div class="card" style="margin-top:14px;border-color:var(--brand)"><div class="row"><h3 style="margin:0">🧾 التسوية</h3><span class="tag ok">اتسوّت ${esc(ltm(r.settled.at))} — ${esc(r.settled.by || '')}</span></div><p class="small" style="margin:8px 0 0">التحصيل ${fmt(r.settled.cash || 0)}${r.settled.missing && r.settled.missing.length ? ` — <span style="color:var(--danger)">شنط مارجعتش: ${esc(r.settled.missing.join('، '))} (${esc(r.settled.why || '')})</span>` : ''}${r.settled.note ? ' — ' + esc(r.settled.note) : ''}</p></div>`;
    if (r.status === 'active' && I.open) return '';
    return `<div class="card" style="margin-top:14px;border:2px solid var(--gold)" id="stBox"><div class="row"><h3 style="margin:0">🧾 تسوية المندوب — ${esc(r.driverName || '')}</h3><span class="sp"></span><span class="small muted">لما يرجع المخزن</span></div>
      <div class="dv-list" style="margin-top:10px">
        <div class="dv-stop" style="grid-template-columns:minmax(0,1fr) auto"><div><b>💰 التحصيل: ${fmt(I.total)}</b><div class="small muted">${I.cash.length ? `${I.cash.length} صيدلية — ${I.toPost.length ? `<span style="color:var(--danger)">${I.toPost.length} لسه ماتسجّلتش في الخزينة</span>` : 'كله اتسجّل في الخزينة ✓'}` : 'مفيش تحصيل في الخط ده'}</div></div>${I.toPost.length && can('cash') ? `<button class="btn s p" id="stCash">سجّل ${fmt(I.toPost.reduce((a, x) => a + (+x.s.cash || 0), 0))} في الخزينة</button>` : ''}</div>
        <div class="dv-stop" style="grid-template-columns:minmax(0,1fr)"><div><b>📦 شنط راجعة (ماتسلّمتش): ${I.back.length}</b><div class="small muted">${I.back.length ? I.back.map(p => esc(MZ_PK.nameOfKey(p.key) + ' — ' + MZ_PK.label(p))).join('، ') : 'مفيش ✓'}</div>${I.back.length ? `<div class="row" style="margin-top:8px;gap:6px;flex-wrap:nowrap"><input class="in" id="stPk" autocomplete="off" placeholder="امسح كل شنطة راجعة" style="flex:1"></div><div class="small" id="stPkM" style="min-height:16px;margin-top:4px"></div>` : ''}</div></div>
        <div class="dv-stop" style="grid-template-columns:minmax(0,1fr) auto"><div><b>↩️ مرتجعات مع المندوب: ${I.rets.length}</b><div class="small muted">${I.rets.length ? I.rets.map(x => `<a href="#/rets/${esc(x.id)}">${esc(x.code)} — ${esc(partyName(x.partyId))}</a>`).join('، ') + ' — افتح كل إذن وعُدّه في المخزن' : 'مفيش'}</div></div></div>
      </div>
      <label class="f" style="margin-top:10px">ملاحظة التسوية<input class="in" id="stN" placeholder="مثلًا: الفلوس اتسلّمت لأمين الخزينة"></label>
      <div class="row" style="margin-top:10px"><span class="small muted" style="flex:1">${I.open ? '⚠ فيه محطات لسه مفتوحة — هتتقفل كمشكلة توصيل وترجع لطابور التوصيل.' : ''}</span><button class="btn p" id="stOk">✓ قفل التسوية</button></div></div>`;
  };
  F.bindSettle = function (r, rerender) {
    const cb = document.getElementById('stCash');
    if (cb) cb.onclick = async () => {
      const I = F.settleInfo(G('runs', r.id) ? { ...G('runs', r.id), id: r.id } : r); if (!I.toPost.length) return;
      if (!(await confirmBox(`تسجيل ${I.toPost.length} سند قبض بإجمالي ${fmt(I.toPost.reduce((a, x) => a + (+x.s.cash || 0), 0))} في ${safeName(defSafe())}؟ كل سند بيتخصم من حساب الصيدلية بتاعته.`, 'تسجيل'))) return;
      cb.disabled = true; const at = nowIso();
      await putMany(I.toPost.map(x => ['cash', uid(), { date: today(), kind: 'in', category: 'تحصيل من عميل', amount: +x.s.cash, safe: defSafe(), partyId: x.s.partyId, note: `تحصيل ${r.driverName || 'المندوب'} — فاتورة #${(L('invoices').find(i => i.id === x.s.invId) || {}).no || ''} — ${r.name || ''}`, ref: 'run:' + r.id + ':' + x.s.invId, createdAt: at, createdBy: S.me.id || '' }]));
      toast(`اتسجّل ${I.toPost.length} سند قبض`); rerender();
    };
    const pi = document.getElementById('stPk');
    if (pi) { setTimeout(() => pi.focus(), 50); pi.onkeydown = async e => { if (e.key !== 'Enter') return; e.preventDefault(); const v = pi.value.trim(); pi.value = ''; if (!v) return; const m = document.getElementById('stPkM');
      const I = F.settleInfo({ ...G('runs', r.id), id: r.id }); const b = fromScanPk(v);
      if (!b) { MZ_PK.beep('err'); m.textContent = 'ده مش ملصق شنطة'; m.style.color = 'var(--danger)'; return; }
      if (!I.back.some(x => x.id === b.id)) { MZ_PK.beep('err'); m.textContent = `${MZ_PK.label(b)} — ${MZ_PK.nameOfKey(b.key)}: مش من الشنط الراجعة في الخط ده`; m.style.color = 'var(--danger)'; return; }
      const c = G('pkgs', b.id); const d = { ...c }; delete d.id; d.st = 'packed'; d.backAt = nowIso(); d.backBy = who(); d.backRun = r.id; d.runId = ''; d.upd = nowIso(); await put('pkgs', b.id, d);
      MZ_PK.beep(I.back.length === 1 ? 'done' : 'ok'); toast(`✓ ${MZ_PK.label(b)} رجعت المخزن`); rerender(); }; }
    const ok = document.getElementById('stOk');
    if (ok) ok.onclick = async () => {
      const cur = { ...G('runs', r.id), id: r.id }; const I = F.settleInfo(cur); let why = '';
      if (I.toPost.length && !(await confirmBox(`فيه ${I.toPost.length} تحصيل لسه ماتسجّلش في الخزينة (${fmt(I.toPost.reduce((a, x) => a + (+x.s.cash || 0), 0))}). تقفل التسوية من غيرهم؟`, 'قفل برضه', true))) return;
      if (I.back.length) { why = (await promptBox(`فيه ${I.back.length} شنطة لسه مارجعتش المخزن. اكتب السبب علشان تقفل:`)) || ''; if (!why.trim()) return; }
      const note = (document.getElementById('stN') || {}).value || '';
      const d = { ...cur }; delete d.id;
      (d.stops || []).forEach(s => { if (s.status === 'pending' || s.status === 'arrived') { s.status = 'failed'; s.reason = s.reason || 'اتقفلت في التسوية من غير تسليم'; s.at = nowIso(); } });
      if (d.status !== 'done') { d.status = 'done'; d.endAt = nowIso(); }
      d.settled = { at: nowIso(), by: who(), byId: S.me.id || '', cash: I.total, posted: I.cash.length - I.toPost.length, ...(I.back.length ? { missing: I.back.map(p => MZ_PK.nameOfKey(p.key) + ' ' + MZ_PK.label(p)), why: why.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
      d.upd = nowIso(); await put('runs', r.id, d); toast('✓ اتقفلت التسوية'); rerender();
    };
  };
  function fromScanPk(raw) { const v = fixBc(String(raw || '').trim()).toUpperCase().replace(/\s/g, ''); const m = v.match(/^PKG-?([0-9A-Z]{5,8})$/) || v.match(/^(98\d{8})$/); if (!m) return null; const p = G('pkgs', m[1]); return p ? { id: m[1], ...p } : null; }
  function promptBox(msg) {
    return new Promise(res => {
      modal(`<h2>${esc(msg)}</h2><input class="in" id="pb_v" autocomplete="off"><div class="row" style="margin-top:12px"><button class="btn p" id="pb_ok">تمام</button><button class="btn" id="pb_x">رجوع</button></div>`);
      const v = document.getElementById('pb_v'); setTimeout(() => v.focus(), 40);
      document.getElementById('pb_ok').onclick = () => { const x = v.value; closeModal(); res(x); };
      document.getElementById('pb_x').onclick = () => { closeModal(); res(''); };
      v.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('pb_ok').click(); } };
    });
  }
  F.unsettled = () => L('runs').filter(r => r.status === 'done' && !r.settled && (r.endAt || r.createdAt || '') >= addDays(today(), -7) + 'T').filter(r => !(r.stops || []).every(s => s.kind === 'pickup'));

  /* ---------- شاشة متابعة الأوردرات ---------- */
  // بداية المتابعة: الفواتير اللي قبل التاريخ ده (زي فواتير أورجا القديمة) مش بتدخل دورة الطباعة والتحضير والتوصيل
  F.from = () => { const s = settings(); return s.flowFrom || F._autoFrom || today(); };
  F.inFlow = inv => (inv.date || '') >= F.from();
  F.ensureFrom = () => { const s = settings(); if (s.flowFrom || F._autoFrom) return; F._autoFrom = today(); if (S.isAdmin) put('settings', 'main', { ...s, flowFrom: today() }).catch(() => {}); };
  function rowsFor(days) {
    F.ensureFrom();
    const from = addDays(today(), -(days - 1)); const back = addDays(today(), -14);
    const xs = L('invoices').filter(i => i.type === 'sale' && (i.date || '') >= back && F.inFlow(i));
    const out = [];
    for (const i of xs) { const o = of(i); if ((i.date || '') >= from || OPEN.has(o.st) && o.st !== 'delivered' && (o.st !== 'new' || (i.date || '') >= addDays(today(), -3))) out.push({ inv: i, o }); }
    return out;
  }
  window.vFlow = function () {
    ensureCss(); setTitle('متابعة الأوردرات');
    if (!canSeeFlow()) { denied('ليس لديك صلاحية'); return; }
    const all = rowsFor(F.days); const cnt = {}; ORDER.forEach(k => cnt[k] = 0); all.forEach(x => cnt[x.o.st]++);
    const nOpen = all.filter(x => x.o.st !== 'delivered').length; const nFlag = all.filter(x => x.o.flags.some(f => !['ret'].includes(f[0]))).length;
    let xs = all.filter(x => F.st === 'all' ? true : F.st === 'open' ? x.o.st !== 'delivered' : F.st === 'flag' ? x.o.flags.some(f => f[0] !== 'ret') : x.o.st === F.st);
    if (F.q) { const q = norm(F.q); xs = xs.filter(x => String(x.inv.no) === F.q || norm(partyName(x.inv.partyId)).includes(q)); }
    xs.sort((a, b) => ORDER.indexOf(a.o.st) - ORDER.indexOf(b.o.st) || (a.inv.createdAt || '').localeCompare(b.inv.createdAt || ''));
    const R = calc(); const uns = isMgr() ? F.unsettled() : [];
    const sel = F.sel; [...sel].forEach(id => { if (!all.some(x => x.inv.id === id)) sel.delete(id); });
    const bulk = bulkActs(xs);
    $('#view').innerHTML = `<div class="wrap">
      <div class="card" style="padding:12px 14px"><div class="row"><div class="rv-scan" style="flex:1 1 320px;display:flex;gap:8px"><input class="in" id="flI" autocomplete="off" placeholder="امسح أي باركود: فاتورة / شنطة / إذن مرتجع — أو اكتب رقم الفاتورة" style="font-size:17px;padding:11px 14px"></div>
        <select class="in" id="flD" style="width:140px">${opts([[1, 'النهارده'], [2, 'من امبارح'], [3, 'آخر 3 أيام'], [7, 'آخر أسبوع']], String(F.days))}</select><input class="in" id="flQ" style="width:170px" placeholder="العميل أو رقم الفاتورة" value="${esc(F.q)}"></div>
        <p class="small muted" style="margin:8px 0 0">كل فاتورة بتتنقل للمرحلة الجاية لوحدها مع كل خطوة (طباعة، مراجعة، تحميل، تسليم). الفواتير المفتوحة من أيام قبل كده بتفضل ظاهرة لحد ما تتقفل.
          <span class="nowrap">المتابعة بتبدأ من ${S.isAdmin ? `<input type="date" class="in" id="flFrom" value="${esc(F.from())}" style="width:150px;display:inline-block;padding:3px 8px">` : `<b class="num">${esc(F.from())}</b>`} — اللي قبل كده مش بيظهر هنا.</span></p></div>
      <div class="fl-pipe">${ORDER.map(k => `<button class="fl-pc ${F.st === k ? 'on' : ''} ${STG[k][2]}" data-fls="${k}"><b>${cnt[k]}</b><span>${STG[k][0]}</span></button>`).join('<i class="fl-ar">←</i>')}</div>
      <div class="row" style="margin:10px 0">
        <div class="seg"><button data-fls="open" class="${F.st === 'open' ? 'on' : ''}">المفتوح <span class="small muted num">${nOpen}</span></button><button data-fls="flag" class="${F.st === 'flag' ? 'on' : ''}">تنبيهات <span class="small muted num">${nFlag}</span></button><button data-fls="all" class="${F.st === 'all' ? 'on' : ''}">الكل <span class="small muted num">${all.length}</span></button></div>
        <span class="sp"></span>${bulk.map((b, i) => `<button class="btn ${b.p ? 'p' : ''}" data-flb="${i}">${esc(b.t)}</button>`).join('')}</div>
      ${uns.length ? `<div class="card" style="margin-bottom:12px;border-color:var(--gold)"><b>🧾 خطوط سير خلصت ولسه ماتسوّتش:</b> ${uns.map(r => `<a href="#/routes/${esc(r.id)}">${esc(r.driverName || '')} — ${esc(r.name || '')}</a>`).join('، ')}</div>` : ''}
      <div class="tw"><table class="t" id="flT"><thead><tr><th style="width:30px"><input type="checkbox" id="flAll"></th><th>رقم</th><th>العميل</th><th class="n hide-m">الصافي</th><th>المرحلة</th><th class="hide-m">المسار</th><th>تفاصيل</th><th></th></tr></thead><tbody>
      ${xs.slice(0, 500).map(({ inv, o }) => { const nx = nextAct(inv, o); const ss = steps(inv); return `<tr data-flr="${inv.id}">
        <td><input type="checkbox" data-flc="${inv.id}" ${sel.has(inv.id) ? 'checked' : ''}></td>
        <td class="num"><b>${esc(inv.no)}</b><div class="small muted">${inv.date !== today() ? esc(inv.date.slice(5)) + ' ' : ''}${esc(ltm(inv.createdAt).slice(11))}</div></td>
        <td>${esc(partyName(inv.partyId) || 'عميل نقدي')}<div class="small muted">${esc(whoName(inv.createdBy) || inv.orgaUser || '')}</div></td>
        <td class="n hide-m">${fmt((R.inv[inv.id] || invTotals(inv)).total)}</td>
        <td><span class="tag ${STG[o.st][2]}">${STG[o.st][0]}</span>${o.late ? ' <span class="tag bad" title="فاتورة من يوم قبل كده لسه مااتقفلتش">متأخرة</span>' : ''}</td>
        <td class="hide-m"><span class="fl-dots" title="${esc(ss.map(s => (s.done ? '✓ ' : s.bad ? '! ' : '○ ') + s.t).join('\n'))}">${ss.map(s => `<i class="${s.done ? 'd' : s.bad ? 'b' : ''}"></i>`).join('')}</span></td>
        <td class="small">${detail(inv, o)}</td>
        <td style="white-space:nowrap">${nx ? `<button class="btn s ${nx.p ? 'p' : ''}" data-fln="${inv.id}">${esc(nx.t)}</button>` : ''} <button class="btn s" data-flt="${inv.id}" title="المسار">⋯</button></td></tr>`; }).join('') || `<tr><td colspan="8"><div class="empty"><b>${F.st === 'open' ? 'كل الأوردرات اتقفلت 👌' : 'مفيش'}</b></div></td></tr>`}</tbody></table></div>
      <div class="row small" style="margin-top:8px" id="flSelBar" style="${sel.size ? '' : 'display:none'}"><b id="flSelN">${sel.size} مختارة</b>${selActs().map((b, i) => `<button class="btn s" data-fla="${i}">${esc(b.t)}</button>`).join('')}<button class="btn s" id="flSelC">إلغاء الاختيار</button></div></div>`;
    bindFlow(xs, bulk);
  };
  function detail(inv, o) {
    const out = [];
    if (o.bags.length) out.push(`📦 ${o.bags.length}`);
    if (o.rr) out.push(`🚚 ${esc(o.rr.run.driverName || '')}${o.rr.stop.status === 'delivered' && o.rr.stop.at ? ' ' + esc(ltm(o.rr.stop.at).slice(11)) : ''}${o.rr.stop.cash ? ' — حصّل ' + fmt(o.rr.stop.cash) : ''}`);
    if (o.st === 'failed' && o.rr) out.push(`<span style="color:var(--danger)">${esc(o.rr.stop.reason || 'مااتسلّمتش')}</span>`);
    if (o.st === 'short' && o.k) out.push(`<span style="color:var(--danger)">${esc(o.k.reason || '')}</span>`);
    o.flags.forEach(f => out.push(`<span class="tag ${f[0] === 'ret' ? 'purchase' : 'bad'}" title="${esc(f[2] || '')}">${esc(f[1])}</span>`));
    return out.join(' ');
  }
  function bulkActs(xs) {
    const of_ = k => xs.filter(x => x.o.st === k).map(x => x.inv.id); const out = [];
    const nw = of_('new'); if (nw.length && canPrintQ()) out.push({ t: `🖨 اطبع كل اللي ماتطبعش (${nw.length})`, p: 1, fn: async () => { if (nw.length > 1 && !(await confirmBox(`طباعة ${nw.length} فاتورة مرة واحدة؟`, 'طباعة'))) return; printMany(nw); } });
    const rd = xs.filter(x => (x.o.st === 'ready' || x.o.st === 'failed') && x.inv.partyId).map(x => x.inv.id); if (rd.length && isMgr()) out.push({ t: `⚡ خط سير بكل الجاهز (${rd.length})`, p: 1, fn: () => F.plan(rd) });
    const ed = xs.filter(x => x.o.st !== 'delivered' && x.o.flags.some(f => f[0] === 'edit')).map(x => x.inv.id); if (ed.length && canPrintQ()) out.push({ t: `اطبع النسخ المعدّلة (${ed.length})`, fn: () => printMany(ed) });
    return out;
  }
  function selActs() {
    const ids = [...F.sel]; const invs = ids.map(id => L('invoices').find(i => i.id === id)).filter(Boolean); const out = [];
    if (canPrintQ()) out.push({ t: '🖨 طباعة', fn: () => printMany(ids) });
    if (isMgr()) out.push({ t: '🚚 خط سير', fn: () => F.plan(invs.filter(i => ['ready', 'failed'].includes(of(i).st) || !strict()).map(i => i.id)) });
    return out;
  }
  function bindFlow(xs, bulk) {
    const I = document.getElementById('flI');
    if (I) { setTimeout(() => { if (!document.getElementById('modal').classList.contains('on')) I.focus(); }, 30); I.onkeydown = e => { if (e.key !== 'Enter') return; e.preventDefault(); const v = I.value.trim(); I.value = ''; if (v) F.scan(v); }; }
    $$('[data-fls]').forEach(b => b.onclick = () => { F.st = F.st === b.dataset.fls && ORDER.includes(F.st) ? 'open' : b.dataset.fls; render(); });
    $('#flD').onchange = e => { F.days = +e.target.value; render(); };
    const ff = $('#flFrom'); if (ff) ff.onchange = async e => { const v = e.target.value; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return; await put('settings', 'main', { ...settings(), flowFrom: v }); toast('المتابعة بقت تبدأ من ' + v); render(); };
    $('#flQ').onchange = e => { F.q = e.target.value.trim(); render(); };
    $$('[data-flb]').forEach(b => b.onclick = () => bulk[+b.dataset.flb].fn());
    $$('[data-fln]').forEach(b => b.onclick = e => { e.stopPropagation(); const inv = L('invoices').find(i => i.id === b.dataset.fln); const nx = inv && nextAct(inv); if (nx) nx.fn(); });
    $$('[data-flt]').forEach(b => b.onclick = e => { e.stopPropagation(); F.timeline(b.dataset.flt); });
    $$('[data-flr]').forEach(t => t.onclick = e => { if (e.target.closest('input,button,a')) return; F.timeline(t.dataset.flr); });
    const upd = () => { const bar = document.getElementById('flSelBar'); if (bar) { bar.style.display = F.sel.size ? '' : 'none'; document.getElementById('flSelN').textContent = F.sel.size + ' مختارة'; } };
    $$('[data-flc]').forEach(c => c.onchange = () => { if (c.checked) F.sel.add(c.dataset.flc); else F.sel.delete(c.dataset.flc); upd(); });
    const ca = document.getElementById('flAll'); if (ca) ca.onchange = () => { $$('[data-flc]').forEach(c => { c.checked = ca.checked; if (ca.checked) F.sel.add(c.dataset.flc); else F.sel.delete(c.dataset.flc); }); upd(); };
    const acts = selActs(); $$('[data-fla]').forEach(b => b.onclick = () => { const a = acts[+b.dataset.fla]; F.sel = new Set(); a.fn(); });
    const sc = document.getElementById('flSelC'); if (sc) sc.onclick = () => { F.sel.clear(); render(); };
  }
  // مسح أي باركود: فاتورة ← مسارها، شنطة ← فواتيرها، إذن مرتجع ← صفحته
  F.scan = function (v) {
    const b = invBcParse(v);
    let inv = b ? L('invoices').filter(i => String(i.no) === String(b.no) && i.type === b.type).sort((a, c) => (c.date || '').localeCompare(a.date || ''))[0] : null;
    if (!inv && /^\d{1,7}$/.test(fixBc(v))) inv = L('invoices').filter(i => String(i.no) === String(+fixBc(v)) && i.type === 'sale').sort((a, c) => (c.date || '').localeCompare(a.date || ''))[0];
    if (inv) { F.timeline(inv.id); return; }
    const pk = fromScanPk(v); if (pk) { const ids = pk.invIds || []; const lbl = MZ_PK.label(pk); const st = { packed: 'في المخزن', loaded: 'في العربية مع المندوب', delivered: 'اتسلّمت' }[pk.st] || pk.st;
      modal(`<h2>📦 ${esc(lbl)} — ${esc(MZ_PK.nameOfKey(pk.key))}</h2><p>الحالة: <b>${esc(st)}</b>${pk.loadAt ? ` — اتحمّلت ${esc(ltm(pk.loadAt))} ${esc(pk.loadBy || '')}` : ''}${pk.delAt ? ` — اتسلّمت ${esc(ltm(pk.delAt))}` : ''}${pk.backAt ? ` — رجعت المخزن ${esc(ltm(pk.backAt))}` : ''}</p><div class="dv-list">${ids.map(id => { const i = L('invoices').find(x => x.id === id); if (!i) return ''; const o = of(i); return `<button class="dv-stop" data-flpi="${esc(id)}" style="grid-template-columns:minmax(0,1fr) auto;text-align:right;cursor:pointer;width:100%;font:inherit;color:inherit"><b>#${esc(i.no)}</b><span class="tag ${STG[o.st][2]}">${STG[o.st][0]}</span></button>`; }).join('')}</div><div class="row" style="margin-top:12px"><span class="sp"></span><button class="btn" data-close>قفل</button></div>`);
      $$('[data-flpi]').forEach(x => x.onclick = () => F.timeline(x.dataset.flpi)); return; }
    const rv = fixBc(v).toUpperCase().replace(/\s/g, '').match(/^R-?(\d{4})$/);
    if (rv && window.MZ_RT) { const r = L('rets').filter(x => x.code === 'R-' + rv[1]).sort((a, c) => (c.at || '').localeCompare(a.at || ''))[0]; if (r) { go('rets/' + r.id); return; } }
    toast('مش لاقي فاتورة أو شنطة أو إذن مرتجع بالكود ده', 'err'); try { MZ_PK.beep('err'); } catch (e) {}
  };

  /* ---------- كارت الرئيسية ---------- */
  F.card = function () {
    if (!canSeeFlow()) return '';
    const all = rowsFor(1); if (!all.length) return '';
    const cnt = {}; ORDER.forEach(k => cnt[k] = 0); all.forEach(x => cnt[x.o.st]++);
    const uns = isMgr() ? F.unsettled().length : 0; const flags = all.filter(x => x.o.flags.some(f => f[0] !== 'ret')).length;
    return `<a class="card" href="#/flow" style="display:block;margin-bottom:18px;color:inherit;text-decoration:none"><div class="row"><h3 style="margin:0">🔄 دورة الأوردرات النهارده</h3><span class="sp"></span>${flags ? `<span class="tag bad">${flags} تنبيه</span>` : ''}${uns ? `<span class="tag purchase">${uns} خط مستني تسوية</span>` : ''}</div>
      <div class="fl-mini">${ORDER.filter(k => cnt[k] || ['new', 'ready', 'delivered'].includes(k)).map(k => `<div class="${STG[k][2]}"><b>${cnt[k]}</b><span>${STG[k][0]}</span></div>`).join('')}</div></a>`;
  };

  /* ---------- CSS ---------- */
  const css = `
  .fl-strip{padding:10px 14px;margin-bottom:12px;cursor:pointer}
  .fl-steps{display:flex;align-items:flex-start;gap:0;overflow-x:auto;padding-bottom:2px}
  .fl-st{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:70px;text-align:center;font-size:12.5px;color:var(--muted)}
  .fl-st i{font-style:normal;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;border:2px solid var(--line);background:var(--surface);font-weight:700;font-size:12px}
  .fl-st small{font-size:10.5px;opacity:.8;direction:ltr}
  .fl-st.done{color:var(--ink)}.fl-st.done i{background:var(--brand);border-color:var(--brand);color:#fff}
  .fl-st.cur{color:var(--ink);font-weight:700}.fl-st.cur i{border-color:var(--brand);color:var(--brand);box-shadow:0 0 0 4px color-mix(in srgb,var(--brand) 16%,transparent)}
  .fl-st.bad i{background:var(--danger);border-color:var(--danger);color:#fff}
  .fl-ln{flex:1 1 18px;min-width:14px;height:2px;background:var(--line);margin-top:13px}
  .fl-pipe{display:flex;align-items:stretch;gap:4px;overflow-x:auto;margin:12px 0 0;padding-bottom:4px}
  .fl-ar{align-self:center;color:var(--muted);font-style:normal}
  .fl-pc{flex:1 0 82px;border:1.5px solid var(--line);background:var(--surface);color:var(--ink);border-radius:12px;padding:8px 6px;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;font:inherit}
  .fl-pc b{font:700 22px/1 var(--display,inherit)}.fl-pc span{font-size:12px;color:var(--muted)}
  .fl-pc.bad b{color:var(--danger)}.fl-pc.ok b{color:var(--brand)}
  .fl-pc.on{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 18%,transparent)}
  .fl-dots{display:inline-flex;gap:3px}.fl-dots i{width:9px;height:9px;border-radius:50%;background:var(--line)}.fl-dots i.d{background:var(--brand)}.fl-dots i.b{background:var(--danger)}
  #flT tr[data-flr]{cursor:pointer}
  .fl-tl{display:flex;flex-direction:column;gap:0;margin-top:6px}
  .fl-ti{display:grid;grid-template-columns:28px 1fr;gap:10px;padding:6px 0;position:relative}
  .fl-ti i{font-style:normal;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;border:2px solid var(--line);font-size:12px;font-weight:700;background:var(--surface);z-index:1}
  .fl-ti:not(:last-child)::after{content:'';position:absolute;right:12px;top:30px;bottom:-6px;width:2px;background:var(--line)}
  .fl-ti.done i{background:var(--brand);border-color:var(--brand);color:#fff}.fl-ti.bad i{background:var(--danger);border-color:var(--danger);color:#fff}
  .fl-mini{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.fl-mini div{flex:1 0 70px;border:1px solid var(--line);border-radius:10px;padding:6px;text-align:center;display:flex;flex-direction:column}
  .fl-mini b{font:700 20px/1.1 var(--display,inherit)}.fl-mini span{font-size:11.5px;color:var(--muted)}.fl-mini .bad b{color:var(--danger)}.fl-mini .ok b{color:var(--brand)}`;
  function ensureCss() { if (!document.getElementById('flcss')) { const s = document.createElement('style'); s.id = 'flcss'; s.textContent = css; document.head.appendChild(s); } }
  F.ensureCss = ensureCss; ensureCss();
})();
