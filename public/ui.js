/* ميزان — طبقة الحركة: انتقال خفيف عند تغيير الشاشة، وحركة دخول واحدة للوحة الرئيسية
   (الأرقام بتعدّ والأعمدة بتطلع). مابتشتغلش مع إعادة الرسم التلقائية من المزامنة. */
(function () {
  'use strict';
  if (typeof render_ !== 'function') return;
  const reduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let last = null, t = null;
  const orig = render_;
  render_ = function () {
    const p = route().p; const changed = p !== last; last = p;
    orig.apply(this, arguments);
    if (changed) enter(p);
  };
  function enter(p) {
    const v = document.getElementById('view'); if (!v || reduce()) return;
    clearTimeout(t); v.classList.remove('enter', 'dash'); void v.offsetWidth;
    v.classList.add('enter'); if (p === 'dash' && v.querySelector('.strip')) { v.classList.add('dash'); dashIntro(v); }
    t = setTimeout(() => v.classList.remove('enter', 'dash'), 1300);
  }
  function dashIntro(v) {
    v.querySelectorAll('.bars .b').forEach((b, i) => { const c = b.querySelector('.col'); if (c) c.style.animationDelay = (0.15 + i * 0.035) + 's'; });
    v.querySelectorAll('.strip .v').forEach((el, i) => {
      const txt = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild.nodeValue : el.textContent;
      const m = /^\s*(-?[\d,]+(?:\.(\d+))?)\s*$/.exec(txt || ''); if (!m) return;
      const target = parseFloat(m[1].replace(/,/g, '')); if (!isFinite(target) || Math.abs(target) < 1) return;
      const dec = m[2] ? m[2].length : 0; const node = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : null; if (!node) return;
      const f = n => n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      const t0 = performance.now() + i * 60, D = 900;
      const step = now => {
        if (!node.isConnected) return;
        const k = Math.min(1, Math.max(0, (now - t0) / D)); const e = 1 - Math.pow(1 - k, 3);
        node.nodeValue = f(target * e); if (k < 1) requestAnimationFrame(step); else node.nodeValue = txt;
      };
      node.nodeValue = f(0); requestAnimationFrame(step);
    });
  }
})();
