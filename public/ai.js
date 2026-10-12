/* ميزان — المساعد الذكي.
   The model runs at the provider (via /api/ai/chat on our server, which holds the key).
   Tools run here in the browser against the data the user is already allowed to see,
   so the assistant can only read — it never writes — and respects the user's permissions. */
(function () {
  'use strict';
  const AI = { cfg: null, msgs: [], busy: false, open: false };
  window.MZ_AI = AI;
  const r0 = n => Math.round((+n || 0) * 100) / 100;
  const q3 = n => Math.round((+n || 0) * 1000) / 1000;
  const sc = () => can('seeCost');
  const H = { 'Content-Type': 'application/json', 'X-Mizan': '1' };

  /* ---------- helpers ---------- */
  function findProducts(q, lim) {
    q = String(q || '').trim(); if (!q) return [];
    const ex = L('products').filter(p => bcMatch(p, q, true));
    if (ex.length) return ex.slice(0, lim);
    let r = pSearch(q, lim);
    if (!r.length) {
      const ws = norm(q).split(/\s+/).filter(w => w.length > 1);
      if (ws.length) r = pIndex().filter(x => ws.every(w => x.n.includes(w) || x.c.includes(w))).slice(0, lim).map(x => x.p);
    }
    return r;
  }
  function findParty(q, kind) {
    q = String(q || '').trim(); if (!q) return null;
    const ps = L('parties').filter(p => !kind || p.kind === kind);
    const nq = norm(q);
    return ps.find(p => p.id === q) || ps.find(p => norm(p.name) === nq) || ps.find(p => norm(p.name).includes(nq)) ||
      (() => { const ws = nq.split(/\s+/).filter(w => w.length > 1); return ws.length ? ps.find(p => ws.every(w => norm(p.name).includes(w))) : null; })();
  }
  const findStore = q => { if (!q) return ''; const n = norm(q); const s = stores().find(s => s.id === q || norm(s.name).includes(n)); return s ? s.id : ''; };
  const dateOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  function period(a) {
    const t = today();
    let from = dateOk(a.from) ? a.from : '', to = dateOk(a.to) ? a.to : '';
    if (!from && !to) { from = t.slice(0, 8) + '01'; to = t; }
    return { from, to };
  }
  function prodRow(p, store) {
    const st = calc().stock[p.id] || { by: {} };
    const by = {}; for (const [sid, q] of Object.entries(st.by || {})) if (Math.abs(q) > 0.0001) by[storeName(sid)] = q3(q);
    const o = { code: p.code || '', name: p.name, group: p.group || '', unit: p.unit || '', barcode: p.barcode || '',
      qty_total: q3(qtyIn(p.id)), qty_by_store: by, consumer_price: r0(consOf(p)) };
    if (store) o.qty_in_store = q3(qtyIn(p.id, store));
    if (p.minQty != null && p.minQty !== '') o.reorder_level = +p.minQty;
    if (sc()) { const c = avgCost(p.id); o.avg_cost = r0(c); o.tier_prices = Object.fromEntries(tiers().map(t => [t.name, r0(c * (1 + (+t.markup || 0) / 100))])); }
    return o;
  }
  function invRow(inv) {
    const t = calc().inv[inv.id] || invTotals(inv);
    const o = { no: inv.no, date: inv.date, type: (TYPES[inv.type] || {}).t || inv.type, party: partyName(inv.partyId) || (inv.partyId ? '' : 'نقدي'),
      store: storeName(inv.storeId), items: (inv.lines || []).length, total: r0(t.total), paid: r0(inv.paid), rest: r0(t.total - (+inv.paid || 0)) };
    if (sc() && (inv.type === 'sale' || inv.type === 'sret') && t.profit != null) o.profit = r0(t.profit);
    if (inv.note) o.note = String(inv.note).slice(0, 80);
    return o;
  }
  const deny = w => ({ error: 'المستخدم ده مالوش صلاحية ' + w });

  /* ---------- tools ---------- */
  const TOOLS = {
    search_products: {
      d: 'ابحث عن صنف بالاسم أو الكود أو الباركود. يرجّع الرصيد في كل مخزن وسعر المستهلك' + ' (والتكلفة وأسعار الشرائح لو مسموح).',
      p: { query: ['string', 'اسم/كود/باركود'], store: ['string', 'اسم المخزن (اختياري)'], limit: ['integer', 'افتراضي 8'] }, req: ['query'],
      run(a) {
        const lim = Math.min(20, +a.limit || 8); const st = findStore(a.store);
        const r = findProducts(a.query, lim);
        return { count: r.length, products: r.map(p => prodRow(p, st)) };
      },
    },
    run_report: {
      d: 'شغّل تقرير من تقارير البرنامج وارجع أهم الصفوف والإجماليات. استخدمه لأي سؤال عن مبيعات/أرباح/مشتريات/أرصدة/رواكد/نواقص/خزينة/حضور.',
      p: {
        report_id: ['string', 'رقم التقرير من القائمة'], from: ['string', 'YYYY-MM-DD'], to: ['string', 'YYYY-MM-DD'],
        days: ['integer', 'للرواكد/النواقص/العملاء المتوقفين'], month: ['string', 'YYYY-MM للحضور'],
        store: ['string', 'اسم المخزن'], group: ['string', 'مجموعة الأصناف'], customer: ['string', 'اسم العميل'], vendor: ['string', 'اسم المورد'],
        sort_by: ['string', 'مفتاح العمود للترتيب'], ascending: ['boolean', 'تصاعدي؟'], limit: ['integer', 'عدد الصفوف، افتراضي 15 وأقصى 40'],
      }, req: ['report_id'],
      run(a) {
        const rep = REPS.find(r => r.id === a.report_id) || REPS.find(r => norm(r.t).includes(norm(a.report_id || '')));
        if (!rep) return { error: 'تقرير غير معروف', available: REPS.filter(repOk).map(r => r.id) };
        if (!can('reports') || !repOk(rep)) return deny('التقارير دي');
        const save = Object.assign({}, RF);
        try {
          const f = rep.f || [];
          if (f.includes('range')) { const p = period(a); RF.from = p.from; RF.to = p.to; }
          if (a.days) RF.days = Math.max(1, Math.min(3650, +a.days || 60));
          if (a.month && /^\d{4}-\d{2}$/.test(a.month)) RF.month = a.month;
          RF.store = findStore(a.store); RF.group = a.group || ''; RF.emp = '';
          RF.customer = ''; RF.vendor = '';
          if (a.customer) { const p = findParty(a.customer, 'customer'); if (!p) return { error: 'العميل مش موجود: ' + a.customer }; RF.customer = p.id; }
          if (a.vendor) { const p = findParty(a.vendor, 'vendor'); if (!p) return { error: 'المورد مش موجود: ' + a.vendor }; RF.vendor = p.id; }
          const res = rep.run();
          const cols = res.cols.filter(c => !c[3] || sc());
          let rows = res.rows.slice();
          const keys = cols.map(c => c[0]);
          const sk = keys.includes(a.sort_by) ? a.sort_by : (res.sort && res.sort[0]);
          const sd = a.sort_by && keys.includes(a.sort_by) ? (a.ascending ? 1 : -1) : (res.sort ? res.sort[1] : -1);
          if (sk && !res.nosort) rows.sort((x, y) => { const p = x[sk], q = y[sk]; if (typeof p === 'number' || typeof q === 'number') return sd * ((+p || 0) - (+q || 0)); return sd * String(p ?? '').localeCompare(String(q ?? ''), 'ar', { numeric: true }); });
          const tot = {}; cols.forEach(([k, , fm, , ns]) => { if (!ns && ['m', 'q', 'i'].includes(fm)) tot[k] = r0(rows.reduce((s, r) => s + (Math.abs(r[k]) === 99999 ? 0 : (+r[k] || 0)), 0)); });
          if (res.totFn) Object.assign(tot, res.totFn(tot));
          const strip = v => typeof v === 'string' ? v.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().slice(0, 80) : (typeof v === 'number' ? r0(v) : v);
          const lim = Math.min(40, +a.limit || 15);
          const out = rows.slice(0, lim).map(r => { const o = {}; for (const k of keys) if (r[k] !== '' && r[k] != null) o[k] = Math.abs(r[k]) === 99999 ? null : strip(r[k]); return o; });
          for (const k of Object.keys(tot)) tot[k] = r0(tot[k]);
          return {
            report: rep.t, filters: { from: f.includes('range') ? RF.from : undefined, to: f.includes('range') ? RF.to : undefined, days: f.includes('days') ? RF.days : undefined, month: f.includes('month') ? RF.month : undefined },
            columns: Object.fromEntries(cols.map(c => [c[0], c[1]])), total_rows: rows.length, rows: out, totals: tot,
            kpi: (res.kpi || []).map(([k, v]) => [k, strip(String(v))]), note: res.note || undefined,
          };
        } finally { Object.assign(RF, save); }
      },
    },
    find_party: {
      d: 'ابحث عن عميل أو مورد وارجع رصيده الحالي (موجب للعميل = عليه فلوس لينا، سالب للمورد = علينا له) وشريحته وتليفونه.',
      p: { query: ['string', 'الاسم'], kind: ['string', 'customer أو vendor (اختياري)'], limit: ['integer', 'افتراضي 5'] }, req: ['query'],
      run(a) {
        if (!(can('parties') || can('sell') || can('buy'))) return deny('العملاء والموردين');
        const nq = norm(a.query || ''); const ws = nq.split(/\s+/).filter(Boolean);
        const kind = ['customer', 'vendor'].includes(a.kind) ? a.kind : '';
        const ps = L('parties').filter(p => (!kind || p.kind === kind) && ws.every(w => norm(p.name).includes(w))).slice(0, Math.min(15, +a.limit || 5));
        const R = calc(); const { ls, lp } = lastDates();
        return {
          parties: ps.map(p => ({
            name: p.name, kind: p.kind === 'vendor' ? 'مورد' : 'عميل', phone: p.phone || '', tier: (tierOf(p.id) || {}).name || '',
            balance: r0(R.party[p.id] || 0), last_deal: ls[p.id] || '', last_payment: lp[p.id] || '', credit_limit: p.limit || undefined,
          })),
        };
      },
    },
    list_invoices: {
      d: 'اعرض فواتير بفلاتر (النوع، الفترة، العميل/المورد، أقل قيمة). الأحدث أولاً.',
      p: { type: ['string', 'sale|sret|purchase|pret|porder|quote|transfer|count|adj (اختياري)'], from: ['string', 'YYYY-MM-DD'], to: ['string', 'YYYY-MM-DD'],
        party: ['string', 'اسم العميل أو المورد'], min_total: ['number', 'أقل إجمالي'], unpaid_only: ['boolean', 'الآجل بس'], limit: ['integer', 'افتراضي 10 وأقصى 30'] },
      run(a) {
        const okT = t => (['sale', 'sret', 'quote', 'transfer'].includes(t) ? can('sell') : can('buy'));
        let pid = ''; if (a.party) { const p = findParty(a.party); if (!p) return { error: 'مش لاقي: ' + a.party }; pid = p.id; }
        const from = dateOk(a.from) ? a.from : '', to = dateOk(a.to) ? a.to : '';
        let xs = L('invoices').filter(i => okT(i.type) && (!a.type || i.type === a.type) && (!pid || i.partyId === pid) && (!from || i.date >= from) && (!to || i.date <= to));
        if (a.min_total) xs = xs.filter(i => invTotals(i).total >= +a.min_total);
        if (a.unpaid_only) xs = xs.filter(i => { const t = invTotals(i); return t.total - (+i.paid || 0) > 0.01; });
        xs.sort((x, y) => (y.date || '').localeCompare(x.date || '') || (y.createdAt || '').localeCompare(x.createdAt || ''));
        const lim = Math.min(30, +a.limit || 10);
        const sum = xs.reduce((s, i) => s + invTotals(i).total, 0);
        return { count: xs.length, sum_total: r0(sum), invoices: xs.slice(0, lim).map(invRow) };
      },
    },
    get_invoice: {
      d: 'تفاصيل فاتورة برقمها: الأصناف والكميات والأسعار.',
      p: { no: ['string', 'رقم الفاتورة'], type: ['string', 'نوعها لو فيه أكتر من فاتورة بنفس الرقم'] }, req: ['no'],
      run(a) {
        const xs = L('invoices').filter(i => String(i.no) === String(a.no) && (!a.type || i.type === a.type));
        if (!xs.length) return { error: 'مفيش فاتورة بالرقم ده' };
        const inv = xs.sort((x, y) => (y.date || '').localeCompare(x.date || ''))[0];
        const okT = ['sale', 'sret', 'quote', 'transfer'].includes(inv.type) ? can('sell') : can('buy'); if (!okT) return deny('الفواتير دي');
        const R = calc();
        return Object.assign(invRow(inv), {
          others_with_same_no: xs.length - 1, discount: r0(inv.discount), tax_rate: +inv.taxRate || 0,
          lines: (inv.lines || []).slice(0, 60).map((l, i) => { const x = R.line[inv.id + ':' + i] || {}; const o = { item: pname(l.pid), qty: q3(l.qty), price: r0(l.price), disc_pct: +l.disc || 0, net: r0(x.net) }; if (sc() && x.cost != null && ['sale', 'sret'].includes(inv.type)) { o.cost = r0(x.cost); o.profit = r0(x.profit); } return o; }),
        });
      },
    },
    overview: {
      d: 'ملخص سريع للنشاط: مبيعات وأرباح ومشتريات الفترة، أرصدة الخزائن، إجمالي ديون العملاء والموردين، قيمة المخزون، والشيكات.',
      p: { from: ['string', 'YYYY-MM-DD'], to: ['string', 'YYYY-MM-DD'] },
      run(a) {
        if (!can('reports')) return deny('لوحة الأرقام');
        const { from, to } = period(a); const R = calc(); const inR = d => (!from || d >= from) && (!to || d <= to);
        let sales = 0, ret = 0, profit = 0, cnt = 0, pur = 0, pret = 0;
        for (const inv of L('invoices')) {
          if (!inR(inv.date || '')) continue; const t = R.inv[inv.id]; if (!t) continue;
          if (inv.type === 'sale') { sales += t.total; profit += t.profit; cnt++; }
          else if (inv.type === 'sret') { ret += t.total; profit += t.profit; }
          else if (inv.type === 'purchase') pur += t.total; else if (inv.type === 'pret') pret += t.total;
        }
        let recv = 0, pay = 0; for (const p of L('parties')) { const b = R.party[p.id] || 0; if (p.kind === 'vendor') { if (b < 0) pay += -b; } else if (b > 0) recv += b; }
        let sv = 0; if (sc()) for (const [, s] of Object.entries(R.stock)) if (s.qty > 0) sv += s.value;
        const o = { period: { from, to }, sales: r0(sales), sales_returns: r0(ret), net_sales: r0(sales - ret), sale_invoices: cnt, purchases: r0(pur), purchase_returns: r0(pret),
          customers_owe_us: r0(recv), we_owe_vendors: r0(pay), cheques_in_pending: r0(R.chq.inPend), cheques_out_pending: r0(R.chq.outPend) };
        if (sc()) { o.gross_profit = r0(profit); o.stock_value_at_cost = r0(sv); }
        if (can('cash')) o.safes = Object.fromEntries(safes().map(s => [s.name, r0(R.safe[s.id] || 0)]));
        return o;
      },
    },
    open_screen: {
      d: 'افتح شاشة في البرنامج للمستخدم (بعد ما تشرح). الشاشات: ' + NAV.flatMap(([, it]) => it.map(([k, t]) => k + '=' + t)).join('، ') + '، وكمان reports/<report_id>.',
      p: { screen: ['string', 'مفتاح الشاشة'] }, req: ['screen'],
      run(a) {
        const s = String(a.screen || '').replace(/^#?\/?/, ''); const k = s.split('/')[0];
        if (!NAV.some(([, it]) => it.some(([x]) => x === k))) return { error: 'شاشة غير معروفة' };
        if (!canRoute(k)) return deny('الشاشة دي');
        setTimeout(() => go(s), 200); return { ok: true, opened: s };
      },
    },
  };
  const toolDefs = () => Object.entries(TOOLS).map(([name, t]) => ({
    type: 'function', function: {
      name, description: t.d,
      parameters: { type: 'object', properties: Object.fromEntries(Object.entries(t.p).map(([k, [ty, de]]) => [k, { type: ty, description: de }])), required: t.req || [] },
    },
  }));

  function systemPrompt() {
    const s = settings(); const perms = PERMS.filter(([k]) => can(k)).map(([, t]) => t).join('، ');
    const reps = REPS.filter(r => repOk(r) && can('reports')).map(r => `${r.id}: ${r.t}`).join('\n');
    return `انت "مساعد ميزان"، مساعد ذكي جوه برنامج ميزان للمبيعات والمخازن والحسابات والموظفين لشركة "${s.company || 'الشركة'}" (نشاط صيدلي/توزيع). اتكلم بالعامية المصرية باختصار ووضوح.
النهارده ${today()} (${DAYS[new Date().getDay()]}). المستخدم: ${S.me && S.me.name || ''} — دوره: ${S.roleName || ''}. صلاحياته: ${perms || 'محدودة'}.
قواعد:
- أي رقم (مبيعات، أرصدة، أسعار، كميات) لازم يجي من الأدوات — ماتخترعش أرقام أبدًا. لو الأداة رجّعت خطأ أو مفيش بيانات قول كده.
- انت بتقرا بس، ماتقدرش تعدّل أو تحفظ حاجة. لو المستخدم عايز يعمل حاجة اشرحله الخطوات وافتحله الشاشة بـ open_screen.
- العملة جنيه مصري (ج.م). اكتب الأرقام بفواصل الآلاف. استخدم جدول Markdown صغير لما تعرض أكتر من 3 صفوف.
- "الشهر ده" = من أول الشهر لحد النهارده. "الشهر اللي فات" = الشهر الكامل السابق. السنة = من أول يناير.
- لو المستخدم مالوش صلاحية حاجة، قوله إنها مش متاحة لدوره.
معلومات عن البرنامج:
- فاتورة البيع: اختار العميل (السعر بيتحسب تلقائي حسب شريحته: ${tiers().map(t => `${t.name} = التكلفة + ${t.markup}%`).join('، ')}، والعميل النقدي بسعر المستهلك)، امسح الباركود أو اكتب اسم الصنف واضغط Enter، عدّل الكمية/السعر/الخصم في الخلية، والحفظ Ctrl+S. البرنامج بيمنع بيع كمية أكبر من رصيد المخزن${s.allowNegative ? ' (لكن البيع بالسالب مسموح حاليًا بعد تأكيد)' : ''}.
- فاتورة الشراء بتعرض سعر المستهلك والتكلفة، وممكن رفع الأصناف من شيت Excel من "استيراد من Excel". أمر التوريد بيتحوّل لفاتورة شراء من شاشة "أوامر التوريد".
- الخلايا في الفواتير المحفوظة بتتعدّل من "شبكة الحركات" (تاريخ/سعر/تكلفة/كمية) لو عنده صلاحية.
- الخزينة: قبض ومصروف وتحويل بين الخزائن. الشيكات: وارد وصادر (تحصيل/صرف/رفض/تظهير). الإشعارات المدينة والدائنة من صفحة العميل/المورد.
- الجرد من فاتورة "جرد وتسوية مخزن"، والتحويل بين المخازن من "تحويل بين المخازن"، وطباعة الباركود من شاشتها.
- المحاسبة والقوائم المالية (للي عنده صلاحية المحاسبة): شجرة الحسابات، دفتر اليومية (القيود الآلية من كل الحركات + قيود يدوية)، دفتر الأستاذ، ميزان المراجعة، قائمة الدخل، الميزانية العمومية، والفترات المحاسبية (غلق وفتح الفترات وبداية السنة المالية). افتحها بـ open_screen: accounts/tb أو accounts/bs أو accounts/is أو accounts/ledger أو accounts/journal أو accounts/chart أو accounts/periods.
- الحضور والانصراف بيتربط بالرواتب (تأخير، إضافي، جزاءات، سلف). المستخدمين والصلاحيات وغلق الفترات والنسخ الاحتياطي من الإعدادات (للمدير).
التقارير المتاحة (run_report):
${reps || 'مفيش صلاحية تقارير'}`;
  }

  /* ---------- UI ---------- */
  const css = `
#aiFab{position:fixed;left:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:45;width:54px;height:54px;border-radius:50%;border:0;background:var(--brand);color:#fff;box-shadow:0 10px 28px rgba(0,0,0,.25);cursor:pointer;display:grid;place-items:center}
#aiFab:hover{filter:brightness(1.08)}#aiFab svg{width:26px;height:26px}
#aiP{position:fixed;left:18px;bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:46;width:min(430px,calc(100vw - 36px));height:min(640px,calc(100vh - 120px));background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden}
#aiP.on{display:flex}
#aiP header{display:flex;align-items:center;gap:8px;padding:12px 14px;background:var(--side,#0E2620);color:#fff}
#aiP header b{font:700 17px var(--display)}#aiP header small{opacity:.7;font-size:11.5px}
#aiP header button{background:transparent;border:0;color:#fff;cursor:pointer;padding:4px;border-radius:6px;opacity:.85}#aiP header button:hover{opacity:1;background:rgba(255,255,255,.1)}
#aiM{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--bg)}
.aim{max-width:92%;padding:9px 12px;border-radius:12px;line-height:1.7;font-size:14px;word-wrap:break-word;overflow-wrap:anywhere}
.aim.u{align-self:flex-start;background:var(--brand);color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap}
.aim.a{align-self:flex-end;background:var(--surface);border:1px solid var(--line);border-bottom-left-radius:4px}
.aim.a p{margin:0 0 6px}.aim.a p:last-child{margin:0}.aim.a ul,.aim.a ol{margin:4px 0;padding-inline-start:20px}
.aim.a table{border-collapse:collapse;margin:6px 0;font-size:12.5px;display:block;overflow-x:auto;max-width:100%}.aim.a th,.aim.a td{border:1px solid var(--line);padding:3px 7px;text-align:right;white-space:nowrap}.aim.a th{background:var(--surface2)}
.aim.a code{background:var(--surface2);padding:0 4px;border-radius:4px}
.aim.t{align-self:flex-end;font-size:12px;color:var(--muted);background:transparent;padding:0 4px}
.aim.e{align-self:stretch;background:transparent;border:1px solid var(--danger);color:var(--danger);font-size:13px}
#aiS{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 4px}#aiS button{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:5px 11px;font:inherit;font-size:12.5px;cursor:pointer}#aiS button:hover{border-color:var(--brand);color:var(--brand)}
#aiF{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line);background:var(--surface)}
#aiI{flex:1;resize:none;border:1px solid var(--line);border-radius:10px;padding:9px 11px;font:inherit;font-size:14.5px;max-height:120px;background:var(--surface);color:var(--ink)}#aiI:focus{outline:none;border-color:var(--brand)}
#aiF button{border:0;background:var(--brand);color:#fff;border-radius:10px;padding:0 14px;cursor:pointer;font:inherit;font-weight:600}#aiF button:disabled{opacity:.5}
.aidot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--muted);margin:0 2px;animation:aib 1s infinite}.aidot:nth-child(2){animation-delay:.15s}.aidot:nth-child(3){animation-delay:.3s}
@keyframes aib{0%,80%,100%{opacity:.25}40%{opacity:1}}
@media (max-width:860px){#aiFab{bottom:calc(76px + env(safe-area-inset-bottom,0px));left:12px;width:50px;height:50px}#aiP{inset:0;width:auto;height:auto;left:0;bottom:0;border-radius:0}#aiP header{padding-top:calc(12px + env(safe-area-inset-top,0px))}}
@media print{#aiFab,#aiP{display:none!important}}`;
  const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
  const SUGG = [
    ['مبيعات وأرباح الشهر ده', 'reports'], ['أكتر 10 أصناف مبيعًا الشهر ده', 'reports'], ['الأصناف اللي قربت تخلص', 'reports'],
    ['مين أكتر العملاء اللي عليهم فلوس؟', 'parties'], ['الأصناف الراكدة من 90 يوم', 'reports'], ['إزاي أرفع أصناف من Excel؟', ''], ['إزاي أعمل فاتورة بيع؟', ''],
  ];

  function md(s) {
    s = esc(String(s || '')).replace(/\r/g, '');
    const lines = s.split('\n'); let out = '', i = 0;
    const inl = t => t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const row = x => x.trim().replace(/^\||\|$/g, '').split('|').map(c => inl(c.trim()));
        const hd = row(l); i += 2; let body = '';
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body += '<tr>' + row(lines[i]).map(c => `<td>${c}</td>`).join('') + '</tr>'; i++; }
        out += `<table><thead><tr>${hd.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`; continue;
      }
      if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
        const ord = /^\s*\d/.test(l); let items = '';
        while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) { items += '<li>' + inl(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, '')) + '</li>'; i++; }
        out += ord ? `<ol>${items}</ol>` : `<ul>${items}</ul>`; continue;
      }
      if (/^#{1,4}\s+/.test(l)) { out += `<p><b>${inl(l.replace(/^#+\s+/, ''))}</b></p>`; i++; continue; }
      if (!l.trim()) { i++; continue; }
      let para = l; i++;
      while (i < lines.length && lines[i].trim() && !/^\s*(\||[-*•]\s|\d+[.)]\s|#)/.test(lines[i])) { para += '<br>' + lines[i]; i++; }
      out += `<p>${inl(para)}</p>`;
    }
    return out;
  }

  function mount() {
    if (document.getElementById('aiFab')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const fab = document.createElement('button'); fab.id = 'aiFab'; fab.title = 'مساعد ميزان الذكي'; fab.setAttribute('aria-label', 'مساعد ميزان الذكي'); fab.innerHTML = SPARK;
    const p = document.createElement('div'); p.id = 'aiP'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'مساعد ميزان');
    p.innerHTML = `<header>${SPARK.replace('<svg', '<svg width="22" height="22"')}<div style="flex:1"><b>مساعد ميزان</b><div><small id="aiMd"></small></div></div>
      <button id="aiN" title="محادثة جديدة" aria-label="محادثة جديدة"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
      <button id="aiX" title="إغلاق" aria-label="إغلاق"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
      <div id="aiM"></div>
      <form id="aiF"><textarea id="aiI" rows="1" placeholder="اسأل عن المبيعات، الأرصدة، الأصناف، أو إزاي تعمل حاجة…"></textarea><button id="aiB">إرسال</button></form>`;
    document.body.appendChild(fab); document.body.appendChild(p);
    fab.onclick = () => toggle(); document.getElementById('aiX').onclick = () => toggle(false);
    document.getElementById('aiN').onclick = () => { if (AI.busy) return; AI.msgs = []; draw(); };
    const inp = document.getElementById('aiI');
    inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(120, inp.scrollHeight) + 'px'; });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    document.getElementById('aiF').onsubmit = e => { e.preventDefault(); send(); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && AI.open && !document.getElementById('modal').classList.contains('on')) toggle(false); });
    draw();
  }
  function toggle(v) {
    AI.open = v === undefined ? !AI.open : v; const p = document.getElementById('aiP'); p.classList.toggle('on', AI.open);
    if (AI.open) { draw(); setTimeout(() => document.getElementById('aiI').focus(), 30); }
  }
  function draw(thinking) {
    const box = document.getElementById('aiM'); if (!box) return;
    document.getElementById('aiMd').textContent = AI.cfg ? (AI.cfg.model || '') : '';
    let h = '';
    const vis = AI.msgs.filter(m => m.ui);
    if (!vis.length) {
      h += `<div class="aim a"><p><b>أهلاً ${esc((S.me && S.me.name) || '')} 👋</b></p><p>أنا مساعد ميزان. اسألني عن مبيعاتك وأرباحك وأرصدة الأصناف والعملاء، أو اسألني إزاي تعمل أي حاجة في البرنامج.</p></div>`;
      const sg = SUGG.filter(([, perm]) => !perm || can(perm) || (perm === 'parties' && can('sell')));
      h += `<div id="aiS">${sg.map(([t]) => `<button type="button">${esc(t)}</button>`).join('')}</div>`;
    }
    for (const m of vis) h += m.ui === 'u' ? `<div class="aim u">${esc(m.content)}</div>` : m.ui === 'e' ? `<div class="aim e">${esc(m.content)}</div>` : m.ui === 't' ? `<div class="aim t">${esc(m.content)}</div>` : `<div class="aim a">${md(m.content)}</div>`;
    if (thinking) h += `<div class="aim t">${esc(typeof thinking === 'string' ? thinking : '')} <span class="aidot"></span><span class="aidot"></span><span class="aidot"></span></div>`;
    box.innerHTML = h; box.scrollTop = box.scrollHeight;
    box.querySelectorAll('#aiS button').forEach(b => b.onclick = () => { document.getElementById('aiI').value = b.textContent; send(); });
    const btn = document.getElementById('aiB'); if (btn) btn.disabled = AI.busy;
  }
  const TOOL_LABEL = { search_products: 'بدوّر في الأصناف', run_report: 'بشغّل التقرير', find_party: 'بدوّر على العميل/المورد', list_invoices: 'بجيب الفواتير', get_invoice: 'بفتح الفاتورة', overview: 'بحسب الملخص', open_screen: 'بفتح الشاشة' };

  async function send() {
    const inp = document.getElementById('aiI'); const text = inp.value.trim();
    if (!text || AI.busy) return;
    if (!AI.cfg || !AI.cfg.enabled) { AI.msgs.push({ ui: 'e', content: 'المساعد مش متفعّل لسه. المدير يفعّله من الإعدادات ← المساعد الذكي.' }); draw(); return; }
    inp.value = ''; inp.style.height = 'auto';
    AI.msgs.push({ role: 'user', content: text, ui: 'u' }); AI.busy = true; draw('بفكر');
    try {
      for (let round = 0; round < 7; round++) {
        const all = AI.msgs.filter(m => m.role); let lastU = -1; all.forEach((m, k) => { if (m.role === 'user') lastU = k; });
        const hist = all.slice(-24).map(m => { const old = all.indexOf(m) < lastU; let ct = m.content == null ? '' : m.content;
          if (old && m.role === 'tool' && ct.length > 700) ct = ct.slice(0, 700) + '…(نتيجة قديمة مختصرة)';
          const o = { role: m.role, content: ct }; if (m.tool_calls) o.tool_calls = m.tool_calls; if (m.tool_call_id) o.tool_call_id = m.tool_call_id; if (m.name) o.name = m.name; return o; });
        while (hist.length && hist[0].role === 'tool') hist.shift();
        const r = await fetch('/api/ai/chat', { method: 'POST', credentials: 'same-origin', headers: H, body: JSON.stringify({ messages: [{ role: 'system', content: systemPrompt() }, ...hist], tools: toolDefs() }) });
        if (r.status === 401) { location.href = '/login'; return; }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'تعذّر الاتصال بالمساعد');
        const m = j.message || {};
        if (m.tool_calls && m.tool_calls.length) {
          AI.msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
          for (const tc of m.tool_calls) {
            const fn = tc.function || {}; const t = TOOLS[fn.name]; let out;
            draw(TOOL_LABEL[fn.name] || 'بشتغل');
            try { const args = fn.arguments ? (typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : fn.arguments) : {}; out = t ? t.run(args || {}) : { error: 'أداة غير معروفة' }; }
            catch (e) { out = { error: 'فشل تنفيذ الأداة: ' + (e.message || e) }; }
            let s = JSON.stringify(out); if (s.length > 9000) s = s.slice(0, 9000) + '…(مقطوع)';
            AI.msgs.push({ role: 'tool', tool_call_id: tc.id, name: fn.name, content: s });
            await new Promise(r => setTimeout(r, 0));
          }
          draw('بكتب الرد');
          continue;
        }
        AI.msgs.push({ role: 'assistant', content: m.content || '(مفيش رد)', ui: 'a' });
        break;
      }
    } catch (e) {
      AI.msgs.push({ ui: 'e', content: e.message || String(e) });
    } finally { AI.busy = false; draw(); }
  }

  AI.loadCfg = async function () {
    try { const r = await fetch('/api/ai/config', { credentials: 'same-origin' }); if (r.ok) AI.cfg = await r.json(); } catch (e) {}
    const fab = document.getElementById('aiFab');
    if (fab) fab.style.display = AI.cfg && (AI.cfg.enabled || AI.cfg.admin) ? '' : 'none';
    return AI.cfg;
  };
  async function boot() {
    if (typeof allReady !== 'function' || !allReady() || !S.me) { setTimeout(boot, 800); return; }
    mount(); await AI.loadCfg();
  }
  AI.settingsCard = async function (el) {
    const c = await AI.loadCfg();
    if (!c || !c.admin) { el.remove(); return; }
    const P = c.presets || {};
    const help = {
      groq: 'مجاني: ادخل <b>console.groq.com</b> ← سجّل بإيميلك ← API Keys ← Create API Key، وانسخ المفتاح (بيبدأ بـ gsk_). الموديل المقترح openai/gpt-oss-120b. ميزته إن الشركة مش بتستخدم بياناتك في التدريب.',
      gemini: 'مجاني: ادخل <b>aistudio.google.com</b> ← Get API key ← Create API key. الموديل المقترح gemini-3.8-flash. ملحوظة: في الخطة المجانية جوجل ممكن تستخدم الأسئلة والردود لتحسين منتجاتها.',
      anthropic: 'ادخل <b>console.anthropic.com</b> (platform.claude.com) ← API Keys ← Create Key (المفتاح بيبدأ بـ sk-ant-). الموديل المقترح <code>claude-sonnet-5-5</code> (سريع وكويس جدًا في العربي)، أو <code>claude-haiku-5-5</code> لو عايز أرخص، أو <code>claude-opus-5-5</code> للأقوى. مدفوع حسب الاستخدام — اشحن رصيد من Billing. Anthropic مش بتدرّب على بيانات الـ API.',
      openai: 'ادخل <b>platform.openai.com</b> ← API keys ← Create new secret key (بيبدأ بـ sk-). OpenAI <b>مش مجاني</b>: لازم تشحن رصيد من Billing (أقل حاجة 5 دولار)، وبيتحاسب على كل سؤال (gpt-5-mini رخيص — السؤال غالبًا أقل من سنت). OpenAI مش بتدرّب على بيانات الـ API.',
      openrouter: 'ادخل <b>openrouter.ai</b> ← Keys ← Create key، واختار أي موديل اسمه منتهي بـ <code>:free</code> من زرار "جيب الموديلات".',
      custom: 'أي مزوّد متوافق مع OpenAI (رابط ينتهي غالبًا بـ /v1).',
    };
    const prov = c.provider || 'groq';
    el.innerHTML = `<h3>المساعد الذكي ${c.enabled ? '<span class="tag ok">شغّال</span>' : '<span class="tag">مش متفعّل</span>'}</h3>
      <p class="small muted" style="margin-top:0">زرار ✨ في الركن بيفتح مساعد بيرد على أسئلة الموظفين عن المبيعات والأرصدة والأصناف والعملاء ويشرح استخدام البرنامج. بيقرا بس — مابيعدّلش أي بيانات — وبيحترم صلاحية كل مستخدم. المفتاح بيتحفظ على السيرفر بس، والأسئلة بتروح لمزوّد الذكاء الاصطناعي اللي تختاره.</p>
      <div class="grid g2">
        <label class="f">المزوّد<select class="in" id="ai_p">${Object.entries(P).map(([k, v]) => `<option value="${k}" ${k === prov ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
        <label class="f">الموديل<input class="in" id="ai_m" name="mz-ai-model" autocomplete="off" dir="ltr" list="ai_ml" value="${esc(c.model || '')}" placeholder="${esc((P[prov] || {}).model || '')}"><datalist id="ai_ml"></datalist></label>
        <label class="f" id="ai_uw" style="${prov === 'custom' ? '' : 'display:none'}">رابط الـ API<input class="in" id="ai_u" name="mz-ai-url" autocomplete="off" data-lpignore="true" data-1p-ignore dir="ltr" value="${esc(prov === 'custom' ? c.url || '' : '')}" placeholder="https://…/v1"></label>
        <label class="f">مفتاح الـ API ${c.hasKey ? `<span class="small muted">(محفوظ ${esc(c.keyHint)} — سيبه فاضي لو مش هتغيّره)</span>` : ''}<input class="in" id="ai_k" type="text" name="mz-ai-key" dir="ltr" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore style="-webkit-text-security:disc" placeholder="${c.hasKey ? '••••••••' : 'الصق المفتاح هنا'}"></label>
      </div>
      <p class="small" id="ai_h" style="background:var(--surface2);padding:8px 10px;border-radius:8px">${help[prov] || ''}</p>
      <div class="row"><label class="row small" style="gap:6px"><input type="checkbox" id="ai_on" ${c.on !== false ? 'checked' : ''}> تشغيل المساعد لكل المستخدمين</label><span class="sp"></span>
        <button class="btn s" id="ai_ls" type="button">جيب الموديلات</button><button class="btn s" id="ai_t" type="button">تجربة</button><button class="btn s p" id="ai_s" type="button">حفظ</button></div>
      <p class="small" id="ai_r" style="min-height:20px;margin-bottom:0"></p>`;
    const $e = id => el.querySelector('#' + id);
    const msg = (t, bad) => { const r = $e('ai_r'); r.textContent = t; r.style.color = bad ? 'var(--danger)' : 'var(--brand)'; };
    $e('ai_p').onchange = () => { const v = $e('ai_p').value; $e('ai_uw').style.display = v === 'custom' ? '' : 'none'; $e('ai_h').innerHTML = help[v] || ''; $e('ai_m').value = (P[v] || {}).model || ''; $e('ai_m').placeholder = (P[v] || {}).model || ''; };
    const save = async () => {
      const v = $e('ai_p').value; const body = { provider: v, model: $e('ai_m').value.trim() || (P[v] || {}).model || '', enabled: $e('ai_on').checked, url: v === 'custom' ? $e('ai_u').value.trim() : '' };
      const k = $e('ai_k').value.trim();
      if (k) { if (k.length < 20 || /\s/.test(k)) throw new Error('ده مش شكل مفتاح API — المفتاح طويل (من موقع المزوّد) وبيبدأ غالبًا بـ gsk_ أو sk- أو sk-ant- أو AIza. امسح الخانة والصق المفتاح الصح.'); body.key = k; }
      const r = await fetch('/api/ai/config', { method: 'POST', credentials: 'same-origin', headers: H, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'فشل الحفظ');
      await AI.loadCfg();
    };
    $e('ai_s').onclick = async () => { try { await save(); toast('تم حفظ إعدادات المساعد'); AI.settingsCard(el); } catch (e) { msg(e.message, true); } };
    $e('ai_ls').onclick = async () => {
      try { await save(); msg('جارٍ جلب الموديلات…'); const r = await fetch('/api/ai/models', { credentials: 'same-origin' }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'فشل');
        $e('ai_ml').innerHTML = j.models.map(m => `<option value="${esc(m)}">`).join(''); msg(`لقيت ${j.models.length} موديل — اضغط في خانة الموديل واختار`); }
      catch (e) { msg(e.message, true); }
    };
    $e('ai_t').onclick = async () => {
      try { await save(); msg('جارٍ التجربة…'); const t0 = performance.now();
        const r = await fetch('/api/ai/chat', { method: 'POST', credentials: 'same-origin', headers: H, body: JSON.stringify({ messages: [{ role: 'user', content: 'رد بكلمة واحدة: تمام' }] }) });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'فشل');
        msg(`شغّال ✓ — الرد: "${String(j.message.content || '').slice(0, 40)}" في ${Math.round(performance.now() - t0)} مللي ثانية`); }
      catch (e) { msg(e.message, true); }
    };
  };
  AI.tools = TOOLS; AI.systemPrompt = systemPrompt; AI.md = md;
  setTimeout(boot, 500);
})();
