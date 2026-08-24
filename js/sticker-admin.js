(function () {
  'use strict';
  var base = '/api/admin/data?resource=stickerAccess';
  var nameInput = document.getElementById('sticker-key-name');
  var createButton = document.getElementById('sticker-key-create');
  var rangeLimitInput = document.getElementById('sticker-key-range-limit');
  var customLimitInput = document.getElementById('sticker-key-custom-limit');
  var boxRangeLimitInput=document.getElementById('sticker-key-box-range-limit'),boxCustomLimitInput=document.getElementById('sticker-key-box-custom-limit');
  var refreshButton = document.getElementById('sticker-key-refresh');
  var output = document.getElementById('sticker-key-output');
  var outputValue = document.getElementById('sticker-key-value');
  var copyButton = document.getElementById('sticker-key-copy');
  var rows = document.getElementById('sticker-key-rows');
  var dialog = document.getElementById('sticker-key-dialog');
  var editId = document.getElementById('sticker-edit-id');
  var editName = document.getElementById('sticker-edit-name');
  var editRange = document.getElementById('sticker-edit-range');
  var editCustom = document.getElementById('sticker-edit-custom');
  var editBoxRange=document.getElementById('sticker-edit-box-range'),editBoxCustom=document.getElementById('sticker-edit-box-custom');
  var editInfo = document.getElementById('sticker-edit-info');
  var editSave = document.getElementById('sticker-edit-save');
  var editingItem = null;
  if (!nameInput) return;

  function load() {
    rows.innerHTML = '<tr><td colspan="8">Загрузка…</td></tr>';
    fetch(base).then(function (response) {
      if (!response.ok) throw new Error();
      return response.json();
    }).then(function (list) {
      rows.innerHTML = '';
      if (!list.length) rows.innerHTML = '<tr><td colspan="8">Кодов пока нет</td></tr>';
      list.forEach(function (item) {
        var tr = document.createElement('tr');
        [item.code, item.name, item.rangeUsed + ' / ' + item.rangeLimit,
          item.customUsed + ' / ' + item.customLimit,
          item.boxRangeUsed+' / '+item.boxRangeLimit,item.boxCustomUsed+' / '+item.boxCustomLimit,
          item.active ? 'активен' : 'отключён'].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
        });
        var actions = document.createElement('td');
        var edit = document.createElement('button');
        edit.className = 'btn admin-mini-btn'; edit.textContent = 'Изменить';
        edit.onclick = function () {
          editingItem = item; editId.value = item.id; editName.value = item.name;
          editRange.value = item.rangeLimit; editCustom.value = item.customLimit;
          editBoxRange.value=item.boxRangeLimit;editBoxCustom.value=item.boxCustomLimit;
          editInfo.textContent = 'Использовано: товары '+item.rangeUsed+' / '+item.customUsed+', коробки '+item.boxRangeUsed+' / '+item.boxCustomUsed+'.';
          dialog.showModal();
        };
        var toggle = document.createElement('button');
        toggle.className = 'btn admin-mini-btn'; toggle.textContent = item.active ? 'Отключить' : 'Включить';
        toggle.onclick = function () { fetch(base + '&id=' + item.id, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({active:!item.active}) }).then(load); };
        var remove = document.createElement('button');
        remove.className = 'btn admin-mini-btn'; remove.textContent = 'Удалить';
        remove.onclick = function () { if (confirm('Удалить код ' + item.code + '?')) fetch(base + '&id=' + item.id, {method:'DELETE'}).then(load); };
        actions.appendChild(edit); actions.appendChild(toggle); actions.appendChild(remove); tr.appendChild(actions); rows.appendChild(tr);
      });
    }).catch(function () { rows.innerHTML = '<tr><td colspan="8">Ошибка загрузки</td></tr>'; });
  }

  createButton.onclick = function () {
    var name = nameInput.value.trim();
    var rangeLimit = Number(rangeLimitInput.value);
    var customLimit = Number(customLimitInput.value);
    var boxRangeLimit=Number(boxRangeLimitInput.value),boxCustomLimit=Number(boxCustomLimitInput.value);
    if (!name) { alert('Введите имя'); return; }
    if (!Number.isInteger(rangeLimit) || rangeLimit < 0 || !Number.isInteger(customLimit) || customLimit < 0) {
      alert('Укажите корректные лимиты'); return;
    }
    createButton.disabled = true;
    fetch(base, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:name,rangeLimit:rangeLimit,customLimit:customLimit,boxRangeLimit:boxRangeLimit,boxCustomLimit:boxCustomLimit}) })
      .then(function (response) { if (!response.ok) throw new Error(); return response.json(); })
      .then(function (item) { outputValue.textContent=item.code; output.hidden=false; nameInput.value=''; load(); })
      .catch(function () { alert('Не удалось создать код'); })
      .then(function () { createButton.disabled=false; });
  };
  refreshButton.onclick = load;
  copyButton.onclick = function () { navigator.clipboard && navigator.clipboard.writeText(outputValue.textContent); };
  editSave.onclick = function (event) {
    event.preventDefault();
    if (!editingItem) return;
    var body = { name:editName.value.trim(), rangeLimit:Number(editRange.value), customLimit:Number(editCustom.value),boxRangeLimit:Number(editBoxRange.value),boxCustomLimit:Number(editBoxCustom.value) };
    if (!body.name || !Number.isInteger(body.rangeLimit) || !Number.isInteger(body.customLimit)) { alert('Проверьте имя и лимиты'); return; }
    editSave.disabled = true;
    fetch(base + '&id=' + encodeURIComponent(editId.value), { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })
      .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.error || 'Ошибка изменения'); }); })
      .then(function () { dialog.close(); load(); })
      .catch(function (error) { alert(error.message); })
      .then(function () { editSave.disabled = false; });
  };
  var app = document.getElementById('admin-app');
  new MutationObserver(function () { if (!app.hidden) load(); }).observe(app, {attributes:true, attributeFilter:['hidden']});
})();
