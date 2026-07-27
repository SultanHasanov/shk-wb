// Счётчик посещений на базе mokky.dev (mock REST API)
// Считаем ОТКРЫТИЕ сайта (не обновление):
//   1) общий счётчик visits (id=1)
//   2) личный счётчик каждого клиента: сколько раз он открывал сайт
(function () {
  var BASE = '/api/visits';
  var el = document.getElementById('visit-count');

  function render(n) {
    if (el) el.textContent = (n == null ? '—' : Number(n).toLocaleString('ru-RU'));
  }

  // Постоянный id клиента (живёт в браузере между визитами)
  var visitorId = localStorage.getItem('wb_visitor_id');
  if (!visitorId) {
    visitorId = 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('wb_visitor_id', visitorId);
  }

  // Открытие вкладки = новая сессия. Обновление (F5) сессию сохраняет → не считаем.
  var alreadyOpened = sessionStorage.getItem('wb_visit_counted') === '1';
  sessionStorage.setItem('wb_visit_counted', '1');

  fetch(BASE, alreadyOpened ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId: visitorId })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) { render(data && data.count); })
    .catch(function () { render(null); });
})();
