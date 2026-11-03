const { fetchWithRetry } = require('./_fetch-retry');

function botToken() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return token;
}

// Методы, которые безопасно повторить после обрыва сети: при дубле ничего не задваивается.
// sendMessage/sendPhoto/sendDocument/sendMediaGroup не повторяем — второе сообщение хуже, чем его отсутствие.
const RETRY_SAFE_METHODS = new Set(['answerCallbackQuery', 'editMessageText', 'editMessageReplyMarkup', 'editMessageCaption', 'deleteMessage', 'sendChatAction', 'getFile', 'getMe', 'getWebhookInfo', 'setMyCommands']);

/**
 * options.apiBase — релей вместо TELEGRAM_API_BASE (запасной канал для алертов о здоровье бота);
 * options.timeoutMs / options.retries — переопределить сетевые настройки (мониторинг хочет быстрый ответ без повторов).
 */
async function telegramRequest(method, body, options = {}) {
  const token = botToken();
  const relayBase = String(options.apiBase ?? process.env.TELEGRAM_API_BASE ?? '').trim().replace(/\/$/, '');
  const proxiedBody = proxyTelegramMedia(method, body, relayBase);
  const url = relayBase
    ? `${relayBase}/api/${method}`
    : `https://api.telegram.org/bot${token}/${method}`;
  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(relayBase ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(proxiedBody),
  }, { retries: options.retries ?? (RETRY_SAFE_METHODS.has(method) ? 1 : 0), timeoutMs: options.timeoutMs, label: `telegram ${method}` });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    const error = new Error(data.description || `Telegram API error (${response.status})`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data.result;
}

function uploadDescriptor(value, fallbackName, fallbackType) {
  if (Buffer.isBuffer(value)) return { buffer: value, filename: fallbackName, contentType: fallbackType };
  if (value && Buffer.isBuffer(value.buffer)) return { buffer: value.buffer, filename: value.filename || fallbackName, contentType: value.contentType || fallbackType };
  return null;
}

async function telegramUpload(method, field, chatId, media, options, fallbackName, fallbackType) {
  const upload = uploadDescriptor(media, fallbackName, fallbackType);
  if (!upload) return telegramRequest(method, { chat_id: chatId, [field]: media, ...options });
  const form = new FormData();
  form.set('chat_id', String(chatId));
  for (const [key, value] of Object.entries(options || {})) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  form.set(field, new Blob([upload.buffer], { type: upload.contentType }), upload.filename);
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    const error = new Error(data.description || `Telegram API error (${response.status})`);
    error.status = response.status; error.details = data; throw error;
  }
  return data.result;
}

function proxyMediaUrl(value, relayBase) {
  if (!relayBase || typeof value !== 'string') return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'shk-wb.ru') return value;
  if (!['/api/stickers/image', '/api/stickers/pdf'].includes(url.pathname)) return value;
  // Путём, а не ?url=: релей на Caddy (tg.shk-wb.ru:88) умеет только так; Supabase-релей понимает обе формы.
  return `${relayBase}/media${url.pathname}${url.search}`;
}

function proxyTelegramMedia(method, body, relayBase) {
  if (!body || typeof body !== 'object') return body;
  if (method === 'sendPhoto') {
    return { ...body, photo: proxyMediaUrl(body.photo, relayBase) };
  }
  if (method === 'sendDocument') {
    return { ...body, document: proxyMediaUrl(body.document, relayBase) };
  }
  if (method === 'sendMediaGroup' && Array.isArray(body.media)) {
    return {
      ...body,
      media: body.media.map(item => ({ ...item, media: proxyMediaUrl(item.media, relayBase) })),
    };
  }
  return body;
}

function sendMessage(chatId, text, options = {}) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  });
}

function editMessageText(chatId, messageId, text, options = {}) {
  return telegramRequest('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  });
}

function sendPhoto(chatId, photo, options = {}) {
  return telegramUpload('sendPhoto', 'photo', chatId, photo, options, 'sticker.png', 'image/png');
}

function sendMediaGroup(chatId, urls) {
  return telegramRequest('sendMediaGroup', {
    chat_id: chatId,
    media: urls.map(media => ({ type: 'photo', media })),
  });
}

function sendDocument(chatId, document, options = {}) {
  return telegramUpload('sendDocument', 'document', chatId, document, options, 'stickers.pdf', 'application/pdf');
}

// Подтверждение нажатия кнопки. Если бот ответил позже ~15 с (медленный WB, сеть), Telegram
// отвечает «query is too old» — само действие при этом выполнять нужно, поэтому не падаем.
async function answerCallbackQuery(callbackQueryId, text) {
  try {
    return await telegramRequest('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  } catch (error) {
    if (/query is too old|query ID is invalid/i.test(String(error.message))) return null;
    throw error;
  }
}

async function deleteMessage(chatId, messageId) {
  try {
    await telegramRequest('deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch (error) {
    console.warn('Telegram message deletion failed', error.message);
  }
}

/**
 * Скачать файл из сообщения (фото, документ) по file_id. С VPS api.telegram.org недоступен —
 * тогда и getFile, и сам файл идут через релей (GET <релей>/file?path=…, тот же Bearer-токен).
 */
async function downloadFile(fileId, { maxBytes = 20 * 1024 * 1024, timeoutMs = 20_000 } = {}) {
  const file = await telegramRequest('getFile', { file_id: fileId });
  const filePath = String(file?.file_path || '');
  if (!filePath) throw new Error('Telegram не отдал путь к файлу');
  if (Number(file.file_size || 0) > maxBytes) throw new Error('Файл слишком большой');
  const token = botToken();
  const relayBase = String(process.env.TELEGRAM_API_BASE || '').trim().replace(/\/$/, '');
  const url = relayBase
    ? `${relayBase}/file?path=${encodeURIComponent(filePath)}`
    : `https://api.telegram.org/file/bot${token}/${filePath}`;
  const response = await fetch(url, {
    headers: relayBase ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Telegram file: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('Файл слишком большой');
  return buffer;
}

module.exports = { answerCallbackQuery, deleteMessage, downloadFile, editMessageText, sendDocument, sendMediaGroup, sendMessage, sendPhoto, telegramRequest };
