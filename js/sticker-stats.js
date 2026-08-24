(function () {
  'use strict';

  var returnCount = document.getElementById('return-sticker-count');
  var customCount = document.getElementById('custom-sticker-count');
  if (!returnCount || !customCount) return;

  function format(value) {
    return Number(value).toLocaleString('ru-RU');
  }

  function refresh() {
    return fetch('/api/sticker-stats', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('Statistics request failed');
        return response.json();
      })
      .then(function (stats) {
        returnCount.textContent = format(stats.returnStickers);
        customCount.textContent = format(stats.customStickers);
      })
      .catch(function () {
        // Keep the last successfully loaded values (or the initial placeholders).
      });
  }

  window.addEventListener('sticker:generated', refresh);
  refresh();
  window.setInterval(refresh, 30000);
})();
