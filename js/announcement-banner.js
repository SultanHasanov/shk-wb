(function () {
  'use strict';
  var banner = document.getElementById('site-announcement');
  if (!banner) return;
  var text = document.getElementById('site-announcement-text');
  var link = document.getElementById('site-announcement-link');
  var previewText = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? new URLSearchParams(location.search).get('previewAnnouncement') : '';
  document.getElementById('site-announcement-close').addEventListener('click', function () { banner.hidden = true; });
  if (previewText) {
    text.textContent = previewText;
    link.href = '#'; link.textContent = 'Подробнее'; link.hidden = false;
    banner.hidden = false;
    return;
  }
  fetch('/api/messages?surface=site').then(function (response) {
    if (!response.ok) throw new Error('announcement request failed');
    return response.json();
  }).then(function (items) {
    var item = Array.isArray(items) && items[0];
    if (!item || !item.text) return;
    text.textContent = item.text;
    if (item.url && /^https?:\/\//i.test(item.url)) {
      link.href = item.url; link.textContent = item.button || 'Подробнее'; link.hidden = false;
      link.target = '_blank'; link.rel = 'noopener';
    }
    banner.hidden = false;
  }).catch(function () {});
})();
