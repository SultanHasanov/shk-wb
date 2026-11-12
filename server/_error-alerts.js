const os = require('os');
const { sendToAdmins } = require('./_admin-alerts');

// Любая ошибка, которую увидел человек (сбой в боте с кодом, ответ 5xx сайту или программе), — сразу сообщение
// админу в бот (ADMIN_PAYMENT_TELEGRAM_IDS). Одинаковые ошибки за минуту схлопываются: первая уходит сразу,
// повторы считаются и приписываются к следующему сообщению с той же ошибкой. Всего не больше 20 сообщений
// в минуту — дальше Telegram начнёт отвечать 429; пропущенные тоже считаются.
const REPEAT_WINDOW_MS = 60_000;
const MAX_PER_MINUTE = 20;
const repeats = new Map();
let sentTimes = [];
let dropped = 0;

const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nodeName = () => (process.env.BOT_ROLE === 'bot' ? 'узел бота' : 'сайт') + ` · ${os.hostname()}`;

function telegramUserLine(from) {
  if (!from?.id) return null;
  const name = from.username ? `@${from.username}` : ([from.first_name, from.last_name].filter(Boolean).join(' ') || 'Telegram');
  return `<a href="tg://user?id=${Number(from.id)}">${escapeHtml(name)}</a> (${Number(from.id)})`;
}

/**
 * where — что делал человек («Бот: создание стикера», «API POST /api/app»), message — текст ошибки для журнала,
 * incident — код, который увидел человек, who — строка «кто» (HTML), extra — ещё строки (будут экранированы).
 * Никогда не бросает: сбой оповещения не должен ломать ответ человеку.
 */
function reportUserError({ where, message, incident = null, who = null, from = null, extra = [] }) {
  try {
    const now = Date.now();
    const signature = `${where}|${String(message || '').slice(0, 200)}`;
    const prev = repeats.get(signature);
    if (prev && now - prev.at < REPEAT_WINDOW_MS) { prev.count += 1; return; }
    const repeated = prev?.count || 0;
    repeats.set(signature, { at: now, count: 0 });
    if (repeats.size > 500) for (const [key, value] of repeats) if (now - value.at >= REPEAT_WINDOW_MS) repeats.delete(key);

    sentTimes = sentTimes.filter(time => now - time < 60_000);
    if (sentTimes.length >= MAX_PER_MINUTE) { dropped += 1; return; }
    sentTimes.push(now);

    const lines = [`<b>🚨 Ошибка у пользователя</b>`, escapeHtml(where)];
    const whoLine = who || telegramUserLine(from);
    if (whoLine) lines.push(`Кто: ${whoLine}`);
    if (incident) lines.push(`Код: <code>${escapeHtml(incident)}</code>`);
    if (message) lines.push(`<pre>${escapeHtml(String(message).slice(0, 700))}</pre>`);
    for (const line of extra.filter(Boolean)) lines.push(escapeHtml(String(line).slice(0, 300)));
    if (repeated) lines.push(`<i>Та же ошибка ещё ${repeated} раз за прошлую минуту</i>`);
    if (dropped) { lines.push(`<i>Пропущено из-за лимита сообщений: ${dropped}</i>`); dropped = 0; }
    lines.push(`<i>${escapeHtml(nodeName())}</i>`);
    sendToAdmins(lines.join('\n')).catch(() => {});
  } catch (error) {
    console.error('reportUserError failed', error?.message || error);
  }
}

/** Текст ошибки с подробностями ответа Supabase (code/message/details), чтобы по сообщению было видно причину. */
function errorText(error) {
  if (!error) return '';
  const parts = [error.code, error.message].filter(Boolean);
  const details = error.details;
  if (details) parts.push(typeof details === 'string' ? details : JSON.stringify(details));
  return parts.join(' · ');
}

module.exports = { errorText, reportUserError, telegramUserLine };
