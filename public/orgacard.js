/* ميزان — إضافة/تعديل كارت صنف من جوه صفحة المشتريات.
   - ocQuickCard(inv, seed): مودال لإضافة صنف جديد (اسم/كود ماستر/تكلفة/مستهلك).
     بيعمل كارت محلي في ميزان (يتضاف للفاتورة فورًا) + يبعته لأورجا للتكويد (لو صلاحية الكتابة متاحة).
   - ocEditLine(i): تعديل كارت صنف سطر في الفاتورة (الاسم/المستهلك/التكلفة) محليًا + في أورجا. */
(function () {
  const numIn = window.numIn || (v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, '')); return isFinite(n) ? n : 0; });
  const esc2 = window.esc || (s => String(s == null ? '' : s));

  function form(opts) {
    return `<h2 style="margin:0 0 12px">${opts.title}</h2>
      <div class="grid g2" style="gap:10px">
        <label class="f" style="grid-column:1/-1">اسم الصنف *<input class="in" id="ocf_name" value="${esc2(opts.name || '')}" placeholder="اسم الصنف بالعربي"></label>
        ${opts.showMaster ? `<label class="f">كود ماستر (اختياري)<input class="in" id="ocf_master" value="${esc2(opts.master || '')}" placeholder="كود المورد/الماستر"></label>` : ''}
        <label class="f">التكلفة<input class="in n" id="ocf_cost" inputmode="decimal" value="${opts.cost != null && opts.cost !== '' ? esc2(opts.cost) : ''}" placeholder="0"></label>
        <label class="f">سعر المستهلك<input class="in n" id="ocf_cons" inputmode="decimal" value="${opts.cons != null && opts.cons !== '' ? esc2(opts.cons) : ''}" placeholder="0"></label>
      </div>
      <p class="small muted" style="margin:10px 0 0">${opts.hint || ''}</p>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:14px">
        <button class="btn s" id="ocf_cancel">إلغاء</button>
        <button class="btn p" id="ocf_save">${opts.save || 'حفظ'}</button>
      </div>`;
  }

  // إضافة كارت صنف جديد من صفحة المشتريات
  window.ocQuickCard = function (inv, seed) {
    inv = inv || (window.ED && ED.inv); if (!inv) return;
    const canOrga = (typeof canOrgaWrite === 'function') && canOrgaWrite();
    modal(form({
      title: 'كارت صنف جديد',
      name: (seed && String(seed).replace(/[\u0000-\u001f]/g, '').trim()) || '',
      showMaster: true,
      hint: canOrga ? 'هيتعمل كارت في ميزان ويتضاف للفاتورة فورًا، ويتبعت لأورجا للتكويد (الكود هيظهر بعد ما الوكيل يكوّده ويتزامن).' : 'هيتعمل كارت في ميزان ويتضاف للفاتورة. (تكويد أورجا محتاج صلاحية الكتابة لأورجا.)',
      save: 'إضافة الصنف'
    }));
    $('#ocf_cancel').onclick = closeModal;
    $('#ocf_save').onclick = async () => {
      const name = String($('#ocf_name').value || '').trim().slice(0, 50);
      if (!name) { toast('اكتب اسم الصنف', 'err'); return; }
      const master = String(($('#ocf_master') || {}).value || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 25);
      const cost = numIn($('#ocf_cost').value);
      const cons = numIn($('#ocf_cons').value);
      // منع التكرار محليًا بنفس الكود
      if (master && L('products').some(p => String(p.code || '') === master)) { toast('كود الماستر ده موجود في ميزان', 'err'); return; }
      const id = uid();
      const prod = { name, code: master || '', barcode: '', group: '', unit: '', cost: cost || 0, consumer: cons || 0, price: cons || 0, createdAt: new Date().toISOString(), createdBy: (S.me && S.me.id) || '' };
      try { await put('products', id, prod); } catch (e) { toast('تعذّر حفظ الصنف', 'err'); return; }
      // تكويد في أورجا
      if (canOrga) {
        try {
          const r = await MZ.post('/api/orga/products/add', { items: [{ ref: id, name, master, cons, cost }] });
          if (r && r.queued) toast('«' + name + '» اتضاف — وبيتكوّد في أورجا دلوقتي');
          else toast('«' + name + '» اتضاف في ميزان');
        } catch (e) { toast('«' + name + '» اتضاف في ميزان (تكويد أورجا فشل: ' + (e && e.message || e) + ')', 'err'); }
      } else toast('«' + name + '» اتضاف في ميزان');
      closeModal();
      addLine(id);
    };
  };

  // تعديل كارت صنف سطر في الفاتورة
  window.ocEditLine = function (i) {
    const inv = window.ED && ED.inv; if (!inv || !inv.lines[i]) return;
    const pid = inv.lines[i].pid; const p = G('products', pid); if (!p) return;
    window.ocEditCard(pid);
  };

  // تعديل كارت صنف بالـ id المحلي
  window.ocEditCard = function (pid) {
    const p = G('products', pid); if (!p) { toast('الصنف مش موجود', 'err'); return; }
    const canOrga = (typeof canOrgaWrite === 'function') && canOrgaWrite();
    const hasOrga = +p.orga > 0;
    modal(form({
      title: 'تعديل كارت الصنف' + (hasOrga ? ' — كود أورجا ' + p.orga : ''),
      name: p.name || '', showMaster: false,
      cost: (p.cost != null ? p.cost : ''), cons: (consOf ? consOf(p) : (p.consumer || p.price || '')),
      hint: !canOrga ? 'التعديل هيتحفظ في ميزان بس.' : hasOrga ? 'التعديل هيتحفظ في ميزان ويتبعت لأورجا.' : 'الصنف ده لسه ماتزامنش من أورجا (مفيش كود أورجا) — التعديل في ميزان بس.',
      save: 'حفظ التعديل'
    }));
    $('#ocf_cancel').onclick = closeModal;
    $('#ocf_save').onclick = async () => {
      const name = String($('#ocf_name').value || '').trim().slice(0, 50);
      if (!name) { toast('اكتب اسم الصنف', 'err'); return; }
      const cost = numIn($('#ocf_cost').value);
      const cons = numIn($('#ocf_cons').value);
      const n = { ...p, name };
      if ($('#ocf_cost').value !== '') n.cost = cost;
      if ($('#ocf_cons').value !== '') { n.consumer = cons; n.price = cons; }
      try { await put('products', pid, n); } catch (e) { toast('تعذّر حفظ التعديل', 'err'); return; }
      if (canOrga && hasOrga) {
        const prices = {};
        if ($('#ocf_cons').value !== '') prices.CONSUMER = cons;
        if ($('#ocf_cost').value !== '') { prices.PRIC_COST = cost; prices.COST_AV = cost; }
        const item = { prod: +p.orga, name };
        if (Object.keys(prices).length) item.prices = prices;
        try { const r = await MZ.post('/api/orga/products/edit', { items: [item] }); if (r && r.queued) toast('اتعدّل — وبيتبعت لأورجا'); else toast('اتعدّل في ميزان'); }
        catch (e) { toast('اتعدّل في ميزان (أورجا فشل: ' + (e && e.message || e) + ')', 'err'); }
      } else toast('تم تعديل الصنف');
      closeModal();
      render();
    };
  };
})();
