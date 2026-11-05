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

// Код клиента только с подтверждением владельца в Telegram-боте (server/_code-approvals.js): включён →
// /api/app/client-qr для вошедшего аккаунта отвечает 403 APPROVAL_REQUIRED, программа шлёт запрос владельцу.
const CODE_VIA_BOT_KEY = 'app_code_via_bot';

async function codeViaBotEnabled() {
  return readFlag(CODE_VIA_BOT_KEY);
}
async function codeViaBotState() {
  return { enabled: await codeViaBotEnabled() };
}
async function setCodeViaBot(enabled) {
  await writeFlag(CODE_VIA_BOT_KEY, enabled === true);
  return { enabled: enabled === true };
}

// Индивидуальное исключение: user_profiles.app_code_via_bot_off = true → этому аккаунту код выдаётся напрямую
// даже при включённом глобальном флаге (владелец без Telegram). Ставится из админки на странице пользователя.
async function codeViaBotOffForUser(userId) {
  if (!userId) return false;
  try {
    const rows = await supabaseFetch(`user_profiles?user_id=eq.${encodeURIComponent(userId)}&select=app_code_via_bot_off&limit=1`);
    return rows.length ? rows[0].app_code_via_bot_off === true : false;
  } catch {
    return false;
  }
}

/** Итог для конкретного аккаунта: глобальный флаг включён И у аккаунта нет индивидуального исключения. */
async function codeViaBotEnabledFor(userId) {
  if (!await codeViaBotEnabled()) return false;
  return !(await codeViaBotOffForUser(userId));
}

async function setCodeViaBotOffForUser(userId, off) {
  await supabaseFetch('user_profiles', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ user_id: userId, app_code_via_bot_off: off === true, updated_at: new Date().toISOString() }),
  });
  return { off: off === true };
}

/** Для тестов: забыть кэшированные значения. */
function clearFlagCache() { cache.clear(); }

module.exports = { readFlag, writeFlag, clearFlagCache, crackFallbackEnabled, crackFallbackState, setCrackFallback, codeViaBotEnabled, codeViaBotState, setCodeViaBot, codeViaBotOffForUser, codeViaBotEnabledFor, setCodeViaBotOffForUser };
