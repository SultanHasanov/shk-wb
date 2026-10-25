// Переключатели «Помощника ПВЗ» в site_settings (кроме бесплатного режима — он в _app-free.js).
// Сейчас один: app_crack_fallback — показывать ли в программе кнопку резервного подбора кода
// по хешам (server/_wb-crack.js). Значение кэшируется на 30 с, как у бесплатного режима.
const { supabaseFetch } = require('./_supabase');

const TTL_MS = 30 * 1000;
const cache = new Map(); // key -> { at, value }

async function readFlag(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const rows = await supabaseFetch(`site_settings?key=eq.${key}&select=value&limit=1`);
    const value = rows.length ? rows[0].value === true : false;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    // База недоступна — отдаём прошлое значение (по умолчанию выключено).
    return hit ? hit.value : false;
  }
}

async function writeFlag(key, value) {
  await supabaseFetch('site_settings', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, value: value === true, updated_at: new Date().toISOString() }),
  });
  cache.set(key, { at: Date.now(), value: value === true });
}

const CRACK_KEY = 'app_crack_fallback';

async function crackFallbackEnabled() {
  return readFlag(CRACK_KEY);
}
async function crackFallbackState() {
  return { enabled: await crackFallbackEnabled() };
}
async function setCrackFallback(enabled) {
  await writeFlag(CRACK_KEY, enabled === true);
  return { enabled: enabled === true };
}

module.exports = { readFlag, writeFlag, crackFallbackEnabled, crackFallbackState, setCrackFallback };
