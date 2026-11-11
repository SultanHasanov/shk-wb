// Аккаунт программы «Помощник ПВЗ»: вход тем же логином и паролем, что на сайте,
// вход через браузер (для аккаунтов Telegram без пароля), сведения о тарифе,
// списание подборов и управление ПК.
//
// Сессия — обычная сессия Supabase (access + refresh). Каждый запрос программы
// несёт X-Device-Id: sha256 от MachineGuid. ПК регистрируется при входе
// (app_register_device следит за лимитом тарифа); отключённый в кабинете ПК
// получает DEVICE_REVOKED и выходит, даже если его токены ещё живы.
const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { authConfig, getAuthUser, optionalUser } = require('./_user-auth');
const deviceCache = require('./_app-device-cache');
const { ADDONS, PLANS, accountLimits, addonAllowed, effectiveFeatures, isPlan, mirrorLimit } = require('./_app-plans');
const { createNotification } = require('./_notifications');
const { sendMessage } = require('./_telegram-api');
const { identityForUser } = require('./_telegram-identity');
const { appFreeMode, appFreeUntil, appFreeWindow } = require('./_app-free');
const { crackFallbackEnabled, codeViaBotEnabled } = require('./_app-flags');
const { CLUB_DISCOUNT_PERCENT, clubUserDiscount } = require('./_club');
const permissions = require('./_app-permissions');
// Ограничения и безлимит из админки — снимок в памяти (без похода в базу на каждый запрос)
const controls = require('./_user-controls');

/**
 * Фактические даты подписки с учётом бесплатного периода. При его окончании подписки
 * сдвигаются (_app-free.js planShift): сдвиг = конец периода − max(начало периода, начало
 * подписки). Здесь та же формула заранее — чтобы человек видел, с какого числа и до какого
 * действует то, что он оплатил. Вне бесплатного периода — null.
 */
function effectiveDates(ent, win) {
  if (!win || !win.until || !ent?.starts_at) return null;
  const untilMs = Date.parse(win.until);
  const startMs = Date.parse(ent.starts_at);
  const sinceMs = win.since ? Date.parse(win.since) : startMs;
  const shift = untilMs - Math.max(sinceMs, startMs);
  if (!(shift > 0)) return null;
  const move = iso => (iso ? new Date(Date.parse(iso) + shift).toISOString() : null);
  return {
    startsAt: startMs >= sinceMs ? new Date(untilMs).toISOString() : ent.starts_at,
    endsAt: move(ent.ends_at),
    paidUntil: move(ent.paid_until),
  };
}

const DEVICE_RE = /^[a-f0-9]{64}$/;

// Аккаунты без лимитов и оплаты (владелец сервиса): APP_UNLIMITED_USER_IDS — UUID через запятую,
// или безлимит, выданный в админке (user_overrides, из снимка server/_user-controls.js).
// Всё открыто, подборы не списываются, ПК и пунктов — сколько угодно.
function isUnlimited(userId) {
  if (!userId) return false;
  const env = String(process.env.APP_UNLIMITED_USER_IDS || '')
    .split(/[\s,]+/).filter(Boolean).map(s => s.toLowerCase())
    .includes(String(userId).toLowerCase());
  return env || controls.isUnlimitedCached(userId);
}

// Фича «mirror» = есть хотя бы один зеркальный пункт (у безлимита — всегда).
function withMirror(features, mirror) {
  return mirror > 0 && !features.includes('mirror') ? [...features, 'mirror'] : features;
}

// Права аккаунта целиком: тариф, услуги, фичи и лимиты ПК/пунктов.
async function loadEntitlements(userId, cached) {
  const load = () => supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) });
  if (!cached) return load();
  const hit = deviceCache.getUserData(userId, 'plan');
  if (hit) return hit;
  const epoch = deviceCache.currentDataEpoch();
  const ent = await load();
  deviceCache.putUserData(userId, 'plan', ent, epoch);
  return ent;
}

// cached — только для фонового /points, где нужен лишь признак зеркала: счётчики кодов в этом ответе могут устареть.
async function entitlementsFor(userId, { cached = false } = {}) {
  const [ent, free] = await Promise.all([
    loadEntitlements(userId, cached),
    appFreeMode(),
  ]);
  const unlimited = isUnlimited(userId) || ent.unlimited === true;
  const plan = isPlan(ent.plan) ? ent.plan : null;
  const addons = ent.addons && typeof ent.addons === 'object' ? ent.addons : {};
  const all = free || unlimited;
  const mirror = mirrorLimit(plan, addons, unlimited, ent.mirror_bonus);
  return {
    ent, free, unlimited, plan, addons, mirror,
    // в правило старого «Стандарта» — тарифный лимит кодов (codes_base), ручная квота без подписки — отдельно
    features: withMirror(effectiveFeatures(plan, addons, all, ent.codes_base ?? ent.codes_limit, plan ? 0 : ent.codes_limit), mirror),
    limits: accountLimits(plan, addons, ent.device_limit, all, ent.device_bonus, ent.points_bonus),
  };
}
const LOGIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function appError(status, code, message, extra) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (extra) error.extra = extra;
  return error;
}

// Исключения из SQL-функций приходят текстом в details — достаём наш код.
function dbErrorCode(error) {
  const text = JSON.stringify(error?.details || error?.message || '');
  for (const code of ['DEVICE_LIMIT', 'LIMIT_EXCEEDED', 'CODE_REQUEST_CONFLICT', 'INVALID_AMOUNT', 'UNSUPPORTED_KIND']) {
    if (text.includes(code)) return code;
  }
  for (const code of ['POINT_LIMIT', 'VERSION_CONFLICT']) {
    if (text.includes(code)) return code;
  }
  if (text.includes('Asset belongs to another user')) return 'KEY_OWNED';
  if (text.includes('Asset not found')) return 'KEY_NOT_FOUND';
  if (text.includes('User is not confirmed')) return 'EMAIL_NOT_CONFIRMED';
  return null;
}

async function authRequest(path, { method = 'POST', body, service = false, token } = {}) {
  const { url, publishableKey, serviceKey } = authConfig();
  const key = service ? serviceKey : publishableKey;
  const response = await fetch(`${url}/auth/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${token || key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.msg || data.error_description || data.message || 'Auth request failed');
    error.status = response.status;
    error.authCode = data.error_code || data.error || null;
    throw error;
  }
  return data;
}

function sessionPayload(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    expires_at: data.expires_at,
  };
}

async function passwordLogin(email, password) {
  try {
    return await authRequest('token?grant_type=password', { body: { email, password } });
  } catch (error) {
    if (error.authCode === 'email_not_confirmed') throw appError(403, 'EMAIL_NOT_CONFIRMED', 'Подтвердите почту по ссылке из письма и попробуйте снова');
    // GoTrue-бан ставит ограничение «Полностью» из админки — это не «неверный пароль»
    if (error.authCode === 'user_banned') throw appError(403, 'ACCOUNT_RESTRICTED', 'Доступ к аккаунту ограничен администратором');
    if (error.status === 400 || error.status === 401) throw appError(401, 'BAD_CREDENTIALS', 'Неверная почта или пароль');
    throw error;
  }
}

async function refreshSession(refreshToken) {
  try {
    return await authRequest('token?grant_type=refresh_token', { body: { refresh_token: refreshToken } });
  } catch (error) {
    if (error.status === 400 || error.status === 401) throw appError(401, 'SESSION_EXPIRED', 'Сессия истекла, войдите снова');
    throw error;
  }
}

// Сессия для пользователя без пароля: одноразовая magic-ссылка, которую тут же
// подтверждаем сервером (так же работает вход через Telegram в api/auth.js).
async function magicTokenHash(userId) {
  const user = await getAuthUser(userId);
  if (!user?.email) throw appError(404, 'USER_NOT_FOUND', 'Аккаунт не найден');
  const link = await authRequest('admin/generate_link', { service: true, body: { type: 'magiclink', email: user.email } });
  const tokenHash = link.properties?.hashed_token || link.hashed_token;
  if (!tokenHash) throw new Error('Supabase did not return a token');
  return tokenHash;
}

async function sessionForUser(userId) {
  const tokenHash = await magicTokenHash(userId);
  return authRequest('verify', { body: { type: 'magiclink', token_hash: tokenHash } });
}

async function logout(accessToken) {
  await authRequest('logout?scope=local', { token: accessToken }).catch(() => {});
}

function deviceHashFrom(req) {
  const value = String(req.headers['x-device-id'] || '').trim().toLowerCase();
  return DEVICE_RE.test(value) ? value : null;
}

// callback_data кнопки «🚫 Это не я» под сообщением о новом ПК (обработчик — бот, handleDeviceNotMe): 42 байта.
function deviceNotMeData(deviceId) {
  return `dv:no:${deviceId}`;
}

/**
 * То же уведомление в Telegram, если к аккаунту привязан Telegram: у профиля бота нет почты, и без этого
 * о чужом входе владелец не узнает. Кнопка «🚫 Это не я» отключает ПК и завершает все сеансы. Сбой не мешает входу.
 */
async function notifyNewDeviceTelegram(userId, name, deviceId, when) {
  const identity = await identityForUser(userId);
  if (!identity?.telegram_user_id) return false;
  const pc = String(name || 'Компьютер').slice(0, 80).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = [];
  if (/^[0-9a-f-]{36}$/i.test(String(deviceId || ''))) rows.push([{ text: '🚫 Это не я', callback_data: deviceNotMeData(deviceId) }]);
  // n:<callback> — меню откроется новым сообщением; уведомление и кнопка «Это не я» останутся (server/_bot-notice.js).
  rows.push([{ text: '☰ Меню', callback_data: require('./_bot-notice').noticeData('menu:home') }]);
  await sendMessage(Number(identity.telegram_user_id), [
    '🖥 <b>Новый вход в «Помощник ПВЗ»</b>',
    `Компьютер «${pc}» вошёл в ваш профиль ${when} (МСК).`,
    'Если это не вы — нажмите «🚫 Это не я»: я отключу этот компьютер и завершу все входы.',
  ].join('\n'), { reply_markup: { inline_keyboard: rows } });
  return true;
}

// Письмо, уведомление в кабинете и сообщение в Telegram «вход с нового компьютера»: если это не вы — отключите ПК.
async function notifyNewDevice(userId, name, deviceId) {
  const user = await getAuthUser(userId).catch(() => null);
  const when = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  await Promise.all([
    createNotification({
      userId,
      kind: 'system',
      title: 'Вход в «Помощник ПВЗ» с нового компьютера',
      body: `Компьютер «${String(name || 'Компьютер').slice(0, 80)}» вошёл в ваш аккаунт ${when} (МСК). Если это были не вы — отключите его в кабинете (Подписка → Компьютеры) и смените пароль.`,
      link: '/cabinet/subscription',
      dedupeKey: `app-device:${userId}:${Date.now()}`,
      email: technicalEmail(user?.email) ? null : user.email,
    }).catch(() => {}),
    notifyNewDeviceTelegram(userId, name, deviceId, when)
      .catch(error => console.warn('New device: Telegram notice failed', error?.message || error)),
  ]);
}

// Есть ли ПК в профиле и не отключён ли он. Отключённый ПК (кабинет, «🚫 Это не я», «выйти на всех других»)
// при возврате — снова новый вход: уведомление с кнопкой «Это не я» приходит заново. Сбой чтения — как
// «известный и активный»: вход не ломаем и лишних уведомлений не шлём.
async function deviceState(userId, deviceHash) {
  const rows = await supabaseFetch(`app_devices?user_id=eq.${encodeURIComponent(userId)}&device_hash=eq.${deviceHash}&select=id,name,revoked_at&limit=1`).catch(() => null);
  if (!rows) return { exists: true, active: true, name: '' };
  const row = rows[0];
  return { exists: Boolean(row), active: Boolean(row && !row.revoked_at), name: row?.name || '' };
}

// В бесплатном режиме лимит ПК не действует: ПК добавляем/возвращаем напрямую.
async function registerDeviceFree(userId, deviceHash, name, version) {
  const now = new Date().toISOString();
  const fields = { last_seen_at: now, app_version: String(version || '').slice(0, 32), revoked_at: null };
  if (name) fields.name = String(name).slice(0, 80);
  const rows = await supabaseFetch(`app_devices?user_id=eq.${encodeURIComponent(userId)}&device_hash=eq.${deviceHash}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  if (rows.length) return rows[0].id;
  const created = await supabaseFetch('app_devices', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: userId, device_hash: deviceHash, name: String(name || '').trim().slice(0, 80) || 'Компьютер', app_version: fields.app_version }),
  });
  return created[0].id;
}

// Название ПК задаётся при первом входе (адрес пункта или «Домашний ноутбук») и дальше меняется
// только переименованием — повторный вход его не затирает (пустое имя = оставить как есть).
// Вернувшийся отключённый ПК сохраняет своё название и роль (assignInitialRole трогает только пустую роль).
async function registerDevice(userId, deviceHash, name, version) {
  const state = await deviceState(userId, deviceHash);
  const id = await registerDeviceLimited(userId, deviceHash, state.exists ? '' : name, version);
  if (!state.active) {
    await assignInitialRole(userId, id);
    await notifyNewDevice(userId, state.name || name, id);
  }
  return id;
}

// Новый ПК — компьютер сотрудника: закрыт по шаблону «Сотрудник пункта», видит только себя.
// Исключение: первый компьютер пустого аккаунта — владельца (иначе владелец на единственном ПК
// увидел бы урезанный профиль и не смог бы ничего настроить). Сбой здесь вход не ломает.
async function assignInitialRole(userId, deviceId) {
  if (!deviceId) return;
  try {
    const others = await supabaseFetch(`app_devices?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&id=neq.${encodeURIComponent(deviceId)}&select=id&limit=1`);
    const role = others.length ? 'work' : 'owner';
    await supabaseFetch(`app_devices?id=eq.${encodeURIComponent(deviceId)}&role=is.null`, {
      method: 'PATCH',
      body: JSON.stringify(role === 'work'
        ? { role, denied: [...permissions.WORK_DENIED], access_updated_at: new Date().toISOString() }
        : { role }),
    });
  } catch { /* роль назначит владелец вручную */ }
}

/**
 * Смена роли ПК. `by` — кто меняет: null (кабинет на сайте) или ПК программы (requireDevice).
 * Из программы: «компьютер владельца» — только с паролем аккаунта (или с другого ПК владельца);
 * «компьютер сотрудника» — только с ПК владельца и не себе самому.
 */
async function setDeviceRole(user, deviceId, role, { by = null, password, denied } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(deviceId || ''))) throw appError(400, 'VALIDATION_ERROR', 'Некорректное устройство');
  if (!permissions.ROLES.has(role)) throw appError(400, 'VALIDATION_ERROR', 'Роль компьютера: owner или work');
  if (by) {
    if (permissions.isWork(by) && role === 'work') throw appError(403, 'WORK_PC', 'Это действие доступно только с компьютера владельца');
    if (role === 'work' && by.id === deviceId) throw appError(400, 'VALIDATION_ERROR', 'Свой компьютер делают компьютером сотрудника с другого ПК владельца или в кабинете');
    if (role === 'owner' && permissions.isWork(by)) {
      if (technicalEmail(user.email)) throw appError(400, 'NO_PASSWORD', 'У аккаунта нет пароля. Назначьте роль в кабинете на сайте.');
      await passwordLogin(user.email, String(password || '')).catch(() => {
        throw appError(401, 'BAD_PASSWORD', 'Пароль не подошёл. Это пароль от аккаунта на сайте shk-wb.ru, не от Wildberries.');
      });
    }
  }
  const fields = { role };
  if (role === 'owner') {
    fields.denied = [];
    fields.access_updated_at = new Date().toISOString();
  } else if (Array.isArray(denied)) {
    fields.denied = permissions.cleanDenied(denied);
    fields.access_updated_at = new Date().toISOString();
  } else {
    fields.denied = [...permissions.WORK_DENIED];
    fields.access_updated_at = new Date().toISOString();
  }
  const rows = await supabaseFetch(`app_devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(user.id)}&revoked_at=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  if (!rows.length) throw appError(404, 'NOT_FOUND', 'Устройство не найдено');
  return { id: rows[0].id, role: rows[0].role, denied: rows[0].denied || [] };
}

async function registerDeviceLimited(userId, deviceHash, name, version) {
  if (isUnlimited(userId) || await appFreeMode()) return registerDeviceFree(userId, deviceHash, name, version);
  const { limits } = await entitlementsFor(userId);
  try {
    return await supabaseFetch('rpc/app_register_device', {
      method: 'POST',
      body: JSON.stringify({ p_user: userId, p_hash: deviceHash, p_name: String(name || '').slice(0, 80), p_version: String(version || '').slice(0, 32), p_limit: limits.devices }),
    });
  } catch (error) {
    if (dbErrorCode(error) === 'DEVICE_LIMIT') {
      throw appError(409, 'DEVICE_LIMIT', 'Достигнут лимит компьютеров по тарифу. Отключите один из них, чтобы войти здесь.', { devices: await listDevices(userId) });
    }
    throw error;
  }
}

const DEVICE_SELECT = 'id,name,last_seen_at,denied,point_wb,role,alert_sound';
// Звуки окна «сообщение владельца» — те же id, что WAV в программе (src-tauri/sounds) и на сайте (sounds/pvz).
const ALERT_SOUNDS = Object.freeze(['chime', 'bell', 'ding', 'knock', 'pulse', 'soft']);
const DEVICE_KEY_RE = /^[A-Za-z0-9_-]{40,64}$/;

// last_seen_at / версия — не чаще раза в 10 минут.
async function touchDevice(device, req) {
  const seenAt = Math.max(new Date(device.last_seen_at).getTime() || 0, deviceCache.lastTouched(device.id));
  if (Date.now() - seenAt <= 10 * 60 * 1000) return;
  deviceCache.markTouched(device.id);
  await supabaseFetch(`app_devices?id=eq.${device.id}`, {
    method: 'PATCH',
    keepCache: true,
    body: JSON.stringify({ last_seen_at: new Date().toISOString(), app_version: String(req.headers['x-app-version'] || '').slice(0, 32) }),
  }).catch(() => {});
}

// ПК, с которого пришёл запрос программы; без него — 401 DEVICE_REVOKED.
async function requireDevice(req, userId) {
  const hash = deviceHashFrom(req);
  if (!hash) throw appError(400, 'DEVICE_REQUIRED', 'Обновите программу');
  const cacheKey = `session:${userId}:${hash}`;
  let device = deviceCache.getDevice(cacheKey);
  if (!device) {
    const epoch = deviceCache.currentEpoch();
    const rows = await supabaseFetch(`app_devices?user_id=eq.${encodeURIComponent(userId)}&device_hash=eq.${hash}&revoked_at=is.null&select=${DEVICE_SELECT}&limit=1`);
    if (!rows.length) throw appError(401, 'DEVICE_REVOKED', 'Этот компьютер отключён от аккаунта. Войдите снова.');
    device = rows[0];
    deviceCache.putDevice(cacheKey, device, epoch);
  }
  await touchDevice(device, req);
  return { ...device };
}

// --- Ключ устройства (1.12+): ПК ходит в передатчик и за сообщениями владельца без сессии ---
// Ключ выдаётся при входе (finishLogin) или по запросу device-key с сессией; в базе только sha256.
// Выход из аккаунта строку не отзывает — отзывает «Отключить» в кабинете, и тогда ключ мёртв.

function deviceKeyFrom(req) {
  const value = String(req.headers['x-device-key'] || '').trim();
  return DEVICE_KEY_RE.test(value) ? value : null;
}

/** Новый ключ ПК (прежний перестаёт действовать). Возвращает сам ключ — отдать программе один раз. */
async function issueDeviceKey(userId, deviceId) {
  const key = crypto.randomBytes(32).toString('base64url');
  const rows = await supabaseFetch(`app_devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ key_hash: hashSecret(key), key_issued_at: new Date().toISOString() }),
  });
  if (!rows.length) throw appError(404, 'NOT_FOUND', 'Устройство не найдено');
  return key;
}

/**
 * ПК по X-Device-Id + X-Device-Key, без сессии → { userId, device }.
 * 401 DEVICE_KEY_REQUIRED — нет заголовков; 401 DEVICE_REVOKED — живой строки с ключом нет (ПК отключён
 * в кабинете: программа забывает ключ и сессию); 401 DEVICE_KEY_INVALID — строка есть, ключ не тот
 * (программа забывает только ключ и запрашивает новый по сессии).
 */
async function requireDeviceByKey(req) {
  const hash = deviceHashFrom(req);
  const key = deviceKeyFrom(req);
  if (!hash || !key) throw appError(401, 'DEVICE_KEY_REQUIRED', 'Войдите в аккаунт');
  const given = Buffer.from(hashSecret(key));
  // один ПК мог входить в разные аккаунты — строк с этим хэшем несколько, ключ выбирает свою
  const matching = list => list.find(r => {
    const expected = Buffer.from(String(r.key_hash || ''));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
  const cacheKey = `key:${hash}`;
  // в память попадают только строки, к которым подошёл ключ; не подошёл — решает база, а не память
  let row = matching(deviceCache.getDevice(cacheKey) || []);
  if (!row) {
    const epoch = deviceCache.currentEpoch();
    const rows = await supabaseFetch(`app_devices?device_hash=eq.${hash}&revoked_at=is.null&key_hash=not.is.null&select=user_id,key_hash,${DEVICE_SELECT}`);
    if (!rows.length) throw appError(401, 'DEVICE_REVOKED', 'Этот компьютер отключён от аккаунта. Войдите снова.');
    row = matching(rows);
    if (!row) throw appError(401, 'DEVICE_KEY_INVALID', 'Ключ компьютера устарел');
    deviceCache.putDevice(cacheKey, rows, epoch);
  }
  await touchDevice(row, req);
  const { user_id: userId, key_hash: _hash, ...device } = row;
  return { userId, device };
}

async function setAlertSound(userId, deviceId, sound) {
  if (!/^[0-9a-f-]{36}$/i.test(String(deviceId || ''))) throw appError(400, 'VALIDATION_ERROR', 'Некорректное устройство');
  const value = sound === null || sound === '' ? null : String(sound);
  if (value !== null && !ALERT_SOUNDS.includes(value)) throw appError(400, 'VALIDATION_ERROR', 'Неизвестный звук');
  const rows = await supabaseFetch(`app_devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ alert_sound: value }),
  });
  if (!rows.length) throw appError(404, 'NOT_FOUND', 'Устройство не найдено');
  return { id: rows[0].id, alertSound: rows[0].alert_sound || null };
}

async function listDevices(userId, currentHash) {
  const rows = await supabaseFetch(`app_devices?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=id,device_hash,name,app_version,last_seen_at,created_at,denied,point_wb,access_updated_at,role,alert_sound&order=last_seen_at.desc`);
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    appVersion: row.app_version,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    current: Boolean(currentHash && row.device_hash === currentHash),
    denied: Array.isArray(row.denied) ? row.denied : [],
    pointWb: row.point_wb || null,
    accessUpdatedAt: row.access_updated_at || null,
    alertSound: row.alert_sound || null,
    // owner | work | null (роль не назначена — как owner)
    role: permissions.roleOf(row),
  }));
}

// Кабинет → «Доступ сотрудников»: что закрыто на этом ПК. Только владелец (Bearer сайта).
async function setDeviceAccess(userId, deviceId, denied) {
  if (!/^[0-9a-f-]{36}$/i.test(String(deviceId || ''))) throw appError(400, 'VALIDATION_ERROR', 'Некорректное устройство');
  if (!Array.isArray(denied)) throw appError(400, 'VALIDATION_ERROR', 'Список закрытого должен быть массивом');
  const list = permissions.cleanDenied(denied);
  const rows = await supabaseFetch(`app_devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ denied: list, access_updated_at: new Date().toISOString() }),
  });
  if (!rows.length) throw appError(404, 'NOT_FOUND', 'Устройство не найдено');
  return { id: rows[0].id, denied: rows[0].denied || [] };
}

// Запрос программы с ПК, где владелец закрыл действие, — 403 DENIED_BY_OWNER.
// Запросы кабинета (без X-Device-Id) не ограничиваются: там владелец.
async function requireAllowed(req, userId, key) {
  if (!req.headers['x-device-id']) return null;
  const device = await requireDevice(req, userId);
  if (permissions.isDenied(device, key)) {
    throw appError(403, 'DENIED_BY_OWNER', 'Владелец закрыл это действие на этом компьютере', { key });
  }
  return device;
}

async function renameDevice(userId, deviceId, name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!/^[0-9a-f-]{36}$/i.test(String(deviceId || ''))) throw appError(400, 'VALIDATION_ERROR', 'Некорректное устройство');
  if (!clean) throw appError(400, 'VALIDATION_ERROR', 'Введите название компьютера');
  const rows = await supabaseFetch(`app_devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name: clean }),
  });
  if (!rows.length) throw appError(404, 'NOT_FOUND', 'Устройство не найдено');
  return { id: rows[0].id, name: rows[0].name };
}

async function revokeDevice(userId, deviceId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(deviceId || ''))) throw appError(400, 'VALIDATION_ERROR', 'Некорректное устройство');
  const rows = await supabaseFetch(`app_devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  if (!rows.length) throw appError(404, 'NOT_FOUND', 'Устройство не найдено');
}

function technicalEmail(email) {
  return !email || String(email).endsWith('@users.invalid');
}

// Ключ в ответах API показываем не целиком: WBPK-••••-••••-3F2A.
function maskKey(key) {
  const v = String(key || '');
  return v.length > 4 ? `WBPK-••••-••••-${v.slice(-4)}` : v;
}

// Сводка для программы и кабинета.
async function accountSummary(user, currentHash) {
  const uid = encodeURIComponent(user.id);
  const [ent, profiles, telegram, packs, stickerCodes, devices, free, freeUntil, freeWin, points, crackFallback, clubDiscount, codeViaBot] = await Promise.all([
    supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: user.id }) }),
    supabaseFetch(`user_profiles?user_id=eq.${uid}&select=display_name,phone,app_code_via_bot_off&limit=1`).catch(() => []),
    supabaseFetch(`user_telegram_identities?user_id=eq.${uid}&select=username,first_name&limit=1`).catch(() => []),
    supabaseFetch(`license_keys?owner_user_id=eq.${uid}&active=eq.true&select=key,usage_limit,used,created_at&order=created_at.asc`),
    supabaseFetch(`sticker_access_codes?owner_user_id=eq.${uid}&active=eq.true&app_subscription_id=is.null&select=generation_limit,generation_used`),
    listDevices(user.id, currentHash),
    appFreeMode(),
    appFreeUntil(),
    appFreeWindow(),
    supabaseFetch(`app_points?user_id=eq.${uid}&revoked_at=is.null&select=id,wb_point_id,name,last_sync_at,mirror_at,created_at&order=created_at.asc`).catch(() => []),
    crackFallbackEnabled().catch(() => false),
    // Скидка участника «Клуба вопросов» на тариф «Про» (server/_club.js): кабинет показывает цену со скидкой,
    // сервер применяет её в api/payments.js. Ошибка проверки → без скидки.
    clubUserDiscount(user.id).catch(() => false),
    codeViaBotEnabled().catch(() => false),
  ]);
  const restriction = await controls.restrictionFor(user.id).catch(() => null);
  // ограничение «Программа» (или «Полностью») из админки: разделы закрыты, тариф не показываем
  const appBlocked = controls.covers(restriction, 'app');
  const unlimited = isUnlimited(user.id) || ent.unlimited === true;
  const all = free || unlimited;
  const profile = profiles[0] || {};
  const tg = telegram[0] || null;
  const plan = isPlan(ent.plan) ? ent.plan : null;
  const packsLeft = Number(ent.packs_left || 0);
  const rawAddons = ent.addons && typeof ent.addons === 'object' ? ent.addons : {};
  return {
    user: {
      id: user.id,
      email: technicalEmail(user.email) ? null : user.email,
      name: profile.display_name || tg?.first_name || null,
      phone: profile.phone || null,
      telegram: tg ? { username: tg.username || null, firstName: tg.first_name || null } : null,
    },
    // Telegram привязан к аккаунту (username бывает пустым — поэтому отдельный флаг): туда приходят
    // запросы QR-кода клиента с компьютеров.
    telegramLinked: Boolean(tg),
    // Бесплатный режим (админка): всем вошедшим — Про. Программа читает поле plan первым.
    freeMode: free,
    freeUntil: free ? freeUntil : null,
    // Безлимитный аккаунт: всё открыто бессрочно, оплаты не нужны.
    unlimited,
    // Переключатели из админки (резервный подбор кода и т.п.). codeViaBot — уже с учётом индивидуального
    // исключения аккаунта (user_profiles.app_code_via_bot_off): программа по нему выбирает прямой путь или запрос владельцу.
    flags: { crackFallback: crackFallback === true, codeViaBot: codeViaBot === true && profile.app_code_via_bot_off !== true },
    // Скидка участника клуба на «Про», в процентах (0 — нет). Применяется только к тарифу pro.
    clubDiscountPercent: clubDiscount ? CLUB_DISCOUNT_PERCENT : 0,
    // Ограничение из админки (любая область): программа и кабинет показывают причину и срок.
    restricted: restriction ? { scopes: [...restriction.scopes], message: restriction.message, until: restriction.until } : null,
    ...(all && !appBlocked ? { plan: 'pro' } : {}),
    // Итоговые разделы программы: тариф + активные услуги (в бесплатном режиме — всё).
    features: appBlocked ? [] : withMirror(
      effectiveFeatures(plan, rawAddons, all, ent.codes_base ?? ent.codes_limit, plan ? 0 : ent.codes_limit),
      mirrorLimit(plan, rawAddons, unlimited, ent.mirror_bonus),
    ),
    // Услуги: куплена до endsAt; active = действует сейчас (на тарифе ниже нужного — false).
    addons: Object.values(ADDONS).map(a => {
      const endsAt = rawAddons[a.id]?.ends_at || null;
      return {
        id: a.id,
        kind: a.kind || 'service',
        title: a.title,
        endsAt,
        active: !appBlocked && ((all && a.kind !== 'pack') || Boolean(endsAt && addonAllowed(a.id, plan))),
        needsPlan: !all && Boolean(endsAt) && !addonAllowed(a.id, plan) ? a.minPlan : null,
      };
    }),
    // Без подписки, но с пакетами (или ручной квотой из админки) подбор кода всё равно работает — как «Базовый».
    effectivePlan: appBlocked ? null : all ? 'pro' : plan || ((packsLeft > 0 || Number(ent.codes_limit) > 0) ? 'basic' : null),
    subscription: plan ? {
      plan,
      title: PLANS[plan].title,
      startsAt: ent.starts_at,
      endsAt: ent.ends_at,
      paidUntil: ent.paid_until,
      nextPlan: ent.next_plan || null,
      // в бесплатный период: когда подписка фактически начнётся и до какого числа оплачена
      effective: free ? effectiveDates(ent, freeWin) : null,
    } : null,
    // ручная квота кодов без подписки (user_overrides) считается в окне календарного месяца по МСК
    quota: plan || (ent.override?.codes_mode && ent.window_start) ? {
      windowStart: ent.window_start,
      resetAt: ent.window_end,
      codes: { used: Number(ent.codes_used || 0), limit: Number(ent.codes_limit || 0) },
      stickers: { used: Number(ent.stickers_used || 0), limit: Number(ent.stickers_limit || 0) },
    } : null,
    packs: packs.map(row => ({ key: maskKey(row.key), total: row.usage_limit, left: Math.max(0, row.usage_limit - row.used), addedAt: row.created_at })),
    packsLeft,
    stickerPacksLeft: stickerCodes.reduce((sum, row) => sum + Math.max(0, Number(row.generation_limit || 0) - Number(row.generation_used || 0)), 0),
    deviceLimit: accountLimits(plan, rawAddons, ent.device_limit, all, ent.device_bonus, ent.points_bonus).devices,
    pointLimit: accountLimits(plan, rawAddons, ent.device_limit, all, ent.device_bonus, ent.points_bonus).points,
    // сколько пунктов можно загружать на другие ПК (пакеты «Загрузка с другого ПК» и надбавка из админки)
    mirrorLimit: mirrorLimit(plan, rawAddons, unlimited, ent.mirror_bonus),
    devices,
    points: points.map(p => ({
      id: p.id,
      wbPointId: String(p.wb_point_id),
      name: p.name,
      lastSyncAt: p.last_sync_at,
      mirrorAt: p.mirror_at,
      createdAt: p.created_at,
    })),
  };
}

/**
 * Права для подписанной аренды (POST /api/app/lease). Программа открывает разделы
 * только по ним, а не по кэшу account.json, — поэтому правка файлов ничего не даёт.
 * Без входа или с отключённым ПК — пустой список: подбор кода по пакетам и ключу
 * всё равно проверяет сервер при списании.
 */
async function leaseRights(req) {
  const user = await optionalUser(req).catch(() => null);
  let userId = user?.id || null;
  let device = null;
  // Без сессии, но с ключом устройства (1.12+): права только на фоновую работу — отдавать базу по
  // передатчику (mirror) и получать сообщения владельца. Разделы тарифа без входа закрыты, как раньше.
  const viaKey = !user && Boolean(req.headers['x-device-key']);
  if (viaKey) {
    try {
      ({ userId, device } = await requireDeviceByKey(req));
    } catch (error) {
      if (error.status === 401) return { user: null, plan: null, features: [], archive_until: null, free: false };
      throw error;
    }
  }
  if (!userId) return { user: null, plan: null, features: [], archive_until: null, free: false };
  if (!device) {
    try {
      device = await requireDevice(req, userId);
    } catch (error) {
      if (error.code === 'DEVICE_REVOKED' || error.code === 'DEVICE_REQUIRED') {
        return { user: userId, plan: null, features: [], archive_until: null, free: false, denied: [], role: null };
      }
      throw error;
    }
  }
  // Ограничение «Программа» из админки: пустые права и причина — программа покажет её вместо разделов.
  // Ни 401, ни DEVICE_REVOKED: ключ ПК и вход остаются, после снятия всё откроется само.
  const restriction = await controls.restrictionFor(userId);
  if (restriction && controls.covers(restriction, 'app')) {
    return {
      user: userId, plan: null, features: [], archive_until: null, free: false, denied: [], role: permissions.roleOf(device),
      via: viaKey ? 'key' : 'session', restricted: { message: restriction.message, until: restriction.until },
    };
  }
  await rememberDevicePoint(device, req.headers['x-point-wb']);
  const { free, unlimited, plan, addons, features } = await entitlementsFor(userId);
  const all = free || unlimited;
  const archiveUntil = all ? null : (features.includes('archive') ? addons.archive?.ends_at || null : null);
  // закрытое владельцем на этом ПК: разделы вычитаются из тарифа, весь список — программе
  const denied = permissions.cleanDenied(device.denied);
  const open = features.filter(f => !denied.includes(f));
  const granted = viaKey ? open.filter(f => f === 'mirror') : open;
  // роль ПК — подписана вместе с правами: компьютер сотрудника не покажет чужие ПК и не загрузит их базы
  return { user: userId, plan: all ? 'pro' : plan, features: granted, archive_until: viaKey ? null : archiveUntil, free: all, denied, role: permissions.roleOf(device), via: viaKey ? 'key' : 'session' };
}

// Пункт, чья база WB стоит на ПК (программа шлёт в /lease), — для группировки ПК в кабинете.
async function rememberDevicePoint(device, header) {
  const wb = String(header || '').trim();
  if (!/^\d{1,12}$/.test(wb) || wb === device.point_wb) return;
  await supabaseFetch(`app_devices?id=eq.${device.id}`, { method: 'PATCH', body: JSON.stringify({ point_wb: wb }) }).catch(() => {});
}

async function consumeCode(userId, deviceId, meta) {
  // Бесплатный режим и безлимитный аккаунт: подбор не списываем ни из квоты, ни из пакетов.
  if (isUnlimited(userId)) return { ok: true, free: true, unlimited: true };
  if (await appFreeMode()) return { ok: true, free: true };
  try {
    return await supabaseFetch('rpc/app_consume', {
      method: 'POST',
      body: JSON.stringify({ p_user: userId, p_device: deviceId, p_kind: 'code', p_amount: 1, p_meta: meta || {} }),
    });
  } catch (error) {
    if (dbErrorCode(error) === 'LIMIT_EXCEEDED') throw appError(409, 'LIMIT_EXCEEDED', 'Подборы закончились: лимит месяца исчерпан и нет пакетов. Докупите пакет или смените тариф.');
    throw error;
  }
}

// Списание подбора с WBPK-ключа (режим «Базовый» без входа в аккаунт).
async function consumeKey(key) {
  const value = String(key || '').trim();
  if (!value) throw appError(400, 'VALIDATION_ERROR', 'Нет ключа');
  const rows = await supabaseFetch('rpc/consume_license', { method: 'POST', body: JSON.stringify({ p_key: value }) });
  if (!rows.length) throw appError(409, 'LIMIT_EXCEEDED', 'Подборы в ключе закончились. Докупите пакет или смените тариф.');
  const row = rows[0];
  return { via: 'key', left: Math.max(0, Number(row.usage_limit || 0) - Number(row.used || 0)) };
}

async function authorizeCodeAttempt(req, key) {
  const user = await optionalUser(req).catch(() => null);
  if (user) {
    await requireDevice(req, user.id);
    return;
  }
  const value = String(key || '').trim();
  if (!value) throw appError(401, 'AUTH_REQUIRED', 'Войдите в аккаунт или добавьте ключ');
  const active = await supabaseFetch('rpc/app_code_key_active', { method: 'POST', body: JSON.stringify({ p_key: value }) });
  if (!active) throw appError(401, 'INVALID_KEY', 'Ключ не найден или подборы закончились');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function codeOnce(body) {
  try {
    return await supabaseFetch('rpc/app_code_once', { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    if (dbErrorCode(error) === 'LIMIT_EXCEEDED') throw appError(409, 'LIMIT_EXCEEDED', 'Подборы закончились. Докупите пакет или смените тариф.');
    if (dbErrorCode(error) === 'CODE_REQUEST_CONFLICT') throw appError(409, 'CODE_REQUEST_CONFLICT', 'Этот запрос уже использован для другого клиента');
    throw error;
  }
}

/**
 * Списание одного кода клиента по аккаунту без HTTP-запроса — для подтверждений в боте
 * (server/_code-approvals.js) и прямого «Код <SID>» в боте (deviceId = null, meta.via = 'bot').
 * Идемпотентно по requestId (app_code_once). Безлимит и бесплатный режим — без списания.
 */
async function chargeClientCode(userId, deviceId, { requestId, sid, qrText, meta }) {
  if (!UUID_RE.test(String(requestId || ''))) throw appError(400, 'VALIDATION_ERROR', 'Некорректный идентификатор запроса кода');
  // зовут и бот, и подтверждения владельца — проверка ограничения здесь, а не только в HTTP
  await controls.assertAllowed(userId, 'app');
  if (isUnlimited(userId) || await appFreeMode()) {
    return { qrText, billing: { via: 'account', ok: true, free: true }, replayed: false };
  }
  return codeOnce({ p_request: requestId, p_user: userId, p_device: deviceId || null, p_key: null, p_sid: sid, p_qr_text: qrText, p_meta: meta || {} });
}

async function billClientCode(req, { key, meta, requestId, sid, qrText }) {
  if (!UUID_RE.test(String(requestId || ''))) {
    throw appError(400, 'VALIDATION_ERROR', 'Некорректный идентификатор запроса кода');
  }
  const user = await optionalUser(req).catch(() => null);
  if (user) {
    await controls.assertAllowed(user.id, 'app');
    const device = await requireDevice(req, user.id);
    return chargeClientCode(user.id, device.id, { requestId, sid, qrText, meta });
  }
  if (!key) throw appError(401, 'AUTH_REQUIRED', 'Войдите в аккаунт или добавьте ключ');
  return codeOnce({ p_request: requestId, p_user: null, p_device: null, p_key: String(key).trim(), p_sid: sid, p_qr_text: qrText, p_meta: meta || {} });
}

/**
 * Один биллинг «подбора» для генерации кода клиента. Вошедший аккаунт — через квоту/пакеты
 * (consumeCode), иначе — по WBPK-ключу из тела. Бросает 401, если ни того, ни другого нет.
 */
async function billCode(req, { key, meta } = {}) {
  const user = await optionalUser(req).catch(() => null);
  if (user) {
    await controls.assertAllowed(user.id, 'app');
    const device = await requireDevice(req, user.id);
    const result = await consumeCode(user.id, device.id, meta || {});
    return { via: 'account', ...result };
  }
  if (key) return consumeKey(key);
  throw appError(401, 'AUTH_REQUIRED', 'Войдите в аккаунт или добавьте ключ');
}

async function usageHistory(userId, limit = 30) {
  const n = Math.max(1, Math.min(100, Number(limit) || 30));
  const rows = await supabaseFetch(`app_usage?user_id=eq.${encodeURIComponent(userId)}&select=kind,amount,source,meta,created_at,device_id,license_key_id&order=created_at.desc&limit=${n}`);
  const deviceIds = [...new Set(rows.map(r => r.device_id).filter(Boolean))];
  const devices = deviceIds.length
    ? await supabaseFetch(`app_devices?id=in.(${deviceIds.join(',')})&select=id,name`).catch(() => [])
    : [];
  const names = Object.fromEntries(devices.map(d => [d.id, d.name]));
  return rows.map(row => ({
    kind: row.kind,
    amount: row.amount,
    source: row.source,
    device: names[row.device_id] || null,
    cell: row.meta?.cell || null,
    createdAt: row.created_at,
  }));
}

// После привязки: сколько подборов в ключе — чтобы сказать человеку «+N подборов».
async function keyInfo(value) {
  const rows = await supabaseFetch(`license_keys?key=eq.${encodeURIComponent(value)}&select=usage_limit,used,active&limit=1`).catch(() => []);
  const row = rows[0];
  return row ? { total: row.usage_limit, left: Math.max(0, row.usage_limit - row.used), active: row.active } : null;
}

async function claimKey(userId, key) {
  const value = String(key || '').trim().toUpperCase();
  if (!/^WBPK-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(value)) throw appError(400, 'VALIDATION_ERROR', 'Ключ выглядит так: WBPK-XXXX-XXXX-XXXX');
  try {
    await supabaseFetch('rpc/claim_user_asset', { method: 'POST', body: JSON.stringify({ p_user_id: userId, p_kind: 'program', p_value: value }) });
  } catch (error) {
    const code = dbErrorCode(error);
    if (code === 'KEY_OWNED') throw appError(409, code, 'Этот ключ уже привязан к другому аккаунту');
    if (code === 'KEY_NOT_FOUND') throw appError(404, code, 'Ключ не найден');
    if (code === 'EMAIL_NOT_CONFIRMED') throw appError(403, code, 'Подтвердите почту, чтобы привязать ключ');
    throw error;
  }
  const info = await keyInfo(value);
  return { key: maskKey(value), left: info?.left ?? null, total: info?.total ?? null };
}

// --- Вход через браузер ---

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function newLoginCode() {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, b => LOGIN_CODE_ALPHABET[b % LOGIN_CODE_ALPHABET.length]).join('');
}

async function startBrowserLogin(deviceHash, deviceName, version) {
  const secret = crypto.randomBytes(32).toString('base64url');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newLoginCode();
    try {
      await supabaseFetch('app_login_requests', {
        method: 'POST',
        body: JSON.stringify({ code, poll_secret_hash: hashSecret(secret), device_hash: deviceHash, device_name: String(deviceName || 'Компьютер').slice(0, 80), app_version: String(version || '').slice(0, 32) }),
      });
      return { code, secret };
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  throw new Error('Unable to allocate login code');
}

function normalizeLoginCode(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z2-9]{8}$/.test(code) ? code : null;
}

async function loginRequest(code) {
  const rows = await supabaseFetch(`app_login_requests?code=eq.${code}&select=*&limit=1`);
  const row = rows[0];
  if (!row) throw appError(404, 'NOT_FOUND', 'Код не найден');
  if (new Date(row.expires_at) <= new Date()) throw appError(410, 'EXPIRED', 'Код устарел. Нажмите «Войти через сайт» в программе ещё раз.');
  return row;
}

// Какая программа просит вход: тот же код выдаёт и ПВЗ Принт (api/cell-print.js, app_version 'cell-print/…').
// scope — область ограничения из админки: ПВЗ Принт — cell_print, Помощник — app.
function loginProgram(row) {
  return String(row?.app_version || '').startsWith('cell-print')
    ? { scope: 'cell_print', name: 'ПВЗ Принт' }
    : { scope: 'app', name: 'Помощник ПВЗ' };
}

/** Ограничение аккаунта, которое закрывает этот вход (или null). */
async function loginRestriction(userId, row) {
  const restriction = await controls.restrictionFor(userId);
  return controls.covers(restriction, loginProgram(row).scope) ? restriction : null;
}

// Второй подтверждающий (вторая вкладка, бот и сайт одновременно) не получает ложный «успех»: строку
// меняет только тот, кто застал её pending, остальным — 409 ALREADY_USED.
async function approveBrowserLogin(userId, code) {
  const row = await loginRequest(code);
  if (row.status !== 'pending') throw appError(409, 'ALREADY_USED', 'Этот код уже использован');
  const updated = await supabaseFetch(`app_login_requests?code=eq.${code}&status=eq.pending&expires_at=gt.${new Date().toISOString()}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: userId, status: 'approved' }),
  });
  if (!Array.isArray(updated) || !updated.length) throw appError(409, 'ALREADY_USED', 'Этот код уже использован');
  return { deviceName: row.device_name };
}

/**
 * Подтверждение входа с проверкой ограничения из админки — общее для страницы сайта (login-approve)
 * и бота (lg:ok). Ограничен — 403 ACCOUNT_RESTRICTED (не 401: программа не должна стирать сессию).
 */
async function approveLoginChecked(userId, code) {
  const row = await loginRequest(code);
  const restriction = await loginRestriction(userId, row);
  if (restriction) throw appError(403, 'ACCOUNT_RESTRICTED', restriction.message, { until: restriction.until || null });
  return approveBrowserLogin(userId, code);
}

/**
 * Завершить все сеансы аккаунта (сайт и программы): у GoTrue Admin API нет «выйти везде», поэтому открываем
 * сеанс от имени пользователя и зовём logout?scope=global его токеном (как logoutAll в админке).
 * Неподтверждённую почту magic-ссылкой подтверждать нельзя — у такого аккаунта и сеансов нет.
 */
async function endAllSessions(userId) {
  const user = await getAuthUser(userId);
  if (!user) throw appError(404, 'USER_NOT_FOUND', 'Аккаунт не найден');
  if (!user.email_confirmed_at) return { ended: false };
  const session = await sessionForUser(userId);
  await authRequest('logout?scope=global', { token: session.access_token });
  return { ended: true };
}

// Программа опрашивает, пока человек не подтвердит вход на сайте.
async function pollBrowserLogin(code, secret) {
  const row = await loginRequest(code);
  const expected = Buffer.from(row.poll_secret_hash);
  const given = Buffer.from(hashSecret(secret));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw appError(403, 'FORBIDDEN', 'Неверный запрос входа');
  if (row.status === 'pending') return { status: 'pending' };
  if (row.status !== 'approved' || !row.user_id) throw appError(409, 'ALREADY_USED', 'Этот код уже использован');
  const updated = await supabaseFetch(`app_login_requests?code=eq.${code}&status=eq.approved`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'consumed' }),
  });
  if (!updated.length) throw appError(409, 'ALREADY_USED', 'Этот код уже использован');
  const session = await sessionForUser(row.user_id);
  return { status: 'approved', session, userId: row.user_id, deviceHash: row.device_hash, deviceName: row.device_name, appVersion: row.app_version };
}

// --- Регистрация и пароль прямо из программы ---

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function checkPassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw appError(400, 'WEAK_PASSWORD', 'Пароль — не короче 8 символов');
  if (value.length > 72) throw appError(400, 'WEAK_PASSWORD', 'Пароль — не длиннее 72 символов');
  if (!/[A-Za-zА-Яа-яЁё]/.test(value) || !/\d/.test(value)) throw appError(400, 'WEAK_PASSWORD', 'В пароле нужны буквы и цифры');
  return value;
}

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(value) || value.length > 320) throw appError(400, 'VALIDATION_ERROR', 'Введите корректную почту');
  return value;
}

/**
 * Регистрация: Supabase шлёт письмо со ссылкой, программа опрашивает signup/poll и входит
 * сама, как только почта подтверждена. Пароль в программе не хранится. Ответ одинаковый,
 * есть такой аккаунт или нет, — по нему нельзя узнать, зарегистрирована ли почта.
 */
async function startSignup({ email, password, deviceHash, deviceName, version, origin }) {
  const login = normalizeEmail(email);
  const pass = checkPassword(password);
  let data;
  try {
    data = await authRequest(`signup?redirect_to=${encodeURIComponent(`${origin}/app-login?confirmed=1`)}`, {
      body: { email: login, password: pass },
    });
  } catch (error) {
    if (error.authCode === 'weak_password') throw appError(400, 'WEAK_PASSWORD', 'Пароль слишком простой — добавьте символов');
    if (error.authCode === 'over_email_send_rate_limit' || error.status === 429) throw appError(429, 'RATE_LIMITED', 'Слишком много писем. Подождите пару минут и попробуйте снова');
    if (error.authCode === 'user_already_exists' || error.authCode === 'email_exists') data = {};
    else if (error.status === 400 || error.status === 422) throw appError(400, 'VALIDATION_ERROR', 'Не удалось зарегистрироваться с этой почтой');
    else throw error;
  }
  // Подтверждение почты выключено — сразу готовая сессия.
  if (data.access_token) return { session: data, userId: data.user?.id };
  const userId = data.user?.id || data.id || null;
  const secret = crypto.randomBytes(32).toString('base64url');
  const rows = await supabaseFetch('app_signup_requests', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      email: login,
      poll_secret_hash: hashSecret(secret),
      device_hash: deviceHash,
      device_name: String(deviceName || 'Компьютер').slice(0, 80),
      app_version: String(version || '').slice(0, 32),
      user_id: userId && await getAuthUser(userId) ? userId : null,
    }),
  });
  return { id: rows[0].id, secret, email: login };
}

async function signupRequest(id, secret) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw appError(400, 'VALIDATION_ERROR', 'Некорректный запрос');
  const rows = await supabaseFetch(`app_signup_requests?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  const row = rows[0];
  if (!row) throw appError(404, 'NOT_FOUND', 'Запрос регистрации не найден');
  const expected = Buffer.from(row.poll_secret_hash);
  const given = Buffer.from(hashSecret(secret));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw appError(403, 'FORBIDDEN', 'Неверный запрос');
  if (new Date(row.expires_at) <= new Date()) throw appError(410, 'EXPIRED', 'Ссылка устарела. Зарегистрируйтесь ещё раз.');
  return row;
}

// Почта подтверждена → сессия (как вход через браузер). Иначе pending.
async function pollSignup(id, secret) {
  const row = await signupRequest(id, secret);
  if (row.consumed_at) throw appError(409, 'ALREADY_USED', 'Вход уже выполнен. Войдите по почте и паролю.');
  if (!row.user_id) return { status: 'pending' };
  const user = await getAuthUser(row.user_id);
  if (!user?.email_confirmed_at) return { status: 'pending' };
  const updated = await supabaseFetch(`app_signup_requests?id=eq.${encodeURIComponent(id)}&consumed_at=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ consumed_at: new Date().toISOString() }),
  });
  if (!updated.length) throw appError(409, 'ALREADY_USED', 'Вход уже выполнен. Войдите по почте и паролю.');
  const session = await sessionForUser(row.user_id);
  return { status: 'approved', session, userId: row.user_id, deviceHash: row.device_hash, deviceName: row.device_name, appVersion: row.app_version };
}

async function resendSignup(id, secret, origin) {
  const row = await signupRequest(id, secret);
  await authRequest(`resend?redirect_to=${encodeURIComponent(`${origin}/app-login?confirmed=1`)}`, { body: { type: 'signup', email: row.email } })
    .catch(error => {
      if (error.status === 429 || error.authCode === 'over_email_send_rate_limit') throw appError(429, 'RATE_LIMITED', 'Письмо уже отправлено. Подождите минуту.');
    });
  return { ok: true };
}

// Письмо со ссылкой на смену пароля (страница сайта). Ответ всегда «отправили».
async function sendPasswordReset(email, origin) {
  const login = normalizeEmail(email);
  await authRequest(`recover?redirect_to=${encodeURIComponent(`${origin}/reset-password`)}`, { body: { email: login } }).catch(() => {});
  return { ok: true };
}

async function changePassword(user, current, next) {
  if (technicalEmail(user.email)) throw appError(400, 'NO_PASSWORD', 'У аккаунта Telegram нет пароля. Задайте почту в кабинете на сайте.');
  const pass = checkPassword(next);
  const session = await passwordLogin(user.email, String(current || '')).catch(error => {
    if (error.code === 'BAD_CREDENTIALS') throw appError(401, 'BAD_PASSWORD', 'Текущий пароль неверный');
    throw error;
  });
  await authRequest('user', { method: 'PUT', token: session.access_token, body: { password: pass } }).catch(error => {
    if (error.authCode === 'same_password') throw appError(400, 'SAME_PASSWORD', 'Новый пароль совпадает со старым');
    if (error.authCode === 'weak_password') throw appError(400, 'WEAK_PASSWORD', 'Пароль слишком простой');
    throw error;
  });
  await logout(session.access_token);
  return { ok: true };
}

// Выйти на всех других ПК: их сессии закрываются, сами ПК отключаются от аккаунта.
async function logoutOthers(user, currentDeviceId) {
  await authRequest('logout?scope=others', { token: user._accessToken }).catch(() => {});
  await supabaseFetch(`app_devices?user_id=eq.${encodeURIComponent(user.id)}&revoked_at=is.null&id=neq.${encodeURIComponent(currentDeviceId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  return { ok: true };
}

module.exports = {
  changePassword,
  requireAllowed,
  setDeviceAccess,
  setDeviceRole,
  entitlementsFor,
  isUnlimited,
  logoutOthers,
  pollSignup,
  resendSignup,
  sendPasswordReset,
  startSignup,
  leaseRights,
  accountSummary,
  appError,
  approveBrowserLogin,
  approveLoginChecked,
  deviceNotMeData,
  endAllSessions,
  loginProgram,
  loginRestriction,
  notifyNewDevice,
  claimKey,
  consumeCode,
  consumeKey,
  authorizeCodeAttempt,
  billClientCode,
  chargeClientCode,
  billCode,
  dbErrorCode,
  deviceHashFrom,
  deviceKeyFrom,
  issueDeviceKey,
  requireDeviceByKey,
  setAlertSound,
  ALERT_SOUNDS,
  listDevices,
  logout,
  magicTokenHash,
  normalizeLoginCode,
  passwordLogin,
  pollBrowserLogin,
  refreshSession,
  registerDevice,
  requireDevice,
  renameDevice,
  revokeDevice,
  sessionPayload,
  sessionForUser,
  startBrowserLogin,
  usageHistory,
  loginRequest,
};
