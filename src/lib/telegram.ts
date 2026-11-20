/**
 * Ссылки на Telegram в одном месте: юзернейм бота читался независимо в трёх
 * файлах, и промо-блок генератора добавил бы четвёртое чтение той же env.
 *
 * Фолбэк нужен потому, что промо-блок рендерится безусловно: без переменной
 * окружения на превью-сборке кнопка вела бы на https://t.me/ .
 */
export const BOT_USERNAME = String(import.meta.env.VITE_TELEGRAM_BOT_USERNAME || 'shkwb_bot').replace(/^@/, '');

export const BOT_URL = `https://t.me/${BOT_USERNAME}`;

/** Канал WB Tools — не бот: на него ведут пилюля в шапке и ссылки в футере. */
export const CHANNEL_URL = 'https://t.me/wbtools_ru';

/** Личный Telegram владельца — сюда пишут, когда не проходит оплата. */
export const SUPPORT_USERNAME = 'roma_denosov';
export const SUPPORT_URL = `https://t.me/${SUPPORT_USERNAME}`;

/**
 * Общий чат поддержки (вопросы по программам, боту и сайту) — VITE_SUPPORT_CHAT_URL при сборке, https://t.me/<имя>.
 * Не задан — пусто, и страницы показывают только личку поддержки.
 */
const chatUrl = String(import.meta.env.VITE_SUPPORT_CHAT_URL || '').trim();
export const SUPPORT_CHAT_URL = /^https:\/\/t\.me\/[\w+]+$/.test(chatUrl) ? chatUrl : '';

/** Куда писать с общим вопросом: в чат, если он есть, иначе в личку. */
export const SUPPORT_QUESTION_URL = SUPPORT_CHAT_URL || SUPPORT_URL;
