/* ميزان — عقل المساعد المدمج (مجاني وبدون إنترنت).
   بيفهم العامية المصرية والأخطاء الإملائية، وبيقسّم الرسالة لأكتر من طلب، وبيفتكر سياق الكلام
   (العميل/الصنف/الفاتورة/الفترة اللي اتكلمنا عنها)، وبينفّذ أوامر بصلاحيات المستخدم اللي عامل دخول:
   كل أمر بيتأكد من can(...) الأول، وأي تعديل في البيانات محتاج تأكيد، والفواتير والسندات بتتفتح
   متعبّية في شاشتها العادية علشان كل تحققات البرنامج تشتغل والمستخدم يراجع ويحفظ بنفسه. */
(function () {
  'use strict';
  const AI = window.MZ_AI; if (!AI) return;
  const T = () => AI.tools;
  const F = v => fmt(v);
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const sc = () => can('seeCost');

  /* ---------- اللغة ---------- */
  function nz(s) {
    return String(s ?? '')
      .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 1776)
      .replace(/(\d)[,٬](?=\d{3}\b)/g, '$1').replace(/٫/g, '.')
      .toLowerCase().replace(/[ً-ْـ]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
      .replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/[؟?!,،؛;:"'«»()\[\]{}…]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let best = i;
      for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < best) best = cur[j]; }
      if (best > max) return max + 1; prev = cur;
    }
    return prev[b.length];
  }
  // "و" و"ال" و"لل" و"بال" في أول الكلمة
  const stems = w => { const o = [w]; if (w.length > 3 && w[0] === 'و') o.push(w.slice(1)); for (const x of o.slice()) { if (x.startsWith('بال') && x.length > 4) o.push(x.slice(3), 'ال' + x.slice(3)); if (x.startsWith('لل') && x.length > 3) o.push('ال' + x.slice(2), x.slice(2)); if (x.startsWith('ال') && x.length > 3) o.push(x.slice(2)); if (/^[لب]/.test(x) && x.length > 3) o.push(x.slice(1)); } return o; };
  // has(c, 'كلمة', 'جملة من كلمتين'...) — مطابقة مرنة بتستحمل غلطة حرف
  function has(c, ...kws) {
    for (const k0 of kws) {
      const k = nz(k0); if (!k) continue;
      if (k.includes(' ')) { if ((' ' + c.t + ' ').includes(' ' + k + ' ') || c.t.includes(k)) return true; continue; }
      for (const w of c.w) for (const s of stems(w)) {
        if (s === k) return true;
        if (k.length >= 4 && s.length >= 4 && (s.startsWith(k) || (k.length >= 5 && k.startsWith(s) && s.length >= k.length - 1))) return true;
        if (k.length >= 5 && lev(s, k, 1) <= 1) return true;
        if (k.length >= 8 && lev(s, k, 2) <= 2) return true;
      }
    }
    return false;
  }
  const NUMW = { 'واحد': 1, 'واحده': 1, 'اتنين': 2, 'اثنين': 2, 'اتنان': 2, 'تلاته': 3, 'ثلاثه': 3, 'تلات': 3, 'اربعه': 4, 'اربع': 4, 'خمسه': 5, 'خمس': 5, 'سته': 6, 'ست': 6, 'سبعه': 7, 'سبع': 7, 'تمانيه': 8, 'ثمانيه': 8, 'تمن': 8, 'تسعه': 9, 'تسع': 9, 'عشره': 10, 'عشر': 10, 'دسته': 12, 'نص': 0.5, 'ربع': 0.25 };
  const nums = t => (t.match(/\d+(?:\.\d+)?/g) || []).map(Number);

  /* ---------- الفترات ---------- */
  const MONTHS = ['يناير', 'فبراير', 'مارس', 'ابريل', 'مايو', 'يونيو', 'يوليو', 'اغسطس', 'سبتمبر', 'اكتوبر', 'نوفمبر', 'ديسمبر'];
  const pad = n => String(n).padStart(2, '0');
  const monthRange = (y, m) => { const last = new Date(y, m, 0).getDate(); const t = today(); const to = `${y}-${pad(m)}-${pad(last)}`; return { from: `${y}-${pad(m)}-01`, to: to > t ? t : to }; };
  function periods(t) {
    const td = today(), Y = +td.slice(0, 4), M = +td.slice(5, 7); const out = [];
    const add = (re, f) => { const m = re.exec(t); if (m) out.push(Object.assign({ at: m.index }, f(m))); };
    add(/اول (امبارح|امس)/, () => { const d = addDays(td, -2); return { from: d, to: d, label: 'أول امبارح' }; });
    add(/(?<!اول )(امبارح|امس|البارحه|مبارح)/, () => { const d = addDays(td, -1); return { from: d, to: d, label: 'امبارح' }; });
    add(/النهارده|النهارد|انهارده|النهرده|النهاردة|اليوم/, () => ({ from: td, to: td, label: 'النهارده' }));
    add(/(الاسبوع|اسبوع|الجمعه) (اللي|الي) (فات|فاتت)|الاسبوع (الماضي|السابق|اللي قبله)/, () => ({ from: addDays(td, -13), to: addDays(td, -7), label: 'الأسبوع اللي فات' }));
    add(/(?<!اخر )(الاسبوع|اسبوع|الجمعه دي)(?! (اللي|الي) فات| الماضي| السابق)/, () => ({ from: addDays(td, -6), to: td, label: 'آخر 7 أيام' }));
    add(/اخر (\d+) (يوم|ايام)/, m => ({ from: addDays(td, -(+m[1] - 1)), to: td, label: `آخر ${m[1]} يوم` }));
    add(/الشهر (اللي|الي) (فات|قبله)|الشهر (الماضي|السابق)/, () => { const y = M === 1 ? Y - 1 : Y, m = M === 1 ? 12 : M - 1; return Object.assign(monthRange(y, m), { label: 'الشهر اللي فات' }); });
    add(/(?<!(اول|اخر) )الشهر(?! (اللي|الي) (فات|قبله)| الماضي| السابق)|الشهر ده|هذا الشهر/, () => ({ from: td.slice(0, 8) + '01', to: td, label: 'الشهر ده' }));
    add(/(السنه|العام|سنه) (اللي|الي) (فاتت|فات)|(السنه|العام) (الماضيه|الماضي|السابقه)/, () => ({ from: `${Y - 1}-01-01`, to: `${Y - 1}-12-31`, label: `سنة ${Y - 1}` }));
    add(/(?<!اخر )(السنه|العام|سنه)(?! (اللي|الي) فات| الماضي| السابق)/, () => ({ from: `${Y}-01-01`, to: td, label: `سنة ${Y}` }));
    MONTHS.forEach((mn, i) => add(new RegExp('(شهر )?' + mn + '(?: (\\d{4}))?'), m => { const y = m[2] ? +m[2] : (i + 1 > M ? Y - 1 : Y); return Object.assign(monthRange(y, i + 1), { label: `شهر ${mn}${y !== Y ? ' ' + y : ''}` }); }));
    add(/شهر (\d{1,2})(?:[\/\- ](\d{4}))?(?!\d)/, m => { const mm = +m[1]; if (mm < 1 || mm > 12) return null; const y = m[2] ? +m[2] : (mm > M ? Y - 1 : Y); return Object.assign(monthRange(y, mm), { label: `شهر ${mm}${y !== Y ? '/' + y : ''}` }); });
    const ds = [...t.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g)].map(m => {
      const d = m[1] ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : `${m[6] ? (m[6].length === 2 ? '20' + m[6] : m[6]) : Y}-${pad(m[5])}-${pad(m[4])}`; return { d, at: m.index };
    }).filter(x => /^\d{4}-\d\d-\d\d$/.test(x.d) && !isNaN(new Date(x.d)));
    if (ds.length >= 2) out.push({ from: ds[0].d < ds[1].d ? ds[0].d : ds[1].d, to: ds[0].d < ds[1].d ? ds[1].d : ds[0].d, label: `من ${ds[0].d} لـ ${ds[1].d}`, at: ds[0].at });
    else if (ds.length === 1) out.push({ from: ds[0].d, to: ds[0].d, label: ds[0].d, at: ds[0].at });
    const seen = new Set();
    return out.filter(Boolean).filter(p => p.from).sort((a, b) => a.at - b.at).filter(p => { const k = p.from + p.to; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  const DEFP = () => ({ from: today().slice(0, 8) + '01', to: today(), label: 'الشهر ده' });

  /* ---------- العملاء والموردين ---------- */
  const PSTOP = new Set(['ص', 'د', 'دكتور', 'دكتوره', 'صيدليه', 'صيدليات', 'شركه', 'مؤسسه', 'مكتب', 'لتجاره', 'للتجاره', 'التجاريه', 'لتوزيع', 'للتوزيع', 'و', 'ال', 'مستحضرات', 'لمستحضرات', 'التجميل', 'مواد', 'وتوزيع']);
  const QSTOP = new Set('رصيد حساب كشف عليه ليه كام قد ايه اللي الي بتاع بتاعه عميل العميل مورد المورد للعميل للمورد من في فى على لـ ل الى الي او مع اعمل اعرض هات جيب وريني شوف ورينى عايز عاوز ممكن لو سمحت يا فاتوره فاتورة بيع شراء حصل حصلت استلمت دفع دفعت سدد سددت ادفع جنيه ج م الف مبلغ النهارده امبارح الشهر السنه الاسبوع اخر فواتير مبيعات مشتريات سحب سعر بكام موجود متاح عندنا عندكم فيه لسه كميه الكميه المتاح كم'.split(' ').map(nz));
  const toks = s => nz(String(s).replace(/[\-–_\/\\]+/g, ' ')).split(/\s+/).filter(Boolean);
  function partyScan(text, kind) {
    const q = toks(text).map((w, i) => ({ w, i })).filter(x => !QSTOP.has(nz(x.w)) && !/^\d/.test(x.w));
    if (!q.length) return [];
    const res = [];
    for (const p of L('parties')) {
      if (kind && p.kind !== kind) continue;
      const nt = toks(p.name).filter(w => w.length >= 2 && !PSTOP.has(w)); if (!nt.length) continue;
      let m = 0; const used = new Set();
      for (const w of nt) {
        let best = 0, bi = -1;
        for (const x of q) for (const s of stems(x.w)) {
          let v = 0; if (s === w) v = 1; else if (s.length >= 3 && w.length >= 3 && (w.startsWith(s) || s.startsWith(w))) v = 0.75; else if (w.length >= 4 && lev(s, w, 1) <= 1) v = 0.6;
          if (v > best) { best = v; bi = x.i; }
        }
        if (best) { m += best; used.add(bi); }
      }
      if (m < 0.75) continue;
      const full = norm(text).includes(norm(p.name)) ? 2 : 0;
      res.push({ p, s: m + m / nt.length + full, used });
    }
    return res.sort((a, b) => b.s - a.s);
  }
  // يرجّع {p} لو واضح، أو {many:[...]} لو فيه احتمالات، أو null
  function resolveParty(c, kind, opt = {}) {
    let r = partyScan(c.raw, kind);
    if (!r.length && kind && opt.anyKind) r = partyScan(c.raw);
    if (!r.length) { if (c.mem.party && (opt.pronoun || /(ه|ها|هم)$/.test(c.w.find(w => /^(حساب|رصيد|كشف|فواتير|مبيعات)/.test(w)) || ''))) { const p = G('parties', c.mem.party) && L('parties').find(x => x.id === c.mem.party); if (p && (!kind || p.kind === kind)) return { p, mem: true }; } return null; }
    const top = r[0]; const close = r.filter(x => x.s >= top.s - 0.3);
    if (close.length === 1 || top.s >= 3.5 && close.length < 3 && r[1].s < top.s - 0.01) return { p: top.p, used: top.used };
    return { many: close.slice(0, 8).map(x => x.p), used: top.used };
  }

  /* ---------- الأصناف ---------- */
  const IGN = new Set('علبه علب قطعه قطع حبه حبات كرتونه كراتين عبوه عبوات باكو باكت x × من صنف اصناف الصنف وحده وحدات بس كمان و'.split(' ').map(nz));
  let VOC = null, VOCn = -1;
  function vocab() { const ps = L('products'); if (VOC && VOCn === ps.length) return VOC; const m = new Map(); for (const p of ps) for (const w of nz(p.name).split(' ')) if (w.length >= 3 && !/^\d/.test(w)) m.set(w, (m.get(w) || 0) + 1); VOC = [...m.entries()].sort((a, b) => b[1] - a[1]); VOCn = ps.length; return VOC; }
  function fixWord(w) {
    if (w.length < 3 || /^\d/.test(w)) return w; const V = vocab(); if (V.some(([x]) => x === w)) return w;
    const alts = [w, w.replace(/ه$/, 'ا'), w.replace(/ا$/, 'ه'), w.replace(/ي$/, 'ى'), w.replace(/ت$/, 'ه'), w.replace(/^ال/, '')];
    for (const a of alts) if (V.some(([x]) => x === a)) return a;
    const mx = w.length >= 7 ? 2 : 1; let best = null;
    for (const [x, n] of V) { if (Math.abs(x.length - w.length) > mx) continue; const d = lev(w, x, mx); if (d <= mx && (!best || d < best.d || (d === best.d && n > best.n))) best = { x, d, n }; }
    return best ? best.x : w;
  }
  const nameScore = (p, q) => { const ws = nz(q).split(' ').filter(Boolean); const n = nz(p.name); return ws.filter(w => (' ' + n + ' ').includes(' ' + w + ' ')).length * 2 + ws.filter(w => n.includes(w)).length; };
  const rank = (r, q) => { const ws = nz(q).split(' ').filter(Boolean); const sc_ = p => { const n = nz(p.name); return ws.filter(w => (' ' + n + ' ').includes(' ' + w + ' ')).length * 2 + ws.filter(w => n.includes(w)).length + (n.startsWith(ws[0] || '') ? 1 : 0); }; return r.map((p, i) => ({ p, i, s: sc_(p) })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.p); };
  function prodFind(q, lim = 6) {
    q = String(q || '').trim(); if (!q) return [];
    const srch = x => { try { return AI.findProducts(x, 60); } catch (e) { return pSearch(x, 60); } };
    let r = srch(q); const fx = nz(q).split(' ').map(fixWord).join(' ');
    if (fx !== nz(q)) { const seen = new Set(); r = srch(fx).concat(r).filter(p => !seen.has(p.id) && seen.add(p.id)); q = fx; }
    return rank(r, q).slice(0, lim);
  }

  const rest = (c, extra, keepNum) => { const drop = new Set([...(extra || []).map(nz)]); return c.raw.split(/\s+/).filter(w => { const n = nz(w); return n && !drop.has(n) && !QSTOP.has(n) && (keepNum || !/^\d+(\.\d+)?$/.test(n)) && !PSTOP.has(n); }).join(' ').replace(/[؟?!]/g, '').trim(); };

  /* ---------- نتايج وأزرار ---------- */
  const tbl = (cols, rows) => '| ' + cols.join(' | ') + ' |\n|' + cols.map(() => '---').join('|') + '|\n' + rows.map(r => '| ' + r.map(x => String(x ?? '').replace(/\|/g, '/')).join(' | ') + ' |').join('\n');
  const deny = (what) => `🔒 ${what} مش من صلاحياتك (دورك: ${S.roleName || '—'}). لو محتاجها كلّم المدير يضيفها لدورك.`;
  const R = (md, acts, extra) => Object.assign({ md, acts: acts || [] }, extra || {});
  const act = (label, fn, o = {}) => ({ label, fn, kind: o.kind || '', auto: !!o.auto, once: o.once !== false });

  /* ---------- الأوامر (كلها بصلاحيات المستخدم) ---------- */
  const ACT = {
    draft(a) { // a: {type:'sale'|'purchase'|'quote'|'porder', partyId, items:[{pid,qty}], merge}
      const grp = ['sale', 'quote'].includes(a.type) ? 'sale' : 'purchase';
      if (!can(grp === 'sale' ? 'sell' : 'buy')) return R(deny(grp === 'sale' ? 'البيع' : 'الشراء'));
      const open = ED && !ED.id && ED.grp === grp && ED.inv.lines.length;
      const pre = [];
      if (OUTT.includes(a.type) && !allowNeg()) a.items = (a.items || []).filter(it => { const av = qtyIn(it.pid, MAIN); if (av <= 0.0001) { pre.push(`«${pname(it.pid)}» رصيده صفر — مينفعش يتباع`); return false; } if (it.qty > av + 0.0001) { pre.push(`«${pname(it.pid)}» المتاح ${fq(av)} بس — حطيت ${fq(av)}`); it.qty = av; } return true; });
      const preMd = pre.length ? '\n\n⚠️ ' + pre.join('\n⚠️ ') : '';
      const build = merge => {
        if (!merge || !open) ED = { id: null, inv: newInv(a.type), grp };
        const inv = ED.inv; if (a.type && inv.type !== a.type && !inv.lines.length) inv.type = a.type;
        if (a.partyId) inv.partyId = a.partyId;
        const notes = [];
        for (const it of a.items || []) {
          const p = G('products', it.pid); if (!p) continue; let q = +it.qty || 1;
          const ex = inv.lines.find(l => l.pid === it.pid); const cur = ex ? +ex.qty || 0 : 0;
          if (OUTT.includes(inv.type) && !allowNeg()) { const av = qtyIn(it.pid, inv.storeId); if (av - cur <= 0.0001) { notes.push(`«${p.name}» رصيده صفر — اتشال`); continue; } if (cur + q > av + 0.0001) { notes.push(`«${p.name}» المتاح ${fq(av)} بس — حطيت ${fq(av - cur)}`); q = av - cur; } }
          if (ex) ex.qty = cur + q;
          else inv.lines.push({ pid: it.pid, qty: q, price: isSaleT(inv.type) ? salePrice(p, inv.partyId) : (Math.round(avgCost(it.pid) * 100) / 100 || +p.cost || 0), disc: 0, cost: '', ...(PURT.includes(inv.type) ? { consumer: consOf(p) } : {}) });
        }
        if (isSaleT(inv.type) && inv.partyId) inv.lines.forEach(l => { const p = G('products', l.pid); if (p && !l.bonus) l.price = salePrice(p, inv.partyId); });
        if (isSaleT(inv.type) || inv.type === 'transfer') inv.lines.sort((x, y) => pname(x.pid).localeCompare(pname(y.pid)));
        if (location.hash === '#/' + grp) render(); else go(grp);
        if (notes.length) setTimeout(() => toast(notes.join(' • '), 'err'), 400);
        return notes;
      };
      const desc = `${TYPES[a.type].full}${a.partyId ? ' لـ **' + partyName(a.partyId) + '**' : grp === 'sale' ? ' (عميل نقدي)' : ''}` + (a.items && a.items.length ? ':\n' + a.items.map(i => `- ${fq(i.qty)} × ${pname(i.pid)}`).join('\n') : '');
      if (open && (a.items || []).length) return R(`فيه ${TYPES[ED.inv.type].full} مفتوحة لسه متحفظتش (${ED.inv.lines.length} صنف). أعمل إيه؟\n\n${desc}${preMd}`, [act('ضيفهم على الفاتورة المفتوحة', () => { build(true); return 'ضفتهم ✓ — راجع واحفظ بـ Ctrl+S'; }, { kind: 'p' }), act('فاتورة جديدة', () => { build(false); return 'فتحت فاتورة جديدة ✓ — راجع واحفظ بـ Ctrl+S'; })]);
      if (!(a.items || []).length && pre.length) return R('مقدرتش أجهز الفاتورة:' + preMd);
      return R(`جهزتلك ${desc}${preMd}\n\nفتحتها في شاشتها — راجع الكميات والأسعار واحفظ بـ **Ctrl+S**. (مش هتتحفظ غير لما تحفظها انت)`, [act('افتح الفاتورة', () => { build(false); }, { auto: true, kind: 'p' })]);
    },
    cash(a) { // {kind:'in'|'out', category, amount, partyId, empId, safe, note, exp}
      if (!can('cash')) return R(deny('الخزينة والسندات'));
      const o = { kind: a.kind, category: a.category, amount: a.amount || '', partyId: a.partyId || '', empId: a.empId || '', note: a.note || '', ...(a.safe ? { safe: a.safe } : {}), ...(a.exp ? { exp: true } : {}) };
      const who = a.partyId ? partyName(a.partyId) : a.empId ? (L('employees').find(e => e.id === a.empId) || {}).name : '';
      return R(`جهزتلك **${a.kind === 'in' ? 'سند قبض' : 'سند صرف'}** — ${a.category}${a.amount ? ' بمبلغ **' + F(a.amount) + '**' : ''}${who ? ' — ' + who : ''}${a.safe ? ' — ' + safeName(a.safe) : ''}${a.note ? ' — ' + a.note : ''}.\nراجعه ودوس «حفظ».`, [act('افتح السند', () => cashModal(o), { auto: true, kind: 'p', once: false })]);
    },
    xfer(a) {
      if (!can('cash')) return R(deny('الخزينة'));
      const o = { amount: a.amount || '', ...(a.from ? { from: a.from } : {}), ...(a.to ? { to: a.to } : {}) };
      return R(`جهزتلك **تحويل بين الخزائن** بمبلغ ${F(a.amount || 0)}${a.from ? ' من ' + safeName(a.from) : ''}${a.to ? ' إلى ' + safeName(a.to) : ''}. راجع ودوس «حفظ».`, [act('افتح التحويل', () => xferModal(o), { auto: true, kind: 'p', once: false })]);
    },
    statement(pid) {
      if (!can('parties')) return R(deny('كشوف الحساب'));
      return R(`كشف حساب **${partyName(pid)}** — الرصيد الحالي ${F(calc().party[pid] || 0)}. فتحته لك (تقدر تطبعه أو تبعته واتساب).`, [act('افتح كشف الحساب', () => statement(pid), { auto: true, kind: 'p', once: false })]);
    },
    print(inv) {
      if (!invOk(inv)) return R(deny('الفواتير دي'));
      const pr = G('prints', inv.id);
      return R(`طباعة **${TYPES[inv.type].full} رقم ${inv.no}**${pr && pr.n ? ` — ملحوظة: اتطبعت قبل كده ${pr.n} مرة (آخر مرة ${ltm(pr.last)})، النسخة دي هتتعلّم «نسخة مكررة»` : ''}.`, [act('اطبع', () => printInv(inv.id), { auto: !(pr && pr.n), kind: 'p', once: false })]);
    },
    openInv(inv) { if (!invOk(inv)) return R(deny('الفواتير دي')); return R(`فتحتلك ${TYPES[inv.type].full} رقم ${inv.no}.`, [act('افتح الفاتورة', () => go('inv/' + inv.id), { auto: true, kind: 'p', once: false })]); },
    ret(inv) {
      if (!['sale', 'purchase'].includes(inv.type)) return R('المرتجع بيتعمل من فاتورة بيع أو شراء بس.');
      if (!can(inv.type === 'sale' ? 'sell' : 'buy')) return R(deny(inv.type === 'sale' ? 'مرتجع المبيعات' : 'مرتجع المشتريات'));
      return R(`فتحتلك **مرتجع من ${TYPES[inv.type].full} رقم ${inv.no}** (${partyName(inv.partyId) || 'نقدي'}) — اختار الأصناف والكميات اللي راجعة واحفظ.`, [act('افتح المرتجع', () => startReturn(inv.id), { auto: true, kind: 'p' })]);
    },
    setPrice(p, v, field) {
      if (!can('products')) return R(deny('تعديل أسعار الأصناف'));
      const f = field || 'consumer'; const fl = { consumer: 'سعر المستهلك', price: 'سعر البيع', cost: 'التكلفة' }[f];
      const old = f === 'consumer' ? consOf(p) : +p[f] || 0;
      return R(`تغيير **${fl}** للصنف **${p.name}** من ${F(old)} إلى **${F(v)}** — متأكد؟`, [act('تأكيد التغيير', async () => {
        const cur = L('products').find(x => x.id === p.id); if (!cur) return 'الصنف مش موجود';
        const n = { ...cur }; delete n.id; n[f] = +v; n.updatedAt = new Date().toISOString();
        await audit('products', p.id, fl, old, +v, p.name); await put('products', p.id, n); return `تم ✓ — ${fl} «${p.name}» بقى ${F(v)}`;
      }, { kind: 'p' }), act('إلغاء', () => 'اتلغى — مفيش حاجة اتغيرت.')]);
    },
    newParty(kind, name, phone) {
      if (!can('parties')) return R(deny('إضافة عملاء وموردين'));
      return R(`فتحتلك إضافة ${kind === 'vendor' ? 'مورد' : 'عميل'} جديد${name ? ' باسم **' + name + '**' : ''}${phone ? ' — ' + phone : ''}. كمّل البيانات ودوس «حفظ».`, [act('افتح', () => { partyModal(null, kind); setTimeout(() => { const n = document.getElementById('q_n'), ph = document.getElementById('q_p'); if (n && name) n.value = name; if (ph && phone) ph.value = phone; }, 60); }, { auto: true, kind: 'p', once: false })]);
    },
    newProduct(name) {
      if (!can('products')) return R(deny('إضافة الأصناف'));
      return R(`فتحتلك صنف جديد${name ? ' باسم **' + name + '**' : ''} — كمّل الكود والأسعار واحفظ.`, [act('افتح', () => { productModal(null); setTimeout(() => { const n = document.getElementById('m_name'); if (n && name) n.value = name; }, 60); }, { auto: true, kind: 'p', once: false })]);
    },
    open(route, title) { const k = route.split('/')[0]; if (!canRoute(k)) return R(deny('شاشة «' + title + '»')); return R(`فتحتلك «${title}».`, [act('افتح', () => go(route), { auto: true, kind: 'p', once: false })]); },
  };
  const invOk = inv => ['sale', 'sret', 'quote', 'transfer'].includes(inv.type) ? can('sell') : can('buy');
  const safeName = id => (safes().find(s => s.id === id) || {}).name || '';
  AI.actions = ACT;

  /* ---------- مساعدات للقراءة ---------- */
  function findInv(no, type) {
    const xs = L('invoices').filter(i => String(i.no) === String(no) && (!type || i.type === type)); if (!xs.length) return null;
    const pref = xs.filter(invOk); const ys = pref.length ? pref : xs;
    return ys.sort((a, b) => (['sale', 'purchase'].indexOf(a.type) < 0) - (['sale', 'purchase'].indexOf(b.type) < 0) || (b.date || '').localeCompare(a.date || ''))[0];
  }
  function invMd(inv) {
    const r = T().get_invoice.run({ no: inv.no, type: inv.type }); if (r.error) return r.error;
    const pr = G('prints', inv.id);
    return `**${r.type} رقم ${r.no}** — ${r.date} — ${r.party}${pr && pr.n ? ` — اتطبعت ${pr.n} مرة` : ' — لسه ماتطبعتش'}\n\n` + tbl(['الصنف', 'الكمية', 'السعر', 'الصافي'].concat(sc() && r.lines.some(l => l.profit != null) ? ['الربح'] : []), r.lines.map(l => [l.item, l.qty, F(l.price), F(l.net)].concat(sc() && l.profit != null ? [F(l.profit)] : []))) + `\n\n**الإجمالي:** ${F(r.total)} — المدفوع ${F(r.paid)} — الباقي ${F(r.rest)}${r.profit != null ? ' — الربح ' + F(r.profit) : ''}`;
  }
  function rep(id, a, title, cols, lim) {
    if (!can('reports')) return deny('التقارير');
    const r = T().run_report.run(Object.assign({ report_id: id, limit: lim || 10 }, a)); if (r.error) return r.error.startsWith('المستخدم') ? deny('التقرير ده') : r.error;
    if (!r.rows.length) return `**${title}** — مفيش بيانات${r.filters && r.filters.from ? ` من ${r.filters.from} لـ ${r.filters.to}` : ''}.`;
    const ok = cols.filter(c => r.columns[c[0]] !== undefined || r.rows.some(x => x[c[0]] !== undefined));
    let s = `**${title}**${r.filters && r.filters.from ? ` (${r.filters.from} ← ${r.filters.to})` : ''} — ${r.total_rows} صف${r.total_rows > r.rows.length ? `، أول ${r.rows.length}` : ''}\n\n` + tbl(ok.map(c => c[1]), r.rows.map(x => ok.map(c => typeof x[c[0]] === 'number' ? F(x[c[0]]) : (x[c[0]] ?? '')))) ;
    const tt = ok.filter(c => r.totals && r.totals[c[0]] != null && c[2]); if (tt.length) s += '\n\n**الإجمالي:** ' + tt.map(c => `${c[1]} ${F(r.totals[c[0]])}`).join(' — ');
    return s;
  }
  function overviewRows(p) { const o = T().overview.run({ from: p.from, to: p.to }); if (o.error) return null; return o; }
  function moneyMd(ps) {
    if (!can('reports')) return deny('أرقام المبيعات والأرباح');
    if (ps.length >= 2) {
      const os = ps.map(overviewRows); const rows = [['صافي المبيعات', 'net_sales'], ['عدد فواتير البيع', 'sale_invoices'], ['مرتجعات المبيعات', 'sales_returns']].concat(sc() ? [['مجمل الربح', 'gross_profit']] : []).concat([['المشتريات', 'purchases']]);
      let s = '**مقارنة**\n\n' + tbl(['البند'].concat(ps.map(p => p.label)).concat(ps.length === 2 ? [`الفرق (${ps[0].label} عن ${ps[1].label})`] : []), rows.map(([t, k]) => [t].concat(os.map(o => F(o[k]))).concat(ps.length === 2 ? [diff(os[0][k], os[1][k])] : [])));
      return s;
    }
    const p = ps[0] || DEFP(); const o = overviewRows(p);
    let s = `**ملخص ${p.label}** (${o.period.from} ← ${o.period.to})\n\n` + tbl(['البند', 'القيمة'], [['صافي المبيعات', F(o.net_sales)], ['عدد فواتير البيع', o.sale_invoices], ['متوسط الفاتورة', o.sale_invoices ? F(o.sales / o.sale_invoices) : '—'], ['مرتجعات المبيعات', F(o.sales_returns)]].concat(o.gross_profit != null ? [['مجمل الربح', F(o.gross_profit) + (o.net_sales ? ` (${r2(o.gross_profit / o.net_sales * 100)}%)` : '')]] : []).concat([['المشتريات', F(o.purchases)], ['على العملاء لنا', F(o.customers_owe_us)], ['علينا للموردين', F(o.we_owe_vendors)]]));
    if (o.safes) s += '\n\n**الخزائن:**\n' + tbl(['الخزينة', 'الرصيد'], Object.entries(o.safes).map(([k, v]) => [k, F(v)]));
    return s;
  }
  const diff = (a, b) => { const d = (+a || 0) - (+b || 0); const pc = b ? ` (${d >= 0 ? '+' : ''}${r2(d / b * 100)}%)` : ''; return (d >= 0 ? '+' : '') + F(d) + pc; };
  function partyMd(ps) {
    if (!(can('parties') || can('sell') || can('buy'))) return deny('أرصدة العملاء والموردين');
    const Rc = calc(); const { ls, lp } = lastDates();
    return tbl(['الاسم', 'النوع', 'الرصيد', 'آخر تعامل', 'آخر سداد', 'الشريحة'], ps.map(p => { const b = Rc.party[p.id] || 0; return [p.name, p.kind === 'vendor' ? 'مورد' : 'عميل', F(b) + (b > 0.009 ? (p.kind === 'vendor' ? ' (لنا)' : ' (عليه)') : b < -0.009 ? (p.kind === 'vendor' ? ' (علينا)' : ' (له)') : ''), ls[p.id] || '—', lp[p.id] || '—', (tierOf(p.id) || {}).name || (p.kind === 'vendor' ? '' : 'مستهلك')]; }));
  }
  function partySalesMd(p, per) {
    const isV = p.kind === 'vendor'; const ty = isV ? ['purchase', 'pret'] : ['sale', 'sret'];
    if (!can(isV ? 'buy' : 'sell')) return deny(isV ? 'المشتريات' : 'المبيعات');
    const Rc = calc(); let tot = 0, cnt = 0, ret = 0, prof = 0; const items = {};
    for (const i of L('invoices')) { if (i.partyId !== p.id || !ty.includes(i.type) || i.date < per.from || i.date > per.to) continue; const x = Rc.inv[i.id]; if (!x) continue; if (i.type === ty[0]) { tot += x.total; cnt++; } else ret += x.total; if (x.profit != null) prof += (i.type === ty[0] ? 1 : 1) * x.profit; (i.lines || []).forEach((l, k) => { const ln = Rc.line[i.id + ':' + k] || {}; const s = i.type === ty[0] ? 1 : -1; const it = items[l.pid] || (items[l.pid] = { q: 0, v: 0 }); it.q += s * (+l.qty || 0); it.v += s * (ln.net || 0); }); }
    const top = Object.entries(items).sort((a, b) => b[1].v - a[1].v).slice(0, 8);
    let s = `**${isV ? 'مشترياتنا من' : 'مبيعات'} ${p.name} — ${per.label}** (${per.from} ← ${per.to})\n\n` + tbl(['البند', 'القيمة'], [[isV ? 'المشتريات' : 'المبيعات', F(tot)], ['عدد الفواتير', cnt], ['المرتجعات', F(ret)], ['الصافي', F(tot - ret)]].concat(!isV && sc() ? [['الربح', F(prof)]] : []).concat([['الرصيد الحالي', F(Rc.party[p.id] || 0)]]));
    if (top.length) s += '\n\n**أكتر الأصناف:**\n' + tbl(['الصنف', 'الكمية', 'القيمة'], top.map(([pid, v]) => [pname(pid), fq(v.q), F(v.v)]));
    return s;
  }
  function prodSalesMd(prods, per) {
    if (!can('sell') && !can('reports')) return deny('المبيعات');
    const ids = new Set(prods.map(p => p.id)); const Rc = calc(); const by = {};
    for (const i of L('invoices')) { if (!['sale', 'sret'].includes(i.type) || i.date < per.from || i.date > per.to) continue; const s = i.type === 'sale' ? 1 : -1; (i.lines || []).forEach((l, k) => { if (!ids.has(l.pid)) return; const ln = Rc.line[i.id + ':' + k] || {}; const o = by[l.pid] || (by[l.pid] = { q: 0, v: 0, pr: 0, n: 0 }); o.q += s * (+l.qty || 0); o.v += s * (ln.net || 0); o.pr += s * (ln.profit || 0) * (s > 0 ? 1 : -1) * (s > 0 ? 1 : -1); if (s > 0) o.n++; }); }
    const sold = prods.filter(p => by[p.id]); if (!sold.length) return `مفيش مبيعات لـ «${prods[0].name.split(' ')[0]}» ${per.label} (${per.from} ← ${per.to}).`;
    prods = sold.sort((a, b) => by[b.id].v - by[a.id].v);
    const rows = prods.map(p => [p.name, fq((by[p.id] || {}).q || 0), F((by[p.id] || {}).v || 0)].concat(sc() ? [F((by[p.id] || {}).pr || 0)] : []).concat([fq(qtyIn(p.id))]));
    return `**مبيعات الأصناف — ${per.label}** (${per.from} ← ${per.to})\n\n` + tbl(['الصنف', 'الكمية المباعة', 'القيمة'].concat(sc() ? ['الربح'] : []).concat(['الرصيد الحالي']), rows);
  }
  function prodMd(prods, opts = {}) {
    const showC = sc(); const ts = showC ? tiers() : [];
    let s = (prods.length > 1 ? `لقيت ${prods.length} صنف:\n\n` : '') + tbl(['الصنف', 'الكود', 'الرصيد', 'سعر المستهلك'].concat(showC ? ['متوسط التكلفة'].concat(ts.slice(0, 3).map(t => t.name)) : []), prods.map(p => { const c = avgCost(p.id); return [p.name, p.code || '', fq(qtyIn(p.id)), F(consOf(p))].concat(showC ? [F(c)].concat(ts.slice(0, 3).map(t => F(c * (1 + (+t.markup || 0) / 100)))) : []); }));
    if (prods.length === 1) { const st = calc().stock[prods[0].id]; const by = st ? Object.entries(st.by || {}).filter(([, q]) => Math.abs(q) > 0.0001) : []; if (by.length > 1) s += '\n\n**حسب المخزن:** ' + by.map(([k, q]) => `${storeName(k)}: ${fq(q)}`).join(' — '); const mn = prods[0].minQty; if (mn !== '' && mn != null && qtyIn(prods[0].id) <= +mn) s += `\n\n⚠️ الرصيد وصل لحد الطلب (${fq(mn)}).`; }
    return s;
  }

  /* ---------- النوايا ---------- */
  const DRAFTV = ['اعمل', 'اعملي', 'عمل', 'سجل', 'سجلي', 'جهز', 'جهزلي', 'انشئ', 'اكتب', 'اكتبلي', 'افتح', 'افتحلي', 'ابدا', 'نزل', 'نزلي', 'طلع'];
  const INT = [
    { id: 'greet', m: c => c.w.length <= 5 && /^(ازيك|ازيكم|اهلا|هاي|هلو|هلا|السلام|سلام|صباح|مساء|يا مساعد|انت مين|مين انت|hi|hello)/.test(c.t), run: c => R(`أهلًا ${(S.me && S.me.name) || ''} 👋 أنا مساعد ميزان المدمج — شغّال مجانًا ومن غير إنترنت، وبشتغل بصلاحياتك انت (${S.roleName || ''}).\n\n` + capsMd()) },
    { id: 'thanks', m: c => c.w.length <= 6 && has(c, 'شكرا', 'متشكر', 'تسلم', 'مرسي', 'تمام كده', 'حلو', 'جميل'), run: () => R('العفو 🌿 تحت أمرك في أي حاجة تانية.') },
    { id: 'caps', m: c => has(c, 'تقدر تعمل ايه', 'بتعمل ايه', 'تعرف تعمل ايه', 'مساعده', 'ساعدني', 'الاوامر', 'help') && c.w.length <= 7, run: () => R(capsMd()) },
    { id: 'calc', m: c => /^(احسب|كام|حسبة|حسبه)?\s*[\d\s+\-*/×÷x().%]+(من\s*[\d.]+)?\s*$/.test(c.t.replace(/^(احسب|حسبه|كام)\s*/, '')) && /\d\s*[+\-*/×÷x%]\s*\d|%/.test(c.t), run: c => R(calcMd(c.t)) },
    { id: 'time', m: c => has(c, 'الساعه كام', 'التاريخ', 'النهارده كام', 'انهي يوم', 'النهارده ايه') && c.w.length <= 5, run: () => R(`النهارده **${DAYS[new Date(today() + 'T12:00:00').getDay()]} ${today()}** — الساعة ${nowHM()} (بتوقيت السيرفر).`) },
    { id: 'howto', m: c => has(c, 'ازاي', 'ازاى', 'ازى', 'كيف', 'طريقه', 'اعمل ايه علشان', 'اعمل ايه عشان', 'خطوات') , run: c => { const h = (AI.HELP || []).find(([re]) => re.test(c.raw) || re.test(c.t)); if (!h) return null; const okr = canRoute(h[1].split('/')[0]); return R(`**${h[2]}:**\n` + h[3].map((s, i) => `${i + 1}. ${s}`).join('\n') + (okr ? '' : '\n\n🔒 الشاشة دي مش من صلاحياتك حاليًا.'), okr ? [act('افتح الشاشة', () => go(h[1]), { kind: 'p', once: false })] : []); } },
    // ---- فاتورة برقمها: عرض / طباعة / فتح / مرتجع
    { id: 'invno', m: c => c.invNo != null || (c.mem.inv && has(c, 'اطبعها', 'افتحها', 'رجعها', 'اطبعهالي', 'افتحهالي', 'نفس الفاتوره')), run: c => {
      const inv = c.invNo != null ? findInv(c.invNo, c.invType) : L('invoices').find(i => i.id === c.mem.inv); if (!inv) return R(`مفيش فاتورة رقم ${c.invNo}.`);
      c.set.inv = inv.id; if (inv.partyId) c.set.party = inv.partyId;
      if (has(c, 'اطبع', 'طباعه', 'اطبعها', 'برنت')) return ACT.print(inv);
      if (has(c, 'مرتجع', 'رجع', 'ارجع', 'رجعها', 'ترجيع')) return ACT.ret(inv);
      if (has(c, 'افتح', 'افتحها', 'عدل', 'تعديل', 'وديني')) return ACT.openInv(inv);
      if (!invOk(inv)) return R(deny('الفواتير دي'));
      return R(invMd(inv), [act('افتحها', () => go('inv/' + inv.id), { once: false }), act('اطبعها', () => printInv(inv.id), { once: false })]);
    } },
    // ---- تجهيز فاتورة
    { id: 'draft', m: c => (has(c, 'فاتوره', 'فاتورة', 'عرض سعر', 'امر توريد', 'اوردر', 'طلبيه') && (has(c, ...DRAFTV) || c.qtyItems)) && !has(c, 'ازاي', 'كيف', 'اخر', 'فواتير') || (has(c, 'بيع', 'بيعلي', 'اشتري', 'اشتريلي') && has(c, ...DRAFTV)), run: c => draftIntent(c) },
    // ---- سندات
    { id: 'xfer', m: c => has(c, 'حول', 'حولت', 'تحويل', 'نقل') && c.n.length && (has(c, 'خزنه', 'خزينه', 'الخزنه', 'الخزينه') || safeHits(c).length >= 1) && !has(c, 'مخزن', 'المخزن'), run: c => { const sh = safeHits(c, true); const a = { amount: c.amount }; const to = sh.find(x => x.to), fr = sh.find(x => !x.to); if (to) a.to = to.s.id; if (fr) a.from = fr.s.id; if (!fr && to && to.s.id !== defSafe()) a.from = defSafe(); return ACT.xfer(a); } },
    { id: 'receipt', m: c => has(c, 'حصل', 'حصلت', 'حصلنا', 'حصلي', 'تحصيل', 'استلمت', 'استلمنا', 'قبضت', 'قبضنا', 'سند قبض', 'دفعلنا', 'دفع لنا', 'دفع', 'دفعلي', 'سدد لنا', 'سددلنا', 'وصل منه', 'جالنا من', 'خدت من', 'اخدت من') && (c.n.length || has(c, 'سند قبض')), run: c => cashIntent(c, 'in') },
    { id: 'payment', m: c => (has(c, 'سدد', 'سددت', 'سددنا', 'ادفع', 'دفعت', 'دفعنا', 'ندفع', 'سند صرف', 'صرفت', 'صرفنا', 'اصرف', 'اصرفلي', 'سلفه') || c.w.some(w => ['مصروف', 'مصاريف', 'سلف'].includes(w))) && (c.amount || has(c, 'سند صرف')) && !has(c, 'تقرير', 'كام'), run: c => cashIntent(c, 'out') },
    // ---- تعديل سعر
    { id: 'price', m: c => has(c, 'غير', 'غيري', 'عدل', 'عدلي', 'خلي', 'اجعل', 'حط', 'ظبط', 'زود', 'نزل') && has(c, 'سعر', 'السعر', 'تكلفه', 'التكلفه') && c.n.length, run: c => priceIntent(c) },
    // ---- إضافة عميل/مورد/صنف
    { id: 'newparty', m: c => has(c, 'ضيف', 'اضف', 'ضيفلي', 'سجل', 'افتح حساب', 'جديد', 'جديده') && has(c, 'عميل', 'مورد', 'صيدليه', 'زبون') && has(c, 'جديد', 'جديده', 'اسمه', 'اسمها', 'ضيف', 'اضف'), run: c => { const kind = has(c, 'مورد') ? 'vendor' : 'customer'; const m = c.raw.match(/(?:اسمه|اسمها|باسم)\s+(.+?)(?:\s+(?:رقمه|رقمها|تليفونه|تليفونها|موبايله|تليفون|رقم|موبايل)\s*[:\-]?\s*([\d +]{8,}))?$/); const ph = (c.raw.match(/0\d{9,10}|\+?20\d{9,10}/) || [])[0] || (m && m[2]) || ''; return ACT.newParty(kind, m ? m[1].replace(/0\d{9,10}.*/, '').trim() : '', ph.replace(/\s/g, '')); } },
    { id: 'newprod', m: c => has(c, 'ضيف', 'اضف', 'سجل') && has(c, 'صنف', 'منتج') && has(c, 'جديد', 'اسمه'), run: c => { const m = c.raw.match(/(?:اسمه|باسم)\s+(.+)$/); return ACT.newProduct(m ? m[1].trim() : ''); } },
    // ---- كشف حساب
    { id: 'statement', m: c => has(c, 'كشف', 'كشف حساب', 'كشفه'), run: c => { const r = resolveParty(c, null, { pronoun: true }); if (!r) return R('اكتب اسم العميل أو المورد — مثلًا: «كشف حساب ص الجزار».'); if (r.many) return pick(r.many, p => ACT.statement(p.id), 'تقصد مين؟'); c.set.party = r.p.id; return ACT.statement(r.p.id); } },
    // ---- متابعات CRM / حضور / شيكات
    { id: 'crm', m: c => !has(c, 'افتح', 'افتحلي', 'وديني', 'روح', 'روحلي') && has(c, 'متابعات', 'متابعاتي', 'المتابعات', 'متابعه', 'الصيدليات', 'صيدليات', 'crm') && !has(c, 'ازاي'), run: c => crmMd(c) },
    { id: 'att', m: c => !has(c, 'افتح', 'افتحلي', 'وديني', 'روح', 'روحلي') && has(c, 'حضر', 'حاضر', 'الحضور', 'غايب', 'غياب', 'متاخر', 'اتاخر', 'انصراف', 'بصم', 'بصمت') && !has(c, 'ازاي'), run: c => attMd(c) },
    { id: 'chq', m: c => !has(c, 'افتح', 'افتحلي', 'وديني', 'روح', 'روحلي') && has(c, 'شيك', 'شيكات', 'الشيكات') && !has(c, 'ازاي'), run: c => chqMd(c) },
    // ---- فتح شاشة / تقرير
    { id: 'open', m: c => has(c, 'افتح', 'افتحلي', 'وديني', 'روح', 'روحلي', 'شاشه', 'تقرير') && (screenHit(c) || reportHit(c)), run: c => { const r = reportHit(c); if (r && (has(c, 'تقرير') || !screenHit(c))) return ACT.open('reports/' + r.id, 'تقرير ' + r.t); const s = screenHit(c); return ACT.open(s[0], s[1]); } },
    // ---- قوايم
    { id: 'unpaid', m: c => has(c, 'اجل', 'الاجل', 'متدفعتش', 'مش مدفوعه', 'لسه عليها', 'غير مدفوعه', 'الباقي عليها'), run: c => invListMd(c, { unpaid_only: true, type: has(c, 'شراء', 'مشتريات', 'موردين') ? 'purchase' : 'sale' }, 'الفواتير الآجلة (لسه عليها فلوس)') },
    { id: 'lastinv', m: c => has(c, 'اخر فاتوره', 'اخر الفواتير', 'اخر فواتير', 'فواتير', 'الفواتير') && !has(c, 'ازاي', 'اطبع'), run: c => { const r = resolveParty(c, null, { pronoun: true }); if (r && r.p) c.set.party = r.p.id; if (r && r.many) return pick(r.many, p => R(invListMd(c, { party: p.name }, 'فواتير ' + p.name)), 'فواتير مين؟'); const per = c.p[0]; return R(invListMd(c, Object.assign({ type: has(c, 'شراء', 'مشتريات') ? 'purchase' : has(c, 'بيع', 'مبيعات') ? 'sale' : undefined, party: r && r.p ? r.p.name : undefined, limit: /اخر فاتوره/.test(c.t) ? 1 : 10 }, per ? { from: per.from, to: per.to } : {}), (r && r.p ? 'فواتير ' + r.p.name : 'آخر الفواتير') + (per ? ' — ' + per.label : ''))); } },
    { id: 'debts', m: c => has(c, 'عليهم', 'ديون', 'مديونيات', 'المديونيه', 'مستحق لنا', 'فلوس بره', 'فلوسنا', 'لينا عند') || (has(c, 'العملاء', 'عملاء') && has(c, 'ارصده', 'رصيد', 'حساب', 'حسابات')), run: c => R(rep('cust_balances', {}, 'أكتر العملاء عليهم فلوس', [['name', 'العميل'], ['bal', 'الرصيد', 1], ['a90', 'أكتر من 90 يوم', 1], ['last', 'آخر بيع'], ['lastPay', 'آخر سداد']], c.n[0] && c.n[0] <= 50 ? c.n[0] : 10)) },
    { id: 'vend', m: c => has(c, 'الموردين', 'موردين', 'المورد', 'مورد') && has(c, 'علينا', 'لهم', 'مستحق', 'ديون', 'رصيد', 'ارصده', 'حساب', 'حسابات', 'فلوس') && !resolveStrong(c, 'vendor'), run: c => R(rep('vend_balances', {}, 'أرصدة الموردين', [['name', 'المورد'], ['bal', 'المستحق له', 1], ['last', 'آخر توريد'], ['lastPay', 'آخر سداد']], 10)) },
    { id: 'inactive', m: c => has(c, 'متوقف', 'متوقفين', 'مشتروش', 'ماشتروش', 'بطلوا', 'مبطلين', 'مبطل', 'اختفوا', 'مش بيشتروا', 'مبيسحبوش', 'مش بيسحبوا', 'انقطعوا', 'وقفوا'), run: c => R(rep('cust_inactive', { days: c.n[0] || 30 }, `العملاء المتوقفين (من ${c.n[0] || 30} يوم أو أكتر)`, [['name', 'العميل'], ['last', 'آخر شراء'], ['idleH', 'منذ'], ['bal', 'رصيده']], 15)) },
    { id: 'low', m: c => has(c, 'نواقص', 'النواقص', 'ناقص', 'قربت تخلص', 'هتخلص', 'خلصان', 'خلصت', 'حد الطلب', 'محتاج اطلب', 'نطلب ايه', 'اطلب ايه', 'نشتري ايه'), run: c => R(rep('stock_low', { days: 60 }, 'النواقص', [['name', 'الصنف'], ['q', 'الرصيد'], ['sold', 'المباع 60 يوم'], ['sug', 'المقترح'], ['lastV', 'آخر مورد'], ['est', 'التكلفة المتوقعة', 1]], 15)) },
    { id: 'stag', m: c => has(c, 'راكد', 'رواكد', 'الراكده', 'مبيتباعش', 'مش بيتباع', 'واقف', 'بطيء', 'بطيئه'), run: c => R(rep('stock_stagnant', { days: c.n[0] || 90 }, `الأصناف الراكدة (${c.n[0] || 90} يوم)`, [['name', 'الصنف'], ['q', 'الرصيد'], ['last', 'آخر بيع'], ['idle', 'أيام الركود'], ['val', 'القيمة المحبوسة', 1]], 15)) },
    { id: 'stockval', m: c => has(c, 'قيمه المخزون', 'قيمه البضاعه', 'قيمه المخزن', 'البضاعه بكام', 'المخزون بكام', 'جرد مالي'), run: () => { if (!sc()) return R(deny('قيمة المخزون')); const o = T().overview.run({}); return R(o.error ? o.error : `**قيمة المخزون بالتكلفة:** ${F(o.stock_value_at_cost)}`); } },
    { id: 'topcust', m: c => has(c, 'اكتر', 'اعلي', 'افضل', 'احسن', 'اكبر', 'توب') && has(c, 'عميل', 'عملاء', 'العملاء', 'زبون', 'زباين', 'صيدليات') && !has(c, 'عليهم', 'ديون'), run: c => { const p = c.p[0] || DEFP(); return R(rep('sales_customers', { from: p.from, to: p.to }, `أكتر العملاء شراءً — ${p.label}`, [['name', 'العميل'], ['cnt', 'الفواتير'], ['net', 'الصافي', 1], ['profit', 'الربح', 1], ['bal', 'رصيده']], c.n.find(x => x <= 50) || 10)); }, periodic: true },
    { id: 'topemp', m: c => has(c, 'البياعين', 'البائعين', 'بائع', 'بياع', 'الموظفين', 'عموله', 'العمولات') && has(c, 'مبيعات', 'اكتر', 'باع', 'عموله', 'العمولات'), run: c => { const p = c.p[0] || DEFP(); return R(rep('sales_emps', { from: p.from, to: p.to }, `مبيعات البائعين — ${p.label}`, [['name', 'البائع'], ['cnt', 'الفواتير'], ['net', 'الصافي', 1], ['profit', 'الربح', 1], ['comm', 'العمولة', 1]], 10)); }, periodic: true },
    { id: 'topprod', m: c => has(c, 'اكتر', 'اعلي', 'افضل', 'احسن', 'اكبر', 'توب', 'الاكثر') && has(c, 'صنف', 'اصناف', 'الاصناف', 'منتج', 'منتجات', 'بيتباع', 'اتباع', 'مبيعا', 'ربحيه', 'ربحا', 'بيكسب'), run: c => { const p = c.p[0] || DEFP(); const byP = has(c, 'ربح', 'ربحا', 'ربحيه', 'بيكسب', 'مكسب', 'الربح', 'ارباح') && sc(); return R(rep('sales_items', { from: p.from, to: p.to, sort_by: byP ? 'profit' : 'net' }, `أكتر الأصناف ${byP ? 'ربحًا' : 'مبيعًا'} — ${p.label}`, [['name', 'الصنف'], ['q', 'الكمية'], ['net', 'المبيعات', 1], ['profit', 'الربح', 1]], c.n.find(x => x <= 50) || 10)); }, periodic: true },
    { id: 'daily', m: c => has(c, 'كل يوم', 'يوم بيوم', 'اليوميه', 'يومي', 'بالايام', 'بالشهور', 'كل شهر', 'شهري') && !has(c, 'قارن', 'مقارنه', 'قارنلي') && c.p.length < 2, run: c => { const p = c.p[0] || (has(c, 'كل شهر', 'بالشهور', 'شهري') ? { from: today().slice(0, 5) + '01-01', to: today(), label: 'السنة دي' } : DEFP()); return R(rep('sales_daily', { from: p.from, to: p.to }, `المبيعات ${has(c, 'كل شهر', 'بالشهور', 'شهري') ? 'الشهرية' : 'اليومية'} — ${p.label}`, [['label', 'الفترة'], ['cnt', 'الفواتير'], ['net', 'الصافي', 1], ['profit', 'الربح', 1], ['margin', 'الهامش']], 31)); }, periodic: true },
    { id: 'exp', m: c => has(c, 'المصروفات', 'مصروفات', 'المصاريف', 'مصاريف', 'صرفنا كام', 'اتصرف'), run: c => { const p = c.p[0] || DEFP(); if (!can('cash') && !can('reports')) return R(deny('المصروفات')); return R(rep('expenses', { from: p.from, to: p.to }, `المصروفات — ${p.label}`, [['cat', 'البند'], ['n', 'العدد'], ['v', 'المبلغ', 1], ['share', 'النصيب']], 20)); }, periodic: true },
    { id: 'safes', m: c => has(c, 'الخزنه', 'الخزينه', 'خزنه', 'خزينه', 'الخزن', 'الخزائن', 'الكاش', 'كاش', 'السيوله', 'فودافون', 'انستا') && !has(c, 'حول', 'تحويل'), run: () => { if (!can('cash')) return R(deny('أرصدة الخزائن')); const Rc = calc(); const ss = safes(); const tot = ss.reduce((s, x) => s + (Rc.safe[x.id] || 0), 0); return R('**أرصدة الخزائن**\n\n' + tbl(['الخزينة', 'الرصيد'], ss.map(s => [s.name, F(Rc.safe[s.id] || 0)]).concat([['**الإجمالي**', '**' + F(tot) + '**']]))); } },
    // ---- مبيعات/أرباح (عامة أو لعميل أو لصنف، ومقارنة فترات)
    { id: 'money', m: c => has(c, 'مبيعات', 'المبيعات', 'بعنا', 'بعت', 'ربح', 'ارباح', 'الارباح', 'مكسب', 'كسبنا', 'ايراد', 'ايرادات', 'ملخص', 'اخبار', 'الدنيا', 'الشغل', 'مشتريات', 'اشترينا', 'سحب', 'اتباع', 'باع', 'قارن', 'مقارنه') && !has(c, 'ازاي'), run: c => moneyIntent(c), periodic: true },
    // ---- رصيد عميل/مورد
    { id: 'party', m: c => has(c, 'رصيد', 'حساب', 'حسابه', 'رصيده', 'عليه', 'ليه', 'مديون', 'تليفون', 'رقم', 'شريحه', 'شريحته') && !!resolveParty(c, null, { pronoun: true }) && !prodStrong(c), run: c => { const r = resolveParty(c, null, { pronoun: true }); if (r.many) return R(partyMd(r.many) + '\n\nحدد الاسم أكتر لو تقصد واحد بعينه.'); c.set.party = r.p.id; const p = r.p; return R(partyMd([p]) + (p.phone ? `\n\n📞 ${p.phone}` : ''), can('parties') ? [act('كشف الحساب', () => statement(p.id), { once: false }), ...(can('cash') ? [act(p.kind === 'vendor' ? 'سند صرف له' : 'سند تحصيل منه', () => cashModal({ kind: p.kind === 'vendor' ? 'out' : 'in', category: p.kind === 'vendor' ? 'سداد لمورد' : 'تحصيل من عميل', partyId: p.id }), { once: false })] : [])] : []); } },
  ];

  /* ---------- تفاصيل النوايا ---------- */
  function capsMd() {
    const L_ = [];
    if (can('reports')) L_.push('📊 **أرقام:** «مبيعات النهارده»، «قارن الشهر ده بالشهر اللي فات»، «أكتر 10 أصناف ربحًا السنة دي»، «مبيعات ص الجزار في سبتمبر»');
    L_.push('📦 **أصناف:** «رصيد فاتيكا»، «سعر سوفى طويل»' + (can('reports') ? '، «النواقص»، «الرواكد من 60 يوم»' : '') + (can('products') ? '، «غيّر سعر بانتين 400 لـ 95»' : ''));
    if (can('parties') || can('sell') || can('buy')) L_.push('👥 **عملاء وموردين:** «حساب ص حسام»' + (can('parties') ? '، «كشف حساب ص الجزار»' : '') + (can('reports') ? '، «مين عليهم فلوس»، «عملاء مبطلين»' : '') + (can('parties') ? '، «ضيف عميل جديد اسمه …»' : ''));
    if (can('sell')) L_.push('🧾 **فواتير:** «اعمل فاتورة بيع لص الجزار 5 فاتيكا كريم و3 بانتين»، «اطبع فاتورة 7786»، «مرتجع فاتورة 7786»');
    if (can('buy')) L_.push('🚚 **شراء:** «فاتورة شراء من نوفيك 10 سودو كريم»');
    if (can('cash')) L_.push('💰 **خزينة:** «حصّلت 5000 من ص الجزار»، «سددت 3000 لنوفيك»، «مصروف 200 كهربا»، «حوّل 1000 لفودافون كاش»، «الشيكات المستحقة»');
    if (can('hr')) L_.push('🕘 **موظفين:** «مين حضر النهارده»، «مين اتأخر»');
    if (can('crm') || can('crmManage')) L_.push('📍 **CRM:** «متابعاتي النهارده»');
    L_.push('❓ **شرح:** «إزاي أعمل مرتجع» — وأقدر أفتحلك أي شاشة أو تقرير: «افتح تقرير حركة الخزينة»');
    return 'أقدر أساعدك في (حسب صلاحياتك):\n\n' + L_.map(x => '- ' + x).join('\n') + '\n\nوتقدر تطلب أكتر من حاجة في رسالة واحدة: «مبيعات النهارده ورصيد فاتيكا والنواقص». وكل حاجة فيها تعديل بتتفتح لك تراجعها أو تأكدها الأول.';
  }
  function calcMd(t) {
    let e = t.replace(/^(احسب|حسبه|كام)\s*/, '').replace(/[×x]/g, '*').replace(/÷/g, '/');
    const pm = e.match(/^([\d.]+)\s*%\s*(?:من)?\s*([\d.]+)$/); if (pm) return `${pm[1]}% من ${F(pm[2])} = **${F(+pm[1] * +pm[2] / 100)}**`;
    e = e.replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
    if (!/^[\d\s+\-*/().]+$/.test(e)) return 'مقدرتش أحسبها — اكتبها كده: 150*12 أو 15% من 2000';
    try { const v = Function('"use strict";return (' + e + ')')(); if (!isFinite(v)) throw 0; return `${t.replace(/^(احسب|حسبه|كام)\s*/, '')} = **${F(v)}**`; } catch (x) { return 'مقدرتش أحسبها — اتأكد من الأقواس والعلامات.'; }
  }
  const safeHits = (c, dir) => { const hs = safes().map(s => { const nt = toks(s.name).filter(w => w.length >= 3 && !['الخزينه', 'خزينه', 'الخزنه', 'خزنه'].includes(w)); const hit = nt.find(w => c.w.some(x => stems(x).some(y => y === w || (y.length >= 4 && (w.startsWith(y) || y.startsWith(w)))))); const i = hit ? c.w.findIndex(x => stems(x).some(y => y === hit || (y.length >= 4 && (hit.startsWith(y) || y.startsWith(hit))))) : -1; const wd = i >= 0 ? c.w[i] : ''; const prev = i > 0 ? c.w[i - 1] : ''; const to = /^(ل|لل)/.test(wd) && !norm(s.name).startsWith(wd.slice(0, 2)) || ['الي', 'ل', 'لـ', 'علي', 'على', 'لحساب'].includes(prev); return { s, i, to }; }).filter(x => x.i >= 0).sort((a, b) => a.i - b.i); return dir ? hs : hs.map(x => x.s); };
  function screenHit(c) {
    let best = null;
    for (const [, it] of NAV) for (const [k, t] of it) { const tw = toks(t).filter(w => w.length >= 3 && !['شاشه', 'من', 'الي'].includes(w)); if (!tw.length) continue; const m = tw.filter(w => c.w.some(x => stems(x).some(y => y === w || (y.length >= 4 && lev(y, w, 1) <= 1) || (y.length >= 4 && w.startsWith(y))))).length; const s = m / tw.length; if (m && s >= 0.5 && (!best || s > best.s)) best = { k, t, s }; }
    return best ? [best.k, best.t] : null;
  }
  function reportHit(c) {
    let best = null; if (!can('reports')) return null;
    for (const r of REPS) { if (typeof repOk === 'function' && !repOk(r)) continue; const tw = toks(r.t).filter(w => w.length >= 3 && !['تقرير', 'وتقييمه', 'الاصناف'].includes(w)); const m = tw.filter(w => c.w.some(x => stems(x).some(y => y === w || (y.length >= 4 && lev(y, w, 1) <= 1)))).length; const s = m / Math.max(1, tw.length) + m * 0.1; if (m && (!best || s > best.s)) best = { r, s }; }
    return best && best.s >= 0.45 ? best.r : null;
  }
  const resolveStrong = (c, kind) => { const r = partyScan(c.raw, kind); return r.length && r[0].s >= 2.2 ? r[0].p : null; };
  const prodStrong = c => { const q = rest(c, ['رصيد', 'سعر', 'حساب', 'عليه', 'ليه']); if (q.length < 3) return false; const ps = prodFind(q, 2); return ps.length && norm(ps[0].name).startsWith(norm(q)) && !partyScan(c.raw).some(x => x.s >= 2.5); };
  function pick(list, fn, q) { return R(`${q || 'تقصد مين؟'}`, list.slice(0, 8).map(p => act(p.name, () => fn(p), { once: true }))); }

  function parseItems(text, opt = {}) {
    const chunks = text.replace(/\s+و\s*(?=\d)|\s+و(?=\d)/g, ' | ').replace(/\s+و\s+/g, ' | ').replace(/[،,+\n]/g, ' | ').split('|').map(s => s.trim()).filter(Boolean);
    const out = [], miss = [];
    for (const ch of chunks) {
      const ws = ch.split(/\s+/); let q = null; const nm = [];
      for (const w of ws) { const n = nz(w); if (q == null && /^\d+(\.\d+)?$/.test(n)) q = +n; else if (q == null && NUMW[n] != null) q = NUMW[n]; else if (/^\d+(\.\d+)?$/.test(n) && q != null && !nm.length) q = +n; else if (!IGN.has(n)) nm.push(w); }
      const name = nm.join(' ').trim(); if (!name) continue;
      let ps = prodFind(name, 8); if (!ps.length) { miss.push(name); continue; }
      if (opt.inStock && !allowNeg()) { const fx = nz(name).split(' ').map(fixWord).join(' '); const top = nameScore(ps[0], fx); const eq = ps.filter(p => nameScore(p, fx) >= top); const ok = eq.filter(p => qtyIn(p.id, MAIN) >= (q || 1) - 0.0001); const any = eq.filter(p => qtyIn(p.id, MAIN) > 0.0001); const pref = ok.length ? ok : any; if (pref.length) ps = pref.concat(ps.filter(p => !pref.includes(p))); }
      out.push({ pid: ps[0].id, qty: q || 1, name, alt: ps.slice(1, 4) });
    }
    return { items: out, miss };
  }
  function draftIntent(c) {
    const type = has(c, 'عرض سعر') ? 'quote' : has(c, 'امر توريد', 'اوردر توريد') ? 'porder' : has(c, 'شراء', 'اشتري', 'اشتريلي', 'مشتريات', 'من المورد', 'توريد') ? 'purchase' : 'sale';
    const kind = ['purchase', 'porder'].includes(type) ? 'vendor' : 'customer';
    const grp = kind === 'vendor' ? 'buy' : 'sell'; if (!can(grp)) return R(deny(kind === 'vendor' ? 'الشراء' : 'البيع'));
    let pr = resolveParty(c, kind, { pronoun: /(له|ليه|لها)\b/.test(c.t) });
    const cash = has(c, 'نقدي', 'كاش', 'نقدى') && kind === 'customer';
    if (cash) pr = null;
    // الأصناف = الكلام بعد شيل أوامر الفاتورة والعميل
    const used = pr && pr.used ? pr.used : new Set();
    const tk = toks(c.raw);
    const CMD = new Set(['اعمل', 'اعملي', 'عمل', 'سجل', 'سجلي', 'جهز', 'جهزلي', 'انشئ', 'اكتب', 'اكتبلي', 'افتح', 'افتحلي', 'ابدا', 'نزل', 'نزلي', 'طلع', 'فاتوره', 'بيع', 'شراء', 'عرض', 'سعر', 'امر', 'توريد', 'اوردر', 'طلبيه', 'جديده', 'جديد', 'لـ', 'ل', 'للعميل', 'العميل', 'للصيدليه', 'الصيدليه', 'من', 'المورد', 'مورد', 'عميل', 'فيها', 'بـ', 'نقدي', 'كاش', 'ص', 'لص', 'باسم', 'اسم', 'علي', 'على', 'بيعلي', 'اشتري', 'اشتريلي', 'له', 'ليه', 'لها', 'في', 'فيه', 'يا', 'لو', 'سمحت', 'ممكن', 'عايز', 'عاوز'].map(nz));
    const left = tk.filter((w, i) => !used.has(i) && !CMD.has(nz(w))).join(' ');
    const { items, miss } = parseItems(left, { inStock: OUTT.includes(type) || type === 'quote' });
    if (pr && pr.many && !items.length && !miss.length) return pick(pr.many, p => ACT.draft({ type, partyId: p.id, items: [] }), kind === 'vendor' ? 'من أنهي مورد؟' : 'لأنهي عميل؟');
    if (pr && pr.many) return pick(pr.many, p => ACT.draft({ type, partyId: p.id, items }), (kind === 'vendor' ? 'من أنهي مورد؟' : 'لأنهي عميل؟') + (items.length ? ` (${items.length} صنف جاهزين)` : ''));
    const pid = pr && pr.p ? pr.p.id : ''; if (pid) c.set.party = pid;
    if (!pid && kind === 'vendor' && !items.length) return R('من أنهي مورد؟ اكتب مثلًا: «فاتورة شراء من نوفيك 10 سودو كريم».');
    const res = ACT.draft({ type, partyId: pid, items });
    const notes = [];
    if (miss.length) notes.push('⚠️ مالقيتش: ' + miss.map(m => '«' + m + '»').join('، ') + ' — ضيفهم من البحث في الفاتورة.');
    const alts = items.filter(i => i.alt.length && !norm(pname(i.pid)).startsWith(norm(i.name)));
    if (alts.length) notes.push('اخترت أقرب صنف لـ ' + alts.map(i => `«${i.name}» ← ${pname(i.pid)}`).join('، ') + ' — غيّره لو مش هو.');
    if (!pid && kind === 'vendor') notes.push('⚠️ اختار المورد من خانة المورد قبل الحفظ.');
    if (notes.length) res.md += '\n\n' + notes.join('\n');
    return res;
  }
  function cashIntent(c, dir) {
    if (!can('cash')) return R(deny('الخزينة والسندات'));
    const amount = c.amount; const sh = safeHits(c); const safe = sh[0] ? sh[0].id : '';
    if (dir === 'in') {
      const r = resolveParty(c, 'customer', { anyKind: true, pronoun: /(منه|منها)\b/.test(c.t) });
      if (r && r.many) return pick(r.many, p => ACT.cash({ kind: 'in', category: p.kind === 'vendor' ? 'إيرادات أخرى' : 'تحصيل من عميل', amount, partyId: p.id, safe }), 'اتحصّل من مين؟');
      const p = r && r.p; if (p) c.set.party = p.id;
      const cat = has(c, 'راس مال', 'رأس مال', 'ايداع') ? 'إيداع / رأس مال' : p && p.kind === 'customer' ? 'تحصيل من عميل' : p ? 'إيرادات أخرى' : has(c, 'عميل', 'صيدليه') ? 'تحصيل من عميل' : 'إيرادات أخرى';
      return ACT.cash({ kind: 'in', category: cat, amount, partyId: p ? p.id : '', safe, note: p ? '' : rest(c, ['حصلت', 'حصل', 'تحصيل', 'استلمت', 'استلمنا', 'قبضت', 'سند', 'قبض', ...(sh.length ? toks(sh[0].name) : [])]) });
    }
    if (has(c, 'سلفه', 'سلف')) {
      const emps = L('employees').filter(e => !e.inactive); const e = emps.map(e => ({ e, m: toks(e.name).filter(w => w.length >= 3 && c.w.some(x => stems(x).includes(w))).length })).filter(x => x.m).sort((a, b) => b.m - a.m)[0];
      return ACT.cash({ kind: 'out', category: 'سلفة موظف', amount, empId: e ? e.e.id : '', safe });
    }
    const r = resolveParty(c, 'vendor', { pronoun: /(له|ليه)\b/.test(c.t) });
    if (r && r.many) return pick(r.many, p => ACT.cash({ kind: 'out', category: 'سداد لمورد', amount, partyId: p.id, safe }), 'اتدفع لمين؟');
    if (r && r.p && !has(c, 'مصروف', 'مصاريف')) { c.set.party = r.p.id; return ACT.cash({ kind: 'out', category: 'سداد لمورد', amount, partyId: r.p.id, safe }); }
    const cat = has(c, 'مرتب', 'مرتبات', 'رواتب') ? 'رواتب' : has(c, 'مسحوبات', 'سحبت لنفسي') ? 'مسحوبات' : 'مصروفات';
    return ACT.cash({ kind: 'out', category: cat, amount, safe, exp: cat === 'مصروفات', note: rest(c, ['مصروف', 'مصاريف', 'مصروفات', 'صرفت', 'صرفنا', 'اصرف', 'دفعت', 'دفعنا', 'ادفع', 'سند', 'صرف', 'ثمن', 'تمن', ...(sh.length ? toks(sh[0].name) : [])]) });
  }
  function priceIntent(c) {
    if (!can('products')) return R(deny('تعديل أسعار الأصناف'));
    const v = c.n[c.n.length - 1]; const field = has(c, 'تكلفه', 'التكلفه') ? 'cost' : has(c, 'صيدلي', 'الصيدلي', 'سعر البيع', 'الجمهور') && !has(c, 'مستهلك') ? 'price' : 'consumer';
    let q = c.raw.replace(/(\d+(?:[.,]\d+)?)(?!.*\d)/, ' ');
    q = q.split(/\s+/).filter(w => !['غير', 'غيري', 'عدل', 'عدلي', 'خلي', 'اجعل', 'حط', 'ظبط', 'زود', 'نزل', 'سعر', 'السعر', 'المستهلك', 'مستهلك', 'الصيدلي', 'صيدلي', 'البيع', 'التكلفه', 'تكلفه', 'بتاع', 'بتاعه', 'لـ', 'ل', 'الي', 'إلى', 'يبقى', 'يبقي', 'بقى', 'خليه', 'جنيه', 'ج', 'صنف', 'الصنف', 'علي', 'على'].includes(nz(w))).join(' ').replace(/\s+ل$/, '').trim();
    if (!q && c.mem.prod) { const p = L('products').find(x => x.id === c.mem.prod); if (p) return ACT.setPrice(p, v, field); }
    const ps = prodFind(q, 6); if (!ps.length) return R(`مالقيتش صنف باسم «${q}».`);
    if (ps.length > 1 && !norm(ps[0].name).startsWith(norm(q))) return R(`أنهي صنف تقصد؟`, ps.slice(0, 6).map(p => act(p.name, () => ACT.setPrice(p, v, field))));
    c.set.prod = ps[0].id; return ACT.setPrice(ps[0], v, field);
  }
  function invListMd(c, a, title) {
    const r = T().list_invoices.run(Object.assign({ limit: 10 }, a)); if (r.error) return r.error.startsWith('المستخدم') ? deny('الفواتير') : r.error;
    if (!r.count) return `**${title}** — مفيش.`;
    if (r.invoices[0]) c.set.inv = (findInv(r.invoices[0].no) || {}).id;
    return `**${title}** — ${r.count} فاتورة بإجمالي ${F(r.sum_total)}\n\n` + tbl(['الرقم', 'التاريخ', 'النوع', 'الطرف', 'الإجمالي', 'الباقي'], r.invoices.map(i => [i.no, i.date, i.type, i.party, F(i.total), F(i.rest)]));
  }
  function moneyIntent(c) {
    const ps = c.p.length ? c.p : [c.mem.period || DEFP()];
    if (c.p.length) c.set.period = c.p[c.p.length - 1];
    // لعميل/مورد معين؟
    const r = resolveParty(c, null, { pronoun: /(مبيعاته|مسحوباته|سحبه|اشترى كام)/.test(c.t) });
    if (r && r.p && (partyScan(c.raw).length && partyScan(c.raw)[0].s >= 1.6 || r.mem)) { c.set.party = r.p.id; return R(ps.map(p => partySalesMd(r.p, p)).join('\n\n---\n\n')); }
    if (r && r.many && partyScan(c.raw)[0].s >= 1.6) return pick(r.many, p => R(partySalesMd(p, ps[0])), 'تقصد مين؟');
    // لصنف معين؟
    const q = rest(c, ['مبيعات', 'المبيعات', 'بعنا', 'بعت', 'ربح', 'ارباح', 'مكسب', 'اتباع', 'باع', 'كام', 'قد', 'ايه', 'قارن', 'مقارنه', 'بـ', 'ب', 'مع', ...ps.flatMap(p => toks(p.label))]).split(/\s+/).filter(w => !['النهارده', 'امبارح', 'الشهر', 'ده', 'دي', 'اللي', 'فات', 'الاسبوع', 'السنه', 'شهر', 'اخر', 'يوم', 'ايام', 'اول'].includes(nz(w)) && !MONTHS.includes(nz(w))).join(' ');
    if (q.length >= 3 && !has(c, 'ملخص', 'الدنيا', 'اخبار', 'الشغل')) { const prods = prodFind(q, 8).filter(p => norm(p.name).includes(norm(q.split(' ')[0]))); if (prods.length) { c.set.prod = prods[0].id; return R(prodSalesMd(prods, ps[0])); } }
    if (has(c, 'مشتريات', 'اشترينا') && !has(c, 'مبيعات')) { if (!can('reports')) return R(deny('المشتريات')); const p = ps[0]; return R(rep('pur_vendors', { from: p.from, to: p.to }, `المشتريات من الموردين — ${p.label}`, [['name', 'المورد'], ['cnt', 'الفواتير'], ['net', 'الصافي', 1], ['bal', 'المستحق له']], 10)); }
    return R(moneyMd(ps));
  }
  function crmMd(c) {
    if (!(can('crm') || can('crmManage'))) return R(deny('CRM الصيدليات'));
    if (!window.MZ_CRM) return R('CRM مش متاح.');
    const t = today(); const all = MZ_CRM.scope(); const done = ['active_customer', 'not_interested'];
    const due = all.filter(l => l.nextAt && l.nextAt <= t && !done.includes(l.status)).sort((a, b) => a.nextAt.localeCompare(b.nextAt));
    const cnt = {}; all.forEach(l => cnt[l.status || 'new'] = (cnt[l.status || 'new'] || 0) + 1);
    let s = `**CRM — ${all.length} صيدلية في نطاقك**\n\n` + tbl(['الحالة', 'العدد'], Object.entries(MZ_CRM.ST).map(([k, v]) => [v, cnt[k] || 0]));
    s += `\n\n**متابعات مستحقة (${due.length}):**\n` + (due.length ? tbl(['الصيدلية', 'المنطقة', 'المتابعة', 'التليفون'], due.slice(0, 15).map(l => [l.name, [l.region, l.district].filter(Boolean).join(' - '), l.nextAt, l.phone || ''])) : 'مفيش متابعات متأخرة 👌');
    return R(s, [act('افتح المتابعات', () => go('crm'), { once: false })]);
  }
  function attMd(c) {
    const t = (c.p[0] && c.p[0].from === c.p[0].to) ? c.p[0].from : today();
    const emps = L('employees').filter(e => !e.inactive); const att = new Map(L('attendance').filter(a => a.date === t).map(a => [a.empId, a]));
    if (!can('hr')) { const me = S.me.id && emps.find(e => e.userId === S.me.id); if (!me) return R(deny('حضور باقي الموظفين')); const a = att.get(me.id); return R(`**حضورك ${t}:** ${a && a.in ? 'حضور ' + a.in : 'لسه ماسجلتش حضور'}${a && a.out ? ' — انصراف ' + a.out : ''}`, [act('افتح الحضور', () => go('attendance'), { once: false })]); }
    const rows = emps.map(e => { const a = att.get(e.id); let late = ''; try { const st = dayStatus(e, a, t); late = st && st.late ? st.late + ' د' : ''; } catch (x) {} return [e.name, a && a.in || '—', a && a.out || '—', late]; });
    const pres = rows.filter(r => r[1] !== '—');
    const onlyLate = has(c, 'متاخر', 'اتاخر', 'متاخرين'), onlyAbs = has(c, 'غايب', 'غياب', 'مجاش', 'محضرش');
    const show = onlyLate ? rows.filter(r => r[3]) : onlyAbs ? rows.filter(r => r[1] === '—') : rows;
    return R(`**الحضور ${t}** — حاضر ${pres.length} من ${emps.length}\n\n` + (show.length ? tbl(['الموظف', 'حضور', 'انصراف', 'تأخير'], show) : (onlyLate ? 'مفيش حد متأخر 👌' : 'مفيش.')), [act('افتح الحضور', () => go('attendance'), { once: false })]);
  }
  function chqMd(c) {
    if (!can('cash')) return R(deny('الشيكات'));
    const t = today(); const p = c.p[0]; const lim = p ? p.to : addDays(t, 14);
    const xs = L('cheques').filter(q => q.status === 'pending' && (!p || q.dueDate >= p.from) && q.dueDate <= lim).sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
    const sum = d => xs.filter(q => q.dir === d).reduce((s, q) => s + (+q.amount || 0), 0);
    if (!xs.length) return R(`مفيش شيكات مستحقة ${p ? p.label : 'لحد ' + lim}.`);
    return R(`**الشيكات المستحقة ${p ? p.label : 'لحد ' + lim}** — وارد ${F(sum('in'))} • صادر ${F(sum('out'))}\n\n` + tbl(['الاستحقاق', 'النوع', 'الطرف', 'رقم الشيك', 'المبلغ'], xs.slice(0, 20).map(q => [q.dueDate + (q.dueDate < t ? ' ⚠️' : ''), q.dir === 'in' ? 'وارد' : 'صادر', partyName(q.partyId), q.no || '', F(q.amount)])), [act('افتح الشيكات', () => go('cheques'), { once: false })]);
  }

  /* ---------- التقسيم لطلبات ---------- */
  const SPLITW = new Set(['رصيد', 'حساب', 'كشف', 'مبيعات', 'المبيعات', 'ارباح', 'الارباح', 'ربح', 'النواقص', 'نواقص', 'الرواكد', 'الراكد', 'فاتوره', 'اطبع', 'افتح', 'حصل', 'حصلت', 'اعمل', 'ضيف', 'غير', 'اكتر', 'اعلي', 'ديون', 'الموردين', 'العملاء', 'الخزنه', 'الخزينه', 'المصروفات', 'الشيكات', 'مين', 'ازاي', 'سعر', 'قيمه', 'متابعات', 'متابعاتي', 'سددت', 'سدد', 'ادفع', 'مصروف', 'هات', 'وريني', 'اخر', 'قارن', 'الحضور', 'الشيكات'].map(nz));
  function split(raw) {
    const parts = raw.split(/\n+|؛|;|(?:\s+(?:وكمان|كمان|وبعدين|بعدين|وبعد كده|ثم|وايضا|وأيضا|وبرضه|وبرضو)\s+)|(?<=[؟?])\s+/).map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const p of parts) {
      let cur = [];
      for (const w of p.split(/\s+/)) {
        const n = nz(w);
        if (cur.length && n.length > 2 && n[0] === 'و' && SPLITW.has(n.slice(1))) { out.push(cur.join(' ')); cur = [w.replace(/^و/, '')]; }
        else cur.push(w);
      }
      if (cur.length) out.push(cur.join(' '));
    }
    return out.filter(s => nz(s).length);
  }

  /* ---------- التشغيل ---------- */
  const MEM = AI.mem || (AI.mem = {});
  function ctx(raw) {
    const t = nz(raw); const w = t.split(' ').filter(Boolean);
    const n = nums(t);
    const invM = t.match(/(?:فاتوره|فاتورة|الفاتوره|فاتورتي|رقم|#)\s*(?:رقم|نمره|نمرة)?\s*#?(\d{1,7})\b/) || (/^#?\d{3,7}$/.test(t) ? [t, t.replace('#', '')] : null);
    const invType = /مرتجع (مبيعات|بيع)/.test(t) && !/^مرتجع فاتوره/.test(t) ? 'sret' : /شراء|مشتريات/.test(t) ? 'purchase' : /بيع|مبيعات/.test(t) ? null : null;
    const c = { raw, t, w, n, p: periods(t), mem: MEM, set: {}, invNo: invM ? invM[1] : null, invType };
    if (c.invNo != null && /(سعر|حصل|حصلت|استلمت|سدد|ادفع|دفعت|مصروف|اعمل|سجل|جهز)/.test(t) && !/(اطبع|افتح|مرتجع|رجع)/.test(t)) c.invNo = null;
    c.amount = (() => { const xs = n.filter(x => !(c.invNo && String(x) === c.invNo) && !(x >= 1900 && x <= 2100 && /\d{4}-/.test(t))); const big = /الف|آلاف|الاف/.test(t); const v = xs.length ? Math.max(...xs) : 0; return v ? (big && v < 1000 ? v * 1000 : v) : ''; })();
    c.qtyItems = /\d+\s+[^\d\s]{3,}|[^\d\s]{3,}\s+\d+/.test(t) && n.length >= 1;
    return c;
  }
  function one(raw) {
    const c = ctx(raw);
    for (const it of INT) {
      let ok = false; try { ok = it.m(c); } catch (e) { ok = false; }
      if (!ok) continue;
      let r; try { r = it.run(c); } catch (e) { console.error(e); r = R('حصل خطأ وأنا بنفّذ «' + raw + '»: ' + (e.message || e)); }
      if (!r) continue;
      if (typeof r === 'string') r = R(r);
      MEM.intent = it.id; if (it.periodic) MEM.periodic = it.id; Object.assign(MEM, c.set); if (c.p.length) MEM.period = c.p[c.p.length - 1];
      return r;
    }
    // متابعة لكلام قبل كده: «وامبارح؟» «والشهر اللي فات»
    if (c.p.length && MEM.periodic && c.w.length <= 5) { const it = INT.find(x => x.id === MEM.periodic); const r = it.run(c); MEM.period = c.p[c.p.length - 1]; return r; }
    // اسم لوحده: صنف أو عميل
    const pr = partyScan(raw); const q = rest(c, [], true); const prods = q.length >= 2 ? prodFind(q, 8) : [];
    const pStrong = pr.length && pr[0].s >= 2.2; const fw = fixWord(nz(q.split(' ')[0])); const prodOk = prods.length && (nz(prods[0].name).includes(nz(q.split(' ')[0])) || nz(prods[0].name).includes(fw));
    if (prodOk && (!pStrong || nz(prods[0].name).startsWith(nz(q)) || nz(prods[0].name).startsWith(fw))) { MEM.prod = prods[0].id; const r = R(prodMd(prods)); if (pStrong) r.md += '\n\nولقيت كمان:\n\n' + partyMd(pr.filter(x => x.s >= pr[0].s - 0.3).slice(0, 4).map(x => x.p)); return r; }
    if (pr.length && (pStrong || pr[0].s >= 1.4)) { const close = pr.filter(x => x.s >= pr[0].s - 0.3).slice(0, 6).map(x => x.p); if (close.length === 1) MEM.party = close[0].id; return R(partyMd(close)); }
    const h = (AI.HELP || []).find(([re]) => re.test(raw) || re.test(c.t)); if (h) return R(`**${h[2]}:**\n` + h[3].map((s, i) => `${i + 1}. ${s}`).join('\n'));
    return null;
  }
  AI.brain = function (text) {
    const segs = split(String(text || '').trim()); const outs = [];
    for (const s of segs.slice(0, 6)) { const r = one(s); if (r) outs.push(r); else outs.push(R(`مفهمتش «${s}» 🙏`)); }
    if (!outs.length) return R('اكتب سؤالك 🙂');
    const allBad = outs.every(o => /^مفهمتش/.test(o.md));
    if (allBad) return R('مفهمتش قصدك 🙏 ' + capsMd());
    // لو فيه أمر واحد بيفتح شاشة، نفّذه علطول
    const autos = outs.flatMap(o => o.acts.filter(a => a.auto));
    if (autos.length === 1 && outs.length === 1) { try { const x = autos[0].fn(); if (x && x.then) x.catch(() => {}); } catch (e) { console.error(e); } autos[0].ran = true; }
    return { md: outs.map(o => o.md).join('\n\n---\n\n'), acts: outs.flatMap(o => o.acts) };
  };
  /* ---------- أداة الأوامر للموديلات الأونلاين (Claude/Groq/...) ---------- */
  T().do_action = {
    d: 'نفّذ أمر في البرنامج بصلاحيات المستخدم: الفواتير والسندات بتتفتح متعبّية للمستخدم يراجعها ويحفظها بنفسه، وتغيير السعر بيظهر له زرار تأكيد. ' +
      'actions: sale_draft, quote_draft, purchase_draft, receipt (تحصيل من عميل), payment (سداد لمورد), expense (مصروف), transfer (تحويل بين خزائن), statement (كشف حساب), print_invoice, open_invoice, return_invoice (مرتجع من فاتورة), set_price (سعر المستهلك), new_customer, new_vendor.',
    p: { action: ['string', 'اسم الأمر'], party: ['string', 'اسم العميل أو المورد'], items: ['string', 'الأصناف والكميات زي: 5 فاتيكا كريم، 3 بانتين'], amount: ['number', 'المبلغ'], invoice_no: ['string', 'رقم الفاتورة'], product: ['string', 'اسم الصنف (لـ set_price)'], price: ['number', 'السعر الجديد'], note: ['string', 'بيان/ملاحظة'], phone: ['string', 'تليفون (لعميل/مورد جديد)'] }, req: ['action'],
    run(a) {
      const pty = (kind) => { if (!a.party) return { p: null }; const r = partyScan(a.party, kind); if (!r.length) return { err: 'مش لاقي: ' + a.party }; const top = r[0]; const close = r.filter(x => x.s >= top.s - 0.3); return close.length === 1 ? { p: top.p } : { err: 'فيه أكتر من اسم قريب: ' + close.slice(0, 6).map(x => x.p.name).join('، ') + ' — اسأل المستخدم يقصد مين' }; };
      const inv = () => a.invoice_no ? findInv(String(a.invoice_no).replace(/\D/g, '')) : null;
      let res;
      switch (a.action) {
        case 'sale_draft': case 'quote_draft': case 'purchase_draft': {
          const type = { sale_draft: 'sale', quote_draft: 'quote', purchase_draft: 'purchase' }[a.action]; const x = pty(type === 'purchase' ? 'vendor' : 'customer'); if (x.err) return { error: x.err };
          const { items, miss } = parseItems(String(a.items || ''), { inStock: type !== 'purchase' }); res = ACT.draft({ type, partyId: x.p ? x.p.id : '', items }); if (miss.length) res.md += '\n\n⚠️ مالقيتش: ' + miss.join('، '); break; }
        case 'receipt': { const x = pty('customer'); if (x.err) return { error: x.err }; res = ACT.cash({ kind: 'in', category: 'تحصيل من عميل', amount: +a.amount || '', partyId: x.p ? x.p.id : '', note: a.note || '' }); break; }
        case 'payment': { const x = pty('vendor'); if (x.err) return { error: x.err }; res = ACT.cash({ kind: 'out', category: 'سداد لمورد', amount: +a.amount || '', partyId: x.p ? x.p.id : '', note: a.note || '' }); break; }
        case 'expense': res = ACT.cash({ kind: 'out', category: 'مصروفات', amount: +a.amount || '', note: a.note || '', exp: true }); break;
        case 'transfer': res = ACT.xfer({ amount: +a.amount || '' }); break;
        case 'statement': { const x = pty(); if (x.err || !x.p) return { error: x.err || 'حدد الاسم' }; res = ACT.statement(x.p.id); break; }
        case 'print_invoice': case 'open_invoice': case 'return_invoice': { const i = inv(); if (!i) return { error: 'مفيش فاتورة بالرقم ده' }; res = a.action === 'print_invoice' ? ACT.print(i) : a.action === 'open_invoice' ? ACT.openInv(i) : ACT.ret(i); break; }
        case 'set_price': { const ps = prodFind(a.product || '', 3); if (!ps.length) return { error: 'مش لاقي الصنف' }; if (!(+a.price > 0)) return { error: 'السعر مش صحيح' }; res = ACT.setPrice(ps[0], +a.price, 'consumer'); break; }
        case 'new_customer': case 'new_vendor': res = ACT.newParty(a.action === 'new_vendor' ? 'vendor' : 'customer', a.party || '', a.phone || ''); break;
        default: return { error: 'أمر غير معروف' };
      }
      if (/^🔒/.test(res.md)) return { error: res.md };
      AI.pushLocal(res);
      const autos = res.acts.filter(x => x.auto); if (autos.length === 1) { try { autos[0].fn(); } catch (e) {} }
      return { ok: true, shown_to_user: res.md.replace(/[*#|]/g, ' ').slice(0, 400), note: autos.length ? 'اتفتحت للمستخدم يراجعها ويحفظ' : 'ظهر للمستخدم زرار تأكيد — هو اللي يقرر' };
    },
  };
  AI.brainParts = { nz, periods, partyScan, split, parseItems, ctx };
})();
