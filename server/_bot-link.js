// Ссылки t.me/<бот>?start=… для сайта и API программ. Имя бота спрашиваем getMe (у тестового и боевого
// бота оно разное) через релей, с кэшем; запасной путь — TELEGRAM_BOT_USERNAME. Неудачу помним минуту:
// страница входа опрашивает статус каждые 3 с, и каждый опрос не должен ждать таймаут getMe.
const QRCode = require('qrcode');
const { telegramRequest } = require('./_telegram-api');

const MISS_TTL_MS = 60 * 1000;
let cachedUsername = null;
let missUntil = 0;

async function botUsername() {
  if (cachedUsername) return cachedUsername;
  const fallback = process.env.TELEGRAM_BOT_USERNAME || process.env.VITE_TELEGRAM_BOT_USERNAME || null;
  if (Date.now() < missUntil) return fallback ? String(fallback).replace(/^@/, '') : null;
  const me = await telegramRequest('getMe', {}, { timeoutMs: 5000 }).catch(() => null);
  const name = me?.username || fallback;
  if (me?.username) cachedUsername = me.username;
  else missUntil = Date.now() + MISS_TTL_MS;
  return name ? String(name).replace(/^@/, '') : null;
}

/**
 * Вход в программу подтверждением в боте: ссылка t.me/<бот>?start=login_<КОД> и её QR (для ПК без
 * Telegram Desktop — навести камеру телефона). Имени бота нет — { telegramUrl: null, telegramQr: null }.
 */
async function botLoginLink(code) {
  const username = await botUsername();
  if (!username || !/^[A-Z2-9]{8}$/.test(String(code || ''))) return { telegramUrl: null, telegramQr: null };
  const telegramUrl = `https://t.me/${username}?start=login_${code}`;
  const telegramQr = await QRCode.toDataURL(telegramUrl, { width: 240, margin: 1 }).catch(() => null);
  return { telegramUrl, telegramQr };
}

function resetBotLinkCacheForTests() {
  cachedUsername = null;
  missUntil = 0;
}

module.exports = { botLoginLink, botUsername, resetBotLinkCacheForTests };
