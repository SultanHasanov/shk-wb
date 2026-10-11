const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { supabaseFetch } = require('./_supabase');
const { answerCallbackQuery, deleteMessage, sendDocument, sendMediaGroup, sendMessage, sendPhoto } = require('./_telegram-api');
const { generateStickers, selectAccessCode } = require('./_sticker-generation');
const { PACKAGE_PRICES } = require('./_payments');
const { accountHasValuableData, isTechnicalTelegramUser } = require('./_telegram-account');
const wbPvz = require('./_wb-pvz');

const SESSION_TTL_MS = 30 * 60 * 1000;
const GOODS_SNAPSHOT_TTL_MS = 2 * 60 * 1000;
const localWbConnections = new Map();
const localGoodsSnapshots = new Map();
let localConnectionsLoaded = false;

function loadLocalConnections() {
  if (localConnectionsLoaded || process.env.WB_CONNECTION_STORE !== 'file') return;
  localConnectionsLoaded = true;
  const file = process.env.WB_CONNECTION_FILE;
  if (!file) return;
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const row of Array.isArray(rows) ? rows : []) localWbConnections.set(Number(row.telegram_user_id), row);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Cannot read local WB connection store', error.message);
  }
}

function persistLocalConnections() {
  if (process.env.WB_CONNECTION_STORE !== 'file' || !process.env.WB_CONNECTION_FILE) return;
  const file = path.resolve(process.env.WB_CONNECTION_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...localWbConnections.values()]), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}
const HOME_KEYBOARD = {
  keyboard: [
    [{ text: '🏷 Стикеры для товаров' }, { text: '📦 QR для коробок' }],
    [{ text: '➕ Создать ШК' }, { text: '💳 Остаток' }],
    [{ text: '👤 Аккаунт' }, { text: '🆘 Помощь' }],
    [{ text: '⭐ Отзывы ПВЗ' }, { text: '🌐 Открыть сайт', web_app: { url: publicUrl('/') } }],
  ],
  resize_keyboard: true,
  is_persistent: false,
};

function publicUrl(path) {
  const fallback = process.env.VERCEL_ENV === 'production' ? 'https://shk-wb.ru' : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://shk-wb.ru';
  const origin = String(process.env.PUBLIC_APP_URL || fallback).replace(/\/$/, '');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function claimUpdate(updateId) {
  if (process.env.TELEGRAM_LOCAL_POLLING === '1') return true;
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

async function getWbConnection(telegramId) {
  if (process.env.WB_CONNECTION_STORE === 'memory' || process.env.WB_CONNECTION_STORE === 'file') {
    loadLocalConnections();
    const row = localWbConnections.get(Number(telegramId));
    return row ? { ...row, session: wbPvz.decryptSession(row.encrypted_session) } : null;
  }
  const rows = await supabaseFetch(`telegram_wb_connections?telegram_user_id=eq.${encodeURIComponent(telegramId)}&select=*&limit=1`);
  const row = rows[0] || null;
  if (!row) return null;
  try { row.session = wbPvz.decryptSession(row.encrypted_session); }
  catch { row.session = null; }
  return row;
}

async function saveWbConnection(from, chatId, state, session, extra = {}) {
  if (process.env.WB_CONNECTION_STORE === 'memory' || process.env.WB_CONNECTION_STORE === 'file') {
    loadLocalConnections();
    const row = {
      telegram_user_id: Number(from.id), chat_id: Number(chatId), state,
      encrypted_session: session ? wbPvz.encryptSession(session) : null,
      selected_point_id: session?.pointId || null, last_error: extra.lastError || null,
      updated_at: new Date().toISOString(),
    };
    localWbConnections.set(Number(from.id), row);
    persistLocalConnections();
    return row;
  }
  const rows = await supabaseFetch('telegram_wb_connections?on_conflict=telegram_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      telegram_user_id: Number(from.id), chat_id: Number(chatId), state,
      encrypted_session: session ? wbPvz.encryptSession(session) : null,
      selected_point_id: session?.pointId || null, last_error: extra.lastError || null,
      updated_at: new Date().toISOString(),
    }),
  });
  return rows[0];
}

async function deleteWbConnection(telegramId) {
  if (process.env.WB_CONNECTION_STORE === 'memory' || process.env.WB_CONNECTION_STORE === 'file') {
    loadLocalConnections();
    localWbConnections.delete(Number(telegramId));
    persistLocalConnections();
    return;
  }
  await supabaseFetch(`telegram_wb_connections?telegram_user_id=eq.${encodeURIComponent(telegramId)}`, { method: 'DELETE' });
}

/** Сессия генератора исчезает, а эта запись остаётся для статистики и рассылок. */
async function touchSubscriber(from, chatId) {
  if (process.env.TELEGRAM_LOCAL_POLLING === '1') return;
  if (!from?.id || !chatId) return;
  await supabaseFetch('telegram_bot_subscribers?on_conflict=telegram_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      telegram_user_id: Number(from.id),
      chat_id: Number(chatId),
      username: from.username || null,
      first_name: from.first_name || '',
      last_name: from.last_name || null,
      last_seen_at: new Date().toISOString(),
      blocked_at: null,
    }),
  });
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
  return choiceKeyboard([
    [{ text: 'У меня уже есть кабинет', web_app: { url: publicUrl('/telegram-account') } }],
    [{ text: 'Создать кабинет через Telegram', web_app: { url: publicUrl('/login') } }],
    [{ text: '🌐 Открыть сайт', web_app: { url: publicUrl('/') } }],
  ]);
}

function accountKeyboard(canConnect) {
  const rows = [];
  if (canConnect) rows.push([{ text: 'Подключить основной кабинет', web_app: { url: publicUrl('/telegram-account') } }]);
  rows.push([{ text: 'Продолжить с текущим', callback_data: 'account:continue' }]);
  return choiceKeyboard(rows);
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

async function showAccount(from, chatId) {
  const userId = await findUser(from.id);
  if (!userId) {
    await sendMessage(chatId, '<b>Аккаунт не подключён</b>\n\nЕсли вы уже покупали генерации на сайте, войдите в существующий кабинет.', { reply_markup: miniAppKeyboard() });
    return;
  }
  const [rows, hasData, technical] = await Promise.all([
    supabaseFetch(`sticker_access_codes?owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=generation_limit,generation_used`),
    accountHasValuableData(userId),
    isTechnicalTelegramUser(userId),
  ]);
  const paidRemaining = rows.reduce((sum, row) => sum + Math.max(0, Number(row.generation_limit || 0) - Number(row.generation_used || 0)), 0);
  const guidance = technical
    ? hasData
      ? 'Если вы уже пользовались сайтом с другим email, подключите основной кабинет — пакеты и история будут объединены.'
      : 'Если этот кабинет был создан случайно, подключите основной кабинет.'
    : 'Сайт и Telegram используют один кабинет.';
  await sendMessage(chatId, `<b>Аккаунт подключён</b>\n\nДоступно генераций: <b>${paidRemaining}</b>\n\n${guidance}`, { reply_markup: accountKeyboard(technical) });
}

async function showHelp(chatId) {
  await sendMessage(chatId, '<b>Как пользоваться ботом</b>\n\n1. Выберите товарные стикеры или QR коробок.\n2. Выберите один номер или пачку до 500 штук.\n3. Проверьте параметры и подтвердите.\n4. Получите предпросмотр и PDF для печати.\n\nЕсли нужна помощь, напишите в поддержку.', { reply_markup: choiceKeyboard([[{ text: 'Написать в поддержку', url: 'https://t.me/roma_denosov' }]]) });
}

function reviewFilterKeyboard() {
  return choiceKeyboard([
    [1, 2, 3, 4, 5].map(star => ({ text: `${star} ⭐`, callback_data: `rv:filter:${star}` })),
    [{ text: 'Все оценки', callback_data: 'rv:filter:all' }],
    [{ text: 'Сменить ПВЗ', callback_data: 'rv:points' }, { text: 'Отключить WB', callback_data: 'rv:disconnect' }],
  ]);
}

function pointKeyboard(points) {
  return choiceKeyboard([
    ...points.slice(0, 30).map(point => [{ text: `ПВЗ ${point.id}`, callback_data: `rv:point:${point.id}` }]),
    [{ text: 'Отмена', callback_data: 'rv:cancel' }],
  ]);
}

function reviewStars(key) {
  return key === 'all' ? [1, 2, 3, 4, 5] : [Number(key)].filter(star => star >= 1 && star <= 5);
}

function formatWbDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(String(value).slice(0, 19));
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('7')) return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
  return digits ? `+${digits}` : '—';
}

/** WB отдаёт середину номера заглушкой из нулей — меняем только группу, целиком из нулей. */
function maskWbPhone(value) {
  return formatPhone(value).replace(/\b0+\b/g, zeros => '*'.repeat(zeros.length));
}

function reviewText(review, position, total) {
  const stars = Math.max(0, Math.min(5, Number(review.stars || 0)));
  const comment = String(review.comment || '').trim();
  const reasons = Array.isArray(review.reasons_text) ? review.reasons_text.filter(Boolean).join(', ') : '';
  const parts = [
    `<b>Отзыв ${position} из ${total}</b>`,
    `${'⭐'.repeat(stars)}${'☆'.repeat(5 - stars)} · ${formatWbDate(review.rate_dt)}`,
  ];
  if (comment) parts.push(`\n${escapeHtml(comment)}`);
  if (reasons) parts.push(`\nПричины: ${escapeHtml(reasons)}`);
  if (!comment && !reasons) parts.push('\n<i>Без комментария</i>');
  return parts.join('\n');
}

const PICKUP_STATUSES = ['GOODS_RECIEVED', 'GOODS_RECEIVED'];
const REFUSAL_STATUSES = ['GOODS_RETURNED', 'GOODS_RETURN_ERROR'];

/** Возвращает 'received' (клиент забрал), 'returned' (отказ) или null. */
function pickupAction(status) {
  const value = String(status || '').toUpperCase();
  if (PICKUP_STATUSES.includes(value)) return 'received';
  if (REFUSAL_STATUSES.includes(value)) return 'returned';
  return null;
}

function findPickupEvents(goods, userIds) {
  const wanted = new Set((Array.isArray(userIds) ? userIds : [userIds])
    .map(value => String(value || '').trim()).filter(Boolean));
  return (Array.isArray(goods) ? goods : [])
    .filter(item => wanted.has(String(item?.buyer_id ?? item?.user_id ?? ''))
      || wanted.has(String(item?.buyer_sid ?? item?.user_sid ?? ''))
      || wanted.has(String(item?.buyer?.user_id ?? ''))
      || wanted.has(String(item?.buyer?.user_sid ?? '')))
    .filter(item => pickupAction(item?.status))
    .sort((left, right) => new Date(right.status_updated || 0) - new Date(left.status_updated || 0));
}

/**
 * WB обезличивает поле user_sid (возвращает "0"), но sid клиента зашит
 * в первых 8 hex-символах id отзыва: int(id[:8], 16). Так же, как это делает
 * десктоп-программа «подбор кодов».
 */
function decodeReviewClientId(ratingId) {
  const match = /^([0-9a-f]{8})-/i.exec(String(ratingId || ''));
  return match ? Number.parseInt(match[1], 16) : null;
}

function reviewAuthorIds(review) {
  return [...new Set([review?.user_id, review?.user_sid, decodeReviewClientId(review?.id)]
    .map(Number).filter(value => Number.isSafeInteger(value) && value > 0)
  )];
}

async function loadPickupEvents(telegramId, connection, userIds) {
  const cacheKey = Number(telegramId);
  let snapshot = localGoodsSnapshots.get(cacheKey);
  if (!snapshot || Date.now() - snapshot.loadedAt > GOODS_SNAPSHOT_TTL_MS) {
    const goods = [];
    let cursor = 0;
    for (let page = 0; page < 20; page += 1) {
      const result = await wbPvz.loadGoodsInPickPoint(connection.session, cursor);
      goods.push(...result.goods);
      if (!result.goods.length || result.cursor == null || result.cursor <= cursor) break;
      cursor = result.cursor;
    }
    snapshot = { goods, loadedAt: Date.now() };
    localGoodsSnapshots.set(cacheKey, snapshot);
  }
  return findPickupEvents(snapshot.goods, userIds);
}

async function showReviewFilters(from, chatId) {
  const connection = await getWbConnection(from.id);
  if (connection?.session?.token && connection.state === 'await_point') {
    await beginPointSelection(from, chatId, connection);
    return;
  }
  if (!connection?.session?.token || connection.state !== 'ready') {
    const session = { deviceId: crypto.randomUUID() };
    await saveWbConnection(from, chatId, 'await_phone', session);
    await sendMessage(chatId, '<b>Подключение кабинета WB</b>\n\nОтправьте номер телефона сотрудника в формате <code>79991234567</code>. Сообщение с номером будет удалено после обработки.');
    return;
  }
  await sendMessage(chatId, `<b>Отзывы ПВЗ ${connection.session.pointId}</b>\n\nКакие оценки показать?`, { reply_markup: reviewFilterKeyboard() });
}

async function sendReviewPage(from, chatId, filterKey, page) {
  const connection = await getWbConnection(from.id);
  if (!connection?.session?.token || connection.state !== 'ready') return showReviewFilters(from, chatId);
  const stars = reviewStars(filterKey);
  if (!stars.length) return;
  let result;
  try { result = await wbPvz.loadReviews(connection.session, stars, page, 5); }
  catch (error) {
    if (error.status === 401 || error.status === 403) {
      await deleteWbConnection(from.id);
      await sendMessage(chatId, 'Сессия WB истекла. Подключите кабинет заново.');
      return showReviewFilters(from, chatId);
    }
    throw error;
  }
  const totalPages = Math.max(1, Math.ceil(result.total / 5));
  const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
  if (safePage !== Number(page) && result.total) return sendReviewPage(from, chatId, filterKey, safePage);
  if (!result.data.length) {
    const noReviews = filterKey === 'all'
      ? 'Отзывов пока нет.'
      : `Отзывов с оценкой ${filterKey}⭐ нет.`;
    await sendMessage(chatId, noReviews, { reply_markup: reviewFilterKeyboard() });
    return;
  }
  for (let index = 0; index < result.data.length; index += 1) {
    const review = result.data[index];
    const callbackData = `rv:who2:${filterKey}:${safePage}:${index}`;
    const keyboard = choiceKeyboard([[{ text: '👤 Кто оставил', callback_data: callbackData }]]);
    await sendMessage(chatId, reviewText(review, safePage * 5 + index + 1, result.total), { reply_markup: keyboard });
  }
  const navigation = [];
  if (safePage > 0) navigation.push({ text: '⬅️ Назад', callback_data: `rv:page:${filterKey}:${safePage - 1}` });
  if (safePage + 1 < totalPages) navigation.push({ text: 'Далее ➡️', callback_data: `rv:page:${filterKey}:${safePage + 1}` });
  await sendMessage(chatId, `Страница <b>${safePage + 1}</b> из <b>${totalPages}</b>`, {
    reply_markup: choiceKeyboard([navigation, [{ text: 'Изменить оценку', callback_data: 'rv:filters' }]].filter(row => row.length)),
  });
}

async function showReviewAuthor(from, chatId, reviewOrUserId, userSid) {
  const connection = await getWbConnection(from.id);
  if (!connection?.session?.token || connection.state !== 'ready') return showReviewFilters(from, chatId);
  const review = reviewOrUserId && typeof reviewOrUserId === 'object' ? reviewOrUserId : null;
  const identifiers = review ? reviewAuthorIds(review) : [...new Set([reviewOrUserId, userSid]
    .map(Number).filter(value => Number.isSafeInteger(value) && value > 0))];
  const reviewEvents = (Array.isArray(review?.goods) ? review.goods : [])
    .filter(item => item?.status_updated)
    .sort((left, right) => new Date(right.status_updated || 0) - new Date(left.status_updated || 0));
  const [users, pickupResult] = await Promise.all([
    identifiers.length ? wbPvz.loadUsers(connection.session, identifiers) : [],
    reviewEvents.length
      ? { events: reviewEvents }
      : identifiers.length
        ? loadPickupEvents(from.id, connection, identifiers).then(events => ({ events })).catch(error => ({ error }))
        : { events: [] },
  ]);
  const wanted = new Set(identifiers.map(String));
  let user = users.find(item => wanted.has(String(item.id)) || wanted.has(String(item.user_sid)));
  if (!user && String(review?.user_name || '').trim()) user = { name: String(review.user_name).trim() };
  // Телефон/имя WB в users-data для обезличенных отзывов не отдаёт — берём из продажи.
  if (!pickupResult.error && pickupResult.events.length) {
    const buyers = pickupResult.events.map(item => item?.buyer).filter(Boolean);
    const matched = buyers.find(buyer => wanted.has(String(buyer.user_id)) || wanted.has(String(buyer.user_sid)))
      || buyers[0];
    if (matched) {
      user = {
        name: user?.name || matched.name || '',
        phone: user?.phone ?? user?.mobile ?? matched.mobile,
      };
    }
  }
  const clientLine = identifiers.length ? `ID клиента: <code>${identifiers[0]}</code>\n` : '';
  let pickupText;
  if (pickupResult.error) {
    pickupText = `Когда забрал/отказался: <i>не удалось получить (${escapeHtml(pickupResult.error.message)})</i>`;
  } else if (!pickupResult.events.length && !identifiers.length) {
    pickupText = '<i>WB не передал ID автора в этом отзыве — определить клиента невозможно.</i>';
  } else if (!pickupResult.events.length) {
    pickupText = '<i>Выдача/отказ не найдены в текущем окне продаж WB — возможно, уже выпали из списка. Для старых событий нужна накопленная локальная база.</i>';
  } else {
    const recent = pickupResult.events.slice(0, 5).map((item, index) => {
      const returned = pickupAction(item.status) === 'returned';
      const label = returned ? '↩️ отказ' : '✅ взял';
      const shk = item.shk_code || item.barcode || item.sticker_code;
      const parts = [`${index + 1}. ${label} · ${formatWbDate(item.status_updated)}`];
      if (item.cell) parts.push(`яч. <code>${escapeHtml(item.cell)}</code>`);
      if (shk) parts.push(`ШК <code>${escapeHtml(shk)}</code>`);
      return parts.join(' · ');
    });
    pickupText = `<b>Когда забрал / отказался:</b>\n${recent.join('\n')}`;
  }
  const phone = maskWbPhone(user?.phone ?? user?.mobile);
  await sendMessage(chatId,
    `<b>Информация об авторе</b>\n\n${clientLine}Телефон: <code>${escapeHtml(phone)}</code>\n\n${pickupText}`,
  );
}

async function showReviewAuthorByPosition(from, chatId, filterKey, page, index) {
  const connection = await getWbConnection(from.id);
  if (!connection?.session?.token || connection.state !== 'ready') return showReviewFilters(from, chatId);
  const stars = reviewStars(filterKey);
  if (!stars.length || !Number.isInteger(page) || page < 0 || !Number.isInteger(index) || index < 0 || index >= 5) return;
  const result = await wbPvz.loadReviews(connection.session, stars, page, 5);
  const review = result.data[index];
  if (!review) return sendMessage(chatId, 'Отзыв больше не найден в этой позиции. Обновите список отзывов.');
  return showReviewAuthor(from, chatId, review);
}

async function beginPointSelection(from, chatId, connection) {
  const points = await wbPvz.loadPoints(connection.session);
  if (!points.length) throw new Error('В кабинете WB не найдено доступных ПВЗ');
  if (points.length === 1) {
    const session = await wbPvz.selectPoint(connection.session, points[0].id);
    await saveWbConnection(from, chatId, 'ready', session);
    return showReviewFilters(from, chatId);
  }
  await saveWbConnection(from, chatId, 'await_point', connection.session);
  await sendMessage(chatId, '<b>Выберите ПВЗ</b>', { reply_markup: pointKeyboard(points) });
}

async function showIndividualOrders(from, chatId) {
  const userId = await findUser(from.id);
  if (!userId) return sendMessage(chatId, 'Сначала подключите кабинет.', { reply_markup: miniAppKeyboard() });
  const orders = await supabaseFetch(`individual_sticker_orders?user_id=eq.${encodeURIComponent(userId)}&select=id,title,quantity,amount_due,status&order=created_at.desc&limit=10`);
  if (!orders.length) return sendMessage(chatId, 'Индивидуальных заказов пока нет.', { reply_markup: HOME_KEYBOARD });
  for (const order of orders) {
    const paid = order.status === 'paid';
    const rows = [[{ text: paid ? '🌐 Посмотреть каждый стикер' : `💳 Оплатить ${Number(order.amount_due).toFixed(2)} ₽`, web_app: { url: publicUrl(paid ? '/cabinet/history' : '/cabinet/orders') } }]];
    if (paid) {
      const parts = Math.ceil(Number(order.quantity) / 500);
      const expires = Math.floor(Date.now()/1000)+3600;
      for (let part=0;part<parts;part+=1) {
        const signedValue=`individual:${order.id}:${part}:${expires}`;
        const token=crypto.createHmac('sha256',process.env.STICKER_CLIENT_SECRET).update(signedValue).digest('base64url');
        rows.push([{text:`📄 PDF ${part+1} из ${parts}`,url:publicUrl(`/api/stickers/pdf?individual=${encodeURIComponent(order.id)}&part=${part}&expires=${expires}&token=${encodeURIComponent(token)}`)}]);
      }
    }
    await sendMessage(chatId, `<b>${escapeHtml(order.title)}</b>\n${order.quantity} стикеров\nСтатус: ${paid?'оплачен ✅':'ожидает оплаты'}`, { reply_markup: choiceKeyboard(rows) });
  }
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
  await touchSubscriber(from, chatId);
  const data = String(callback.data || '');
  if (data === 'rv:start' || data === 'rv:filters') { await answerCallbackQuery(callback.id); await showReviewFilters(from, chatId); return; }
  if (data === 'rv:disconnect') { await answerCallbackQuery(callback.id); await deleteWbConnection(from.id); await sendMessage(chatId, 'Кабинет WB отключён.', { reply_markup: HOME_KEYBOARD }); return; }
  if (data === 'rv:cancel') { await answerCallbackQuery(callback.id); const connection = await getWbConnection(from.id); if (connection) await saveWbConnection(from, chatId, 'idle', connection.session); await sendMessage(chatId, 'Подключение WB отменено.', { reply_markup: HOME_KEYBOARD }); return; }
  if (data === 'rv:points') {
    await answerCallbackQuery(callback.id);
    const connection = await getWbConnection(from.id);
    if (!connection?.session?.token) return showReviewFilters(from, chatId);
    await beginPointSelection(from, chatId, connection);
    return;
  }
  const pointMatch = data.match(/^rv:point:(\d+)$/);
  if (pointMatch) {
    await answerCallbackQuery(callback.id);
    const connection = await getWbConnection(from.id);
    if (!connection?.session?.token) return showReviewFilters(from, chatId);
    const session = await wbPvz.selectPoint(connection.session, Number(pointMatch[1]));
    await saveWbConnection(from, chatId, 'ready', session);
    await showReviewFilters(from, chatId);
    return;
  }
  const filterMatch = data.match(/^rv:filter:(all|[1-5])$/);
  if (filterMatch) { await answerCallbackQuery(callback.id); await sendReviewPage(from, chatId, filterMatch[1], 0); return; }
  const reviewPageMatch = data.match(/^rv:page:(all|[1-5]):(\d+)$/);
  if (reviewPageMatch) { await answerCallbackQuery(callback.id); await sendReviewPage(from, chatId, reviewPageMatch[1], Number(reviewPageMatch[2])); return; }
  const authorPositionMatch = data.match(/^rv:who2:(all|[1-5]):(\d+):(\d+)$/);
  if (authorPositionMatch) { await answerCallbackQuery(callback.id); await showReviewAuthorByPosition(from, chatId, authorPositionMatch[1], Number(authorPositionMatch[2]), Number(authorPositionMatch[3])); return; }
  const authorMatch = data.match(/^rv:who:(\d+)(?::(\d+))?$/);
  if (authorMatch) { await answerCallbackQuery(callback.id); await showReviewAuthor(from, chatId, Number(authorMatch[1]), Number(authorMatch[2] || 0)); return; }
  if (data === 'gen:start') { await answerCallbackQuery(callback.id); await startGeneration(from, chatId); return; }
  if (data === 'orders:list') { await answerCallbackQuery(callback.id); await showIndividualOrders(from, chatId); return; }
  if (data === 'gen:cancel') { await answerCallbackQuery(callback.id); await clearSession(from.id); await sendMessage(chatId, 'Генерация отменена.', { reply_markup: HOME_KEYBOARD }); return; }
  if (data === 'account:continue') { await answerCallbackQuery(callback.id); await sendMessage(chatId, 'Продолжайте работу с текущим кабинетом.', { reply_markup: HOME_KEYBOARD }); return; }
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
  await touchSubscriber(from, chatId);
  if (/^\/(start|help)(?:@\w+)?(?:\s+[A-Za-z0-9_-]+)?$/i.test(text)) {
    await clearSession(from.id);
    const userId = await findUser(from.id);
    const intro = `<b>Генератор ШК для Wildberries</b>\n\nБот создаёт:\n• возвратные стикеры для товаров;\n• QR-коды возвратных коробок;\n• одиночные ШК и пачки до 500 штук;\n• готовый PDF для печати.\n\n${userId ? 'Ваш Telegram уже связан с кабинетом.' : 'Чтобы пользоваться пакетами генераций, откройте Mini App и войдите через Telegram.'}`;
    if (userId) await sendMessage(chatId, intro, { reply_markup: HOME_KEYBOARD });
    else await sendLoginPrompt(from, chatId, intro);
    return;
  }
  if (/^\/cancel(?:@\w+)?$/i.test(text)) { await clearSession(from.id); const wb = await getWbConnection(from.id); if (wb && wb.state !== 'ready') await saveWbConnection(from, chatId, 'idle', wb.session); await sendMessage(chatId, 'Текущее действие отменено.', { reply_markup: HOME_KEYBOARD }); return; }
  if (/^\/generate(?:@\w+)?$/i.test(text)) return startGeneration(from, chatId);
  if (/^\/reviews(?:@\w+)?$/i.test(text)) return showReviewFilters(from, chatId);
  if (/^\/account(?:@\w+)?$/i.test(text)) return showAccount(from, chatId);
  if (/^\/orders(?:@\w+)?$/i.test(text) || text === '📦 Мои индивидуальные заказы') return showIndividualOrders(from, chatId);
  if (text === '➕ Создать ШК') return startGeneration(from, chatId);
  if (text === '🏷 Стикеры для товаров') return startForCategory(from, chatId, 'product');
  if (text === '📦 QR для коробок') return startForCategory(from, chatId, 'box');
  if (text === '💳 Остаток') return showBalance(from, chatId);
  if (text === '👤 Аккаунт') return showAccount(from, chatId);
  if (text === '🆘 Помощь') return showHelp(chatId);
  if (text === '⭐ Отзывы ПВЗ') return showReviewFilters(from, chatId);
  const wbConnection = await getWbConnection(from.id);
  if (wbConnection?.state === 'await_phone') {
    await deleteMessage(chatId, message.message_id);
    let phone = text.replace(/\D/g, '');
    if (phone.length === 11 && phone.startsWith('8')) phone = `7${phone.slice(1)}`;
    if (!/^7\d{10}$/.test(phone)) return sendMessage(chatId, 'Введите номер в формате <code>79991234567</code>.');
    try {
      const result = await wbPvz.requestCode(wbConnection.session || { deviceId: crypto.randomUUID() }, phone);
      await saveWbConnection(from, chatId, 'await_code', result.session);
      await sendMessage(chatId, `Код отправлен. Введите код из сообщения WB в течение ${result.ttl} сек. Сообщение с кодом будет удалено.`);
    } catch (error) {
      await saveWbConnection(from, chatId, 'await_phone', wbConnection.session, { lastError: String(error.message).slice(0, 500) });
      await sendMessage(chatId, `Не удалось отправить код WB: ${escapeHtml(error.message)}`);
    }
    return;
  }
  if (wbConnection?.state === 'await_code') {
    await deleteMessage(chatId, message.message_id);
    const code = text.replace(/\D/g, '');
    if (!/^\d{4,6}$/.test(code)) return sendMessage(chatId, 'Введите код WB из 4–6 цифр.');
    try {
      const session = await wbPvz.confirmCode(wbConnection.session, code);
      await saveWbConnection(from, chatId, 'await_point', session);
      try {
        await beginPointSelection(from, chatId, { ...wbConnection, state: 'await_point', session });
      } catch (error) {
        await saveWbConnection(from, chatId, 'await_point', session, { lastError: String(error.message).slice(0, 500) });
        await sendMessage(chatId, `Вход WB выполнен, но ПВЗ пока не подключён: ${escapeHtml(error.message)}. Повторите /reviews позже — новый SMS-код не потребуется.`);
      }
    } catch (error) {
      await saveWbConnection(from, chatId, 'await_code', wbConnection.session, { lastError: String(error.message).slice(0, 500) });
      await sendMessage(chatId, `Не удалось войти в WB: ${escapeHtml(error.message)}`);
    }
    return;
  }
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

module.exports = { HOME_KEYBOARD, escapeHtml, findPickupEvents, formatPhone, handleTelegramUpdate, maskWbPhone, notifyMiniAppAuthorized, publicUrl, reviewAuthorIds, reviewStars, reviewText, validWebhookSecret };
