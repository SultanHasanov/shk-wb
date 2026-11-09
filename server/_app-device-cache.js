// Короткая память о ПК и токенах для фоновых запросов «Помощника ПВЗ»: каждый ПК обращается к серверу
// много раз в минуту, и проверка токена и строки app_devices была почти половиной запросов к Supabase.
//
// Записи держатся TTL_MS. Сервер — один процесс (selfhost), поэтому:
//   - любая запись в app_devices очищает память ПК сразу (_supabase.js) — отключение и смена прав действуют мгновенно;
//   - токен проверяется заново не позже чем через TTL_MS, поэтому смена пароля или блокировка действует с этой задержкой.
const TTL_MS = 120_000;
const MAX_ENTRIES = 5000;

const devices = new Map();
const tokens = new Map();
let epoch = 0; // растёт с каждой записью: чтение, начатое до неё, не имеет права сохранить старую строку

function read(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.until <= Date.now()) {
    map.delete(key);
    return null;
  }
  return entry.value;
}

function write(map, key, value, until) {
  if (map.size >= MAX_ENTRIES) map.clear();
  map.set(key, { value, until });
}

function currentEpoch() {
  return epoch;
}

function getDevice(key) {
  return read(devices, key);
}

/** seenEpoch — currentEpoch() до запроса к базе. */
function putDevice(key, value, seenEpoch) {
  if (seenEpoch === epoch) write(devices, key, value, Date.now() + TTL_MS);
}

function clearDevices() {
  epoch += 1;
  devices.clear();
}

function getToken(hash) {
  return read(tokens, hash);
}

/** expiresAtMs — срок самого токена: память не должна его продлевать. */
function putToken(hash, user, expiresAtMs) {
  const until = Math.min(Date.now() + TTL_MS, expiresAtMs);
  if (until > Date.now()) write(tokens, hash, user, until);
}

function forgetToken(hash) {
  tokens.delete(hash);
}

// Когда ПК последний раз отмечен «в сети»: в строке из памяти last_seen_at не меняется, и без этого ПК отмечался бы на каждый запрос.
const touched = new Map();

function lastTouched(deviceId) {
  return touched.get(deviceId) || 0;
}

function markTouched(deviceId) {
  if (touched.size >= MAX_ENTRIES) touched.clear();
  touched.set(deviceId, Date.now());
}

function resetForTests() {
  devices.clear();
  tokens.clear();
  touched.clear();
}

module.exports = { TTL_MS, clearDevices, currentEpoch, forgetToken, getDevice, getToken, lastTouched, markTouched, putDevice, putToken, resetForTests };
