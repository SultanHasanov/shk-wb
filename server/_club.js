// ── Скидка 20% участникам «Клуба вопросов» (бот @zara34_help_bot, проект zara-bot) ──
// Подписку на клуб проверяем у zara-bot: GET ZARA_CLUB_CHECK_URL?tg=<telegram id>, заголовок x-club-secret
// (CLUB_CHECK_SECRET) → { active: boolean }. Человеку ничего подтверждать не нужно.
//
// Где действует:
// - Telegram-бот (@shkwb_bot): «Код клиента» и «Кто поставил оценку» — только если человек пришёл по кнопке из
//   группы клуба (/start club_code | club_reviews → club_ref_at в telegram_bot_subscribers, 30 дней). ШК и магазин —
//   без скидки. См. clubDiscount(telegramId) с requireRef по умолчанию.
// - Тариф «Про» программы «Помощник ПВЗ» (api/payments.js, кабинет): аккаунт сайта с привязанным Telegram
//   (user_telegram_identities) и активной подпиской на клуб. Переход по ссылке не нужен — clubUserDiscount(userId).
const { supabaseFetch } = require('./_supabase');

const CLUB_DISCOUNT_PERCENT = 20;
const CLUB_REF_MS = 30 * 24 * 60 * 60 * 1000;
const CLUB_CACHE_MS = 10 * 60 * 1000;
const clubCache = new Map(); // telegramId → { at, active }

// Ключи кеша — как в clubDiscount: `ref:<id>` (с переходом из группы) и `any:<id>` (без него).
function forgetClub(telegramId) {
  clubCache.delete(`ref:${telegramId}`);
  clubCache.delete(`any:${telegramId}`);
}

async function markClubRef(telegramId) {
  // Новая отметка перехода — прежний ответ «скидки нет» из кеша больше не верен.
  forgetClub(telegramId);
  // chat_id лички = id человека; запись обычно уже есть (touchSubscriber), upsert — на случай локального запуска
  await supabaseFetch('telegram_bot_subscribers?on_conflict=telegram_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ telegram_user_id: Number(telegramId), chat_id: Number(telegramId), club_ref_at: new Date().toISOString() }),
  });
}

/** Активна ли подписка на клуб у этого Telegram id (ответ zara-bot). Ошибка → false без кэша. */
async function clubActive(telegramId) {
  const url = process.env.ZARA_CLUB_CHECK_URL, secret = process.env.CLUB_CHECK_SECRET;
  if (!url || !secret || !telegramId) return false;
  const response = await fetch(`${url}?tg=${encodeURIComponent(String(telegramId))}`, { headers: { 'x-club-secret': secret }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`club-check HTTP ${response.status}`);
  return (await response.json())?.active === true;
}

/**
 * Скидка клуба для Telegram: { active, until }. requireRef (по умолчанию) — нужен переход из группы за последние
 * 30 дней (как в боте), until — когда скидка закончится (переход + 30 дней); без requireRef until = null.
 * Ошибка проверки — без скидки (и без кэша, чтобы повторить при следующем действии).
 */
async function clubDiscountInfo(telegramId, { requireRef = true } = {}) {
  if (!process.env.ZARA_CLUB_CHECK_URL || !process.env.CLUB_CHECK_SECRET || !telegramId) return { active: false, until: null };
  const key = `${requireRef ? 'ref' : 'any'}:${telegramId}`;
  const cached = clubCache.get(key);
  if (cached && Date.now() - cached.at < CLUB_CACHE_MS) return { active: cached.active, until: cached.until };
  try {
    let eligible = true, until = null;
    if (requireRef) {
      const rows = await supabaseFetch(`telegram_bot_subscribers?telegram_user_id=eq.${encodeURIComponent(String(telegramId))}&select=club_ref_at&limit=1`);
      const refAt = Date.parse(rows[0]?.club_ref_at || '');
      eligible = Boolean(refAt) && Date.now() - refAt < CLUB_REF_MS;
      if (eligible) until = new Date(refAt + CLUB_REF_MS).toISOString();
    }
    const active = eligible ? await clubActive(telegramId) : false;
    clubCache.set(key, { at: Date.now(), active, until: active ? until : null });
    return { active, until: active ? until : null };
  } catch (error) {
    console.warn('Скидка клуба: проверка не удалась', error?.message || error);
    return { active: false, until: null };
  }
}

/** Положена ли скидка клуба человеку из Telegram (см. clubDiscountInfo). */
async function clubDiscount(telegramId, options) {
  return (await clubDiscountInfo(telegramId, options)).active;
}

/** Скидка клуба для аккаунта сайта: по привязанному Telegram (user_telegram_identities). Нет привязки → false. */
async function clubUserDiscount(userId) {
  if (!userId) return false;
  try {
    const rows = await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(userId)}&select=telegram_user_id&limit=1`);
    const telegramId = rows[0]?.telegram_user_id;
    return telegramId ? await clubDiscount(telegramId, { requireRef: false }) : false;
  } catch (error) {
    console.warn('Скидка клуба: привязка Telegram не прочиталась', error?.message || error);
    return false;
  }
}

/** Цена со скидкой клуба (рубли, без копеек). */
function applyClubDiscount(price) {
  return Math.round(Number(price) * (100 - CLUB_DISCOUNT_PERCENT) / 100);
}

/** Цена с учётом скидки клуба для Telegram: { price, club }. */
async function clubPrice(telegramId, basePrice) {
  const club = await clubDiscount(telegramId);
  return { price: club ? applyClubDiscount(basePrice) : basePrice, club };
}

module.exports = { CLUB_DISCOUNT_PERCENT, CLUB_REF_MS, applyClubDiscount, clubDiscount, clubDiscountInfo, clubPrice, clubUserDiscount, markClubRef };
