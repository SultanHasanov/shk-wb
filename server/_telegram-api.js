function botToken() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return token;
}

async function telegramRequest(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

function sendMessage(chatId, text, options = {}) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  });
}

function sendPhoto(chatId, photo, options = {}) {
  return telegramRequest('sendPhoto', { chat_id: chatId, photo, ...options });
}

function sendMediaGroup(chatId, urls) {
  return telegramRequest('sendMediaGroup', {
    chat_id: chatId,
    media: urls.map(media => ({ type: 'photo', media })),
  });
}

function sendDocument(chatId, document, options = {}) {
  return telegramRequest('sendDocument', { chat_id: chatId, document, ...options });
}

function answerCallbackQuery(callbackQueryId, text) {
  return telegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

async function deleteMessage(chatId, messageId) {
  try {
    await telegramRequest('deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch (error) {
    console.warn('Telegram message deletion failed', error.message);
  }
}

module.exports = { answerCallbackQuery, deleteMessage, sendDocument, sendMediaGroup, sendMessage, sendPhoto, telegramRequest };
