/* ميزان — المسح بكاميرا الموبايل في كل خانات الباركود
   - BarcodeDetector الأصلي لو المتصفح فيه (أندرويد كروم)، وإلا polyfill (ZXing) متخزن على السيرفر نفسه — يشتغل على آيفون كمان
   - زرار 📷 بيتضاف لوحده جنب خانات المسح (الفاتورة، متابعة الأوردرات، ...) على الأجهزة اللي فيها كاميرا */
(function () {
  'use strict';
  try {
    if (window.BarcodeDetectionAPI && window.BarcodeDetectionAPI.prepareZXingModule) {
      window.BarcodeDetectionAPI.prepareZXingModule({ overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? '/vendor/barcode/' + p : prefix + p) } });
    }
  } catch (e) {}
  const hasCam = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && 'BarcodeDetector' in window;
  const touch = () => matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  // الخانات اللي بتاخد باركود + Enter
  const TARGETS = ['#ps', '#flI'];
  function feed(sel, val) {
    const el = document.querySelector(sel); if (!el) return false;
    el.focus(); el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return true;
  }
  function attach() {
    if (!hasCam() || !touch()) return;
    for (const sel of TARGETS) {
      const el = document.querySelector(sel);
      if (!el || el.dataset.cam || el.closest('.modal-x')) continue;
      el.dataset.cam = '1';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.textContent = '📷'; b.title = 'امسح بكاميرا الموبايل';
      b.style.cssText = 'flex:0 0 auto;font-size:18px;padding:6px 12px';
      b.onclick = e => {
        e.preventDefault();
        if (!window.MZ_PK || !MZ_PK.camScan) return;
        let lv = '', ls = 0;
        MZ_PK.camScan(v => { const now = Date.now(); const dup = v === lv && now - ls < 2500; lv = v; ls = now; if (dup) return '✓ ' + v + ' — شيل الكاميرا من عليه وامسح اللي بعده'; feed(sel, v); try { navigator.vibrate && navigator.vibrate(60); } catch (x) {} return '✓ ' + v + ' — امسح اللي بعده أو اقفل'; }, 'وجّه الكاميرا على الباركود');
      };
      const host = el.closest('.psearch') || el;
      host.insertAdjacentElement('afterend', b);
      const p = host.parentElement; if (p && getComputedStyle(p).display !== 'flex') { p.style.display = 'flex'; p.style.gap = '6px'; p.style.alignItems = 'center'; }
    }
  }
  const mo = new MutationObserver(() => { clearTimeout(attach.t); attach.t = setTimeout(attach, 60); });
  const start = () => { const v = document.getElementById('view'); if (v) mo.observe(v, { childList: true, subtree: true }); attach(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.MZ_SCAN = { attach, hasCam };
})();
