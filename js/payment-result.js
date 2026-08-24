(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var token = params.get('token');
  var title = document.getElementById('result-title');
  var text = document.getElementById('result-text');
  var box = document.getElementById('result-code');
  var download = document.getElementById('result-download');
  var value = box.querySelector('span');
  var button = box.querySelector('button');
  var attempt = 0;

  function showCode(code) { value.textContent = code; box.hidden = false; }
  function check() {
    fetch('/api/payments/status?token=' + encodeURIComponent(token || ''))
      .then(function (response) { return response.json().then(function (body) { if (!response.ok) throw new Error(body.error); return body; }); })
      .then(function (order) {
        if (order.status === 'succeeded' && String(order.productKind).indexOf('cell_print_') === 0 && order.licenseKey) {
          title.textContent = 'Покупка готова';
          text.textContent = 'Ключ действует ' + order.durationDays + ' дней для ' + order.deviceLimit + ' устройств. Срок начнётся при первой активации.';
          showCode(order.licenseKey);
          if (order.downloadUrl) { download.href = order.downloadUrl; download.hidden = false; }
          return;
        }
        if (order.status === 'succeeded' && order.productKind === 'program' && order.downloadUrl) {
          title.textContent = 'Оплата прошла'; text.textContent = 'Установщик программы готов к скачиванию.';
          download.href = order.downloadUrl; download.hidden = false; return;
        }
        if (order.status === 'succeeded' && order.productKind === 'program_license' && order.licenseKey) {
          title.textContent = 'Ключ готов'; text.textContent = 'Ключ на ' + order.licenseIterations + ' итераций. Скопируйте и активируйте его в программе.';
          showCode(order.licenseKey); return;
        }
        if (order.status === 'succeeded' && order.accessCode) {
          title.textContent = 'Оплата прошла';
          text.textContent = 'Код сохранён в этом браузере. Лимиты: ' + order.rangeQuantity + ' возвратных и ' + order.customQuantity + ' QR по номеру.';
          showCode(order.accessCode);
          try {
            localStorage.setItem('sticker_access_code', order.accessCode);
            localStorage.setItem('sticker_access_limits', JSON.stringify({range:order.rangeQuantity,custom:order.customQuantity}));
            localStorage.setItem('sticker_purchased_package', JSON.stringify({code:order.accessCode,target:order.stickerTarget||'product',rangeTotal:order.rangeQuantity,customTotal:order.customQuantity,purchasedAt:new Date().toISOString()}));
          } catch (_error) {}
          return;
        }
        if (order.status === 'canceled') { title.textContent = 'Платёж отменён'; text.textContent = 'Деньги не списаны. Вы можете создать новый заказ.'; return; }
        title.textContent = 'Ожидаем подтверждения оплаты'; text.textContent = 'Страница обновится автоматически.';
        if (attempt++ < 20) setTimeout(check, 3000);
      })
      .catch(function (reason) { title.textContent = 'Не удалось проверить платёж'; text.textContent = reason.message; });
  }
  button.onclick = function () { if (navigator.clipboard) navigator.clipboard.writeText(value.textContent); };
  check();
})();
