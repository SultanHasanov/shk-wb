// Счётчик посещений на базе mokky.dev (mock REST API)
// Считаем ОТКРЫТИЕ сайта (не обновление):
//   1) общий счётчик visits (id=1)
//   2) личный счётчик каждого клиента: сколько раз он открывал сайт
(function () {
  var BASE = 'https://5f517982e1d5a6b7.mokky.dev/items';
  var TOTAL = BASE + '/1';
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

  // --- 1. Общий счётчик ---
  function bumpTotal() {
    return fetch(TOTAL)
      .then(function (r) { return r.json(); })
      .then(function (item) {
        var current = (item && typeof item.count === 'number') ? item.count : 0;
        if (alreadyOpened) { render(current); return; }
        return fetch(TOTAL, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: current + 1 })
        })
          .then(function (r) { return r.json(); })
          .then(function (u) {
            render(u && typeof u.count === 'number' ? u.count : current + 1);
          });
      })
      .catch(function () { render(null); });
  }

  // --- 2. Личный счётчик клиента ---
  function bumpVisitor() {
    if (alreadyOpened) return;
    return fetch(BASE + '?visitorId=' + encodeURIComponent(visitorId))
      .then(function (r) { return r.json(); })
      .then(function (list) {
        var rec = Array.isArray(list) && list.length ? list[0] : null;
        var nowIso = new Date().toISOString();
        if (rec) {
          return fetch(BASE + '/' + rec.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count: (rec.count || 0) + 1, lastVisit: nowIso })
          });
        }
        return fetch(BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'visitor',
            visitorId: visitorId,
            count: 1,
            firstVisit: nowIso,
            lastVisit: nowIso
          })
        });
      })
      .catch(function () { /* не критично */ });
  }

  Promise.resolve().then(bumpTotal).then(bumpVisitor);
})();
