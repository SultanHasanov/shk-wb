(function () {
  'use strict';
  var nav = document.querySelector('.admin-nav');
  if (!nav) return;
  var preview = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).get('preview') === '1';
  if (preview) {
    var adminRoot = document.getElementById('admin');
    var login = document.getElementById('admin-login');
    var app = document.getElementById('admin-app');
    if (adminRoot) adminRoot.hidden = false;
    if (login) login.hidden = true;
    if (app) app.hidden = false;
  }
  var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
  var sections = links.map(function (link) { return document.querySelector(link.getAttribute('href')); }).filter(Boolean);
  function show(id, updateHash) {
    if (!document.getElementById(id)) id = sections[0] && sections[0].id;
    sections.forEach(function (section) { section.hidden = section.id !== id; });
    links.forEach(function (link) {
      var active = link.getAttribute('href') === '#' + id;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    if (updateHash && history.replaceState) history.replaceState(null, '', '#' + id);
  }
  links.forEach(function (link) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      show(link.getAttribute('href').slice(1), true);
    });
  });
  show(location.hash.slice(1) || 'pool-section', false);
})();
