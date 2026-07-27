// Админка лицензионных ключей для «Подбор кодов».
// Доступ ограничен: секция показывается только при секретном хэше в URL
// и после ввода пароля. Это защита от обычных посетителей, не криптозащита.
(function () {
  // === НАСТРОЙКИ (можно менять) ===
  var SECRET_HASH = '#panel-2026';   // открывать админку: index.html#panel-2026
  var BASE = '/api/admin/data?resource=key';
  var MSG_BASE = '/api/admin/data?resource=message';

  var section = document.getElementById('admin');
  if (!section) return;

  // --- Гейт доступа ---
  if (window.location.hash !== SECRET_HASH) return; // обычные посетители не видят
  section.hidden = false;

  var loginScreen = document.getElementById('admin-login');
  var appScreen   = document.getElementById('admin-app');
  var passInput   = document.getElementById('admin-pass');
  var loginBtn    = document.getElementById('admin-login-btn');
  var loginErr    = document.getElementById('admin-login-err');

  function showApp() {
    loginScreen.hidden = true;
    appScreen.hidden = false;
    loadKeys();
    loadMessages();
  }

  function tryLogin() {
    loginBtn.disabled = true;
    loginErr.textContent = '';
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passInput.value })
    })
      .then(function (r) {
        if (!r.ok) throw new Error('login failed');
        passInput.value = '';
        showApp();
      })
      .catch(function () {
        loginErr.textContent = 'Неверный пароль';
      })
      .then(function () { loginBtn.disabled = false; });
  }
  loginBtn.addEventListener('click', tryLogin);
  passInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') tryLogin();
  });

  // --- Элементы управления ключами ---
  var limitInput  = document.getElementById('key-limit');
  var noteInput   = document.getElementById('key-note');
  var createBtn   = document.getElementById('key-create-btn');
  var outBox      = document.getElementById('key-out');
  var outValue    = document.getElementById('key-out-value');
  var copyBtn     = document.getElementById('key-copy-btn');
  var refreshBtn  = document.getElementById('key-refresh-btn');
  var tbody       = document.getElementById('key-rows');

  function generateKey() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    function group() {
      var s = '';
      for (var i = 0; i < 4; i++) {
        s += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return s;
    }
    return 'WBPK-' + group() + '-' + group() + '-' + group();
  }

  function createKey() {
    var limit = parseInt(limitInput.value, 10);
    if (!limit || limit < 1) { alert('Введите число итераций (>= 1)'); return; }
    var key = generateKey();
    createBtn.disabled = true;
    fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: key,
        limit: limit,
        used: 0,
        active: true,
        note: noteInput.value || '',
        createdAt: new Date().toISOString()
      })
    })
      .then(function (r) { return r.json(); })
      .then(function () {
        outValue.textContent = key;
        outBox.hidden = false;
        noteInput.value = '';
        loadKeys();
      })
      .catch(function () { alert('Ошибка создания ключа (нет связи с сервером).'); })
      .then(function () { createBtn.disabled = false; });
  }

  function loadKeys() {
    tbody.innerHTML = '<tr><td colspan="5">Загрузка…</td></tr>';
    fetch(BASE)
      .then(function (r) { return r.json(); })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) {
          tbody.innerHTML = '<tr><td colspan="5">Ключей нет</td></tr>';
          return;
        }
        tbody.innerHTML = '';
        list.forEach(renderRow);
      })
      .catch(function () {
        tbody.innerHTML = '<tr><td colspan="5">Ошибка загрузки</td></tr>';
      });
  }

  function renderRow(rec) {
    var tr = document.createElement('tr');

    var tdKey = document.createElement('td');
    tdKey.textContent = rec.key;
    tdKey.className = 'admin-key-cell';

    var tdUse = document.createElement('td');
    tdUse.textContent = (rec.used || 0) + ' / ' + rec.limit;

    var tdStatus = document.createElement('td');
    tdStatus.textContent = rec.active ? 'активен' : 'отозван';
    tdStatus.style.color = rec.active ? '#128c3e' : '#e23b3b';

    var tdNote = document.createElement('td');
    tdNote.textContent = rec.note || '';

    var tdActions = document.createElement('td');
    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn admin-mini-btn';
    toggleBtn.textContent = rec.active ? 'Отозвать' : 'Вернуть';
    toggleBtn.addEventListener('click', function () { toggleActive(rec.id, !rec.active); });

    var delBtn = document.createElement('button');
    delBtn.className = 'btn admin-mini-btn';
    delBtn.textContent = 'Удалить';
    delBtn.addEventListener('click', function () { deleteKey(rec.id, rec.key); });

    tdActions.appendChild(toggleBtn);
    tdActions.appendChild(delBtn);

    tr.appendChild(tdKey);
    tr.appendChild(tdUse);
    tr.appendChild(tdStatus);
    tr.appendChild(tdNote);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }

  function toggleActive(id, active) {
    fetch(BASE + '&id=' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: active })
    })
      .then(function () { loadKeys(); })
      .catch(function () { alert('Ошибка изменения (нет связи).'); });
  }

  function deleteKey(id, key) {
    if (!confirm('Удалить ключ ' + key + '?')) return;
    fetch(BASE + '&id=' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () { loadKeys(); })
      .catch(function () { alert('Ошибка удаления (нет связи).'); });
  }

  copyBtn.addEventListener('click', function () {
    var text = outValue.textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () {
        copyBtn.textContent = 'Скопировано!';
        setTimeout(function () { copyBtn.textContent = 'Скопировать'; }, 1500);
      });
    }
  });

  createBtn.addEventListener('click', createKey);
  refreshBtn.addEventListener('click', loadKeys);

  // --- Объявления в программе (mokky /message) ---
  var msgText      = document.getElementById('msg-text');
  var msgUrl       = document.getElementById('msg-url');
  var msgButton    = document.getElementById('msg-button');
  var msgCreateBtn = document.getElementById('msg-create-btn');
  var msgRefreshBtn = document.getElementById('msg-refresh-btn');
  var msgTbody     = document.getElementById('msg-rows');

  function createMessage() {
    var text = (msgText.value || '').trim();
    if (!text) { alert('Введите текст объявления.'); return; }
    msgCreateBtn.disabled = true;
    fetch(MSG_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text,
        url: (msgUrl.value || '').trim(),
        button: (msgButton.value || '').trim(),
        active: true,
        createdAt: new Date().toISOString()
      })
    })
      .then(function (r) { return r.json(); })
      .then(function () {
        msgText.value = '';
        msgUrl.value = '';
        msgButton.value = '';
        loadMessages();
      })
      .catch(function () { alert('Ошибка публикации (нет связи с сервером).'); })
      .then(function () { msgCreateBtn.disabled = false; });
  }

  function loadMessages() {
    if (!msgTbody) return;
    msgTbody.innerHTML = '<tr><td colspan="3">Загрузка…</td></tr>';
    fetch(MSG_BASE)
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) {
          msgTbody.innerHTML = '<tr><td colspan="3">Объявлений нет</td></tr>';
          return;
        }
        list.sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
        msgTbody.innerHTML = '';
        list.forEach(renderMessageRow);
      })
      .catch(function () {
        msgTbody.innerHTML = '<tr><td colspan="3">Ошибка загрузки</td></tr>';
      });
  }

  function renderMessageRow(rec) {
    var tr = document.createElement('tr');

    var tdText = document.createElement('td');
    tdText.textContent = rec.text || '';

    var tdStatus = document.createElement('td');
    var active = rec.active !== false;
    tdStatus.textContent = active ? 'показывается' : 'скрыто';
    tdStatus.style.color = active ? '#128c3e' : '#888';

    var tdActions = document.createElement('td');
    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn admin-mini-btn';
    toggleBtn.textContent = active ? 'Скрыть' : 'Показать';
    toggleBtn.addEventListener('click', function () { toggleMessage(rec.id, !active); });

    var delBtn = document.createElement('button');
    delBtn.className = 'btn admin-mini-btn';
    delBtn.textContent = 'Удалить';
    delBtn.addEventListener('click', function () { deleteMessage(rec.id); });

    tdActions.appendChild(toggleBtn);
    tdActions.appendChild(delBtn);

    tr.appendChild(tdText);
    tr.appendChild(tdStatus);
    tr.appendChild(tdActions);
    msgTbody.appendChild(tr);
  }

  function toggleMessage(id, active) {
    fetch(MSG_BASE + '&id=' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: active })
    })
      .then(function () { loadMessages(); })
      .catch(function () { alert('Ошибка изменения (нет связи).'); });
  }

  function deleteMessage(id) {
    if (!confirm('Удалить это объявление?')) return;
    fetch(MSG_BASE + '&id=' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () { loadMessages(); })
      .catch(function () { alert('Ошибка удаления (нет связи).'); });
  }

  if (msgCreateBtn) msgCreateBtn.addEventListener('click', createMessage);
  if (msgRefreshBtn) msgRefreshBtn.addEventListener('click', loadMessages);

  // Сессию проверяет сервер; пароль и токен недоступны JavaScript.
  fetch('/api/admin/session').then(function (r) {
    if (r.ok) showApp();
  });
})();
