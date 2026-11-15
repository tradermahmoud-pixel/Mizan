/* ميزان — حفظ تلقائي لمسودة الفاتورة الجديدة في المتصفح.
   لو عملت Refresh والفاتورة لسه مش محفوظة، بترجع الأصناف اللي كتبتها لوحدها.
   بتتحفظ للفواتير الجديدة بس (id=null)؛ وبتتمسح أول ما تحفظ الفاتورة أو تبدأ جديدة. */
(function () {
  const KEY = 'mz_ed_draft_v1';
  let t = null, toastPend = false;
  const edOf = () => (typeof ED !== 'undefined' ? ED : null);
  const inEditor = () => /^#\/(sale|purchase|porder|open|sret|pret|adj|count|transfer|inv\/)/.test(location.hash || '');

  function doSave() {
    try {
      const e = edOf();
      if (!e || e.id || !e.inv) return;                 // الجديدة بس (id=null)
      const inv = e.inv;
      const has = (inv.lines && inv.lines.length) || (inv.notes && String(inv.notes).trim());
      if (!has) { return; }
      localStorage.setItem(KEY, JSON.stringify({ grp: e.grp || inv.type, type: inv.type, inv, recv: e.recv ? 1 : 0, at: Date.now() }));
    } catch (_) {}
  }
  window.edSaveDraft = function () { clearTimeout(t); t = setTimeout(doSave, 500); };
  window.edClearDraft = function () { try { localStorage.removeItem(KEY); } catch (_) {} };

  // بيرجّع كائن ED من المسودة المحفوظة لنفس النوع (أو null)
  window.edRestoreDraft = function (type) {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (d && d.grp === type && d.inv && d.inv.lines && d.inv.lines.length) {
        if (!toastPend) { toastPend = true; setTimeout(() => { toastPend = false; try { toast('رجّعنا مسودة فاتورة مش محفوظة (' + d.inv.lines.length + ' صنف) — دوس «جديد» لو عاوز تبدأ من الأول'); } catch (_) {} }, 400); }
        return { id: null, inv: d.inv, grp: type, ...(d.recv ? { recv: 1 } : {}) };
      }
    } catch (_) {}
    return null;
  };

  // حفظ تلقائي أثناء الكتابة/الإضافة
  const trig = () => { const e = edOf(); if (e && !e.id && e.inv && inEditor()) window.edSaveDraft(); };
  ['input', 'change', 'click', 'keyup'].forEach(ev => document.addEventListener(ev, trig, true));
  setInterval(() => { const e = edOf(); if (e && !e.id && e.inv && inEditor()) doSave(); }, 5000);
})();
