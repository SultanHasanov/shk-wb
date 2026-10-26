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
const { ADDONS, PLANS, accountLimits, addonAllowed, effectiveFeatures, isPlan, mirrorLimit } = require('./_app-plans');
const { createNotification } = require('./_notifications');
const { appFreeMode, appFreeUntil, appFreeWindow } = require('./_app-free');
const { crackFallbackEnabled } = require('./_app-flags');

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

// Аккаунты без лимитов и оплаты (владелец сервиса): APP_UNLIMITED_USER_IDS — UUID через запятую.
// Всё открыто бессрочно, подборы не списываются, ПК и пунктов — сколько угодно.
function isUnlimited(userId) {
  if (!userId) return false;
  return String(process.env.APP_UNLIMITED_USER_IDS || '')
    .split(/[\s,]+/).filter(Boolean).map(s => s.toLowerCase())
    .includes(String(userId).toLowerCase());
}

// Фича «mirror» = есть хотя бы один зеркальный пункт (у безлимита — всегда).
function withMirror(features, mirror) {
  return mirror > 0 && !features.includes('mirror') ? [...features, 'mirror'] : features;
}

// Права аккаунта целиком: тариф, услуги, фичи и лимиты ПК/пунктов.
async function entitlementsFor(userId) {
  const [ent, free] = await Promise.all([
    supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) }),
    appFreeMode(),
  ]);
  const unlimited = isUnlimited(userId);
  const plan = isPlan(ent.plan) ? ent.plan : null;
  const addons = ent.addons && typeof ent.addons === 'object' ? ent.addons : {};
  const all = free || unlimited;
  const mirror = mirrorLimit(plan, addons, unlimited);
  return {
    ent, free, unlimited, plan, addons, mirror,
    features: withMirror(effectiveFeatures(plan, addons, all), mirror),
    limits: accountLimits(plan, addons, ent.device_limit, all),
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

// Письмо и уведомление в кабинете «вход с нового компьютера»: если это не вы — отключите ПК.
async function notifyNewDevice(userId, name) {
  const user = await getAuthUser(userId).catch(() => null);
  const when = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  await createNotification({
    userId,
    kind: 'system',
    title: 'Вход в «Помощник ПВЗ» с нового компьютера',
    body: `Компьютер «${String(name || 'Компьютер').slice(0, 80)}» вошёл в ваш аккаунт ${when} (МСК). Если это были не вы — отключите его в кабинете (Подписка → Компьютеры) и смените пароль.`,
    link: '/cabinet/subscription',
    dedupeKey: `app-device:${userId}:${Date.now()}`,
    email: technicalEmail(user?.email) ? null : user.email,
  }).catch(() => {});
}

async function deviceKnown(userId, deviceHash) {
  const rows = await supabaseFetch(`app_devices?user_id=eq.${encodeURIComponent(userId)}&device_hash=eq.${deviceHash}&select=id&limit=1`).catch(() => [1]);
  return rows.length > 0;
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
async function registerDevice(userId, deviceHash, name, version) {
  const known = await deviceKnown(userId, deviceHash);
  const id = await registerDeviceLimited(userId, deviceHash, known ? '' : name, version);
  if (!known) await notifyNewDevice(userId, name);
  return id;
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

// ПК, с которого пришёл запрос программы; без него — 401 DEVICE_REVOKED.
async function requireDevice(req, userId) {
  const hash = deviceHashFrom(req);
  if (!hash) throw appError(400, 'DEVICE_REQUIRED', 'Обновите программу');
  const rows = await supabaseFetch(`app_devices?user_id=eq.${encodeURIComponent(userId)}&device_hash=eq.${hash}&revoked_at=is.null&select=id,name,last_seen_at&limit=1`);
  if (!rows.length) throw appError(401, 'DEVICE_REVOKED', 'Этот компьютер отключён от аккаунта. Войдите снова.');
  const device = rows[0];
  if (Date.now() - new Date(device.last_seen_at).getTime() > 10 * 60 * 1000) {
    await supabaseFetch(`app_devices?id=eq.${device.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_seen_at: new Date().toISOString(), app_version: String(req.headers['x-app-version'] || '').slice(0, 32) }),
    }).catch(() => {});
  }
  return device;
}

async function listDevices(userId, currentHash) {
  const rows = await supabaseFetch(`app_devices?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=id,device_hash,name,app_version,last_seen_at,created_at&order=last_seen_at.desc`);
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    appVersion: row.app_version,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    current: Boolean(currentHash && row.device_hash === currentHash),
  }));
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
  const [ent, profiles, telegram, packs, stickerCodes, devices, free, freeUntil, freeWin, points, crackFallback] = await Promise.all([
    supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: user.id }) }),
    supabaseFetch(`user_profiles?user_id=eq.${uid}&select=display_name,phone&limit=1`).catch(() => []),
    supabaseFetch(`user_telegram_identities?user_id=eq.${uid}&select=username,first_name&limit=1`).catch(() => []),
    supabaseFetch(`license_keys?owner_user_id=eq.${uid}&active=eq.true&select=key,usage_limit,used,created_at&order=created_at.asc`),
    supabaseFetch(`sticker_access_codes?owner_user_id=eq.${uid}&active=eq.true&app_subscription_id=is.null&select=generation_limit,generation_used`),
    listDevices(user.id, currentHash),
    appFreeMode(),
    appFreeUntil(),
    appFreeWindow(),
    supabaseFetch(`app_points?user_id=eq.${uid}&revoked_at=is.null&select=id,wb_point_id,name,last_sync_at,mirror_at,created_at&order=created_at.asc`).catch(() => []),
    crackFallbackEnabled().catch(() => false),
  ]);
  const unlimited = isUnlimited(user.id);
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
      telegram: tg ? { username: tg.username || null } : null,
    },
    // Бесплатный режим (админка): всем вошедшим — Про. Программа читает поле plan первым.
    freeMode: free,
    freeUntil: free ? freeUntil : null,
    // Безлимитный аккаунт: всё открыто бессрочно, оплаты не нужны.
    unlimited,
    // Переключатели из админки (резервный подбор кода и т.п.).
    flags: { crackFallback: crackFallback === true },
    ...(all ? { plan: 'pro' } : {}),
    // Итоговые разделы программы: тариф + активные услуги (в бесплатном режиме — всё).
    features: withMirror(effectiveFeatures(plan, rawAddons, all), mirrorLimit(plan, rawAddons, unlimited)),
    // Услуги: куплена до endsAt; active = действует сейчас (на тарифе ниже нужного — false).
    addons: Object.values(ADDONS).map(a => {
      const endsAt = rawAddons[a.id]?.ends_at || null;
      return {
        id: a.id,
        kind: a.kind || 'service',
        title: a.title,
        endsAt,
        active: (all && a.kind !== 'pack') || Boolean(endsAt && addonAllowed(a.id, plan)),
        needsPlan: !all && Boolean(endsAt) && !addonAllowed(a.id, plan) ? a.minPlan : null,
      };
    }),
    // Без подписки, но с пакетами подбор кода всё равно работает — как «Базовый» без квоты.
    effectivePlan: all ? 'pro' : plan || (packsLeft > 0 ? 'basic' : null),
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
    quota: plan ? {
      windowStart: ent.window_start,
      resetAt: ent.window_end,
      codes: { used: Number(ent.codes_used || 0), limit: Number(ent.codes_limit || 0) },
      stickers: { used: Number(ent.stickers_used || 0), limit: Number(ent.stickers_limit || 0) },
    } : null,
    packs: packs.map(row => ({ key: maskKey(row.key), total: row.usage_limit, left: Math.max(0, row.usage_limit - row.used), addedAt: row.created_at })),
    packsLeft,
    stickerPacksLeft: stickerCodes.reduce((sum, row) => sum + Math.max(0, Number(row.generation_limit || 0) - Number(row.generation_used || 0)), 0),
    deviceLimit: accountLimits(plan, rawAddons, ent.device_limit, all).devices,
    pointLimit: accountLimits(plan, rawAddons, ent.device_limit, all).points,
    // сколько пунктов можно загружать на другие ПК (пакеты «Загрузка с другого ПК»)
    mirrorLimit: mirrorLimit(plan, rawAddons, unlimited),
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
  if (!user) return { user: null, plan: null, features: [], archive_until: null, free: false };
  try {
    await requireDevice(req, user.id);
  } catch (error) {
    if (error.code === 'DEVICE_REVOKED' || error.code === 'DEVICE_REQUIRED') {
      return { user: user.id, plan: null, features: [], archive_until: null, free: false };
    }
    throw error;
  }
  const { free, unlimited, plan, addons, features } = await entitlementsFor(user.id);
  const all = free || unlimited;
  const archiveUntil = all ? null : (features.includes('archive') ? addons.archive?.ends_at || null : null);
  return { user: user.id, plan: all ? 'pro' : plan, features, archive_until: archiveUntil, free: all };
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

async function billClientCode(req, { key, meta, requestId, sid, qrText }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(requestId || ''))) {
    throw appError(400, 'VALIDATION_ERROR', 'Некорректный идентификатор запроса кода');
  }
  const user = await optionalUser(req).catch(() => null);
  const charge = async body => {
    try {
      return await supabaseFetch('rpc/app_code_once', { method: 'POST', body: JSON.stringify(body) });
    } catch (error) {
      if (dbErrorCode(error) === 'LIMIT_EXCEEDED') throw appError(409, 'LIMIT_EXCEEDED', 'Подборы закончились. Докупите пакет или смените тариф.');
      if (dbErrorCode(error) === 'CODE_REQUEST_CONFLICT') throw appError(409, 'CODE_REQUEST_CONFLICT', 'Этот запрос уже использован для другого клиента');
      throw error;
    }
  };
  if (user) {
    const device = await requireDevice(req, user.id);
    if (isUnlimited(user.id) || await appFreeMode()) {
      return { qrText, billing: { via: 'account', ok: true, free: true }, replayed: false };
    }
    return charge({ p_request: requestId, p_user: user.id, p_device: device.id, p_key: null, p_sid: sid, p_qr_text: qrText, p_meta: meta || {} });
  }
  if (!key) throw appError(401, 'AUTH_REQUIRED', 'Войдите в аккаунт или добавьте ключ');
  return charge({ p_request: requestId, p_user: null, p_device: null, p_key: String(key).trim(), p_sid: sid, p_qr_text: qrText, p_meta: meta || {} });
}

/**
 * Один биллинг «подбора» для генерации кода клиента. Вошедший аккаунт — через квоту/пакеты
 * (consumeCode), иначе — по WBPK-ключу из тела. Бросает 401, если ни того, ни другого нет.
 */
async function billCode(req, { key, meta } = {}) {
  const user = await optionalUser(req).catch(() => null);
  if (user) {
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

async function approveBrowserLogin(userId, code) {
  const row = await loginRequest(code);
  if (row.status !== 'pending') throw appError(409, 'ALREADY_USED', 'Этот код уже использован');
  await supabaseFetch(`app_login_requests?code=eq.${code}&status=eq.pending`, {
    method: 'PATCH',
    body: JSON.stringify({ user_id: userId, status: 'approved' }),
  });
  return { deviceName: row.device_name };
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
  claimKey,
  consumeCode,
  consumeKey,
  authorizeCodeAttempt,
  billClientCode,
  billCode,
  dbErrorCode,
  deviceHashFrom,
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
  startBrowserLogin,
  usageHistory,
  loginRequest,
};
