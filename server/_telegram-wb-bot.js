const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { supabaseFetch } = require('./_supabase');
const { answerCallbackQuery, deleteMessage, editMessageText, sendDocument, sendMediaGroup, sendMessage, sendPhoto, telegramRequest } = require('./_telegram-api');
const { generateStickers, selectAccessCode } = require('./_sticker-generation');
const { CELL_PRINT_PRICES, CLIENT_CODE_PRICE, LICENSE_PRICES, REVIEW_PRICE } = require('./_payments');
const { buildClientQr } = require('./_wb-code');
const { PLANS, TERMS, orderSnapshot, planPrice } = require('./_app-plans');
const wallet = require('./_wallet');
const { notifyAdminSpend } = require('./_admin-alerts');
const { appFreeMode, appFreeUntil } = require('./_app-free');
const { isTechnicalTelegramUser } = require('./_telegram-account');
const wbPvz = require('./_wb-pvz');
const { isAccessCode, normalizeAccessCode } = require('./_access-code');

const SESSION_TTL_MS = 30 * 60 * 1000;
// Коды из 6 цифр подбираются перебором, поэтому попыток ввода — не больше 10 в час.
const CODE_ATTEMPTS_PER_HOUR = 10;
const codeAttemptsFallback = new Map();
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
// Постоянная клавиатура — только быстрый возврат. Всё остальное в инлайн-меню (showMainMenu).
const HOME_KEYBOARD = {
  keyboard: [[{ text: '☰ Меню' }, { text: '🏷 Стикеры и QR' }]],
  resize_keyboard: true,
  is_persistent: false,
};

// Ссылки на программы показываем текстом, а не кнопкой: их копируют и открывают на ПК пункта.
const PROGRAM_URL = 'https://shk-wb.ru/program';
const CELL_PRINT_URL = 'https://shk-wb.ru/cell-print';
const SUPPORT_URL = 'https://t.me/roma_denosov';
const CHANNEL_URL = 'https://t.me/wbtools_ru';

const BOT_COMMANDS = [
  { command: 'menu', description: 'Главное меню' },
  { command: 'stickers', description: 'Стикеры товаров и QR коробок' },
  { command: 'code', description: 'Найти код клиента' },
  { command: 'reviews', description: 'Отзывы ПВЗ и кто поставил оценку' },
  { command: 'profile', description: 'Профиль, баланс, продление' },
  { command: 'invite', description: 'Пригласить друга — 10% с его оплат' },
  { command: 'help', description: 'Как пользоваться ботом' },
];

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

const MENU_ROW = [{ text: '☰ Меню', callback_data: 'menu:home' }];

function mainMenuKeyboard(signedIn) {
  return choiceKeyboard([
    [{ text: '🏷 Стикеры и QR для коробок', callback_data: 'menu:stickers' }],
    [{ text: '🔑 Найти код клиента', callback_data: 'menu:code' }],
    [{ text: '⭐ Отзывы ПВЗ — кто поставил оценку', callback_data: 'menu:reviews' }],
    [{ text: '🖥 Помощник ПВЗ', callback_data: 'menu:helper' }],
    [{ text: '🖨 Печать ячеек', callback_data: 'menu:cellprint' }],
    [{ text: '👥 Пригласить друга — 10%', callback_data: 'menu:ref' }],
    [signedIn
      ? { text: '👤 Мой профиль и баланс', callback_data: 'menu:profile' }
      : { text: '🔐 Войти в кабинет', callback_data: 'menu:login' }],
    [{ text: '📣 Канал', url: CHANNEL_URL }, { text: '🆘 Поддержка', callback_data: 'menu:support' }, { text: '🌐 Сайт', web_app: { url: publicUrl('/') } }],
  ]);
}

const dayMonth = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
const shortDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });

/** «бесплатно до 1 ноября» для бесплатного периода Помощника; пустая строка, если он закончился. */
function freeUntilText(enabled, until) {
  if (!enabled) return '';
  const end = Date.parse(until || '');
  // В админке дата хранится как последняя секунда дня (23:59:59 МСК) — показываем следующий день: «до 1 ноября».
  return Number.isFinite(end) ? `бесплатно до ${dayMonth.format(new Date(end + 1000))}` : 'сейчас бесплатно';
}

async function helperFreeText() {
  try { return freeUntilText(await appFreeMode(), await appFreeUntil()); }
  catch { return ''; }
}

async function showMainMenu(from, chatId, messageId) {
  const [userId, free] = await Promise.all([findUser(from.id), helperFreeText()]);
  const lines = ['<b>Главное меню</b>'];
  if (free) lines.push(`🆕 Помощник ПВЗ — ${free}`);
  lines.push(`📣 <a href="${CHANNEL_URL}">Наш канал</a> — новости и обновления`);
  await showScreen(chatId, messageId, lines.join('\n'), { reply_markup: mainMenuKeyboard(Boolean(userId)) });
}

/** Подписанная ссылка на «голый» QR кода клиента (отдаёт api/stickers/image в режиме qr). */
function clientQrUrl(qrText) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = crypto.createHmac('sha256', process.env.STICKER_CLIENT_SECRET).update(`qr:${qrText}:${expires}`).digest('base64url');
  return publicUrl(`/api/stickers/image?qr=${encodeURIComponent(qrText)}&token=${encodeURIComponent(token)}&expires=${expires}&format=png`);
}

async function showClientCode(chatId, messageId) {
  const free = await helperFreeText();
  const text = [
    '<b>🔑 Код клиента</b>',
    `Отправьте <code>Код ID</code> — пришлю QR. За QR спишется <b>${wallet.formatRub(CLIENT_CODE_PRICE)}</b> с баланса бота.`,
    '',
    '<b>Где взять ID (SID) клиента:</b>',
    '• 🔎 прямо здесь в боте — по номеру телефона или ячейке;',
    '• 🖥 в программе «Помощник ПВЗ» — в ячейке клиента или поиском по телефону.',
    '',
    `Для доступа к ячейкам в программе нужен тариф «Базовый» — ${PLANS.basic.monthlyPrice} ₽/мес${free ? ` (сейчас ${free})` : ''}.`,
    '',
    'Пример: <code>Код 191607973</code>',
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    [{ text: '🔎 Найти ID в боте', callback_data: 'code:find' }],
    [{ text: `🛒 Купить «Базовый» — ${PLANS.basic.monthlyPrice} ₽/мес`, callback_data: 'shop:helper:basic' }],
    [{ text: '🖥 Что ещё умеет Помощник', callback_data: 'menu:helper' }],
    MENU_ROW,
  ]) });
}

/** Не хватает денег на QR — пополнить ровно на недостающее и выдать QR (afterWalletTopup → qr:<sid>). */
async function showClientCodePaywall(from, chatId, sid, balance) {
  const text = [
    `<b>🔑 Код клиента — ${wallet.formatRub(CLIENT_CODE_PRICE)}</b>`,
    `💰 На балансе: <b>${wallet.formatRub(balance)}</b> — не хватает.`,
    'После пополнения QR придёт сам.',
  ].join('\n');
  await sendMessage(chatId, text, { reply_markup: choiceKeyboard([
    topupAndBuyRow(CLIENT_CODE_PRICE - balance, `qr:${sid}`),
    MENU_ROW,
  ]) });
}

/**
 * Безлимитный тариф: «Код клиента», «Кто поставил оценку» и стикеры товаров/коробок без оплаты.
 * Имя — для фразы «У вас, <имя>, безлимитный тариф».
 */
const UNLIMITED_TELEGRAM_USERS = { 439335621: 'Султан', 1751409240: 'Зара' };

function unlimitedName(telegramId) { return UNLIMITED_TELEGRAM_USERS[String(telegramId)] || null; }

function unlimitedLine(telegramId) {
  const name = unlimitedName(telegramId);
  return name ? `У вас, ${name}, безлимитный тариф.` : 'Бесплатный доступ.';
}

function envIdList(name) { return String(process.env[name] || '').split(',').map(value => value.trim()).filter(Boolean); }

/** Безлимит или Telegram ID через запятую в CLIENT_CODE_FREE_TELEGRAM_IDS — QR без оплаты. */
function clientCodeFreeFor(telegramId) {
  return Boolean(unlimitedName(telegramId)) || envIdList('CLIENT_CODE_FREE_TELEGRAM_IDS').includes(String(telegramId));
}

/** «Код <SID>» → списать 50 ₽ и прислать только QR-код. */
async function handleClientCode(from, chatId, sid) {
  const { qrText: freeQr } = buildClientQr(sid);
  if (clientCodeFreeFor(from.id)) {
    await sendPhoto(chatId, clientQrUrl(freeQr), { caption: unlimitedLine(from.id) });
    return;
  }
  const userId = await findUser(from.id);
  if (!userId) { await sendLoginPrompt(from, chatId, 'Чтобы получить QR, войдите через Telegram — баланс хранится в кабинете.'); return; }
  const { qrText } = buildClientQr(sid);
  const balance = await walletRub(userId);
  if (balance < CLIENT_CODE_PRICE) return showClientCodePaywall(from, chatId, sid, balance);
  const spent = await supabaseFetch('rpc/wallet_spend', {
    method: 'POST',
    body: JSON.stringify({ p_user: userId, p_kopecks: CLIENT_CODE_PRICE * 100, p_event_key: `qr:${userId}:${qrText}`, p_details: { sid: String(sid) } }),
  });
  if (!spent?.ok) return showClientCodePaywall(from, chatId, sid, Number(spent?.balance || 0) / 100);
  notifyAdminSpend({ userId, priceRub: CLIENT_CODE_PRICE, title: 'Код клиента (QR)', balanceKopecks: spent.balance }).catch(() => {});
  try {
    await sendPhoto(chatId, clientQrUrl(qrText), { caption: `Списано ${wallet.formatRub(CLIENT_CODE_PRICE)} · баланс ${wallet.formatRub(Number(spent.balance) / 100)}` });
  } catch (error) {
    // Фото не ушло — возвращаем деньги, чтобы не списать за несделанное.
    await supabaseFetch('rpc/admin_wallet_adjust', { method: 'POST', body: JSON.stringify({ p_user: userId, p_kopecks: CLIENT_CODE_PRICE * 100, p_note: `qr refund ${qrText}` }) }).catch(() => {});
    throw error;
  }
}

// ── Поиск SID клиента в боте: по телефону (последние цифры) или номеру ячейки ──
// Данные берём из списка товаров пункта (loadGoodsInPickPoint): там у каждой записи есть
// buyer_sid, номер ячейки (cell) и телефон клиента (buyer.mobile, середина замаскирована).

function goodSid(item) {
  const value = item?.buyer_sid ?? item?.buyer?.user_sid ?? item?.user_sid ?? item?.buyer_id ?? item?.buyer?.user_id ?? item?.user_id;
  const sid = Number(value);
  return Number.isSafeInteger(sid) && sid > 0 ? String(sid) : null;
}
function goodPhone(item) { return String(item?.buyer?.mobile ?? item?.buyer?.phone ?? item?.mobile ?? item?.phone ?? ''); }
function goodCell(item) { return String(item?.cell ?? item?.cell_address ?? '').trim(); }
function goodName(item) { return String(item?.buyer?.name ?? item?.name ?? '').trim(); }

/** Совпадения по запросу: цифры могут быть и номером ячейки, и хвостом телефона — ищем и так, и так. */
function findClientsByQuery(goods, digits) {
  const out = new Map();
  for (const item of Array.isArray(goods) ? goods : []) {
    const sid = goodSid(item);
    if (!sid) continue;
    const cell = goodCell(item);
    const phoneDigits = goodPhone(item).replace(/\D/g, '');
    const cellMatch = cell && cell.replace(/\D/g, '') === digits;
    const phoneMatch = digits.length >= 3 && phoneDigits.length >= digits.length && phoneDigits.endsWith(digits);
    if (!cellMatch && !phoneMatch) continue;
    const entry = out.get(sid) || { sid, phone: '', cells: new Set(), name: '' };
    if (cell) entry.cells.add(cell);
    if (!entry.phone && goodPhone(item)) entry.phone = goodPhone(item);
    if (!entry.name && goodName(item)) entry.name = goodName(item);
    out.set(sid, entry);
  }
  return [...out.values()];
}

/** Весь список товаров пункта с кэшем на 2 минуты (общий с loadPickupEvents). */
async function loadGoodsSnapshot(telegramId, connection) {
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
  return snapshot.goods;
}

async function promptClientQuery(from, chatId, messageId) {
  await saveSession(from, chatId, 'await_client_query', { userId: await findUser(from.id) });
  await showScreen(chatId, messageId, [
    `<b>🔎 Поиск клиента (ПВЗ ${(await getWbConnection(from.id))?.session?.pointId || ''})</b>`,
    'Отправьте <b>номер ячейки</b> или <b>телефон</b> (можно последние 4 цифры).',
    'Например: <code>245</code> или <code>1234</code> или <code>79991234567</code>.',
    '',
    'Ищу по текущим заказам в пункте.',
  ].join('\n'), { reply_markup: choiceKeyboard([[{ text: '⬅️ Назад', callback_data: 'menu:code' }], MENU_ROW]) });
}

/** После входа в кабинет WB: если ждали поиск клиента — к поиску, иначе к отзывам. */
async function afterWbReady(from, chatId) {
  const session = await getSession(from.id);
  if (session?.state === 'await_wb_for_search') { await clearSession(from.id); return promptClientQuery(from, chatId); }
  return showReviewFilters(from, chatId);
}

/** «Найти ID в боте»: нужен вход в кабинет WB (как для отзывов), затем запрос телефона/ячейки. */
async function startClientSearch(from, chatId, messageId) {
  const userId = await findUser(from.id);
  if (!userId) { await sendLoginPrompt(from, chatId, 'Чтобы получить QR после поиска, войдите через Telegram — баланс хранится в кабинете.'); return; }
  const connection = await getWbConnection(from.id);
  if (connection?.session?.token && connection.state === 'ready') return promptClientQuery(from, chatId, messageId);
  await saveSession(from, chatId, 'await_wb_for_search', { userId });
  if (connection?.session?.token && connection.state === 'await_point') return beginPointSelection(from, chatId, connection);
  const session = { deviceId: crypto.randomUUID() };
  await saveWbConnection(from, chatId, 'await_phone', session);
  await showScreen(chatId, messageId, '<b>Вход в кабинет WB</b>\nДля поиска клиента по телефону или ячейке нужен вход в кабинет WB.\n\nОтправьте номер телефона сотрудника в формате <code>79991234567</code>. Сообщение с номером будет удалено после обработки.', { reply_markup: choiceKeyboard([[{ text: '⬅️ Назад', callback_data: 'menu:code' }], MENU_ROW]) });
}

async function runClientSearch(from, chatId, query) {
  const connection = await getWbConnection(from.id);
  if (!connection?.session?.token || connection.state !== 'ready') { await clearSession(from.id); return startClientSearch(from, chatId); }
  const digits = String(query || '').replace(/\D/g, '');
  if (!digits) return sendMessage(chatId, 'Отправьте номер ячейки или телефон цифрами (можно последние 4 цифры).');
  let goods;
  try {
    goods = await loadGoodsSnapshot(from.id, connection);
  } catch (error) {
    if (error.status === 401 || error.status === 403) { await deleteWbConnection(from.id); await clearSession(from.id); await sendMessage(chatId, 'Сессия WB истекла. Подключите кабинет заново.'); return startClientSearch(from, chatId); }
    throw error;
  }
  const matches = findClientsByQuery(goods, digits);
  if (!matches.length) {
    return sendMessage(chatId, [
      'Не нашёл клиента по этому запросу среди текущих заказов пункта.',
      'Попробуйте номер ячейки или другие цифры телефона. WB хранит только недавние заказы — старых в онлайне нет.',
      '',
      '<b>Не нашли здесь — найдите ID в программе «Помощник ПВЗ».</b>',
      'Установите её на компьютер пункта, где стоит WB-PVZ: в ячейке клиента или поиском по телефону будет ID (SID).',
      `Скачать: ${PROGRAM_URL}`,
    ].join('\n'), { reply_markup: choiceKeyboard([
      [{ text: '🔁 Искать снова', callback_data: 'code:find' }],
      [{ text: '🖥 Что умеет «Помощник ПВЗ»', callback_data: 'menu:helper' }],
      MENU_ROW,
    ]) });
  }
  const lines = ['<b>🔎 Найдено:</b>', 'Выберите клиента — пришлю QR (спишется ' + wallet.formatRub(CLIENT_CODE_PRICE) + ').', ''];
  const rows = [];
  matches.slice(0, 10).forEach((match, index) => {
    const cells = [...match.cells].join(', ');
    const parts = [`${index + 1}. ${maskWbPhone(match.phone)}`];
    if (cells) parts.push(`яч. ${escapeHtml(cells)}`);
    parts.push(`ID <code>${match.sid}</code>`);
    lines.push(parts.join(' · '));
    rows.push([{ text: `${index + 1}. Получить QR`, callback_data: `code:qr:${match.sid}` }]);
  });
  if (matches.length > 10) lines.push(`\n…и ещё ${matches.length - 10}. Уточните запрос.`);
  rows.push([{ text: '🔁 Искать снова', callback_data: 'code:find' }, ...MENU_ROW]);
  await clearSession(from.id);
  await sendMessage(chatId, lines.join('\n'), { reply_markup: choiceKeyboard(rows) });
}

async function showHelperInfo(chatId, messageId) {
  const free = await helperFreeText();
  const text = [
    '<b>🖥 Помощник ПВЗ</b>',
    'Программа для ПК пункта: код клиента, ячейки, отзывы с авторами, досье клиентов, график и зарплата сотрудников.',
    '',
    ...['basic', 'standard', 'pro'].map(id => `${PLANS[id].title} — ${PLANS[id].monthlyPrice} ₽/мес`),
    ...(free ? [`🎁 Сейчас ${free}`] : []),
    '',
    `Скачать: ${PROGRAM_URL}`,
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    [{ text: '🛒 Оплатить с баланса', callback_data: 'shop:helper' }],
    [{ text: '🔑 Как найти код клиента', callback_data: 'menu:code' }],
    MENU_ROW,
  ]) });
}

async function showCellPrintInfo(chatId, messageId) {
  const text = [
    '<b>🖨 Печать ячеек</b>',
    'Сканируете товар — номер ячейки сразу печатается на термопринтере. Этикетки без лимита.',
    '',
    `От ${CELL_PRINT_PRICES[7]?.[1]} ₽ в неделю · программа бесплатная`,
    `Скачать: ${CELL_PRINT_URL}`,
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    [{ text: '🛒 Купить или продлить с баланса', callback_data: 'shop:cp' }],
    MENU_ROW,
  ]) });
}

/**
 * Показать экран в том же сообщении (кнопки меню и шаги мастера), а если его нельзя
 * отредактировать (старое, удалено, это фото) — новым сообщением. Возвращает id сообщения.
 */
async function showScreen(chatId, messageId, text, options = {}) {
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, options);
      return messageId;
    } catch (error) {
      if (/message is not modified/i.test(String(error.message))) return messageId;
    }
  }
  const message = await sendMessage(chatId, text, options);
  return message?.message_id || null;
}

// ── Мастер стикеров: одно сообщение, шаги сменяют друг друга, «⬅️ Назад» — на шаг раньше ──

const GEN_BACK = { text: '⬅️ Назад', callback_data: 'gen:back' };
const GEN_CANCEL = { text: 'Отмена', callback_data: 'gen:cancel' };
const KIND_TITLES = { product: '🏷 Стикеры товаров', box: '📦 QR возвратных коробок' };

/** Выбранные параметры над вопросом шага — видно, что уже выбрано. */
function wizardTrail(draft) {
  const lines = [];
  if (draft.category) lines.push(`Тип: <b>${KIND_TITLES[draft.category]}</b>`);
  if (draft.mode) lines.push(`Режим: <b>${draft.mode === 'range' ? 'пачка по количеству' : 'конкретный номер'}</b>`);
  if (draft.mode === 'range' && draft.quantity) lines.push(`Количество: <b>${draft.quantity}</b>`);
  if (draft.mode === 'custom' && draft.code) lines.push(`Номер: <code>${escapeHtml(draft.code)}</code>`);
  return lines.length ? `${lines.join('\n')}\n\n` : '';
}

function wizardView(state, draft) {
  const error = draft.error ? `⚠️ ${draft.error}\n\n` : '';
  const trail = wizardTrail(draft);
  if (state === 'choose_kind') {
    return { text: `${error}<b>Что нужно создать?</b>`, rows: [
      [{ text: KIND_TITLES.product, callback_data: 'gen:kind:product' }],
      [{ text: KIND_TITLES.box, callback_data: 'gen:kind:box' }],
      [{ text: '⬅️ Меню', callback_data: 'menu:home' }],
    ] };
  }
  if (state === 'choose_mode') {
    return { text: `${trail}${error}<b>Выберите режим</b>`, rows: [
      [{ text: 'Пачка по количеству', callback_data: 'gen:mode:range' }],
      [{ text: 'По конкретному номеру', callback_data: 'gen:mode:custom' }],
      [GEN_BACK, GEN_CANCEL],
    ] };
  }
  if (state === 'await_quantity') {
    return { text: `${trail}${error}<b>Сколько создать?</b>\nВыберите или отправьте число от 1 до 500 сообщением.`, rows: [
      [1, 10, 50].map(value => ({ text: String(value), callback_data: `gen:qty:${value}` })),
      [100, 250, 500].map(value => ({ text: String(value), callback_data: `gen:qty:${value}` })),
      [GEN_BACK, GEN_CANCEL],
    ] };
  }
  if (state === 'await_code') {
    const length = draft.category === 'box' ? 10 : 11;
    return { text: `${trail}${error}<b>Отправьте номер сообщением</b>\n${draft.category === 'box' ? 'Номер коробки' : 'ШК'} — ровно ${length} цифр.`, rows: [[GEN_BACK, GEN_CANCEL]] };
  }
  // state === 'confirm'
  if (draft.unlimited) {
    return { text: `${trail}${error}<b>Проверьте параметры</b>\nУ вас, ${escapeHtml(draft.unlimited)}, безлимитный тариф — генерация бесплатная.`, rows: [
      [{ text: '✅ Подтвердить', callback_data: 'gen:confirm' }],
      [GEN_BACK, GEN_CANCEL],
    ] };
  }
  if (draft.accessCode) {
    return { text: `${trail}${error}<b>Проверьте параметры</b>\nГенерации спишутся с вашего кода доступа.`, rows: [
      [{ text: '✅ Подтвердить', callback_data: 'gen:confirm' }],
      [GEN_BACK, GEN_CANCEL],
    ] };
  }
  // Генераций на кодах нет — платим с баланса по таблице пакетов.
  const cost = Number(draft.walletCost || 0), balance = Number(draft.balanceKopecks || 0) / 100;
  if (balance >= cost) {
    return { text: `${trail}${error}<b>Проверьте параметры</b>\nСпишется <b>${wallet.formatRub(cost)}</b> с баланса — останется ${wallet.formatRub(balance - cost)}.`, rows: [
      [{ text: `✅ Подтвердить — ${wallet.formatRub(cost)}`, callback_data: 'gen:confirm' }],
      [GEN_BACK, GEN_CANCEL],
    ] };
  }
  return { text: `${trail}${error}<b>Не хватает ${wallet.formatRub(cost - balance)}</b>\nЦена ${wallet.formatRub(cost)}, на балансе ${wallet.formatRub(balance)}. После пополнения стикеры создадутся сами.`, rows: [
    topupAndBuyRow(cost - balance, 'gen'),
    [{ text: '🔑 У меня есть код', callback_data: 'code:enter' }],
    [GEN_BACK, GEN_CANCEL],
  ] };
}

/** Перерисовать шаг мастера в его сообщении и сохранить состояние. */
async function renderWizard(from, chatId, state, draft, messageId) {
  const view = wizardView(state, draft);
  delete draft.error;
  draft.msgId = await showScreen(chatId, messageId || draft.msgId, view.text, { reply_markup: choiceKeyboard(view.rows) });
  await saveSession(from, chatId, state, draft);
}

/** Шаг назад: куда возвращаться из каждого состояния. */
async function wizardBack(from, chatId, session, messageId) {
  const draft = session.draft || {};
  const state = session.state;
  if (state === 'choose_mode') { delete draft.category; return renderWizard(from, chatId, 'choose_kind', draft, messageId); }
  if (state === 'await_quantity' || state === 'await_code') {
    delete draft.mode; delete draft.quantity; delete draft.code; delete draft.prefix;
    return renderWizard(from, chatId, 'choose_mode', draft, messageId);
  }
  if (state === 'confirm') {
    delete draft.accessCode; delete draft.walletCost; delete draft.balanceKopecks; delete draft.unlimited;
    if (draft.mode === 'range') { delete draft.quantity; return renderWizard(from, chatId, 'await_quantity', draft, messageId); }
    delete draft.code;
    return renderWizard(from, chatId, 'await_code', draft, messageId);
  }
  return renderWizard(from, chatId, 'choose_kind', draft, messageId);
}

function miniAppKeyboard() {
  return choiceKeyboard([
    [{ text: 'У меня уже есть кабинет', web_app: { url: publicUrl('/telegram-account') } }],
    [{ text: 'Создать кабинет через Telegram', web_app: { url: publicUrl('/login') } }],
    [{ text: '🌐 Открыть сайт', web_app: { url: publicUrl('/') } }],
  ]);
}

async function sendLoginPrompt(from, chatId, text) {
  const message = await sendMessage(chatId, text, { reply_markup: miniAppKeyboard() });
  await saveSession(from, chatId, 'choose_kind', { authPromptMessageId: message.message_id });
}

function topupButton(amount) {
  const bonus = wallet.topupBonus(amount);
  return { text: `${amount} ₽${bonus ? ` (+${bonus} ₽)` : ''}`, web_app: { url: publicUrl(`/bot-checkout?kind=topup&amount=${amount}`) } };
}

/** Кнопки пополнения (сразу на оплату). missing — сколько не хватает: меньшие суммы не предлагаем. */
function topupRows(missing = 0) {
  const amounts = wallet.TOPUP_AMOUNTS.filter(amount => amount + wallet.topupBonus(amount) >= missing);
  const list = amounts.length ? amounts : [wallet.TOPUP_AMOUNTS[wallet.TOPUP_AMOUNTS.length - 1]];
  const rows = [];
  for (let index = 0; index < list.length; index += 2) rows.push(list.slice(index, index + 2).map(topupButton));
  return rows;
}

/**
 * Не хватает денег на покупку — пополнить ровно на недостающее (не меньше минимума) и купить.
 * then — что сделать после оплаты пополнения (afterWalletTopup): 'gen' | 'rv:<фильтр>:<стр>:<№>' | 'shop:<части>';
 * messageId — экран покупки, который после оплаты станет «Готово ✅».
 */
function topupAndBuyRow(missingRub, then, messageId) {
  const amount = Math.max(wallet.MIN_TOPUP, Math.ceil(Number(missingRub) - 1e-9));
  const params = new URLSearchParams({ kind: 'topup', amount: String(amount), then });
  if (messageId) params.set('m', String(messageId));
  return [{ text: `💳 Пополнить на ${amount} ₽ и купить`, web_app: { url: publicUrl(`/bot-checkout?${params}`) } }];
}

function profileKeyboard({ technical = false } = {}) {
  const rows = [
    [{ text: '💰 Пополнить баланс', callback_data: 'topup:home' }, { text: '🛒 Купить с баланса', callback_data: 'shop:home' }],
    [{ text: '👥 Пригласить друга', callback_data: 'menu:ref' }, { text: '🔑 Ввести код доступа', callback_data: 'code:enter' }],
  ];
  if (technical) rows.push([{ text: 'Подключить основной кабинет', web_app: { url: publicUrl('/telegram-account') } }]);
  rows.push(MENU_ROW);
  return choiceKeyboard(rows);
}

/** Текст ошибки claim_user_asset для человека; null — ошибка не из этих, пусть летит дальше. */
function claimErrorText(error) {
  const details = JSON.stringify(error?.details || error?.message || '');
  if (details.includes('Asset belongs to another user')) return 'Этот код уже привязан к другому аккаунту. Если это ваш код, напишите в поддержку.';
  if (details.includes('Asset not found')) return 'Код не найден. Проверьте цифры и отправьте код ещё раз.';
  if (details.includes('User is not confirmed')) return 'Кабинет не подтверждён. Откройте сайт через Mini App и войдите заново.';
  return null;
}

async function consumeCodeAttempt(telegramId) {
  const keyHash = crypto.createHash('sha256').update(`bot-code:${telegramId}`).digest('hex');
  try {
    const allowed = await supabaseFetch('rpc/consume_api_rate_limit', {
      method: 'POST',
      body: JSON.stringify({ p_scope: 'bot-access-code', p_key_hash: keyHash, p_limit: CODE_ATTEMPTS_PER_HOUR, p_window_seconds: 3600 }),
    });
    return allowed === true;
  } catch {
    const now = Date.now(), current = codeAttemptsFallback.get(keyHash);
    if (!current || current.resetAt <= now) { codeAttemptsFallback.set(keyHash, { hits: 1, resetAt: now + 3600 * 1000 }); return true; }
    current.hits += 1;
    return current.hits <= CODE_ATTEMPTS_PER_HOUR;
  }
}

/**
 * Ввод кода доступа — например, кода от партнёра. Черновик генерации сохраняется,
 * чтобы после привязки кода сразу вернуться к подтверждению, а не начинать заново.
 */
async function askAccessCode(from, chatId, draft = {}) {
  const userId = draft.userId || await findUser(from.id);
  if (!userId) { await sendLoginPrompt(from, chatId, 'Сначала войдите через Mini App — код привяжется к вашему кабинету.'); return; }
  await saveSession(from, chatId, 'await_access_code', { ...draft, userId });
  await sendMessage(chatId, '<b>Введите код доступа</b>\n\nОтправьте код сообщением — например, <code>123456</code>. Генерации из кода добавятся к вашему остатку.', { reply_markup: choiceKeyboard([[{ text: 'Отмена', callback_data: 'gen:cancel' }]]) });
}

async function redeemAccessCode(from, chatId, session, text) {
  const draft = session.draft || {};
  const code = normalizeAccessCode(text.replace(/\s+/g, ''));
  if (!isAccessCode(code)) return sendMessage(chatId, 'Код — это 6 цифр, например <code>123456</code>. Отправьте его ещё раз или нажмите /cancel.');
  if (!await consumeCodeAttempt(from.id)) return sendMessage(chatId, 'Слишком много попыток. Попробуйте через час.', { reply_markup: HOME_KEYBOARD });
  try {
    await supabaseFetch('rpc/claim_user_asset', { method: 'POST', body: JSON.stringify({ p_user_id: draft.userId, p_kind: 'sticker', p_value: code }) });
  } catch (error) {
    const reason = claimErrorText(error);
    if (!reason) throw error;
    return sendMessage(chatId, reason);
  }
  const rows = await supabaseFetch(`sticker_access_codes?code=eq.${encodeURIComponent(code)}&select=active,generation_limit,generation_used&limit=1`);
  const row = rows[0];
  if (row && !row.active) {
    await clearSession(from.id);
    return sendMessage(chatId, `Код <code>${escapeHtml(code)}</code> привязан к кабинету, но сейчас отключён. Обратитесь к тому, кто выдал код.`, { reply_markup: HOME_KEYBOARD });
  }
  const left = row ? Math.max(0, Number(row.generation_limit || 0) - Number(row.generation_used || 0)) : 0;
  await sendMessage(chatId, `✅ Код <code>${escapeHtml(code)}</code> добавлен: <b>+${left}</b> генераций.`, { reply_markup: HOME_KEYBOARD });
  // Пришли из генерации, где не хватило остатка, — продолжаем с тем же черновиком.
  if (draft.mode) {
    // Старый экран мастера остался выше в чате — подтверждение показываем новым сообщением под кодом.
    const { msgId, accessCode, walletCost, balanceKopecks, ...rest } = draft;
    return requestConfirmation(from, chatId, rest);
  }
  await clearSession(from.id);
  return showProfile(from, chatId);
}

function requiredUnits(draft) { return draft.mode === 'range' ? Number(draft.quantity) : 1; }

function telegramRequesterHash(telegramId) {
  return crypto.createHmac('sha256', process.env.STICKER_CLIENT_SECRET).update(`telegram:${telegramId}`).digest('hex');
}

/** Подтверждение: сначала генерации на кодах доступа, если их нет — оплата с баланса. */
async function requestConfirmation(from, chatId, draft, messageId) {
  const units = requiredUnits(draft);
  if (unlimitedName(from.id)) {
    // Безлимит: свой код без оплаты, лимит которого бот поднимает сам перед каждой генерацией.
    draft.unlimited = unlimitedName(from.id);
    delete draft.accessCode; delete draft.walletCost; delete draft.balanceKopecks;
    return renderWizard(from, chatId, 'confirm', draft, messageId);
  }
  delete draft.unlimited;
  const accessCode = await selectAccessCode(draft.userId, units);
  if (accessCode) { draft.accessCode = accessCode; delete draft.walletCost; delete draft.balanceKopecks; }
  else {
    delete draft.accessCode;
    draft.walletCost = wallet.generationCost(units);
    draft.balanceKopecks = await wallet.getBalanceKopecks(draft.userId);
  }
  await renderWizard(from, chatId, 'confirm', draft, messageId);
}

/** Свой активный код доступа — на него докупаем генерации с баланса, чтобы не плодить коды. */
async function ownTopupCode(userId) {
  const rows = await supabaseFetch(`sticker_access_codes?owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=code&order=created_at.desc&limit=1`);
  return rows[0]?.code || null;
}

const UNLIMITED_CODE_NAME = 'Безлимитный тариф (Telegram)';

/** Код безлимитного тарифа владельца: создаём при первой генерации, лимит держим с большим запасом. */
async function unlimitedAccessCode(userId, units) {
  const rows = await supabaseFetch(`sticker_access_codes?owner_user_id=eq.${encodeURIComponent(userId)}&name=eq.${encodeURIComponent(UNLIMITED_CODE_NAME)}&select=code,active,generation_limit,generation_used&order=created_at.asc&limit=1`);
  const row = rows[0];
  if (!row) {
    const code = `STK-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
    await supabaseFetch('sticker_access_codes', { method: 'POST', body: JSON.stringify({ code, name: UNLIMITED_CODE_NAME, active: true, owner_user_id: userId, generation_limit: 100000, generation_used: 0 }) });
    return code;
  }
  if (!row.active || remainingOf(row) < units + 1000) {
    await supabaseFetch(`sticker_access_codes?code=eq.${encodeURIComponent(row.code)}`, { method: 'PATCH', body: JSON.stringify({ active: true, generation_limit: Number(row.generation_used || 0) + units + 100000 }) });
  }
  return row.code;
}

/** Купить с баланса ровно нужное число генераций; возвращает код, на который они легли. */
async function buyGenerationsWithWallet(draft) {
  const units = requiredUnits(draft);
  const target = await ownTopupCode(draft.userId);
  const result = await wallet.payWithWallet({
    userId: draft.userId,
    productKind: 'stickers',
    fields: { range_quantity: units, sticker_target: draft.category === 'box' ? 'box' : 'product', ...(target ? { renewal_target_key: target } : {}) },
    priceRub: wallet.generationCost(units),
    snapshot: { packs: [], units, total: wallet.generationCost(units), source: 'telegram-wallet' },
  });
  if (!result.ok) return result;
  return { ok: true, accessCode: result.order.access_code, balanceKopecks: result.balanceKopecks };
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
  return choiceKeyboard([row, [{ text: '➕ Создать ещё', callback_data: 'gen:start' }, ...MENU_ROW]].filter(items => items.length));
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
  return runGeneration(callback.from, callback.message.chat.id, callback.message.message_id, session,
    () => answerCallbackQuery(callback.id, 'Этот запрос уже обработан'));
}

/** Генерация по подтверждённому черновику: по кнопке «Подтвердить» или сама после пополнения баланса. */
async function runGeneration(from, chatId, messageId, session, onDuplicate = async () => {}) {
  const draft = session.draft || {};
  // Сообщение мастера переиспользуется между генерациями, поэтому к его id добавлена метка
  // этого запуска мастера (draft.nonce): двойной клик по «Подтвердить» по-прежнему отсекается.
  const requestId = `${from.id}:${messageId}${draft.nonce || ''}`;
  if (!await claimGenerationRequest(requestId, from, chatId, draft)) { await onDuplicate(); return; }
  let paidLine = '';
  if (draft.unlimited) {
    draft.accessCode = await unlimitedAccessCode(draft.userId, requiredUnits(draft));
    paidLine = ` У вас, ${escapeHtml(draft.unlimited)}, безлимитный тариф.`;
  } else if (!draft.accessCode) {
    // Генераций на кодах нет — докупаем ровно нужное с баланса и генерируем этим кодом.
    const bought = await buyGenerationsWithWallet(draft);
    if (!bought.ok) {
      // Деньги не списаны: освобождаем запрос, чтобы после пополнения можно было нажать «Подтвердить» снова.
      await supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}`, { method: 'DELETE' }).catch(() => {});
      draft.balanceKopecks = bought.balanceKopecks;
      draft.error = 'Денег на балансе не хватает — пополните баланс.';
      await renderWizard(from, chatId, 'confirm', draft, messageId);
      return;
    }
    draft.accessCode = bought.accessCode;
    paidLine = ` Списано ${wallet.formatRub(wallet.generationCost(requiredUnits(draft)))}, на балансе ${wallet.formatRub(bought.balanceKopecks / 100)}.`;
  }
  await saveSession(from, chatId, 'generating', draft);
  await showScreen(chatId, messageId, `${wizardTrail(draft)}⏳ Генерирую и подготавливаю PDF…`);
  try {
    const requesterHash = telegramRequesterHash(from.id);
    const result = await generateStickers({ ...draft, requesterHash, clientEntryId: `telegram:${requestId}`, channel: 'telegram' });
    await completeGenerationRequest(requestId, result);
    await clearSession(from.id);
    await sendPreview(chatId, requestId, result, 0);
    await sendDocument(chatId, absoluteAssetUrl(result.pdfUrl), { caption: paidLine ? `Готово: ${result.quantity || 1} шт.${paidLine}` : `Готово: ${result.quantity || 1} шт. Осталось генераций на коде: ${result.access?.remaining ?? '—'}` });
    // Мягкая подсказка про Помощник — не после каждой генерации, примерно в каждой третьей.
    if (Math.random() < 1 / 3) await sendMessage(chatId, `💡 Клиент пришёл без кода? «Помощник ПВЗ» подберёт его по базе WB ПВЗ за пару минут: ${PROGRAM_URL}`, { reply_markup: choiceKeyboard([[{ text: '🔑 Как это работает', callback_data: 'menu:code' }]]) });
  } catch (error) {
    await supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', error: String(error.message || '').slice(0, 500), completed_at: new Date().toISOString() }) }).catch(() => {});
    await clearSession(from.id);
    // Если генерации уже куплены с баланса, они остались на коде — следующая попытка возьмёт их без оплаты.
    const kept = paidLine && !draft.unlimited ? '\n\nОплаченные генерации остались на вашем счёте — попробуйте ещё раз, повторно платить не нужно.' : '';
    await sendMessage(chatId, `Не удалось создать ШК: ${escapeHtml(error.message)}${kept}`, { reply_markup: choiceKeyboard([[{ text: '🏷 Попробовать снова', callback_data: 'menu:stickers' }], MENU_ROW]) });
  }
}

function wizardNonce() { return String(crypto.randomInt(100000, 1000000)); }

/** messageId — сообщение, которое превращается в мастер (например, главное меню). Без него — новое сообщение. */
async function startGeneration(from, chatId, messageId) {
  const userId = await findUser(from.id);
  if (!userId) { await sendLoginPrompt(from, chatId, 'Этот Telegram ещё не привязан к аккаунту. Войдите через Mini App — после привязки эта кнопка исчезнет.'); return; }
  await renderWizard(from, chatId, 'choose_kind', { userId, nonce: wizardNonce() }, messageId);
}

async function startForCategory(from, chatId, category) {
  const userId = await findUser(from.id);
  if (!userId) { await sendLoginPrompt(from, chatId, 'Сначала войдите через Mini App — бот генерирует по вашим пакетам генераций.'); return; }
  await renderWizard(from, chatId, 'choose_mode', { userId, category, nonce: wizardNonce() });
}

/** Баланс в рублях. */
async function walletRub(userId) {
  return (await wallet.getBalanceKopecks(userId)) / 100;
}


function remainingOf(row) { return Math.max(0, Number(row.generation_limit || 0) - Number(row.generation_used || 0)); }

/** Короткая строка подписки «Помощника ПВЗ»: «Базовый» до 19.11 · бесплатно до 1 ноября · нет подписки. */
function helperStatusLine(ent, free) {
  const plan = ent?.plan && PLANS[ent.plan];
  if (plan) {
    const until = ent.paid_until || ent.ends_at;
    return `«${plan.title}»${until ? ` до ${dayMonthShort(until)}` : ''}`;
  }
  return free || 'нет подписки';
}

function cellPrintStatusLine(keys) {
  if (!keys.length) return 'нет ключа';
  const running = keys.filter(key => key.expires_at && Date.parse(key.expires_at) > Date.now())
    .sort((a, b) => Date.parse(b.expires_at) - Date.parse(a.expires_at));
  if (running.length) return `до ${dayMonthShort(running[0].expires_at)}`;
  if (keys.some(key => !key.activated_at)) return 'ключ не активирован';
  return 'срок закончился';
}

function dayMonthShort(value) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' }).format(new Date(value));
}

/** Профиль: деньги и что куплено — по строке на каждое. */
async function showProfile(from, chatId, messageId) {
  const userId = await findUser(from.id);
  if (!userId) {
    await sendLoginPrompt(from, chatId, '<b>Кабинет не подключён</b>\nВойдите через Telegram — кабинет создастся сам.');
    return;
  }
  const id = encodeURIComponent(userId);
  const [codes, balance, ent, cellKeys, free, technical] = await Promise.all([
    supabaseFetch(`sticker_access_codes?owner_user_id=eq.${id}&active=eq.true&select=generation_limit,generation_used`),
    walletRub(userId).catch(() => 0),
    supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) }).catch(() => null),
    supabaseFetch(`cell_print_licenses?owner_user_id=eq.${id}&active=eq.true&select=activated_at,expires_at`).catch(() => []),
    helperFreeText(),
    isTechnicalTelegramUser(userId),
  ]);
  const stickers = codes.reduce((sum, row) => sum + remainingOf(row), 0);
  const text = [
    '<b>👤 Профиль</b>',
    `💰 Баланс: <b>${wallet.formatRub(balance)}</b>`,
    // Генерации на кодах — только если есть: кто работает в боте, обходится балансом.
    ...(stickers ? [`🏷 Стикеры: ${stickers.toLocaleString('ru-RU')} шт.`] : []),
    `🖥 Помощник ПВЗ: ${helperStatusLine(ent, free)}`,
    `🖨 Печать ячеек: ${cellPrintStatusLine(cellKeys)}`,
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: profileKeyboard({ technical }) });
}

async function showHelp(chatId, messageId) {
  await showScreen(chatId, messageId, [
    '<b>❓ Как пользоваться</b>',
    '🏷 Стикеры и QR — выберите тип и количество, придёт PDF.',
    '⭐ Отзывы — войдите в кабинет WB по SMS.',
    '💰 Оплата — с баланса в «👤 Профиль».',
  ].join('\n'), { reply_markup: choiceKeyboard([[{ text: '🆘 Написать в поддержку', url: SUPPORT_URL }], MENU_ROW]) });
}

function reviewFilterKeyboard() {
  return choiceKeyboard([
    [1, 2, 3, 4, 5].map(star => ({ text: `${star} ⭐`, callback_data: `rv:filter:${star}` })),
    [{ text: 'Все оценки', callback_data: 'rv:filter:all' }],
    [{ text: '💰 Пополнить баланс', callback_data: 'topup:home' }],
    [{ text: 'Сменить ПВЗ', callback_data: 'rv:points' }, { text: 'Отключить WB', callback_data: 'rv:disconnect' }],
    MENU_ROW,
  ]);
}

/**
 * «Кто поставил оценку» — цена и пополнение. reason='empty' — нажали «Кто поставил оценку», а денег не хватило;
 * then — какой отзыв раскрыть сразу после пополнения ('rv:<фильтр>:<стр>:<№>').
 */
async function showReviewPaywall(from, chatId, reason, messageId, then) {
  const userId = await findUser(from.id);
  if (!userId) {
    await sendLoginPrompt(from, chatId, 'Чтобы узнать, кто поставил оценку, войдите через Telegram — кабинет создастся сам.');
    return;
  }
  const [balance, free] = await Promise.all([walletRub(userId), helperFreeText()]);
  const text = [
    `<b>👤 Кто поставил оценку — ${wallet.formatRub(REVIEW_PRICE)}</b>`,
    'Телефон клиента, когда забрал или отказался, ячейка. Повторно — бесплатно.',
    '',
    `💰 На балансе: <b>${wallet.formatRub(balance)}</b>${reason === 'empty' ? ' — не хватает' : ''}`,
    ...(then ? ['После пополнения автор откроется сам.'] : []),
    ...(free ? ['', `💡 В Помощнике ПВЗ — ${free}: ${PROGRAM_URL}`] : []),
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    ...(then ? [topupAndBuyRow(REVIEW_PRICE - balance, then)] : topupRows(REVIEW_PRICE - balance)),
    [{ text: '⭐ К отзывам', callback_data: 'rv:filters' }, ...MENU_ROW],
  ]) });
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
  return findPickupEvents(await loadGoodsSnapshot(telegramId, connection), userIds);
}

async function showReviewFilters(from, chatId, messageId) {
  const connection = await getWbConnection(from.id);
  if (connection?.session?.token && connection.state === 'await_point') {
    await beginPointSelection(from, chatId, connection);
    return;
  }
  if (!connection?.session?.token || connection.state !== 'ready') {
    const session = { deviceId: crypto.randomUUID() };
    await saveWbConnection(from, chatId, 'await_phone', session);
    await showScreen(chatId, messageId, '<b>Подключение кабинета WB</b>\n\nОтправьте номер телефона сотрудника в формате <code>79991234567</code>. Сообщение с номером будет удалено после обработки.', { reply_markup: choiceKeyboard([MENU_ROW]) });
    return;
  }
  const userId = await findUser(from.id);
  const balance = userId ? await walletRub(userId).catch(() => null) : null;
  const balanceLine = balance == null ? '' : ` · 💰 ${wallet.formatRub(balance)}`;
  await showScreen(chatId, messageId, `<b>⭐ Отзывы ПВЗ ${connection.session.pointId}</b>\nКто поставил оценку — ${wallet.formatRub(REVIEW_PRICE)}${balanceLine}\n\nКакие оценки показать?`, { reply_markup: reviewFilterKeyboard() });
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
    const keyboard = choiceKeyboard([[{ text: '👤 Кто поставил оценку', callback_data: callbackData }]]);
    await sendMessage(chatId, reviewText(review, safePage * 5 + index + 1, result.total), { reply_markup: keyboard });
  }
  const navigation = [];
  if (safePage > 0) navigation.push({ text: '⬅️ Назад', callback_data: `rv:page:${filterKey}:${safePage - 1}` });
  if (safePage + 1 < totalPages) navigation.push({ text: 'Далее ➡️', callback_data: `rv:page:${filterKey}:${safePage + 1}` });
  await sendMessage(chatId, `Страница <b>${safePage + 1}</b> из <b>${totalPages}</b>`, {
    reply_markup: choiceKeyboard([navigation, [{ text: 'Изменить оценку', callback_data: 'rv:filters' }]].filter(row => row.length)),
  });
}

function authorIdentifiers(reviewOrUserId, userSid) {
  const review = reviewOrUserId && typeof reviewOrUserId === 'object' ? reviewOrUserId : null;
  return review ? reviewAuthorIds(review) : [...new Set([reviewOrUserId, userSid]
    .map(Number).filter(value => Number.isSafeInteger(value) && value > 0))];
}

/** Данные автора отзыва. found=false — WB ничего не отдал, проверку не списываем. */
async function buildReviewAuthor(from, connection, reviewOrUserId, userSid) {
  const review = reviewOrUserId && typeof reviewOrUserId === 'object' ? reviewOrUserId : null;
  const identifiers = authorIdentifiers(reviewOrUserId, userSid);
  const reviewEvents = (Array.isArray(review?.goods) ? review.goods : [])
    .filter(item => item?.status_updated)
    .sort((left, right) => new Date(right.status_updated || 0) - new Date(left.status_updated || 0));
  const [users, pickupResult] = await Promise.all([
    // users-data отвечает 403 «недостаточно прав» аккаунтам без роли руководителя — телефон тогда берём из продаж.
    identifiers.length ? wbPvz.loadUsers(connection.session, identifiers).catch(error => {
      console.warn('WB users-data failed', error.status, error.message);
      return [];
    }) : [],
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
  const found = phone !== '—' || Boolean(!pickupResult.error && pickupResult.events.length);
  return {
    found,
    text: `<b>Информация об авторе</b>\n\n${clientLine}Телефон: <code>${escapeHtml(phone)}</code>\n\n${pickupText}`,
  };
}

/**
 * «👤 Кто поставил оценку» — платно: 1 проверка за клиента в этом ПВЗ. Баланс проверяем до запроса
 * к WB, а списываем после — и только если WB что-то отдал. Повтор того же автора бесплатный.
 */
/** Безлимит или Telegram ID через запятую в REVIEW_FREE_TELEGRAM_IDS — «Кто поставил оценку» без оплаты. */
function reviewFreeFor(telegramId) {
  return Boolean(unlimitedName(telegramId)) || envIdList('REVIEW_FREE_TELEGRAM_IDS').includes(String(telegramId));
}

async function revealReviewAuthor(from, chatId, reviewOrUserId, userSid, then) {
  const connection = await getWbConnection(from.id);
  if (!connection?.session?.token || connection.state !== 'ready') return showReviewFilters(from, chatId);
  if (reviewFreeFor(from.id)) {
    const info = await buildReviewAuthor(from, connection, reviewOrUserId, userSid);
    return sendMessage(chatId, `${info.text}\n\n<i>${unlimitedLine(from.id)}</i>`);
  }
  const userId = await findUser(from.id);
  if (!userId) return showReviewPaywall(from, chatId);
  const clientId = authorIdentifiers(reviewOrUserId, userSid)[0] || null;
  const pointId = Number(connection.session.pointId) || 0;
  // Баланс, факт прошлого показа и данные автора узнаём параллельно. Пэйвол показываем только
  // после запроса к WB: если автора не определить, показ бесплатный и денег не требуется.
  const [revealed, balance, info] = await Promise.all([
    clientId
      ? supabaseFetch(`bot_review_reveals?user_id=eq.${encodeURIComponent(userId)}&point_id=eq.${pointId}&client_id=eq.${clientId}&select=client_id&limit=1`).then(rows => rows.length > 0)
      : Promise.resolve(false),
    walletRub(userId),
    buildReviewAuthor(from, connection, reviewOrUserId, userSid),
  ]);
  let footer;
  if (!clientId || !info.found) footer = 'Данных об авторе нет — деньги не списаны.';
  else if (revealed) footer = 'Этого автора вы уже смотрели — бесплатно.';
  else if (balance < REVIEW_PRICE) return showReviewPaywall(from, chatId, 'empty', undefined, then);
  else {
    // bot_review_spend списывает 25 ₽ с баланса (миграция 20261023_wallet.sql), balance — в копейках.
    const spent = await supabaseFetch('rpc/bot_review_spend', { method: 'POST', body: JSON.stringify({ p_user: userId, p_point: pointId, p_client: clientId }) });
    if (!spent?.ok) return showReviewPaywall(from, chatId, 'empty', undefined, then);
    if (!spent.free) notifyAdminSpend({ userId, priceRub: REVIEW_PRICE, title: 'Кто поставил оценку', balanceKopecks: spent.balance }).catch(() => {});
    footer = spent.free ? 'Этого автора вы уже смотрели — бесплатно.' : `Списано ${wallet.formatRub(REVIEW_PRICE)} · на балансе ${wallet.formatRub(Number(spent.balance) / 100)}`;
  }
  await sendMessage(chatId, `${info.text}\n\n<i>${footer}</i>`);
}

async function showReviewAuthorByPosition(from, chatId, filterKey, page, index) {
  const connection = await getWbConnection(from.id);
  if (!connection?.session?.token || connection.state !== 'ready') return showReviewFilters(from, chatId);
  const stars = reviewStars(filterKey);
  if (!stars.length || !Number.isInteger(page) || page < 0 || !Number.isInteger(index) || index < 0 || index >= 5) return;
  const result = await wbPvz.loadReviews(connection.session, stars, page, 5);
  const review = result.data[index];
  if (!review) return sendMessage(chatId, 'Отзыв больше не найден в этой позиции. Обновите список отзывов.');
  return revealReviewAuthor(from, chatId, review, undefined, `rv:${filterKey}:${page}:${index}`);
}

async function beginPointSelection(from, chatId, connection) {
  const points = await wbPvz.loadPoints(connection.session);
  if (!points.length) throw new Error('В кабинете WB не найдено доступных ПВЗ');
  if (points.length === 1) {
    const session = await wbPvz.selectPoint(connection.session, points[0].id);
    await saveWbConnection(from, chatId, 'ready', session);
    return afterWbReady(from, chatId);
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
  // Пришёл по приглашению и только что создал кабинет — привязываем к пригласившему.
  await bindTelegramReferral(telegramId).catch(error => console.warn('Telegram referral bind failed', error.message));
  const session = await getSession(telegramId);
  if (session?.draft?.authPromptMessageId) await deleteMessage(session.chat_id, session.draft.authPromptMessageId);
  await clearSession(telegramId);
  await sendMessage(telegramId,
    '<b>Готово — вход выполнен.</b>\n\nКабинет подключён: стикеры, авторы отзывов и продление программ доступны в меню.',
    { reply_markup: HOME_KEYBOARD },
  );
  await showMainMenu({ id: telegramId }, telegramId);
}

// ── Баланс: пополнение и покупки с баланса (server/_wallet.js) ──

const LOGIN_FOR_WALLET = 'Баланс хранится в кабинете shk-wb.ru. Войдите через Telegram — это пара секунд, кабинет создастся сам.';

async function showTopup(from, chatId, messageId) {
  const userId = await findUser(from.id);
  if (!userId) return sendLoginPrompt(from, chatId, LOGIN_FOR_WALLET);
  const balance = await walletRub(userId);
  const text = [
    '<b>💰 Пополнение</b>',
    `На балансе: <b>${wallet.formatRub(balance)}</b>`,
    '🎁 +5% от 500 ₽, +10% от 1000 ₽',
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    ...topupRows(0),
    [{ text: '✏️ Своя сумма', callback_data: 'topup:custom' }],
    [{ text: '⬅️ Профиль', callback_data: 'menu:profile' }],
  ]) });
}

async function askTopupAmount(from, chatId, messageId, error) {
  const userId = await findUser(from.id);
  if (!userId) return sendLoginPrompt(from, chatId, LOGIN_FOR_WALLET);
  const id = await showScreen(chatId, messageId, `${error ? `⚠️ ${error}\n\n` : ''}<b>Своя сумма</b>\nОтправьте сумму сообщением: от ${wallet.MIN_TOPUP} до ${wallet.MAX_TOPUP.toLocaleString('ru-RU')} ₽.`, { reply_markup: choiceKeyboard([[{ text: '⬅️ Назад', callback_data: 'topup:home' }]]) });
  await saveSession(from, chatId, 'await_topup_amount', { userId, msgId: id });
}

async function acceptTopupAmount(from, chatId, session, message, text) {
  await deleteMessage(chatId, message.message_id).catch(() => {});
  const amount = Number(String(text).replace(/[\s₽р.]/gi, ''));
  const msgId = session.draft?.msgId;
  if (!wallet.validTopup(amount)) return askTopupAmount(from, chatId, msgId, `«${escapeHtml(String(text).slice(0, 20))}» — нужна сумма от ${wallet.MIN_TOPUP} до ${wallet.MAX_TOPUP.toLocaleString('ru-RU')} ₽.`);
  await clearSession(from.id);
  const bonus = wallet.topupBonus(amount);
  await showScreen(chatId, msgId, `<b>Пополнение на ${wallet.formatRub(amount)}</b>${bonus ? `\nЗачислим ${wallet.formatRub(amount + bonus)} с бонусом` : ''}`, { reply_markup: choiceKeyboard([
    [{ text: `💳 Оплатить ${wallet.formatRub(amount)}`, web_app: { url: publicUrl(`/bot-checkout?kind=topup&amount=${amount}`) } }],
    [{ text: '⬅️ Назад', callback_data: 'topup:home' }],
  ]) });
}

const CP_DAYS = [7, 30, 90, 180, 365];
const CP_NEW_DEVICES = [1, 2, 3, 5];
const CP_SCOPES = { wb: 'Wildberries', ozon: 'Ozon', both: 'WB + Ozon' };

function monthsLabel(months) { return months === 1 ? '1 месяц' : months < 5 ? `${months} месяца` : `${months} месяцев`; }
function devicesLabel(count) { return count === 1 ? '1 компьютер' : count < 5 ? `${count} компьютера` : `${count} компьютеров`; }
function cellPrintPrice(days, devices, scope) {
  const base = CELL_PRINT_PRICES[days]?.[devices];
  return base == null ? null : Math.round(base * (scope === 'both' ? 1.8 : 1));
}

async function ownCellKeys(userId) {
  return supabaseFetch(`cell_print_licenses?owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=id,key,duration_days,device_limit,marketplace_scope,activated_at,expires_at&order=created_at.desc&limit=5`);
}

function cellKeyStatus(key) {
  if (!key.activated_at) return `не активирован, ${key.duration_days} дн.`;
  const ends = Date.parse(key.expires_at || '');
  return Number.isFinite(ends) && ends > Date.now() ? `до ${shortDate.format(new Date(ends))}` : 'срок закончился';
}

async function ownLicenseKey(userId) {
  const rows = await supabaseFetch(`license_keys?owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=key,usage_limit,used&order=created_at.desc&limit=1`);
  return rows[0] || null;
}

/**
 * Что покупаем — по частям callback_data. Цену и поля заказа считаем здесь, на сервере, и при
 * показе, и при оплате: кнопке с ценой не доверяем. { error } — товар недоступен.
 */
async function resolveShopItem(userId, parts) {
  const [kind, a, b, c, d] = parts;
  if (kind === 'helper') {
    const months = Number(b), snap = orderSnapshot(a, months);
    if (!snap) return { error: 'Такого тарифа нет.' };
    return {
      title: `<b>🖥 «${PLANS[a].title}» на ${monthsLabel(months)}</b>`,
      priceRub: snap.total, productKind: 'app_subscription', back: `shop:helper:${a}`,
      fields: { app_plan: a, app_term_months: months }, snapshot: snap,
    };
  }
  if (kind === 'cp' && a === 'r') {
    const days = Number(c);
    const rows = await supabaseFetch(`cell_print_licenses?id=eq.${Number(b)}&owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=id,key,duration_days,device_limit,marketplace_scope&limit=1`);
    const key = rows[0];
    if (!key) return { error: 'Ключ не найден или отключён.' };
    if (!CP_DAYS.includes(days)) return { error: 'Такого срока нет.' };
    if (Number(key.duration_days) + days > 4000) return { error: 'Суммарный срок ключа не может быть больше 4000 дней.' };
    // У старых ключей площадка не задана — продлеваем как WB и не передаём площадку в заказ.
    const legacy = !CP_SCOPES[key.marketplace_scope];
    const price = cellPrintPrice(days, key.device_limit, legacy ? 'wb' : key.marketplace_scope);
    if (price == null) return { error: 'Для этого ключа цена не найдена — продлите на сайте.' };
    return {
      title: `<b>🔄 Продление ключа на ${days} дней</b>\n<code>${escapeHtml(key.key)}</code>`,
      priceRub: price, productKind: 'cell_print_license', back: `shop:cp:r:${key.id}`, renewal: true,
      fields: { cell_print_duration_days: days, cell_print_device_limit: key.device_limit, cell_print_marketplace_scope: legacy ? null : key.marketplace_scope, renewal_target_key: key.key },
      snapshot: { cellPrint: { durationDays: days, deviceLimit: key.device_limit, program: false, bonusDays: 0 }, total: price },
    };
  }
  if (kind === 'cp' && a === 'n') {
    const days = Number(b), devices = Number(c), scope = d;
    const price = CP_SCOPES[scope] ? cellPrintPrice(days, devices, scope) : null;
    if (!CP_DAYS.includes(days) || price == null) return { error: 'Такого варианта нет.' };
    return {
      title: `<b>🖨 Ключ: ${days} дней, ${devicesLabel(devices)}, ${CP_SCOPES[scope]}</b>`,
      priceRub: price, productKind: 'cell_print_license', back: `shop:cp:n:${days}:${devices}`,
      fields: { cell_print_duration_days: days, cell_print_device_limit: devices, cell_print_marketplace_scope: scope },
      snapshot: { cellPrint: { durationDays: days, deviceLimit: devices, program: false, bonusDays: 0 }, total: price },
    };
  }
  if (kind === 'wbpk') {
    const count = Number(a), price = LICENSE_PRICES[count];
    if (!price) return { error: 'Такого пакета нет.' };
    const target = await ownLicenseKey(userId);
    return {
      title: `<b>🔑 ${count} подборов кода</b>`,
      priceRub: price, productKind: 'program_license', back: 'shop:wbpk',
      fields: { license_iterations: count, ...(target ? { renewal_target_key: target.key } : {}) },
      snapshot: { license: { iterations: count, total: price }, total: price },
    };
  }
  return { error: 'Такого товара нет.' };
}

/** Экран магазина по callback_data `shop:…`. */
async function showShop(from, chatId, messageId, parts) {
  const userId = await findUser(from.id);
  if (!userId) return sendLoginPrompt(from, chatId, LOGIN_FOR_WALLET);
  const balance = await walletRub(userId);
  const balanceLine = `💰 На балансе: <b>${wallet.formatRub(balance)}</b>`;
  const back = data => [{ text: '⬅️ Назад', callback_data: data }];
  const [kind, a, b, c, d] = parts;

  if (!kind || kind === 'home') {
    return showScreen(chatId, messageId, `<b>🛒 Купить с баланса</b>\n${balanceLine}`, { reply_markup: choiceKeyboard([
      [{ text: '🖥 Подписка «Помощник ПВЗ»', callback_data: 'shop:helper' }],
      [{ text: '🖨 Ключ «Печать ячеек»', callback_data: 'shop:cp' }],
      [{ text: '🔑 Пакет подборов кода', callback_data: 'shop:wbpk' }],
      [{ text: '💰 Пополнить баланс', callback_data: 'topup:home' }],
      [{ text: '⬅️ Профиль', callback_data: 'menu:profile' }],
    ]) });
  }
  if (kind === 'helper' && !a) {
    const [ent, free] = await Promise.all([
      supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) }).catch(() => null),
      helperFreeText(),
    ]);
    const freeNote = free ? '\nОплата начнёт действовать после бесплатного периода.' : '';
    return showScreen(chatId, messageId, `<b>🖥 Подписка «Помощник ПВЗ»</b>\nСейчас: ${helperStatusLine(ent, free)}${freeNote}\n${balanceLine}`, { reply_markup: choiceKeyboard([
      ...['basic', 'standard', 'pro'].map(id => [{ text: `${PLANS[id].title} — ${PLANS[id].monthlyPrice} ₽/мес`, callback_data: `shop:helper:${id}` }]),
      back('shop:home'),
    ]) });
  }
  if (kind === 'helper' && a && !b) {
    if (!PLANS[a]) return showShop(from, chatId, messageId, ['helper']);
    return showScreen(chatId, messageId, `<b>🖥 «${PLANS[a].title}»</b> — ${PLANS[a].summary.toLowerCase()}\n${balanceLine}\n\nНа какой срок?`, { reply_markup: choiceKeyboard([
      ...Object.keys(TERMS).map(Number).map(months => [{ text: `${monthsLabel(months)} — ${planPrice(a, months)} ₽${TERMS[months] ? ` (−${TERMS[months]}%)` : ''}`, callback_data: `shop:helper:${a}:${months}` }]),
      back('shop:helper'),
    ]) });
  }
  if (kind === 'cp' && !a) {
    const keys = await ownCellKeys(userId);
    return showScreen(chatId, messageId, `<b>🖨 Ключ «Печать ячеек»</b>\n${balanceLine}`, { reply_markup: choiceKeyboard([
      ...keys.map(key => [{ text: `🔄 Продлить ${key.key} (${cellKeyStatus(key)})`, callback_data: `shop:cp:r:${key.id}` }]),
      [{ text: '➕ Новый ключ', callback_data: 'shop:cp:n' }],
      back('shop:home'),
    ]) });
  }
  if (kind === 'cp' && a === 'r' && b && !c) {
    const rows = await supabaseFetch(`cell_print_licenses?id=eq.${Number(b)}&owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=id,key,device_limit,marketplace_scope,activated_at,expires_at,duration_days&limit=1`);
    const key = rows[0];
    if (!key) return showShop(from, chatId, messageId, ['cp']);
    const scope = CP_SCOPES[key.marketplace_scope] ? key.marketplace_scope : 'wb';
    return showScreen(chatId, messageId, `<b>🔄 Продление ключа</b> <code>${escapeHtml(key.key)}</code>\n${cellKeyStatus(key)} · ${devicesLabel(key.device_limit)} · ${CP_SCOPES[scope]}\n\n${balanceLine}\n\nНа сколько продлить?`, { reply_markup: choiceKeyboard([
      ...CP_DAYS.map(days => ({ days, price: cellPrintPrice(days, key.device_limit, scope) })).filter(item => item.price != null)
        .map(item => [{ text: `${item.days} дней — ${item.price} ₽`, callback_data: `shop:cp:r:${key.id}:${item.days}` }]),
      back('shop:cp'),
    ]) });
  }
  if (kind === 'cp' && a === 'n' && !b) {
    return showScreen(chatId, messageId, `<b>➕ Новый ключ</b>\nНа какой срок? Цена за 1 ПК.`, { reply_markup: choiceKeyboard([
      ...CP_DAYS.map(days => [{ text: `${days} дней — от ${cellPrintPrice(days, 1, 'wb')} ₽`, callback_data: `shop:cp:n:${days}` }]),
      back('shop:cp'),
    ]) });
  }
  if (kind === 'cp' && a === 'n' && b && !c) {
    const days = Number(b);
    if (!CP_DAYS.includes(days)) return showShop(from, chatId, messageId, ['cp', 'n']);
    return showScreen(chatId, messageId, `<b>➕ Новый ключ на ${days} дней</b>\n\nНа скольких компьютерах будет работать?`, { reply_markup: choiceKeyboard([
      ...CP_NEW_DEVICES.map(devices => [{ text: `${devicesLabel(devices)} — ${cellPrintPrice(days, devices, 'wb')} ₽`, callback_data: `shop:cp:n:${days}:${devices}` }]),
      back('shop:cp:n'),
    ]) });
  }
  if (kind === 'cp' && a === 'n' && b && c && !d) {
    const days = Number(b), devices = Number(c);
    if (cellPrintPrice(days, devices, 'wb') == null) return showShop(from, chatId, messageId, ['cp', 'n']);
    return showScreen(chatId, messageId, `<b>➕ Новый ключ: ${days} дней, ${devicesLabel(devices)}</b>\n\nДля какой площадки?`, { reply_markup: choiceKeyboard([
      ...Object.keys(CP_SCOPES).map(scope => [{ text: `${CP_SCOPES[scope]} — ${cellPrintPrice(days, devices, scope)} ₽`, callback_data: `shop:cp:n:${days}:${devices}:${scope}` }]),
      back(`shop:cp:n:${days}`),
    ]) });
  }
  if (kind === 'wbpk' && !a) {
    const key = await ownLicenseKey(userId);
    const keyLine = key ? `Ваш ключ: осталось ${Math.max(0, Number(key.usage_limit) - Number(key.used))} — пакет добавится к нему.` : '';
    return showScreen(chatId, messageId, `<b>🔑 Пакет подборов кода</b>\nДля «Помощника ПВЗ» сверх тарифа.${keyLine ? `\n${keyLine}` : ''}\n${balanceLine}`, { reply_markup: choiceKeyboard([
      ...Object.keys(LICENSE_PRICES).map(Number).map(count => [{ text: `${count} шт. — ${LICENSE_PRICES[count]} ₽`, callback_data: `shop:wbpk:${count}` }]),
      back('shop:home'),
    ]) });
  }
  // Последний шаг любой ветки — подтверждение оплаты.
  return showShopConfirm(from, chatId, messageId, userId, parts);
}

async function showShopConfirm(from, chatId, messageId, userId, parts, error) {
  const item = await resolveShopItem(userId, parts);
  if (item.error) return showScreen(chatId, messageId, `⚠️ ${item.error}`, { reply_markup: choiceKeyboard([[{ text: '⬅️ В магазин', callback_data: 'shop:home' }]]) });
  const balance = await walletRub(userId);
  const lines = [`${error ? `⚠️ ${error}\n` : ''}${item.title}`, `Цена: <b>${wallet.formatRub(item.priceRub)}</b> · 💰 ${wallet.formatRub(balance)}`];
  if (balance >= item.priceRub) {
    // Метка на кнопке оплаты: повторное нажатие той же кнопки не спишет деньги второй раз.
    const nonce = crypto.randomInt(100000, 1000000);
    return showScreen(chatId, messageId, lines.join('\n'), { reply_markup: choiceKeyboard([
      [{ text: `✅ Оплатить ${wallet.formatRub(item.priceRub)} с баланса`, callback_data: `shop:pay:${nonce}:${parts.join(':')}` }],
      [{ text: '⬅️ Назад', callback_data: item.back }],
    ]) });
  }
  lines.push(`Не хватает <b>${wallet.formatRub(item.priceRub - balance)}</b> — после пополнения покупка пройдёт сама.`);
  return showScreen(chatId, messageId, lines.join('\n'), { reply_markup: choiceKeyboard([
    topupAndBuyRow(item.priceRub - balance, `shop:${parts.join(':')}`, messageId),
    [{ text: '⬅️ Назад', callback_data: item.back }],
  ]) });
}

async function payShopItem(from, chatId, messageId, nonce, parts) {
  const userId = await findUser(from.id);
  if (!userId) return sendLoginPrompt(from, chatId, LOGIN_FOR_WALLET);
  const item = await resolveShopItem(userId, parts);
  if (item.error) return showShopConfirm(from, chatId, messageId, userId, parts);
  const requestId = `shop:${from.id}:${messageId}:${nonce}`;
  if (!await claimGenerationRequest(requestId, from, chatId, { userId, shop: parts })) return;
  await showScreen(chatId, messageId, `${item.title}\n\n⏳ Оплачиваю с баланса…`);
  let result;
  try {
    result = await wallet.payWithWallet({ userId, productKind: item.productKind, fields: item.fields, priceRub: item.priceRub, snapshot: item.snapshot });
  } catch (error) {
    await supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', error: String(error.message || '').slice(0, 500), completed_at: new Date().toISOString() }) }).catch(() => {});
    return showScreen(chatId, messageId, `⚠️ Не удалось оформить покупку: ${escapeHtml(error.message)}\n\nДеньги вернулись на баланс. Если повторится — напишите в поддержку.`, { reply_markup: choiceKeyboard([[{ text: '🆘 Поддержка', callback_data: 'menu:support' }], [{ text: '⬅️ В магазин', callback_data: 'shop:home' }]]) });
  }
  if (!result.ok) {
    await supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}`, { method: 'DELETE' }).catch(() => {});
    return showShopConfirm(from, chatId, messageId, userId, parts, 'Денег на балансе не хватает.');
  }
  await completeGenerationRequest(requestId, { orderId: result.order.id });
  const order = result.order;
  let done;
  if (item.productKind === 'app_subscription') {
    const ent = await supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) }).catch(() => null);
    const until = ent?.paid_until || ent?.ends_at;
    done = `Подписка оплачена${until ? ` до <b>${dayMonthShort(until)}</b>` : ''}.`;
  } else if (item.productKind === 'cell_print_license') {
    done = item.renewal
      ? `Ключ <code>${escapeHtml(order.cell_print_license_key)}</code> продлён на ${item.fields.cell_print_duration_days} дней.`
      : `Ваш ключ: <code>${escapeHtml(order.cell_print_license_key)}</code>\nСрок пойдёт с первой активации.`;
  } else {
    done = `+${item.fields.license_iterations} подборов — уже в «Помощнике ПВЗ».`;
  }
  await showScreen(chatId, messageId, `<b>Готово ✅</b> ${done}\n💰 Осталось ${wallet.formatRub(result.balanceKopecks / 100)}`, { reply_markup: choiceKeyboard([
    [{ text: '👤 Профиль', callback_data: 'menu:profile' }, { text: '🛒 Ещё покупка', callback_data: 'shop:home' }],
    MENU_ROW,
  ]) });
}

// ── Рефералка (поверх referral_accounts / bind_referral сайта, миграция 20261025_bot_referrals.sql) ──

const REFERRAL_PERCENT = 10; // = award_referral_order (0.10) в SQL — менять вместе
const REFERRAL_PAYLOAD = /^r_([A-Za-z0-9]{6,16})$/;
let cachedBotUsername = null;

/** Имя бота для ссылки t.me/<бот>?start=… — у тестового и боевого бота разное, поэтому спрашиваем getMe. */
async function botUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  const me = await telegramRequest('getMe', {}).catch(() => null);
  cachedBotUsername = me?.username || process.env.TELEGRAM_BOT_USERNAME || process.env.VITE_TELEGRAM_BOT_USERNAME || null;
  return cachedBotUsername;
}

async function referralLinks(code) {
  const username = await botUsername();
  return {
    telegram: username ? `https://t.me/${username}?start=r_${code}` : null,
    site: publicUrl(`/r/${code}`),
  };
}

/**
 * /start r_<КОД>: запомнить, кто пригласил. Первый переход побеждает; если кабинет уже есть,
 * привязать нельзя (приглашение считается только для новых) — ничего не сохраняем.
 */
async function captureReferral(from, rawCode) {
  const code = String(rawCode).toUpperCase();
  if (await findUser(from.id)) return false;
  const [owners, aliases] = await Promise.all([
    supabaseFetch(`referral_accounts?referral_code=eq.${encodeURIComponent(code)}&select=user_id&limit=1`),
    supabaseFetch(`referral_code_aliases?referral_code=eq.${encodeURIComponent(code)}&select=user_id&limit=1`),
  ]);
  if (!owners.length && !aliases.length) return false;
  const rows = await supabaseFetch('telegram_referral_captures?on_conflict=telegram_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ telegram_user_id: Number(from.id), referral_code: code }),
  });
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Кабинет для этого Telegram только что создан — привязываем к пригласившему (bind_referral проверит,
 * что переход был до регистрации и не раньше 30 дней) и сообщаем пригласившему в бот.
 */
async function bindTelegramReferral(telegramId, userId) {
  const uid = userId || await findUser(telegramId);
  if (!uid) return false;
  const rows = await supabaseFetch(`telegram_referral_captures?telegram_user_id=eq.${Number(telegramId)}&bound_user_id=is.null&select=referral_code,captured_at&limit=1`);
  const capture = rows[0];
  if (!capture) return false;
  const bound = await supabaseFetch('rpc/bind_referral', {
    method: 'POST',
    body: JSON.stringify({ p_user_id: uid, p_code: capture.referral_code, p_captured_at: capture.captured_at }),
  }).catch(() => false);
  await supabaseFetch(`telegram_referral_captures?telegram_user_id=eq.${Number(telegramId)}`, {
    method: 'PATCH', body: JSON.stringify({ bound_user_id: bound === true ? uid : null, bound_at: new Date().toISOString() }),
  }).catch(() => {});
  if (bound !== true) return false;
  const attribution = await supabaseFetch(`referral_attributions?invited_user_id=eq.${encodeURIComponent(uid)}&select=referrer_user_id&limit=1`).catch(() => []);
  const referrer = attribution[0]?.referrer_user_id;
  const tg = referrer ? await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(referrer)}&select=telegram_user_id&limit=1`).catch(() => []) : [];
  if (tg[0]?.telegram_user_id) {
    await sendMessage(tg[0].telegram_user_id, `<b>🎉 По вашей ссылке пришёл новый пользователь</b>\n\nС каждой его оплаты вам начисляется ${REFERRAL_PERCENT}% — деньги можно перевести на баланс бота или вывести на карту.`, {
      reply_markup: choiceKeyboard([[{ text: '👥 Мои приглашения', callback_data: 'menu:ref' }]]),
    }).catch(() => {});
  }
  return true;
}

async function showReferrals(from, chatId, messageId, notice) {
  const userId = await findUser(from.id);
  if (!userId) return sendLoginPrompt(from, chatId, `<b>👥 Пригласить друга — ${REFERRAL_PERCENT}%</b>\nВойдите через Telegram — бот покажет вашу ссылку.`);
  const account = await supabaseFetch('rpc/ensure_referral_account', { method: 'POST', body: JSON.stringify({ p_user_id: userId }) });
  const [invited, links] = await Promise.all([
    supabaseFetch(`referral_attributions?referrer_user_id=eq.${encodeURIComponent(userId)}&select=invited_user_id`).catch(() => []),
    referralLinks(account.referral_code),
  ]);
  const available = Number(account.available_kopecks || 0) / 100;
  const earned = Number(account.earned_kopecks || 0) / 100;
  const text = [
    ...(notice ? [notice, ''] : []),
    `<b>👥 Приглашайте коллег — ${REFERRAL_PERCENT}% с их оплат</b>`,
    '',
    'Ваша ссылка:',
    links.telegram || links.site,
    '',
    `Приглашено: <b>${invited.length}</b> · заработано: <b>${wallet.formatRub(earned)}</b>`,
    `Доступно: <b>${wallet.formatRub(available)}</b>`,
  ].join('\n');
  const share = links.telegram || links.site;
  const shareText = 'Стикеры и QR для возвратов WB, код клиента и отзывы ПВЗ — бот shk-wb.ru';
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    [{ text: '📤 Поделиться ссылкой', url: `https://t.me/share/url?url=${encodeURIComponent(share)}&text=${encodeURIComponent(shareText)}` }],
    ...(available > 0 ? [[{ text: `💰 Перевести ${wallet.formatRub(available)} на баланс`, callback_data: 'ref:towallet' }]] : []),
    [{ text: '🏦 Вывести на карту (от 500 ₽)', web_app: { url: publicUrl('/cabinet/referrals') } }],
    MENU_ROW,
  ]) });
}

async function referralToWallet(from, chatId, messageId) {
  const userId = await findUser(from.id);
  if (!userId) return showReferrals(from, chatId, messageId);
  const result = await supabaseFetch('rpc/referral_to_wallet', { method: 'POST', body: JSON.stringify({ p_user: userId, p_kopecks: null }) });
  const notice = result?.ok
    ? `✅ Переведено ${wallet.formatRub(Number(result.moved) / 100)} на баланс. На балансе: ${wallet.formatRub(Number(result.wallet_balance) / 100)}.`
    : '⚠️ Переводить нечего — доступных реферальных денег нет.';
  return showReferrals(from, chatId, messageId, notice);
}

/**
 * После оплаты пополнения «💳 Пополнить на X ₽ и купить» — сразу провести покупку, ради которой
 * пополняли (pricing_snapshot.wallet.then). Вызывается из notifyCompleted один раз на заказ.
 * Возвращает true, если покупка запущена; false — пусть пользователь вернётся к ней сам.
 */
async function afterWalletTopup(order) {
  const then = String(order?.pricing_snapshot?.wallet?.then || '');
  if (!then || !order.user_id) return false;
  const tg = await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(order.user_id)}&select=telegram_user_id&limit=1`);
  const telegramId = Number(tg[0]?.telegram_user_id);
  if (!telegramId) return false;
  const from = { id: telegramId }, chatId = telegramId;
  const messageId = Number(order.pricing_snapshot.wallet.message) || null;
  if (then === 'gen') {
    const session = await getSession(telegramId);
    if (session?.state !== 'confirm' || !session.draft?.mode || session.draft.accessCode) return false;
    await runGeneration(from, chatId, session.draft.msgId, session);
    return true;
  }
  const review = /^rv:(all|[1-5]):(\d+):(\d)$/.exec(then);
  if (review) {
    await showReviewAuthorByPosition(from, chatId, review[1], Number(review[2]), Number(review[3]));
    return true;
  }
  const qr = /^qr:(\d{1,12})$/.exec(then);
  if (qr) {
    await handleClientCode(from, chatId, qr[1]);
    return true;
  }
  if (then.startsWith('shop:')) {
    // Метка оплаты из id заказа: повторный вызов по тому же заказу не купит второй раз.
    const nonce = parseInt(String(order.id).replace(/-/g, '').slice(0, 8), 16) % 1000000;
    await payShopItem(from, chatId, messageId, nonce, then.slice('shop:'.length).split(':'));
    return true;
  }
  return false;
}

async function showSupport(chatId, messageId) {
  const text = [
    '<b>🆘 Поддержка</b>',
    'Есть вопрос или что-то не работает — напишите нам. Скриншот ускорит ответ.',
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    [{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }],
    [{ text: '❓ Как пользоваться ботом', callback_data: 'menu:help' }],
    MENU_ROW,
  ]) });
}

/** Пункты меню открываются в том же сообщении (messageId), «☰ Меню» возвращает его обратно. */
async function handleMenu(from, chatId, item, messageId) {
  // Ушли из мастера кнопкой меню — его черновик больше не нужен.
  if (item !== 'stickers') await clearSession(from.id).catch(() => {});
  if (item === 'stickers') return startGeneration(from, chatId, messageId);
  if (item === 'code') return showClientCode(chatId, messageId);
  if (item === 'reviews') return showReviewFilters(from, chatId, messageId);
  if (item === 'helper') return showHelperInfo(chatId, messageId);
  if (item === 'cellprint') return showCellPrintInfo(chatId, messageId);
  if (item === 'profile') return showProfile(from, chatId, messageId);
  if (item === 'support') return showSupport(chatId, messageId);
  if (item === 'ref') return showReferrals(from, chatId, messageId);
  if (item === 'help') return showHelp(chatId, messageId);
  if (item === 'login') return sendLoginPrompt(from, chatId, '<b>Вход в кабинет</b>\n\nВойдите через Telegram — кабинет shk-wb.ru создастся сам. Если вы уже покупали на сайте, выберите «У меня уже есть кабинет».');
  return showMainMenu(from, chatId, messageId);
}

async function handleCallback(callback) {
  const from = callback.from, chatId = callback.message?.chat?.id;
  if (!chatId) return;
  await touchSubscriber(from, chatId);
  const data = String(callback.data || '');
  const messageId = callback.message?.message_id;
  if (data.startsWith('menu:')) { await answerCallbackQuery(callback.id); await handleMenu(from, chatId, data.slice('menu:'.length), messageId); return; }
  if (data === 'rvbuy:list') { await answerCallbackQuery(callback.id); await showReviewPaywall(from, chatId, undefined, messageId); return; }
  // code:buy — кнопка «Купить генерации» из старых сообщений: теперь это пополнение баланса.
  if (data === 'topup:home' || data === 'code:buy') { await answerCallbackQuery(callback.id); await showTopup(from, chatId, messageId); return; }
  if (data === 'ref:towallet') { await answerCallbackQuery(callback.id); await referralToWallet(from, chatId, messageId); return; }
  if (data === 'topup:custom') { await answerCallbackQuery(callback.id); await askTopupAmount(from, chatId, messageId); return; }
  const shopPay = data.match(/^shop:pay:(\d+):(.+)$/);
  if (shopPay) { await answerCallbackQuery(callback.id); await payShopItem(from, chatId, messageId, shopPay[1], shopPay[2].split(':')); return; }
  if (data.startsWith('shop:')) { await answerCallbackQuery(callback.id); await showShop(from, chatId, messageId, data.split(':').slice(1)); return; }
  if (data === 'rv:start' || data === 'rv:filters') { await answerCallbackQuery(callback.id); await showReviewFilters(from, chatId, messageId); return; }
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
    await afterWbReady(from, chatId);
    return;
  }
  const filterMatch = data.match(/^rv:filter:(all|[1-5])$/);
  if (filterMatch) { await answerCallbackQuery(callback.id); await sendReviewPage(from, chatId, filterMatch[1], 0); return; }
  const reviewPageMatch = data.match(/^rv:page:(all|[1-5]):(\d+)$/);
  if (reviewPageMatch) { await answerCallbackQuery(callback.id); await sendReviewPage(from, chatId, reviewPageMatch[1], Number(reviewPageMatch[2])); return; }
  const authorPositionMatch = data.match(/^rv:who2:(all|[1-5]):(\d+):(\d+)$/);
  if (authorPositionMatch) { await answerCallbackQuery(callback.id); await showReviewAuthorByPosition(from, chatId, authorPositionMatch[1], Number(authorPositionMatch[2]), Number(authorPositionMatch[3])); return; }
  const authorMatch = data.match(/^rv:who:(\d+)(?::(\d+))?$/);
  if (authorMatch) { await answerCallbackQuery(callback.id); await revealReviewAuthor(from, chatId, Number(authorMatch[1]), Number(authorMatch[2] || 0)); return; }
  if (data === 'gen:start') { await answerCallbackQuery(callback.id); await startGeneration(from, chatId); return; }
  if (data === 'orders:list') { await answerCallbackQuery(callback.id); await showIndividualOrders(from, chatId); return; }
  if (data === 'gen:cancel') {
    await answerCallbackQuery(callback.id); await clearSession(from.id);
    await showScreen(chatId, messageId, 'Генерация отменена.', { reply_markup: choiceKeyboard([[{ text: '🏷 Начать заново', callback_data: 'menu:stickers' }], MENU_ROW]) });
    return;
  }
  if (data === 'code:find') { await answerCallbackQuery(callback.id); await startClientSearch(from, chatId, messageId); return; }
  const codeQr = data.match(/^code:qr:(\d{1,12})$/);
  if (codeQr) { await answerCallbackQuery(callback.id); await handleClientCode(from, chatId, codeQr[1]); return; }
  if (data === 'code:enter') {
    await answerCallbackQuery(callback.id);
    const current = await getSession(from.id);
    // Из подтверждения генерации сохраняем черновик (после кода — сразу к подтверждению), из профиля начинаем с чистого.
    await askAccessCode(from, chatId, current?.state === 'confirm' && current.draft?.mode ? current.draft : {});
    return;
  }
  if (data === 'account:continue') { await answerCallbackQuery(callback.id); await showMainMenu(from, chatId); return; }
  const pageMatch = data.match(/^gen:page:([^:]+:\d+):(\d+)$/);
  if (pageMatch) { await answerCallbackQuery(callback.id); const result = await loadGenerationRequest(pageMatch[1], from.id); if (!result) return sendMessage(chatId, 'Результат больше недоступен.'); await sendPreview(chatId, pageMatch[1], result, Number(pageMatch[2])); return; }
  const session = await getSession(from.id);
  if (!session) {
    await answerCallbackQuery(callback.id, 'Сессия истекла');
    await showScreen(chatId, messageId, 'Сессия истекла — начните заново.', { reply_markup: choiceKeyboard([[{ text: '🏷 Стикеры и QR', callback_data: 'menu:stickers' }], MENU_ROW]) });
    return;
  }
  const draft = session.draft || {};
  // Кнопки мастера работают только в его текущем сообщении: старые экраны выше в чате не трогают черновик.
  if (data.startsWith('gen:') && draft.msgId && messageId !== draft.msgId) {
    await answerCallbackQuery(callback.id, 'Этот шаг устарел — используйте последнее сообщение');
    return;
  }
  if (data === 'gen:back') { await answerCallbackQuery(callback.id); await wizardBack(from, chatId, session, messageId); return; }
  // «🔄 Я пополнил» — перечитать баланс и коды и показать подтверждение заново.
  if (data === 'gen:recheck' && session.state === 'confirm') { await answerCallbackQuery(callback.id); await requestConfirmation(from, chatId, draft, messageId); return; }
  if (data.startsWith('gen:kind:') && session.state === 'choose_kind') {
    await answerCallbackQuery(callback.id);
    draft.category = data.endsWith(':box') ? 'box' : 'product';
    await renderWizard(from, chatId, 'choose_mode', draft, messageId);
    return;
  }
  if (data.startsWith('gen:mode:') && session.state === 'choose_mode') {
    await answerCallbackQuery(callback.id);
    draft.mode = data.endsWith(':custom') ? 'custom' : 'range';
    if (draft.category === 'box') draft.prefix = 'TRBX';
    await renderWizard(from, chatId, draft.mode === 'range' ? 'await_quantity' : 'await_code', draft, messageId);
    return;
  }
  if (data.startsWith('gen:qty:') && session.state === 'await_quantity') {
    const quantity = Number(data.slice('gen:qty:'.length));
    // gen:qty:manual — кнопка «Ввести другое количество» из старых сообщений.
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) { await answerCallbackQuery(callback.id, 'Отправьте число от 1 до 500 сообщением'); return; }
    await answerCallbackQuery(callback.id);
    draft.quantity = quantity; await requestConfirmation(from, chatId, draft, messageId); return;
  }
  if (data === 'gen:confirm' && session.state === 'confirm') { await answerCallbackQuery(callback.id); await confirmGeneration(callback, session); return; }
  await answerCallbackQuery(callback.id, 'Кнопка больше неактуальна');
}

async function handleMessage(message) {
  const from = message.from, chatId = message.chat.id, text = String(message.text || '').trim();
  if (message.chat.type !== 'private') return sendMessage(chatId, 'Используйте личный чат с ботом.');
  await touchSubscriber(from, chatId);
  const startMatch = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]+))?$/i.exec(text);
  if (startMatch) {
    await clearSession(from.id);
    // t.me/<бот>?start=r_<КОД> — переход по приглашению.
    const referral = REFERRAL_PAYLOAD.exec(startMatch[1] || '');
    const invited = referral ? await captureReferral(from, referral[1]).catch(() => false) : false;
    const intro = [
      '<b>👋 Бот shk-wb.ru для ПВЗ Wildberries</b>',
      'Стикеры и QR, код клиента, отзывы, печать ячеек.',
      ...(invited ? ['', 'Вас пригласил коллега — нажмите «🔐 Войти в кабинет» в меню.'] : []),
    ].join('\n');
    // Первое сообщение заменяет старую большую клавиатуру на короткую, второе — само меню.
    await sendMessage(chatId, intro, { reply_markup: HOME_KEYBOARD });
    return showMainMenu(from, chatId);
  }
  if (/^\/help(?:@\w+)?$/i.test(text) || text === '🆘 Помощь') return showHelp(chatId);
  if (/^\/menu(?:@\w+)?$/i.test(text) || text === '☰ Меню' || text === '🌐 Открыть сайт') return showMainMenu(from, chatId);
  if (/^\/cancel(?:@\w+)?$/i.test(text)) { await clearSession(from.id); const wb = await getWbConnection(from.id); if (wb && wb.state !== 'ready') await saveWbConnection(from, chatId, 'idle', wb.session); await sendMessage(chatId, 'Текущее действие отменено.', { reply_markup: HOME_KEYBOARD }); return; }
  if (/^\/(generate|stickers)(?:@\w+)?$/i.test(text)) return startGeneration(from, chatId);
  if (/^\/code(?:@\w+)?$/i.test(text)) return showClientCode(chatId);
  if (/^\/profile(?:@\w+)?$/i.test(text)) return showProfile(from, chatId);
  if (/^\/invite(?:@\w+)?$/i.test(text)) return showReferrals(from, chatId);
  if (/^\/reviews(?:@\w+)?$/i.test(text)) return showReviewFilters(from, chatId);
  if (/^\/account(?:@\w+)?$/i.test(text)) return showProfile(from, chatId);
  if (/^\/orders(?:@\w+)?$/i.test(text) || text === '📦 Мои индивидуальные заказы') return showIndividualOrders(from, chatId);
  // «Код <SID>» → QR клиента (списывает 50 ₽). Голое «код …» без цифр — показываем инструкцию.
  const codeMatch = /^\s*код\s+(\d{1,12})\s*$/iu.exec(text);
  if (codeMatch) return handleClientCode(from, chatId, codeMatch[1]);
  if (/^\s*код\b/iu.test(text)) return showClientCode(chatId);
  // Старые кнопки большой клавиатуры ещё висят у людей — принимаем их.
  if (text === '➕ Создать ШК' || text === '🏷 Стикеры и QR') return startGeneration(from, chatId);
  if (text === '🏷 Стикеры для товаров') return startForCategory(from, chatId, 'product');
  if (text === '📦 QR для коробок') return startForCategory(from, chatId, 'box');
  if (text === '💳 Остаток' || text === '👤 Аккаунт') return showProfile(from, chatId);
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
  if (!session) return showMainMenu(from, chatId);
  const draft = session.draft || {};
  if (session.state === 'await_access_code') return redeemAccessCode(from, chatId, session, text);
  if (session.state === 'await_topup_amount') return acceptTopupAmount(from, chatId, session, message, text);
  if (session.state === 'await_client_query') return runClientSearch(from, chatId, text);
  // Ввод в мастер: сообщение пользователя убираем, ответ — в том же экране мастера (ошибка — строкой сверху).
  if (session.state === 'await_quantity') {
    await deleteMessage(chatId, message.message_id).catch(() => {});
    const quantity = Number(text);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) { draft.error = `«${escapeHtml(text.slice(0, 20))}» — нужно целое число от 1 до 500.`; return renderWizard(from, chatId, 'await_quantity', draft); }
    draft.quantity = quantity; return requestConfirmation(from, chatId, draft);
  }
  if (session.state === 'await_code') {
    await deleteMessage(chatId, message.message_id).catch(() => {});
    const length = draft.category === 'box' ? 10 : 11;
    if (!new RegExp(`^\\d{${length}}$`).test(text)) { draft.error = `«${escapeHtml(text.slice(0, 20))}» — номер должен содержать ровно ${length} цифр.`; return renderWizard(from, chatId, 'await_code', draft); }
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
    console.error('Telegram generator bot failed', error.message, error.details ? JSON.stringify(error.details).slice(0, 500) : '');
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) await sendMessage(chatId, 'Произошла внутренняя ошибка. Попробуйте позже.', { reply_markup: HOME_KEYBOARD }).catch(() => {});
  }
  return res.status(200).json({ ok: true });
}

module.exports = { BOT_COMMANDS, HOME_KEYBOARD, afterWalletTopup, bindTelegramReferral, claimErrorText, findClientsByQuery, freeUntilText, mainMenuKeyboard, profileKeyboard, topupRows, escapeHtml, findPickupEvents, formatPhone, handleTelegramUpdate, maskWbPhone, notifyMiniAppAuthorized, publicUrl, reviewAuthorIds, reviewStars, reviewText, validWebhookSecret };
