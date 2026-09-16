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
