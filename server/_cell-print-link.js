// Привязка «Печати ячеек» 2.2 к аккаунту сайта: программа после входа сама
// находит/активирует подходящую лицензию, не заставляя вводить ключ руками.
// Логика выбора вынесена сюда; api/cell-print.js только маршрутизирует.
const { supabaseFetch } = require('./_supabase');

const KEY_RE = /^CP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Ключ для показа в списке выбора: CP-••••-••••-ZZZZ. */
function maskKey(key) {
  const parts = String(key).split('-');
  if (parts.length !== 4) return key;
  return `${parts[0]}-••••-••••-${parts[3]}`;
}

function linkError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function dbMessage(error) {
  const detail = error && error.details && typeof error.details === 'object'
    ? String(error.details.message || '')
    : String((error && error.details) || '');
  return detail || String((error && error.message) || '');
}

// Исключения функции activate_cell_print_license → понятные коды для программы.
function activationError(error) {
  const msg = dbMessage(error);
  if (msg.includes('Not owner')) return linkError(403, 'KEY_OWNED', 'Этот ключ привязан к другому аккаунту');
  if (msg.includes('Account required')) return linkError(403, 'ACCOUNT_REQUIRED', 'Ключ требует входа в аккаунт владельца');
  if (msg.includes('License expired') || msg.includes('expired')) return linkError(403, 'KEY_EXPIRED', 'Срок ключа истёк');
  if (msg.includes('Device limit')) return linkError(409, 'DEVICE_LIMIT', 'Достигнут лимит компьютеров у ключа');
  if (msg.includes('Invalid license')) return linkError(404, 'KEY_NOT_FOUND', 'Ключ не найден или отозван');
  if (msg.includes('Invalid device')) return linkError(400, 'VALIDATION_ERROR', 'Проверьте устройство');
  return null;
}

function rpc(fn, args) {
  return supabaseFetch('rpc/' + fn, { method: 'POST', body: JSON.stringify(args) });
}

async function activate({ key, deviceHash, legacyHash, user, deviceName }) {
  const body = { p_key: key, p_device_hash: deviceHash, p_user: user };
  if (legacyHash && legacyHash !== deviceHash) body.p_legacy_hash = legacyHash;
  if (deviceName) body.p_device_name = String(deviceName).slice(0, 80);
  try {
    return await rpc('activate_cell_print_license', body);
  } catch (error) {
    throw activationError(error) || error;
  }
}

function linked(result, key) {
  return {
    status: 'linked',
    key,
    scope: result.marketplaceScope,
    expiresAt: result.expiresAt,
    deviceLimit: result.deviceLimit,
    devicesUsed: result.devicesUsed,
  };
}

/** Зарегистрировать/обновить ПК в реестре аккаунта. Отозванный ПК → DEVICE_REVOKED. */
async function touchDevice(user, deviceHash, name, appVersion) {
  const res = await rpc('cell_print_register_device', {
    p_user: user, p_device_hash: deviceHash, p_name: name || null, p_version: appVersion || null,
  });
  if (res && res.revoked) throw linkError(401, 'DEVICE_REVOKED', 'Этот компьютер отключён в кабинете');
}

/**
 * Выбор лицензии для этого ПК: переданный ключ → уже активная здесь →
 * единственная со свободным местом → иначе choose / full / none.
 */
async function linkDevice({ user, deviceHash, legacyHash, key, deviceName, appVersion, buyUrl }) {
  if (!HEX64.test(deviceHash)) throw linkError(400, 'DEVICE_REQUIRED', 'Обновите программу');
  await touchDevice(user, deviceHash, deviceName, appVersion);

  // Передан конкретный ключ — активируем его (база проверит владельца/замок/срок).
  if (key) {
    if (!KEY_RE.test(key)) throw linkError(400, 'VALIDATION_ERROR', 'Проверьте ключ');
    return linked(await activate({ key, deviceHash, legacyHash, user, deviceName }), key);
  }

  const candidates = await rpc('cell_print_link_candidates', { p_user: user, p_device_hash: deviceHash });

  const active = candidates.find(c => c.thisDevice);
  if (active) return linked(await activate({ key: active.key, deviceHash, legacyHash, user, deviceName }), active.key);

  const free = candidates.filter(c => c.devicesUsed < c.deviceLimit);
  if (free.length === 1) return linked(await activate({ key: free[0].key, deviceHash, legacyHash, user, deviceName }), free[0].key);
  if (free.length > 1) {
    return {
      status: 'choose',
      options: free.map(c => ({ key: c.key, label: maskKey(c.key), scope: c.scope, expiresAt: c.expiresAt, devicesUsed: c.devicesUsed, deviceLimit: c.deviceLimit })),
    };
  }
  // Свободных мест нет: либо все ключи заняты, либо ключей нет вовсе.
  return { status: candidates.length ? 'full' : 'none', buyUrl };
}

async function listDevices(user) {
  return { devices: await rpc('cell_print_devices_list', { p_user: user }) };
}

async function revokeDevice(user, deviceHash) {
  if (!HEX64.test(deviceHash)) throw linkError(400, 'VALIDATION_ERROR', 'Проверьте устройство');
  return rpc('cell_print_revoke_device', { p_user: user, p_device_hash: deviceHash });
}

module.exports = { linkDevice, listDevices, revokeDevice, touchDevice, maskKey, KEY_RE, HEX64 };
