// Кнопки под уведомлениями — сообщениями, которые бот или сайт присылают сами (оплата прошла, вознаграждение,
// напоминания, выдачи и сообщения из админки). Обычная кнопка редактирует своё сообщение — и уведомление
// пропадает из чата. Поэтому у таких кнопок callback_data с префиксом n:<обычный callback>: бот снимает кнопки
// с уведомления (текст остаётся) и открывает экран новым сообщением (handleCallback в _telegram-wb-bot.js).
// Кнопки-действия над самим уведомлением («✅ Выдать», «🚫 Это не я») префикс не получают.
// Сообщения шлёт и сайт, а кнопки обрабатывает узел бота — выкладывать узел бота раньше сайта.

const NOTICE_PREFIX = 'n:';
// Лимит callback_data у Telegram — 64 байта: не влезло с префиксом — кнопка остаётся обычной.
const CALLBACK_LIMIT = 64;

function noticeData(data) {
  const value = String(data || '');
  if (!value || value.startsWith(NOTICE_PREFIX)) return value;
  const prefixed = `${NOTICE_PREFIX}${value}`;
  return Buffer.byteLength(prefixed) <= CALLBACK_LIMIT ? prefixed : value;
}

/** Ряды inline-кнопок уведомления: callback_data → n:<callback>, ссылки и прочие кнопки — как есть. */
function noticeRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => (Array.isArray(row) ? row : []).map(button => (
    button && typeof button.callback_data === 'string' ? { ...button, callback_data: noticeData(button.callback_data) } : button
  )));
}

/** reply_markup уведомления ({ inline_keyboard }) с кнопками-переходами n:<callback>. */
function noticeMarkup(markup) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  return { ...markup, inline_keyboard: noticeRows(markup.inline_keyboard) };
}

/** Кнопки, которые остаются под уведомлением после нажатия n:-кнопки: всё, кроме переходов. */
function keptRows(markup) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : [];
  return rows
    .map(row => (Array.isArray(row) ? row : []).filter(button => !String(button?.callback_data || '').startsWith(NOTICE_PREFIX)))
    .filter(row => row.length);
}

module.exports = { NOTICE_PREFIX, keptRows, noticeData, noticeMarkup, noticeRows };
