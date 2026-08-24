(function () {
  'use strict';

  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');

  if (toggle && nav) {
    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) nav.setAttribute('data-open', 'true');
      else nav.removeAttribute('data-open');
    };

    toggle.addEventListener('click', function (event) {
      event.stopPropagation();
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });

    document.addEventListener('click', function (event) {
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      if (!event.target.closest('.topbar')) setOpen(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      setOpen(false);
      toggle.focus();
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 760) setOpen(false);
    });
  }

  /* «Назад» возвращает на предыдущую страницу сайта, иначе ведёт по href */
  var back = document.querySelector('[data-back]');
  if (back) {
    back.addEventListener('click', function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      var from = document.referrer;
      if (!from || history.length < 2) return;
      var sameSite = false;
      try { sameSite = new URL(from).origin === location.origin; } catch (e) {}
      if (!sameSite) return;
      event.preventDefault();
      history.back();
    });
  }
})();
