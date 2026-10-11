/* ميزان — CRM الصيدليات: متابعة المندوبين للصيدليات، التوزيع، المتابعات، الأداء، والربط بعملاء ميزان.
   البيانات: leads (مقسّمة chunks) + crm_reps. كل تعديل بيتسجّل في سجل الصيدلية. */
(function () {
  'use strict';
  const ST = { new: 'لسه محتاجة تواصل', contacted: 'تم التواصل', interested: 'مهتمة / متابعة', active_customer: 'عميل نشط', not_interested: 'مش مهتمة' };
  const ST_ORDER = ['new', 'contacted', 'interested', 'active_customer', 'not_interested'];
  const ST_TAG = { new: '', contacted: 'sale', interested: 'purchase', active_customer: 'ok', not_interested: 'bad' };
  const CF = { tab: 'list', q: '', region: '', district: '', status: '', rep: '', h24: false, linked: '', n: 120, sel: new Set(), due: 'today' };
  const digits = s => String(s || '').replace(/[^\d]/g, '');
  const phoneKey = s => { const d = digits(s); return d.length >= 8 ? d.slice(-9) : ''; };
  const waLink = ph => { let d = digits(ph); if (!d) return ''; if (d.startsWith('0')) d = '2' + d; return 'https://wa.me/' + d; };
  const isMgr = () => S.isAdmin || can('crmManage') || !!(myRep() && myRep().manager);
  const reps = () => L('crm_reps').filter(r => !r.inactive).sort((a, b) => (b.manager ? 1 : 0) - (a.manager ? 1 : 0) || String(a.name).localeCompare(b.name));
  const repName = id => { const r = id && G('crm_reps', id); return r ? r.name : ''; };
  const myRep = () => S.me && S.me.id ? L('crm_reps').find(r => r.userId === S.me.id) : null;
  function scope() {
    const all = L('leads');
    if (isMgr()) return all;
    const me = myRep(); if (!me) return [];
    return all.filter(l => l.assignedTo === me.id);
  }
  const nowIso = () => new Date().toISOString();
  const by = () => (S.me && S.me.name) || 'مستخدم';
  async function saveLead(id, cur, patch, logText) {
    const n = { ...cur, ...patch, updatedAt: nowIso(), updatedBy: by() };
    delete n.id;
    if (logText) n.log = [{ at: nowIso(), by: by(), t: logText }, ...(cur.log || [])].slice(0, 40);
    await put('leads', id, n);
    return n;
  }
  const relTime = iso => { if (!iso) return ''; const d = (Date.now() - new Date(iso)) / 864e5; if (d < 1 / 24) return 'من دقايق'; if (d < 1) return 'النهارده'; if (d < 2) return 'امبارح'; if (d < 30) return 'من ' + Math.floor(d) + ' يوم'; return String(iso).slice(0, 10); };

  /* ---------- link to Mizan customers ---------- */
  function partyStats(pid) {
    if (!pid || !G('parties', pid)) return null;
    const R = calc(); const t = today(); const m0 = t.slice(0, 8) + '01'; let month = 0, total = 0, last = '', n = 0;
    for (const i of L('invoices')) { if (i.partyId !== pid || (i.type !== 'sale' && i.type !== 'sret')) continue; const x = R.inv[i.id]; if (!x) continue; const v = (i.type === 'sale' ? 1 : -1) * x.total; total += v; if ((i.date || '') >= m0) month += v; if (i.type === 'sale') { n++; if ((i.date || '') > last) last = i.date; } }
    return { bal: R.party[pid] || 0, month, total, last, n };
  }
  function matchParty(l) {
    const k = phoneKey(l.phone); const nm = norm(l.name || '');
    const cs = L('parties').filter(p => p.kind !== 'vendor');
    return (k && cs.find(p => phoneKey(p.phone) === k)) || (nm.length > 5 && cs.find(p => norm(p.name) === nm)) || null;
  }

  /* ---------- main view ---------- */
  window.vCrm = function () {
    setTitle('CRM الصيدليات');
    const tab = route().a[0] || CF.tab; CF.tab = tab;
    const mgr = isMgr(); const me = myRep();
    if (!mgr && !me) {
      $('#view').innerHTML = `<div class="wrap" style="max-width:640px"><div class="card"><h3>حسابك مش مربوط بمندوب</h3><p class="muted" style="margin:0">اطلب من مديرة المبيعات أو المدير يربط حسابك باسمك في «الفريق» جوّه CRM الصيدليات، وبعدها هتظهر لك الصيدليات المتوزعة عليك.</p></div></div>`;
      return;
    }
    const tabs = [['list', 'الصيدليات'], ['due', 'المتابعات'], ...(mgr ? [['team', 'الفريق والأداء'], ['io', 'استيراد وتصدير']] : [])];
    $('#view').innerHTML = `<div class="wrap"><div class="row" style="margin-bottom:14px"><div class="seg">${tabs.map(([k, t]) => `<button data-ct="${k}" class="${k === tab ? 'on' : ''}">${t}</button>`).join('')}</div><span class="sp"></span>${!S.ro ? `<button class="btn p" id="crmNew">${ic('plus')}صيدلية جديدة</button>` : ''}</div><div id="crmB"></div></div>`;
    $$('[data-ct]').forEach(b => b.onclick = () => go('crm/' + b.dataset.ct));
    const nb = $('#crmNew'); if (nb) nb.onclick = () => leadModal(null);
    const box = $('#crmB');
    if (tab === 'due') vDue(box); else if (tab === 'team' && mgr) vTeam(box); else if (tab === 'io' && mgr) vIO(box); else vList(box);
  };

  function filtered() {
    const q = norm(CF.q || ''); const qd = digits(CF.q);
    return scope().filter(l => (!CF.region || l.region === CF.region) && (!CF.district || l.district === CF.district) && (!CF.status || l.status === CF.status)
      && (!CF.rep || (CF.rep === '_none' ? !l.assignedTo : l.assignedTo === CF.rep)) && (!CF.h24 || l.hours24)
      && (!CF.linked || (CF.linked === 'y' ? !!l.partyId : !l.partyId))
      && (!q || norm(l.name).includes(q) || norm(l.address).includes(q) || (qd.length >= 4 && digits(l.phone).includes(qd))));
  }

  function vList(box) {
    const mgr = isMgr(); const all = scope(); const xs = filtered();
    const regions = [...new Set(all.map(l => l.region).filter(Boolean))];
    const ro = (settings().crmRegionOrder || []); regions.sort((a, b) => ((ro.indexOf(a) + 1) || 99) - ((ro.indexOf(b) + 1) || 99) || a.localeCompare(b));
    const dists = [...new Set(all.filter(l => !CF.region || l.region === CF.region).map(l => l.district).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const cnt = s => all.filter(l => l.status === s).length; const t = today();
    const dueN = all.filter(l => l.nextAt && l.nextAt <= t && !['active_customer', 'not_interested'].includes(l.status)).length;
    const dor = settings().crmDistrictOrder || {}; const di = l => { const a = dor[l.region] || []; const i = a.indexOf(l.district); return i < 0 ? 99 : i; }; const ri = r => { const i = ro.indexOf(r); return i < 0 ? 99 : i; };
    xs.sort((a, b) => (ri(a.region) - ri(b.region)) || (di(a) - di(b)) || String(a.district || '').localeCompare(b.district || '') || String(a.name).localeCompare(b.name));
    const shown = xs.slice(0, CF.n); const rs = reps();
    box.innerHTML = `<div class="strip" style="grid-template-columns:repeat(${mgr ? 5 : 4},1fr);margin-bottom:14px">
        <div><div class="k">${mgr ? 'كل الصيدليات' : 'صيدلياتي'}</div><div class="v">${all.length}</div><div class="s">${mgr ? all.filter(l => !l.assignedTo).length + ' مش متوزعة' : ''}</div></div>
        <div><div class="k">تم التواصل</div><div class="v">${cnt('contacted')}</div></div><div><div class="k">مهتمة / متابعة</div><div class="v">${cnt('interested')}</div></div>
        <div><div class="k">عملاء نشطين</div><div class="v pos">${cnt('active_customer')}</div></div>${mgr ? `<div><div class="k">متابعات مستحقة</div><div class="v ${dueN ? 'neg' : ''}">${dueN}</div></div>` : ''}</div>
      <div class="card" style="padding:12px 14px;margin-bottom:12px"><div class="row">
        <input class="in" style="width:230px" id="cq" placeholder="بحث بالاسم أو التليفون أو العنوان" value="${esc(CF.q)}">
        <select class="in" style="width:190px" id="cr">${opts(regions.map(r => [r, r]), CF.region, 'كل المناطق')}</select>
        <select class="in" style="width:190px" id="cd">${opts(dists.map(r => [r, r]), CF.district, 'كل الأحياء')}</select>
        ${mgr ? `<select class="in" style="width:170px" id="crp">${opts([['_none', 'مش متوزعة'], ...rs.map(r => [r.id, r.name])], CF.rep, 'كل المندوبين')}</select>` : ''}
        <select class="in" style="width:150px" id="cl">${opts([['y', 'مربوطة بعميل في ميزان'], ['n', 'مش مربوطة']], CF.linked, 'الكل')}</select>
        <label class="row small" style="gap:6px"><input type="checkbox" id="ch" ${CF.h24 ? 'checked' : ''}>24 ساعة</label></div>
        <div class="seg" style="margin-top:10px">${[['', 'كل الحالات', all.length], ...ST_ORDER.map(s => [s, ST[s], cnt(s)])].map(([k, tt, n]) => `<button data-cs="${k}" class="${CF.status === k ? 'on' : ''}">${tt} <span class="small muted num">${n}</span></button>`).join('')}</div></div>
      ${mgr && !S.ro ? `<div class="card" id="cbulk" style="padding:10px 14px;margin-bottom:12px;${CF.sel.size ? '' : 'display:none'}"><div class="row"><b id="cbn">${CF.sel.size} مختارة</b>
        <select class="in" style="width:170px" id="cba">${opts(rs.map(r => [r.id, 'توزيع على: ' + r.name]), '', 'توزيع على…')}</select><button class="btn s" id="cbaGo">توزيع</button><button class="btn s" id="cbu">إلغاء التوزيع</button>
        <select class="in" style="width:170px" id="cbs">${opts(ST_ORDER.map(s => [s, ST[s]]), '', 'تغيير الحالة…')}</select><button class="btn s" id="cbsGo">تطبيق</button>
        <span class="sp"></span><button class="btn s" id="cball">اختيار كل النتايج (${xs.length})</button><button class="btn s" id="cbclr">إلغاء الاختيار</button><button class="btn s d" id="cbdel">حذف</button></div></div>` : ''}
      <div class="small muted" style="margin-bottom:8px">${xs.length} صيدلية${xs.length > shown.length ? ` — معروض ${shown.length}` : ''}</div>
      <div class="grid g3" id="cgrid">${shown.map(l => card(l, mgr, rs)).join('') || '<div class="empty card" style="grid-column:1/-1"><b>مفيش صيدليات بالفلاتر دي</b></div>'}</div>
      ${xs.length > shown.length ? `<div style="text-align:center;margin-top:14px"><button class="btn" id="cmore">عرض ${Math.min(120, xs.length - shown.length)} كمان</button></div>` : ''}`;
    const rer = () => { CF.n = 120; render(); };
    $('#cq').onchange = e => { CF.q = e.target.value.trim(); rer(); };
    $('#cr').onchange = e => { CF.region = e.target.value; CF.district = ''; rer(); };
    $('#cd').onchange = e => { CF.district = e.target.value; rer(); };
    const crp = $('#crp'); if (crp) crp.onchange = e => { CF.rep = e.target.value; rer(); };
    $('#cl').onchange = e => { CF.linked = e.target.value; rer(); };
    $('#ch').onchange = e => { CF.h24 = e.target.checked; rer(); };
    $$('[data-cs]').forEach(b => b.onclick = () => { CF.status = b.dataset.cs; rer(); });
    const more = $('#cmore'); if (more) more.onclick = () => { CF.n += 120; render(); };
    bindCards(box, xs);
  }
  function card(l, mgr, rs) {
    const ps = l.partyId ? partyStats(l.partyId) : null; const t = today();
    const due = l.nextAt && !['active_customer', 'not_interested'].includes(l.status) ? (l.nextAt < t ? 'neg' : l.nextAt === t ? 'purchase' : '') : null;
    return `<div class="card" data-lead="${esc(l.id)}" style="padding:12px 14px;display:flex;flex-direction:column;gap:8px;${CF.sel.has(l.id) ? 'border-color:var(--brand);box-shadow:0 0 0 2px var(--brand-soft)' : ''}">
      <div class="row" style="align-items:flex-start;flex-wrap:nowrap">${mgr && !S.ro ? `<input type="checkbox" data-csel="${esc(l.id)}" ${CF.sel.has(l.id) ? 'checked' : ''} style="margin-top:4px">` : ''}
        <div style="flex:1;min-width:0"><b style="cursor:pointer" data-open="${esc(l.id)}">${esc(l.name)}</b><div class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.address || '')}">${esc(l.district || '')}${l.address ? ' — ' + esc(l.address) : ''}</div></div>
        ${l.hours24 ? '<span class="tag">24 ساعة</span>' : ''}</div>
      <div class="row small" style="gap:6px">${!S.ro ? `<select class="in" data-cst="${esc(l.id)}" style="width:auto;padding:3px 8px;font-size:12.5px">${opts(ST_ORDER.map(s => [s, ST[s]]), l.status || 'new')}</select>` : `<span class="tag ${ST_TAG[l.status] || ''}">${ST[l.status] || ''}</span>`}
        ${mgr && !S.ro ? `<select class="in" data-crep="${esc(l.id)}" style="width:auto;padding:3px 8px;font-size:12.5px">${opts(rs.map(r => [r.id, r.name]), l.assignedTo || '', 'مش متوزعة')}</select>` : (l.assignedTo ? `<span class="tag sale">${esc(repName(l.assignedTo))}</span>` : '')}
        ${due != null ? `<span class="tag ${due}">متابعة ${l.nextAt}</span>` : ''}${ps ? `<span class="tag ok" title="عميل في ميزان">رصيد ${fmt(ps.bal)}</span>` : ''}</div>
      ${l.notes ? `<div class="small" style="background:var(--surface2);padding:6px 9px;border-radius:8px;white-space:pre-wrap;max-height:4.8em;overflow:hidden">${esc(l.notes)}</div>` : ''}
      <div class="row small" style="gap:6px">${l.phone ? `<a class="btn s" href="tel:${esc(digits(l.phone))}" dir="ltr">${esc(l.phone)}</a><a class="btn s" href="${waLink(l.phone)}" target="_blank" rel="noopener">واتساب</a>` : '<span class="muted">مفيش رقم</span>'}
        <span class="sp"></span><span class="muted" title="${esc(l.updatedBy || '')}">${l.updatedAt ? esc(relTime(l.updatedAt)) + (l.updatedBy ? ' · ' + esc(l.updatedBy) : '') : ''}</span><button class="btn s" data-open="${esc(l.id)}">تفاصيل</button></div></div>`;
  }
  function bindCards(box, xs) {
    box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { const l = G('leads', b.dataset.open); if (l) leadModal({ id: b.dataset.open, ...l }); });
    box.querySelectorAll('[data-cst]').forEach(s => s.onchange = async () => { const id = s.dataset.cst, l = G('leads', id); if (!l) return; const o = l.status || 'new';
      await saveLead(id, l, { status: s.value }, `الحالة: ${ST[o]} ← ${ST[s.value]}`); toast('اتحفظت الحالة: ' + ST[s.value]);
      if (s.value === 'active_customer' && !l.partyId) linkModal({ id, ...G('leads', id) }); });
    box.querySelectorAll('[data-crep]').forEach(s => s.onchange = async () => { const id = s.dataset.crep, l = G('leads', id); if (!l) return;
      await saveLead(id, l, { assignedTo: s.value || null }, `التوزيع: ${repName(l.assignedTo) || 'مش متوزعة'} ← ${repName(s.value) || 'مش متوزعة'}`); toast(s.value ? 'اتوزعت على ' + repName(s.value) : 'اتلغى التوزيع'); });
    box.querySelectorAll('[data-csel]').forEach(c => c.onchange = () => { const id = c.dataset.csel; if (c.checked) CF.sel.add(id); else CF.sel.delete(id); const bb = $('#cbulk'); if (bb) { bb.style.display = CF.sel.size ? '' : 'none'; $('#cbn').textContent = CF.sel.size + ' مختارة'; } c.closest('[data-lead]').style.borderColor = c.checked ? 'var(--brand)' : ''; });
    const bulk = async (patch, txt) => { const ids = [...CF.sel]; const items = ids.map(id => { const l = G('leads', id); if (!l) return null; const n = { ...l, ...patch, updatedAt: nowIso(), updatedBy: by(), log: [{ at: nowIso(), by: by(), t: txt(l) }, ...(l.log || [])].slice(0, 40) }; return ['leads', id, n]; }).filter(Boolean);
      await putMany(items); CF.sel.clear(); toast(`اتعدّلت ${items.length} صيدلية`); render(); };
    const g = id => $('#' + id);
    if (g('cbaGo')) g('cbaGo').onclick = () => { const r = g('cba').value; if (!r) { toast('اختار المندوب', 'err'); return; } bulk({ assignedTo: r }, l => `التوزيع: ${repName(l.assignedTo) || 'مش متوزعة'} ← ${repName(r)}`); };
    if (g('cbu')) g('cbu').onclick = () => bulk({ assignedTo: null }, l => `التوزيع: ${repName(l.assignedTo) || '—'} ← مش متوزعة`);
    if (g('cbsGo')) g('cbsGo').onclick = () => { const s = g('cbs').value; if (!s) { toast('اختار الحالة', 'err'); return; } bulk({ status: s }, l => `الحالة: ${ST[l.status || 'new']} ← ${ST[s]}`); };
    if (g('cball')) g('cball').onclick = () => { xs.forEach(l => CF.sel.add(l.id)); render(); };
    if (g('cbclr')) g('cbclr').onclick = () => { CF.sel.clear(); render(); };
    if (g('cbdel')) g('cbdel').onclick = async () => { if (!(await confirmBox(`حذف ${CF.sel.size} صيدلية نهائيًا من CRM؟`, 'حذف', true))) return; for (const id of [...CF.sel]) await del('leads', id); await audit('crm', 'bulk', 'حذف صيدليات', CF.sel.size, '', 'CRM'); CF.sel.clear(); toast('تم الحذف'); };
  }

  /* ---------- lead detail ---------- */
  function leadModal(l) {
    const mgr = isMgr(); const isNew = !l; const me = myRep();
    const x = l || { name: '', phone: '', address: '', region: CF.region || '', district: CF.district || '', status: 'new', assignedTo: mgr ? '' : (me && me.id) || '', notes: '', hours24: false, source: 'manual' };
    const all = L('leads'); const regions = [...new Set(all.map(v => v.region).filter(Boolean))]; const dists = [...new Set(all.map(v => v.district).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const ps = x.partyId ? partyStats(x.partyId) : null; const sug = !x.partyId && !isNew ? matchParty(x) : null;
    modal(`<div class="row" style="align-items:flex-start"><h2 style="flex:1;margin:0">${isNew ? 'صيدلية جديدة' : esc(x.name)}</h2>${!isNew ? `<span class="tag ${ST_TAG[x.status] || ''}">${ST[x.status] || ''}</span>` : ''}</div>
      ${ps ? `<div class="card" style="margin:12px 0;padding:10px 12px;border-color:var(--brand)"><div class="row small" style="gap:14px"><b>عميل في ميزان: ${esc(partyName(x.partyId))}</b><span>الرصيد <b class="num">${fmt(ps.bal)}</b></span><span>مبيعات الشهر <b class="num">${fmt(ps.month)}</b></span><span>آخر فاتورة <b class="num">${ps.last || '—'}</b></span><span>${ps.n} فاتورة</span><span class="sp"></span><button class="btn s" id="lm_st">كشف حساب</button><button class="btn s p" id="lm_sale">${ic('sale')}فاتورة بيع</button></div></div>`
        : sug ? `<div class="card" style="margin:12px 0;padding:10px 12px;border-color:var(--gold)"><div class="row small"><span>ممكن تكون العميل <b>${esc(sug.name)}</b> اللي في ميزان (${esc(sug.phone || '')})</span><span class="sp"></span><button class="btn s" id="lm_sug">ربطها بيه</button></div></div>` : ''}
      <div class="grid g2" style="margin-top:12px">
        <label class="f">اسم الصيدلية *<input class="in" id="lm_n" value="${esc(x.name)}"></label>
        <label class="f">التليفون<input class="in" id="lm_p" dir="ltr" inputmode="tel" value="${esc(x.phone || '')}"></label>
        <label class="f">المنطقة<input class="in" id="lm_r" list="lm_rl" value="${esc(x.region || '')}"><datalist id="lm_rl">${regions.map(r => `<option value="${esc(r)}">`).join('')}</datalist></label>
        <label class="f">الحي<input class="in" id="lm_d" list="lm_dl" value="${esc(x.district || '')}"><datalist id="lm_dl">${dists.map(r => `<option value="${esc(r)}">`).join('')}</datalist></label>
        <label class="f" style="grid-column:1/-1">العنوان<input class="in" id="lm_a" value="${esc(x.address || '')}"></label>
        <label class="f">الحالة<select class="in" id="lm_s">${opts(ST_ORDER.map(s => [s, ST[s]]), x.status || 'new')}</select></label>
        <label class="f">المتابعة الجاية<input class="in" type="date" id="lm_nx" value="${esc(x.nextAt || '')}"></label>
        ${mgr ? `<label class="f">المندوب<select class="in" id="lm_rep">${opts(reps().map(r => [r.id, r.name + (r.tag ? ' — ' + r.tag : '')]), x.assignedTo || '', 'مش متوزعة')}</select></label>` : `<div class="f small muted">المندوب: <b>${esc(repName(x.assignedTo) || '—')}</b></div>`}
        <label class="row small" style="gap:6px;align-self:end"><input type="checkbox" id="lm_h" ${x.hours24 ? 'checked' : ''}>شغالة 24 ساعة</label>
        <label class="f" style="grid-column:1/-1">ملاحظات<textarea class="in" id="lm_no" rows="3">${esc(x.notes || '')}</textarea></label>
        <label class="f" style="grid-column:1/-1">إضافة تحديث للسجل (مكالمة / زيارة)<div class="row"><input class="in" id="lm_lg" placeholder="مثال: كلمت د. أحمد — عايز عرض أسعار الأسبوع الجاي" style="flex:1"></div></label></div>
      ${!isNew && (x.log || []).length ? `<div style="margin-top:12px"><b class="small">السجل</b><div class="tw" style="max-height:180px;overflow:auto;margin-top:6px"><table class="t" style="font-size:13px"><tbody>${(x.log || []).map(e => `<tr><td class="num muted" style="white-space:nowrap">${esc(String(e.at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(e.by || '')}</td><td>${esc(e.t || '')}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      <div class="row" style="margin-top:14px">${!S.ro ? '<button class="btn p" id="lm_sv">حفظ</button>' : ''}${x.phone ? `<a class="btn" href="tel:${esc(digits(x.phone))}">اتصال</a><a class="btn" href="${waLink(x.phone)}" target="_blank" rel="noopener">واتساب</a>` : ''}
        ${!isNew && !x.partyId && !S.ro ? '<button class="btn" id="lm_cv">تحويل لعميل في ميزان</button>' : ''}<span class="sp"></span>${!isNew && mgr && !S.ro ? '<button class="btn d" id="lm_del">حذف</button>' : ''}<button class="btn" data-close>إغلاق</button></div>`, true);
    const sv = $('#lm_sv'); if (sv) sv.onclick = async () => {
      const name = $('#lm_n').value.trim(); if (!name) { toast('اكتب اسم الصيدلية', 'err'); return; }
      const patch = { name, phone: $('#lm_p').value.trim(), region: $('#lm_r').value.trim(), district: $('#lm_d').value.trim(), address: $('#lm_a').value.trim(), status: $('#lm_s').value, nextAt: $('#lm_nx').value || '', hours24: $('#lm_h').checked, notes: $('#lm_no').value.trim() };
      if (mgr) patch.assignedTo = $('#lm_rep').value || null;
      const ch = []; if (!isNew) { if (patch.status !== (x.status || 'new')) ch.push(`الحالة: ${ST[x.status || 'new']} ← ${ST[patch.status]}`); if (mgr && (patch.assignedTo || null) !== (x.assignedTo || null)) ch.push(`التوزيع: ${repName(x.assignedTo) || 'مش متوزعة'} ← ${repName(patch.assignedTo) || 'مش متوزعة'}`); if ((patch.nextAt || '') !== (x.nextAt || '') && patch.nextAt) ch.push('متابعة يوم ' + patch.nextAt); if (patch.notes !== (x.notes || '')) ch.push('تعديل الملاحظات'); }
      const lg = $('#lm_lg').value.trim(); if (lg) ch.unshift(lg);
      if (!isNew && patch.phone && phoneKey(patch.phone) && L('leads').some(o => o.id !== x.id && phoneKey(o.phone) === phoneKey(patch.phone))) toast('تنبيه: الرقم ده متسجل لصيدلية تانية', 'err');
      const id = isNew ? 'L' + uid().slice(-12) : x.id;
      const cur = isNew ? { createdAt: nowIso(), createdBy: by(), source: 'manual', log: [] } : G('leads', id);
      if (isNew && phoneKey(patch.phone) && L('leads').some(o => phoneKey(o.phone) === phoneKey(patch.phone))) { if (!(await confirmBox('فيه صيدلية متسجلة بنفس الرقم. تضيفها برضه؟', 'إضافة'))) return; }
      await saveLead(id, cur, patch, isNew ? 'إضافة الصيدلية' + (lg ? ' — ' + lg : '') : ch.join(' · ') || null);
      closeModal(); toast('تم الحفظ');
      if (patch.status === 'active_customer' && !(cur && cur.partyId)) linkModal({ id, ...G('leads', id) });
    };
    const dl = $('#lm_del'); if (dl) dl.onclick = async () => { if (!(await confirmBox('حذف «' + x.name + '» من CRM؟', 'حذف', true))) return; await del('leads', x.id); await audit('crm', x.id, 'حذف صيدلية', x.name, '', 'CRM'); toast('تم الحذف'); };
    const cv = $('#lm_cv'); if (cv) cv.onclick = () => linkModal(x);
    const sg = $('#lm_sug'); if (sg) sg.onclick = async () => { await saveLead(x.id, G('leads', x.id), { partyId: sug.id }, 'ربط بالعميل ' + sug.name); toast('اتربطت بالعميل ' + sug.name); closeModal(); };
    const st = $('#lm_st'); if (st) st.onclick = () => { closeModal(); statement(x.partyId); };
    const sl = $('#lm_sale'); if (sl) sl.onclick = () => { closeModal(); ED = null; go('sale'); setTimeout(() => { if (ED && !ED.id) { ED.inv.partyId = x.partyId; const t = tierOf(x.partyId); render(); toast('فاتورة بيع لـ ' + partyName(x.partyId) + (t ? ' — ' + t.name : '')); } }, 120); };
  }
  function linkModal(l) {
    const sug = matchParty(l); const cs = L('parties').filter(p => p.kind !== 'vendor').sort((a, b) => a.name.localeCompare(b.name));
    modal(`<h2>ربط «${esc(l.name)}» بعميل في ميزان</h2>
      <p class="small muted" style="margin-top:0">لما الصيدلية تبقى عميل، اربطها بحساب في ميزان عشان المبيعات والرصيد يظهروا هنا وفي أداء المندوب.</p>
      <div class="grid g2"><div class="card"><h3>عميل جديد</h3><label class="f">الاسم<input class="in" id="lk_n" value="${esc(l.name)}"></label><label class="f" style="margin-top:8px">الشريحة<select class="in" id="lk_t">${opts(tiers().map(t => [t.id, `${t.name} (التكلفة + ${fmt(t.markup)}%)`]), (tiers()[0] || {}).id || '', 'بدون شريحة')}</select></label><button class="btn p" id="lk_new" style="margin-top:10px">إنشاء العميل وربطه</button></div>
        <div class="card"><h3>عميل موجود</h3><select class="in" id="lk_ex">${opts(cs.map(p => [p.id, p.name + (p.phone ? ' — ' + p.phone : '')]), sug ? sug.id : '', '— اختار العميل —')}</select>${sug ? `<p class="small" style="color:var(--gold)">مقترح: ${esc(sug.name)} (نفس الرقم أو الاسم)</p>` : ''}<button class="btn" id="lk_go" style="margin-top:10px">ربط</button></div></div>
      <div class="row" style="margin-top:12px"><span class="sp"></span><button class="btn" data-close>بعدين</button></div>`, true);
    $('#lk_new').onclick = async () => { const name = $('#lk_n').value.trim(); if (!name) return; const pid = uid(); await put('parties', pid, { kind: 'customer', name, phone: l.phone || '', address: [l.address, l.district].filter(Boolean).join(' — '), tier: $('#lk_t').value, openBalance: 0 });
      await saveLead(l.id, G('leads', l.id), { partyId: pid, status: 'active_customer' }, 'تحويل لعميل في ميزان: ' + name); closeModal(); toast('اتعمل العميل واتربط بالصيدلية'); };
    $('#lk_go').onclick = async () => { const pid = $('#lk_ex').value; if (!pid) { toast('اختار العميل', 'err'); return; } await saveLead(l.id, G('leads', l.id), { partyId: pid, status: 'active_customer' }, 'ربط بالعميل ' + partyName(pid)); closeModal(); toast('اتربطت'); };
  }

  /* ---------- follow-ups ---------- */
  function vDue(box) {
    const t = today(), w = addDays(t, 7); const mgr = isMgr(); const rs = reps();
    let xs = scope().filter(l => l.nextAt && !['active_customer', 'not_interested'].includes(l.status));
    if (mgr && CF.rep) xs = xs.filter(l => l.assignedTo === CF.rep);
    const over = xs.filter(l => l.nextAt < t), tod = xs.filter(l => l.nextAt === t), wk = xs.filter(l => l.nextAt > t && l.nextAt <= w);
    const stale = scope().filter(l => l.status === 'interested' && !l.nextAt);
    const sec = (title, arr, cls) => `<h3 style="margin:18px 0 8px">${title} <span class="tag ${cls || ''}">${arr.length}</span></h3><div class="grid g3">${arr.sort((a, b) => a.nextAt.localeCompare(b.nextAt)).map(l => card(l, mgr, rs)).join('') || '<p class="muted small">مفيش</p>'}</div>`;
    box.innerHTML = `${mgr ? `<div class="row" style="margin-bottom:6px"><select class="in" style="width:200px" id="drp">${opts(rs.map(r => [r.id, r.name]), CF.rep, 'كل المندوبين')}</select></div>` : ''}
      ${sec('متأخرة', over, 'bad')}${sec('النهارده', tod, 'purchase')}${sec('الأسبوع ده', wk)}
      ${stale.length ? `<h3 style="margin:18px 0 8px">مهتمة ومالهاش ميعاد متابعة <span class="tag">${stale.length}</span></h3><div class="grid g3">${stale.slice(0, 30).map(l => card(l, mgr, rs)).join('')}</div>` : ''}`;
    const d = $('#drp'); if (d) d.onchange = e => { CF.rep = e.target.value; render(); };
    bindCards(box, []);
  }

  /* ---------- team & performance ---------- */
  function vTeam(box) {
    const rs = L('crm_reps').sort((a, b) => (b.manager ? 1 : 0) - (a.manager ? 1 : 0)); const leads = L('leads'); const t7 = Date.now() - 7 * 864e5; const m0 = today().slice(0, 8) + '01';
    const R = calc(); const users = (window.MZ && MZ.users) || [];
    const rows = rs.map(r => { const mine = leads.filter(l => l.assignedTo === r.id); const c = s => mine.filter(l => l.status === s).length;
      let acts = 0; for (const l of leads) for (const e of (l.log || [])) if (e.by === r.name && new Date(e.at).getTime() >= t7) acts++;
      let sales = 0; const pids = new Set(mine.map(l => l.partyId).filter(Boolean));
      for (const i of L('invoices')) if (pids.has(i.partyId) && (i.date || '') >= m0 && (i.type === 'sale' || i.type === 'sret')) { const x = R.inv[i.id]; if (x) sales += (i.type === 'sale' ? 1 : -1) * x.total; }
      return { r, n: mine.length, c, acts, sales, linked: pids.size }; });
    box.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="muted small" style="margin:0;flex:1">اربط كل مندوب بحساب دخول في ميزان، وهو هيشوف الصيدليات المتوزعة عليه بس. مديرة المبيعات تاخد صلاحية «CRM: توزيع وإدارة» من المستخدمين والصلاحيات.</p>${!S.ro ? `<button class="btn p" id="trNew">${ic('plus')}مندوب جديد</button>` : ''}</div>
      <div class="tw"><table class="t"><thead><tr><th>المندوب</th><th>حساب الدخول</th><th class="n">الصيدليات</th>${ST_ORDER.map(s => `<th class="n">${ST[s]}</th>`).join('')}<th class="n">تحديثات آخر 7 أيام</th><th class="n">عملاء مربوطين</th><th class="n">مبيعاتهم الشهر ده</th><th></th></tr></thead><tbody>
      ${rows.map(x => `<tr><td><b>${esc(x.r.name)}</b><div class="small muted">${esc(x.r.tag || '')}${x.r.inactive ? ' · موقوف' : ''}</div></td>
        <td>${!S.ro ? `<select class="in" style="width:180px" data-tru="${esc(x.r.id)}">${opts(users.filter(u => !u.disabled).map(u => [u.id, u.name + ' (' + u.username + ')']), x.r.userId || '', '— مش مربوط —')}</select>` : esc(whoName(x.r.userId))}</td>
        <td class="n">${x.n}</td>${ST_ORDER.map(s => `<td class="n">${x.c(s) || ''}</td>`).join('')}<td class="n">${x.acts}</td><td class="n">${x.linked}</td><td class="n">${fmt(x.sales)}</td>
        <td>${!S.ro ? `<button class="btn s" data-tre="${esc(x.r.id)}">تعديل</button>` : ''}<button class="btn s" data-trv="${esc(x.r.id)}">صيدلياته</button></td></tr>`).join('') || '<tr><td colspan="12" class="muted">مفيش مندوبين لسه — أضف الفريق أو استورد بيانات الـ CRM القديم</td></tr>'}
      <tr style="font-weight:600;background:var(--surface2)"><td>مش متوزعة</td><td></td><td class="n">${leads.filter(l => !l.assignedTo).length}</td><td colspan="9"></td></tr></tbody></table></div>
      <p class="small muted">لو المندوب ملوش حساب دخول، اعمله من <a href="#/users">المستخدمين والصلاحيات</a> بدور فيه صلاحية «CRM الصيدليات»، وارجع اربطه هنا.</p>`;
    $$('[data-tru]').forEach(s => s.onchange = async () => { const r = G('crm_reps', s.dataset.tru); const other = s.value && L('crm_reps').find(o => o.userId === s.value && o.id !== s.dataset.tru); if (other) { toast('الحساب ده مربوط بـ ' + other.name + ' — هيتشال منه', 'err'); await put('crm_reps', other.id, { ...G('crm_reps', other.id), userId: '' }); } await put('crm_reps', s.dataset.tru, { ...r, userId: s.value }); toast('تم الربط'); });
    $$('[data-tre]').forEach(b => b.onclick = () => repModal({ id: b.dataset.tre, ...G('crm_reps', b.dataset.tre) }));
    $$('[data-trv]').forEach(b => b.onclick = () => { CF.rep = b.dataset.trv; CF.status = ''; go('crm/list'); });
    const n = $('#trNew'); if (n) n.onclick = () => repModal(null);
  }
  function repModal(r) {
    const x = r || { name: '', tag: 'سيلز', manager: false };
    modal(`<h2>${r ? 'تعديل مندوب' : 'مندوب جديد'}</h2><div class="grid g2"><label class="f">الاسم<input class="in" id="rp_n" value="${esc(x.name)}"></label><label class="f">الوظيفة<input class="in" id="rp_t" value="${esc(x.tag || '')}"></label></div>
      <label class="row small" style="gap:6px;margin-top:10px"><input type="checkbox" id="rp_m" ${x.manager ? 'checked' : ''}>مدير/ة مبيعات</label>${r ? `<label class="row small" style="gap:6px;margin-top:6px"><input type="checkbox" id="rp_x" ${x.inactive ? 'checked' : ''}>موقوف (يختفي من قوايم التوزيع)</label>` : ''}
      <div class="row" style="margin-top:14px"><button class="btn p" id="rp_s">حفظ</button><button class="btn" data-close>إلغاء</button></div>`);
    $('#rp_s').onclick = async () => { const name = $('#rp_n').value.trim(); if (!name) return; const id = r ? r.id : 'r' + uid().slice(-10); const cur = r ? G('crm_reps', r.id) : {};
      await put('crm_reps', id, { ...cur, name, tag: $('#rp_t').value.trim(), manager: $('#rp_m').checked, ...(r ? { inactive: $('#rp_x').checked || undefined } : {}) }); closeModal(); toast('تم الحفظ'); };
  }

  /* ---------- import / export ---------- */
  function vIO(box) {
    const n = L('leads').length;
    box.innerHTML = `<div class="grid g2" style="align-items:start">
      <div class="card"><h3>استيراد بيانات الـ CRM القديم</h3><p class="small muted" style="margin-top:0">ارفع ملف <b>crm-pharmacies.json</b> (نسخة بيانات تطبيق «سيلز صيدليات القاهرة»). الصيدليات والتوزيع والحالات والملاحظات بتتنقل زي ما هي، والفريق (ندى، إسراء، مصري، علا، حسين) بيتعمل لوحده. الصيدليات الموجودة بنفس الكود بتتحدّث.</p>
        <input type="file" id="ioJ" accept=".json,application/json" hidden><button class="btn p" id="ioJb">اختيار الملف</button></div>
      <div class="card"><h3>استيراد من Excel</h3><p class="small muted" style="margin-top:0">أعمدة: اسم الصيدلية، التليفون، العنوان، المنطقة، الحي، الحالة، المندوب، ملاحظات. الصيدلية اللي رقمها متسجل قبل كده بتتجاهل.</p>
        <input type="file" id="ioX" accept=".xlsx,.xls,.csv" hidden><div class="row"><button class="btn" id="ioXb">اختيار ملف Excel</button><button class="btn s" id="ioT">تنزيل قالب</button></div></div>
      <div class="card"><h3>تصدير</h3><p class="small muted" style="margin-top:0">${n} صيدلية بكل بياناتها.</p><button class="btn" id="ioE">${ic('dl')}Excel</button></div>
      <div class="card"><h3>ربط تلقائي بعملاء ميزان</h3><p class="small muted" style="margin-top:0">بيدوّر على كل صيدلية مش مربوطة، ولو لقى عميل في ميزان بنفس رقم التليفون أو نفس الاسم بالظبط بيربطهم.</p><button class="btn" id="ioL">ابدأ الربط</button><div id="ioLr" class="small" style="margin-top:8px"></div></div></div>`;
    $('#ioJb').onclick = () => $('#ioJ').click();
    $('#ioJ').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); await importJSON(j); } catch (x) { toast('الملف مش مظبوط: ' + (x.message || x), 'err'); } e.target.value = ''; };
    $('#ioXb').onclick = () => $('#ioX').click();
    $('#ioT').onclick = () => xlsxOut('قالب_صيدليات.xlsx', [['اسم الصيدلية', 'التليفون', 'العنوان', 'المنطقة', 'الحي', 'الحالة', 'المندوب', 'ملاحظات'], ['صيدلية د. أحمد', '01000000000', '12 شارع ...', 'شرق القاهرة', 'مدينة نصر', 'لسه محتاجة تواصل', '', '']], 'صيدليات');
    $('#ioX').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { await importXlsx(f); } catch (x) { toast('تعذّر قراءة الملف', 'err'); } e.target.value = ''; };
    $('#ioE').onclick = () => xlsxOut('صيدليات_CRM_' + today() + '.xlsx', [['اسم الصيدلية', 'التليفون', 'العنوان', 'المنطقة', 'الحي', '24 ساعة', 'الحالة', 'المندوب', 'المتابعة الجاية', 'ملاحظات', 'عميل ميزان', 'آخر تحديث', 'بواسطة'],
      ...L('leads').map(l => [l.name, l.phone || '', l.address || '', l.region || '', l.district || '', l.hours24 ? 'نعم' : '', ST[l.status] || '', repName(l.assignedTo), l.nextAt || '', l.notes || '', l.partyId ? partyName(l.partyId) : '', String(l.updatedAt || '').slice(0, 16).replace('T', ' '), l.updatedBy || ''])], 'الصيدليات');
    $('#ioL').onclick = async () => { const items = []; for (const l of L('leads')) { if (l.partyId) continue; const p = matchParty(l); if (p) items.push(['leads', l.id, { ...l, partyId: p.id, updatedAt: nowIso(), updatedBy: by(), log: [{ at: nowIso(), by: by(), t: 'ربط تلقائي بالعميل ' + p.name }, ...(l.log || [])].slice(0, 40) }]); }
      items.forEach(x => delete x[2].id); if (items.length) await putMany(items); $('#ioLr').textContent = items.length ? `اتربطت ${items.length} صيدلية بعملاء ميزان.` : 'مفيش تطابق جديد.'; };
  }
  async function importJSON(j) {
    const ph = Array.isArray(j) ? j : (j.pharmacies || (j.state && j.state.pharmacies));
    if (!Array.isArray(ph) || !ph.length) throw new Error('مفيش صيدليات في الملف');
    const roles = j.reps || j.roles || {};
    const repMap = {};
    for (const [k, v] of Object.entries(roles)) { const id = 'r_' + k; repMap[k] = id; const cur = G('crm_reps', id); if (!cur) await put('crm_reps', id, { name: v.name || k, tag: v.tag || '', manager: !!v.manager, key: k }); }
    for (const p of ph) if (p.assignedTo && !repMap[p.assignedTo]) { const id = 'r_' + p.assignedTo; repMap[p.assignedTo] = id; if (!G('crm_reps', id)) await put('crm_reps', id, { name: p.assignedTo, tag: 'سيلز', key: p.assignedTo }); }
    if (j.regionOrder && S.isAdmin) await put('settings', 'main', { ...settings(), crmRegionOrder: j.regionOrder, ...(j.districtOrder ? { crmDistrictOrder: j.districtOrder } : {}) });
    const items = ph.map(p => { const id = 'L' + String(p.id || uid()).replace(/[^A-Za-z0-9_-]/g, ''); const cur = G('leads', id) || {};
      return ['leads', id, { ...cur, name: p.name || '', phone: p.phone || '', address: p.address || '', region: p.region || '', district: p.district || '', hours24: !!p.hours24, source: p.source || 'import', assignedTo: p.assignedTo ? repMap[p.assignedTo] : null, status: ST[p.status] ? p.status : 'new', notes: p.notes || '', updatedAt: p.updatedAt || cur.updatedAt || null, updatedBy: p.updatedBy || cur.updatedBy || null, createdAt: cur.createdAt || nowIso(), log: cur.log || (p.updatedAt ? [{ at: p.updatedAt, by: p.updatedBy || '', t: 'آخر تحديث في الـ CRM القديم: ' + (ST[p.status] || '') }] : []) }]; });
    toast('جارٍ استيراد ' + items.length + ' صيدلية…');
    await putMany(items);
    await audit('crm', 'import', 'استيراد CRM', '', items.length + ' صيدلية', 'CRM');
    toast(`تم استيراد ${items.length} صيدلية و${Object.keys(repMap).length} مندوب`); go('crm/team');
  }
  async function importXlsx(f) {
    if (!window.XLSX) { toast('مكتبة Excel مش محمّلة — اتأكد من النت', 'err'); return; }
    const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' }); const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }).filter(r => r.some(c => String(c).trim() !== '')); if (rows.length < 2) { toast('الشيت فاضي', 'err'); return; }
    const hdr = rows[0].map(x => norm(String(x || '')));
    const col = (...names) => hdr.findIndex(h => names.some(n => h.includes(norm(n))));
    const C = { n: col('اسم', 'الصيدلية', 'name'), p: col('تليفون', 'موبايل', 'رقم', 'phone'), a: col('عنوان', 'address'), r: col('منطقة', 'region'), d: col('حي', 'district'), s: col('حالة', 'status'), rep: col('مندوب', 'سيلز'), no: col('ملاحظ', 'notes') };
    if (C.n < 0) { toast('مش لاقي عمود «اسم الصيدلية»', 'err'); return; }
    const byName = Object.fromEntries(Object.entries(ST).map(([k, v]) => [norm(v), k]));
    const have = new Set(L('leads').map(l => phoneKey(l.phone)).filter(Boolean)); const items = []; let skip = 0;
    for (const r of rows.slice(1)) { const name = String(r[C.n] || '').trim(); if (!name) continue; const phone = C.p >= 0 ? String(r[C.p] || '').trim() : ''; const k = phoneKey(phone); if (k && have.has(k)) { skip++; continue; } if (k) have.add(k);
      const rn = C.rep >= 0 ? norm(String(r[C.rep] || '')) : ''; const rep = rn ? L('crm_reps').find(x => norm(x.name) === rn) : null; const sv = C.s >= 0 ? norm(String(r[C.s] || '')) : '';
      items.push(['leads', 'L' + uid().slice(-12), { name, phone, address: C.a >= 0 ? String(r[C.a] || '') : '', region: C.r >= 0 ? String(r[C.r] || '') : '', district: C.d >= 0 ? String(r[C.d] || '') : '', status: byName[sv] || 'new', assignedTo: rep ? rep.id : null, notes: C.no >= 0 ? String(r[C.no] || '') : '', source: 'excel', createdAt: nowIso(), updatedAt: nowIso(), updatedBy: by(), log: [{ at: nowIso(), by: by(), t: 'استيراد من Excel' }] }]); }
    if (items.length) await putMany(items); toast(`اتضافت ${items.length} صيدلية${skip ? ` — واتجاهلت ${skip} متكررة` : ''}`);
  }

  window.MZ_CRM = { scope, ST, partyStats };
})();
