// Счётчик посещений на базе mokky.dev (mock REST API)
(function () {
  var API = 'https://5f517982e1d5a6b7.mokky.dev/items/1';
  var el = document.getElementById('visit-count');

  function render(n) {
    if (el) el.textContent = (n == null ? '—' : Number(n).toLocaleString('ru-RU'));
  }

  // Считаем визит один раз за сессию вкладки, чтобы перезагрузки не накручивали.
  var alreadyCounted = sessionStorage.getItem('wb_visit_counted') === '1';

  fetch(API)
    .then(function (r) { return r.json(); })
    .then(function (item) {
      var current = (item && typeof item.count === 'number') ? item.count : 0;

      if (alreadyCounted) {
        render(current);
        return;
      }

      var next = current + 1;
      return fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: next })
      })
        .then(function (r) { return r.json(); })
        .then(function (updated) {
          sessionStorage.setItem('wb_visit_counted', '1');
          render(updated && typeof updated.count === 'number' ? updated.count : next);
        });
    })
    .catch(function () { render(null); });
})();
