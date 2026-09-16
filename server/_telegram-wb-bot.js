const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { answerCallbackQuery, deleteMessage, sendDocument, sendMediaGroup, sendMessage, sendPhoto } = require('./_telegram-api');
const { generateStickers, selectAccessCode } = require('./_sticker-generation');
const { PACKAGE_PRICES } = require('./_payments');

const SESSION_TTL_MS = 30 * 60 * 1000;
const HOME_KEYBOARD = {
  keyboard: [
    [{ text: '🏷 Стикеры для товаров' }, { text: '📦 QR для коробок' }],
    [{ text: '➕ Создать ШК' }, { text: '💳 Остаток' }],
    [{ text: '🌐 Открыть сайт', web_app: { url: publicUrl('/') } }, { text: '🆘 Помощь' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

function publicUrl(path) {
  const fallback = process.env.VERCEL_ENV === 'production' ? 'https://shk-wb.vercel.app' : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://shk-wb.vercel.app';
  const origin = String(process.env.PUBLIC_APP_URL || fallback).replace(/\/$/, '');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function claimUpdate(updateId) {
  const rows = await supabaseFetch('telegram_bot_updates?on_conflict=update_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify({ update_id: Number(updateId) }) });
  return Array.isArray(rows) && rows.length > 0;
}

async function findUser(telegramId) {
  const rows = await supabaseFetch(`user_telegram_identities?telegram_user_id=eq.${encodeURIComponent(telegramId)}&select=user_id&limit=1`);
  return rows[0]?.user_id || null;
}

async function getSession(telegramId) {
  const rows = await supabaseFetch(`telegram_generator_sessions?telegram_user_id=eq.${encodeURIComponent(telegramId)}&select=*&limit=1`);
  const session = rows[0] || null;
  if (session && Date.now() - new Date(session.updated_at).getTime() > SESSION_TTL_MS) { await clearSession(telegramId); return null; }
  return session;
}

async function saveSession(from, chatId, state, draft = {}) {
  const rows = await supabaseFetch('telegram_generator_sessions?on_conflict=telegram_user_id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ telegram_user_id: Number(from.id), chat_id: Number(chatId), user_id: draft.userId || null, state, draft, updated_at: new Date().toISOString() }),
  });
  return rows[0];
}

async function clearSession(telegramId) {
  await supabaseFetch(`telegram_generator_sessions?telegram_user_id=eq.${encodeURIComponent(telegramId)}`, { method: 'DELETE' });
}

function choiceKeyboard(rows) { return { inline_keyboard: rows }; }

function kindKeyboard() {
  return choiceKeyboard([[{ text: '🏷 Стикеры товаров', callback_data: 'gen:kind:product' }], [{ text: '📦 QR возвратных коробок', callback_data: 'gen:kind:box' }], [{ text: 'Отмена', callback_data: 'gen:cancel' }]]);
}

function modeKeyboard() {
  return choiceKeyboard([[{ text: 'Пачка по количеству', callback_data: 'gen:mode:range' }], [{ text: 'По конкретному номеру', callback_data: 'gen:mode:custom' }], [{ text: 'Отмена', callback_data: 'gen:cancel' }]]);
}

function quantityKeyboard() {
  return choiceKeyboard([
    [1, 10, 50].map(value => ({ text: String(value), callback_data: `gen:qty:${value}` })),
    [100, 250, 500].map(value => ({ text: String(value), callback_data: `gen:qty:${value}` })),
    [{ text: '⌨️ Ввести другое количество', callback_data: 'gen:qty:manual' }],
    [{ text: 'Отмена', callback_data: 'gen:cancel' }],
  ]);
}

function miniAppKeyboard() {
  return choiceKeyboard([[{ text: '🌐 Открыть сайт', web_app: { url: publicUrl('/') } }], [{ text: 'Войти и привязать Telegram', web_app: { url: publicUrl('/login') } }]]);
}

async function sendLoginPrompt(from, chatId, text) {
  const message = await sendMessage(chatId, text, { reply_markup: miniAppKeyboard() });
  await saveSession(from, chatId, 'choose_kind', { authPromptMessageId: message.message_id });
}

function packageKeyboard() {
  const quantities = Object.keys(PACKAGE_PRICES).map(Number).sort((a, b) => a - b);
  const rows = [];
  for (let index = 0; index < quantities.length; index += 2) {
    rows.push(quantities.slice(index, index + 2).map(quantity => ({ text: `${quantity} шт. — ${PACKAGE_PRICES[quantity]} ₽`, callback_data: `buy:pack:${quantity}` })));
  }
  rows.push([{ text: 'Отмена', callback_data: 'gen:cancel' }]);
  return choiceKeyboard(rows);
}

function requiredUnits(draft) { return draft.mode === 'range' ? Number(draft.quantity) : 1; }

function telegramRequesterHash(telegramId) {
  return crypto.createHmac('sha256', process.env.STICKER_CLIENT_SECRET).update(`telegram:${telegramId}`).digest('hex');
}

function summary(draft) {
  const type = draft.category === 'box' ? 'QR возвратных коробок' : 'стикеры товаров';
  const value = draft.mode === 'range' ? `Количество: <b>${draft.quantity}</b>` : `Номер: <code>${escapeHtml(draft.code)}</code>`;
  return `<b>Проверьте параметры</b>\nТип: ${type}\nРежим: ${draft.mode === 'range' ? 'пачка' : 'конкретный номер'}\n${value}\n\nПосле подтверждения генерации будут списаны из пакета.`;
}

async function requestConfirmation(from, chatId, draft) {
  const units = requiredUnits(draft);
  const accessCode = await selectAccessCode(draft.userId, units);
  if (!accessCode) {
    draft.pendingPurchase = true;
    await saveSession(from, chatId, 'confirm', draft);
    await sendMessage(chatId, `${units > 1 ? 'Для этой пачки недостаточно генераций.' : 'Оплаченных генераций нет.'}\n\nВыберите пакет — после подтверждения откроется только страница оплаты:`, { reply_markup: packageKeyboard() });
    return;
  }
  draft.accessCode = accessCode;
  await saveSession(from, chatId, 'confirm', draft);
  await sendMessage(chatId, summary(draft), { reply_markup: choiceKeyboard([[{ text: '✅ Подтвердить', callback_data: 'gen:confirm' }], [{ text: 'Отмена', callback_data: 'gen:cancel' }]]) });
}

function absoluteAssetUrl(relative, png = false) {
  const suffix = png ? `${relative.includes('?') ? '&' : '?'}format=png` : '';
  return publicUrl(`${relative}${suffix}`);
}

function resultItems(result) {
  return result.items || (result.imageUrl ? [{ code: result.code, imageUrl: result.imageUrl }] : []);
}

function pageKeyboard(requestId, page, totalPages) {
  const row = [];
  if (page > 0) row.push({ text: '⬅️ Назад', callback_data: `gen:page:${requestId}:${page - 1}` });
  if (page + 1 < totalPages) row.push({ text: 'Далее ➡️', callback_data: `gen:page:${requestId}:${page + 1}` });
  return choiceKeyboard([row, [{ text: '➕ Создать ещё', callback_data: 'gen:start' }]].filter(items => items.length));
}

async function sendPreview(chatId, requestId, result, page = 0) {
  const items = resultItems(result), totalPages = Math.ceil(items.length / 4), safePage = Math.max(0, Math.min(page, totalPages - 1));
  const urls = items.slice(safePage * 4, safePage * 4 + 4).map(item => absoluteAssetUrl(item.imageUrl, true));
  if (urls.length === 1) await sendPhoto(chatId, urls[0]);
  else if (urls.length > 1) await sendMediaGroup(chatId, urls);
  await sendMessage(chatId, `Предпросмотр ${safePage + 1} из ${totalPages} · показано ${Math.min(items.length, safePage * 4 + 4)} из ${items.length}`, { reply_markup: pageKeyboard(requestId, safePage, totalPages) });
}

async function claimGenerationRequest(requestId, from, chatId, draft) {
  const rows = await supabaseFetch('telegram_generation_requests?on_conflict=request_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify({ request_id: requestId, telegram_user_id: Number(from.id), chat_id: Number(chatId), user_id: draft.userId, status: 'processing', draft }) });
  return Array.isArray(rows) && rows.length > 0;
}

async function completeGenerationRequest(requestId, result) {
  await supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed', result, completed_at: new Date().toISOString() }) });
}

async function loadGenerationRequest(requestId, telegramId) {
  const rows = await supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}&telegram_user_id=eq.${encodeURIComponent(telegramId)}&status=eq.completed&select=result&limit=1`);
  return rows[0]?.result || null;
}

async function confirmGeneration(callback, session) {
  const from = callback.from, chatId = callback.message.chat.id, draft = session.draft || {};
  const requestId = `${from.id}:${callback.message.message_id}`;
  if (!await claimGenerationRequest(requestId, from, chatId, draft)) { await answerCallbackQuery(callback.id, 'Этот запрос уже обработан'); return; }
  await saveSession(from, chatId, 'generating', draft);
  await sendMessage(chatId, 'Генерирую и подготавливаю PDF…');
  try {
    const requesterHash = telegramRequesterHash(from.id);
    const result = await generateStickers({ ...draft, requesterHash, clientEntryId: `telegram:${requestId}`, channel: 'telegram' });
    await completeGenerationRequest(requestId, result);
    await clearSession(from.id);
    await sendPreview(chatId, requestId, result, 0);
    await sendDocument(chatId, absoluteAssetUrl(result.pdfUrl), { caption: `Готово: ${result.quantity || 1} шт. Осталось генераций: ${result.access?.remaining ?? '—'}` });
  } catch (error) {
    await supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', error: String(error.message || '').slice(0, 500), completed_at: new Date().toISOString() }) }).catch(() => {});
    await clearSession(from.id);
    const noBalance = error.code === 'ACCESS_CODE_LIMIT' || error.code === 'INVALID_ACCESS_CODE';
    await sendMessage(chatId, `Не удалось создать ШК: ${escapeHtml(error.message)}`, { reply_markup: noBalance ? miniAppKeyboard() : HOME_KEYBOARD });
  }
}

async function startGeneration(from, chatId) {
  const userId = await findUser(from.id);
  if (!userId) { await sendLoginPrompt(from, chatId, 'Этот Telegram ещё не привязан к аккаунту. Войдите через Mini App — после привязки эта кнопка исчезнет.'); return; }
  await saveSession(from, chatId, 'choose_kind', { userId });
  await sendMessage(chatId, '<b>Что нужно создать?</b>', { reply_markup: kindKeyboard() });
}

async function startForCategory(from, chatId, category) {
  const userId = await findUser(from.id);
  if (!userId) { await sendLoginPrompt(from, chatId, 'Сначала войдите через Mini App — бот генерирует по вашим пакетам генераций.'); return; }
  await saveSession(from, chatId, 'choose_mode', { userId, category });
  await sendMessage(chatId, `<b>${category === 'box' ? 'QR для возвратных коробок' : 'Стикеры для товаров'}</b>\nВыберите режим генерации:`, { reply_markup: modeKeyboard() });
}

async function showBalance(from, chatId) {
  const userId = await findUser(from.id);
  if (!userId) { await sendMessage(chatId, 'Сначала войдите через Mini App.', { reply_markup: miniAppKeyboard() }); return; }
  const rows = await supabaseFetch(`sticker_access_codes?owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=code,generation_limit,generation_used&order=created_at.asc`);
  const paidRemaining = rows.reduce((sum, row) => sum + Math.max(0, Number(row.generation_limit || 0) - Number(row.generation_used || 0)), 0);
  const details = rows.map(row => `• код <code>${escapeHtml(row.code)}</code>: ${Math.max(0, Number(row.generation_limit || 0) - Number(row.generation_used || 0))}`).join('\n');
  await sendMessage(chatId, `<b>Ваш остаток</b>\n\n💳 В пакетах: <b>${paidRemaining}</b>${details ? `\n\n${details}` : ''}`, { reply_markup: HOME_KEYBOARD });
}

async function showHelp(chatId) {
  await sendMessage(chatId, '<b>Как пользоваться ботом</b>\n\n1. Выберите товарные стикеры или QR коробок.\n2. Выберите один номер или пачку до 500 штук.\n3. Проверьте параметры и подтвердите.\n4. Получите предпросмотр и PDF для печати.\n\nЕсли нужна помощь, напишите в поддержку.', { reply_markup: choiceKeyboard([[{ text: 'Написать в поддержку', url: 'https://t.me/roma_denosov' }]]) });
}

async function notifyMiniAppAuthorized(telegramId) {
  const session = await getSession(telegramId);
  if (session?.draft?.authPromptMessageId) await deleteMessage(session.chat_id, session.draft.authPromptMessageId);
  await clearSession(telegramId);
  await sendMessage(telegramId,
    '<b>Готово — вход выполнен.</b>\n\nВернитесь к генератору в боте.',
    { reply_markup: HOME_KEYBOARD },
  );
}

async function handleCallback(callback) {
  const from = callback.from, chatId = callback.message?.chat?.id;
  if (!chatId) return;
  const data = String(callback.data || '');
  if (data === 'gen:start') { await answerCallbackQuery(callback.id); await startGeneration(from, chatId); return; }
  if (data === 'gen:cancel') { await answerCallbackQuery(callback.id); await clearSession(from.id); await sendMessage(chatId, 'Генерация отменена.', { reply_markup: HOME_KEYBOARD }); return; }
  const pageMatch = data.match(/^gen:page:([^:]+:\d+):(\d+)$/);
  if (pageMatch) { await answerCallbackQuery(callback.id); const result = await loadGenerationRequest(pageMatch[1], from.id); if (!result) return sendMessage(chatId, 'Результат больше недоступен.'); await sendPreview(chatId, pageMatch[1], result, Number(pageMatch[2])); return; }
  const session = await getSession(from.id);
  if (!session) { await answerCallbackQuery(callback.id, 'Сессия истекла'); await sendMessage(chatId, 'Сессия истекла. Начните генерацию заново.', { reply_markup: HOME_KEYBOARD }); return; }
  const draft = session.draft || {};
  const packMatch = data.match(/^buy:pack:(\d+)$/);
  if (packMatch && session.state === 'confirm' && draft.pendingPurchase) {
    const quantity = Number(packMatch[1]), total = PACKAGE_PRICES[quantity];
    await answerCallbackQuery(callback.id);
    if (!total) return;
    draft.purchaseQuantity = quantity;
    await saveSession(from, chatId, 'confirm', draft);
    await sendMessage(chatId, `<b>Покупка пакета</b>\n\n${quantity} ${quantity === 1 ? 'генерация' : 'генераций'} — <b>${total} ₽</b>\n\nНажимая «Подтвердить», вы принимаете <a href="${publicUrl('/offer')}">оферту</a> и <a href="${publicUrl('/privacy')}">политику конфиденциальности</a>.`, { reply_markup: choiceKeyboard([[{ text: '✅ Подтвердить покупку', callback_data: 'buy:confirm' }], [{ text: 'Выбрать другой пакет', callback_data: 'buy:change' }], [{ text: 'Отмена', callback_data: 'gen:cancel' }]]) });
    return;
  }
  if (data === 'buy:change' && session.state === 'confirm' && draft.pendingPurchase) { await answerCallbackQuery(callback.id); await sendMessage(chatId, 'Выберите пакет:', { reply_markup: packageKeyboard() }); return; }
  if (data === 'buy:confirm' && session.state === 'confirm' && draft.pendingPurchase && PACKAGE_PRICES[draft.purchaseQuantity]) {
    await answerCallbackQuery(callback.id); await clearSession(from.id);
    await sendMessage(chatId, `Пакет: ${draft.purchaseQuantity} шт. за ${PACKAGE_PRICES[draft.purchaseQuantity]} ₽. Откройте защищённую оплату:`, { reply_markup: choiceKeyboard([[{ text: '💳 Оплатить', web_app: { url: publicUrl(`/bot-checkout?quantity=${draft.purchaseQuantity}`) } }], [{ text: 'Отмена', callback_data: 'gen:cancel' }]]) });
    return;
  }
  if (data.startsWith('gen:kind:') && session.state === 'choose_kind') { draft.category = data.endsWith(':box') ? 'box' : 'product'; await saveSession(from, chatId, 'choose_mode', draft); await answerCallbackQuery(callback.id); await sendMessage(chatId, '<b>Выберите режим</b>', { reply_markup: modeKeyboard() }); return; }
  if (data.startsWith('gen:mode:') && session.state === 'choose_mode') {
    draft.mode = data.endsWith(':custom') ? 'custom' : 'range';
    if (draft.category === 'box') draft.prefix = 'TRBX';
    const state = draft.mode === 'range' ? 'await_quantity' : 'await_code';
    await saveSession(from, chatId, state, draft); await answerCallbackQuery(callback.id);
    await sendMessage(chatId, state === 'await_quantity' ? '<b>Сколько стикеров создать?</b>\nВыберите быстрый вариант или введите любое целое число от 1 до 500.' : `Введите номер ${draft.category === 'box' ? 'коробки: ровно 10 цифр.' : 'ШК: ровно 11 цифр.'}`, state === 'await_quantity' ? { reply_markup: quantityKeyboard() } : undefined); return;
  }
  if (data.startsWith('gen:qty:') && session.state === 'await_quantity') {
    await answerCallbackQuery(callback.id);
    if (data === 'gen:qty:manual') { await sendMessage(chatId, 'Введите любое целое число от 1 до 500.'); return; }
    const quantity = Number(data.slice('gen:qty:'.length));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) return;
    draft.quantity = quantity; await requestConfirmation(from, chatId, draft); return;
  }
  if (data === 'gen:confirm' && session.state === 'confirm') { await answerCallbackQuery(callback.id); await confirmGeneration(callback, session); return; }
  await answerCallbackQuery(callback.id, 'Кнопка больше неактуальна');
}

async function handleMessage(message) {
  const from = message.from, chatId = message.chat.id, text = String(message.text || '').trim();
  if (message.chat.type !== 'private') return sendMessage(chatId, 'Используйте личный чат с ботом.');
  if (/^\/(start|help)(?:@\w+)?(?:\s+[A-Za-z0-9_-]+)?$/i.test(text)) {
    await clearSession(from.id);
    const userId = await findUser(from.id);
    const intro = `<b>Генератор ШК для Wildberries</b>\n\nБот создаёт:\n• возвратные стикеры для товаров;\n• QR-коды возвратных коробок;\n• одиночные ШК и пачки до 500 штук;\n• готовый PDF для печати.\n\n${userId ? 'Ваш Telegram уже связан с кабинетом.' : 'Чтобы пользоваться пакетами генераций, откройте Mini App и войдите через Telegram.'}`;
    if (userId) await sendMessage(chatId, intro, { reply_markup: HOME_KEYBOARD });
    else await sendLoginPrompt(from, chatId, intro);
    return;
  }
  if (/^\/cancel(?:@\w+)?$/i.test(text)) { await clearSession(from.id); await sendMessage(chatId, 'Генерация отменена.', { reply_markup: HOME_KEYBOARD }); return; }
  if (/^\/generate(?:@\w+)?$/i.test(text)) return startGeneration(from, chatId);
  if (text === '➕ Создать ШК') return startGeneration(from, chatId);
  if (text === '🏷 Стикеры для товаров') return startForCategory(from, chatId, 'product');
  if (text === '📦 QR для коробок') return startForCategory(from, chatId, 'box');
  if (text === '💳 Остаток') return showBalance(from, chatId);
  if (text === '🆘 Помощь') return showHelp(chatId);
  const session = await getSession(from.id);
  if (!session) return sendMessage(chatId, 'Нажмите «Создать ШК».', { reply_markup: HOME_KEYBOARD });
  const draft = session.draft || {};
  if (session.state === 'await_quantity') {
    const quantity = Number(text); if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) return sendMessage(chatId, 'Количество должно быть целым числом от 1 до 500.');
    draft.quantity = quantity; return requestConfirmation(from, chatId, draft);
  }
  if (session.state === 'await_code') {
    const length = draft.category === 'box' ? 10 : 11; if (!new RegExp(`^\\d{${length}}$`).test(text)) return sendMessage(chatId, `Номер должен содержать ровно ${length} цифр.`);
    draft.code = text; return requestConfirmation(from, chatId, draft);
  }
  return sendMessage(chatId, 'Завершите текущее действие или отправьте /cancel.');
}

function validWebhookSecret(req) {
  const expected = String(process.env.TELEGRAM_WEBHOOK_SECRET || ''), actual = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (expected.length < 16 || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

async function handleTelegramUpdate(req, res) {
  if (!validWebhookSecret(req)) return res.status(401).json({ ok: false });
  const update = req.body || {};
  if (!Number.isSafeInteger(Number(update.update_id))) return res.status(400).json({ ok: false });
  try {
    if (!await claimUpdate(update.update_id)) return res.status(200).json({ ok: true, duplicate: true });
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message?.from && update.message?.chat) await handleMessage(update.message);
  } catch (error) {
    console.error('Telegram generator bot failed', error.message);
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) await sendMessage(chatId, 'Произошла внутренняя ошибка. Попробуйте позже.', { reply_markup: HOME_KEYBOARD }).catch(() => {});
  }
  return res.status(200).json({ ok: true });
}

module.exports = { HOME_KEYBOARD, escapeHtml, handleTelegramUpdate, notifyMiniAppAuthorized, publicUrl, validWebhookSecret };
