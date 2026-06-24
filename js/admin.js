// Админка лицензионных ключей для «Подбор кодов».
// Доступ ограничен: секция показывается только при секретном хэше в URL
// и после ввода пароля. Это защита от обычных посетителей, не криптозащита.
(function () {
  // === НАСТРОЙКИ (можно менять) ===
  var SECRET_HASH = '#panel-2026';   // открывать админку: index.html#panel-2026
  var ADMIN_PASS  = 'wb-admin-2026'; // пароль входа в админку
  var BASE = 'https://5f517982e1d5a6b7.mokky.dev/key';

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
  }

  function tryLogin() {
    if (passInput.value === ADMIN_PASS) {
      sessionStorage.setItem('wb_admin_ok', '1');
      loginErr.textContent = '';
      showApp();
    } else {
      loginErr.textContent = 'Неверный пароль';
    }
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
    fetch(BASE + '/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: active })
    })
      .then(function () { loadKeys(); })
      .catch(function () { alert('Ошибка изменения (нет связи).'); });
  }

  function deleteKey(id, key) {
    if (!confirm('Удалить ключ ' + key + '?')) return;
    fetch(BASE + '/' + id, { method: 'DELETE' })
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

  // Автовход в рамках вкладки — после того, как все элементы и обработчики готовы.
  if (sessionStorage.getItem('wb_admin_ok') === '1') {
    showApp();
  }
})();
