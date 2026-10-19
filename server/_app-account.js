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
const { ADDONS, PLANS, addonAllowed, effectiveFeatures, isPlan } = require('./_app-plans');
const { appFreeMode, appFreeUntil } = require('./_app-free');

const DEVICE_RE = /^[a-f0-9]{64}$/;
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
  for (const code of ['DEVICE_LIMIT', 'LIMIT_EXCEEDED', 'INVALID_AMOUNT', 'UNSUPPORTED_KIND']) {
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

async function registerDevice(userId, deviceHash, name, version) {
  if (await appFreeMode()) return registerDeviceFree(userId, deviceHash, name, version);
  try {
    return await supabaseFetch('rpc/app_register_device', {
      method: 'POST',
      body: JSON.stringify({ p_user: userId, p_hash: deviceHash, p_name: String(name || '').slice(0, 80), p_version: String(version || '').slice(0, 32) }),
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
  const rows = await supabaseFetch(`app_devices?user_id=eq.${encodeURIComponent(userId)}&device_hash=eq.${hash}&revoked_at=is.null&select=id,last_seen_at&limit=1`);
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

// Сводка для программы и кабинета.
async function accountSummary(user, currentHash) {
  const uid = encodeURIComponent(user.id);
  const [ent, profiles, telegram, packs, stickerCodes, devices, free, freeUntil] = await Promise.all([
    supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: user.id }) }),
    supabaseFetch(`user_profiles?user_id=eq.${uid}&select=display_name,phone&limit=1`).catch(() => []),
    supabaseFetch(`user_telegram_identities?user_id=eq.${uid}&select=username,first_name&limit=1`).catch(() => []),
    supabaseFetch(`license_keys?owner_user_id=eq.${uid}&active=eq.true&select=key,usage_limit,used,created_at&order=created_at.asc`),
    supabaseFetch(`sticker_access_codes?owner_user_id=eq.${uid}&active=eq.true&app_subscription_id=is.null&select=generation_limit,generation_used`),
    listDevices(user.id, currentHash),
    appFreeMode(),
    appFreeUntil(),
  ]);
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
    ...(free ? { plan: 'pro' } : {}),
    // Итоговые разделы программы: тариф + активные услуги (в бесплатном режиме — всё).
    features: effectiveFeatures(plan, rawAddons, free),
    // Услуги: куплена до endsAt; active = действует сейчас (на тарифе ниже нужного — false).
    addons: Object.values(ADDONS).map(a => {
      const endsAt = rawAddons[a.id]?.ends_at || null;
      return {
        id: a.id,
        title: a.title,
        endsAt,
        active: free || Boolean(endsAt && addonAllowed(a.id, plan)),
        needsPlan: !free && Boolean(endsAt) && !addonAllowed(a.id, plan) ? a.minPlan : null,
      };
    }),
    // Без подписки, но с пакетами подбор кода всё равно работает — как «Базовый» без квоты.
    effectivePlan: free ? 'pro' : plan || (packsLeft > 0 ? 'basic' : null),
    subscription: plan ? {
      plan,
      title: PLANS[plan].title,
      startsAt: ent.starts_at,
      endsAt: ent.ends_at,
      paidUntil: ent.paid_until,
      nextPlan: ent.next_plan || null,
    } : null,
    quota: plan ? {
      windowStart: ent.window_start,
      resetAt: ent.window_end,
      codes: { used: Number(ent.codes_used || 0), limit: Number(ent.codes_limit || 0) },
      stickers: { used: Number(ent.stickers_used || 0), limit: Number(ent.stickers_limit || 0) },
    } : null,
    packs: packs.map(row => ({ key: row.key, total: row.usage_limit, left: Math.max(0, row.usage_limit - row.used) })).filter(p => p.left > 0),
    packsLeft,
    stickerPacksLeft: stickerCodes.reduce((sum, row) => sum + Math.max(0, Number(row.generation_limit || 0) - Number(row.generation_used || 0)), 0),
    deviceLimit: free ? 99 : Number(ent.device_limit || 1),
    devices,
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
  const [ent, free] = await Promise.all([
    supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: user.id }) }),
    appFreeMode(),
  ]);
  const plan = isPlan(ent.plan) ? ent.plan : null;
  const addons = ent.addons && typeof ent.addons === 'object' ? ent.addons : {};
  const features = effectiveFeatures(plan, addons, free);
  const archiveUntil = free ? null : (features.includes('archive') ? addons.archive?.ends_at || null : null);
  return { user: user.id, plan: free ? 'pro' : plan, features, archive_until: archiveUntil, free };
}

async function consumeCode(userId, deviceId, meta) {
  // Бесплатный режим: подбор не списываем ни из квоты, ни из пакетов.
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
  return value;
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

module.exports = {
  leaseRights,
  accountSummary,
  appError,
  approveBrowserLogin,
  claimKey,
  consumeCode,
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
  revokeDevice,
  sessionPayload,
  startBrowserLogin,
  usageHistory,
  loginRequest,
};
