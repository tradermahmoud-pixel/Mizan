/* ميزان — تصدير/مشاركة الفاتورة PDF من الموبايل.
   يطلّع نسخة واحدة A4 من الفاتورة كـ PDF، ويفتح مشاركة الموبايل (واتساب/حفظ/طباعة).
   بيحمّل html2canvas + jsPDF أول مرة فقط عند الحاجة. */
(function () {
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
      document.head.appendChild(s);
    });
  }
  async function ensureLibs() {
    if (window.html2canvas && window.jspdf) return true;
    try {
      if (window.toast) toast('بيحمّل أدوات الـPDF…');
      if (!window.html2canvas) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
      if (!window.jspdf) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    } catch (e) { return false; }
    return !!(window.html2canvas && window.jspdf);
  }

  async function invoiceShare(id, opt) {
    opt = opt || {};
    const inv = typeof id === 'object' ? id : G('invoices', id);
    if (!inv) { toast('الفاتورة غير موجودة', 'err'); return; }
    if (typeof invBodyHTML !== 'function') { toast('مش قادر أجهّز الفاتورة', 'err'); return; }
    const ok = await ensureLibs();
    if (!ok) { toast('مش قادر أحمّل أدوات الـPDF — تأكد من النت وجرّب تاني', 'err'); return; }

    const fam = getComputedStyle(document.body).fontFamily || 'Tahoma, Arial, sans-serif';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff;z-index:-1;pointer-events:none';
    wrap.innerHTML =
      '<style>#pdfx{background:#fff;color:#000;padding:26px;font-family:' + fam + ';direction:rtl;font-size:13px;line-height:1.5}'
      + '#pdfx *{color:#000;box-sizing:border-box}'
      + '#pdfx table{width:100%;border-collapse:collapse;margin:6px 0}'
      + '#pdfx th,#pdfx td{border:1px solid #999;padding:5px;text-align:right}'
      + '#pdfx h2{font-size:18px;margin:0}#pdfx p{margin:4px 0}</style>'
      + '<div id="pdfx">' + invBodyHTML(inv, opt.label || '') + '</div>';
    document.body.appendChild(wrap);
    try { window.MZ_RV_bc && MZ_RV_bc(wrap); } catch (e) {}

    try {
      const node = wrap.querySelector('#pdfx');
      const canvas = await html2canvas(node, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pw = 210, ph = 297, margin = 8;
      const iw = pw - margin * 2;
      const pxPerMM = canvas.width / iw;
      const fullH = canvas.height / pxPerMM; // mm
      if (fullH <= ph - margin * 2 + 0.5) {
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, iw, fullH);
      } else {
        const pageMM = ph - margin * 2;
        const pagePx = Math.floor(pageMM * pxPerMM);
        let y = 0, page = 0;
        while (y < canvas.height) {
          const h = Math.min(pagePx, canvas.height - y);
          const slice = document.createElement('canvas');
          slice.width = canvas.width; slice.height = h;
          const ctx = slice.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, slice.width, slice.height);
          ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
          if (page > 0) pdf.addPage();
          pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, iw, h / pxPerMM);
          y += h; page++;
        }
      }
      const base = 'فاتورة-' + (inv.no != null ? inv.no : '') + '-' + (inv.date || today());
      const fname = base.replace(/[\\/:*?"<>|]/g, '-') + '.pdf';
      const blob = pdf.output('blob');

      const file = new File([blob], fname, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: fname }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; /* else fall through to download */ }
      }
      // تحميل كبديل
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('اتحفظ الـPDF — تقدر تبعته واتساب أو تطبعه', 'ok');
    } catch (e) {
      toast('حصل خطأ وانا بعمل الـPDF — جرّب الطباعة العادية', 'err');
    } finally {
      wrap.remove();
    }
  }

  window.invoiceShare = invoiceShare;
})();
