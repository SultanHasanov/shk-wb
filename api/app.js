const crypto = require('crypto');
const { sendApiError, supabaseFetch } = require('../server/_supabase');
const approvals = require('../server/_code-approvals');
const { botLoginLink, botUsername } = require('../server/_bot-link');
const { enforceRateLimit } = require('../server/_rate-limit');
const { enforceProgramVersion } = require('../server/_program-version');
const { forgetUserToken, requireUser, optionalUser } = require('../server/_user-auth');
const { publicOrigin } = require('../server/_origin');
const { publicPlans } = require('../server/_app-plans');
const account = require('../server/_app-account');
const QRCode = require('qrcode');
const sync = require('../server/_app-sync');
const relay = require('../server/_app-relay');
const messages = require('../server/_app-messages');
const { appFreeMode } = require('../server/_app-free');
const { crackFallbackEnabled, codeViaBotEnabled, codeViaBotEnabledFor } = require('../server/_app-flags');
const { buildClientQr } = require('../server/_wb-code');
const { crackClientQr } = require('../server/_wb-crack');
const wallet = require('../server/_wallet');
const appUpdate = require('../server/_app-update');
const payments = require('./payments');
const permissions = require('../server/_app-permissions');
const { generationPrices } = require('../server/_generation-billing');
const { CELL_PRINT_PRICES } = require('../server/_payments');
const cabinet = require('./cabinet');

// API программы «Помощник ПВЗ» (/api/app/*, rewrites в vercel.json).
// Отдельный файл не заводим: на Vercel 12 функций — это лимит тарифа, поэтому
// бывшая заглушка api/trial.js стала этим обработчиком, а /api/trial ведёт сюда.

// Пробного периода у «Подбора кодов» больше нет. Старые сборки ещё спрашивают
// этот адрес — всем отвечаем «уже использован», бесплатный подбор не даём.
async function legacyTrial(req, res) {
  if (!await enforceRateLimit(req, res, { scope: 'trial', limit: 10, windowSeconds: 3600 })) return;
  if (!enforceProgramVersion(req, res)) return;
  const hwid = String((req.method === 'GET' ? req.query.hwid : req.body && req.body.hwid) || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(hwid)) return res.status(400).json({ error: 'Invalid hardware id' });
  if (req.method === 'GET') return res.status(200).json({ used: true });
  if (req.method === 'POST') return res.status(200).json({ claimed: false });
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

function sendError(res, error) {
  if (error.code === 'SYNC_NOT_CONFIGURED') return res.status(503).json({ error: error.publicMessage, code: error.code });
  if (error.code && error.status) return res.status(error.status).json({ error: error.message, code: error.code, ...(error.extra || {}) });
  return sendApiError(res, error);
}

// Действие закрыто владельцем на этом ПК (кабинет → «Доступ сотрудников») — 403 DENIED_BY_OWNER.
// Для эндпоинтов до requireUser: без входа (ключ WBPK) ограничений нет — их ставит аккаунт.
async function ownerAllows(req, key) {
  if (!req.headers['x-device-id']) return;
  const user = await optionalUser(req).catch(() => null);
  if (!user) return;
  await account.requireAllowed(req, user.id, key).catch(error => {
    if (error.code === 'DENIED_BY_OWNER') throw error;
  });
}

// Код клиента только через подтверждение владельца в боте (флаг app_code_via_bot): вошедшему аккаунту прямой
// путь закрыт — 403 APPROVAL_REQUIRED (старые версии программы покажут этот текст тостом). Ключ WBPK без входа
// владельца не имеет — работает как раньше. Аккаунт с индивидуальным исключением (user_profiles.app_code_via_bot_off,
// ставится в админке) тоже идёт напрямую. Возвращает false, если ответ уже отправлен.
async function approvalRequired(req, res) {
  if (!await codeViaBotEnabled()) return true;
  const user = await optionalUser(req).catch(() => null);
  if (!user) return true;
  if (!await codeViaBotEnabledFor(user.id)) return true;
  res.status(403).json({ error: 'Код клиента выдаёт владелец через Telegram-бот. Обновите программу до версии 1.11 или новее.', code: 'APPROVAL_REQUIRED' });
  return false;
}


function body(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

function codeFromQrText(qrText) {
  const value = String(qrText || '').split('_')[1];
  return /^\d{5}$/.test(value) ? Number(value) : null;
}

async function clientQrImage(qrText) {
  if (!/^\d{1,12}_\d{5}_\d{6}_\d$/.test(String(qrText || ''))) throw account.appError(400, 'VALIDATION_ERROR', 'Некорректный QR-код');
  return QRCode.toDataURL(qrText, { width: 240, margin: 1 });
}

// Сессия + регистрация ПК. При лимите ПК токены всё равно отдаём: из программы
// можно сразу отключить лишний компьютер и повторить регистрацию.
async function finishLogin(res, session, userId, deviceHash, deviceName, version) {
  const tokens = account.sessionPayload(session);
  let deviceId;
  try {
    deviceId = await account.registerDevice(userId, deviceHash, deviceName, version);
  } catch (error) {
    if (error.code === 'DEVICE_LIMIT') return res.status(409).json({ error: error.message, code: error.code, ...error.extra, session: tokens });
    throw error;
  }
  // Ключ устройства (1.12+): ПК отдаёт базу и получает сообщения владельца и после выхода из аккаунта.
  const deviceKey = await account.issueDeviceKey(userId, deviceId).catch(() => null);
  return res.status(200).json({ session: tokens, deviceKey });
}

// Запросы ПК, которые работают и по ключу устройства (без сессии), и по сессии: передатчик (этот ПК
// отдаёт свои данные), сообщения владельца, звук уведомления. userId/device уже проверены вызывающим кодом.
async function deviceActions(req, res, action, userId, device) {
  if (action === 'relay-inbox' && req.method === 'POST') {
    // Непоказанные сообщения владельца едут в том же ответе: если они уже есть — не ждём заданий,
    // если нет — спим до задания, таймаута или пробуждения новым сообщением (relay.wake).
    let list = await messages.pull(userId, device.id).catch(() => []);
    const out = await relay.inbox(userId, device, body(req), list.length ? { waitMs: 0 } : {});
    if (!list.length) list = await messages.pull(userId, device.id).catch(() => []);
    return res.status(200).json({ ...out, messages: list, alertSound: device.alert_sound || null });
  }
  if (action === 'relay-put' && req.method === 'POST') return res.status(200).json(relay.put(userId, device, req.query, req.body));
  if (action === 'messages-ack' && req.method === 'POST') return res.status(200).json(await messages.ack(userId, device, body(req)));
  if (action === 'device-settings' && req.method === 'POST') return res.status(200).json(await account.setAlertSound(userId, device.id, body(req).alertSound));
  return res.status(405).json({ error: 'Method not allowed' });
}
const KEYED_ACTIONS = new Set(['relay-inbox', 'relay-put', 'messages-ack', 'device-settings']);
// Что программа может и при ограничении «Программа» из админки (server/_user-controls.js): сводка с причиной,
// фоновая работа по передатчику и сообщениям, ключ устройства и выход. Остальное — 403 ACCOUNT_RESTRICTED
// (никогда не 401 и не DEVICE_REVOKED: иначе программа сотрёт сессию или ключ ПК).
const APP_RESTRICT_EXEMPT = new Set(['me', 'relay-inbox', 'relay-put', 'messages-ack', 'device-settings', 'device-key', 'logout']);
// Фоновые опросы программы: ответ Supabase Auth о токене можно помнить до 2 минут (_app-device-cache.js).
function isBackgroundPoll(action, method) {
  return (method === 'POST' && action === 'relay-inbox')
    || (method === 'GET' && ['points', 'docs', 'secrets', 'relay-peers'].includes(action));
}

// Общие документы (server/_app-sync.js) → какой доступ нужен ПК, чтобы их менять или получать.
const DOC_WRITE_PERMS = Object.freeze({
  notes: 'notes', settings: 'settings', staff: 'act.staff_edit', schedule: 'act.staff_edit', video: 'act.video_settings',
});
const SECRET_WRITE_PERMS = Object.freeze({ telegram: 'telegram', ivideon: 'act.video_settings' });
const SECRET_READ_PERMS = Object.freeze({ telegram: 'telegram', ivideon: 'video' });
const SITE_LINK_TARGETS = /^\/cabinet(\/[a-z-]+)?(\?[a-z0-9=&_-]{0,80})?$/i;
// Компьютер сотрудника (app_devices.role = work): видит только себя, не загружает чужие базы,
// не управляет аккаунтом и оплатами. Роль меняется с компьютера владельца или в кабинете.
const WORK_PC = Object.freeze({ error: 'Это действие доступно только с компьютера владельца', code: 'WORK_PC' });

module.exports = async function handler(req, res) {
  const action = String(req.query?.action || '');
  try {
    if (action === 'trial') return await legacyTrial(req, res);

    if (action === 'plans' && req.method === 'GET') {
      // Короткий кэш: freeMode переключается из админки и должен доехать быстро.
      res.setHeader('Cache-Control', 'public, max-age=30');
      return res.status(200).json({ ...publicPlans(), freeMode: await appFreeMode() });
    }

    // Аварийный экран программы (AppErrorBoundary): текст ошибки, раздел и версия — в журнал сервера,
    // чтобы разбирать жалобы без скриншотов. Без входа: экран может упасть и до авторизации.
    if (action === 'client-error' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-client-error', limit: 20, windowSeconds: 600 })) return;
      const b = body(req);
      const cut = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
      const deviceId = cut(req.headers['x-device-id'], 64);
      console.warn('[app] client error', JSON.stringify({
        app: cut(req.headers['x-app-name'], 32), version: cut(req.headers['x-app-version'], 32),
        device: deviceId ? `${deviceId.slice(0, 8)}…` : '', screen: cut(b.screen, 80), message: cut(b.message, 500),
        stack: cut(b.stack, 1500), components: cut(b.componentStack, 1500),
      }));
      return res.status(204).end();
    }

    // Подтверждение входа со страницы сайта — без заголовка версии программы.
    if (action === 'login-request' && req.method === 'GET') {
      const code = account.normalizeLoginCode(req.query.code);
      if (!code) return res.status(400).json({ error: 'Некорректный код', code: 'VALIDATION_ERROR' });
      const row = await account.loginRequest(code);
      const program = account.loginProgram(row).name;
      // Ссылка в бота и её QR — только пока код ждёт подтверждения и не для опроса статуса (poll=1, раз в 3 с).
      const link = row.status === 'pending' && req.query.poll !== '1' ? await botLoginLink(code) : {};
      return res.status(200).json({ deviceName: row.device_name, status: row.status, program, ...link });
    }
    if (action === 'login-approve' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-login-approve', limit: 20, windowSeconds: 600 })) return;
      // Вход программы по коду со страницы сайта. Тот же код выдаёт и ПВЗ Принт (api/cell-print.js,
      // app_version 'cell-print/…'), поэтому область ограничения берётся из самого запроса входа:
      // ПВЗ Принт — «ПВЗ Принт» (cell_print), Помощник — «Программа» (app). 403 ACCOUNT_RESTRICTED, не 401.
      // Та же проверка у подтверждения в боте (lg:ok) — account.approveLoginChecked.
      const user = await requireUser(req, res);
      if (!user) return;
      const code = account.normalizeLoginCode(body(req).code);
      if (!code) return res.status(400).json({ error: 'Некорректный код', code: 'VALIDATION_ERROR' });
      return res.status(200).json(await account.approveLoginChecked(user.id, code));
    }
    if (action === 'me' && req.method === 'GET' && !req.headers['x-device-id']) {
      // Кабинет на сайте: та же сводка, без привязки к ПК.
      const user = await requireUser(req, res, { scope: 'site' });
      if (!user) return;
      const summary = await account.accountSummary(user, null);
      // «в сети» — ПК держит inbox передатчика прямо сейчас (в памяти процесса сайта)
      const online = relay.onlineIds(user.id);
      if (Array.isArray(summary.devices)) summary.devices = summary.devices.map(d => ({ ...d, online: online.has(d.id) }));
      return res.status(200).json(summary);
    }
    // Кабинет на сайте: сообщения владельца на ПК (server/_app-messages.js).
    if (action === 'messages' && !req.headers['x-device-id']) {
      const user = await requireUser(req, res, { scope: 'site' });
      if (!user) return;
      if (req.method === 'GET') return res.status(200).json(await messages.list(user.id, { deviceId: req.query.device, limit: req.query.limit }));
      if (req.method === 'POST') {
        if (!await enforceRateLimit(req, res, { scope: 'app-messages-send', limit: 60, windowSeconds: 600, key: user.id })) return;
        const b = body(req);
        return res.status(201).json(await messages.send({ userId: user.id, deviceId: b.deviceId, text: b.text }));
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (action === 'point' && req.method === 'DELETE' && !req.headers['x-device-id']) {
      // кабинет на сайте: отключить пункт (облачные данные пункта сохраняются)
      const user = await requireUser(req, res, { scope: 'site' });
      if (!user) return;
      await sync.revokePoint(user.id, req.query.id);
      return res.status(204).end();
    }
    if (action === 'device' && req.method === 'DELETE') {
      const user = await requireUser(req, res, { scope: req.headers['x-device-id'] ? 'app' : 'site' });
      if (!user) return;
      const by = await account.requireAllowed(req, user.id, 'act.account');
      if (by && permissions.isWork(by)) return res.status(403).json(WORK_PC);
      await account.revokeDevice(user.id, req.query.id);
      return res.status(204).end();
    }
    if (action === 'device' && req.method === 'PATCH') {
      const user = await requireUser(req, res, { scope: req.headers['x-device-id'] ? 'app' : 'site' });
      if (!user) return;
      if (!await enforceRateLimit(req, res, { scope: 'app-device-rename', limit: 30, windowSeconds: 600, key: user.id })) return;
      const b = body(req);
      // кто меняет: null — кабинет на сайте (владелец), иначе ПК программы. Для роли и доступа ПК обязателен,
      // для переименования — как раньше, без строгой проверки (старые версии шлют его до регистрации ПК).
      const strict = typeof b.role === 'string' || Array.isArray(b.denied);
      const by = !req.headers['x-device-id'] ? null
        : strict ? await account.requireDevice(req, user.id)
        : await account.requireDevice(req, user.id).catch(() => null);
      const self = Boolean(by && by.id === String(req.query.id || ''));
      // звук окна «сообщение владельца» на ПК: кабинет, компьютер владельца или сам ПК
      if (typeof b.alertSound === 'string' || b.alertSound === null) {
        if (by && permissions.isWork(by) && !self) return res.status(403).json(WORK_PC);
        return res.status(200).json(await account.setAlertSound(user.id, req.query.id, b.alertSound));
      }
      // роль ПК: «компьютер владельца» — с паролем (или с другого ПК владельца), «сотрудника» — с ПК владельца
      if (typeof b.role === 'string') {
        return res.status(200).json(await account.setDeviceRole(user, req.query.id, b.role, { by, password: b.password, denied: b.denied }));
      }
      // что закрыто на ПК: кабинет или компьютер владельца (не себе — иначе сотрудник открыл бы себе всё)
      if (Array.isArray(b.denied)) {
        if (by && (permissions.isWork(by) || self)) return res.status(403).json({ error: 'Доступ меняется в кабинете на сайте или с компьютера владельца', code: 'DENIED_BY_OWNER' });
        return res.status(200).json(await account.setDeviceAccess(user.id, req.query.id, b.denied));
      }
      // компьютер сотрудника переименовывает только себя
      if (by && permissions.isWork(by) && !self) return res.status(403).json(WORK_PC);
      return res.status(200).json(await account.renameDevice(user.id, req.query.id, b.name));
    }

    // Обновление и аренда — ДО проверки версии: устаревшая программа должна узнать,
    // куда обновляться, и получить аренду (в ней же флаг обязательного обновления).
    if (action === 'update' && req.method === 'GET') return appUpdate.updateResponse(req, res, publicOrigin(req));
    if (action === 'update-download' && req.method === 'GET') return appUpdate.downloadResponse(res);
    if (action === 'lease' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-lease', limit: 120, windowSeconds: 3600 })) return;
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      // Права считаем, только если ключ аренды настроен (иначе ответ всё равно 503).
      // Сбой базы не должен ронять аренду: rights=null — «неизвестно», программа держит прошлые права.
      const rights = process.env.PVZ_LEASE_PRIVATE_KEY ? await account.leaseRights(req).catch(() => null) : null;
      return appUpdate.leaseResponse(req, res, deviceHash, rights);
    }

    // Дальше — только программа.
    if (!enforceProgramVersion(req, res)) return;
    const version = String(req.headers['x-app-version'] || '');

    if (action === 'login' && req.method === 'POST') {
      const { email, password, deviceName } = body(req);
      const login = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login) || !password) return res.status(400).json({ error: 'Введите почту и пароль', code: 'VALIDATION_ERROR' });
      if (!await enforceRateLimit(req, res, { scope: 'app-login', limit: 10, windowSeconds: 600 })) return;
      if (!await enforceRateLimit(req, res, { scope: 'app-login-email', limit: 10, windowSeconds: 600, key: login })) return;
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      const session = await account.passwordLogin(login, String(password));
      return await finishLogin(res, session, session.user.id, deviceHash, deviceName, version);
    }
    if (action === 'login-start' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-login-start', limit: 10, windowSeconds: 600 })) return;
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      const { code, secret } = await account.startBrowserLogin(deviceHash, body(req).deviceName, version);
      // telegramUrl / telegramQr — подтвердить вход в боте без аккаунта сайта (старые версии их не читают).
      const link = await botLoginLink(code);
      return res.status(201).json({ code, secret, url: `${publicOrigin(req)}/app-login?code=${code}`, expiresIn: 600, ...link });
    }
    if (action === 'login-poll' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-login-poll', limit: 200, windowSeconds: 600 })) return;
      const code = account.normalizeLoginCode(body(req).code);
      if (!code || !body(req).secret) return res.status(400).json({ error: 'Некорректный запрос', code: 'VALIDATION_ERROR' });
      const result = await account.pollBrowserLogin(code, String(body(req).secret));
      if (result.status === 'pending') return res.status(202).json({ status: 'pending' });
      return await finishLogin(res, result.session, result.userId, result.deviceHash, result.deviceName, result.appVersion);
    }
    // Регистрация из программы: письмо → человек жмёт ссылку → программа входит сама.
    if (action === 'signup' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-signup', limit: 5, windowSeconds: 3600 })) return;
      const b = body(req);
      const email = String(b.email || '').trim().toLowerCase();
      if (email && !await enforceRateLimit(req, res, { scope: 'app-signup-email', limit: 3, windowSeconds: 3600, key: email })) return;
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      const result = await account.startSignup({ email, password: b.password, deviceHash, deviceName: b.deviceName, version, origin: publicOrigin(req) });
      if (result.session) return await finishLogin(res, result.session, result.userId, deviceHash, b.deviceName, version);
      return res.status(201).json({ status: 'pending', id: result.id, secret: result.secret, email: result.email });
    }
    if (action === 'signup-poll' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-signup-poll', limit: 300, windowSeconds: 3600 })) return;
      const b = body(req);
      const result = await account.pollSignup(String(b.id || ''), String(b.secret || ''));
      if (result.status === 'pending') return res.status(202).json({ status: 'pending' });
      return await finishLogin(res, result.session, result.userId, result.deviceHash, result.deviceName, result.appVersion);
    }
    if (action === 'signup-resend' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-signup-resend', limit: 5, windowSeconds: 3600 })) return;
      const b = body(req);
      return res.status(200).json(await account.resendSignup(String(b.id || ''), String(b.secret || ''), publicOrigin(req)));
    }
    if (action === 'password-reset' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-password-reset', limit: 5, windowSeconds: 3600 })) return;
      const email = String(body(req).email || '').trim().toLowerCase();
      if (email && !await enforceRateLimit(req, res, { scope: 'app-password-reset-email', limit: 3, windowSeconds: 3600, key: email })) return;
      return res.status(200).json(await account.sendPasswordReset(email, publicOrigin(req)));
    }
    if (action === 'refresh' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-refresh', limit: 60, windowSeconds: 600 })) return;
      const token = String(body(req).refreshToken || '');
      if (!token) return res.status(400).json({ error: 'Нет сессии', code: 'VALIDATION_ERROR' });
      const session = await account.refreshSession(token);
      req.headers.authorization = `Bearer ${session.access_token}`;
      await account.requireDevice(req, session.user.id);
      return res.status(200).json({ session: account.sessionPayload(session) });
    }

    // --- Код клиента: формула и подбор живут только на сервере (server/_wb-code.js,
    // server/_wb-crack.js). Биллинг — аккаунтом (Bearer) или WBPK-ключом из тела, поэтому
    // эндпоинты до requireUser: «Базовый» без входа тоже должен получать коды.
    if (action === 'qr-image' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-qr-image', limit: 120, windowSeconds: 60 })) return;
      return res.status(200).json({ qrImage: await clientQrImage(body(req).qrText) });
    }
    if (action === 'client-qr' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-client-qr', limit: 60, windowSeconds: 60 })) return;
      await ownerAllows(req, 'act.client_qr');
      if (!await approvalRequired(req, res)) return;
      const b = body(req);
      const sid = String(b.sid || '').replace(/\D/g, '');
      if (!sid) return res.status(400).json({ error: 'Нет SID клиента', code: 'VALIDATION_ERROR' });
      const meta = { cell: String(b.cell || '').slice(0, 16) || undefined, via: 'client-qr' };
      if (b.requestId) {
        const qr = buildClientQr(sid);
        const result = await account.billClientCode(req, { key: b.key, meta, requestId: b.requestId, sid, qrText: qr.qrText });
        return res.status(200).json({ code: codeFromQrText(result.qrText), qrText: result.qrText, qrImage: await clientQrImage(result.qrText), billing: result.billing, replayed: result.replayed });
      }
      const billing = await account.billCode(req, { key: b.key, meta });
      const { code, qrText } = buildClientQr(sid);
      return res.status(200).json({ code, qrText, qrImage: await clientQrImage(qrText), billing });
    }
    if (action === 'crack-code' && req.method === 'POST') {
      if (!await crackFallbackEnabled()) return res.status(403).json({ error: 'Резервный подбор отключён', code: 'CRACK_DISABLED' });
      if (!await enforceRateLimit(req, res, { scope: 'app-crack-code', limit: 5, windowSeconds: 60 })) return;
      await ownerAllows(req, 'act.client_qr');
      if (!await approvalRequired(req, res)) return;
      const b = body(req);
      const sid = String(b.sid || '').replace(/\D/g, '');
      if (!sid) return res.status(400).json({ error: 'Нет SID клиента', code: 'VALIDATION_ERROR' });
      await account.authorizeCodeAttempt(req, b.key);
      const hashes = Array.isArray(b.hashes) ? b.hashes.slice(0, 50) : [];
      const found = crackClientQr(sid, hashes);
      if (!found) return res.status(404).json({ error: 'Код не найден по хешам', code: 'CODE_NOT_FOUND' });
      const meta = { cell: String(b.cell || '').slice(0, 16) || undefined, via: 'crack' };
      if (b.requestId) {
        const result = await account.billClientCode(req, { key: b.key, meta, requestId: b.requestId, sid, qrText: found.qrText });
        return res.status(200).json({ code: codeFromQrText(result.qrText), qrText: result.qrText, qrImage: await clientQrImage(result.qrText), billing: result.billing, replayed: result.replayed });
      }
      const billing = await account.billCode(req, { key: b.key, meta });
      return res.status(200).json({ code: found.code, qrText: found.qrText, qrImage: await clientQrImage(found.qrText), billing });
    }

    // --- ПК по ключу устройства, без сессии (1.12+): передатчик, сообщения владельца, звук.
    // Сессия (Bearer) имеет приоритет — тогда обычный путь ниже. ---
    if (KEYED_ACTIONS.has(action) && !req.headers.authorization && req.headers['x-device-key']) {
      const { userId, device } = await account.requireDeviceByKey(req);
      if (!await enforceRateLimit(req, res, { scope: 'app-relay', limit: 3000, windowSeconds: 600, key: userId })) return;
      return await deviceActions(req, res, action, userId, device);
    }

    const user = await requireUser(req, res, {
      cached: isBackgroundPoll(action, req.method),
      // с ПК — область «Программа» (кроме APP_RESTRICT_EXEMPT), из кабинета сайта — «Сайт»
      scope: req.headers['x-device-id'] ? (APP_RESTRICT_EXEMPT.has(action) ? undefined : 'app') : 'site',
    });
    if (!user) return;

    if (action === 'register-device' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-register-device', limit: 30, windowSeconds: 600, key: user.id })) return;
      const deviceHash = account.deviceHashFrom(req);
      if (!deviceHash) return res.status(400).json({ error: 'Обновите программу', code: 'DEVICE_REQUIRED' });
      await account.registerDevice(user.id, deviceHash, body(req).deviceName, version);
      return res.status(200).json({ ok: true });
    }

    // Оплата из программы по QR-коду СБП: тот же заказ, что на сайте (api/payments.js),
    // только ЮKassa отдаёт ссылку для QR вместо страницы оплаты. До проверки ПК: из окна
    // «лимит компьютеров» докупают компьютер, пока этот ещё не подключён.
    if (action === 'pay' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-pay', limit: 20, windowSeconds: 600, key: user.id })) return;
      // ПК ещё не подключён (окно «лимит компьютеров») — ограничений по нему нет
      const payer = await account.requireAllowed(req, user.id, 'act.pay').catch(error => {
        if (error.code === 'DENIED_BY_OWNER') throw error;
        return null;
      });
      if (payer && permissions.isWork(payer)) return res.status(403).json(WORK_PC);
      const b = body(req);
      const product =
        b.kind === 'addon' ? { productKind: 'app_addon', appAddon: String(b.addon || ''), appAddonMonths: Number(b.months || 0) }
        : b.kind === 'wallet' ? { productKind: 'wallet_topup', walletAmount: Number(b.amount || 0) }
        : b.kind === 'cell_print' ? {
          productKind: 'cell_print_license',
          durationDays: Number(b.days || 0),
          deviceLimit: Number(b.devices || 0),
          marketplaceScope: String(b.scope || 'wb'),
          ...(b.renewalTargetKey ? { renewalTargetKey: String(b.renewalTargetKey) } : {}),
        }
        : { productKind: 'app_subscription', appPlan: String(b.plan || ''), appTermMonths: Number(b.months || 0) };
      req.query.action = 'create';
      req.body = {
        ...product,
        accepted: b.accepted === true,
        paymentMethod: 'sbp_qr',
        returnTo: 'cabinet',
      };
      return payments(req, res);
    }
    if (action === 'pay-status' && req.method === 'GET') {
      req.query.action = 'status';
      return payments(req, res);
    }
    const device = await account.requireDevice(req, user.id);

    // Ключ устройства по сессии: ПК, который вошёл до 1.12, или потерявший ключ (DEVICE_KEY_INVALID).
    if (action === 'device-key' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-device-key', limit: 10, windowSeconds: 600, key: device.id })) return;
      return res.status(200).json({ deviceKey: await account.issueDeviceKey(user.id, device.id) });
    }
    if ((action === 'messages-ack' || action === 'device-settings') && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-relay', limit: 3000, windowSeconds: 600, key: user.id })) return;
      return await deviceActions(req, res, action, user.id, device);
    }

    // --- Код клиента с подтверждением владельца в Telegram (server/_code-approvals.js) ---
    if (action === 'code-request' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-code-request', limit: 30, windowSeconds: 600, key: device.id })) return;
      if (!await codeViaBotEnabledFor(user.id)) return res.status(409).json({ error: 'Подтверждение через бот выключено — код выдаётся напрямую', code: 'CODE_VIA_BOT_OFF' });
      if (permissions.isDenied(device, 'act.client_qr')) return res.status(403).json({ error: 'Владелец закрыл QR-код клиента на этом компьютере', code: 'DENIED_BY_OWNER', key: 'act.client_qr' });
      const b = body(req);
      const sid = String(b.sid || '').replace(/\D/g, '');
      if (!sid || sid.length > 12) return res.status(400).json({ error: 'Нет SID клиента', code: 'VALIDATION_ERROR' });
      const cell = String(b.cell || '').slice(0, 16) || null;
      const { row, reused, owner } = await approvals.createApproval({ userId: user.id, device, sid, cell });
      const current = reused ? row : await approvals.notifyOwner(row, owner);
      return res.status(200).json({ ...approvals.statusPayload(current), reused, ownerTelegram: owner.label });
    }
    if (action === 'code-request-status' && req.method === 'GET') {
      const row = await approvals.loadApproval(String(req.query.id || ''));
      if (!row || row.user_id !== user.id || row.device_id !== device.id) return res.status(404).json({ error: 'Запрос не найден', code: 'NOT_FOUND' });
      const payload = approvals.statusPayload(row);
      if (row.status === 'approved') payload.qrImage = await clientQrImage(row.qr_text);
      return res.status(200).json(payload);
    }
    if (action === 'code-request-cancel' && req.method === 'POST') {
      const row = await approvals.cancel(String(body(req).id || ''), { userId: user.id, deviceId: device.id });
      if (!row) return res.status(404).json({ error: 'Запрос не найден', code: 'NOT_FOUND' });
      return res.status(200).json(approvals.statusPayload(row));
    }
    // Одноразовая ссылка t.me/<бот>?start=link_<token> — привязать Telegram владельца к аккаунту. Только с ПК
    // владельца: сотрудник не должен подключить свой Telegram и подтверждать коды сам себе.
    if (action === 'telegram-link' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-telegram-link', limit: 10, windowSeconds: 600, key: user.id })) return;
      if (permissions.isWork(device) || permissions.isDenied(device, 'act.account')) return res.status(403).json(WORK_PC);
      const username = await botUsername();
      if (!username) return res.status(503).json({ error: 'Имя бота неизвестно — попробуйте позже', code: 'BOT_UNAVAILABLE' });
      const token = crypto.randomBytes(18).toString('base64url');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await supabaseFetch('app_telegram_link_tokens', { method: 'POST', body: JSON.stringify({ token, user_id: user.id, device_id: device.id, expires_at: expiresAt }) });
      return res.status(200).json({ url: `https://t.me/${username}?start=link_${token}`, expiresAt });
    }

    // --- загрузка данных пункта с другого ПК (server/_app-relay.js) — свой потолок частоты:
    // ПК держит inbox постоянно, а большая загрузка идёт сотней кусков ---
    if (action.startsWith('relay-')) {
      if (!await enforceRateLimit(req, res, { scope: 'app-relay', limit: 3000, windowSeconds: 600, key: user.id })) return;
      // inbox и put — этот ПК отдаёт свои данные другим; закрыта только загрузка к себе.
      // Компьютер сотрудника не видит список ПК и не загружает чужие базы вовсе (роль).
      const toMe = ['relay-ask', 'relay-get', 'relay-ack', 'relay-peers'].includes(action);
      if (toMe && permissions.isWork(device)) return res.status(403).json(WORK_PC);
      if (toMe && action !== 'relay-peers' && permissions.isDenied(device, 'act.load_pc')) {
        return res.status(403).json({ error: 'Владелец закрыл загрузку с другого ПК на этом компьютере', code: 'DENIED_BY_OWNER', key: 'act.load_pc' });
      }
      if (action === 'relay-inbox' || action === 'relay-put') return await deviceActions(req, res, action, user.id, device);
      if (action === 'relay-peers' && req.method === 'GET') {
        const list = await account.listDevices(user.id).catch(() => []);
        return res.status(200).json(relay.peers(user.id, device, list));
      }
      if (action === 'relay-ask' && req.method === 'POST') return res.status(200).json(await relay.ask(user.id, device, body(req)));
      if (action === 'relay-ack' && req.method === 'POST') return res.status(200).json(relay.ack(user.id, device, req.query));
      if (action === 'relay-get' && req.method === 'GET') {
        const out = await relay.get(user.id, device, req.query);
        if (!out.bytes) return res.status(200).json(out);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-Relay-Last', out.last ? '1' : '0');
        return res.status(200).end(out.bytes);
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Общий потолок на всё остальное с одного аккаунта (синхронизация ходит пачками).
    if (!await enforceRateLimit(req, res, { scope: 'app-user', limit: 900, windowSeconds: 600, key: user.id })) return;

    if (action === 'me' && req.method === 'GET') {
      const summary = await account.accountSummary(user, account.deviceHashFrom(req));
      // компьютер сотрудника видит из списка ПК только себя
      if (permissions.isWork(device)) summary.devices = summary.devices.filter(d => d.current);
      return res.status(200).json(summary);
    }
    if (action === 'consume' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-consume', limit: 30, windowSeconds: 60, key: user.id })) return;
      const meta = body(req).meta && typeof body(req).meta === 'object' ? body(req).meta : {};
      const safeMeta = { cell: String(meta.cell || '').slice(0, 16) || undefined, via: String(meta.via || '').slice(0, 16) || undefined };
      const result = await account.consumeCode(user.id, device.id, safeMeta);
      return res.status(200).json({ ...result, account: await account.accountSummary(user, account.deviceHashFrom(req)) });
    }
    if (action === 'usage' && req.method === 'GET') {
      return res.status(200).json({ items: await account.usageHistory(user.id, req.query.limit) });
    }
    // Полные данные аккаунта с сайта: баланс, покупки, активы (ключи WBPK + лицензии печати
    // ячеек с устройствами), рефералы. Делегируем серверным функциям кабинета.
    if (action === 'wallet' && req.method === 'GET') {
      // цены генерации — для раздела «Стикеры» программы (не дублировать их там)
      const [summary, prices] = await Promise.all([
        wallet.walletSummary(user.id, req.query.limit),
        generationPrices(user.id).catch(() => null),
      ]);
      return res.status(200).json({ ...summary, ...(prices ? { stickerPrices: prices } : {}) });
    }
    if (action === 'cell-print-prices' && req.method === 'GET') {
      // цены лицензии «Печати ячеек» для окна оплаты в программе: {дней: {ПК: ₽}}
      return res.status(200).json({ prices: CELL_PRINT_PRICES });
    }
    if (action === 'orders' && req.method === 'GET') {
      return res.status(200).json({ items: await cabinet.getOrders(user.id, 25) });
    }
    if (action === 'assets' && req.method === 'GET') {
      return res.status(200).json({ items: await cabinet.getAssets(user.id) });
    }
    if (action === 'referrals' && req.method === 'GET') {
      return res.status(200).json(await cabinet.getReferral(user.id));
    }
    if (action === 'claim-key' && req.method === 'POST') {
      // от перебора ключей: попыток мало, ключ из 12 hex-символов
      if (!await enforceRateLimit(req, res, { scope: 'app-claim-key', limit: 10, windowSeconds: 600, key: user.id })) return;
      return res.status(200).json(await account.claimKey(user.id, body(req).key));
    }
    if (action === 'password-change' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-password-change', limit: 5, windowSeconds: 600, key: user.id })) return;
      if (permissions.isWork(device)) return res.status(403).json(WORK_PC);
      if (permissions.isDenied(device, 'act.account')) throw account.appError(403, 'DENIED_BY_OWNER', 'Владелец закрыл управление аккаунтом на этом компьютере', { key: 'act.account' });
      const b = body(req);
      return res.status(200).json(await account.changePassword(user, b.current, b.password));
    }
    if (action === 'logout-others' && req.method === 'POST') {
      if (permissions.isWork(device)) return res.status(403).json(WORK_PC);
      if (permissions.isDenied(device, 'act.account')) throw account.appError(403, 'DENIED_BY_OWNER', 'Владелец закрыл управление аккаунтом на этом компьютере', { key: 'act.account' });
      return res.status(200).json(await account.logoutOthers(user, device.id));
    }
    if (action === 'security-log' && req.method === 'GET') {
      return res.status(200).json({ items: await sync.secretAccessLog(user.id, req.query.limit) });
    }

    // --- пункты и облако ---
    if (action === 'points' && req.method === 'GET') {
      return res.status(200).json({ points: await sync.listPoints(user.id) });
    }
    if (action === 'points' && req.method === 'POST') {
      const b = body(req);
      return res.status(200).json(await sync.registerPoint(user.id, device.id, b.wbPointId, b.name));
    }
    if (action === 'point' && req.method === 'DELETE') {
      if (permissions.isWork(device)) return res.status(403).json(WORK_PC);
      if (permissions.isDenied(device, 'act.account')) throw account.appError(403, 'DENIED_BY_OWNER', 'Владелец закрыл управление аккаунтом на этом компьютере', { key: 'act.account' });
      await sync.revokePoint(user.id, req.query.id);
      return res.status(204).end();
    }
    if (action === 'point-purge' && req.method === 'POST') {
      // удалить облачные данные пункта — только с ПК владельца и с паролем (если он есть у аккаунта)
      if (permissions.isWork(device)) return res.status(403).json(WORK_PC);
      const b = body(req);
      if (user.email && !String(user.email).endsWith('@users.invalid')) {
        await account.passwordLogin(user.email, String(b.password || '')).catch(() => {
          throw account.appError(401, 'BAD_PASSWORD', 'Неверный пароль');
        });
      }
      await sync.purgePoint(user.id, b.point);
      return res.status(204).end();
    }
    if (action === 'archive-push' && req.method === 'POST') {
      const b = body(req);
      return res.status(200).json(await sync.archivePush(user.id, String(b.point || ''), b));
    }
    if (action === 'archive-pull' && req.method === 'POST') {
      const b = body(req);
      return res.status(200).json(await sync.archivePull(user.id, String(b.point || ''), b.since || {}, b.limit, { exportAll: b.export === true }));
    }
    if (action === 'mirror-push' && req.method === 'POST') {
      const b = body(req);
      return res.status(200).json(await sync.mirrorPush(user.id, String(b.point || ''), b));
    }
    if (action === 'mirror-pull' && req.method === 'POST') {
      const b = body(req);
      return res.status(200).json(await sync.mirrorPull(user.id, String(b.point || ''), b.since, b.limit));
    }
    if ((action === 'docs' || action === 'secrets') && req.method === 'GET') {
      const point = req.query.point ? String(req.query.point) : null;
      const docs = await sync.docsGet(user.id, device.id, { point, secret: action === 'secrets' });
      // токены не уезжают на ПК, где владелец закрыл раздел, которому они нужны
      if (action === 'secrets') {
        for (const [key, perm] of Object.entries(SECRET_READ_PERMS)) if (permissions.isDenied(device, perm)) delete docs[key];
      }
      return res.status(200).json({ docs });
    }
    if ((action === 'docs' || action === 'secrets') && req.method === 'PUT') {
      const b = body(req);
      // ПК, где это закрыто владельцем, не меняет общие данные для всех ПК (ставки, график, камеры, токены).
      // Отвечаем «принято» без записи: старые версии программы на 403 застревали бы в ошибке синхронизации,
      // а так при следующем изменении с другого ПК их копия просто перезапишется общей.
      const perm = (action === 'secrets' ? SECRET_WRITE_PERMS : DOC_WRITE_PERMS)[String(b.key || '')];
      if (perm && permissions.isDenied(device, perm)) return res.status(200).json({ version: Number(b.base) || 0, ignored: true });
      return res.status(200).json(await sync.docPut(user.id, device.id, {
        key: b.key, point: b.point || null, base: b.base, data: b.data, secret: action === 'secrets',
      }));
    }
    if (action === 'site-link' && req.method === 'POST') {
      if (!await enforceRateLimit(req, res, { scope: 'app-site-link', limit: 20, windowSeconds: 600, key: user.id })) return;
      const next = String(body(req).next || '/cabinet/subscription');
      if (!SITE_LINK_TARGETS.test(next)) return res.status(400).json({ error: 'Некорректная страница', code: 'VALIDATION_ERROR' });
      // ПК сотрудника (закрыто «Управлять аккаунтом»): ссылка без входа — иначе сотрудник попал бы в кабинет
      // владельца и открыл бы себе доступ сам. Сайт попросит пароль.
      if (permissions.isWork(device) || permissions.isDenied(device, 'act.account')) return res.status(200).json({ url: `${publicOrigin(req)}${next}`, signedIn: false });
      const tokenHash = await account.magicTokenHash(user.id);
      return res.status(200).json({ url: `${publicOrigin(req)}/app-login?th=${encodeURIComponent(tokenHash)}&next=${encodeURIComponent(next)}` });
    }
    if (action === 'logout' && req.method === 'POST') {
      // ПК остаётся в аккаунте (ключ устройства жив: отдаёт базу и получает сообщения владельца);
      // отключает его только «Отключить» в кабинете или в списке компьютеров.
      forgetUserToken(user._accessToken);
      await account.logout(user._accessToken);
      return res.status(204).end();
    }

    return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  } catch (error) {
    return sendError(res, error);
  }
};
