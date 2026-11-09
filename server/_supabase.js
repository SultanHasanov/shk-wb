const { fetchWithRetry } = require('./_fetch-retry');
const deviceCache = require('./_app-device-cache');

let cachedConfig = null;

function getConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase environment variables are not configured');
  // Тесты меняют переменные между случаями — кеш держится, пока значения те же.
  if (!cachedConfig || cachedConfig.rawUrl !== url || cachedConfig.key !== key) cachedConfig = { rawUrl: url, url: url.replace(/\/$/, ''), key };
  return cachedConfig;
}

// Повторять безопасно только идемпотентное: чтение, удаление по фильтру и upsert (on_conflict + Prefer: resolution=…).
// Обычная вставка и RPC при повторе могут задвоить строку или списание — их не повторяем.
function retriesFor(path, options) {
  const method = String(options.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') return 1;
  if (method === 'POST' && /[?&]on_conflict=/.test(path) && /resolution=/.test(String(options.headers?.Prefer || ''))) return 1;
  return 0;
}

// Любая запись о ПК очищает их память (server/_app-device-cache.js) — здесь, а не у каждого вызова, чтобы новое
// место записи нельзя было забыть. keepDeviceCache — только для отметки «был в сети», она прав не меняет.
function changesDevices(path, options) {
  const method = String(options.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || options.keepDeviceCache) return false;
  return /^(app_devices([?/]|$)|rpc\/app_register_device\b)/.test(path);
}

async function request(path, options, extraHeaders) {
  const { url, key } = getConfig();
  const { keepDeviceCache: _keep, ...fetchOptions } = options;
  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    ...extraHeaders,
    ...(options.headers || {}),
  };
  let response;
  try {
    response = await fetchWithRetry(`${url}/rest/v1/${path}`, { ...fetchOptions, headers }, { retries: retriesFor(path, options), label: 'supabase' });
  } finally {
    // и при ошибке: ответ мог потеряться, а запись — пройти
    if (changesDevices(path, options)) deviceCache.clearDevices();
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  if (!response.ok) {
    const error = new Error(`Supabase request failed (${response.status})`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return { response, data };
}

async function supabaseFetch(path, options = {}) {
  const { data } = await request(path, options);
  return data;
}

async function supabaseFetchWithMeta(path, options = {}) {
  const { response, data } = await request(path, options, { Prefer: 'count=exact' });
  const contentRange = response.headers.get('content-range') || '';
  const match = contentRange.match(/\/(\d+|\*)$/);
  return { data, count: match && match[1] !== '*' ? Number(match[1]) : null };
}

function sendApiError(res, error) {
  console.error(error.message, error.details || '');
  return res.status(502).json({ error: 'Database request failed' });
}

module.exports = { retriesFor, sendApiError, supabaseFetch, supabaseFetchWithMeta };
