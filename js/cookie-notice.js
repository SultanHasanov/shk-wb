(function () {
  'use strict';
  var KEY = 'wb_cookie_notice_ok';
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}
  if (stored === '1') return;

  function build() {
    if (!document.body) return;
    var box = document.createElement('div');
    box.className = 'cookie-notice';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Уведомление о файлах cookie');

    var text = document.createElement('p');
    text.className = 'cookie-notice-text';
    text.appendChild(document.createTextNode('Мы используем файлы cookie, чтобы сайт работал лучше и удобнее. Оставаясь на сайте, вы соглашаетесь с '));
    var link = document.createElement('a');
    link.href = '/privacy';
    link.textContent = 'условиями их использования';
    text.appendChild(link);
    text.appendChild(document.createTextNode('.'));

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary cookie-notice-btn';
    button.textContent = 'Понятно';
    button.addEventListener('click', function () {
      try { localStorage.setItem(KEY, '1'); } catch (e) {}
      box.parentNode.removeChild(box);
    });

    box.appendChild(text);
    box.appendChild(button);
    document.body.appendChild(box);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
