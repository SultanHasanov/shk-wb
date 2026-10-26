function botToken() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return token;
}

async function telegramRequest(method, body) {
  const token = botToken();
  const relayBase = String(process.env.TELEGRAM_API_BASE || '').trim().replace(/\/$/, '');
  const proxiedBody = proxyTelegramMedia(method, body, relayBase);
  const url = relayBase
    ? `${relayBase}/api/${method}`
    : `https://api.telegram.org/bot${token}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(relayBase ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(proxiedBody),
  });
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
  return `${relayBase}/media?url=${encodeURIComponent(url.toString())}`;
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

module.exports = { answerCallbackQuery, deleteMessage, editMessageText, sendDocument, sendMediaGroup, sendMessage, sendPhoto, telegramRequest };
