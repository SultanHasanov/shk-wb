// Кеш в памяти процесса: связка telegram_user_id → user_id сайта и «технический ли аккаунт».
// Сервер — один процесс, все писатели user_telegram_identities (api/auth.js, api/cabinet.js) живут в нём же
// и зовут forgetTelegramUser — поэтому кеш не расходится с базой. Отрицательный ответ (связки нет) живёт
// недолго: человек только что привязался через Mini App — не заставляем ждать десять минут.

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 5000;

const users = new Map();

function remember(telegramId, userId) {
  const key = Number(telegramId);
  if (!Number.isFinite(key)) return userId;
  if (users.size >= MAX_ENTRIES) users.clear();
  users.set(key, { userId: userId || null, expiresAt: Date.now() + (userId ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  return userId;
}

/** Возвращает { userId } при попадании, undefined — при промахе или протухании. */
function cachedUser(telegramId) {
  const entry = users.get(Number(telegramId));
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) { users.delete(Number(telegramId)); return undefined; }
  return { userId: entry.userId };
}

function forgetTelegramUser(telegramId) {
  users.delete(Number(telegramId));
}

/** Отвязка по user_id (кабинет): telegram_user_id там не известен — вычищаем все записи с этим user_id. */
function forgetSiteUser(userId) {
  for (const [key, entry] of users) if (entry.userId === userId) users.delete(key);
}

function clearTelegramUserCache() { users.clear(); }

module.exports = { cachedUser, clearTelegramUserCache, forgetSiteUser, forgetTelegramUser, remember };
