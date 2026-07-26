// auth.js — полноценная авторизация через API Wildberries (мой ПВЗ)
(function() {
  'use strict';

  const STORAGE_KEY = 'wb_auth_user';
  const ACCESS_TOKEN_KEY = 'wb_access_token';
  const DEVICE_ID_KEY = 'wb_device_id';
  const API_BASE = '/api/proxy';

  // DOM-элементы
  const modal = document.getElementById('auth-modal');
  const modalClose = document.getElementById('auth-modal-close');
  const authStatus = document.getElementById('auth-status');

  const phoneInput = document.getElementById('auth-phone');
  const codeInput = document.getElementById('auth-code');
  const codeField = document.getElementById('auth-code-field');

  const sendBtn = document.getElementById('auth-send-btn');
  const confirmBtn = document.getElementById('auth-confirm-btn');

  const errorEl = document.getElementById('auth-error');
  const successDiv = document.getElementById('auth-success');
  const logoutBtn = document.getElementById('auth-logout-btn');
  const authForm = document.getElementById('auth-form');

  // Состояние сессии
  let sticker = null;          // идентификатор сессии от wb-captcha
  let currentPhone = null;     // номер, на который запросили код
  let accessToken = null;      // токен после успешной авторизации

  // ---------- Утилиты для работы с телефоном ----------
  function getRawPhone(value) {
    const text = String(value || '');
    let digits = text.replace(/\D/g, '');
    if (text.trim().startsWith('+7')) {
      digits = digits.slice(1);
    } else if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
      digits = digits.slice(1);
    }
    return digits.slice(0, 10);
  }

  function formatPhoneFromDigits(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 10);
    if (!digits) return '';
    let result = '+7 (';
    result += digits.slice(0, 3);
    if (digits.length > 3) result += `) ${digits.slice(3, 6)}`;
    if (digits.length > 6) result += `-${digits.slice(6, 8)}`;
    if (digits.length > 8) result += `-${digits.slice(8, 10)}`;
    return result;
  }

  function getDeviceId() {
    let deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  }

  function getCaretPosition(formattedValue, digitsBeforeCursor) {
    if (!formattedValue) return 0;
    if (digitsBeforeCursor <= 0) return Math.min(4, formattedValue.length);
    let countryCodeSkipped = false;
    let nationalDigitsCount = 0;
    for (let index = 0; index < formattedValue.length; index++) {
      if (!/\d/.test(formattedValue[index])) continue;
      if (!countryCodeSkipped) {
        countryCodeSkipped = true;
        continue;
      }
      nationalDigitsCount++;
      if (nationalDigitsCount === digitsBeforeCursor) return index + 1;
    }
    return formattedValue.length;
  }

  // ---------- X-Pow (Proof of Work) ----------
  // Парсит challenge из заголовка X-Pow
  function parsePowChallenge(challengeStr) {
    // Формат: 5,8,1,salt,uuid1,uuid2,timestamp,version,hmac
    const parts = challengeStr.split(',');
    if (parts.length < 9) return null;
    return {
      version: parseInt(parts[0], 10),
      difficulty: parseInt(parts[1], 10),
      algorithm: parseInt(parts[2], 10),
      salt: parts[3],
      uuid1: parts[4],
      uuid2: parts[5],
      timestamp: parts[6],
      subversion: parseInt(parts[7], 10),
      hmac: parts[8],
    };
  }

  // SHA-256 через Web Crypto
  async function sha256(message) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Решение PoW: подбор nonce, при котором hash(salt + nonce) имеет difficulty ведущих нулей
  async function solvePow(challengeStr) {
    const parsed = parsePowChallenge(challengeStr);
    if (!parsed) throw new Error('Некорректный challenge');
    const { salt, difficulty } = parsed;

    // Для difficulty=8 в среднем 256 попыток – быстро
    let nonce = 0;
    const maxAttempts = Math.pow(2, difficulty + 4); // запас на случай высокой сложности
    while (nonce < maxAttempts) {
      const input = salt + nonce.toString();
      const hash = await sha256(input);
      const fullZeroNibbles = Math.floor(difficulty / 4);
      const remainingBits = difficulty % 4;
      const hasFullZeroNibbles = hash.startsWith('0'.repeat(fullZeroNibbles));
      const nextNibble = parseInt(hash[fullZeroNibbles] || '0', 16);
      const hasRemainingZeroBits = remainingBits === 0 ||
        nextNibble < Math.pow(2, 4 - remainingBits);
      if (hasFullZeroNibbles && hasRemainingZeroBits) {
        return nonce;
      }
      nonce++;
      // yield для UI (раз в 1000 итераций)
      if (nonce % 1000 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
    throw new Error('Не удалось подобрать nonce для PoW');
  }

  // Формирует заголовок X-Pow для запроса
  async function buildPowHeader(challengeStr) {
    const nonce = await solvePow(challengeStr);
    return `status=valid; nonce=${nonce}; challenge=${challengeStr}`;
  }

  // ---------- API-вызовы ----------
  async function apiRequest(endpoint, body, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'deviceId': getDeviceId(),
      'wb-appversion': 'v0.0.55',
      'X-Language': 'ru',
      ...options.headers,
    };

    // Если есть access_token – добавляем в Authorization
    const token = getAccessToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // Добавляем User-Agent (как в реальных запросах)
    headers['User-Agent'] = navigator.userAgent;

    const fetchOptions = {
      method: options.method || 'POST',
      headers,
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    // Если передан challenge – решаем PoW и добавляем X-Pow
    if (options.challenge) {
      const powHeader = await buildPowHeader(options.challenge);
      fetchOptions.headers['X-Pow'] = powHeader;
    }

    const response = await fetch(url, fetchOptions);

    // Извлекаем X-Pow из ответа для следующего запроса
    const responsePow = response.headers.get('X-Pow') || null;

    // Парсим JSON
    let data;
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    // Если статус не OK – пробрасываем ошибку с данными
    if (!response.ok) {
      const err = new Error(data?.message || data || 'Ошибка запроса');
      err.status = response.status;
      err.data = data;
      err.powChallenge = responsePow;
      throw err;
    }

    // Если в ответе пришёл challenge – сохраняем его для следующего запроса
    if (responsePow && responsePow.includes('challenge')) {
      // Может быть как invalid, так и valid – сохраняем raw
      // Парсим challenge из строки
      const match = responsePow.match(/challenge=([^;]+)/);
      if (match) {
        return { data, powChallenge: match[1], rawPow: responsePow };
      }
    }

    return { data, powChallenge: null, rawPow: responsePow };
  }

  // ---------- Основные методы авторизации ----------

  // 1. Запрос кода (wb-captcha)
  async function requestCode(phoneNumber) {
    const rawPhone = getRawPhone(phoneNumber);
    if (rawPhone.length !== 10) {
      throw new Error('Введите 10 цифр номера телефона');
    }

    // Первый запрос без X-Pow (сервер вернёт challenge)
    try {
      const result = await apiRequest('/code/wb-captcha', {
        captcha_token: '',
        phone_number: rawPhone,
        save_push: true,
      });

      // Если сервер вернул challenge – решаем и повторяем запрос
      if (result.powChallenge) {
        // Повторный запрос с решённым PoW
        const result2 = await apiRequest('/code/wb-captcha', {
          captcha_token: '',
          phone_number: rawPhone,
          save_push: true,
        }, {
          challenge: result.powChallenge,
        });

        // Проверяем ответ
        if (result2.data && result2.data.result === 0) {
          const payload = result2.data.payload || {};
          if (payload.sticker) {
            sticker = payload.sticker;
            currentPhone = rawPhone;
            return { sticker, ttl: payload.ttl || 60 };
          }
        }
        throw new Error(result2.data?.message || 'Не удалось запросить код');
      }

      // Если сразу пришёл sticker (без challenge)
      if (result.data && result.data.result === 0) {
        const payload = result.data.payload || {};
        if (payload.sticker) {
          sticker = payload.sticker;
          currentPhone = rawPhone;
          return { sticker, ttl: payload.ttl || 60 };
        }
      }

      throw new Error(result.data?.message || 'Ошибка при запросе кода');
    } catch (err) {
      // Если ошибка содержит challenge – пробуем ещё раз с решённым PoW
      if (err.powChallenge) {
        try {
          const result2 = await apiRequest('/code/wb-captcha', {
            captcha_token: '',
            phone_number: rawPhone,
            save_push: true,
          }, {
            challenge: err.powChallenge,
          });
          if (result2.data && result2.data.result === 0) {
            const payload = result2.data.payload || {};
            if (payload.sticker) {
              sticker = payload.sticker;
              currentPhone = rawPhone;
              return { sticker, ttl: payload.ttl || 60 };
            }
          }
          throw new Error(result2.data?.message || 'Не удалось запросить код');
        } catch (e2) {
          throw new Error(e2.message || 'Ошибка при запросе кода');
        }
      }
      throw err;
    }
  }

  // 2. Подтверждение кода (auth)
  async function confirmCode(code, stickerId) {
    const codeDigits = String(code).replace(/\D/g, '');
    if (codeDigits.length < 4 || codeDigits.length > 6) {
      throw new Error('Введите 4–6-значный код');
    }

    if (!stickerId) {
      throw new Error('Нет активной сессии. Запросите код заново.');
    }

    // Первый запрос (может потребовать PoW)
    try {
      const result = await apiRequest('/auth', {
        code: codeDigits,
        sticker: stickerId,
      });

      // Если вернулся challenge – решаем и повторяем
      if (result.powChallenge) {
        const result2 = await apiRequest('/auth', {
          code: codeDigits,
          sticker: stickerId,
        }, {
          challenge: result.powChallenge,
        });

        if (result2.data && result2.data.result === 0) {
          const token = result2.data.access_token;
          if (token) {
            saveAccessToken(token);
            return { accessToken: token };
          }
        }
        throw new Error(result2.data?.message || 'Неверный код');
      }

      // Успешный ответ без challenge
      if (result.data && result.data.result === 0) {
        const token = result.data.access_token;
        if (token) {
          saveAccessToken(token);
          return { accessToken: token };
        }
      }

      throw new Error(result.data?.message || 'Неверный код');
    } catch (err) {
      // Если ошибка содержит challenge – пробуем ещё раз с решённым PoW
      if (err.powChallenge) {
        try {
          const result2 = await apiRequest('/auth', {
            code: codeDigits,
            sticker: stickerId,
          }, {
            challenge: err.powChallenge,
          });
          if (result2.data && result2.data.result === 0) {
            const token = result2.data.access_token;
            if (token) {
              saveAccessToken(token);
              return { accessToken: token };
            }
          }
          throw new Error(result2.data?.message || 'Неверный код');
        } catch (e2) {
          throw new Error(e2.message || 'Ошибка подтверждения кода');
        }
      }
      throw err;
    }
  }

  // ---------- Управление токенами и сессией ----------
  function saveAccessToken(token) {
    accessToken = token;
    try {
      localStorage.setItem(ACCESS_TOKEN_KEY, token);
    } catch (_) { /* игнорируем */ }
  }

  function getAccessToken() {
    if (accessToken) return accessToken;
    try {
      const saved = localStorage.getItem(ACCESS_TOKEN_KEY);
      if (saved) {
        accessToken = saved;
        return saved;
      }
    } catch (_) { /* игнорируем */ }
    return null;
  }

  function clearAccessToken() {
    accessToken = null;
    try {
      localStorage.removeItem(ACCESS_TOKEN_KEY);
    } catch (_) { /* игнорируем */ }
  }

  // ---------- Управление пользователем ----------
  function getUser() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return null;
      return JSON.parse(saved);
    } catch (_) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }

  function setUser(phone) {
    const displayPhone = formatPhoneFromDigits(phone);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      phone: displayPhone,
      rawPhone: getRawPhone(phone),
      loginTime: Date.now(),
    }));
    updateUI();
  }

  function logout() {
    clearAccessToken();
    localStorage.removeItem(STORAGE_KEY);
    sticker = null;
    currentPhone = null;
    updateUI();
    resetForm();
  }

  function isLoggedIn() {
    return getUser() !== null && getAccessToken() !== null;
  }

  // ---------- UI-обновление ----------
  function updateUI() {
    const user = getUser();
    const token = getAccessToken();

    if (user && token) {
      authStatus.innerHTML = `
        <span class="user-phone">${user.phone}</span>
        <button class="logout-btn" id="logout-btn" type="button">Выйти</button>
      `;
      return;
    }

    // Не авторизован
    authStatus.innerHTML = `
      <button id="auth-login-btn" class="btn btn-outline" type="button">Войти</button>
    `;
  }

  function resetForm() {
    sticker = null;
    currentPhone = null;
    authForm.style.display = 'block';
    successDiv.style.display = 'none';
    phoneInput.disabled = false;
    phoneInput.value = '';
    codeInput.value = '';
    codeField.style.display = 'none';
    sendBtn.style.display = '';
    confirmBtn.style.display = 'none';
    errorEl.textContent = '';
    // Сбрасываем атрибуты disabled
    sendBtn.disabled = false;
    confirmBtn.disabled = false;
  }

  function openModal() {
    resetForm();
    modal.hidden = false;
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => phoneInput.focus());
  }

  function closeModal() {
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    errorEl.textContent = '';
  }

  function showError(msg) {
    errorEl.textContent = msg;
  }

  function setLoading(button, loading) {
    if (loading) {
      button.disabled = true;
      button.textContent = 'Загрузка…';
    } else {
      button.disabled = false;
      button.textContent = button.dataset.originalText || button.textContent;
    }
  }

  // ---------- Обработчики событий ----------

  // Делегирование для кнопок входа/выхода в шапке
  authStatus.addEventListener('click', function(event) {
    const loginBtn = event.target.closest('#auth-login-btn');
    const logoutBtn = event.target.closest('#logout-btn');

    if (loginBtn) {
      event.preventDefault();
      event.stopPropagation();
      if (!isLoggedIn()) openModal();
      return;
    }

    if (logoutBtn) {
      event.preventDefault();
      event.stopPropagation();
      logout();
    }
  });

  // Маска телефона
  phoneInput.addEventListener('input', function() {
    const currentValue = this.value;
    const currentCursor = this.selectionStart ?? currentValue.length;
    const valueBeforeCursor = currentValue.slice(0, currentCursor);
    const digitsBeforeCursor = getRawPhone(valueBeforeCursor).length;
    const rawPhone = getRawPhone(currentValue);
    const formattedPhone = formatPhoneFromDigits(rawPhone);
    this.value = formattedPhone;
    const newCursor = getCaretPosition(formattedPhone, digitsBeforeCursor);
    this.setSelectionRange(newCursor, newCursor);
    if (errorEl.textContent) errorEl.textContent = '';
  });

  phoneInput.addEventListener('focus', function() {
    if (!this.value) {
      this.value = '+7 (';
      this.setSelectionRange(this.value.length, this.value.length);
    }
  });

  phoneInput.addEventListener('blur', function() {
    if (!getRawPhone(this.value)) this.value = '';
  });

  // Код – только цифры, до 6 символов
  codeInput.addEventListener('input', function() {
    this.value = this.value.replace(/\D/g, '').slice(0, 6);
    if (errorEl.textContent) errorEl.textContent = '';
  });

  // Отправка кода (первый шаг)
  sendBtn.addEventListener('click', async function() {
    const rawPhone = getRawPhone(phoneInput.value);
    if (rawPhone.length !== 10) {
      showError('Введите 10 цифр номера телефона');
      phoneInput.focus();
      return;
    }

    setLoading(this, true);
    this.dataset.originalText = 'Отправить код';

    try {
      const result = await requestCode(rawPhone);
      // Успех – показываем поле для кода
      phoneInput.disabled = true;
      codeField.style.display = '';
      confirmBtn.style.display = '';
      sendBtn.style.display = 'none';
      codeInput.value = '';
      codeInput.focus();
      errorEl.textContent = '';
      // Запоминаем, что код отправлен
      showError('Код отправлен! Проверьте уведомления в ЛК Wildberries.');
      setTimeout(() => {
        if (errorEl.textContent === 'Код отправлен! Проверьте уведомления в ЛК Wildberries.') {
          errorEl.textContent = '';
        }
      }, 5000);
    } catch (err) {
      showError(err.message || 'Ошибка при отправке кода');
      console.error('[auth] requestCode error:', err);
    } finally {
      setLoading(this, false);
      this.dataset.originalText = 'Отправить код';
    }
  });

  // Подтверждение кода (второй шаг)
  confirmBtn.addEventListener('click', async function() {
    const code = codeInput.value.replace(/\D/g, '').trim();
    if (code.length < 4 || code.length > 6) {
      showError('Введите 4–6-значный код из уведомлений');
      codeInput.focus();
      return;
    }

    if (!sticker) {
      showError('Сессия истекла. Запросите код заново.');
      phoneInput.disabled = false;
      codeField.style.display = 'none';
      confirmBtn.style.display = 'none';
      sendBtn.style.display = '';
      return;
    }

    setLoading(this, true);
    this.dataset.originalText = 'Подтвердить';

    try {
      const result = await confirmCode(code, sticker);
      if (result.accessToken) {
        // Успешная авторизация
        const userPhone = currentPhone || getRawPhone(phoneInput.value);
        setUser(userPhone);
        closeModal();
        // Показываем сообщение об успехе
        const user = getUser();
        if (user) {
          authStatus.innerHTML = `
            <span class="user-phone">${user.phone}</span>
            <button class="logout-btn" id="logout-btn" type="button">Выйти</button>
          `;
        }
        // Небольшое уведомление (можно заменить на toast)
        alert('Вход выполнен успешно!');
      }
    } catch (err) {
      showError(err.message || 'Неверный код или сессия истекла');
      console.error('[auth] confirmCode error:', err);
      // Если ошибка связана с сессией – сбрасываем
      if (err.message && (err.message.includes('sticker') || err.message.includes('сессия'))) {
        sticker = null;
        phoneInput.disabled = false;
        codeField.style.display = 'none';
        confirmBtn.style.display = 'none';
        sendBtn.style.display = '';
        codeInput.value = '';
      }
    } finally {
      setLoading(this, false);
      this.dataset.originalText = 'Подтвердить';
    }
  });

  // Закрытие модалки
  modalClose.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    closeModal();
  });

  modal.addEventListener('click', function(e) {
    if (e.target === modal) closeModal();
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  // Enter в поле телефона → отправить код
  phoneInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (sendBtn.style.display !== 'none') sendBtn.click();
    }
  });

  // Enter в поле кода → подтвердить
  codeInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (confirmBtn.style.display !== 'none') confirmBtn.click();
    }
  });

  // Кнопка выхода из модалки (если есть)
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function() {
      logout();
      closeModal();
    });
  }

  // ---------- Инициализация ----------
  // Проверяем сохранённую сессию при загрузке
  (function init() {
    const token = getAccessToken();
    const user = getUser();
    if (token && user) {
      // Проверяем, что токен ещё жив (можно сделать ping-запрос)
      // Если токен протух – разлогиниваем
      // Для простоты считаем, что если есть токен и пользователь – всё ок
      updateUI();
    } else {
      // Если токена нет, но пользователь есть – чистим
      if (user) {
        localStorage.removeItem(STORAGE_KEY);
      }
      if (token) {
        clearAccessToken();
      }
      updateUI();
    }
  })();

  // Экспортируем методы для внешнего использования (опционально)
  window.WBAuth = {
    getUser,
    getAccessToken,
    isLoggedIn,
    logout,
    requestCode,
    confirmCode,
    openModal,
    closeModal,
  };

})();
