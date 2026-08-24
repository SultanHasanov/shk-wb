(function () {
  var button = document.getElementById('stats-refresh-btn');
  var rows = document.getElementById('stats-rows');
  var siteTotal = document.getElementById('stats-site-total');
  var uniqueTotal = document.getElementById('stats-unique-total');
  var appTotal = document.getElementById('stats-app-total');
  var adminApp = document.getElementById('admin-app');

  if (!button || !rows || !uniqueTotal) return;

  function number(value) {
    return Number(value || 0).toLocaleString('ru-RU');
  }

  function date(value) {
    var parts = String(value || '').split('-');
    return parts.length === 3 ? parts[2] + '.' + parts[1] + '.' + parts[0] : value;
  }

  function cell(value) {
    var node = document.createElement('td');
    node.textContent = value;
    return node;
  }

  function load() {
    rows.innerHTML = '<tr><td colspan="4">Загрузка…</td></tr>';
    fetch('/api/admin/stats').then(function (response) {
      if (!response.ok) throw new Error('stats failed');
      return response.json();
    }).then(function (data) {
      var totals = data.totals || {};
      siteTotal.textContent = number(totals.siteVisits);
      uniqueTotal.textContent = number(totals.uniqueVisitors);
      appTotal.textContent = number(totals.appLaunches);
      var days = Array.isArray(data.days) ? data.days : [];
      rows.innerHTML = '';
      if (!days.length) {
        rows.innerHTML = '<tr><td colspan="4">Данных пока нет</td></tr>';
        return;
      }
      days.forEach(function (item) {
        var row = document.createElement('tr');
        row.appendChild(cell(date(item.day)));
        row.appendChild(cell(number(item.siteVisits)));
        row.appendChild(cell(number(item.uniqueVisitors)));
        row.appendChild(cell(number(item.appLaunches)));
        rows.appendChild(row);
      });
    }).catch(function () {
      rows.innerHTML = '<tr><td colspan="4">Ошибка загрузки</td></tr>';
    });
  }

  button.addEventListener('click', function (event) {
    event.stopImmediatePropagation();
    load();
  }, true);

  if (adminApp) {
    new MutationObserver(function () {
      if (!adminApp.hidden) load();
    }).observe(adminApp, { attributes: true, attributeFilter: ['hidden'] });
    if (!adminApp.hidden) load();
  }
})();
