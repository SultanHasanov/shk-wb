(function () {
  'use strict';
  var base = '/api/admin/data?resource=stickerPool';
  var current = document.getElementById('sticker-pool-current');
  if (!current) return;
  var available = document.getElementById('sticker-pool-available');
  var used = document.getElementById('sticker-pool-used');
  var start = document.getElementById('sticker-pool-start');
  var end = document.getElementById('sticker-pool-end');
  var save = document.getElementById('sticker-pool-save');
  var refresh = document.getElementById('sticker-pool-refresh');
  var message = document.getElementById('sticker-pool-message');
  var rows = document.getElementById('sticker-pool-used-rows');
  var prev = document.getElementById('sticker-pool-prev');
  var next = document.getElementById('sticker-pool-next');
  var pageText = document.getElementById('sticker-pool-page');
  var page = 0;

  function number(value) { return Number(value || 0).toLocaleString('ru-RU'); }
  function date(value) { return value ? new Date(value).toLocaleString('ru-RU') : '—'; }
  function load() {
    message.textContent = 'Загрузка…';
    fetch(base + '&page=' + page).then(function (response) {
      if (!response.ok) throw new Error('Не удалось загрузить диапазон');
      return response.json();
    }).then(function (data) {
      current.textContent = data.start && data.end ? data.start + ' — ' + data.end : 'Нет свободных номеров';
      available.textContent = number(data.available);
      used.textContent = number(data.used);
      var pages = Math.max(1, Math.ceil(data.used / data.pageSize));
      pageText.textContent = 'Страница ' + (data.page + 1) + ' из ' + pages;
      prev.disabled = data.page <= 0;
      next.disabled = data.page + 1 >= pages;
      if (data.start) start.value = data.start;
      if (data.end) end.value = data.end;
      rows.innerHTML = '';
      if (!data.recentUsed.length) rows.innerHTML = '<tr><td colspan="3">Использованных номеров пока нет</td></tr>';
      data.recentUsed.forEach(function (item) {
        var tr = document.createElement('tr');
        [item.code, date(item.allocatedAt), item.batchId].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value || '—'; tr.appendChild(td);
        });
        rows.appendChild(tr);
      });
      message.textContent = '';
    }).catch(function (error) { message.textContent = error.message; message.className = 'admin-message error'; });
  }

  save.onclick = function () {
    var first = start.value.trim(), last = end.value.trim();
    if (!/^\d{1,12}$/.test(first) || !/^\d{1,12}$/.test(last)) {
      message.textContent = 'Введите начало и конец диапазона цифрами.'; message.className = 'admin-message error'; return;
    }
    var count = BigInt(last) - BigInt(first) + 1n;
    if (count < 1n || count > 100001n) {
      message.textContent = 'В диапазоне должно быть от 1 до 100 001 номера.'; message.className = 'admin-message error'; return;
    }
    if (!confirm('Заменить свободный пул диапазоном ' + first + ' — ' + last + '? Использованные номера сохранятся.')) return;
    save.disabled = true; message.className = 'admin-message'; message.textContent = 'Применяем новый диапазон…';
    fetch(base, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({start:first,end:last}) })
      .then(function (response) { return response.json().then(function (body) { if (!response.ok) throw new Error(body.error || 'Ошибка изменения диапазона'); return body; }); })
      .then(function () { message.textContent = 'Новый диапазон применён.'; load(); })
      .catch(function (error) { message.className = 'admin-message error'; message.textContent = error.message; })
      .then(function () { save.disabled = false; });
  };
  refresh.onclick = load;
  prev.onclick = function () { if (page > 0) { page -= 1; load(); } };
  next.onclick = function () { page += 1; load(); };
  var app = document.getElementById('admin-app');
  new MutationObserver(function () { if (!app.hidden) load(); }).observe(app, {attributes:true, attributeFilter:['hidden']});
})();
