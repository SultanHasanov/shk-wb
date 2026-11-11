const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { supabaseFetch } = require('./_supabase');
const { answerCallbackQuery, deleteMessage, downloadFile, editMessageText, sendDocument, sendMediaGroup, sendMessage, sendPhoto, telegramRequest } = require('./_telegram-api');
const shkVision = require('./_shk-vision');
const { customStickerLinks, generateStickers, getAccessStatus, selectAccessCode } = require('./_sticker-generation');
const { BATCH_QUANTITY, GENERATION_DISCOUNT_PRICES, GENERATION_PRICES, ensureMonthlyStickers, finalizeGeneration, generationPrices, refundGeneration, reserveGeneration } = require('./_generation-billing');
const { CELL_PRINT_PRICES, CLIENT_CODE_PRICE, CUSTOM_GENERATION_PACKAGES, LICENSE_PRICES, REVIEW_PRICE } = require('./_payments');
const { buildClientQr } = require('./_wb-code');
const approvals = require('./_code-approvals');
const account = require('./_app-account');
const { authUser, ensureTechnicalAccount, findIdentity, identityForUser, relinkIdentity, saveIdentity, telegramLabel } = require('./_telegram-identity');
const { PLAN_ORDER, PLANS, SALE_PLANS, TERMS, isSalePlan, orderSnapshot, planPrice } = require('./_app-plans');
const wallet = require('./_wallet');
const { notifyAdminNewUser, notifyAdminSpend, sendToAdmins } = require('./_admin-alerts');
const { appFreeMode, appFreeUntil } = require('./_app-free');
const { accountMergeSummary } = require('./_telegram-account');
const { NOTICE_PREFIX, keptRows, noticeMarkup } = require('./_bot-notice');
const topupScreen = require('./_topup-screen');
const userCache = require('./_telegram-user-cache');
const botHealth = require('./_bot-health');
const wbPvz = require('./_wb-pvz');
const { isAccessCode, normalizeAccessCode } = require('./_access-code');
const { newStickerSvg, stickerSvg } = require('./_stickers');
// Ограничения аккаунтов из админки (снимок в памяти, на узле бота обновляется раз в 60 с или по invalidateUserControls)
const controls = require('./_user-controls');

const SESSION_TTL_MS = 30 * 60 * 1000;
const CONFIRM_TTL_MS = 3 * 60 * 60 * 1000;
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
// Подписи старых постоянных (reply) клавиатур: семикнопочной (до 20.10.2026) и двухкнопочной (до 26.10.2026).
// Бот их больше не отправляет, но Telegram держит такую клавиатуру у человека, пока бот не пришлёт
// remove_keyboard — инлайн-меню её не заменяет. Текст с такой подписью приходит только с той клавиатуры
// (инлайн-кнопки — это callback), поэтому он же и сигнал снять её: см. dropLegacyKeyboard.
const LEGACY_BUTTONS = new Set([
  '☰ Меню', '🏷 Стикеры и QR', '🆘 Помощь', '🌐 Открыть сайт', '➕ Создать ШК',
  '🏷 Стикеры для товаров', '📦 QR для коробок', '💳 Остаток', '👤 Аккаунт', '⭐ Отзывы ПВЗ',
  '📦 Мои индивидуальные заказы',
]);

// Ссылки на программы показываем текстом, а не кнопкой: их копируют и открывают на ПК пункта.
const PROGRAM_URL = 'https://shk-wb.ru/program';
const CELL_PRINT_URL = 'https://shk-wb.ru/cell-print';
// Поддержка и проценты приглашений — общие с сообщениями сайта (оплаты, админка): server/_bot-texts.js.
const botTexts = require('./_bot-texts');
const { SUPPORT_URL, REFERRAL_PERCENT, REFERRAL_WITHDRAW_MIN_RUB } = botTexts;
// Скидка клуба — до текстов меню: строки о ней собираются из CLUB_DISCOUNT_PERCENT и CLUB_REF_MS при загрузке.
const { CLUB_DISCOUNT_PERCENT, CLUB_REF_MS, applyClubDiscount, clubDiscountInfo, clubPrice, markClubRef } = require('./_club');
const CHANNEL_URL = 'https://t.me/wbtools_ru';
const VPN_URL = 'https://t.me/wb_wpn_bot';

// Список «/» в Telegram — те же разделы и подписи, что в главном меню. Ставится при старте узла бота
// (syncBotCommands из selfhost/server.cjs) и локальным скриптом scripts/run-telegram-bot-local.cjs.
const BOT_COMMANDS = [
  { command: 'menu', description: 'Главное меню' },
  { command: 'stickers', description: 'Стикеры и QR коробок' },
  { command: 'code', description: 'Код клиента: QR по ID клиента' },
  { command: 'reviews', description: 'Отзывы ПВЗ' },
  { command: 'profile', description: 'Профиль и баланс' },
  { command: 'balance', description: 'Баланс и пополнение' },
  { command: 'invite', description: `Пригласить коллегу — ${REFERRAL_PERCENT}% с его оплат вам` },
  { command: 'help', description: 'Помощь и поддержка' },
  { command: 'cancel', description: 'Отменить текущее действие' },
];

/** Поставить список команд боту. Сбой Telegram не мешает запуску — вызывающий ловит ошибку и не ждёт. */
function syncBotCommands() {
  return telegramRequest('setMyCommands', { commands: BOT_COMMANDS });
}

function publicUrl(path) {
  const fallback = process.env.VERCEL_ENV === 'production' ? 'https://shk-wb.ru' : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://shk-wb.ru';
  const origin = String(process.env.PUBLIC_APP_URL || fallback).replace(/\/$/, '');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Повторы апдейтов (Telegram шлёт заново после таймаута, релей — после своего) отсекаем сначала памятью,
// потом базой: база остаётся защитой после рестарта процесса.
const SEEN_UPDATES_MAX = 2000;
const seenUpdates = new Set();

function rememberUpdate(updateId) {
  const key = Number(updateId);
  if (seenUpdates.has(key)) return false;
  if (seenUpdates.size >= SEEN_UPDATES_MAX) seenUpdates.delete(seenUpdates.values().next().value);
  seenUpdates.add(key);
  return true;
}

async function claimUpdate(updateId) {
  if (process.env.TELEGRAM_LOCAL_POLLING === '1') return true;
  if (!rememberUpdate(updateId)) return false;
  let rows;
  try {
    rows = await supabaseFetch('telegram_bot_updates?on_conflict=update_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify({ update_id: Number(updateId) }) });
  } catch (error) {
    // База не ответила — апдейт не наш, повтор от Telegram должен пройти заново.
    seenUpdates.delete(Number(updateId));
    throw error;
  }
  return Array.isArray(rows) && rows.length > 0;
}

async function findUser(telegramId) {
  const cached = userCache.cachedUser(telegramId);
  if (cached) return cached.userId;
  const rows = await supabaseFetch(`user_telegram_identities?telegram_user_id=eq.${encodeURIComponent(telegramId)}&select=user_id&limit=1`);
  return userCache.remember(telegramId, rows[0]?.user_id || null);
}

/**
 * Аккаунт для этого Telegram — создаётся сам при первом действии (технический аккаунт, как через Mini App).
 * Бот работает без входа на сайт; связать бота с аккаунтом сайта может только поддержка (server/_admin-link.js).
 */
async function ensureUser(from) {
  const known = await findUser(from.id);
  if (known) return known;
  const { userId, created } = await ensureTechnicalAccount(from);
  userCache.remember(from.id, userId);
  if (created) await bindTelegramReferral(from.id, userId).catch(error => console.warn('Telegram referral bind failed', error.message));
  return userId;
}

// Сессия мастера в памяти процесса: один процесс, все писатели — здесь же (afterWalletTopup тоже идёт
// через saveSession/clearSession). В базу пишем сквозь кеш, читаем из базы только при промахе.
const sessionCache = new Map();

function sessionExpired(session, now = Date.now()) {
  if (!session) return true;
  // Подтверждение покупки живёт дольше: человек уходит пополнять баланс, а после оплаты покупка проходит сама.
  const ttl = session.state === 'confirm' ? CONFIRM_TTL_MS : SESSION_TTL_MS;
  return now - new Date(session.updated_at).getTime() > ttl;
}

function cacheSession(telegramId, session) {
  if (sessionCache.size > 5000) sessionCache.clear();
  sessionCache.set(Number(telegramId), { session, cachedAt: Date.now() });
  return session;
}

async function getSession(telegramId) {
  const key = Number(telegramId);
  const cached = sessionCache.get(key);
  let session;
  if (cached) {
    session = cached.session;
  } else {
    const rows = await supabaseFetch(`telegram_generator_sessions?telegram_user_id=eq.${encodeURIComponent(telegramId)}&select=*&limit=1`);
    session = cacheSession(telegramId, rows[0] || null);
  }
  if (session && sessionExpired(session)) { await clearSession(telegramId); return null; }
  // Копия: обработчики правят draft на месте, а в кеш попадает только то, что дошло до saveSession.
  return session ? structuredClone(session) : null;
}

async function saveSession(from, chatId, state, draft = {}) {
  const row = { telegram_user_id: Number(from.id), chat_id: Number(chatId), user_id: draft.userId || null, state, draft, updated_at: new Date().toISOString() };
  const rows = await supabaseFetch('telegram_generator_sessions?on_conflict=telegram_user_id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  return cacheSession(from.id, rows[0] || row);
}

async function clearSession(telegramId) {
  cacheSession(telegramId, null);
  await supabaseFetch(`telegram_generator_sessions?telegram_user_id=eq.${encodeURIComponent(telegramId)}`, { method: 'DELETE' });
}

// Подключение WB читается на каждую кнопку меню (отмена незаконченного входа) — минуту держим в памяти.
// Писатели (saveWbConnection, deleteWbConnection) живут здесь же и сбрасывают запись.
const WB_CONNECTION_CACHE_MS = 60 * 1000;
const wbConnectionCache = new Map();
// Незаконченный вход (ждём телефон или код) живёт 15 минут. Потом цифры в чате — снова обычный ввод (ШК, ID
// клиента), а не «телефон» для WB: иначе ШК из 11 цифр на 7… ушёл бы в WB как номер. Запись в базе не трогаем —
// читаем её как отменённую (готовый вход и выбор пункта срока не имеют).
const WB_LOGIN_TTL_MS = 15 * 60 * 1000;

function expirePendingLogin(row, now = Date.now()) {
  if (!row || (row.state !== 'await_phone' && row.state !== 'await_code')) return row;
  const updated = Date.parse(row.updated_at || '');
  return Number.isFinite(updated) && now - updated > WB_LOGIN_TTL_MS ? { ...row, state: 'idle' } : row;
}

async function getWbConnection(telegramId) {
  if (process.env.WB_CONNECTION_STORE === 'memory' || process.env.WB_CONNECTION_STORE === 'file') {
    loadLocalConnections();
    const row = localWbConnections.get(Number(telegramId));
    return row ? expirePendingLogin({ ...row, session: wbPvz.decryptSession(row.encrypted_session) }) : null;
  }
  const key = Number(telegramId);
  const cached = wbConnectionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.row ? expirePendingLogin(structuredClone(cached.row)) : null;
  const rows = await supabaseFetch(`telegram_wb_connections?telegram_user_id=eq.${encodeURIComponent(telegramId)}&select=*&limit=1`);
  const row = rows[0] || null;
  if (row) {
    try { row.session = wbPvz.decryptSession(row.encrypted_session); }
    catch { row.session = null; }
  }
  if (wbConnectionCache.size > 5000) wbConnectionCache.clear();
  wbConnectionCache.set(key, { row, expiresAt: Date.now() + WB_CONNECTION_CACHE_MS });
  return row ? expirePendingLogin(structuredClone(row)) : null;
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
  wbConnectionCache.delete(Number(from.id));
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
  wbConnectionCache.delete(Number(from.id));
  return rows[0];
}

async function deleteWbConnection(telegramId) {
  if (process.env.WB_CONNECTION_STORE === 'memory' || process.env.WB_CONNECTION_STORE === 'file') {
    loadLocalConnections();
    localWbConnections.delete(Number(telegramId));
    persistLocalConnections();
    return;
  }
  wbConnectionCache.delete(Number(telegramId));
  await supabaseFetch(`telegram_wb_connections?telegram_user_id=eq.${encodeURIComponent(telegramId)}`, { method: 'DELETE' });
  wbConnectionCache.delete(Number(telegramId));
}

// Новый подписчик: activated_at ставит база при первой вставке (в теле upsert его нет, поэтому он не
// перезаписывается). Свежий activated_at — значит, человек пишет боту впервые. Окно с запасом на разницу
// часов; повтор в пределах окна (второе сообщение того же новичка) отсекает память процесса.
const NEW_SUBSCRIBER_WINDOW_MS = 2 * 60 * 1000;
const announcedSubscribers = new Set();

function isFreshSubscriber(row, telegramId, now = Date.now()) {
  const activated = Date.parse(row?.activated_at || '');
  if (!Number.isFinite(activated) || Math.abs(now - activated) > NEW_SUBSCRIBER_WINDOW_MS) return false;
  const key = Number(telegramId);
  if (announcedSubscribers.has(key)) return false;
  if (announcedSubscribers.size > 5000) announcedSubscribers.clear();
  announcedSubscribers.add(key);
  return true;
}

/** Откуда пришёл новичок — по первому сообщению. Текст самого сообщения в уведомление не попадает. */
function newUserSource(text) {
  const payload = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]+)$/i.exec(String(text || '').trim())?.[1] || '';
  const referral = REFERRAL_PAYLOAD.exec(payload);
  if (referral) return { source: `по приглашению (код ${referral[1].toUpperCase()})`, referralCode: referral[1].toUpperCase() };
  if (/^club_/.test(payload)) return { source: 'из «Клуба вопросов»' };
  // Одноразовые токены привязки и входа в уведомление админу не отдаём: по ним можно войти чужим профилем.
  if (/^link_/i.test(payload)) return { source: 'по ссылке привязки из программы (link_…)' };
  if (/^login_/i.test(payload)) return { source: 'по ссылке входа в программу (login_…)' };
  if (payload) return { source: `по ссылке со start=${payload}` };
  if (/^\/start\b/i.test(String(text || '').trim())) return { source: 'сам, через /start' };
  return { source: text ? 'сразу написал сообщение' : 'нажал кнопку или прислал фото' };
}

async function notifyNewBotUser(from, text) {
  const { source, referralCode } = newUserSource(text);
  let inviterUserId = null;
  if (referralCode) {
    const [owners, aliases] = await Promise.all([
      supabaseFetch(`referral_accounts?referral_code=eq.${encodeURIComponent(referralCode)}&select=user_id&limit=1`).catch(() => []),
      supabaseFetch(`referral_code_aliases?referral_code=eq.${encodeURIComponent(referralCode)}&select=user_id&limit=1`).catch(() => []),
    ]);
    inviterUserId = owners[0]?.user_id || aliases[0]?.user_id || null;
  }
  await notifyAdminNewUser({ from, source, inviterUserId });
}

/**
 * Сессия генератора исчезает, а эта запись остаётся для статистики и рассылок.
 * text — первое сообщение (для уведомления админу о новичке: откуда пришёл). Возвращает true для новичка.
 */
async function touchSubscriber(from, chatId, text = '') {
  if (process.env.TELEGRAM_LOCAL_POLLING === '1') return false;
  if (!from?.id || !chatId) return false;
  const rows = await supabaseFetch('telegram_bot_subscribers?on_conflict=telegram_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
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
  if (!isFreshSubscriber(Array.isArray(rows) ? rows[0] : null, from.id)) return false;
  // Не задерживаем ответ человеку: уведомление уходит фоном, его ошибка боту не мешает.
  notifyNewBotUser(from, text).catch(error => console.warn('Уведомление о новом пользователе', error?.message || error));
  return true;
}

function choiceKeyboard(rows) { return { inline_keyboard: rows }; }

const MENU_ROW = [{ text: '☰ Меню', callback_data: 'menu:home' }];
// Под короткими ответами — кнопка меню (постоянную нижнюю клавиатуру больше не показываем).
const MENU_KEYBOARD = { inline_keyboard: [MENU_ROW] };
// Во время входа в WB (ждём телефон или код) — выйти из него можно кнопкой, а не только /cancel.
const WB_LOGIN_KEYBOARD = { inline_keyboard: [[{ text: '✖️ Отменить вход', callback_data: 'rv:cancel' }, ...MENU_ROW]] };
// Шаг кода: новый код на тот же номер (rv:resend), другой номер (rv:phone), отмена.
const WB_CODE_KEYBOARD = { inline_keyboard: [
  [{ text: '🔁 Выслать код заново', callback_data: 'rv:resend' }, { text: '📱 Другой номер', callback_data: 'rv:phone' }],
  [{ text: '✖️ Отменить вход', callback_data: 'rv:cancel' }, ...MENU_ROW],
] };

function mainMenuKeyboard() {
  // По две кнопки в ряд с короткими подписями — меню не растягивается.
  return choiceKeyboard([
    [{ text: '🏷 Стикеры и QR коробок', callback_data: 'menu:stickers' }],
    [{ text: '🔑 Код клиента', callback_data: 'menu:code' }, { text: '⭐ Отзывы ПВЗ', callback_data: 'menu:reviews' }],
    [{ text: '💻 Помощник ПВЗ', callback_data: 'menu:helper' }, { text: '🖨 ПВЗ Принт', callback_data: 'menu:cellprint' }],
    // Аккаунт создаётся сам при первом действии — кнопки «Войти» нет. Сайта в меню тоже нет: бот работает
    // сам по себе, связку с аккаунтом сайта делает поддержка. «Помощь» — справка и поддержка, там же канал и VPN.
    [{ text: '👤 Профиль и баланс', callback_data: 'menu:profile' }, { text: '🆘 Помощь', callback_data: 'menu:help' }],
    [{ text: '👥 Пригласить коллегу', callback_data: 'menu:ref' }],
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

function greetingTitle(from) {
  const name = String(from?.first_name || '').trim();
  return `<b>👋 Здравствуйте${name ? `, ${escapeHtml(name)}` : ''}!</b>`;
}

// Переход по ссылке-приглашению (captureReferral): что сказать в приветствии.
const REFERRAL_LINES = {
  new: 'Вы пришли по приглашению коллеги — добро пожаловать!',
  already_captured: 'Вы пришли по приглашению коллеги — добро пожаловать!',
  existing: 'Приглашение засчитывается только новым пользователям, а вы уже пользовались ботом.',
  unknown: 'Ссылку-приглашение не узнал, но бот работает как обычно.',
};

/** Строка о скидке клуба для приветствия и меню: на что она и до какого числа. */
function clubMenuLine(until) {
  return `🎁 Вам как участнику клуба — скидка ${CLUB_DISCOUNT_PERCENT}% на «Код клиента» и «Кто поставил оценку»${until ? ` до ${dayMonthShort(until)}` : ''}, пока активна подписка на клуб.`;
}

/** Короткая строка о действующей скидке на экранах с ценой: «🎁 Скидка участника клуба 20% — до 12.12.» */
function clubLine(until) {
  return `🎁 Скидка участника клуба ${CLUB_DISCOUNT_PERCENT}%${until ? ` — до ${dayMonthShort(until)}` : ''}.`;
}

const CLUB_REF_DAYS = Math.round(CLUB_REF_MS / (24 * 60 * 60 * 1000));
const CLUB_EXPIRED_LINE = `Скидка клуба закончилась. Чтобы включить её снова на ${CLUB_REF_DAYS} дней, откройте бота по кнопке из группы клуба.`;
const CLUB_INACTIVE_LINE = `Скидка ${CLUB_DISCOUNT_PERCENT}% для участников клуба действует при активной подписке на клуб.`;
const CLUB_LAPSED_LINE = `Скидка клуба закончилась. Чтобы включить её снова на ${CLUB_REF_DAYS} дней, продлите подписку на клуб и откройте бота по кнопке из группы клуба.`;
const CLUB_ERROR_LINE = 'Не получилось проверить подписку на клуб — скидку покажу, когда проверка пройдёт.';

/** Скидка клуба этого человека (server/_club.js: clubDiscountInfo); сбой — reason 'error'. */
function clubInfo(telegramId) {
  return clubDiscountInfo(telegramId).catch(() => ({ active: false, until: null, reason: 'error' }));
}

/**
 * Что сказать о скидке клуба: действует — на что и до какого числа (menu — длинная строка для приветствия);
 * закончилась или подписка неактивна — как вернуть (lapsed — оба условия сразу). Сбой проверки — не «подписка неактивна»: говорим о нём
 * только сразу после перехода из группы (fromClub), иначе молчим. Не из клуба (no_ref, off) — ничего.
 */
function clubStatusLines(club, { fromClub = false, menu = false } = {}) {
  if (club?.reason === 'active') return [menu ? clubMenuLine(club.until) : clubLine(club.until)];
  if (club?.reason === 'expired') return [CLUB_EXPIRED_LINE];
  if (club?.reason === 'inactive') return [CLUB_INACTIVE_LINE];
  if (club?.reason === 'lapsed') return [CLUB_LAPSED_LINE];
  if (club?.reason === 'error' && fromClub) return [CLUB_ERROR_LINE];
  return [];
}

/** Приветствие после /start: для кого бот, что умеет и сколько стоит. Цены — из констант, со скидкой клуба. */
async function greetingLines(from, { fromClub = false } = {}) {
  const club = await clubInfo(from?.id);
  const withClub = price => (club.active ? applyClubDiscount(price) : price);
  const custom = wallet.formatRub(GENERATION_PRICES.custom / 100), batch = wallet.formatRub(GENERATION_PRICES.batch / 100);
  return [
    greetingTitle(from),
    ...clubStatusLines(club, { fromClub, menu: true }),
    'Я бот для сотрудников ПВЗ Wildberries. Что умею:',
    '',
    `🏷 Стикер с ШК товара (номер из 11 цифр) — ${custom}, пачка из ${BATCH_QUANTITY} новых — ${batch}. Можно просто прислать сюда фото или скриншот с номером.`,
    `📦 QR возвратной коробки — по тем же ценам.`,
    `🔑 QR-код клиента по его ID — ${wallet.formatRub(withClub(CLIENT_CODE_PRICE))} или 1 код из тарифа «Помощника ПВЗ».`,
    `⭐ Отзывы вашего ПВЗ — смотреть бесплатно, узнать, кто поставил оценку, — ${wallet.formatRub(withClub(REVIEW_PRICE))}.`,
    '',
    `Оплата — с баланса бота, пополнение от ${wallet.formatRub(wallet.MIN_TOPUP)}.`,
    'Выберите, что нужно, кнопкой ниже.',
  ];
}

/**
 * greet — после /start: приветствие по имени вместо заголовка «Главное меню».
 * referral — исход перехода по приглашению (REFERRAL_LINES), notice — строка вместо заголовка (или под приветствием).
 */
async function showMainMenu(from, chatId, messageId, { greet = false, referral = '', notice = '', fromClub = false } = {}) {
  // Без ссылок в тексте: канал и VPN — кнопками на экране «Помощь».
  const lines = greet ? await greetingLines(from, { fromClub }) : [notice || '<b>Главное меню</b>'];
  if (greet && notice) lines.splice(1, 0, notice);
  if (REFERRAL_LINES[referral]) lines.push('', REFERRAL_LINES[referral]);
  await showScreen(chatId, messageId, lines.join('\n'), { reply_markup: mainMenuKeyboard() });
}

// Подписанная ссылка на «голый» QR кода клиента (отдаёт api/stickers/image в режиме qr) — общая с подтверждениями.
const { clientQrUrl } = approvals;

/** Открытые запросы QR с компьютеров владельца — блок сверху экрана «Код клиента» и кнопки по каждому. */
async function pendingApprovalRows(userId) {
  const pending = userId ? await approvals.pendingFor(userId) : [];
  if (!pending.length) return { lines: [], rows: [] };
  const ids = [...new Set(pending.map(r => r.device_id))].map(encodeURIComponent).join(',');
  const devices = await supabaseFetch(`app_devices?id=in.(${ids})&select=id,name`).catch(() => []);
  const nameOf = id => devices.find(d => d.id === id)?.name || 'ПК';
  const rows = pending.map(r => [
    { text: `✅ Выдать · ${nameOf(r.device_id)}${r.cell ? ` · яч. ${r.cell}` : ''}`.slice(0, 60), callback_data: `cq:ok:${r.id}` },
    { text: '❌ Отклонить', callback_data: `cq:no:${r.id}` },
  ]);
  // Раньше всех истекает самый старый запрос (pendingFor — по времени создания).
  const until = approvals.moscowTime(pending[0].expires_at);
  const deadline = pending.length > 1 ? `Первый истекает в ${until} (по Москве).` : `Ответьте до ${until} (по Москве).`;
  return { lines: [`⏳ <b>Ожидают решения: ${pending.length}</b> — запросы QR с ваших компьютеров. ${deadline}`, ''], rows };
}

/** Что спишется за следующий QR этого человека (server/_code-approvals.js: nextCodeCharge). */
function nextClientCharge(from, userId) {
  return approvals.nextCodeCharge(userId, from?.id, { telegramFree: clientCodeFreeFor(from?.id) });
}

const REPEAT_PAID_LINE = 'Каждое получение QR — отдельное списание, даже для того же клиента.';

/**
 * Экран «Код клиента». Главный путь — поиск по ячейке или телефону; ID можно прислать и сразу цифрами.
 * notice — строка сверху (например, «не понял номер» после «код» без цифр).
 */
async function showClientCode(chatId, messageId, from, { notice = '' } = {}) {
  const userId = from?.id ? await findUser(from.id).catch(() => null) : null;
  const [charge, pending] = await Promise.all([nextClientCharge(from, userId), pendingApprovalRows(userId)]);
  // О скидке — только когда платят деньгами; ответ проверки уже в кеше после nextClientCharge.
  const club = ['wallet', 'unknown'].includes(charge.kind) ? await clubInfo(from?.id) : null;
  const text = [
    ...(notice ? [notice, ''] : []),
    '<b>🔑 Код клиента</b>',
    ...pending.lines,
    'Пришлю QR клиента на сегодня — когда клиент не может сам показать свой QR из приложения WB.',
    'Найдите клиента по ячейке или телефону — или пришлите его ID цифрами, например <code>191607973</code>.',
    '',
    ...clubStatusLines(club),
    `<b>Что спишется:</b> ${approvals.chargeLine(charge)}`,
    ...(charge.kind === 'free' ? [] : [REPEAT_PAID_LINE]),
  ].join('\n');
  const short = charge.kind === 'wallet' && charge.balance != null && charge.balance < charge.price;
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    ...pending.rows,
    [{ text: '🔎 Найти клиента по ячейке или телефону', callback_data: 'code:find' }],
    ...(short ? [[{ text: '💰 Пополнить баланс', callback_data: 'topup:home' }]] : []),
    MENU_ROW,
  ]) });
}

// ── Подтверждение QR-кода клиента с компьютеров (server/_code-approvals.js) ──

/**
 * Экран «бесплатных кодов нет» у запроса с компьютера: выдать с баланса, пополнить и выдать, купить пакет или
 * отклонить. away — экран открыт не в сообщении самого запроса (с «Код клиента» или после покупки): «⬅️ Назад».
 */
async function showApprovalPaywall(chatId, messageId, row, price, balance, { away = false } = {}) {
  const base = await approvals.ownerMessage(row, chatId, { withCharge: false });
  const enough = balance >= price;
  const text = [
    base.text,
    '',
    'Бесплатных кодов не осталось.',
    enough
      ? `Выдать этот QR за <b>${wallet.formatRub(price)}</b> с баланса? На балансе ${wallet.formatRub(balance)}.`
      : `Выдать этот QR стоит <b>${wallet.formatRub(price)}</b>, на балансе ${wallet.formatRub(balance)} — не хватает ${wallet.formatRub(price - balance)}.`,
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    enough ? [{ text: `💳 Выдать за ${wallet.formatRub(price)} с баланса`, callback_data: `cq:wallet:${row.id}` }] : topupAndBuyRow(price - balance, `cqa:${row.id}`, { verb: 'выдать' }),
    [{ text: '🔑 Пакет кодов клиента', callback_data: 'shop:wbpk' }],
    [{ text: '❌ Отклонить', callback_data: `cq:no:${row.id}` }],
    ...(away ? [[{ text: '⬅️ Назад', callback_data: 'menu:code' }]] : []),
  ]) });
}

/**
 * Кнопки запроса с компьютера: cq:ok | cq:no | cq:wallet и cq:view («⬅️ Назад» с экрана оплаты — снова экран
 * выдачи, без списания). Нажали не в сообщении самого запроса (экран «Код клиента», «Готово» после покупки
 * пакета) — после решения перерисовываем этот экран: список ожидающих обновится.
 */
async function handleApprovalButton(from, chatId, messageId, callbackId, action, id) {
  const fromRequest = (row) => !row || !messageId || Number(row.telegram_message_id) === Number(messageId);
  const redraw = async (row) => { if (!fromRequest(row)) await showClientCode(chatId, messageId, from); };
  const closed = async (row) => {
    await answerCallbackQuery(callbackId, approvals.closedNotice(row), { alert: true });
    if (row) await approvals.updateOwnerMessage(row);
    await redraw(row);
  };
  if (action === 'view') {
    const row = await approvals.loadApproval(id);
    if (row && row.user_id !== await findUser(from.id)) return answerCallbackQuery(callbackId, 'Это не ваш запрос');
    if (!row || row.status !== 'pending') return closed(row);
    answerCallbackQuery(callbackId).catch(() => {});
    const away = !fromRequest(row);
    const charge = await approvals.nextCodeCharge(row.user_id, from.id);
    // unknown — права не прочитались: не пугаем «кодов не осталось», а показываем обычный запрос; если кодов
    // действительно нет, «Выдать» само откроет экран оплаты (approve → limit).
    if (charge.kind === 'wallet') {
      return showApprovalPaywall(chatId, messageId, row, charge.price, charge.balance ?? await walletRub(row.user_id), { away });
    }
    // Коды появились (купили пакет) — обычный экран запроса с «Выдать / Отклонить».
    const base = await approvals.ownerMessage(row, from.id);
    return showScreen(chatId, messageId, base.text, { reply_markup: choiceKeyboard([
      ...base.reply_markup.inline_keyboard,
      ...(away ? [[{ text: '⬅️ Назад', callback_data: 'menu:code' }]] : []),
    ]) });
  }
  if (action === 'no') {
    const r = await approvals.decline(id, { telegramUserId: from.id });
    if (r.outcome === 'not_owner') return answerCallbackQuery(callbackId, 'Это не ваш запрос');
    if (r.outcome !== 'declined') return closed(r.row);
    await answerCallbackQuery(callbackId, 'Отклонено. Ничего не списано.');
    return redraw(r.row);
  }
  const r = await approvals.approve(id, { telegramUserId: from.id, payWithWallet: action === 'wallet' });
  if (r.outcome === 'approved') {
    answerCallbackQuery(callbackId, 'Выдано — QR показан на компьютере').catch(() => {});
    await approvals.sendQrToOwner(r.row);
    return redraw(r.row);
  }
  if (r.outcome === 'not_owner') return answerCallbackQuery(callbackId, 'Это не ваш запрос');
  if (r.outcome === 'stale') return closed(r.row);
  // limit | wallet_short — кодов нет или на балансе не хватает: экран оплаты там, где нажали.
  answerCallbackQuery(callbackId).catch(() => {});
  await showApprovalPaywall(chatId, messageId || r.row.telegram_message_id, r.row, r.price, r.balance ?? await walletRub(r.row.user_id), { away: !fromRequest(r.row) });
}

/**
 * После пополнения «и выдать» (walletThen = cqa:<id>): выдать с баланса без повторного нажатия. Итог — одним
 * сообщением: уведомление «Баланс пополнен» (noticeId) становится итогом с кнопками; QR при выдаче — фото ниже.
 * screenId — экран оплаты: если это не сообщение запроса (его правит сам запрос), убираем с него ссылку на оплату.
 */
async function afterTopupApproval(from, chatId, id, { noticeId = null, screenId = null, head = '<b>Баланс пополнен ✅</b>' } = {}) {
  const r = await approvals.approve(id, { telegramUserId: from.id, payWithWallet: true });
  if (screenId && screenId !== noticeId && Number(r.row?.telegram_message_id) !== Number(screenId)) {
    await editMessageText(chatId, screenId, 'Баланс пополнен — итог ниже ⬇️').catch(() => {});
  }
  const keyboard = choiceKeyboard([[{ text: '🔑 Код клиента', callback_data: 'menu:code' }, ...MENU_ROW]]);
  let lines;
  if (r.outcome === 'approved') {
    const b = r.row.billing || {};
    const spent = b.via === 'wallet' && b.duplicate ? 'Ничего не списано — деньги на балансе.'
      : b.via === 'wallet' ? `Списано ${wallet.formatRub(Number(b.rub || 0))}${b.club ? CLUB_CHARGE_NOTE : ''} · на балансе ${wallet.formatRub(Number(b.balance || 0))}.`
      : b.via === 'reuse' ? 'Этого клиента сегодня уже выдавали — повтор без списания, деньги на балансе.'
      : 'Без списания с баланса.';
    // Нет уведомления «Баланс пополнен» — итог (сколько списано) пишем в подпись под фото.
    const photo = await approvals.sendQrToOwner(r.row, { replyMarkup: keyboard, extra: noticeId ? [] : [spent] });
    lines = [`✅ QR по запросу с компьютера выдан — он показан на компьютере${photo ? ', фото — ниже' : ''}.`, spent];
    // Кнопки — под фото (последним сообщением); не ушло фото — под итогом.
    const text = [head, ...lines].join('\n');
    if (noticeId) await showScreen(chatId, noticeId, text, photo ? {} : { reply_markup: keyboard });
    else if (!photo) await sendMessage(chatId, text, { reply_markup: keyboard });
    return true;
  }
  lines = [r.outcome === 'wallet_short'
    ? 'QR не выдан: на балансе всё ещё не хватает. Откройте запрос в «Код клиента».'
    : 'QR не выдан: запрос с компьютера уже закрыт. Деньги остались на балансе — платить второй раз не нужно.'];
  const text = [head, ...lines].join('\n');
  if (noticeId) await showScreen(chatId, noticeId, text, { reply_markup: keyboard });
  else await sendMessage(chatId, text, { reply_markup: keyboard });
  return true;
}

// ── Привязка Telegram к аккаунту по ссылке из программы: /start link_<token> (POST /api/app/telegram-link) ──

const LINK_PAYLOAD = /^link_([A-Za-z0-9_-]{24})$/;

async function loadLinkToken(token) {
  const rows = await supabaseFetch(`app_telegram_link_tokens?token=eq.${encodeURIComponent(token)}&select=token,user_id,expires_at,used_at&limit=1`);
  const row = rows[0];
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return null;
  return row;
}

// Профиль бота, который можно отдать программе без поддержки: технический (создан ботом) и пустой по сводке
// базы — кошелёк, подписки, ПК, покупки, отзывы… (account_merge_summary). Нет сводки (миграция не применена)
// или сбой — «не знаем»: удалять аккаунт с непроверенными данными нельзя, такой случай идёт в поддержку.
// → 'empty' | 'data' (технический с данными) | 'site' (аккаунт с почтой) | 'other' (ограничен, не проверить)
async function linkSourceState(userId) {
  let summary = null;
  try {
    summary = await accountMergeSummary(userId);
  } catch (error) {
    console.warn('Link from app: account summary failed', error.message);
  }
  if (!summary || typeof summary.empty !== 'boolean') return 'other';
  if (!summary.technical) return 'site';
  if (summary.restricted) return 'other';
  return summary.empty ? 'empty' : 'data';
}

const LINK_SUPPORT_TEXT = {
  data: 'У этого Telegram уже есть профиль с балансом или покупками. Напишите в поддержку — объединим, ничего не потеряется.',
  site: 'Этот Telegram уже привязан к другому аккаунту. Напишите в поддержку — разберёмся и свяжем.',
  other: 'Подключить этот Telegram автоматически не получилось. Напишите в поддержку — свяжем вручную.',
};

function sendLinkSupport(chatId, from, state) {
  return sendMessage(chatId, [
    LINK_SUPPORT_TEXT[state] || LINK_SUPPORT_TEXT.other,
    `Ваш ID: <code>${Number(from.id)}</code> — назовите его поддержке.`,
  ].join('\n'), { reply_markup: choiceKeyboard([[{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }], MENU_ROW]) });
}

// Отказы перепривязки, которые решает только поддержка (supabase/migrations/20261120_account_merge_full.sql).
const LINK_REFUSAL = /TELEGRAM_ACCOUNT_NOT_EMPTY|TELEGRAM_ACCOUNT_FINANCIAL_CONFLICT|SOURCE_ACCOUNT_NOT_TECHNICAL|TARGET_ACCOUNT_|MERGE_/;

// Вернуть снятую связку прежнего Telegram. Обычная вставка без слияния: если RPC на самом деле прошёл
// (оборвался только ответ), у аккаунта уже новая связка — первичный ключ user_id не даст её затереть.
async function restorePreviousIdentity(row) {
  try {
    await supabaseFetch('user_telegram_identities', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  } catch (error) {
    console.warn('Link from app: previous Telegram not restored', error.message);
  }
  userCache.forgetSiteUser(row.user_id);
  userCache.forgetTelegramUser(row.telegram_user_id);
}

async function completeLink(from, chatId, tokenRow) {
  const existing = await findIdentity(from.id);
  if (existing && existing.user_id !== tokenRow.user_id) {
    // У Telegram свой профиль бота. Пустой — перепривязка через RPC: связка переходит к аккаунту программы,
    // пустой аккаунт удаляется (голый saveIdentity оставил бы аккаунт-сироту). Проверяем заново: между
    // вопросом «переключить?» и ответом на профиль могли прийти деньги.
    const state = await linkSourceState(existing.user_id);
    if (state !== 'empty') return sendLinkSupport(chatId, from, state);
    // RPC требует у аккаунта программы подтверждённую почту — проверяем до того, как снимать его прежний Telegram.
    const target = await authUser(tokenRow.user_id);
    if (!target?.email_confirmed_at || /@users[.]invalid$/i.test(String(target.email || ''))) return sendLinkSupport(chatId, from, 'other');
    // RPC откажет, если у цели уже есть другой Telegram, поэтому прежний снимаем заранее — но запоминаем,
    // чтобы вернуть при отказе или сбое: иначе аккаунт программы останется вовсе без Telegram.
    const previousFilter = `user_telegram_identities?user_id=eq.${encodeURIComponent(tokenRow.user_id)}&telegram_user_id=neq.${encodeURIComponent(from.id)}`;
    const previous = (await supabaseFetch(`${previousFilter}&select=*&limit=1`))?.[0] || null;
    await supabaseFetch(previousFilter, { method: 'DELETE' });
    userCache.forgetSiteUser(tokenRow.user_id);
    try {
      await relinkIdentity(tokenRow.user_id, from);
    } catch (error) {
      if (previous) await restorePreviousIdentity(previous);
      if (!LINK_REFUSAL.test(String(error?.message || ''))) throw error;
      console.warn('Link from app refused', error.message);
      return sendLinkSupport(chatId, from, 'other');
    }
  } else {
    await saveIdentity(tokenRow.user_id, from, { replace: true });
  }
  // В черновике сессии лежит прежний userId — начинаем с чистой.
  await clearSession(from.id).catch(error => console.warn('Link from app: clear session failed', error.message));
  await supabaseFetch(`app_telegram_link_tokens?token=eq.${encodeURIComponent(tokenRow.token)}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) }).catch(() => {});
  await bindTelegramReferral(from.id, tokenRow.user_id).catch(() => {});
  await sendMessage(chatId, [
    '<b>✅ Telegram подключён к аккаунту «Помощника ПВЗ»</b>',
    'Теперь запросы QR-кода клиента с ваших компьютеров будут приходить сюда — вы решаете, выдать или отклонить.',
    'Баланс и покупки в боте и в программе теперь общие.',
  ].join('\n'));
  return showMainMenu(from, chatId);
}

async function handleLinkStart(from, chatId, token) {
  const tokenRow = await loadLinkToken(token);
  if (!tokenRow) return sendMessage(chatId, 'Ссылка устарела — получите новую в программе: Профиль → «Подключить Telegram».', { reply_markup: choiceKeyboard([MENU_ROW]) });
  const existing = await findIdentity(from.id);
  if (existing && existing.user_id !== tokenRow.user_id) {
    const state = await linkSourceState(existing.user_id);
    if (state !== 'empty') return sendLinkSupport(chatId, from, state);
  }
  const current = await identityForUser(tokenRow.user_id);
  if (current && Number(current.telegram_user_id) !== Number(from.id)) {
    return sendMessage(chatId, [
      `К аккаунту программы уже подключён Telegram ${escapeHtml(telegramLabel(current))}. Переключить на этот?`,
      '',
      'Прежний Telegram перестанет видеть баланс и покупки этого аккаунта и получать запросы QR.',
    ].join('\n'), {
      reply_markup: choiceKeyboard([[{ text: '✅ Да, переключить', callback_data: `cq:link:yes:${token}` }, { text: 'Нет', callback_data: `cq:link:no:${token}` }]]),
    });
  }
  return completeLink(from, chatId, tokenRow);
}

async function handleLinkConfirm(from, chatId, messageId, callbackId, answer, token) {
  answerCallbackQuery(callbackId).catch(() => {});
  if (answer === 'no') return showScreen(chatId, messageId, 'Привязка отменена.', { reply_markup: choiceKeyboard([MENU_ROW]) });
  const tokenRow = await loadLinkToken(token);
  if (!tokenRow) return showScreen(chatId, messageId, 'Ссылка устарела — получите новую в программе.', { reply_markup: choiceKeyboard([MENU_ROW]) });
  await deleteMessage(chatId, messageId).catch(() => {});
  return completeLink(from, chatId, tokenRow);
}

// ── Вход в «Помощник ПВЗ» и «ПВЗ Принт» подтверждением в боте: /start login_<КОД> ──
// Программа получает код (login-start, 8 символов, живёт 10 минут) и открывает страницу /app-login, где есть
// кнопка и QR со ссылкой сюда. Подтверждение — только кнопкой: чужая ссылка не должна входить сама.
// Дальше всё как при подтверждении на сайте: программа забирает сессию через login-poll.

const LOGIN_PAYLOAD = /^login_([A-Za-z0-9]{8})$/;
const LOGIN_ATTEMPTS_PER_HOUR = 10;
const LOGIN_STALE_TEXT = 'Код входа устарел. Начните вход в программе ещё раз.';
const LOGIN_USED_TEXT = 'Этот код входа уже использован. Если вы не входили в программу — напишите в поддержку.';

function loginCodeLabel(code) { return `${code.slice(0, 4)}-${code.slice(4)}`; }

function supportKeyboard() {
  return choiceKeyboard([[{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }], MENU_ROW]);
}

// Запрос входа или null, если кода нет или он просрочен (остальные сбои — наверх, в общий ответ о сбое).
async function loadLoginRequest(code) {
  if (!code) return null;
  try {
    return await account.loginRequest(code);
  } catch (error) {
    if (error.code === 'NOT_FOUND' || error.code === 'EXPIRED') return null;
    throw error;
  }
}

function minutesAgoText(iso) {
  const minutes = Math.floor((Date.now() - Date.parse(iso || '')) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'только что';
  return `${minutes} мин назад`;
}

function loginRestrictedText(program, restriction) {
  return `Вход в «${program.name}» для вашего профиля закрыт. ${escapeHtml(restriction.message)}`;
}

async function handleLoginStart(from, chatId, rawCode) {
  if (!await consumeHourlyAttempt('bot-app-login', `bot-login:${from.id}`, LOGIN_ATTEMPTS_PER_HOUR)) {
    return sendMessage(chatId, 'Слишком много попыток входа. Попробуйте через час.', { reply_markup: MENU_KEYBOARD });
  }
  const code = account.normalizeLoginCode(rawCode);
  const row = await loadLoginRequest(code);
  if (!row) return sendMessage(chatId, LOGIN_STALE_TEXT, { reply_markup: MENU_KEYBOARD });
  if (row.status !== 'pending') return sendMessage(chatId, LOGIN_USED_TEXT, { reply_markup: supportKeyboard() });
  const userId = await ensureUser(from);
  const program = account.loginProgram(row);
  const restriction = await account.loginRestriction(userId, row);
  if (restriction) return sendMessage(chatId, loginRestrictedText(program, restriction), { reply_markup: supportKeyboard() });
  const losing = program.scope === 'cell_print' ? 'ваш профиль, баланс и ключи' : 'ваш профиль, баланс и данные пункта';
  return sendMessage(chatId, [
    `🖥 <b>Вход в «${program.name}»</b>`,
    `Компьютер: «${escapeHtml(row.device_name || 'Компьютер')}» · запрошен ${minutesAgoText(row.created_at)}`,
    `Код входа: <code>${loginCodeLabel(code)}</code>`,
    '',
    `Подтверждайте, только если вы сами сейчас нажали «Войти» в программе. Ссылку прислал кто-то другой — нажмите «Нет»: иначе чужой компьютер получит ${losing}.`,
  ].join('\n'), {
    reply_markup: choiceKeyboard([[{ text: '✅ Да, войти', callback_data: `lg:ok:${code}` }, { text: '✖️ Нет', callback_data: `lg:no:${code}` }]]),
  });
}

async function handleLoginConfirm(from, chatId, messageId, callbackId, answer, code) {
  answerCallbackQuery(callbackId).catch(() => {});
  if (answer === 'no') {
    return showScreen(chatId, messageId, 'Вход отменён — компьютер не получил доступ. Если ссылку прислал кто-то другой, не пересылайте её никому.', { reply_markup: MENU_KEYBOARD });
  }
  const userId = await ensureUser(from);
  try {
    await account.approveLoginChecked(userId, code);
  } catch (error) {
    if (error.code === 'NOT_FOUND' || error.code === 'EXPIRED') return showScreen(chatId, messageId, LOGIN_STALE_TEXT, { reply_markup: MENU_KEYBOARD });
    if (error.code === 'ALREADY_USED') return showScreen(chatId, messageId, LOGIN_USED_TEXT, { reply_markup: supportKeyboard() });
    if (error.code === 'ACCOUNT_RESTRICTED') {
      const row = await loadLoginRequest(code).catch(() => null);
      return showScreen(chatId, messageId, loginRestrictedText(account.loginProgram(row), { message: error.message }), { reply_markup: supportKeyboard() });
    }
    throw error;
  }
  return showScreen(chatId, messageId, '✅ Вход подтверждён. Вернитесь в программу — она войдёт сама.', { reply_markup: MENU_KEYBOARD });
}

// «🚫 Это не я» под сообщением о новом компьютере (account.notifyNewDevice): отключить ПК и завершить все
// сеансы. Компьютер ищем только среди ПК профиля этого Telegram — чужой id из подделанной кнопки не сработает.
async function handleDeviceNotMe(from, chatId, messageId, callbackId, deviceId) {
  answerCallbackQuery(callbackId).catch(() => {});
  const userId = await findUser(from.id);
  const rows = userId
    ? await supabaseFetch(`app_devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,name,revoked_at&limit=1`)
    : [];
  const device = rows[0];
  if (!device) return showScreen(chatId, messageId, 'Этого компьютера нет в вашем профиле.', { reply_markup: supportKeyboard() });
  const name = escapeHtml(device.name || 'Компьютер');
  if (!device.revoked_at) {
    try {
      await account.revokeDevice(userId, deviceId);
    } catch (error) {
      if (error.code !== 'NOT_FOUND') throw error; // уже отключили с другого экрана
    }
  }
  const sessions = await account.endAllSessions(userId).catch(error => {
    console.warn('Device not me: end sessions failed', error?.message || error);
    return null;
  });
  const lines = [`🚫 <b>Компьютер «${name}» отключён</b>`];
  if (sessions) {
    lines.push('Все входы в ваш профиль завершены. На своих компьютерах войдите заново — подтверждением здесь, в боте.');
    lines.push('Не понимаете, откуда был вход, — напишите в поддержку.');
  } else {
    lines.push('Завершить остальные входы не получилось — напишите в поддержку, поможем.');
  }
  return showScreen(chatId, messageId, lines.join('\n'), { reply_markup: supportKeyboard() });
}

/** Не хватает денег на QR — пополнить ровно на недостающее и выдать QR (afterWalletTopup → qr:<sid>). */
async function showClientCodePaywall(from, chatId, sid, balance, price) {
  const text = [
    `<b>🔑 QR клиента ${escapeHtml(sid)} — ${wallet.formatRub(price)}</b>`,
    `💰 На балансе: <b>${wallet.formatRub(balance)}</b> — не хватает ${wallet.formatRub(Math.max(0, price - balance))}.`,
    'Пополните баланс — QR придёт сам, ничего нажимать не нужно.',
  ].join('\n');
  await sendMessage(chatId, text, { reply_markup: choiceKeyboard([
    topupAndBuyRow(price - balance, `qr:${sid}`, { verb: 'получить QR' }),
    [{ text: '⬅️ Код клиента', callback_data: 'menu:code' }, ...MENU_ROW],
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

// ── Скидка участникам «Клуба вопросов» — server/_club.js (подключён в начале файла) ──
// В боте: человек пришёл по кнопке из группы клуба (/start club_code | club_reviews) → club_ref_at, скидка 30 дней
// после перехода и только при активной подписке. Только «Код клиента» и «Кто поставил оценку»; ШК и магазин — без скидки.
// Тот же модуль даёт скидку на тариф «Про» программы при оплате на сайте (api/payments.js).
const clientCodePrice = telegramId => clubPrice(telegramId, CLIENT_CODE_PRICE);
// Приписка к «Списано …» при скидке клуба.
const CLUB_CHARGE_NOTE = ` (скидка клуба ${CLUB_DISCOUNT_PERCENT}%)`;
// Разовая скидка на стикеры (GENERATION_DISCOUNT_PRICES к GENERATION_PRICES) — в процентах для текстов.
const GENERATION_DISCOUNT_PERCENT = Math.round((1 - GENERATION_DISCOUNT_PRICES.custom / GENERATION_PRICES.custom) * 100);
// Предел срока ключа «ПВЗ Принт» = CHECK duration_days в 20260823_cell_print.sql — менять вместе.
const CELL_PRINT_MAX_DAYS = 4000;
const clientCodeEventKey = (userId, qrText) => `qr:${userId}:${qrText}`;
const reviewPrice = telegramId => clubPrice(telegramId, REVIEW_PRICE);

/** Цена «Кто поставил оценку» для экрана вместе со скидкой клуба: { price, club, info } — один запрос проверки. */
async function reviewPriceInfo(telegramId) {
  const info = await clubInfo(telegramId);
  return { price: info.active ? applyClubDiscount(REVIEW_PRICE) : REVIEW_PRICE, club: info.active, info };
}

/** «· осталось 6 из 10 на этот месяц, в пакете 5» после списания кода; ошибка → пусто. */
async function codesLeftText(userId) {
  try {
    const ent = await supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) });
    const limit = Number(ent?.codes_limit || 0), used = Number(ent?.codes_used || 0), packs = Number(ent?.packs_left || 0);
    const parts = [];
    if (limit > 0) parts.push(`${Math.max(0, limit - used)} из ${limit} на этот месяц`);
    if (packs > 0) parts.push(`в пакете ${packs}`);
    return parts.length ? ` · осталось ${parts.join(', ')}` : '';
  } catch { return ''; }
}

/**
 * Текст «Код …» → { digits } (цифры без пробелов, двоеточия, «№», дефисов; нет цифр — пустая строка) или null.
 * Принимает «Код 191607973», «код: 191 607 973», «Код191607973», «Код клиента 191607973». «\b» здесь не годится:
 * в JavaScript он не считает кириллицу буквами, и «Код» без цифр раньше проваливался в главное меню.
 */
function parseCodeCommand(text) {
  const match = /^\s*код(?![а-яёa-z])(.*)$/isu.exec(String(text || ''));
  if (!match) return null;
  const tail = match[1].replace(/^\s*клиента(?![а-яёa-z])/iu, '').replace(/[\s:№#.,-]/gu, '');
  return { digits: /^\d+$/.test(tail) ? tail : '' };
}

/**
 * «Код <ID>» в чате. Мгновенная выдача (и списание) — только при 7–12 цифрах, как у настоящего ID клиента; короче
 * (ячейка, SMS-код) — подсказка с поиском, без цифр — экран «Код клиента» с подсказкой сверху.
 */
async function handleCodeCommand(from, chatId, digits) {
  if (/^\d{7,12}$/.test(digits)) return handleClientCode(from, chatId, digits);
  if (!digits) {
    return showClientCode(chatId, undefined, from, { notice: 'Не понял номер клиента. Пришлите ID цифрами, например <code>191607973</code>, или найдите клиента по ячейке.' });
  }
  const lines = digits.length < 7
    ? [`Похоже, это не ID клиента: в нём 7–12 цифр, а вы прислали «${escapeHtml(digits)}».`, 'Если это номер ячейки или цифры телефона — найдите клиента поиском. Ничего не списано.']
    : [`В ID клиента 7–12 цифр, а вы прислали ${digits.length}. Проверьте номер. Ничего не списано.`];
  return sendMessage(chatId, lines.join('\n'), { reply_markup: choiceKeyboard([[{ text: '🔎 Найти клиента по ячейке или телефону', callback_data: 'code:find' }], MENU_ROW]) });
}

/** Подпись под QR клиента: кто это, сколько действует и что списано. */
function clientQrCaption(sid, cell, chargeText) {
  return [
    `QR клиента ${sid}${cell ? ` · ячейка ${cell}` : ''}`,
    'Действует сегодня, до 23:59 по Москве.',
    chargeText,
  ].join('\n');
}

const CLIENT_QR_KEYBOARD = choiceKeyboard([[{ text: '🔎 Найти ещё клиента', callback_data: 'code:find' }], MENU_ROW]);

/** Ячейка для подписи и кнопки «Повторить»: короткая и без разметки — иначе без неё. */
function safeCell(cell) {
  const value = String(cell || '').trim();
  return /^[0-9A-Za-zА-Яа-я-]{1,10}$/u.test(value) ? value : '';
}

/** QR не отправился: что с деньгами — по факту, без общей «внутренней ошибки». */
function clientQrFailedView(lines, retry) {
  return {
    text: ['⚠️ Не получилось отправить QR — Telegram не принял картинку.', ...lines].join('\n'),
    reply_markup: choiceKeyboard([...(retry ? [[retry]] : []), [{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }], MENU_ROW]),
  };
}

/** callback «отправить тот же QR ещё раз» по id списания (code:re:<ID>:<uuid>) — повтор без нового списания. */
function clientQrResendData(sid, requestId) {
  const data = `code:re:${sid}:${requestId}`;
  return Buffer.byteLength(data) <= 64 ? data : null;
}

/**
 * QR клиента по ID. Сначала код из тарифа или пакета (как в программе), если их нет — CLIENT_CODE_PRICE с баланса
 * (со скидкой клуба меньше). Каждое получение — отдельное списание, даже того же клиента (решение владельца).
 * cell — ячейка из поиска (для подписи); requestId — повтор отправки того же списания кодом (app_code_once
 * идемпотентна по нему: второй раз код не спишется).
 * → 'sent' | 'charged_unsent' (списано, фото не ушло, возврата нет) | 'not_sent' (ничего не списано: нехватка, возврат).
 */
async function handleClientCode(from, chatId, sid, { cell = '', requestId = null } = {}) {
  cell = safeCell(cell);
  const { qrText: freeQr } = buildClientQr(sid);
  if (clientCodeFreeFor(from.id)) {
    try {
      await sendPhoto(chatId, clientQrUrl(freeQr), { caption: clientQrCaption(sid, cell, unlimitedLine(from.id)), reply_markup: CLIENT_QR_KEYBOARD });
    } catch (error) {
      console.warn('Client QR photo failed (free)', error.message);
      const view = clientQrFailedView(['Ничего не списано. Попробуйте ещё раз через минуту.'], { text: '🔁 Попробовать ещё раз', callback_data: `code:qr:${sid}` });
      await sendMessage(chatId, view.text, { reply_markup: view.reply_markup });
      return 'not_sent';
    }
    return 'sent';
  }
  const userId = await ensureUser(from);
  const { qrText } = buildClientQr(sid);
  // 1) квота тарифа или пакет кодов клиента — без ПК (p_device = null, via = 'bot'); нет → 2) баланс
  const chargeId = requestId || crypto.randomUUID();
  let charged = null;
  try {
    charged = await account.chargeClientCode(userId, null, { requestId: chargeId, sid, qrText, meta: { via: 'bot' } });
  } catch (error) {
    if (error.code !== 'LIMIT_EXCEEDED') throw error;
  }
  if (charged) {
    const b = charged.billing || {};
    const free = b.free || b.source === 'unlimited';
    const left = free ? '' : await codesLeftText(userId);
    const spentText = free ? 'Без списания.'
      : charged.replayed ? 'Повторная отправка — ничего не списано.'
      : b.source === 'pack' ? `Списан 1 код из пакета${left}.` : `Списан 1 код из тарифа${left}.`;
    try {
      await sendPhoto(chatId, clientQrUrl(charged.qrText || qrText), { caption: clientQrCaption(sid, cell, spentText), reply_markup: CLIENT_QR_KEYBOARD });
    } catch (error) {
      console.warn('Client QR photo failed (code)', error.message);
      // Код уже списан: повтор по тому же id списания отправит этот же QR и второй раз не спишет.
      const resend = !free && clientQrResendData(sid, chargeId);
      const view = free
        ? clientQrFailedView(['Ничего не списано. Попробуйте ещё раз через минуту.'], { text: '🔁 Попробовать ещё раз', callback_data: `code:qr:${sid}` })
        : clientQrFailedView([resend ? 'Код уже списан — повторная отправка бесплатна.' : 'Код уже списан. Напишите в поддержку — разберёмся.'],
          resend ? { text: '🔁 Отправить ещё раз', callback_data: resend } : null);
      await sendMessage(chatId, view.text, { reply_markup: view.reply_markup });
      return free ? 'not_sent' : 'charged_unsent';
    }
    return 'sent';
  }
  // ограничение «Покупки» — с баланса нельзя (ACCOUNT_RESTRICTED покажет processUpdate)
  await controls.assertAllowed(userId, 'purchases');
  const [balance, { price, club }] = await Promise.all([walletRub(userId), clientCodePrice(from.id)]);
  if (balance < price) { await showClientCodePaywall(from, chatId, sid, balance, price); return 'not_sent'; }
  const spent = await supabaseFetch('rpc/wallet_spend', {
    method: 'POST',
    body: JSON.stringify({ p_user: userId, p_kopecks: price * 100, p_event_key: clientCodeEventKey(userId, qrText), p_details: { sid: String(sid), club } }),
  });
  if (!spent?.ok) { await showClientCodePaywall(from, chatId, sid, Number(spent?.balance || 0) / 100, price); return 'not_sent'; }
  // Ключ списания уникален (в qrText случайные 6 цифр), но если база всё же ответила «уже было» — денег сейчас не
  // взяли: не пишем «Списано» и при сбое отправки не возвращаем то, что не списывали.
  const duplicate = spent.duplicate === true;
  if (!duplicate) notifyAdminSpend({ userId, priceRub: price, title: `Код клиента (QR)${club ? ', скидка клуба' : ''}`, balanceKopecks: spent.balance }).catch(() => {});
  const spentText = duplicate ? 'Повторная отправка — ничего не списано.'
    : `Списано ${wallet.formatRub(price)}${club ? CLUB_CHARGE_NOTE : ''} · на балансе ${wallet.formatRub(Number(spent.balance) / 100)}.`;
  try {
    await sendPhoto(chatId, clientQrUrl(qrText), { caption: clientQrCaption(sid, cell, spentText), reply_markup: CLIENT_QR_KEYBOARD });
  } catch (error) {
    // Фото не ушло — возвращаем деньги, чтобы не списать за несделанное. Что сказать — по исходу возврата.
    console.warn('Client QR photo failed (wallet)', error.message);
    if (duplicate) {
      const view = clientQrFailedView(['Ничего не списано. Попробуйте ещё раз через минуту.'], { text: '🔁 Попробовать ещё раз', callback_data: `code:qr:${sid}${cell ? `:${cell}` : ''}` });
      await sendMessage(chatId, view.text, { reply_markup: view.reply_markup });
      return 'not_sent';
    }
    const refund = await supabaseFetch('rpc/admin_wallet_adjust', { method: 'POST', body: JSON.stringify({ p_user: userId, p_kopecks: price * 100, p_note: `qr refund ${qrText}` }) })
      .then(result => (result?.ok === false ? null : result || {}), refundError => { console.error('Client QR refund failed', userId, qrText, refundError.message); return null; });
    let view;
    if (refund) {
      const back = Number.isFinite(Number(refund.balance)) ? `, на балансе ${wallet.formatRub(Number(refund.balance) / 100)}` : '';
      view = clientQrFailedView([`Ничего не списано: ${wallet.formatRub(price)} вернулись на баланс${back}. Попробуйте ещё раз через минуту.`],
        { text: `🔁 Попробовать ещё раз — ${wallet.formatRub(price)}`, callback_data: `code:qr:${sid}${cell ? `:${cell}` : ''}` });
    } else {
      const incident = crypto.randomBytes(3).toString('hex');
      console.error(`Client QR refund not done [${incident}]`, userId, price, qrText);
      sendToAdmins(`⚠️ QR клиента: списано ${wallet.formatRub(price)}, фото не ушло, возврат не прошёл.\nTelegram ${Number(from.id)}, код ${incident}. Верните деньги вручную.`).catch(() => {});
      view = clientQrFailedView([`${wallet.formatRub(price)} списаны, а вернуть их автоматически не получилось. Напишите в поддержку и назовите код: <code>${incident}</code> — вернём вручную.`], null);
    }
    await sendMessage(chatId, view.text, { reply_markup: view.reply_markup });
    return refund ? 'not_sent' : 'charged_unsent';
  }
  return 'sent';
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
// Имя — только покупателя: item.name у товара бывает названием товара, а не клиента.
function goodName(item) { return String(item?.buyer?.name ?? '').trim(); }

/**
 * Совпадения по запросу: цифры могут быть номером ячейки, хвостом телефона или самим ID клиента (его копируют из
 * программы) — ищем всеми способами.
 */
function findClientsByQuery(goods, digits) {
  const out = new Map();
  for (const item of Array.isArray(goods) ? goods : []) {
    const sid = goodSid(item);
    if (!sid) continue;
    const cell = goodCell(item);
    const phoneDigits = goodPhone(item).replace(/\D/g, '');
    const cellMatch = cell && cell.replace(/\D/g, '') === digits;
    const phoneMatch = digits.length >= 3 && phoneDigits.length >= digits.length && phoneDigits.endsWith(digits);
    const sidMatch = sid === digits;
    if (!cellMatch && !phoneMatch && !sidMatch) continue;
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
    'Отправьте <b>номер ячейки</b> или <b>последние 4 цифры телефона</b> клиента.',
    'Например: <code>245</code> или <code>8898</code>.',
    '',
    'Ищу среди заказов, которые сейчас лежат в пункте.',
  ].join('\n'), { reply_markup: choiceKeyboard([
    [{ text: '🔁 Сменить ПВЗ', callback_data: 'cs:points' }],
    [{ text: '🚪 Выйти из WB', callback_data: 'cs:logout' }],
    [{ text: '⬅️ Назад', callback_data: 'menu:code' }, ...MENU_ROW],
  ]) });
}

/** После входа в WB (или выбора пункта): если ждали поиск клиента — к поиску, иначе к отзывам. */
async function afterWbReady(from, chatId, messageId) {
  localGoodsSnapshots.delete(Number(from.id)); // пункт мог смениться — товары старого ПВЗ не показывать
  const session = await getSession(from.id);
  if (session?.state === 'await_wb_for_search') { await clearSession(from.id); return promptClientQuery(from, chatId, messageId); }
  return showReviewFilters(from, chatId, messageId);
}

/** Вход в WB начат ради поиска клиента (или поиск уже открыт) — иначе ради отзывов. */
async function wbPurpose(from) {
  const session = await getSession(from.id).catch(() => null);
  return session?.state === 'await_wb_for_search' || session?.state === 'await_client_query' ? 'search' : 'reviews';
}

/** Вернуться с экрана входа / выбора пункта туда, откуда пришли: в поиск клиента или к отзывам. */
async function backToWbScreen(from, chatId, messageId) {
  if (await wbPurpose(from) === 'search') { await clearSession(from.id); return startClientSearch(from, chatId, messageId); }
  return showReviewFilters(from, chatId, messageId);
}

/** «Найти ID в боте»: нужен вход в WB (как для отзывов), затем запрос телефона/ячейки. notice — строка сверху. */
async function startClientSearch(from, chatId, messageId, { notice = '' } = {}) {
  const userId = await ensureUser(from);
  const connection = await getWbConnection(from.id);
  if (connection?.session?.token && connection.state === 'ready') return promptClientQuery(from, chatId, messageId);
  await saveSession(from, chatId, 'await_wb_for_search', { userId });
  if (connection?.session?.token && connection.state === 'await_point') return beginPointSelection(from, chatId, connection, messageId);
  // Код уже отправлен — повторное «Найти клиента» не сбрасывает вход, а напоминает, что ждём код.
  if (connection?.state === 'await_code' && connection.session?.desktopLoginToken) {
    await showScreen(chatId, messageId, wbCodeText(connection.session.phone, { repeat: true }), { reply_markup: WB_CODE_KEYBOARD });
    return;
  }
  await saveWbConnection(from, chatId, 'await_phone', { deviceId: crypto.randomUUID() });
  await showScreen(chatId, messageId, await wbLoginPromptText(from, 'search', notice), { reply_markup: choiceKeyboard([[{ text: '⬅️ Назад', callback_data: 'menu:code' }, ...MENU_ROW]]) });
}

/** Похоже на полный номер телефона: у WB середина номера затёрта, совпасть может только хвост. */
function phoneLike(digits) { return /^(?:[78]\d{10}|9\d{9})$/.test(digits); }

/** Кнопка результата поиска: «QR · яч. 245 · …98 · Иван» (без ID — QR даёт сама кнопка). */
function clientMatchButton(match) {
  const cells = [...match.cells];
  const tail = String(match.phone || '').replace(/\D/g, '').slice(-2);
  const parts = ['QR'];
  if (cells.length) parts.push(`яч. ${cells.join(', ')}`);
  if (tail) parts.push(`…${tail}`);
  if (match.name) parts.push(match.name);
  const cell = cells.length === 1 ? safeCell(cells[0]) : '';
  return { text: parts.join(' · ').slice(0, 60), callback_data: `code:qr:${match.sid}${cell ? `:${cell}` : ''}` };
}

async function runClientSearch(from, chatId, query) {
  const connection = await getWbConnection(from.id);
  if (!connection?.session?.token || connection.state !== 'ready') { await clearSession(from.id); return startClientSearch(from, chatId); }
  // Поиск остаётся открытым: каждый запрос продлевает ожидание, следующий номер можно прислать и через час.
  await saveSession(from, chatId, 'await_client_query', { userId: await findUser(from.id) });
  const point = connection.session?.pointId ? ` на ПВЗ ${escapeHtml(connection.session.pointId)}` : '';
  let digits = String(query || '').replace(/\D/g, '');
  if (!digits) return sendMessage(chatId, 'Отправьте номер ячейки или последние 4 цифры телефона клиента — цифрами.', { reply_markup: choiceKeyboard([MENU_ROW]) });
  let goods;
  try {
    goods = await loadGoodsSnapshot(from.id, connection);
  } catch (error) {
    if (await replyWbFailure(from, chatId, error, { purpose: 'search' })) return;
    throw error;
  }
  let matches = findClientsByQuery(goods, digits);
  const lines = [];
  if (!matches.length && phoneLike(digits)) {
    digits = digits.slice(-4);
    lines.push(`Ищу по последним 4 цифрам телефона: ${digits}.`);
    matches = findClientsByQuery(goods, digits);
  }
  if (!matches.length) {
    // 7–12 цифр не телефон — может быть ID клиента не из этого пункта: QR через подтверждение с ценой.
    const maybeId = !lines.length && /^\d{7,12}$/.test(digits);
    return sendMessage(chatId, [
      ...lines,
      `По «${escapeHtml(digits)}» никого не нашёл${point}.`,
      'Проверьте номер и отправьте ещё раз — ячейку или последние 4 цифры телефона. Ищу только среди заказов, которые сейчас лежат в пункте.',
    ].join('\n'), { reply_markup: choiceKeyboard([
      ...(maybeId ? [[{ text: '🔑 Это ID клиента — получить QR', callback_data: `code:ask:${digits}` }]] : []),
      [{ text: 'Сменить ПВЗ', callback_data: 'cs:points' }],
      MENU_ROW,
    ]) });
  }
  const userId = await findUser(from.id).catch(() => null);
  const charge = await nextClientCharge(from, userId);
  lines.unshift('<b>🔎 Найдено:</b>');
  lines.push(`Выберите клиента — пришлю его QR. ${approvals.chargeLine(charge)}`);
  if (charge.kind !== 'free') lines.push('Каждое нажатие — отдельное списание.');
  lines.push('');
  const rows = [];
  matches.slice(0, 10).forEach((match, index) => {
    const cells = [...match.cells].join(', ');
    // «1. Иван · яч. 245 · +7 912 ***-**-98»
    const parts = [];
    if (match.name) parts.push(escapeHtml(match.name));
    if (cells) parts.push(`яч. ${escapeHtml(cells)}`);
    if (match.phone) parts.push(maskWbPhone(match.phone));
    lines.push(`${index + 1}. ${parts.join(' · ') || 'клиент'}`);
    rows.push([clientMatchButton(match)]);
  });
  if (matches.length > 10) lines.push('', `…и ещё ${matches.length - 10}. Уточните запрос.`);
  rows.push([{ text: 'Сменить ПВЗ', callback_data: 'cs:points' }, ...MENU_ROW]);
  lines.push('', 'Можно сразу отправить следующую ячейку или последние 4 цифры телефона.');
  await sendMessage(chatId, lines.join('\n'), { reply_markup: choiceKeyboard(rows) });
}

async function showHelperInfo(chatId, messageId) {
  const free = await helperFreeText();
  const text = [
    '<b>🖥 Помощник ПВЗ</b>',
    'Программа для ПК пункта: код клиента, ячейки, отзывы с авторами, досье клиентов, график и зарплата сотрудников.',
    '',
    ...SALE_PLANS.map(id => `${PLANS[id].title} — ${PLANS[id].monthlyPrice} ₽/мес (у аналогов ${PLANS[id].compare[1]} ₽)`),
    ...(free ? [`🎁 Сейчас ${free}`] : []),
    '',
    `Скачать: ${PROGRAM_URL}`,
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    [{ text: '🛒 Купить подписку', callback_data: 'shop:helper' }],
    [{ text: '🔑 Как найти код клиента', callback_data: 'menu:code' }],
    MENU_ROW,
  ]) });
}

// Пробный период «ПВЗ Принт» включается в самой программе: один раз на компьютер и аккаунт и только до покупки
// ключа (api/cell-print.js, маршрут trial) — поэтому не «первые 7 дней бесплатно», а «можно включить».
async function showCellPrintInfo(chatId, messageId) {
  const text = [
    '<b>🖨 ПВЗ Принт — печать ячеек</b>',
    'Сканируете товар — номер ячейки сразу печатается на термопринтере. Этикетки без лимита.',
    '',
    'В программе можно включить 7 дней бесплатно — один раз, до покупки ключа.',
    `Дальше нужен ключ — от ${wallet.formatRub(CELL_PRINT_PRICES[7]?.[1])} за 7 дней.`,
    `Скачать на компьютер пункта: ${CELL_PRINT_URL}`,
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    [{ text: '🛒 Купить или продлить ключ', callback_data: 'shop:cp' }],
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

/**
 * Снять у человека старую постоянную клавиатуру: Telegram убирает её только по remove_keyboard
 * в сообщении, поэтому шлём короткое служебное сообщение и тут же удаляем — клавиатура остаётся
 * снятой, а в чате ничего лишнего. Ошибки не мешают основному ответу.
 */
async function dropLegacyKeyboard(chatId) {
  try {
    const message = await sendMessage(chatId, 'Меню обновлено', { reply_markup: { remove_keyboard: true } });
    if (message?.message_id) await deleteMessage(chatId, message.message_id).catch(() => {});
  } catch (error) {
    console.warn('Не удалось снять старую клавиатуру', error?.message || error);
  }
}

// ── Мастер стикеров: одно сообщение, шаги сменяют друг друга, «⬅️ Назад» — на шаг раньше ──

const GEN_BACK = { text: '⬅️ Назад', callback_data: 'gen:back' };
const GEN_CANCEL = { text: '✖️ Отмена', callback_data: 'gen:cancel' };
const KIND_TITLES = { product: '🏷 Стикеры товаров', box: '📦 QR возвратных коробок' };
const MODE_TITLES = { range: `Пачка ${BATCH_QUANTITY}`, custom: 'По номеру' };
// Что получает человек — одними словами во всех шагах (словарь плана: «стикер», «QR коробки», без «генерации»).
const KIND_NOUNS = {
  product: { one: 'стикер товара', many: 'стикеров товаров', number: 'номер ШК', length: 11, example: '47671114039' },
  box: { one: 'QR коробки', many: 'QR коробок', number: 'номер коробки', length: 10, example: '1234567890' },
};

function kindNoun(category) { return KIND_NOUNS[category === 'box' ? 'box' : 'product']; }

/** 1 цифра, 2 цифры, 5 цифр — для любого слова с тремя формами. */
function plural(count, one, few, many) {
  const n = Math.abs(Number(count)) % 100, last = n % 10;
  if (n > 10 && n < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** Самая низкая цена за штуку в пакетах по номеру — для строки «в пакете дешевле — от 3 ₽ за штуку». */
function cheapestPackageUnit() {
  const units = Object.entries(CUSTOM_GENERATION_PACKAGES).filter(([count]) => Number(count) > 1).map(([count, price]) => price / Number(count));
  return units.length ? Math.min(...units) : null;
}

/**
 * Цены мастера для этого человека (копейки) и что покроет его пакет. wizardView синхронная, а скидка и пакет —
 * запросы, поэтому цены кладутся в черновик, когда мастер доходит до выбора «Пачка / По номеру».
 * Пакет считается как в reserve_sticker_generation: «Один по номеру» берёт коды с режимом custom или без режима,
 * «Пачка 50» — коды batch или без режима (месячные стикеры тарифа «Про»), где осталось не меньше 50.
 * Месячный пакет «Про» создаём заранее — иначе в начале месяца здесь была бы цена, а спишется из пакета.
 * Сбой — обычные цены.
 */
async function wizardPrices(userId) {
  await ensureMonthlyStickers(userId);
  const [prices, codes] = await Promise.all([
    generationPrices(userId).catch(() => ({ batch: GENERATION_PRICES.batch, custom: GENERATION_PRICES.custom, discountAvailable: false })),
    supabaseFetch(`sticker_access_codes?owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=generation_limit,generation_used,generation_mode`).catch(() => []),
  ]);
  const rows = Array.isArray(codes) ? codes : [];
  const packageLeft = rows.filter(row => row.generation_mode !== 'batch').reduce((sum, row) => sum + remainingOf(row), 0);
  const batchFromPackage = rows.some(row => row.generation_mode !== 'custom' && remainingOf(row) >= BATCH_QUANTITY);
  return { batch: prices.batch, custom: prices.custom, discount: Boolean(prices.discountAvailable), packageLeft, batchFromPackage };
}

/** Выбранные параметры над вопросом шага — теми же словами, что на кнопках. */
function wizardTrail(draft, { withCode = true } = {}) {
  const lines = [];
  if (draft.category) lines.push(`Что: <b>${KIND_TITLES[draft.category]}${draft.mode ? ` · ${MODE_TITLES[draft.mode]}` : ''}</b>`);
  if (withCode && draft.mode === 'custom' && draft.code) lines.push(`Номер: <code>${escapeHtml(draft.code)}</code>`);
  return lines.length ? `${lines.join('\n')}\n\n` : '';
}

/** «Получите: …» на подтверждении. */
function wizardResultLine(draft) {
  const noun = kindNoun(draft.category);
  if (draft.mode === 'range') return `${BATCH_QUANTITY} ${noun.many} с новыми номерами одним PDF.`;
  return `1 ${noun.one} с номером <code>${escapeHtml(draft.code || '')}</code> — картинку и PDF для печати.`;
}

function wizardView(state, draft) {
  const error = draft.error ? `⚠️ ${draft.error}\n\n` : '';
  const trail = wizardTrail(draft);
  const noun = kindNoun(draft.category);
  if (state === 'choose_kind') {
    return { text: `${error}<b>Что нужно создать?</b>`, rows: [
      [{ text: KIND_TITLES.product, callback_data: 'gen:kind:product' }],
      [{ text: KIND_TITLES.box, callback_data: 'gen:kind:box' }],
      [{ text: '⬅️ Меню', callback_data: 'menu:home' }],
    ] };
  }
  if (state === 'choose_mode') {
    const prices = draft.prices || { batch: GENERATION_PRICES.batch, custom: GENERATION_PRICES.custom, discount: false, packageLeft: 0 };
    const batch = wallet.formatRub(prices.batch / 100), custom = wallet.formatRub(prices.custom / 100);
    const packageLeft = Number(prices.packageLeft || 0), batchFromPackage = Boolean(prices.batchFromPackage), cheapest = cheapestPackageUnit();
    const box = draft.category === 'box';
    const lines = [
      `<b>${box ? 'Какие QR коробок нужны?' : 'Какие стикеры нужны?'}</b>`,
      `• Пачка ${BATCH_QUANTITY} — ${BATCH_QUANTITY} ${box ? 'QR с новыми номерами коробок' : 'стикеров с новыми номерами ШК'} одним PDF, ${batchFromPackage ? `из вашего пакета (спишется ${BATCH_QUANTITY} шт.)` : `${batch} за всю пачку`}.`,
      `• Один по номеру — ${box ? 'QR с номером коробки' : 'стикер с номером ШК'}, который вы пришлёте, ${packageLeft > 0 ? 'из вашего пакета' : custom}.`,
    ];
    if (prices.discount && !(batchFromPackage && packageLeft > 0)) lines.push(`Цены — с разовой скидкой ${GENERATION_DISCOUNT_PERCENT}%.`);
    if (packageLeft > 0) lines.push(`В вашем пакете ${packageLeft} шт. — ${batchFromPackage ? `и «Пачка ${BATCH_QUANTITY}», и «Один по номеру» спишутся` : '«Один по номеру» спишется'} из него, баланс не тронется.`);
    else if (cheapest) lines.push(`Часто делаете по номеру? В пакете дешевле — от ${wallet.formatRub(cheapest)} за штуку.`);
    return { text: `${trail}${error}${lines.join('\n')}`, rows: [
      [{ text: batchFromPackage ? `Пачка ${BATCH_QUANTITY} шт. — из пакета` : `Пачка ${BATCH_QUANTITY} шт. — ${batch}`, callback_data: 'gen:mode:range' }],
      [{ text: packageLeft > 0 ? 'Один по номеру — из пакета' : `Один по номеру — ${custom}`, callback_data: 'gen:mode:custom' }],
      [{ text: cheapest ? `💎 Пакеты по номеру — от ${wallet.formatRub(cheapest)}/шт.` : '💎 Пакеты по номеру', callback_data: 'shop:gen:wizard' }],
      [GEN_BACK],
    ] };
  }
  if (state === 'await_code') {
    // Несколько номеров (с фото или в одном сообщении) — выбрать кнопкой или прислать номер цифрами.
    if (Array.isArray(draft.photoCodes) && draft.photoCodes.length) {
      const title = draft.pickFromText
        ? `<b>Вы прислали несколько номеров</b>\nЗа один раз делаю один ${noun.one.split(' ')[0]} — выберите номер.`
        : '<b>На фото несколько номеров — какой нужен?</b>\nИли пришлите номер цифрами.';
      return { text: `${trail}${error}${title}`, rows: [
        ...draft.photoCodes.map(code => [{ text: code, callback_data: `gen:pick:${code}` }]),
        [GEN_BACK, GEN_CANCEL],
      ] };
    }
    // Подсказку про фото для коробок не даём: 10 цифр подряд на снимке — это и телефон без +7, будут ложные номера.
    const lines = draft.category === 'box'
      ? ['<b>Пришлите номер коробки</b>', `10 цифр без букв TRBX, например <code>${noun.example}</code>. Один номер — один QR.`]
      : ['<b>Пришлите номер ШК</b>', `ШК — номер товара из 11 цифр, например <code>${noun.example}</code>. Один номер — один стикер.`, '📷 Можно прислать скриншот или фото экрана, где виден номер, — прочитаю сам.'];
    return { text: `${trail}${error}${lines.join('\n')}`, rows: [[GEN_BACK, GEN_CANCEL]] };
  }
  // state === 'confirm'
  const head = `${wizardTrail(draft, { withCode: false })}${error}`;
  const result = `Получите: ${wizardResultLine(draft)}`;
  if (draft.accessCode) {
    const units = draft.mode === 'range' ? BATCH_QUANTITY : 1;
    return { text: `${head}<b>Проверьте и нажмите «Создать»</b>\n${result}\nСпишется из вашего пакета: ${units} шт., в пакете останется ${Number(draft.packageRemaining || 0)}. Баланс не изменится.`, rows: [
      [{ text: '✅ Создать (из пакета)', callback_data: 'gen:confirm' }],
      [GEN_BACK, GEN_CANCEL],
    ] };
  }
  // Без пакета — с общего рублёвого баланса.
  const cost = Number(draft.walletCost || 0), balance = Number(draft.balanceKopecks || 0) / 100;
  if (balance >= cost) {
    return { text: `${head}<b>Проверьте и нажмите «Создать»</b>\n${result}\nСпишется с баланса: <b>${wallet.formatRub(cost)}</b>${draft.discountAvailable ? ` (скидка ${GENERATION_DISCOUNT_PERCENT}%)` : ''}, останется ${wallet.formatRub(balance - cost)}.`, rows: [
      [{ text: `✅ Создать за ${wallet.formatRub(cost)}`, callback_data: 'gen:confirm' }],
      [GEN_BACK, GEN_CANCEL],
    ] };
  }
  const missing = cost - balance;
  const amount = Math.max(wallet.MIN_TOPUP, Math.ceil(missing - 1e-9));
  const left = Math.round((balance + amount + wallet.topupBonus(amount) - cost) * 100) / 100;
  const lines = [
    `${head}<b>На балансе не хватает денег</b>`,
    result,
    `Нужно ${wallet.formatRub(cost)}, на балансе ${wallet.formatRub(balance)}.`,
    ...(amount === wallet.MIN_TOPUP && amount > missing ? [`Минимальное пополнение — ${wallet.formatRub(wallet.MIN_TOPUP)}, после создания на балансе останется ${wallet.formatRub(left)}.`] : []),
    'После оплаты всё создастся само — нажимать ничего не нужно.',
  ];
  return { text: lines.join('\n'), rows: [
    topupAndBuyRow(missing, 'gen', { verb: 'создать' }),
    [GEN_BACK, GEN_CANCEL],
  ] };
}

/**
 * Номер из сообщения в шаге «По номеру». Буквы TRBX, пробелы и дефисы срезаем («TRBX-1234-567-890»).
 * → { code } | { codes } — несколько номеров нужной длины | { error } — что не так, со счётом цифр.
 */
function parseWizardNumber(text, category) {
  const noun = kindNoun(category), length = noun.length;
  const raw = String(text || '');
  const strip = value => value.replace(/TRBX/gi, '').replace(/[\s\-‐-―]/g, '');
  const whole = strip(raw);
  if (new RegExp(`^\\d{${length}}$`).test(whole)) return { code: whole };
  // Несколько номеров через пробел, запятую или с новой строки — каждый по отдельности.
  const tokens = raw.split(/[\s,;]+/).map(strip).filter(Boolean);
  const codes = [...new Set(tokens.filter(token => new RegExp(`^\\d{${length}}$`).test(token)))];
  if (codes.length > 1) return { codes: codes.slice(0, 5) };
  if (codes.length === 1) return { code: codes[0] };
  // Одна цифровая серия нужной длины среди лишних знаков («47671114039.», «№47671114039», «ШК:47671114039») —
  // это и есть номер; ничего не списывается до подтверждения, где номер виден.
  const runs = whole.match(/\d+/g) || [];
  if (runs.length === 1 && runs[0].length === length) return { code: runs[0] };
  const digits = runs.join('').length;
  const shown = escapeHtml(raw.trim().slice(0, 24));
  const hint = `Пришлите номер ещё раз, например <code>${noun.example}</code>.`;
  if (!digits) return { error: `В сообщении нет цифр. ${noun.number[0].toUpperCase()}${noun.number.slice(1)} — ${length} цифр. ${hint}` };
  if (digits === length) return { error: `Не понял номер в «${shown}»: цифры разделены другими знаками. Пришлите только цифры, например <code>${noun.example}</code>.` };
  const box = category === 'box' ? ' (без букв TRBX)' : '';
  return { error: `В «${shown}» ${digits} ${plural(digits, 'цифра', 'цифры', 'цифр')}, а в ${category === 'box' ? 'номере коробки' : 'номере ШК'} их ${length}${box}. ${hint}` };
}

/**
 * Старый экран мастера уходит из чата: удаляем, а если Telegram не дал (сообщению больше 48 часов) — снимаем
 * кнопки, чтобы по нему больше не нажимали.
 */
async function retireMessage(chatId, messageId) {
  if (!messageId) return;
  try {
    await telegramRequest('deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch {
    await telegramRequest('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
}

/**
 * Перерисовать шаг мастера и сохранить состояние. messageId — нажатая кнопка: экран правится на месте.
 * Без messageId — шаг вызван текстом или фото: экран уходит новым сообщением вниз, прежний экран удаляется
 * (иначе ответ появлялся бы в сообщении выше по чату, а внизу — ничего).
 */
async function renderWizard(from, chatId, state, draft, messageId) {
  const view = wizardView(state, draft);
  delete draft.error;
  const options = { reply_markup: choiceKeyboard(view.rows) };
  if (!messageId) {
    const previousId = draft.msgId || null;
    draft.msgId = await showScreen(chatId, null, view.text, options);
    await saveSession(from, chatId, state, draft);
    if (previousId && previousId !== draft.msgId) await retireMessage(chatId, previousId);
    return;
  }
  // Экран правится в известном сообщении — его id в черновике уже есть, поэтому Telegram и Supabase
  // идут параллельно. Если сообщение не удалось отредактировать и ушло новое, сохраняем ещё раз с новым id.
  draft.msgId = messageId;
  const [shownId] = await Promise.all([showScreen(chatId, messageId, view.text, options), saveSession(from, chatId, state, draft)]);
  if (shownId && shownId !== messageId) {
    draft.msgId = shownId;
    await saveSession(from, chatId, state, draft);
  }
}

/** Выбор «Пачка / По номеру» с ценами этого человека (скидка, пакет) — цены кладутся в черновик здесь. */
async function renderChooseMode(from, chatId, draft, messageId) {
  draft.prices = await wizardPrices(draft.userId);
  return renderWizard(from, chatId, 'choose_mode', draft, messageId);
}

/** Шаг назад: куда возвращаться из каждого состояния. */
async function wizardBack(from, chatId, session, messageId) {
  const draft = session.draft || {};
  const state = session.state;
  if (state === 'choose_mode') { delete draft.category; return renderWizard(from, chatId, 'choose_kind', draft, messageId); }
  // Выбор из нескольких номеров → «Назад» возвращает к вводу номера.
  if (state === 'await_code' && draft.photoCodes) {
    delete draft.photoCodes; delete draft.pickFromText;
    return renderWizard(from, chatId, 'await_code', draft, messageId);
  }
  if (state === 'await_code') {
    delete draft.mode; delete draft.quantity; delete draft.code; delete draft.prefix; delete draft.photoCodes; delete draft.pickFromText;
    return renderChooseMode(from, chatId, draft, messageId);
  }
  if (state === 'confirm') {
    delete draft.accessCode; delete draft.packageRemaining; delete draft.walletCost; delete draft.balanceKopecks;
    if (draft.mode === 'range') { delete draft.mode; delete draft.quantity; return renderChooseMode(from, chatId, draft, messageId); }
    delete draft.code; delete draft.photoCodes; delete draft.pickFromText;
    return renderWizard(from, chatId, 'await_code', draft, messageId);
  }
  return renderWizard(from, chatId, 'choose_kind', draft, messageId);
}

// Кнопки пополнения ведут не в Mini App, а на tp:<сумма>[:<then>]: бот сам создаёт заказ ЮKassa и присылает
// ссылку на оплату (server/_bot-checkout.js). Экран покупки, который после оплаты станет «Готово», — это
// сообщение с кнопкой, его id известен в момент нажатия, в callback_data его не кладём.
function topupButton(amount) {
  const bonus = wallet.topupBonus(amount);
  return { text: `${amount} ₽${bonus ? ` (+${bonus} ₽)` : ''}`, callback_data: `tp:${amount}` };
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
function topupAndBuyRow(missingRub, then, { verb = 'купить' } = {}) {
  const amount = Math.max(wallet.MIN_TOPUP, Math.ceil(Number(missingRub) - 1e-9));
  // ~<копейки> — сколько не хватает, для пояснения на экране оплаты. Лимит callback_data у Telegram — 64 байта;
  // не влезло — кнопка без пояснения, покупка от этого не зависит.
  const detailed = `tp:${amount}~${Math.round(Number(missingRub) * 100)}:${then}`;
  const callbackData = Buffer.byteLength(detailed) <= 64 ? detailed : `tp:${amount}:${then}`;
  return [{ text: `💳 Пополнить на ${amount} ₽ и ${verb}`, callback_data: callbackData }];
}

/** Почему сумма пополнения не равна цене: цена, баланс, нехватка, минимум и остаток. Числа неизвестны — пустой список. */
function topupPurchaseLines({ amount, bonus = 0, balance, missing }) {
  if (!Number.isFinite(balance) || !Number.isFinite(missing) || missing <= 0) return [];
  const price = balance + missing;
  const left = Math.round((amount + bonus - missing) * 100) / 100;
  const lines = [`Покупка стоит ${wallet.formatRub(price)}, на балансе ${wallet.formatRub(balance)}${balance > 0 ? `, не хватает ${wallet.formatRub(missing)}` : ''}.`];
  if (amount === wallet.MIN_TOPUP && amount > missing) lines.push(`Минимальное пополнение — ${wallet.formatRub(wallet.MIN_TOPUP)}, поэтому после покупки на балансе останется ${wallet.formatRub(left)}.`);
  else if (left > 0) lines.push(`После покупки на балансе останется ${wallet.formatRub(left)}.`);
  return lines;
}

const OFFER_LINE = `Нажимая «Перейти к оплате», вы принимаете <a href="${publicUrl('/offer')}">оферту</a>.`;

/**
 * Нажата кнопка пополнения: создать заказ ЮKassa и показать ссылку на оплату в том же сообщении.
 * then — что купить после зачисления (afterWalletTopup), screenId — экран, который после оплаты станет «Готово».
 */
/**
 * Заказ ЮKassa из бота (server/_bot-checkout.js) за аккаунт этого Telegram. Аккаунта нет — значит, кеш связки
 * устарел (поддержка объединила аккаунты): сбрасываем кеш, берём аккаунт заново и пробуем ещё раз — один раз.
 * create(userId) → { confirmationUrl }. Возвращает { userId, payment }.
 */
async function createBotPayment(from, create) {
  let userId = await ensureUser(from);
  try {
    return { userId, payment: await create(userId) };
  } catch (error) {
    if (error?.code !== 'ACCOUNT_NOT_FOUND') throw error;
    console.warn('Bot checkout: account not found, retrying with a fresh link', from.id);
    userCache.forgetTelegramUser(from.id);
    userId = await ensureUser(from);
    return { userId, payment: await create(userId) };
  }
}

/**
 * Не получилось создать оплату: что сказать человеку. Как есть показываем только ответы, написанные для
 * человека и узнаваемые по коду (ограничение аккаунта); остальное — общий текст, исходная ошибка — в лог.
 * retry: false — повтор сейчас не поможет (лимит попыток), кнопку «Попробовать снова» не даём.
 */
function paymentErrorView(error) {
  if (error?.code === 'ACCOUNT_RESTRICTED') return { text: `⛔ ${escapeHtml(error.message)}`, retry: false };
  if (Number(error?.status) === 429) return { text: '⚠️ Слишком много попыток оплаты подряд. Подождите 10 минут и попробуйте снова.', retry: false };
  return { text: '⚠️ Не получилось создать оплату. Деньги не списаны. Попробуйте ещё раз через минуту, а если не выйдет — напишите в поддержку.', retry: true };
}

function paymentErrorKeyboard(view, retryData) {
  return choiceKeyboard([
    ...(view.retry ? [[{ text: '🔄 Попробовать снова', callback_data: retryData }]] : []),
    [{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }],
    MENU_ROW,
  ]);
}

// «⬅️ Назад» с экрана оплаты — server/_topup-screen.js: тот же расчёт нужен сайту, когда он правит этот экран.
const { topupBackData } = topupScreen;

/**
 * retryData — исходная кнопка tp:…: «Попробовать снова» повторяет то же пополнение с той же покупкой.
 * id экрана уходит в заказ всегда: после оплаты (или её отмены) сайт правит этот экран, а не оставляет живую ссылку.
 */
async function startTopupPayment(from, chatId, amount, then, screenId, missing = null, retryData = 'topup:home') {
  const bonus = wallet.topupBonus(amount);
  // Кнопка из уведомления открывает экран новым сообщением — его id нужен заказу до создания оплаты.
  if (!screenId) screenId = await showScreen(chatId, null, '⏳ Готовлю оплату…');
  let userId, payment;
  try {
    ({ userId, payment } = await createBotPayment(from, id => require('./_bot-checkout').createTopupPayment({ userId: id, amount, then, messageId: screenId })));
  } catch (error) {
    console.warn('Telegram topup payment failed', error.code || '', error.message);
    const view = paymentErrorView(error);
    await showScreen(chatId, screenId, view.text, { reply_markup: paymentErrorKeyboard(view, retryData) });
    return;
  }
  const balance = then && missing != null ? await walletRub(userId).catch(() => null) : null;
  const text = [
    `<b>💳 Пополнение на ${wallet.formatRub(amount)}</b>`,
    ...(bonus ? [`Зачислим ${wallet.formatRub(amount + bonus)}: ${wallet.formatRub(amount)} + бонус ${wallet.formatRub(bonus)}.`] : []),
    ...topupPurchaseLines({ amount, bonus, balance: balance ?? NaN, missing: missing ?? NaN }),
    '',
    then
      ? 'Откроется страница оплаты ЮKassa. После оплаты вернитесь сюда — покупка пройдёт сама, ничего нажимать не нужно.'
      : 'Откроется страница оплаты ЮKassa. После оплаты вернитесь сюда — я напишу, что деньги на балансе.',
    '',
    OFFER_LINE,
  ].join('\n');
  const check = topupScreen.topupCheckData(payment.token);
  await showScreen(chatId, screenId, text, { reply_markup: choiceKeyboard([
    [{ text: `💳 Перейти к оплате ${wallet.formatRub(amount)}`, url: payment.confirmationUrl }],
    ...(check ? [[{ text: '🔄 Проверить оплату', callback_data: check }]] : []),
    [{ text: '⬅️ Назад', callback_data: topupBackData(then) }, ...MENU_ROW],
  ]) });
}

/**
 * «🔄 Проверить оплату» (tpc:<токен заказа>): спросить ЮKassa сейчас, не дожидаясь вебхука. Запрос статуса
 * (api/payments.js, action=status) сам зачисляет оплаченное — сообщение о зачислении придёт как обычно.
 * Заказ ищем по токену и аккаунту этого Telegram: чужой токен ничего не покажет.
 */
async function checkTopupPayment(from, chatId, messageId, callbackId, token) {
  const userId = await ensureUser(from);
  const rows = await supabaseFetch(`payment_orders?public_token=eq.${encodeURIComponent(token)}&user_id=eq.${encodeURIComponent(userId)}&product_kind=eq.wallet_topup&select=id,status,fulfillment_status,gross_amount,pricing_snapshot&limit=1`);
  const order = rows[0];
  if (!order) return answerCallbackQuery(callbackId, 'Эта оплата не найдена — откройте пополнение заново');
  const wasCanceled = order.status === 'canceled';
  let status = order.fulfillment_status === 'fulfilled' ? 'succeeded' : order.status;
  if (status !== 'succeeded' && !wasCanceled) {
    try {
      status = (await require('./_bot-checkout').checkTopupPayment({ token })).status;
    } catch (error) {
      console.warn('Telegram topup status check failed', error.code || '', error.message);
      return answerCallbackQuery(callbackId, 'Не получилось проверить оплату. Попробуйте через минуту.');
    }
  }
  const topup = order.pricing_snapshot?.wallet || {};
  const amount = Number(topup.amount || order.gross_amount || 0);
  if (status === 'succeeded') {
    answerCallbackQuery(callbackId, 'Оплата прошла ✅ Деньги на балансе').catch(() => {});
    // Пополнение ради покупки: экран правит сама покупка (afterWalletTopup); простое — итог здесь.
    if (!topup.then) await showScreen(chatId, messageId, topupScreen.paidScreenText(amount), { reply_markup: choiceKeyboard([[{ text: '👤 Профиль', callback_data: 'menu:profile' }, ...MENU_ROW]]) });
    return;
  }
  if (status === 'canceled') {
    answerCallbackQuery(callbackId, 'Оплата не прошла — деньги не списаны').catch(() => {});
    // Отмену только что узнал запрос статуса — он сам поправил экран (с причиной). Отменён раньше — правим здесь.
    if (wasCanceled) {
      const view = topupScreen.canceledScreen({ amount, then: String(topup.then || '') });
      await showScreen(chatId, messageId, view.text, { reply_markup: view.reply_markup });
    }
    return;
  }
  return answerCallbackQuery(callbackId, 'Оплата ещё не поступила. Если вы уже оплатили — подождите минуту и нажмите снова.');
}

/** Кнопки профиля. orders — у человека есть индивидуальные заказы стикеров: кнопка «Мои заказы». */
function profileKeyboard({ orders = false } = {}) {
  const rows = [
    [{ text: '💰 Пополнить баланс', callback_data: 'topup:home' }, { text: '🛒 Купить с баланса', callback_data: 'shop:home' }],
    [{ text: '👥 Пригласить коллегу', callback_data: 'menu:ref' }, { text: '🎟 Ввести код доступа', callback_data: 'code:enter' }],
  ];
  if (orders) rows.push([{ text: '📦 Мои заказы', callback_data: 'orders:list' }]);
  rows.push(MENU_ROW);
  return choiceKeyboard(rows);
}

/**
 * Ответ claim_user_asset для человека: { text, retry } — retry: бот ждёт код дальше (опечатка в цифрах).
 * null — ошибка не из этих, пусть летит дальше.
 */
function claimError(error) {
  const details = JSON.stringify(error?.details || error?.message || '');
  if (details.includes('Asset belongs to another user')) return { text: 'Этот код уже принадлежит другому аккаунту. Если код ваш (например, куплен на сайте) — напишите в поддержку, перенесём его в бот.', retry: false };
  if (details.includes('Asset not found')) return { text: 'Код не найден. Проверьте цифры и пришлите код ещё раз.', retry: true };
  if (details.includes('User is not confirmed')) return { text: 'Не получилось добавить код. Напишите в поддержку — поможем.', retry: false };
  return null;
}

function claimErrorText(error) {
  return claimError(error)?.text || null;
}

// Под ответами о коде доступа: отмена ввода и поддержка (раньше ответ приходил без кнопок, выйти — только /cancel).
// Отмена своя (code:cancel → профиль): общая gen:cancel отвечала «создание стикера отменено», хотя стикер не начинали.
const ACCESS_CODE_CANCEL = { text: '✖️ Отмена', callback_data: 'code:cancel' };
const ACCESS_CODE_REPLY_KEYBOARD = choiceKeyboard([
  [ACCESS_CODE_CANCEL],
  [{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }],
]);

/**
 * Попытка из лимита «N в час на Telegram ID» (коды доступа, вход в программу). Счётчик в базе
 * (consume_api_rate_limit), при её сбое — в памяти процесса. keyText различает лимиты между собой.
 */
async function consumeHourlyAttempt(scope, keyText, limit = CODE_ATTEMPTS_PER_HOUR) {
  const keyHash = crypto.createHash('sha256').update(keyText).digest('hex');
  try {
    const allowed = await supabaseFetch('rpc/consume_api_rate_limit', {
      method: 'POST',
      body: JSON.stringify({ p_scope: scope, p_key_hash: keyHash, p_limit: limit, p_window_seconds: 3600 }),
    });
    return allowed === true;
  } catch {
    const now = Date.now(), current = codeAttemptsFallback.get(keyHash);
    if (!current || current.resetAt <= now) { codeAttemptsFallback.set(keyHash, { hits: 1, resetAt: now + 3600 * 1000 }); return true; }
    current.hits += 1;
    return current.hits <= limit;
  }
}

function consumeCodeAttempt(telegramId) {
  return consumeHourlyAttempt('bot-access-code', `bot-code:${telegramId}`);
}

/**
 * Ввод кода доступа — например, кода от партнёра. Черновик мастера сохраняется, чтобы после привязки кода
 * сразу вернуться к подтверждению, а не начинать заново. Экран — в том же сообщении, где нажата кнопка.
 */
async function askAccessCode(from, chatId, draft = {}, messageId) {
  const userId = draft.userId || await ensureUser(from);
  await saveSession(from, chatId, 'await_access_code', { ...draft, userId });
  await showScreen(chatId, messageId, [
    '<b>🎟 Код доступа</b>',
    'Код доступа — 6 цифр: пакет стикеров от партнёра или поддержки.',
    'Пришлите его сообщением, например <code>123456</code>. Стикеры из кода добавятся в ваш пакет.',
  ].join('\n'), { reply_markup: choiceKeyboard([[ACCESS_CODE_CANCEL]]) });
}

async function redeemAccessCode(from, chatId, session, text) {
  const draft = session.draft || {};
  const code = normalizeAccessCode(text.replace(/\s+/g, ''));
  if (!isAccessCode(code)) return sendMessage(chatId, 'Код — это 6 цифр, например <code>123456</code>. Пришлите его ещё раз.', { reply_markup: ACCESS_CODE_REPLY_KEYBOARD });
  if (!await consumeCodeAttempt(from.id)) return sendMessage(chatId, 'Слишком много попыток. Попробуйте через час.', { reply_markup: MENU_KEYBOARD });
  try {
    await supabaseFetch('rpc/claim_user_asset', { method: 'POST', body: JSON.stringify({ p_user_id: draft.userId, p_kind: 'sticker', p_value: code }) });
  } catch (error) {
    const reason = claimError(error);
    if (!reason) throw error;
    // Опечатка — ждём код дальше; чужой код или сбой проверки — ввод закончен, дальше только поддержка.
    if (reason.retry) return sendMessage(chatId, reason.text, { reply_markup: ACCESS_CODE_REPLY_KEYBOARD });
    await clearSession(from.id);
    return sendMessage(chatId, reason.text, { reply_markup: supportKeyboard() });
  }
  const rows = await supabaseFetch(`sticker_access_codes?code=eq.${encodeURIComponent(code)}&select=active,generation_limit,generation_used&limit=1`);
  const row = rows[0];
  if (row && !row.active) {
    await clearSession(from.id);
    return sendMessage(chatId, `Код <code>${escapeHtml(code)}</code> добавлен, но сейчас отключён. Обратитесь к тому, кто его выдал.`, { reply_markup: supportKeyboard() });
  }
  const left = row ? Math.max(0, Number(row.generation_limit || 0) - Number(row.generation_used || 0)) : 0;
  await sendMessage(chatId, `✅ Код <code>${escapeHtml(code)}</code> принят: в вашем пакете <b>+${left}</b> ${plural(left, 'стикер', 'стикера', 'стикеров')}.`, { reply_markup: MENU_KEYBOARD });
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
  delete draft.accessCode;
  delete draft.packageRemaining;
  const packageMode = draft.mode === 'range' ? 'batch' : 'custom';
  // Код доступа (и его остаток), скидка и баланс не зависят друг от друга — читаем параллельно.
  // Месячный пакет «Про» — до выбора кода: по номеру с фото или голыми цифрами сюда приходят, минуя выбор режима.
  const [packageInfo, discounts, balanceKopecks] = await Promise.all([
    ensureMonthlyStickers(draft.userId).then(() => selectAccessCode(draft.userId, units, packageMode)).then(async packageCode => {
      if (!packageCode) return null;
      const status = await getAccessStatus(packageCode);
      return { packageCode, remaining: Math.max(0, Number(status?.remaining || 0) - units) };
    }),
    supabaseFetch(`sticker_generation_discounts?user_id=eq.${encodeURIComponent(draft.userId)}&eligible=eq.true&consumed_at=is.null&select=user_id&limit=1`).catch(() => []),
    wallet.getBalanceKopecks(draft.userId),
  ]);
  if (packageInfo) {
    draft.accessCode = packageInfo.packageCode;
    draft.packageRemaining = packageInfo.remaining;
  }
  const discounted = discounts.length > 0;
  draft.discountAvailable = discounted;
  // Цены в копейках — те же, что в SQL reserve_sticker_generation (менять вместе).
  const prices = discounted ? GENERATION_DISCOUNT_PRICES : GENERATION_PRICES;
  draft.walletCost = (draft.mode === 'range' ? prices.batch : prices.custom) / 100;
  draft.balanceKopecks = balanceKopecks;
  await renderWizard(from, chatId, 'confirm', draft, messageId);
}

/**
 * Свой активный код доступа — на него докупаем генерации с баланса, чтобы не плодить коды. Месячный код тарифа «Про»
 * (app_subscription_id) не годится: в конце окна подписки он выключается, и докупленное пропало бы вместе с ним.
 */
async function ownTopupCode(userId, mode = 'custom') {
  const rows = await supabaseFetch(`sticker_access_codes?owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&app_subscription_id=is.null&or=(generation_mode.eq.${mode},generation_mode.is.null)&select=code,generation_mode&order=created_at.desc&limit=1`);
  return rows[0]?.code || null;
}

/** Купить с баланса ровно нужное число генераций; возвращает код, на который они легли. */
async function buyGenerationsWithWallet(draft) {
  const reserve = () => reserveGeneration({
    userId: draft.userId,
    requestKey: draft.billingRequestKey,
    mode: draft.mode === 'range' ? 'batch' : 'custom',
    category: draft.category === 'box' ? 'box' : 'product',
  });
  try {
    let charge = await reserve();
    // Тот же ключ уже был зарезервирован и возвращён (например, при ограничении «Покупки» резерв сразу
    // возвращается, а запрос мастера освобождается). Повтор «Подтвердить» на том же сообщении получил бы
    // этот возвращённый резерв и упал на списании — резервируем заново под новым ключом.
    if (charge?.duplicate && charge.status === 'refunded') {
      draft.billingRequestKey = `${draft.billingRequestKey}:r${crypto.randomBytes(4).toString('hex')}`;
      charge = await reserve();
    }
    return { ok: true, charge };
  } catch (error) {
    if (error.code === 'INSUFFICIENT_BALANCE') {
      return { ok: false, error: 'INSUFFICIENT', balanceKopecks: await wallet.getBalanceKopecks(draft.userId) };
    }
    throw error;
  }
}

function absoluteAssetUrl(relative, png = false, style = 'old') {
  const params = [png ? 'format=png' : '', style === 'new' ? 'style=new' : ''].filter(Boolean).join('&');
  const suffix = params ? `${relative.includes('?') ? '&' : '?'}${params}` : '';
  return publicUrl(`${relative}${suffix}`);
}

function resultItems(result) {
  return result.items || (result.imageUrl ? [{ code: result.code, imageUrl: result.imageUrl }] : []);
}

/**
 * Результат для повторной выдачи: у стикера по номеру ссылки подписаны на час (server/_sticker-generation.js),
 * к смене вида или «прислать ещё раз» они уже просрочены — подписываем заново тем же форматом. У пачки ссылки
 * идут по id пачки и не истекают.
 */
function freshResult(result) {
  if (!result || result.items || !result.code) return result;
  const boxMode = result.variant === 'box';
  return { ...result, ...customStickerLinks(String(result.code), { boxMode, prefix: result.prefix || 'TRBX' }) };
}

/** Листание предпросмотра — только когда страниц больше одной (сейчас стикер по номеру всегда один). */
function pageKeyboard(requestId, page, totalPages, style = 'old') {
  const row = [];
  if (page > 0) row.push({ text: '⬅️ Предыдущие', callback_data: `gen:page:${style}:${requestId}:${page - 1}` });
  if (page + 1 < totalPages) row.push({ text: 'Следующие ➡️', callback_data: `gen:page:${style}:${requestId}:${page + 1}` });
  return choiceKeyboard([row, MENU_ROW].filter(items => items.length));
}

/**
 * Кнопки под готовым файлом — на самом PDF, последнем сообщении: смена вида (у QR коробок вид один — кнопки нет),
 * «ещё один по номеру» сразу на ввод номера того же типа, меню.
 */
function resultKeyboard(requestId, result, style = 'old') {
  const rows = [];
  if (result.variant !== 'box') {
    rows.push([{ text: style === 'new' ? '🔁 Обычный вид' : '🔁 Новый вид (QR по углам)', callback_data: `gen:format:${style === 'new' ? 'old' : 'new'}:${requestId}` }]);
  }
  const again = Number(result.quantity || 1) === BATCH_QUANTITY
    ? { text: '➕ Создать ещё', callback_data: 'gen:start' }
    : { text: '➕ Ещё один по номеру', callback_data: `gen:again:${result.variant === 'box' ? 'box' : 'product'}` };
  rows.push([again, ...MENU_ROW]);
  return choiceKeyboard(rows);
}

/** Подпись к повторной выдаче: тот же результат, денег второй раз не берём — и слова «Списано» в ней нет. */
function repeatCaption(result, style) {
  if (result.variant === 'box') return 'Тот же QR коробки ещё раз. Повторно ничего не списано.';
  const what = Number(result.quantity || 1) === BATCH_QUANTITY ? `Те же ${BATCH_QUANTITY} стикеров` : 'Тот же стикер';
  return `${what} — ${style === 'new' ? 'новый вид, с QR по углам' : 'обычный вид'}. Повторно ничего не списано.`;
}

async function localStickerPng(code, style) {
  const { Resvg } = require('@resvg/resvg-js');
  const svg = style === 'new' ? await newStickerSvg(code) : await stickerSvg(code);
  const renderer = new Resvg(svg, {
    font: { fontFiles: [path.join(process.cwd(), 'server', 'assets', 'InterVariable.ttf')], loadSystemFonts: false, defaultFontFamily: 'Inter' },
  });
  return Buffer.from(renderer.render().asPng());
}

async function localStickerPdf(result, style) {
  const { buildStickerPdf } = require('../api/stickers/pdf');
  return buildStickerPdf(resultItems(result).map(item => ({ code: String(item.code) })), { style });
}

async function sendPreview(chatId, requestId, result, page = 0, style = 'old') {
  const items = resultItems(result), totalPages = Math.ceil(items.length / 4), safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageItems = items.slice(safePage * 4, safePage * 4 + 4);
  if (process.env.TELEGRAM_LOCAL_POLLING === '1' && result.variant !== 'box') {
    for (const item of pageItems) await sendPhoto(chatId, { buffer: await localStickerPng(item.code, style), filename: `sticker-${item.code}-${style}.png` });
  } else {
    const urls = pageItems.map(item => absoluteAssetUrl(item.imageUrl, true, style));
    if (urls.length === 1) await sendPhoto(chatId, urls[0]);
    else if (urls.length > 1) await sendMediaGroup(chatId, urls);
  }
  // «Предпросмотр 1 из 1» ничего не сообщал, а главные кнопки висели на нём — счётчик только для нескольких страниц.
  if (totalPages > 1) await sendMessage(chatId, `Страница ${safePage + 1} из ${totalPages}`, { reply_markup: pageKeyboard(requestId, safePage, totalPages, style) });
}

/** Картинка (кроме пачки) и PDF; кнопки — на PDF. caption — подпись к PDF (первая выдача или повтор). */
async function deliverGeneration(chatId, requestId, result, style = 'old', caption = null) {
  const fresh = freshResult(result);
  if (Number(fresh.quantity || 1) !== BATCH_QUANTITY) await sendPreview(chatId, requestId, fresh, 0, style);
  const document = process.env.TELEGRAM_LOCAL_POLLING === '1' && fresh.variant !== 'box'
    ? { buffer: await localStickerPdf(fresh, style), filename: `stickers-${style}.pdf` }
    : absoluteAssetUrl(fresh.pdfUrl, false, style);
  await sendDocument(chatId, document, { caption: caption || fresh.botCaption || `Готово: ${fresh.quantity || 1} шт.`, reply_markup: resultKeyboard(requestId, fresh, style) });
}

/** Файл не ушёл в Telegram: ссылка на PDF и повтор той же выдачи (повтор переподписывает ссылки). */
function deliveryFailedView(requestId, result, style = 'old') {
  const fresh = freshResult(result);
  return {
    text: `Стикеры созданы (${fresh.quantity || 1} шт.), но Telegram не принял файл. Скачайте PDF по кнопке или пришлите файл ещё раз — повторно платить не нужно.`,
    reply_markup: choiceKeyboard([
      [{ text: '📄 Скачать PDF', url: absoluteAssetUrl(fresh.pdfUrl, false, style) }],
      [{ text: '🔄 Прислать файл ещё раз', callback_data: `gen:format:${style}:${requestId}` }],
      MENU_ROW,
    ]),
  };
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
  return runGeneration(callback.from, callback.message.chat.id, callback.message.message_id, session, {
    onDuplicate: () => answerCallbackQuery(callback.id, 'Этот запрос уже обработан'),
  });
}

/** Подпись к PDF при первой выдаче: что создано и что списано (из пакета или с баланса). */
function generationCaption(draft, charge) {
  const noun = kindNoun(draft.category), units = requiredUnits(draft);
  const what = draft.mode === 'range' ? `${BATCH_QUANTITY} ${noun.many} одним файлом` : `1 ${noun.one} (${draft.code})`;
  const paid = charge.paymentSource === 'package'
    ? `Списано из пакета: ${units} шт., в пакете осталось ${Number(charge.packageRemaining || 0)}.`
    : `Списано ${wallet.formatRub(charge.priceKopecks / 100)}${charge.discountApplied ? ` со скидкой ${GENERATION_DISCOUNT_PERCENT}%` : ''}, на балансе ${wallet.formatRub(charge.balanceKopecks / 100)}.`;
  const hint = draft.category === 'box' ? '' : '\nНужен новый вид — с маленькими QR по углам? Нажмите «🔁 Новый вид», пришлю без доплаты.';
  return `Готово: ${what}. ${paid}${hint}`;
}

/** Что сказать о деньгах, когда стикер не создан: по источнику оплаты и по тому, прошёл ли возврат. */
function refundLine(charge, refunded) {
  // Сам по себе резерв не возвращается: его вернёт следующее создание стикера, начатое через 5 минут
  // (reserve_sticker_generation), или поддержка.
  if (!refunded) {
    const what = charge?.paymentSource === 'package' ? ['стикер в пакет', 'Он вернётся сам'] : ['деньги', 'Они вернутся сами'];
    return `Вернуть ${what[0]} сразу не получилось. ${what[1]}, когда вы создадите следующий стикер — но не раньше чем через 5 минут. Или напишите в поддержку и назовите код ниже.`;
  }
  if (charge?.paymentSource === 'package') return 'Деньги не потеряны: стикер вернулся в ваш пакет.';
  return `Деньги не потеряны: ${wallet.formatRub(Number(charge?.priceKopecks || 0) / 100)} вернулись на баланс.`;
}

/**
 * Генерация по подтверждённому черновику: по кнопке «Создать» или сама после пополнения баланса.
 * noticeId — сообщение «Баланс пополнен…» внизу чата (автопокупка): ход и итог показываем в нём, а прежний экран
 * мастера выше (там висела ссылка на оплату) превращаем в «итог ниже». Ключ запроса — по прежнему экрану:
 * нажатие «Создать» там и автопокупка не создадут стикер дважды.
 */
async function runGeneration(from, chatId, messageId, session, { onDuplicate = async () => {}, noticeId = null } = {}) {
  const draft = session.draft || {};
  // Сообщение мастера переиспользуется между генерациями, поэтому к его id добавлена метка
  // этого запуска мастера (draft.nonce): двойной клик по «Подтвердить» по-прежнему отсекается.
  const requestId = `${from.id}:${messageId}${draft.nonce || ''}`;
  if (!await claimGenerationRequest(requestId, from, chatId, draft)) { await onDuplicate(); return; }
  const screenId = noticeId || messageId;
  const lead = noticeId ? '<b>Баланс пополнен ✅</b>\n' : '';
  if (noticeId && messageId && noticeId !== messageId) {
    await editMessageText(chatId, messageId, 'Баланс пополнен — итог ниже ⬇️').catch(() => {});
    draft.msgId = noticeId;
  }
  const releaseRequest = () => supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}`, { method: 'DELETE' }).catch(() => {});
  draft.billingRequestKey = `telegram:${requestId}`;
  let bought;
  try {
    bought = await buyGenerationsWithWallet(draft);
  } catch (error) {
    await releaseRequest();
    // Предыдущий стикер ещё создаётся (резерв держится до 5 минут) или резерв не прошёл — деньги не списаны.
    const busy = { GENERATION_BUSY: 'Предыдущий стикер ещё создаётся. Подождите несколько минут и нажмите «Создать» ещё раз — деньги сейчас не списаны.', BILLING_ERROR: 'Не получилось провести оплату — деньги не списаны. Попробуйте ещё раз через минуту.' }[error?.code];
    if (!busy) throw error;
    delete draft.billingRequestKey;
    draft.error = busy;
    await renderWizard(from, chatId, 'confirm', draft, screenId);
    return;
  }
  if (!bought.ok) {
    // Деньги не списаны: освобождаем запрос, чтобы после пополнения можно было нажать «Создать» снова.
    await releaseRequest();
    delete draft.billingRequestKey;
    draft.balanceKopecks = bought.balanceKopecks;
    draft.error = 'Денег на балансе не хватает.';
    await renderWizard(from, chatId, 'confirm', draft, screenId);
    return;
  }
  draft.chargeId = bought.charge.chargeId;
  await saveSession(from, chatId, 'generating', draft);
  await showScreen(chatId, screenId, `${lead}${wizardTrail(draft)}⏳ Создаю ${draft.mode === 'range' ? 'стикеры' : kindNoun(draft.category).one} и PDF…`);
  let result;
  let failure = null, refunded = true;
  try {
    const requesterHash = telegramRequesterHash(from.id);
    result = await generateStickers({ ...draft, quantity: draft.mode === 'range' ? BATCH_QUANTITY : 1, requesterHash, clientEntryId: `telegram:${requestId}`, channel: 'telegram' });
    result = { ...result, priceKopecks: bought.charge.priceKopecks, discountApplied: bought.charge.discountApplied, balanceKopecks: bought.charge.balanceKopecks };
    result.botCaption = generationCaption(draft, bought.charge);
    await finalizeGeneration(draft.chargeId, result);
  } catch (error) {
    // Возврат считается состоявшимся только по ответу ok. ALREADY_FINISHED — списание уже окончательное:
    // finalize прошёл, а его ответ потерялся по дороге. Стикер тогда есть и оплачен — выдаём, а не «возвращаем».
    const refund = draft.chargeId ? await refundGeneration(draft.chargeId).catch(() => null) : { ok: true };
    if (!(result && refund?.code === 'ALREADY_FINISHED')) {
      failure = error;
      refunded = refund?.ok === true;
    }
  }
  if (failure) {
    const error = failure;
    await supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', error: String(error.message || '').slice(0, 500), completed_at: new Date().toISOString() }) }).catch(() => {});
    const incident = crypto.randomBytes(3).toString('hex');
    console.error(`Telegram sticker generation failed [${incident}]`, error.code || '', error.message);
    // «Повторить» — снова подтверждение с тем же черновиком. Новый nonce: этот requestId уже занят записью failed,
    // и повтор в том же сообщении получил бы «Этот запрос уже обработан».
    for (const key of ['chargeId', 'billingRequestKey', 'error']) delete draft[key];
    draft.nonce = wizardNonce();
    draft.msgId = screenId;
    await saveSession(from, chatId, 'confirm', draft).catch(() => clearSession(from.id).catch(() => {}));
    const reason = error?.code === 'POOL_EMPTY'
      ? `Сейчас закончились свободные номера для пачки — ${draft.category === 'box' ? 'QR коробок' : 'стикеры'} не созданы.`
      : `Не получилось создать ${draft.mode === 'range' ? 'стикеры' : kindNoun(draft.category).one} — ошибка на нашей стороне.`;
    // Возврат не прошёл — резерв держится, и «Повторить» раньше чем через 5 минут ответит «предыдущий ещё создаётся».
    const next = !refunded
      ? `Код ошибки: <code>${incident}</code>`
      : error?.code === 'POOL_EMPTY'
        ? 'Попробуйте позже или сделайте один по своему номеру.'
        : `Попробуйте ещё раз. Если повторится — напишите в поддержку, код ошибки: <code>${incident}</code>`;
    await showScreen(chatId, screenId, [`${lead}${wizardTrail(draft)}${reason}`, refundLine(bought.charge, refunded), next].join('\n'), { reply_markup: choiceKeyboard([
      [{ text: '🔄 Повторить', callback_data: 'gen:recheck' }],
      [{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }],
      MENU_ROW,
    ]) }).catch(() => {});
    return;
  }
  // Деньги списаны окончательно, стикер есть — сбой записи о выдаче или сессии не должен превращаться в «ошибку
  // и возврат»: такой возврат не прошёл бы (ALREADY_FINISHED), а «Повторить» списал бы второй раз.
  await completeGenerationRequest(requestId, result)
    .catch(() => completeGenerationRequest(requestId, result))
    .catch(error => console.warn('Telegram sticker request not marked completed', requestId, error.message));
  await clearSession(from.id).catch(error => console.warn('Telegram sticker session not cleared', error.message));
  // Файл должен прийти сразу после списания. Для товарных стикеров отправляем
  // прежний вид по умолчанию, а новый остаётся доступен кнопкой под PDF.
  try {
    await deliverGeneration(chatId, requestId, result, 'old');
  } catch (error) {
    console.warn('Telegram sticker delivery failed', error.message);
    const view = deliveryFailedView(requestId, result);
    await showScreen(chatId, screenId, `${lead}${view.text}`, { reply_markup: view.reply_markup }).catch(() => {});
    return;
  }
  // Экран мастера — в итог, а не вечное «⏳ Создаю…»: всё нужное (файл и кнопки) — ниже.
  await showScreen(chatId, screenId, `${lead}${wizardTrail(draft)}✅ Готово. Файл — ниже.`).catch(() => {});
  if (result.variant !== 'box') return;
  // Мягкая подсказка про «Код клиента» — не после каждого QR коробки, примерно после каждого третьего.
  if (Math.random() < 1 / 3) {
    const charge = await nextClientCharge(from, draft.userId || await findUser(from.id).catch(() => null)).catch(() => null);
    const cost = charge ? ` — ${approvals.chargeLabel(charge)}` : '';
    await sendMessage(chatId, `💡 Клиент пришёл без своего QR? Найду его по ячейке или телефону и пришлю QR сюда${cost}.`, { reply_markup: choiceKeyboard([[{ text: `🔑 Код клиента${cost}`, callback_data: 'menu:code' }]]) }).catch(() => {});
  }
}

function wizardNonce() { return String(crypto.randomInt(100000, 1000000)); }

/** messageId — сообщение, которое превращается в мастер (например, главное меню). Без него — новое сообщение. */
async function startGeneration(from, chatId, messageId) {
  const userId = await ensureUser(from);
  await renderWizard(from, chatId, 'choose_kind', { userId, nonce: wizardNonce() }, messageId);
}

async function startForCategory(from, chatId, category) {
  const userId = await ensureUser(from);
  await renderChooseMode(from, chatId, { userId, category, nonce: wizardNonce() });
}

/** «➕ Ещё один по номеру» под готовым файлом: сразу ввод номера того же типа, новым сообщением внизу. */
async function startAgainByNumber(from, chatId, category) {
  const userId = await ensureUser(from);
  const draft = { userId, category, mode: 'custom', nonce: wizardNonce(), ...(category === 'box' ? { prefix: 'TRBX' } : {}) };
  await renderWizard(from, chatId, 'await_code', draft);
}

/** Стикер (или QR коробки) по уже известному номеру — с фото или из сообщения: сразу на подтверждение. */
async function startWithCode(from, chatId, code, messageId, category = 'product') {
  const userId = await ensureUser(from);
  const draft = { userId, category, mode: 'custom', code, nonce: wizardNonce(), ...(category === 'box' ? { prefix: 'TRBX' } : {}) };
  await requestConfirmation(from, chatId, draft, messageId);
}

// ── ШК с фото: скриншот WB Point или фото экрана WB-PVZ (распознавание — server/_shk-vision.js) ──
const PHOTO_COOLDOWN_MS = 10_000;
const lastPhotoAt = new Map();

/** Не чаще одного фото в 10 с: OCR грузит сервер, а серия фото подряд — обычно случайность. */
function photoTooOften(telegramId) {
  const now = Date.now(), key = Number(telegramId);
  if (now - (lastPhotoAt.get(key) || 0) < PHOTO_COOLDOWN_MS) return true;
  if (lastPhotoAt.size > 5000) lastPhotoAt.clear();
  lastPhotoAt.set(key, now);
  return false;
}

/** Номера с картинки; null — не удалось скачать или распознать (это не то же, что «номера нет»). */
async function shkFromImage(image, length) {
  try {
    const buffer = await downloadFile(image.fileId, { maxBytes: shkVision.MAX_IMAGE_BYTES });
    return await shkVision.recognizeShk(buffer, { length });
  } catch (error) {
    console.warn('ШК с фото: не распознано', error?.message || error);
    return null;
  }
}

function photoFailText(codes, length) {
  return codes
    ? `Не нашёл на фото номер из ${length} цифр. Пришлите номер цифрами или более чёткий снимок, где номер виден целиком.`
    : 'Не получилось прочитать фото. Пришлите номер цифрами или другой снимок.';
}

/** Фото в шаге «По номеру»: один номер — сразу подтверждение, несколько — выбор кнопкой. */
async function acceptWizardPhoto(from, chatId, draft, message, image) {
  await deleteMessage(chatId, message.message_id).catch(() => {});
  const length = draft.category === 'box' ? 10 : 11;
  delete draft.photoCodes;
  delete draft.pickFromText;
  if (photoTooOften(from.id)) { draft.error = 'Читаю по одному фото за раз. Пришлите следующее через 10 секунд.'; return renderWizard(from, chatId, 'await_code', draft); }
  // Статус — новым сообщением внизу (фото человека только что ушло вниз), прежний экран мастера убираем;
  // дальше правим уже статус.
  const previousId = draft.msgId;
  const status = await sendMessage(chatId, `${wizardTrail(draft)}🔍 Читаю номер с фото…`);
  draft.msgId = status?.message_id || null;
  if (previousId && previousId !== draft.msgId) await retireMessage(chatId, previousId);
  const codes = await shkFromImage(image, length);
  if (!codes?.length) { draft.error = photoFailText(codes, length); return renderWizard(from, chatId, 'await_code', draft, draft.msgId); }
  if (codes.length > 1) { draft.photoCodes = codes; return renderWizard(from, chatId, 'await_code', draft, draft.msgId); }
  draft.code = codes[0];
  return requestConfirmation(from, chatId, draft, draft.msgId);
}

// Когда последний раз ответили «читаю по одному фото»: на серию фото (альбом) — одно предупреждение, а не девять.
const photoWarnedAt = new Map();

function shouldWarnPhoto(telegramId, now = Date.now()) {
  const key = Number(telegramId);
  if (now - (photoWarnedAt.get(key) || 0) < PHOTO_COOLDOWN_MS) return false;
  if (photoWarnedAt.size > 5000) photoWarnedAt.clear();
  photoWarnedAt.set(key, now);
  return true;
}

/** Фото вне мастера: нашли ШК — предлагаем стикер по нему. */
async function acceptLoosePhoto(from, chatId, image) {
  if (photoTooOften(from.id)) {
    // Раньше второе фото подряд оставалось без ответа — человек думал, что бот завис или сделает стикеры по всем.
    if (shouldWarnPhoto(from.id)) await sendMessage(chatId, 'Читаю по одному фото за раз. Дождитесь ответа по первому и пришлите следующее.');
    return;
  }
  const status = await sendMessage(chatId, '🔍 Читаю номер ШК с фото…');
  const codes = await shkFromImage(image, 11);
  if (!codes?.length) {
    await showScreen(chatId, status?.message_id, photoFailText(codes, 11), { reply_markup: choiceKeyboard([[{ text: '🏷 Стикеры и QR', callback_data: 'menu:stickers' }], MENU_ROW]) });
    return;
  }
  const text = codes.length === 1
    ? `Нашёл ШК <code>${codes[0]}</code>. Сделать стикер?`
    : '<b>На фото несколько номеров ШК</b>\nДля какого сделать стикер?';
  const rows = codes.map(code => [{ text: `🏷 Стикер ${code}`, callback_data: `gen:num:${code}` }]);
  rows.push(MENU_ROW);
  await showScreen(chatId, status?.message_id, text, { reply_markup: choiceKeyboard(rows) });
}

/** Куда направить фото с учётом того, какой ввод сейчас ждёт бот. */
async function handlePhoto(from, chatId, message, image, session) {
  if (session?.state === 'await_code') return acceptWizardPhoto(from, chatId, session.draft || {}, message, image);
  if (session?.state === 'generating') return sendMessage(chatId, '⏳ Создаю стикеры — подождите немного.');
  const waiting = { await_access_code: 'код доступа', await_topup_amount: 'сумму пополнения', await_client_query: 'номер ячейки или телефон' }[session?.state];
  const wb = waiting ? null : await getWbConnection(from.id);
  const wbWaiting = wb?.state === 'await_phone' ? 'номер телефона для входа в WB' : wb?.state === 'await_code' ? 'код от WB' : null;
  if (waiting || wbWaiting) return sendMessage(chatId, `Сейчас жду ${waiting || wbWaiting} цифрами — фото здесь не подойдёт. /cancel — отменить.`);
  return acceptLoosePhoto(from, chatId, image);
}

/**
 * Голый номер без команды: 11 цифр — может быть ШК товара, 10 — номер возвратной коробки, 7–12 — ID клиента.
 * Ни одна кнопка здесь не списывает сразу: стикер и QR коробки идут через подтверждение мастера, QR клиента —
 * через своё подтверждение с ценой (code:ask). Раньше «QR клиента» списывал 50 ₽ сразу, а для 10 цифр был
 * единственной кнопкой — человек, делавший QR коробки, платил за ненужный QR.
 */
async function offerForNumber(from, chatId, digits) {
  // Цена стикера — как на выборе режима мастера: со скидкой 20% или «из пакета», если пакет есть.
  const [charge, stickerPrices] = await Promise.all([
    findUser(from.id).catch(() => null).then(userId => nextClientCharge(from, userId)),
    digits.length === 10 || digits.length === 11
      ? ensureUser(from).then(wizardPrices).catch(() => null)
      : null,
  ]);
  const sticker = Number(stickerPrices?.packageLeft || 0) > 0 ? 'из пакета' : wallet.formatRub(Number(stickerPrices?.custom ?? GENERATION_PRICES.custom) / 100);
  const qr = approvals.chargeLabel(charge);
  const rows = [], lines = [`Вы прислали номер <code>${digits}</code>. Что с ним сделать?`];
  if (digits.length === 11) {
    rows.push([{ text: `🏷 Стикер товара — ${sticker}`, callback_data: `gen:num:${digits}` }]);
    lines.push(`🏷 Стикер товара — если это ШК товара (11 цифр), ${sticker}`);
  }
  if (digits.length === 10) {
    rows.push([{ text: `📦 QR коробки — ${sticker}`, callback_data: `gen:box:${digits}` }]);
    lines.push(`📦 QR коробки — если это номер возвратной коробки (10 цифр), ${sticker}`);
  }
  rows.push([{ text: `🔑 QR клиента — ${qr}`, callback_data: `code:ask:${digits}` }]);
  lines.push(`🔑 QR клиента — если это ID клиента, ${qr}`);
  lines.push('Деньги спишутся только после подтверждения.');
  rows.push(MENU_ROW);
  await sendMessage(chatId, lines.join('\n'), { reply_markup: choiceKeyboard(rows) });
}

/** Подтверждение QR клиента по голому номеру: что спишется и сколько останется. Сама выдача — code:ok. */
async function askClientCodeConfirm(from, chatId, messageId, sid) {
  const rows = [[{ text: '✖️ Отмена', callback_data: 'menu:home' }]];
  const lines = ['<b>🔑 QR клиента</b>', `ID клиента: <code>${sid}</code>`];
  if (clientCodeFreeFor(from.id)) {
    lines.push(unlimitedLine(from.id));
    return showScreen(chatId, messageId, lines.join('\n'), { reply_markup: choiceKeyboard([[{ text: '✅ Выдать QR', callback_data: `code:ok:${sid}` }], ...rows]) });
  }
  const charge = await nextClientCharge(from, await ensureUser(from));
  lines.push(approvals.chargeLine(charge));
  if (charge.kind !== 'free') lines.push(REPEAT_PAID_LINE);
  const button = charge.kind === 'free' ? '✅ Выдать QR' : `✅ Выдать QR — ${approvals.chargeLabel(charge)}`;
  return showScreen(chatId, messageId, lines.join('\n'), { reply_markup: choiceKeyboard([[{ text: button, callback_data: `code:ok:${sid}` }], ...rows]) });
}

/** Всплывашка на повторное нажатие кнопки выдачи: по сохранённому исходу первого нажатия. */
async function duplicateQrNotice(requestId, from, sentText) {
  const result = await loadGenerationRequest(requestId, from.id).catch(() => null);
  if (result?.outcome === 'charged_unsent') return 'Код уже списан, но QR не дошёл — нажмите «🔁 Отправить ещё раз» в сообщении ниже или напишите в поддержку.';
  return sentText;
}

/** Снять отметку нажатия: QR не выдан и ничего не списано — ту же кнопку можно нажать снова. */
function releaseRequest(requestId) {
  return supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}`, { method: 'DELETE' }).catch(() => {});
}

/**
 * Выдача QR по кнопке с отметкой нажатия: двойной клик или медленная сеть не спишут дважды. Отметка остаётся,
 * если QR ушёл или списание прошло (повтор той же кнопки ответит «уже выдан»); нехватка денег и возврат её снимают.
 * onClaimed — после отметки, до выдачи (ответить на нажатие, показать «Готовлю QR…»).
 * → исход handleClientCode или 'duplicate'.
 */
async function issueClientQrOnce(from, chatId, requestId, sid, options = {}, onClaimed = async () => {}) {
  const userId = await ensureUser(from);
  if (!await claimGenerationRequest(requestId, from, chatId, { userId, sid })) return 'duplicate';
  let outcome;
  await onClaimed();
  try {
    outcome = await handleClientCode(from, chatId, sid, options);
  } catch (error) {
    await releaseRequest(requestId);
    throw error;
  }
  if (outcome === 'not_sent') await releaseRequest(requestId);
  else await completeGenerationRequest(requestId, { sid, outcome }).catch(() => {});
  return outcome;
}

/**
 * «Выдать QR» с экрана подтверждения. Одно подтверждение — одна выдача: повторное нажатие той же кнопки
 * (двойной клик, медленная сеть) отсекается записью запроса по id этого сообщения.
 */
async function confirmClientCodeFromNumber(from, chatId, messageId, callbackId, sid) {
  const title = `<b>🔑 QR клиента</b>\nID клиента: <code>${sid}</code>`;
  const requestId = `qr:${from.id}:${messageId}`;
  let outcome;
  try {
    outcome = await issueClientQrOnce(from, chatId, requestId, sid, {}, async () => {
      answerCallbackQuery(callbackId).catch(() => {});
      await showScreen(chatId, messageId, `${title}\n⏳ Готовлю QR…`);
    });
  } catch (error) {
    await showScreen(chatId, messageId, title, { reply_markup: choiceKeyboard([[{ text: '🔄 Попробовать ещё раз', callback_data: `code:ok:${sid}` }], MENU_ROW]) }).catch(() => {});
    throw error;
  }
  if (outcome === 'duplicate') {
    await answerCallbackQuery(callbackId, await duplicateQrNotice(requestId, from, 'Этот QR уже выдан — он ниже в чате.'), { alert: true });
    return;
  }
  await showScreen(chatId, messageId, `${title} — итог ниже ⬇️`).catch(() => {});
}

/**
 * Кнопка «QR · яч. 245 · …98» в результатах поиска (и «Попробовать ещё раз» после сбоя): отметка нажатия —
 * по сообщению с кнопкой и ID, чтобы двойной клик не списал дважды.
 */
async function pressClientQr(from, chatId, messageId, callbackId, sid, cell) {
  if (!messageId) { answerCallbackQuery(callbackId).catch(() => {}); await handleClientCode(from, chatId, sid, { cell }); return; }
  const requestId = `qrs:${from.id}:${messageId}:${sid}`;
  const outcome = await issueClientQrOnce(from, chatId, requestId, sid, { cell }, async () => {
    answerCallbackQuery(callbackId, 'Готовлю QR…').catch(() => {});
  });
  if (outcome === 'duplicate') {
    await answerCallbackQuery(callbackId, await duplicateQrNotice(requestId, from, 'Этот QR уже выдан по этой кнопке — он ниже в чате. Нужен ещё раз — отправьте ячейку или телефон снова (спишется ещё раз).'), { alert: true });
  }
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
  const userId = await ensureUser(from);
  const id = encodeURIComponent(userId);
  const [codes, balance, ent, cellKeys, free, orders] = await Promise.all([
    supabaseFetch(`sticker_access_codes?owner_user_id=eq.${id}&active=eq.true&select=generation_limit,generation_used`),
    walletRub(userId).catch(() => 0),
    supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) }).catch(() => null),
    ownCellKeys(userId).catch(() => []),
    helperFreeText(),
    // Индивидуальные заказы — редкость: кнопка «Мои заказы» только у тех, у кого они есть. Сбой — без кнопки.
    supabaseFetch(`individual_sticker_orders?user_id=eq.${id}&select=id&limit=1`).catch(() => []),
  ]);
  const stickers = codes.reduce((sum, row) => sum + remainingOf(row), 0);
  const clientCodes = Number(ent?.packs_left || 0);
  const text = [
    '<b>👤 Профиль</b>',
    `💰 На балансе: <b>${wallet.formatRub(balance)}</b>`,
    // Остатки пакетов — только если есть: кто работает в боте, обходится балансом.
    ...(stickers ? [`🏷 Стикеры в пакете: ${stickers.toLocaleString('ru-RU')} шт.`] : []),
    ...(clientCodes > 0 ? [`🔑 Коды клиента в пакете: ${clientCodes.toLocaleString('ru-RU')}`] : []),
    '',
    '<b>Программы для компьютера</b>',
    `🖥 Помощник ПВЗ: ${helperStatusLine(ent, free)}`,
    `🖨 ПВЗ Принт (печать ячеек): ${cellPrintStatusLine(cellKeys)}`,
    // Ключ виден здесь всегда — сообщение с покупкой могло потеряться; нажатие на <code> копирует ключ.
    ...cellKeys.slice(0, 3).map(key => `   ${cellKeyLine(key)}`),
    '',
    `Ваш ID: <code>${Number(from.id)}</code> — назовите его поддержке.`,
  ].join('\n');
  const screenId = await showScreen(chatId, messageId, text, { reply_markup: profileKeyboard({ orders: Array.isArray(orders) && orders.length > 0 }) });
  rememberTopupOrigin(from.id, screenId, 'menu:profile');
}

/**
 * «🆘 Помощь» — справка и поддержка на одном экране: как пользоваться (с ценами из констант и скидкой клуба),
 * что прислать поддержке, Telegram ID для копирования, связка с покупками на сайте; канал и VPN — кнопками.
 */
async function helpText(from) {
  const [{ price: codePrice }, { price: authorPrice }] = await Promise.all([
    clientCodePrice(from?.id).catch(() => ({ price: CLIENT_CODE_PRICE })),
    reviewPrice(from?.id).catch(() => ({ price: REVIEW_PRICE })),
  ]);
  const custom = wallet.formatRub(GENERATION_PRICES.custom / 100), batch = wallet.formatRub(GENERATION_PRICES.batch / 100);
  return [
    '<b>🆘 Помощь и поддержка</b>',
    '',
    `🏷 <b>Стикеры.</b> «По номеру» — стикер для вашего ШК (11 цифр с этикетки товара), ${custom}: пришлите номер или фото/скриншот, где он виден. «Пачка ${BATCH_QUANTITY}» — ${BATCH_QUANTITY} новых стикеров одним PDF, ${batch}.`,
    '📦 <b>QR коробки</b> — те же цены, номер коробки — 10 цифр.',
    `🔑 <b>Код клиента.</b> Напишите «Код» и ID клиента, например <code>Код 191607973</code>, — пришлю QR. Спишется 1 код из тарифа «Помощника ПВЗ», а без него — ${wallet.formatRub(codePrice)}. Не знаете ID — найду клиента по ячейке или телефону (нужен вход в WB по номеру телефона).`,
    `⭐ <b>Отзывы ПВЗ.</b> После входа в WB смотреть бесплатно. «Кто поставил оценку» — ${wallet.formatRub(authorPrice)}, того же клиента повторно — бесплатно.`,
    `💰 <b>Оплата</b> — с баланса бота: «👤 Профиль и баланс» → «💰 Пополнить баланс», от ${wallet.formatRub(wallet.MIN_TOPUP)}.`,
    '↩️ Передумали — «☰ Меню» или /cancel.',
    '',
    '<b>Нужен человек?</b> Кнопка ниже откроет чат с поддержкой. Пришлите скриншот, код ошибки (если я его показал)'
      + (from?.id ? ` и ваш ID: <code>${Number(from.id)}</code> (нажмите, чтобы скопировать).` : '.'),
    'Покупали на сайте shk-wb.ru? Напишите — свяжем сайт с ботом, баланс и покупки станут общими.',
  ].join('\n');
}

async function showHelp(from, chatId, messageId) {
  await showScreen(chatId, messageId, await helpText(from), { reply_markup: choiceKeyboard([
    [{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }],
    [{ text: '📣 Канал', url: CHANNEL_URL }, { text: '🛡 Наш VPN', url: VPN_URL }],
    MENU_ROW,
  ]) });
}

function reviewFilterKeyboard() {
  return choiceKeyboard([
    [1, 2, 3, 4, 5].map(star => ({ text: `${star} ⭐`, callback_data: `rv:filter:${star}` })),
    [{ text: 'Все оценки', callback_data: 'rv:filter:all' }],
    [{ text: '💰 Пополнить баланс', callback_data: 'topup:home' }],
    [{ text: '🔁 Сменить ПВЗ', callback_data: 'rv:points' }, ...MENU_ROW],
    // Выход — отдельным рядом и с подтверждением (rv:logout): промах по кнопке не стирает вход.
    [{ text: '🚪 Выйти из WB', callback_data: 'rv:logout' }],
  ]);
}

// ── Вход в WB: один текст для отзывов и поиска клиента, шаг кода, ошибки WB ──

// «Выслать код заново» — не чаще раза в 30 секунд на человека (WB и сам ограничивает частые запросы).
const WB_RESEND_COOLDOWN_MS = 30 * 1000;
const wbResendAt = new Map();

/** Последние 4 цифры номера: полный номер в чат не возвращаем — сообщение с ним бот удалил. */
function phoneTail(phone) { return String(phone || '').replace(/\D/g, '').slice(-4); }

/**
 * Первый шаг входа в WB: зачем вход, чей номер, что придёт и что хранится. purpose — 'reviews' | 'search';
 * notice — строка сверху (например, «вход устарел»). Цена «Кто поставил» — только для отзывов.
 */
async function wbLoginPromptText(from, purpose, notice = '') {
  const search = purpose === 'search';
  let priceLine = '';
  if (!search && reviewFreeFor(from.id)) priceLine = `Смотреть отзывы и «Кто поставил оценку» — без оплаты. ${unlimitedLine(from.id)}`;
  else if (!search) {
    const { price } = await reviewPrice(from.id).catch(() => ({ price: REVIEW_PRICE }));
    priceLine = `Смотреть отзывы — бесплатно. «Кто поставил оценку» — ${wallet.formatRub(price)} за клиента.`;
  }
  return [
    ...(notice ? [notice, ''] : []),
    search ? '<b>🔎 Поиск клиента — вход в WB</b>' : '<b>⭐ Отзывы ПВЗ — вход в WB</b>',
    search
      ? 'Чтобы найти клиента по ячейке или телефону, мне нужен вход в WB: оттуда я беру заказы вашего пункта.'
      : 'Чтобы показать отзывы вашего пункта, мне нужен вход в WB.',
    '',
    'Отправьте номер телефона, с которым вы входите в программу WB на пункте, например <code>79991234567</code>. WB пришлёт на него код — его тоже отправьте сюда.',
    '',
    '🔒 Сообщения с номером и кодом я сразу удаляю. Данные входа (и номер) хранятся в зашифрованном виде. Выйти можно в любой момент кнопкой «Выйти из WB».',
    ...(priceLine ? ['', priceLine] : []),
  ].join('\n');
}

function ttlText(seconds) {
  const value = Math.round(Number(seconds));
  return value >= 60 && value % 60 === 0 ? `${value / 60} мин` : `${value} сек`;
}

/** Шаг кода. repeat — человек снова открыл отзывы или поиск, пока бот ждёт код; fresh — код запрошен заново. */
function wbCodeText(phone, { ttl = 0, repeat = false, fresh = false } = {}) {
  const tail = phoneTail(phone);
  const number = tail ? `номер, который заканчивается на <b>${tail}</b>` : 'ваш номер';
  if (repeat) return `<b>Вход в WB</b>\nЖду код от WB — он отправлен на ${number}. Пришлите его сюда.\nНе пришёл? Нажмите «Выслать код заново».`;
  const time = Number(ttl) > 0 ? ` в течение ${ttlText(ttl)}` : '';
  return `<b>Вход в WB</b>\n${fresh ? 'Новый код' : 'Код'} от WB отправлен на ${number}. Пришлите его сюда${time} — сообщение с кодом я удалю.\nНе пришёл? Нажмите «Выслать код заново».`;
}

/**
 * Телефон для входа в WB: 8… → 7…, 10 цифр с девятки — дописываем 7. Не номер — { error }; foreign — номер
 * другой страны: вход проверен только по номерам +7, поэтому говорим прямо, а не повторяем «неверный формат».
 * Другая страна — только явный «+» не с семёрки или 12–15 цифр не с семёрки: 11 цифр не с 7/8 — скорее ШК
 * или опечатка, на них обычная подсказка.
 */
function parseWbPhone(text) {
  const raw = String(text || '');
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('9')) digits = `7${digits}`;
  if (/^7\d{10}$/.test(digits)) return { phone: digits };
  const plusOther = /^\s*\+\s*[0-689]/.test(raw) && digits.length >= 10 && digits.length <= 15;
  if (plusOther || (digits.length >= 12 && digits.length <= 15 && !digits.startsWith('7'))) {
    return { foreign: true, error: 'Пока я вхожу в WB только по российским номерам +7. Если ваш номер другой страны — напишите в поддержку.' };
  }
  return { error: 'Это не похоже на номер телефона. Отправьте 11 цифр, например <code>79991234567</code>. Прислали ШК или передумали — нажмите «Отменить вход».' };
}

/** Ошибка WB (его ответ или сеть до него), а не наша: 'expired' | 'forbidden' | 'busy' | 'down'; иначе null. */
function wbErrorKind(error) {
  if (error?.name !== 'WbPvzError') return null;
  const status = Number(error.status);
  if (status === 401) return 'expired';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'busy';
  return 'down';
}

/** Текст, который написал сам WB по-русски (не 5xx), — его можно показать. Технические строки — нет. */
function wbHumanText(error) {
  const text = String(error?.wbMessage || '').trim();
  return text && !(Number(error?.status) >= 500) && text.length <= 200 && /[а-яё]/i.test(text) ? text : '';
}

function wbCodeRequestErrorText(error, fresh) {
  if (Number(error?.status) === 429) return 'WB временно не отправляет код на этот номер — слишком много попыток. Подождите 10–15 минут и попробуйте снова.';
  const said = wbHumanText(error);
  if (said) {
    return `WB не отправил код: «${escapeHtml(said)}».\n${fresh
      ? 'Попробуйте ещё раз через минуту или войдите другим номером.'
      : 'Проверьте номер — тот, с которым вы входите в WB на пункте, — и отправьте его ещё раз.'}`;
  }
  return fresh ? 'WB сейчас не отвечает — новый код не отправлен. Попробуйте через минуту.' : 'WB сейчас не отвечает. Отправьте номер ещё раз через минуту.';
}

function wbCodeConfirmErrorText(error, session) {
  if (!session?.desktopLoginToken) return 'Этот код уже не подойдёт. Нажмите «Выслать код заново».';
  if (Number(error?.status) === 429) return 'Слишком много попыток входа. Подождите 10–15 минут и нажмите «Выслать код заново».';
  const said = wbHumanText(error);
  const status = Number(error?.status);
  if (said || (status >= 400 && status < 500)) {
    return `${said ? `WB ответил: «${escapeHtml(said)}».\n` : ''}Код не подошёл или его срок истёк. Отправьте код ещё раз или нажмите «Выслать код заново».`;
  }
  return 'WB сейчас не отвечает. Отправьте код ещё раз через минуту.';
}

/**
 * Запросить код WB на номер и показать шаг кода. fresh — «Выслать код заново» (вход остаётся на шаге кода, прежний
 * код ещё можно ввести); messageId — править этот экран, без него — новое сообщение (номер пришёл сообщением).
 */
async function requestWbCode(from, chatId, session, phone, { messageId, fresh = false } = {}) {
  try {
    const result = await wbPvz.requestCode(session, phone, { resend: fresh });
    await saveWbConnection(from, chatId, 'await_code', result.session);
    await showScreen(chatId, messageId, wbCodeText(phone, { ttl: result.ttl, fresh }), { reply_markup: WB_CODE_KEYBOARD });
  } catch (error) {
    console.warn('WB login code request failed', error?.status || '', error?.message);
    await saveWbConnection(from, chatId, fresh ? 'await_code' : 'await_phone', session, { lastError: String(error?.message).slice(0, 500) });
    await showScreen(chatId, messageId, wbCodeRequestErrorText(error, fresh), { reply_markup: fresh ? WB_CODE_KEYBOARD : WB_LOGIN_KEYBOARD });
  }
}

/**
 * Ошибка WB посреди отзывов или поиска клиента — понятный ответ вместо «сбоя на нашей стороне», без текста
 * ошибки (он — в журнал). 401 — вход устарел: удаляем его и сразу просим номер; 403 — вход не удаляем (что именно
 * WB отвечает без прав, не проверено — по кругу входа не гоняем), даём повтор и вход заново; 429 и сбой — повтор.
 * purpose — куда вести вход заново; retry — кнопка, повторяющая действие; note — строка сверху;
 * money — дописать «Деньги не списаны» (там, где за действие платят). Не ошибка WB — false.
 */
async function replyWbFailure(from, chatId, error, { purpose = 'reviews', retry = '', note = '', money = false } = {}) {
  const kind = wbErrorKind(error);
  if (!kind) return false;
  console.warn('WB request failed', kind, error.status || '', error.message);
  const lead = note ? `${note}\n\n` : '';
  if (kind === 'expired') {
    localGoodsSnapshots.delete(Number(from.id));
    await deleteWbConnection(from.id);
    const notice = `${lead}Вход в WB устарел — WB просит войти заново. Это минута: номер и код.${money ? '\nДеньги не списаны.' : ''}`;
    if (purpose === 'search') await startClientSearch(from, chatId, undefined, { notice });
    else await showReviewFilters(from, chatId, undefined, { notice });
    return true;
  }
  const text = kind === 'forbidden'
    ? 'WB не дал доступ к данным пункта. Так бывает, если у этого номера нет нужных прав в WB или вход устарел. Попробуйте ещё раз, а если не поможет — войдите заново (можно номером владельца или менеджера).'
    : kind === 'busy' ? 'WB просит подождать: слишком много запросов подряд. Попробуйте ещё раз через пару минут.'
      : 'WB сейчас не отвечает. Попробуйте ещё раз через минуту.';
  const rows = [];
  if (retry && Buffer.byteLength(retry) <= 64) rows.push([{ text: '🔄 Повторить', callback_data: retry }]);
  if (kind === 'forbidden') rows.push([{ text: '📱 Войти заново', callback_data: purpose === 'search' ? 'cs:relogin' : 'rv:relogin:ok' }]);
  rows.push(MENU_ROW);
  await sendMessage(chatId, `${lead}${text}${money ? '\nДеньги не списаны.' : ''}`, { reply_markup: choiceKeyboard(rows) });
  return true;
}

/** Ответ на сообщение (карточку автора — под отзывом): исходное могли удалить — тогда просто новым сообщением. */
function replyTo(messageId) {
  return messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {};
}

// Отзыв, под которым не хватило денег на «Кто поставил»: после пополнения (afterWalletTopup → then) карточка автора
// придёт ответом на него. В памяти процесса по «Telegram + then» (в строке then id сообщения нет, а в лимит
// callback_data он не влезает); потеря после перезапуска безобидна — карточка придёт просто новым сообщением.
const REVIEW_TOPUP_MESSAGES_MAX = 5000;
const reviewTopupMessages = new Map();

function rememberReviewTopupMessage(telegramId, then, reviewMessageId) {
  if (!then || !reviewMessageId) return;
  const key = `${Number(telegramId)}:${then}`;
  reviewTopupMessages.delete(key);
  reviewTopupMessages.set(key, Number(reviewMessageId));
  if (reviewTopupMessages.size > REVIEW_TOPUP_MESSAGES_MAX) reviewTopupMessages.delete(reviewTopupMessages.keys().next().value);
}

function reviewTopupMessage(telegramId, then) {
  return reviewTopupMessages.get(`${Number(telegramId)}:${then}`) || undefined;
}

/**
 * «Кто поставил оценку» — цена и пополнение. reason='empty' — нажали «Кто поставил оценку», а денег не хватило;
 * then — какой отзыв раскрыть сразу после пополнения ('rv:<фильтр>:<стр>:<№>'); reviewMessageId — отзыв, на который
 * отвечаем (экран открывается новым сообщением прямо под ним).
 */
async function showReviewPaywall(from, chatId, reason, messageId, then, reviewMessageId) {
  rememberReviewTopupMessage(from.id, then, reviewMessageId);
  const userId = await ensureUser(from);
  const [balance, free, { price, info: club }] = await Promise.all([walletRub(userId), helperFreeText(), reviewPriceInfo(from.id)]);
  const missing = Math.round((price - balance) * 100) / 100;
  const text = [
    `<b>👤 Кто поставил оценку — ${wallet.formatRub(price)}</b>`,
    ...clubStatusLines(club),
    'Покажу ID клиента, телефон (WB может скрыть часть цифр), когда он забрал заказ или отказался, и ячейку.',
    'Того же клиента в этом ПВЗ повторно — бесплатно, даже по другому отзыву. Если WB не отдал данные — не списываю.',
    '',
    `💰 На балансе: <b>${wallet.formatRub(balance)}</b>${reason === 'empty' && missing > 0 ? ` — не хватает ${wallet.formatRub(missing)}` : ''}`,
    ...(then ? ['После пополнения автор откроется сам.'] : []),
    ...(free ? ['', `💡 В программе «Помощник ПВЗ» для компьютера тоже видно, кто поставил оценку (${free}): ${PROGRAM_URL}`] : []),
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    ...(then ? [topupAndBuyRow(missing, then)] : topupRows(missing)),
    [{ text: '⭐ К отзывам', callback_data: 'rv:filters' }, ...MENU_ROW],
  ]), ...(messageId ? {} : replyTo(reviewMessageId)) });
}

/** «✅ ПВЗ 12345 · адрес» — галочка у открытого пункта; адрес — только если WB его прислал. */
function pointLabel(point, current) {
  const address = typeof point?.address === 'string' ? point.address.trim() : '';
  const text = `${current && Number(point.id) === current ? '✅ ' : ''}ПВЗ ${point.id}${address ? ` · ${address}` : ''}`;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** Список пунктов. current — открытый сейчас: тогда выход — «Оставить текущий ПВЗ» (вход не трогаем). */
function pointKeyboard(points, current = null) {
  return choiceKeyboard([
    ...points.slice(0, 30).map(point => [{ text: pointLabel(point, current), callback_data: `rv:point:${point.id}` }]),
    [current ? { text: '⬅️ Оставить текущий ПВЗ', callback_data: 'rv:cancel' } : { text: '✖️ Отмена', callback_data: 'rv:cancel' }],
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

/**
 * Время из goods отзыва WB: московское, но с ложной «Z» («2026-11-01T13:07:56Z» — выдача в 13:07 МСК,
 * а не в 16:07). Показываем цифры как есть, без перевода пояса.
 */
function formatReviewGoodsTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(String(value).slice(0, 19));
  const zone = /(?:Z|[+-]00:?00)$/i.test(String(value).trim()) ? 'UTC' : 'Europe/Moscow';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Только дата, без времени: «22 окт. 2026 г.» — в шапке отзыва. */
function formatWbDay(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(String(value).slice(0, 10));
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'medium' }).format(date);
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
    `${'⭐'.repeat(stars)}${'☆'.repeat(5 - stars)} · ${formatWbDay(review.rate_dt)}`,
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

/** Экран отзывов: вход в WB (если его нет), выбор пункта или выбор оценок. notice — строка сверху. */
async function showReviewFilters(from, chatId, messageId, { notice = '' } = {}) {
  const connection = await getWbConnection(from.id);
  if (connection?.session?.token && connection.state === 'await_point') {
    await beginPointSelection(from, chatId, connection, messageId);
    return;
  }
  // Код уже отправлен — повторное «Отзывы ПВЗ» не сбрасывает вход на ввод телефона, а напоминает про код.
  if (connection?.state === 'await_code' && connection.session?.desktopLoginToken) {
    await showScreen(chatId, messageId, wbCodeText(connection.session.phone, { repeat: true }), { reply_markup: WB_CODE_KEYBOARD });
    return;
  }
  if (!connection?.session?.token || connection.state !== 'ready') {
    await saveWbConnection(from, chatId, 'await_phone', { deviceId: crypto.randomUUID() });
    await showScreen(chatId, messageId, await wbLoginPromptText(from, 'reviews', notice), { reply_markup: choiceKeyboard([MENU_ROW]) });
    return;
  }
  const free = reviewFreeFor(from.id);
  const userId = free ? null : await findUser(from.id);
  const [balance, { price, info: club }] = await Promise.all([
    free ? null : userId ? walletRub(userId).catch(() => null) : 0,
    reviewPriceInfo(from.id),
  ]);
  const text = [
    ...(notice ? [notice, ''] : []),
    `<b>⭐ Отзывы ПВЗ ${escapeHtml(connection.session.pointId)}</b>`,
    'Смотреть отзывы — бесплатно.',
    free
      ? `👤 «Кто поставил оценку» — без оплаты. ${unlimitedLine(from.id)}`
      : `👤 «Кто поставил оценку» — ${wallet.formatRub(price)} за клиента: ID, телефон (WB может скрыть часть цифр), когда забрал или отказался, ячейка. Того же клиента в этом ПВЗ повторно — бесплатно.`,
    ...(balance == null ? [] : [`💰 На балансе: ${wallet.formatRub(balance)}`]),
    ...(free ? [] : clubStatusLines(club)),
    '',
    'Отзывы с какой оценкой показать?',
  ].join('\n');
  const screenId = await showScreen(chatId, messageId, text, { reply_markup: reviewFilterKeyboard() });
  // «💰 Пополнить баланс» отсюда — «⬅️ Назад» с пополнения вернёт к отзывам, а не в профиль.
  rememberTopupOrigin(from.id, screenId, 'rv:filters');
}

/** Страница отзывов. Ошибки WB (вход устарел, WB не отвечает) разбирает processUpdate — replyWbFailure. */
async function sendReviewPage(from, chatId, filterKey, page) {
  const connection = await getWbConnection(from.id);
  if (!connection?.session?.token || connection.state !== 'ready') return showReviewFilters(from, chatId);
  const stars = reviewStars(filterKey);
  if (!stars.length) return;
  const result = await wbPvz.loadReviews(connection.session, stars, page, 5);
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
  // Цена — прямо на кнопке (со скидкой клуба); безлимиту — без цены: с него не спишется.
  const free = reviewFreeFor(from.id);
  const { price } = free ? { price: 0 } : await reviewPrice(from.id).catch(() => ({ price: REVIEW_PRICE }));
  const whoText = free ? '👤 Кто поставил' : `👤 Кто поставил — ${wallet.formatRub(price)}`;
  for (let index = 0; index < result.data.length; index += 1) {
    const review = result.data[index];
    // Метка отзыва (первые 8 символов id): если список сдвинется, найдём именно этот отзыв, а не соседа по позиции.
    const tag = reviewTag(review);
    const callbackData = `rv:who2:${filterKey}:${safePage}:${index}${tag ? `:${tag}` : ''}`;
    const keyboard = choiceKeyboard([[{ text: whoText, callback_data: callbackData }]]);
    await sendMessage(chatId, reviewText(review, safePage * 5 + index + 1, result.total), { reply_markup: keyboard });
  }
  const navigation = [];
  if (safePage > 0) navigation.push({ text: '⬅️ Предыдущие', callback_data: `rv:page:${filterKey}:${safePage - 1}` });
  if (safePage + 1 < totalPages) navigation.push({ text: 'Следующие ➡️', callback_data: `rv:page:${filterKey}:${safePage + 1}` });
  const terms = free ? '' : `\n«Кто поставил» — ${wallet.formatRub(price)} с баланса за клиента. Того же клиента повторно — бесплатно; если WB не отдал данные — не списываю.`;
  await sendMessage(chatId, `Страница <b>${safePage + 1}</b> из <b>${totalPages}</b>${terms}`, {
    reply_markup: choiceKeyboard([navigation, [{ text: '⭐ Выбрать другую оценку', callback_data: 'rv:filters' }, ...MENU_ROW]].filter(row => row.length)),
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
  if (reviewEvents.length) {
    // Формат goods внутри отзыва не задокументирован: пишем в журнал ключи и сырое время (без ПДн), чтобы сверить.
    const sample = reviewEvents[0];
    console.info('WB review goods shape', Object.keys(sample).join(','), JSON.stringify(sample.status_updated));
  }
  const [users, salesResult] = await Promise.all([
    // users-data отвечает 403 «недостаточно прав» аккаунтам без роли руководителя — телефон тогда берём из продаж.
    identifiers.length ? wbPvz.loadUsers(connection.session, identifiers).catch(error => {
      console.warn('WB users-data failed', error.status, error.message);
      return [];
    }) : [],
    identifiers.length
      ? loadPickupEvents(from.id, connection, identifiers).then(events => ({ events })).catch(error => ({ error }))
      : { events: [] },
  ]);
  // Источник правды — goods/list пункта: там ШК, ячейка и верное время. goods из отзыва — запасной вариант
  // (rid, shk_id, status, status_updated): время в них московское с ложной «Z» — см. formatReviewGoodsTime.
  const fromReview = !salesResult.events?.length && reviewEvents.length > 0;
  const pickupResult = fromReview ? { events: reviewEvents } : salesResult;
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
  let pickupText = '';
  let lines = [];
  if (pickupResult.error) {
    // Текст ошибки — в журнал, человеку — что делать. Деньги при этом не списываются (found ниже).
    console.warn('WB pickup events failed', pickupResult.error.status || '', pickupResult.error.message);
    pickupText = '<i>Сейчас не получилось загрузить выдачи — WB не ответил. Попробуйте ещё раз через минуту.</i>';
  } else if (!pickupResult.events.length && !identifiers.length) {
    pickupText = '<i>WB не передал ID автора в этом отзыве — определить клиента невозможно.</i>';
  } else if (!pickupResult.events.length) {
    pickupText = '<i>Выдачи этого клиента не нашлись: WB хранит только недавние заказы пункта, а этот уже ушёл из списка.</i>';
  } else {
    // Все события клиента из окна WB: показываются по AUTHOR_HISTORY_PAGE штук, листаются в том же сообщении.
    lines = pickupResult.events.map((item, index) => {
      const returned = pickupAction(item.status) === 'returned';
      const label = returned ? '↩️ отказ' : '✅ взял';
      const shk = item.shk_code || item.barcode || item.sticker_code || item.shk_id;
      const when = fromReview ? formatReviewGoodsTime(item.status_updated) : formatWbDate(item.status_updated);
      const parts = [`${index + 1}. ${label} · ${when}`];
      if (item.cell) parts.push(`яч. <code>${escapeHtml(item.cell)}</code>`);
      if (shk) parts.push(`ШК <code>${escapeHtml(shk)}</code>`);
      return parts.join(' · ');
    });
  }
  const phone = maskWbPhone(user?.phone ?? user?.mobile);
  // Списываем, только если WB что-то отдал; сбой загрузки выдач — показ бесплатный, даже если телефон пришёл.
  const failed = Boolean(pickupResult.error);
  const found = !failed && (phone !== '—' || pickupResult.events.length > 0);
  const name = String(user?.name || '').trim();
  const header = [
    '<b>👤 Кто поставил оценку</b>',
    '',
    ...(name ? [`Имя: ${escapeHtml(name)}`] : []),
    ...(identifiers.length ? [`ID клиента: <code>${identifiers[0]}</code>`] : []),
    ...(phone !== '—' ? [`Телефон: <code>${escapeHtml(phone)}</code>`] : []),
  ].join('\n');
  return { found, failed, header, pickupText, lines, clientId: identifiers[0] || null };
}

// ── История автора: по 5 событий на страницу, «Назад»/«Далее» редактируют то же сообщение ──
const AUTHOR_HISTORY_PAGE = 5;
const AUTHOR_HISTORY_TTL_MS = 30 * 60 * 1000;
/** Ключ `${telegramId}:${clientId}` → { info, footer, savedAt }. Хранится после показа, чтобы листать без повторных запросов к WB. */
const authorHistoryCache = new Map();

function rememberAuthorHistory(telegramId, info, footer) {
  if (!info.clientId) return;
  for (const [key, entry] of authorHistoryCache) if (Date.now() - entry.savedAt > AUTHOR_HISTORY_TTL_MS) authorHistoryCache.delete(key);
  authorHistoryCache.set(`${telegramId}:${info.clientId}`, { info, footer, savedAt: Date.now() });
}

/** Текст и кнопки страницы истории. Без событий — одна страница с пояснением и без кнопок листания. */
function renderAuthorHistory(info, footer, page) {
  const total = info.lines.length;
  const pages = Math.max(1, Math.ceil(total / AUTHOR_HISTORY_PAGE));
  const safePage = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  let body = info.pickupText;
  if (total) {
    const start = safePage * AUTHOR_HISTORY_PAGE;
    const slice = info.lines.slice(start, start + AUTHOR_HISTORY_PAGE);
    const counter = ` (${start + 1}–${start + slice.length} из ${total})`;
    body = `<b>Когда забрал / отказался${counter}:</b>\n${slice.join('\n')}`;
  }
  const navigation = [];
  if (info.clientId && safePage > 0) navigation.push({ text: '⬅️ Предыдущие', callback_data: `rv:hist:${info.clientId}:${safePage - 1}` });
  if (info.clientId && safePage + 1 < pages) navigation.push({ text: 'Следующие ➡️', callback_data: `rv:hist:${info.clientId}:${safePage + 1}` });
  return {
    text: `${info.header}\n\n${body}\n\n<i>${footer}</i>`,
    // «⭐ К отзывам» (rv:back) — новым сообщением: оплаченная карточка остаётся в чате.
    options: { reply_markup: choiceKeyboard([navigation, AUTHOR_BACK_ROW].filter(row => row.length)) },
  };
}

const AUTHOR_BACK_ROW = [{ text: '⭐ К отзывам', callback_data: 'rv:back' }, ...MENU_ROW];

/** Карточка автора — ответом на сообщение с отзывом (reviewMessageId), чтобы было видно, к какому она отзыву. */
async function sendAuthorHistory(from, chatId, info, footer, reviewMessageId) {
  rememberAuthorHistory(from.id, info, footer);
  const view = renderAuthorHistory(info, footer, 0);
  await sendMessage(chatId, view.text, { ...view.options, ...replyTo(reviewMessageId) });
}

/** Кнопки «Назад»/«Далее» под историей: берём из кэша, а если он истёк — перечитываем у WB (показ уже оплачен). */
async function turnAuthorHistory(from, chatId, messageId, clientId, page) {
  let entry = authorHistoryCache.get(`${from.id}:${clientId}`);
  if (!entry || Date.now() - entry.savedAt > AUTHOR_HISTORY_TTL_MS) {
    const connection = await getWbConnection(from.id);
    if (!connection?.session?.token || connection.state !== 'ready') return showReviewFilters(from, chatId);
    if (!reviewFreeFor(from.id)) {
      const userId = await findUser(from.id);
      const pointId = Number(connection.session.pointId) || 0;
      const revealed = userId
        ? await supabaseFetch(`bot_review_reveals?user_id=eq.${encodeURIComponent(userId)}&point_id=eq.${pointId}&client_id=eq.${clientId}&select=client_id&limit=1`).then(rows => rows.length > 0).catch(() => false)
        : false;
      if (!revealed) return sendMessage(chatId, 'Список выдач устарел. Откройте отзыв и нажмите «Кто поставил» ещё раз.', { reply_markup: choiceKeyboard([AUTHOR_BACK_ROW]) });
    }
    const info = await buildReviewAuthor(from, connection, clientId);
    entry = { info, footer: reviewFreeFor(from.id) ? unlimitedLine(from.id) : 'Этого автора вы уже смотрели — бесплатно.', savedAt: Date.now() };
    authorHistoryCache.set(`${from.id}:${clientId}`, entry);
  }
  const view = renderAuthorHistory(entry.info, entry.footer, page);
  await showScreen(chatId, messageId, view.text, view.options);
}

/**
 * «👤 Кто поставил оценку» — платно: 1 проверка за клиента в этом ПВЗ. Баланс проверяем до запроса
 * к WB, а списываем после — и только если WB что-то отдал. Повтор того же автора бесплатный.
 */
/** Безлимит или Telegram ID через запятую в REVIEW_FREE_TELEGRAM_IDS — «Кто поставил оценку» без оплаты. */
function reviewFreeFor(telegramId) {
  return Boolean(unlimitedName(telegramId)) || envIdList('REVIEW_FREE_TELEGRAM_IDS').includes(String(telegramId));
}

async function revealReviewAuthor(from, chatId, reviewOrUserId, userSid, then, reviewMessageId) {
  const connection = await getWbConnection(from.id);
  if (!connection?.session?.token || connection.state !== 'ready') return showReviewFilters(from, chatId);
  if (reviewFreeFor(from.id)) {
    const info = await buildReviewAuthor(from, connection, reviewOrUserId, userSid);
    return sendAuthorHistory(from, chatId, info, unlimitedLine(from.id), reviewMessageId);
  }
  // Новичку аккаунт создаём сразу (бот самостоятельный): дальше общая ветка — запрос к WB, пэйвол с «then».
  const userId = await ensureUser(from);
  const clientId = authorIdentifiers(reviewOrUserId, userSid)[0] || null;
  const pointId = Number(connection.session.pointId) || 0;
  // Баланс, факт прошлого показа и данные автора узнаём параллельно. Пэйвол показываем только
  // после запроса к WB: если автора не определить, показ бесплатный и денег не требуется.
  const [revealed, balance, info, { price, club }] = await Promise.all([
    clientId
      ? supabaseFetch(`bot_review_reveals?user_id=eq.${encodeURIComponent(userId)}&point_id=eq.${pointId}&client_id=eq.${clientId}&select=client_id&limit=1`).then(rows => rows.length > 0)
      : Promise.resolve(false),
    walletRub(userId),
    buildReviewAuthor(from, connection, reviewOrUserId, userSid),
    reviewPrice(from.id),
  ]);
  let footer;
  if (!clientId || !info.found) footer = info.failed ? 'Деньги не списаны.' : 'Данных об авторе нет — деньги не списаны.';
  else if (revealed) footer = 'Этого автора вы уже смотрели — бесплатно.';
  else if (balance < price) return showReviewPaywall(from, chatId, 'empty', undefined, then, reviewMessageId);
  else {
    // ограничение «Покупки» — с баланса нельзя (ACCOUNT_RESTRICTED покажет processUpdate)
    await controls.assertAllowed(userId, 'purchases');
    // bot_review_spend списывает цену с баланса (25 ₽, со скидкой клуба 20 ₽; миграция 20261027), balance — в копейках.
    const spent = await supabaseFetch('rpc/bot_review_spend', { method: 'POST', body: JSON.stringify({ p_user: userId, p_point: pointId, p_client: clientId, p_kopecks: price * 100 }) });
    if (!spent?.ok) return showReviewPaywall(from, chatId, 'empty', undefined, then, reviewMessageId);
    if (!spent.free) notifyAdminSpend({ userId, priceRub: price, title: `Кто поставил оценку${club ? ', скидка клуба' : ''}`, balanceKopecks: spent.balance }).catch(() => {});
    footer = spent.free ? 'Этого автора вы уже смотрели — бесплатно.' : `Списано ${wallet.formatRub(price)}${club ? CLUB_CHARGE_NOTE : ''} · на балансе ${wallet.formatRub(Number(spent.balance) / 100)}`;
  }
  await sendAuthorHistory(from, chatId, info, footer, reviewMessageId);
}

function reviewTag(review) {
  const match = /^([0-9a-f]{8})/i.exec(String(review?.id || ''));
  return match ? match[1].toLowerCase() : '';
}

/** reviewMessageId — сообщение с отзывом, под которым нажали «Кто поставил»: карточка придёт ответом на него. */
async function showReviewAuthorByPosition(from, chatId, filterKey, page, index, tag, reviewMessageId) {
  const connection = await getWbConnection(from.id);
  if (!connection?.session?.token || connection.state !== 'ready') return showReviewFilters(from, chatId);
  const stars = reviewStars(filterKey);
  if (!stars.length || !Number.isInteger(page) || page < 0 || !Number.isInteger(index) || index < 0 || index >= 5) return;
  let review = null, foundPage = page, foundIndex = index;
  if (tag) {
    // Новые отзывы сдвигают список вниз — ищем отзыв по метке на его странице и на соседних.
    for (const candidate of [page, page + 1, page - 1].filter(value => value >= 0)) {
      const result = await wbPvz.loadReviews(connection.session, stars, candidate, 5);
      const position = result.data.findIndex(item => reviewTag(item) === tag);
      if (position >= 0) { review = result.data[position]; foundPage = candidate; foundIndex = position; break; }
    }
  } else {
    review = (await wbPvz.loadReviews(connection.session, stars, page, 5)).data[index] || null;
  }
  if (!review) return sendMessage(chatId, 'Этот отзыв больше не найден — список изменился. Откройте отзывы заново, деньги не списаны.', { reply_markup: choiceKeyboard([[{ text: '⭐ К отзывам', callback_data: 'rv:filters' }, ...MENU_ROW]]) });
  return revealReviewAuthor(from, chatId, review, undefined, `rv:${filterKey}:${foundPage}:${foundIndex}${tag ? `:${tag}` : ''}`, reviewMessageId);
}

function noPointsView(phone) {
  const number = phone ? ` для номера <code>${escapeHtml(maskWbPhone(phone))}</code>` : '';
  return {
    text: [
      '<b>Нет доступных ПВЗ</b>',
      '',
      `Вход в WB выполнен, но WB не показывает ни одного ПВЗ${number}.`,
      '',
      'Проверьте, что владелец добавил вас в сотрудники именно по этому номеру. Когда доступ появится, нажмите «Проверить снова» — входить заново не нужно.',
    ].join('\n'),
    reply_markup: choiceKeyboard([
      [{ text: '🔄 Проверить снова', callback_data: 'rv:points' }],
      // Без пунктов вход бесполезен — входим другим номером сразу, без вопроса «точно?».
      [{ text: '📱 Войти другим номером', callback_data: 'rv:relogin:ok' }],
      MENU_ROW,
    ]),
  };
}

/**
 * Выбор пункта. После входа (await_point) — один пункт выбирается сам, несколько — список. «Сменить ПВЗ» из
 * готового входа (ready) состояние НЕ меняет: пока человек не выбрал новый пункт, работает прежний, и «Оставить
 * текущий ПВЗ» ничего не ломает. messageId — править этот экран (кнопка), без него — новое сообщение.
 */
async function beginPointSelection(from, chatId, connection, messageId) {
  const manual = connection.state === 'ready';
  const current = manual ? Number(connection.session?.pointId) || null : null;
  const points = await wbPvz.loadPoints(connection.session);
  if (!points.length) {
    // Обычное состояние, а не сбой: вход прошёл, но WB не отдаёт этому номеру ни одного пункта.
    if (!manual) await saveWbConnection(from, chatId, 'await_point', connection.session, { lastError: 'WB не показывает этому номеру ни одного ПВЗ' });
    const view = noPointsView(connection.session?.phone);
    await showScreen(chatId, messageId, view.text, { reply_markup: view.reply_markup });
    return;
  }
  if (points.length === 1 && manual && current === Number(points[0].id)) {
    // Нажали «Сменить ПВЗ», а пункт один — объясняем, а не показываем тот же экран заново.
    await showScreen(chatId, messageId, `У этого номера в WB только один пункт — ПВЗ ${escapeHtml(current)}. Чтобы открыть другой, войдите номером, у которого есть к нему доступ.`, { reply_markup: choiceKeyboard([
      [{ text: '📱 Войти другим номером', callback_data: 'rv:relogin' }],
      [{ text: '⬅️ Назад', callback_data: 'rv:stay' }, ...MENU_ROW],
    ]) });
    return;
  }
  if (points.length === 1) {
    const session = await wbPvz.selectPoint(connection.session, points[0].id);
    await saveWbConnection(from, chatId, 'ready', session);
    return afterWbReady(from, chatId, messageId);
  }
  // Список пунктов мог обновиться (loadPoints) — сохраняем его, состояние оставляем прежним.
  await saveWbConnection(from, chatId, manual ? 'ready' : 'await_point', connection.session);
  const text = [
    '<b>Выберите ПВЗ</b>',
    ...(current ? [`Сейчас открыт ПВЗ ${escapeHtml(current)}.`] : []),
    ...(points.length > 30 ? [`Показаны первые 30 из ${points.length}.`] : []),
  ].join('\n');
  await showScreen(chatId, messageId, text, { reply_markup: pointKeyboard(points, current) });
}

// Ссылки на PDF индивидуального заказа подписаны на час: сообщение со списком устаревает,
// свежие ссылки — снова по кнопке «Мои заказы».
const ORDER_PDF_PART = 500;
const ORDER_PDF_TTL_S = 3600;

function individualPdfRows(order) {
  const parts = Math.ceil(Number(order.quantity) / ORDER_PDF_PART);
  const expires = Math.floor(Date.now() / 1000) + ORDER_PDF_TTL_S;
  const rows = [];
  for (let part = 0; part < parts; part += 1) {
    const signedValue = `individual:${order.id}:${part}:${expires}`;
    const token = crypto.createHmac('sha256', process.env.STICKER_CLIENT_SECRET).update(signedValue).digest('base64url');
    rows.push([{ text: `📄 PDF ${part + 1} из ${parts}`, url: publicUrl(`/api/stickers/pdf?individual=${encodeURIComponent(order.id)}&part=${part}&expires=${expires}&token=${encodeURIComponent(token)}`) }]);
  }
  return rows;
}

/** Экран одного индивидуального заказа: { text, rows }. Оплата — в боте (ord:pay), каждый стикер — по желанию на сайте. */
function individualOrderView(order) {
  const title = `<b>${escapeHtml(order.title)}</b>`;
  const amount = wallet.formatRub(Number(order.amount_due || 0));
  if (order.status === 'paid') {
    return {
      text: `${title}\n${order.quantity} стикеров · оплачен ✅\nPDF — кнопками ниже. Ссылки действуют час, потом откройте «Мои заказы» снова.`,
      rows: [
        ...individualPdfRows(order),
        // Просмотр по одному стикеру боту заменить нечем — открываем историю на сайте, с понятной подписью.
        [{ text: '🌐 Каждый стикер — на сайте', web_app: { url: publicUrl('/cabinet/history') } }],
      ],
    };
  }
  if (order.status === 'canceled') return { text: `${title}\n${order.quantity} стикеров · заказ отменён`, rows: [] };
  // К оплате 0 ₽ (всё зачтено стикерами из пакета): платить нечего, та же кнопка ord:pay просто закрывает заказ.
  if (!(Number(order.amount_due) > 0)) {
    return {
      text: `${title}\n${order.quantity} стикеров · доплата не нужна\nНажмите «Получить PDF» — файлы появятся здесь, в боте.`,
      rows: [[{ text: '📄 Получить PDF', callback_data: `ord:pay:${order.id}` }]],
    };
  }
  return {
    text: `${title}\n${order.quantity} стикеров · ${amount}\nОплатите — и PDF появятся здесь, в боте.`,
    // ord:pay:<uuid> — 44 байта, в лимит callback_data (64) укладывается.
    rows: [[{ text: `💳 Оплатить ${amount}`, callback_data: `ord:pay:${order.id}` }]],
  };
}

async function showIndividualOrders(from, chatId) {
  const userId = await ensureUser(from);
  const orders = await supabaseFetch(`individual_sticker_orders?user_id=eq.${encodeURIComponent(userId)}&select=id,title,quantity,amount_due,status&order=created_at.desc&limit=10`);
  if (!orders.length) {
    return sendMessage(chatId, 'Индивидуальных заказов пока нет. Нужен большой заказ стикеров — напишите в поддержку.', { reply_markup: supportKeyboard() });
  }
  for (const [index, order] of orders.entries()) {
    const view = individualOrderView(order);
    // Меню — под последним заказом, чтобы из списка было куда уйти.
    const rows = index === orders.length - 1 ? [...view.rows, MENU_ROW] : view.rows;
    await sendMessage(chatId, view.text, rows.length ? { reply_markup: choiceKeyboard(rows) } : {});
  }
}

/** «Оплатить» под индивидуальным заказом: заказ ЮKassa здесь же, ссылка на оплату — в том же сообщении. */
async function payIndividualOrder(from, chatId, messageId, orderId) {
  let userId, payment;
  try {
    ({ userId, payment } = await createBotPayment(from, id => require('./_bot-checkout').createIndividualPayment({ userId: id, orderId })));
  } catch (error) {
    console.warn('Telegram individual order payment failed', error.code || '', error.message);
    // «Заказ не найден или уже оплачен» — 404 от обработчика: показываем свежий список вместо общего «не получилось».
    if (Number(error?.status) === 404 && error?.code !== 'ACCOUNT_NOT_FOUND') {
      await showScreen(chatId, messageId, 'Этот заказ уже оплачен или отменён.', { reply_markup: choiceKeyboard([[{ text: '📦 Мои заказы', callback_data: 'orders:list' }], MENU_ROW]) });
      return;
    }
    const view = paymentErrorView(error);
    await showScreen(chatId, messageId, view.text, { reply_markup: paymentErrorKeyboard(view, `ord:pay:${orderId}`) });
    return;
  }
  const rows = await supabaseFetch(`individual_sticker_orders?id=eq.${encodeURIComponent(orderId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,title,quantity,amount_due,status&limit=1`).catch(() => []);
  const order = rows[0];
  if (payment.paid) {
    // К оплате было 0 ₽: обработчик уже закрыл заказ, ссылки на ЮKassa нет (Telegram не принял бы
    // относительный адрес в кнопке). Заказ уже paid — сразу отдаём PDF.
    const view = order?.status === 'paid' ? individualOrderView(order) : null;
    await showScreen(chatId, messageId, view
      ? `✅ Доплата не нужна, заказ закрыт.\n\n${view.text}`
      : '✅ Доплата не нужна, заказ закрыт. PDF — в «📦 Мои заказы».', { reply_markup: choiceKeyboard([
      ...(view ? view.rows : []),
      [{ text: '📦 Мои заказы', callback_data: 'orders:list' }],
      MENU_ROW,
    ]) });
    return;
  }
  const amount = order ? wallet.formatRub(Number(order.amount_due || 0)) : '';
  await showScreen(chatId, messageId, [
    order ? `<b>💳 Оплата заказа «${escapeHtml(order.title)}»</b>` : '<b>💳 Оплата заказа</b>',
    ...(order ? [`${order.quantity} стикеров · ${amount}`] : []),
    'Откроется страница оплаты ЮKassa. После оплаты я пришлю сюда сообщение, PDF будут в «Мои заказы».',
    '',
    OFFER_LINE,
  ].join('\n'), { reply_markup: choiceKeyboard([
    [{ text: `💳 Перейти к оплате${amount ? ` ${amount}` : ''}`, url: payment.confirmationUrl }],
    [{ text: '📦 Мои заказы', callback_data: 'orders:list' }],
    MENU_ROW,
  ]) });
}

// Причины, по которым сайт сообщает о входе через Telegram (api/auth.js). Сообщение в чат и сброс черновика —
// только когда связка действительно поменялась; обычный вход в Mini App (кнопка истории на сайте и т. п.)
// ничего не пишет и не стирает начатый мастер.
const LINK_CHANGED_REASONS = new Set(['linked']);

/**
 * Сайт записал связку Telegram с аккаунтом (вход в Mini App, виджет, привязка в кабинете).
 * reason: 'login' (связка была) | 'created' (аккаунт создан сайтом) | 'linked' (Telegram привязан к аккаунту
 * сайта в кабинете). Без reason — старый сайт, это обычный вход.
 */
async function notifyMiniAppAuthorized(telegramId, reason = 'login') {
  // Связку записал сайт (другой процесс): узел бота мог только что закешировать «связки нет».
  userCache.forgetTelegramUser(telegramId);
  // Пришёл по приглашению и только что создал аккаунт — привязываем к пригласившему.
  await bindTelegramReferral(telegramId).catch(error => console.warn('Telegram referral bind failed', error.message));
  if (!LINK_CHANGED_REASONS.has(reason)) return;
  // В черновике мог остаться прежний userId — начинаем с чистого.
  await clearSession(telegramId).catch(error => console.warn('notifyMiniAppAuthorized: clear session failed', error.message));
  await showMainMenu({ id: telegramId }, telegramId, undefined, {
    notice: '✅ <b>Готово:</b> Telegram привязан к вашему аккаунту на сайте. Баланс и покупки в боте и на сайте теперь общие.',
  }).catch(error => console.warn('notifyMiniAppAuthorized: message not delivered', error.message));
}

/**
 * Поддержка связала этот Telegram с аккаунтом сайта (server/_admin-link.js, по RPC с сайта): сбросить связку
 * и черновик, сообщить человеку. Не бросает — сайт показывает админу { delivered }.
 */
async function notifyAccountLinked(telegramId) {
  userCache.forgetTelegramUser(telegramId);
  await clearSession(telegramId).catch(error => console.warn('notifyAccountLinked: clear session failed', error.message));
  try {
    await showMainMenu({ id: telegramId }, telegramId, undefined, {
      notice: '✅ <b>Готово:</b> бот связан с вашим аккаунтом на сайте. Баланс, покупки и подписки теперь общие.',
    });
    return { delivered: true };
  } catch (error) {
    console.warn('notifyAccountLinked: message not delivered', error.message);
    return { delivered: false };
  }
}

// ── Баланс: пополнение и покупки с баланса (server/_wallet.js) ──

// «⬅️ Назад» с экрана пополнения — туда, откуда пришли: в профиль или в магазин. Источник держим в памяти процесса
// по паре «Telegram + сообщение» (не в сессии: её состояния ограничены в базе, а потеря после перезапуска безобидна —
// «Назад» тогда ведёт в профиль, как раньше). Записывают его экраны с кнопкой пополнения.
const TOPUP_ORIGINS_MAX = 5000;
const topupOrigins = new Map();
const TOPUP_BACK_TITLES = { 'menu:profile': '⬅️ Профиль', 'shop:home': '⬅️ Магазин', 'rv:filters': '⬅️ К отзывам' };

function rememberTopupOrigin(telegramId, messageId, back) {
  if (!messageId) return;
  const key = `${Number(telegramId)}:${Number(messageId)}`;
  topupOrigins.delete(key);
  topupOrigins.set(key, back);
  if (topupOrigins.size > TOPUP_ORIGINS_MAX) topupOrigins.delete(topupOrigins.keys().next().value);
}

function topupOrigin(telegramId, messageId) {
  return (messageId && topupOrigins.get(`${Number(telegramId)}:${Number(messageId)}`)) || 'menu:profile';
}

/** Ушли с экрана «Своя сумма» — сумму больше не ждём. Другие состояния (черновик мастера для «пополнить и создать») не трогаем. */
async function dropTopupAmountWait(telegramId) {
  const session = await getSession(telegramId).catch(() => null);
  if (session?.state === 'await_topup_amount') await clearSession(telegramId).catch(() => {});
}

/** «🎁 Пополните от 500 ₽ — добавим 5%, от 1 000 ₽ — 10%.» — из TOPUP_BONUS_STEPS. */
function topupBonusText() {
  const steps = [...wallet.TOPUP_BONUS_STEPS].sort((a, b) => a[0] - b[0]);
  return `🎁 Пополните ${steps.map(([amount, percent], index) => `от ${wallet.formatRub(amount)} — ${index ? '' : 'добавим '}${percent}%`).join(', ')}.`;
}

async function showTopup(from, chatId, messageId) {
  const userId = await ensureUser(from);
  const [balance] = await Promise.all([walletRub(userId), dropTopupAmountWait(from.id)]);
  const back = topupOrigin(from.id, messageId);
  const text = [
    '<b>💰 Пополнение баланса</b>',
    'С баланса оплачивается всё в боте: стикеры, код клиента, отзывы, подписки и ключи.',
    `💰 На балансе: <b>${wallet.formatRub(balance)}</b>`,
    topupBonusText(),
  ].join('\n');
  const id = await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    ...topupRows(0),
    [{ text: '✏️ Своя сумма', callback_data: 'topup:custom' }],
    [{ text: TOPUP_BACK_TITLES[back] || '⬅️ Назад', callback_data: back }, ...MENU_ROW],
  ]) });
  if (id !== messageId) rememberTopupOrigin(from.id, id, back);
}

const TOPUP_RANGE_TEXT = `от ${wallet.formatRub(wallet.MIN_TOPUP)} до ${wallet.formatRub(wallet.MAX_TOPUP)}`;

async function askTopupAmount(from, chatId, messageId, error) {
  const userId = await ensureUser(from);
  const text = `${error ? `⚠️ ${error}\n\n` : ''}<b>Своя сумма</b>\nОтправьте сумму сообщением — только число, например <code>350</code>. Пополнить можно ${TOPUP_RANGE_TEXT}.`;
  const id = await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([[{ text: '⬅️ Назад', callback_data: 'topup:home' }, ...MENU_ROW]]) });
  if (id !== messageId) rememberTopupOrigin(from.id, id, topupOrigin(from.id, messageId));
  await saveSession(from, chatId, 'await_topup_amount', { userId, msgId: id });
}

/**
 * Сумма из сообщения: «350», «1 000», «350,50», «500 ₽», «500р», «500 руб». Остальное — null: прежний разбор
 * выкидывал все нецифры, и «100р 50к» становилось 10 050 ₽.
 */
function parseTopupAmount(text) {
  const match = /^\s*(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(?:₽|р\.?|руб\.?|рублей|рубля|рубль)?\s*$/iu.exec(String(text || ''));
  if (!match) return null;
  return Number(`${match[1].replace(/[  ]/g, '')}.${match[2] || '0'}`);
}

async function acceptTopupAmount(from, chatId, session, message, text) {
  const msgId = session.draft?.msgId;
  // Голые 7–12 цифр — скорее ID клиента или ШК, чем сумма (и больше максимума): сумму больше не ждём.
  const bare = String(text).replace(/\s+/g, '');
  if (/^\d{7,12}$/.test(bare)) {
    await clearSession(from.id);
    return offerForNumber(from, chatId, bare);
  }
  await deleteMessage(chatId, message.message_id).catch(() => {});
  const amount = parseTopupAmount(text);
  const shown = escapeHtml(String(text).slice(0, 20));
  if (amount == null) return askTopupAmount(from, chatId, msgId, `Не понял сумму «${shown}». Отправьте только число, например <code>350</code>.`);
  if (!wallet.validTopup(amount)) return askTopupAmount(from, chatId, msgId, `Сумма «${shown}» не подходит: пополнить можно ${TOPUP_RANGE_TEXT}.`);
  await clearSession(from.id);
  // Сумма введена — сразу заказ и ссылка на оплату, без лишнего нажатия.
  await startTopupPayment(from, chatId, Math.round(amount * 100) / 100, '', msgId);
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
  return supabaseFetch(`cell_print_licenses?owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=id,key,source,duration_days,device_limit,marketplace_scope,activated_at,expires_at&order=created_at.desc&limit=5`);
}

// Пробный ключ (7 дней, WB + Ozon) не продлеваем: цена продления по его площадке — «WB + Ozon» (×1,8), а площадку
// выбирают заново при покупке. В программе у пробного тоже только «Купить ключ» (docs/cell-print.md).
function isTrialKey(key) { return key?.source === 'trial'; }

function cellKeyStatus(key) {
  if (!key.activated_at) return `не активирован, ${key.duration_days} дн.`;
  const ends = Date.parse(key.expires_at || '');
  return Number.isFinite(ends) && ends > Date.now() ? `до ${shortDate.format(new Date(ends))}` : 'срок закончился';
}

/** «<code>CP-…</code> — до 12.12 · 1 компьютер · Wildberries» (пробный — «пробный, до 19.11»). */
function cellKeyLine(key) {
  const scope = CP_SCOPES[key.marketplace_scope];
  return `<code>${escapeHtml(key.key)}</code> — ${isTrialKey(key) ? 'пробный, ' : ''}${cellKeyStatus(key)} · ${devicesLabel(Number(key.device_limit) || 1)}${scope ? ` · ${scope}` : ''}`;
}

function lowerFirst(text) { return text ? text[0].toLowerCase() + text.slice(1) : ''; }
function upperFirst(text) { return text ? text[0].toUpperCase() + text.slice(1) : ''; }

function pointsLabel(count) { return count === 1 ? '1 пункт' : count < 5 ? `${count} пункта` : `${count} пунктов`; }

/** Что входит в тариф — из PLANS: «2 компьютера, 1 пункт» и для «Про» — коды клиента и стикеры в месяц. */
function planLimitsLine(id) {
  const plan = PLANS[id];
  const monthly = [
    ...(plan.codes ? [`${plan.codes} кодов клиента`] : []),
    ...(plan.stickers ? [`${plan.stickers} стикеров`] : []),
  ];
  return `${devicesLabel(plan.devices)}, ${pointsLabel(plan.points)}${monthly.length ? `; ${monthly.join(' и ')} в месяц` : ''}`;
}

/**
 * Что станет с текущей подпиской при покупке тарифа planId — словами, как решит SQL (app_apply_subscription,
 * миграция 20261019_app_admin_grant.sql): тот же тариф — срок прибавится; повышение — остаток всех отрезков
 * пересчитается в дни нового; понижение — новый отрезок встанет в очередь после последнего. Точную дату до оплаты
 * не считаем (в SQL — интервалы месяцев и пересчёт дней), её показывает «Готово» из app_entitlements.
 */
function subscriptionChangeLine(ent, planId) {
  const current = ent?.plan && PLANS[ent.plan] ? ent.plan : null;
  if (!current) return 'Подписка начнётся сразу после оплаты.';
  const last = ent.next_plan && PLANS[ent.next_plan] ? ent.next_plan : current;
  const until = ent.paid_until || ent.ends_at;
  const rankNew = PLAN_ORDER.indexOf(planId), rankCur = PLAN_ORDER.indexOf(current);
  if (last === planId && rankNew <= rankCur) return `Срок прибавится к текущему${until ? ` (сейчас до ${dayMonthShort(until)})` : ''}.`;
  if (rankNew > rankCur) return `Остаток «${PLANS[current].title}» пересчитаем в дни «${PLANS[planId].title}» — ничего не сгорит.`;
  return `«${PLANS[planId].title}» начнётся после окончания текущей подписки${until ? ` — с ${dayMonthShort(until)}` : ''}.`;
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
  if (kind === 'gen') {
    const count = Number(a), price = CUSTOM_GENERATION_PACKAGES[count];
    if (!price || count <= 1) return { error: 'Такого пакета нет.' };
    const target = await ownTopupCode(userId);
    return {
      title: `<b>🏷 Пакет: ${count} стикеров по номеру</b>\nПо ${wallet.formatRub(price / count)} за штуку`,
      priceRub: price, productKind: 'stickers', back: b === 'wizard' ? 'shop:gen:wizard' : 'shop:gen', returnToGenerator: b === 'wizard',
      fields: { custom_quantity: count, ...(target ? { renewal_target_key: target } : {}) },
      snapshot: { packs: [{ quantity: count, unit: price / count, total: price }], units: count, total: price },
    };
  }
  if (kind === 'helper') {
    const months = Number(b), snap = isSalePlan(a) ? orderSnapshot(a, months) : null;
    if (!snap) return { error: 'Такого тарифа нет.' };
    return {
      title: `<b>🖥 «${PLANS[a].title}» на ${monthsLabel(months)}</b>`,
      priceRub: snap.total, productKind: 'app_subscription', back: `shop:helper:${a}`,
      fields: { app_plan: a, app_term_months: months }, snapshot: snap,
    };
  }
  if (kind === 'cp' && a === 'r') {
    const days = Number(c);
    const rows = await supabaseFetch(`cell_print_licenses?id=eq.${Number(b)}&owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=id,key,source,duration_days,device_limit,marketplace_scope&limit=1`);
    const key = rows[0];
    if (!key) return { error: 'Ключ не найден или отключён.' };
    // Старая кнопка «Продлить» под пробным ключом (из чата, из напоминания) не продаёт продление по цене «WB + Ozon».
    if (isTrialKey(key)) return { error: 'Пробный ключ не продлевается — купите новый: выберете срок, число компьютеров и площадку.', next: { text: '➕ Купить ключ', callback_data: 'shop:cp:n' } };
    if (!CP_DAYS.includes(days)) return { error: 'Такого срока нет.' };
    if (Number(key.duration_days) + days > CELL_PRINT_MAX_DAYS) return { error: `Суммарный срок ключа не может быть больше ${CELL_PRINT_MAX_DAYS} дней.` };
    // У старых ключей площадка не задана — продлеваем как WB и не передаём площадку в заказ.
    const legacy = !CP_SCOPES[key.marketplace_scope];
    const price = cellPrintPrice(days, key.device_limit, legacy ? 'wb' : key.marketplace_scope);
    if (price == null) return { error: 'Этот ключ не получается продлить в боте. Напишите в поддержку — продлим вручную.' };
    return {
      title: `<b>🔄 Продление ключа «ПВЗ Принт» на ${days} дней</b>\n<code>${escapeHtml(key.key)}</code>`,
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
      title: `<b>🖨 Ключ «ПВЗ Принт»: ${days} дней, ${devicesLabel(devices)}, ${CP_SCOPES[scope]}</b>`,
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
      title: `<b>🔑 Пакет кодов клиента: ${count} шт.</b>`,
      priceRub: price, productKind: 'program_license', back: 'shop:wbpk',
      fields: { license_iterations: count, ...(target ? { renewal_target_key: target.key } : {}) },
      snapshot: { license: { iterations: count, total: price }, total: price },
    };
  }
  return { error: 'Такого товара нет.' };
}

/** Экран магазина по callback_data `shop:…`. */
async function showShop(from, chatId, messageId, parts) {
  const userId = await ensureUser(from);
  const balance = await walletRub(userId);
  const balanceLine = `💰 На балансе: <b>${wallet.formatRub(balance)}</b>`;
  // Нижний ряд каждого экрана магазина: «⬅️ Назад» на предыдущий шаг и «☰ Меню».
  const back = data => [{ text: '⬅️ Назад', callback_data: data }, ...MENU_ROW];
  const [kind, a, b, c, d] = parts;

  if (!kind || kind === 'home') {
    const text = [
      '<b>🛒 Купить с баланса</b>',
      balanceLine,
      '',
      '🖥 Подписка «Помощник ПВЗ» — программа для компьютера пункта',
      '🖨 Ключ «ПВЗ Принт» (печать ячеек) — номер ячейки на термопринтере при сканировании',
      '🏷 Пакет стикеров по номеру — дешевле, чем по одному',
      '🔑 Пакет кодов клиента — QR клиента в боте и в «Помощнике ПВЗ»',
    ].join('\n');
    const id = await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
      [{ text: '🖥 Подписка «Помощник ПВЗ»', callback_data: 'shop:helper' }],
      [{ text: '🖨 Ключ «ПВЗ Принт»', callback_data: 'shop:cp' }],
      [{ text: '🏷 Пакеты стикеров по номеру', callback_data: 'shop:gen' }],
      [{ text: '🔑 Пакет кодов клиента', callback_data: 'shop:wbpk' }],
      [{ text: '💰 Пополнить баланс', callback_data: 'topup:home' }],
      [{ text: '⬅️ Профиль', callback_data: 'menu:profile' }, ...MENU_ROW],
    ]) });
    rememberTopupOrigin(from.id, id, 'shop:home');
    return id;
  }
  if (kind === 'gen' && (!a || a === 'wizard')) {
    const fromWizard = a === 'wizard';
    // Код пакета человеку в боте не нужен: пакет тратится сам (reserve_sticker_generation берёт его раньше баланса).
    // Код остаётся в истории и для поддержки; здесь — только сколько уже есть в пакете.
    const { packageLeft } = await wizardPrices(userId);
    const table = Object.entries(CUSTOM_GENERATION_PACKAGES)
      .map(([count, price]) => [Number(count), price])
      .filter(([count]) => count > 1)
      .map(([count, price]) => `${count} шт. — ${price} ₽ (${wallet.formatRub(price / count)} за штуку)`)
      .join('\n');
    const lines = [
      '<b>🏷 Пакеты стикеров по номеру</b>',
      table,
      `Без пакета один стикер по номеру стоит ${wallet.formatRub(GENERATION_PRICES.custom / 100)}.`,
      'Пакет тратится сам: каждый следующий стикер или QR коробки по номеру спишется из него, а не с баланса. На «Пачку 50» купленный пакет не действует (месячные стикеры тарифа «Про» — действуют).',
      ...(packageLeft > 0 ? [`Сейчас в вашем пакете: ${packageLeft} шт. — новый пакет добавится к ним.`] : []),
      balanceLine,
    ];
    return showScreen(chatId, messageId, lines.join('\n'), { reply_markup: choiceKeyboard([
      ...Object.entries(CUSTOM_GENERATION_PACKAGES)
        .map(([count, price]) => [Number(count), price])
        .filter(([count]) => count > 1)
        .map(([count]) => [{ text: `${count} шт.`, callback_data: `shop:gen:${count}${fromWizard ? ':wizard' : ''}` }]),
      back(fromWizard ? 'gen:return-mode' : 'shop:home'),
    ]) });
  }
  if (kind === 'helper' && !a) {
    const [ent, free] = await Promise.all([
      supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) }).catch(() => null),
      helperFreeText(),
    ]);
    const freeNote = free ? '\nОплата начнёт действовать после бесплатного периода.' : '';
    const plans = SALE_PLANS.map(id => `<b>${PLANS[id].title} — ${PLANS[id].monthlyPrice} ₽/мес</b>: ${lowerFirst(PLANS[id].summary)}. ${upperFirst(planLimitsLine(id))}.`);
    const text = [
      '<b>🖥 Подписка «Помощник ПВЗ»</b>',
      `Сейчас: ${helperStatusLine(ent, free)}${freeNote}`,
      '',
      ...plans,
      '',
      balanceLine,
    ].join('\n');
    return showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
      ...SALE_PLANS.map(id => [{ text: `${PLANS[id].title} — ${PLANS[id].monthlyPrice} ₽/мес`, callback_data: `shop:helper:${id}` }]),
      back('shop:home'),
    ]) });
  }
  if (kind === 'helper' && a && !b) {
    if (!isSalePlan(a)) return showShop(from, chatId, messageId, ['helper']);
    const ent = await supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) }).catch(() => null);
    const text = [
      `<b>🖥 «${PLANS[a].title}»</b> — ${lowerFirst(PLANS[a].summary)}.`,
      `${upperFirst(planLimitsLine(a))}.`,
      subscriptionChangeLine(ent, a),
      balanceLine,
      '',
      'На какой срок?',
    ].join('\n');
    return showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
      ...Object.keys(TERMS).map(Number).map(months => {
        const total = planPrice(a, months);
        const perMonth = months > 1 ? `, ${Math.round(total / months)} ₽/мес` : '';
        return [{ text: `${monthsLabel(months)} — ${total} ₽${TERMS[months] ? ` (−${TERMS[months]}%${perMonth})` : ''}`, callback_data: `shop:helper:${a}:${months}` }];
      }),
      back('shop:helper'),
    ]) });
  }
  if (kind === 'cp' && !a) {
    // Ключи — строками в <code> (нажатие копирует), кнопки — только для продления; пробный не продлевается.
    const keys = await ownCellKeys(userId);
    const renewable = keys.filter(key => !isTrialKey(key));
    const trial = keys.find(isTrialKey);
    const text = [
      '<b>🖨 Ключ «ПВЗ Принт» (печать ячеек)</b>',
      ...(keys.length ? ['Ваши ключи (нажмите, чтобы скопировать):', ...keys.map(cellKeyLine)] : ['Ключей пока нет.']),
      ...(trial && !renewable.length ? ['', `Пробный период${trial.expires_at ? ` до ${dayMonthShort(trial.expires_at)}` : ''}. Чтобы печать не остановилась, купите ключ — выберете срок, число компьютеров и площадку.`] : []),
      '',
      balanceLine,
    ].join('\n');
    return showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
      ...renewable.map(key => [{ text: `🔄 Продлить ${key.key}`, callback_data: `shop:cp:r:${key.id}` }]),
      [{ text: keys.length ? '➕ Купить новый ключ' : '➕ Купить ключ', callback_data: 'shop:cp:n' }],
      back('shop:home'),
    ]) });
  }
  if (kind === 'cp' && a === 'r' && b && !c) {
    const rows = await supabaseFetch(`cell_print_licenses?id=eq.${Number(b)}&owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=id,key,source,device_limit,marketplace_scope,activated_at,expires_at,duration_days&limit=1`);
    const key = rows[0];
    if (!key || isTrialKey(key)) return showShop(from, chatId, messageId, ['cp']);
    const scope = CP_SCOPES[key.marketplace_scope] ? key.marketplace_scope : 'wb';
    // Цена продления — по числу компьютеров и площадке самого ключа; «WB + Ozon» дороже (×1,8).
    return showScreen(chatId, messageId, `<b>🔄 Продление ключа «ПВЗ Принт»</b> <code>${escapeHtml(key.key)}</code>\n${cellKeyStatus(key)} · ${devicesLabel(key.device_limit)} · ${CP_SCOPES[scope]}\nЦена — для ${devicesLabel(key.device_limit)} и площадки ${CP_SCOPES[scope]}, как у ключа.\n\n${balanceLine}\n\nНа сколько продлить?`, { reply_markup: choiceKeyboard([
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
    // Пакет — это коды license_keys: их списывает и «Код <ID>» в боте (account.chargeClientCode), и программа.
    // Сам ключ пакета человеку не нужен — только остаток.
    const key = await ownLicenseKey(userId);
    const left = key ? Math.max(0, Number(key.usage_limit) - Number(key.used)) : 0;
    const text = [
      '<b>🔑 Пакет кодов клиента</b>',
      'Один код — один QR-код клиента. Работает и здесь в боте, и в программе «Помощник ПВЗ»: коды из пакета спишутся сами.',
      ...(left > 0 ? [`В вашем пакете осталось: ${left} — новые добавятся к ним.`] : []),
      balanceLine,
    ].join('\n');
    return showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
      ...Object.keys(LICENSE_PRICES).map(Number).map(count => [{ text: `${count} шт. — ${LICENSE_PRICES[count]} ₽`, callback_data: `shop:wbpk:${count}` }]),
      back('shop:home'),
    ]) });
  }
  // Последний шаг любой ветки — подтверждение оплаты.
  return showShopConfirm(from, chatId, messageId, userId, parts);
}

/**
 * Пополнить с запасом и купить: готовые суммы больше нехватки (500 ₽ и 1000 ₽ с бонусом) с той же покупкой then —
 * покупка пройдёт сама, остаток останется на балансе. Кнопка без then («другая сумма») потеряла бы покупку.
 */
function largerTopupRows(missingRub, then, minAmount) {
  const steps = [...wallet.TOPUP_BONUS_STEPS].map(([amount]) => amount).sort((a, b) => a - b);
  const buttons = steps.filter(amount => amount > minAmount && amount + wallet.topupBonus(amount) >= missingRub).map(amount => {
    const detailed = `tp:${amount}~${Math.round(Number(missingRub) * 100)}:${then}`;
    const data = Buffer.byteLength(detailed) <= 64 ? detailed : `tp:${amount}:${then}`;
    const bonus = wallet.topupBonus(amount);
    return Buffer.byteLength(data) <= 64 ? { text: `${wallet.formatRub(amount)}${bonus ? ` (+${wallet.formatRub(bonus)})` : ''}`, callback_data: data } : null;
  }).filter(Boolean);
  return buttons.length ? [buttons] : [];
}

async function showShopConfirm(from, chatId, messageId, userId, parts, error) {
  const item = await resolveShopItem(userId, parts);
  if (item.error) return showScreen(chatId, messageId, `⚠️ ${item.error}`, { reply_markup: choiceKeyboard([...(item.next ? [[item.next]] : []), [{ text: '⬅️ В магазин', callback_data: 'shop:home' }, ...MENU_ROW]]) });
  const balance = await walletRub(userId);
  const lines = [`${error ? `⚠️ ${error}\n` : ''}${item.title}`, `Цена: <b>${wallet.formatRub(item.priceRub)}</b>`];
  const backRow = [{ text: '⬅️ Назад', callback_data: item.back }, ...MENU_ROW];
  if (balance >= item.priceRub) {
    lines.push(`💰 На балансе: ${wallet.formatRub(balance)}`);
    // Метка на кнопке оплаты: повторное нажатие той же кнопки не спишет деньги второй раз.
    const nonce = crypto.randomInt(100000, 1000000);
    return showScreen(chatId, messageId, lines.join('\n'), { reply_markup: choiceKeyboard([
      [{ text: `✅ Оплатить ${wallet.formatRub(item.priceRub)} с баланса`, callback_data: `shop:pay:${nonce}:${parts.join(':')}` }],
      backRow,
    ]) });
  }
  const missing = item.priceRub - balance;
  const then = `shop:${parts.join(':')}`;
  const main = topupAndBuyRow(missing, then);
  const mainAmount = Math.max(wallet.MIN_TOPUP, Math.ceil(Number(missing) - 1e-9));
  const larger = largerTopupRows(missing, then, mainAmount);
  lines.push(`💰 На балансе: ${wallet.formatRub(balance)} — не хватает <b>${wallet.formatRub(missing)}</b>`);
  lines.push('После пополнения покупка пройдёт сама, ничего нажимать не нужно.');
  if (larger.length) {
    const bonusFrom = Math.min(...wallet.TOPUP_BONUS_STEPS.map(([amount]) => amount));
    lines.push(`Или пополните с запасом кнопками ниже: остаток останется на балансе, от ${wallet.formatRub(bonusFrom)} — с бонусом.`);
  }
  return showScreen(chatId, messageId, lines.join('\n'), { reply_markup: choiceKeyboard([
    main,
    ...larger,
    backRow,
  ]) });
}

/** screenId — где показывать ход оплаты, если не там же, где кнопка (автопокупка после пополнения). */
async function payShopItem(from, chatId, messageId, nonce, parts, screenId = messageId) {
  const userId = await ensureUser(from);
  const item = await resolveShopItem(userId, parts);
  if (item.error) return showShopConfirm(from, chatId, screenId, userId, parts);
  // id экрана с кнопкой, а не screenId: повторное уведомление о том же пополнении не купит второй раз
  const requestId = `shop:${from.id}:${messageId}:${nonce}`;
  if (!await claimGenerationRequest(requestId, from, chatId, { userId, shop: parts })) return;
  await showScreen(chatId, screenId, `${item.title}\n\n⏳ Оплачиваю с баланса…`);
  let result;
  try {
    result = await wallet.payWithWallet({ userId, productKind: item.productKind, fields: item.fields, priceRub: item.priceRub, snapshot: item.snapshot });
  } catch (error) {
    await supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', error: String(error.message || '').slice(0, 500), completed_at: new Date().toISOString() }) }).catch(() => {});
    if (error.code === 'ACCOUNT_RESTRICTED') {
      return showScreen(chatId, screenId, `⛔ ${escapeHtml(error.message)}`, { reply_markup: choiceKeyboard([[{ text: '⬅️ В магазин', callback_data: 'shop:home' }], MENU_ROW]) });
    }
    return showShopFailure(from, chatId, screenId, userId, parts, item, error);
  }
  if (!result.ok) {
    await supabaseFetch(`telegram_generation_requests?request_id=eq.${encodeURIComponent(requestId)}`, { method: 'DELETE' }).catch(() => {});
    return showShopConfirm(from, chatId, screenId, userId, parts, 'Денег на балансе не хватает.');
  }
  await completeGenerationRequest(requestId, { orderId: result.order.id });
  const order = result.order;
  const balanceLine = `💰 На балансе: ${wallet.formatRub(result.balanceKopecks / 100)}`;
  let done;
  let rows = [[{ text: '👤 Профиль', callback_data: 'menu:profile' }, { text: '🛒 Ещё покупка', callback_data: 'shop:home' }], MENU_ROW];
  if (item.productKind === 'app_subscription') {
    done = await subscriptionDoneText(userId, item.fields.app_plan);
  } else if (item.productKind === 'cell_print_license') {
    if (item.renewal) {
      done = `Ключ «ПВЗ Принт» <code>${escapeHtml(order.cell_print_license_key)}</code> продлён на ${item.fields.cell_print_duration_days} дней. В программе ничего вводить не нужно.`;
    } else {
      // Ключ — отдельным сообщением без кнопок: его никто не отредактирует следующим нажатием, и он не пропадёт.
      const keySent = await sendMessage(chatId, cellKeyMessage(order.cell_print_license_key, item.fields))
        .then(() => true, error => { console.warn('Cell print key message failed', error.message); return false; });
      // Сообщение с ключом не ушло — ключ прямо здесь, а не «в сообщении ниже», которого нет.
      done = keySent
        ? 'Ключ «ПВЗ Принт» куплен — он в сообщении ниже ⬇️ Там же — как его включить.'
        : `Ключ «ПВЗ Принт» куплен: <code>${escapeHtml(order.cell_print_license_key)}</code> (нажмите, чтобы скопировать). В программе вставьте его в блок «Ключ без аккаунта» и нажмите «Активировать». Ключ всегда виден в «👤 Профиль и баланс».`;
    }
    rows = [[{ text: '🖨 Мои ключи', callback_data: 'shop:cp' }, { text: '👤 Профиль', callback_data: 'menu:profile' }], MENU_ROW];
  } else if (item.productKind === 'stickers') {
    done = `Пакет куплен: ${item.fields.custom_quantity} стикеров по номеру. Вводить ничего не нужно — они спишутся сами при создании.`;
  } else {
    done = `+${item.fields.license_iterations} кодов клиента в пакете. Они спишутся сами — здесь в боте («Код клиента») и в «Помощнике ПВЗ».`;
    // Покупали из-за запроса с компьютера («Бесплатных кодов не осталось») — сразу кнопка выдачи: код спишется из пакета.
    const pending = await approvals.pendingFor(userId).catch(() => []);
    if (pending.length) {
      done += `\nЖдёт решения запрос QR с компьютера${pending.length > 1 ? ` (всего ${pending.length})` : ''} — выдайте его кнопкой ниже.`;
      rows = [
        ...pending.slice(0, 3).map(r => [{ text: `✅ Выдать QR по запросу${r.cell ? ` · яч. ${r.cell}` : ''}`.slice(0, 60), callback_data: `cq:ok:${r.id}` }]),
        ...rows,
      ];
    }
  }
  if (item.returnToGenerator) rows = [[{ text: '🏷 Создать стикер', callback_data: 'gen:return-mode' }], MENU_ROW];
  await showScreen(chatId, screenId, `<b>Готово ✅</b> ${done}\n${balanceLine}`, { reply_markup: choiceKeyboard(rows) });
}

/** Сообщение с купленным ключом «ПВЗ Принт»: ключ в <code>, что куплено и два шага, как включить. */
function cellKeyMessage(key, fields) {
  const scope = CP_SCOPES[fields.cell_print_marketplace_scope];
  return [
    '<b>🖨 Ваш ключ «ПВЗ Принт»</b> (нажмите, чтобы скопировать):',
    `<code>${escapeHtml(key)}</code>`,
    `${fields.cell_print_duration_days} дней · ${devicesLabel(Number(fields.cell_print_device_limit) || 1)}${scope ? ` · ${scope}` : ''}. Срок начнётся, когда вы первый раз включите ключ в программе.`,
    '',
    'Как включить:',
    `1. Скачайте «ПВЗ Принт» на компьютер пункта: ${CELL_PRINT_URL}`,
    '2. В программе вставьте ключ в блок «Ключ без аккаунта» и нажмите «Активировать».',
    '',
    'Ключ всегда виден в «👤 Профиль и баланс».',
  ].join('\n');
}

/**
 * «Готово» подписки «Помощника»: до какого числа (а при понижении — с какого начнётся) и что дальше — скачать
 * программу и войти через этого бота (страница входа /app-login → «Подтвердить в Telegram-боте», этап A2).
 */
async function subscriptionDoneText(userId, planId) {
  const ent = await supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) }).catch(() => null);
  const title = PLANS[planId]?.title || '';
  const until = ent?.paid_until || ent?.ends_at;
  // Понижение встаёт в очередь: сейчас действует прежний тариф, купленный начнётся после него.
  const queued = ent?.plan && ent.plan !== planId && ent.ends_at;
  const when = queued
    ? ` Начнётся ${dayMonthShort(ent.ends_at)}, после текущей подписки${until ? `, и будет действовать до <b>${dayMonthShort(until)}</b>` : ''}.`
    : until ? ` Действует до <b>${dayMonthShort(until)}</b>.` : '';
  return [
    `Подписка «Помощник ПВЗ» оплачена: тариф «${title}».${when}`,
    '',
    'Что дальше:',
    `1. Скачайте «Помощник ПВЗ» на компьютер пункта: ${PROGRAM_URL}`,
    '2. В программе нажмите «Войти через сайт», на открывшейся странице — «Подтвердить в Telegram-боте», и подтвердите вход здесь. Подписка подключится сама.',
    '',
    'Уже входите в программу по почте и паролю? Напишите в поддержку — перенесём подписку на тот аккаунт.',
  ].join('\n');
}

/**
 * Покупка с баланса упала. Текст — по тому, что стало с деньгами (error.walletOutcome, server/_wallet.js), баланс —
 * перечитанный, без текста ошибки (он в журнал). Возврат не удался — деньги вернёт поддержка, админам сигнал.
 */
async function showShopFailure(from, chatId, screenId, userId, parts, item, error) {
  const incident = crypto.randomBytes(3).toString('hex');
  console.error(`Wallet purchase failed [${incident}]`, item.productKind, error.walletOutcome || 'unknown', error.orderId || '', error.message);
  const balance = await walletRub(userId).catch(() => null);
  const balanceLine = balance != null ? `💰 На балансе: ${wallet.formatRub(balance)}` : '';
  const support = [{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }];
  if (error.walletOutcome === 'refund_failed') {
    sendToAdmins(`⚠️ Покупка с баланса: списано ${wallet.formatRub(item.priceRub)}, выдача не прошла, возврат не удался.\nTelegram ${Number(from.id)}, заказ ${error.orderId || '—'}, код ${incident}. Верните деньги вручную.`).catch(() => {});
    return showScreen(chatId, screenId, [
      '⚠️ Покупка не прошла, и деньги за неё пока не вернулись на баланс — это сбой на нашей стороне.',
      `Напишите в поддержку и назовите код: <code>${incident}</code> — вернём ${wallet.formatRub(item.priceRub)} вручную.`,
      ...(balanceLine ? [balanceLine] : []),
    ].join('\n'), { reply_markup: choiceKeyboard([support, MENU_ROW]) });
  }
  if (error.walletOutcome === 'unknown') {
    // Ответ списания потерялся: оно ещё может пройти позже, поэтому ни «не списаны», ни «попробуйте ещё раз».
    sendToAdmins(`⚠️ Покупка с баланса: ответ списания потерялся, итог неясен (${wallet.formatRub(item.priceRub)}).\nTelegram ${Number(from.id)}, заказ ${error.orderId || '—'}, код ${incident}. Проверьте журнал баланса по заказу.`).catch(() => {});
    return showScreen(chatId, screenId, [
      '⚠️ Покупка не прошла — это сбой на нашей стороне. Списались ли деньги, пока не ясно.',
      'Проверьте баланс через минуту в «👤 Профиль и баланс». Если деньги списались, а покупки нет — напишите в поддержку, вернём.',
      `Код обращения: <code>${incident}</code>`,
    ].join('\n'), { reply_markup: choiceKeyboard([
      [{ text: '👤 Профиль и баланс', callback_data: 'menu:profile' }],
      support,
      MENU_ROW,
    ]) });
  }
  const money = error.walletOutcome === 'refunded' ? 'Деньги за неё вернулись на баланс.'
    : error.walletOutcome === 'not_charged' ? 'Деньги за неё не списаны.'
      : 'Проверьте баланс ниже.';
  return showScreen(chatId, screenId, [
    `⚠️ Покупка не прошла — это сбой на нашей стороне. ${money}`,
    ...(balanceLine ? [balanceLine] : []),
    `Попробуйте ещё раз. Если повторится — напишите в поддержку и назовите код: <code>${incident}</code>`,
  ].join('\n'), { reply_markup: choiceKeyboard([
    [{ text: '🔄 Попробовать снова', callback_data: `shop:${parts.join(':')}` }],
    support,
    [{ text: '⬅️ В магазин', callback_data: 'shop:home' }, ...MENU_ROW],
  ]) });
}

// ── Рефералка (поверх referral_accounts / bind_referral сайта, миграция 20261025_bot_referrals.sql) ──

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

/** Переход из этого Telegram уже привязан к аккаунту (bind_referral прошёл). Сбой чтения — «нет». */
async function referralBoundTo(telegramId, userId) {
  const rows = await supabaseFetch(`telegram_referral_captures?telegram_user_id=eq.${Number(telegramId)}&bound_user_id=eq.${encodeURIComponent(userId)}&select=telegram_user_id&limit=1`).catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * /start r_<КОД>: запомнить, кто пригласил. Первый переход побеждает; если аккаунт уже есть,
 * привязать нельзя (приглашение считается только для новых) — ничего не сохраняем.
 * → 'new' (переход записан) | 'already_captured' (переход был раньше: аккаунта ещё нет или приглашение
 *   ему уже засчитано) | 'existing' (уже пользовался ботом) | 'unknown' (такого кода нет).
 */
async function captureReferral(from, rawCode) {
  const code = String(rawCode).toUpperCase();
  const userId = await findUser(from.id);
  // Аккаунт создаётся сразу после первого перехода, и Telegram шлёт /start r_… при каждом открытии ссылки:
  // если приглашение этому аккаунту уже засчитано, повторный переход — то же приветствие, а не «только новым».
  if (userId) return (await referralBoundTo(from.id, userId)) ? 'already_captured' : 'existing';
  const [owners, aliases] = await Promise.all([
    supabaseFetch(`referral_accounts?referral_code=eq.${encodeURIComponent(code)}&select=user_id&limit=1`),
    supabaseFetch(`referral_code_aliases?referral_code=eq.${encodeURIComponent(code)}&select=user_id&limit=1`),
  ]);
  if (!owners.length && !aliases.length) return 'unknown';
  const rows = await supabaseFetch('telegram_referral_captures?on_conflict=telegram_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ telegram_user_id: Number(from.id), referral_code: code }),
  });
  return Array.isArray(rows) && rows.length > 0 ? 'new' : 'already_captured';
}

/**
 * Кабинет для этого Telegram только что создан — привязываем к пригласившему (bind_referral проверит,
 * что переход был до регистрации и не раньше 30 дней) и сообщаем пригласившему в бот.
 */
async function bindTelegramReferral(telegramId, userId) {
  // Вход виджетом на сайте: связка записана там, кеш узла бота об этом не знает.
  userCache.forgetTelegramUser(telegramId);
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
      reply_markup: noticeMarkup({ inline_keyboard: botTexts.REFERRAL_KEYBOARD }),
    }).catch(() => {});
  }
  return true;
}

/**
 * «Переводить нечего»: если вознаграждение уже начислялось — значит, его уже перевели или вывели
 * (в том числе вторым нажатием «✅ Перевести на баланс»), а не «ещё не начислено».
 */
function referralNothingText(earnedKopecks) {
  return Number(earnedKopecks || 0) > 0
    ? '⚠️ Переводить нечего — всё доступное уже переведено.'
    : '⚠️ Переводить пока нечего — вознаграждение ещё не начислено.';
}

/** Ограничение «Выводы» (или всё): перевод и вывод вознаграждения закрыты — строка для экрана приглашений. */
function referralRestrictedText(restriction) {
  return `⛔ Перевод и вывод вознаграждения сейчас недоступны. ${escapeHtml(restriction.message)}`;
}

/**
 * Экран «👥 Пригласить коллегу»: механика одной фразой, ссылка, три числа и как забрать деньги.
 * notice — строка сверху (итог перевода, ограничение); restricted — ограничение «Выводы»: вместо перевода и
 * вывода только кнопка поддержки; nothing — сверху «переводить нечего» (текст по начисленному).
 */
async function showReferrals(from, chatId, messageId, notice, { restricted = false, nothing = false } = {}) {
  const userId = await ensureUser(from);
  const account = await supabaseFetch('rpc/ensure_referral_account', { method: 'POST', body: JSON.stringify({ p_user_id: userId }) });
  const [invited, links] = await Promise.all([
    supabaseFetch(`referral_attributions?referrer_user_id=eq.${encodeURIComponent(userId)}&select=invited_user_id`).catch(() => []),
    referralLinks(account.referral_code),
  ]);
  const available = Number(account.available_kopecks || 0) / 100;
  const earned = Number(account.earned_kopecks || 0) / 100;
  const minWithdraw = wallet.formatRub(REFERRAL_WITHDRAW_MIN_RUB);
  // nothing — «переводить нечего»: текст зависит от того, начислялось ли вознаграждение (см. referralNothingText).
  if (nothing) notice = referralNothingText(account.earned_kopecks);
  const text = [
    ...(notice ? [notice, ''] : []),
    '<b>👥 Пригласить коллегу</b>',
    // Не «с пополнений»: award_referral_order начисляет с любой оплаты картой, в том числе на сайте (база общая).
    `Коллега открывает бота по вашей ссылке — вам ${REFERRAL_PERCENT}% с каждой его оплаты картой (в боте — с пополнений баланса).`,
    'Засчитываются только те, кто раньше не пользовался ботом.',
    '',
    'Ваша ссылка (нажмите, чтобы скопировать):',
    // В <code> Telegram копирует текст по нажатию, а не открывает ссылку.
    `<code>${escapeHtml(links.telegram || links.site)}</code>`,
    '',
    `Приглашено: <b>${invited.length}</b>`,
    `Начислено всего: <b>${wallet.formatRub(earned)}</b>`,
    `Можно забрать: <b>${wallet.formatRub(available)}</b> — на баланс бота или на карту (от ${minWithdraw}, через поддержку).`,
  ].join('\n');
  const share = links.telegram || links.site;
  const shareText = 'Стикеры и QR для возвратов WB, код клиента и отзывы ПВЗ — бот shk-wb.ru';
  // При ограничении «Выводы» кнопок перевода и вывода нет: они вели бы по кругу на этот же экран.
  const canTransfer = available > 0 && !restricted;
  const canWithdraw = available >= REFERRAL_WITHDRAW_MIN_RUB && !restricted;
  await showScreen(chatId, messageId, text, { reply_markup: choiceKeyboard([
    // copy_text (Bot API 7.11) — кнопка кладёт ссылку в буфер обмена.
    [{ text: '📋 Скопировать ссылку', copy_text: { text: share } }],
    [{ text: '📤 Поделиться ссылкой', url: `https://t.me/share/url?url=${encodeURIComponent(share)}&text=${encodeURIComponent(shareText)}` }],
    // Перевод — через подтверждение (ref:towallet → ref:towallet:yes): обратно на карту его уже не вывести.
    ...(canTransfer ? [[{ text: `💰 Перевести ${wallet.formatRub(available)} на баланс`, callback_data: 'ref:towallet' }]] : []),
    // Вывод — через поддержку (сайт для этого не нужен); кнопка только когда сумма уже доступна к выводу.
    ...(canWithdraw ? [[{ text: '🏦 Вывести на карту — через поддержку', url: SUPPORT_URL }]] : []),
    ...(restricted ? [[{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }]] : []),
    [{ text: '⬅️ Профиль', callback_data: 'menu:profile' }, ...MENU_ROW],
  ]) });
}

/** Ограничение вывода → экран приглашений с объяснением и кнопкой поддержки; иначе null. */
async function referralRestricted(from, chatId, messageId, userId) {
  const restriction = await controls.restrictionFor(userId);
  if (!controls.covers(restriction, 'withdrawals')) return null;
  await showReferrals(from, chatId, messageId, referralRestrictedText(restriction), { restricted: true });
  return true;
}

/** «💰 Перевести на баланс» — сначала вопрос: с баланса деньги на карту уже не вывести. */
async function confirmReferralToWallet(from, chatId, messageId) {
  const userId = await findUser(from.id);
  if (!userId) return showReferrals(from, chatId, messageId);
  if (await referralRestricted(from, chatId, messageId, userId)) return;
  const account = await supabaseFetch('rpc/ensure_referral_account', { method: 'POST', body: JSON.stringify({ p_user_id: userId }) });
  const available = Number(account?.available_kopecks || 0) / 100;
  if (!(available > 0)) return showReferrals(from, chatId, messageId, null, { nothing: true });
  return showScreen(chatId, messageId, [
    `<b>Перевести ${wallet.formatRub(available)} на баланс бота?</b>`,
    '',
    'С баланса деньги тратятся на покупки в боте. Вывести их на карту после перевода будет нельзя.',
  ].join('\n'), { reply_markup: choiceKeyboard([
    [{ text: '✅ Перевести на баланс', callback_data: 'ref:towallet:yes' }],
    [{ text: '⬅️ Назад', callback_data: 'menu:ref' }, ...MENU_ROW],
  ]) });
}

async function referralToWallet(from, chatId, messageId) {
  const userId = await findUser(from.id);
  if (!userId) return showReferrals(from, chatId, messageId);
  if (await referralRestricted(from, chatId, messageId, userId)) return;
  // p_kopecks: null — вся доступная сумма на момент нажатия (rpc переводит атомарно; второе нажатие — «нечего»).
  const result = await supabaseFetch('rpc/referral_to_wallet', { method: 'POST', body: JSON.stringify({ p_user: userId, p_kopecks: null }) });
  if (!result?.ok) return showReferrals(from, chatId, messageId, null, { nothing: true });
  return showReferrals(from, chatId, messageId,
    `✅ Переведено ${wallet.formatRub(Number(result.moved) / 100)} на баланс. На балансе: ${wallet.formatRub(Number(result.wallet_balance) / 100)}.`);
}

/**
 * После оплаты пополнения «💳 Пополнить на X ₽ и купить» — сразу провести покупку, ради которой
 * пополняли (pricing_snapshot.wallet.then). Вызывается из notifyCompleted один раз на заказ.
 * Возвращает true, если покупка запущена; false — пусть пользователь вернётся к ней сам.
 * noticeId — сообщение «Баланс пополнен…» внизу чата: итог покупки показываем в нём, а не в старом экране выше.
 */
async function afterWalletTopup(order, noticeId = null) {
  const then = String(order?.pricing_snapshot?.wallet?.then || '');
  if (!then || !order.user_id) return false;
  const tg = await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(order.user_id)}&select=telegram_user_id&limit=1`);
  const telegramId = Number(tg[0]?.telegram_user_id);
  if (!telegramId) return false;
  const from = { id: telegramId }, chatId = telegramId;
  const messageId = Number(order.pricing_snapshot.wallet.message) || null;
  if (then === 'gen') {
    const session = await getSession(telegramId);
    if (session?.state !== 'confirm' || !session.draft?.mode || session.draft.accessCode) {
      // Выбор успел сброситься (ушли в другой раздел, истекло время): говорим прямо и ведём в мастер.
      const text = '<b>Баланс пополнен ✅</b>\nСтикер не создан: выбор успел сброситься. Деньги на балансе, платить второй раз не нужно — нажмите «🏷 Стикеры и QR коробок» и повторите.';
      const keyboard = { reply_markup: choiceKeyboard([[{ text: '🏷 Стикеры и QR коробок', callback_data: 'menu:stickers' }], MENU_ROW]) };
      if (noticeId) await showScreen(chatId, noticeId, text, keyboard);
      else await sendMessage(chatId, text, keyboard);
      return true;
    }
    await runGeneration(from, chatId, session.draft.msgId, session, { noticeId });
    return true;
  }
  // Итог этих покупок приходит новым сообщением ниже — «Оплачиваю покупку…» в уведомлении меняем на «итог ниже».
  // Старый экран оплаты выше (rv / qr) — без живой ссылки «Перейти к оплате»; экран запроса с ПК (cqa) правит сам запрос.
  const settleNotice = async (withScreen = true) => {
    if (noticeId) await editMessageText(chatId, noticeId, `<b>Баланс пополнен ✅</b>\n${topupScreen.creditedLine(topupScreen.topupAmounts(order))} — итог ниже ⬇️`).catch(() => {});
    if (withScreen && messageId && messageId !== noticeId) await editMessageText(chatId, messageId, 'Баланс пополнен — итог ниже ⬇️').catch(() => {});
  };
  const review = /^rv:(all|[1-5]):(\d+):(\d)(?::([0-9a-f]{8}))?$/.exec(then);
  if (review) {
    await settleNotice();
    try {
      await showReviewAuthorByPosition(from, chatId, review[1], Number(review[2]), Number(review[3]), review[4], reviewTopupMessage(telegramId, then));
    } catch (error) {
      // Вызов идёт мимо processUpdate (с сайта по RPC) — ошибку WB разбираем здесь: деньги уже на балансе.
      const retry = `rv:who2:${review[1]}:${review[2]}:${review[3]}${review[4] ? `:${review[4]}` : ''}`;
      if (!await replyWbFailure(from, chatId, error, { purpose: 'reviews', retry, note: 'Баланс пополнен — деньги на балансе, автор пока не открыт.' })) throw error;
    }
    return true;
  }
  const qr = /^qr:(\d{1,12})$/.exec(then);
  if (qr) {
    await settleNotice();
    await handleClientCode(from, chatId, qr[1]);
    return true;
  }
  // «Пополнить и выдать» по запросу QR с компьютера (server/_code-approvals.js)
  const approval = /^cqa:([0-9a-f-]{36})$/.exec(then);
  if (approval) {
    const head = `<b>Баланс пополнен ✅</b>
${topupScreen.creditedLine(topupScreen.topupAmounts(order))}`;
    return afterTopupApproval(from, chatId, approval[1], { noticeId, screenId: messageId, head });
  }
  if (then.startsWith('shop:')) {
    // Метка оплаты из id заказа: повторный вызов по тому же заказу не купит второй раз.
    const nonce = parseInt(String(order.id).replace(/-/g, '').slice(0, 8), 16) % 1000000;
    // Старый экран покупки выше по чату: убираем кнопку «Пополнить и купить», чтобы не оплатили второй раз.
    if (messageId && noticeId) await editMessageText(chatId, messageId, 'Баланс пополнен — итог покупки ниже ⬇️').catch(() => {});
    await payShopItem(from, chatId, messageId, nonce, then.slice('shop:'.length).split(':'), noticeId || messageId);
    return true;
  }
  return false;
}

/** Вход в WB ждал телефон или код — отменить (готовый вход и выбор пункта не трогаем). */
async function cancelWbLogin(from, chatId) {
  const wb = await getWbConnection(from.id);
  if (wb && (wb.state === 'await_phone' || wb.state === 'await_code')) await saveWbConnection(from, chatId, 'idle', wb.session);
}

/**
 * Человек ушёл в другой раздел (кнопкой меню, командой или /start) — незаконченный ввод больше не ждём:
 * иначе следующее сообщение (цифры, фото) съест старый шаг. Три независимых запроса — параллельно: черновик
 * мастера, незаконченный вход в WB и связка с аккаунтом (греет кеш для экрана, который откроется ниже).
 * item — куда ушли: 'stickers' мастер сам перезапишет, 'reviews' продолжает начатый вход в WB.
 */
async function resetPending(from, chatId, item) {
  await Promise.all([
    item !== 'stickers' ? clearSession(from.id).catch(() => {}) : null,
    item !== 'reviews' ? cancelWbLogin(from, chatId).catch(() => {}) : null,
    findUser(from.id).catch(() => null),
  ]);
}

/** Пункты меню открываются в том же сообщении (messageId), «☰ Меню» возвращает его обратно. */
async function handleMenu(from, chatId, item, messageId) {
  await resetPending(from, chatId, item);
  if (item === 'stickers') return startGeneration(from, chatId, messageId);
  if (item === 'code') return showClientCode(chatId, messageId, from);
  if (item === 'reviews') return showReviewFilters(from, chatId, messageId);
  if (item === 'helper') return showHelperInfo(chatId, messageId);
  if (item === 'cellprint') return showCellPrintInfo(chatId, messageId);
  if (item === 'profile') return showProfile(from, chatId, messageId);
  // «Помощь» — справка и поддержка вместе. menu:support — кнопка из прежних сообщений; menu:login — кнопка «Войти»
  // из старых сообщений: входить никуда не нужно, связать бота с аккаунтом сайта может поддержка.
  if (item === 'help' || item === 'support' || item === 'login') return showHelp(from, chatId, messageId);
  if (item === 'ref') return showReferrals(from, chatId, messageId);
  return showMainMenu(from, chatId, messageId);
}

// Команды и подписи старой постоянной клавиатуры → раздел (обработка — в handleMessage). /help и /cancel — отдельно.
const TEXT_COMMANDS = {
  menu: 'menu', generate: 'stickers', stickers: 'stickers', code: 'code', profile: 'profile', account: 'profile',
  balance: 'balance', topup: 'balance', invite: 'invite', reviews: 'reviews', orders: 'orders',
};
const LEGACY_TARGETS = {
  '☰ Меню': 'menu', '🌐 Открыть сайт': 'menu', '➕ Создать ШК': 'stickers', '🏷 Стикеры и QR': 'stickers',
  '🏷 Стикеры для товаров': 'product', '📦 QR для коробок': 'box', '💳 Остаток': 'profile', '👤 Аккаунт': 'profile',
  '⭐ Отзывы ПВЗ': 'reviews', '📦 Мои индивидуальные заказы': 'orders',
};

function commandTarget(text) {
  const command = /^\/([a-z]+)(?:@\w+)?$/i.exec(text);
  if (command) return TEXT_COMMANDS[command[1].toLowerCase()] || null;
  return LEGACY_TARGETS[text] || null;
}

/** Ответ на сообщение, которого бот не ждал: что он умеет без кнопок и где человек. */
async function unknownInputNotice(from, text) {
  const free = clientCodeFreeFor(from.id);
  const { price } = free ? { price: 0 } : await clientCodePrice(from.id).catch(() => ({ price: CLIENT_CODE_PRICE }));
  return [
    /^\//.test(text) ? 'Такой команды нет.' : 'Я работаю по кнопкам ниже и не отвечаю на сообщения в свободной форме.',
    '',
    'Быстрые способы:',
    '• пришлите фото или номер ШК (11 цифр) — сделаю стикер;',
    `• напишите <code>Код 191607973</code> — пришлю QR клиента (${free ? 'бесплатно' : `${wallet.formatRub(price)} или 1 код из тарифа`}).`,
    '',
    'Нужен человек — «🆘 Помощь».',
  ].join('\n');
}

/** /start club_reviews: сначала польза и цена «Отзывов ПВЗ», потом (если нужно) вход в WB. */
async function reviewsIntroText(from) {
  const [club, connection] = await Promise.all([
    clubInfo(from.id),
    getWbConnection(from.id).catch(() => null),
  ]);
  const price = club.active ? applyClubDiscount(REVIEW_PRICE) : REVIEW_PRICE;
  const ready = connection?.session?.token && connection.state === 'ready';
  return [
    greetingTitle(from),
    '',
    '<b>⭐ Отзывы ПВЗ</b>',
    `Покажу отзывы вашего пункта — смотреть бесплатно. Узнать, кто поставил оценку (ячейка, когда забрал, телефон — WB скрывает часть цифр), — ${wallet.formatRub(price)} с баланса.`,
    // Сюда приходят только по кнопке из группы клуба (/start club_reviews) — сбой проверки тоже называем.
    ...clubStatusLines(club, { fromClub: true, menu: true }),
    ...(ready ? [] : ['', 'Для этого нужен вход в WB — по номеру телефона и коду от WB, как в программе WB на пункте.']),
  ].join('\n');
}

// Начисление бонусов: /bonus <@ник | ссылка t.me | Telegram ID> <сумма> [комментарий]. Только эти Telegram ID.
const BONUS_ADMIN_IDS = new Set(['439335621']);
const MAX_BONUS_RUB = 10000;
const BONUS_USAGE = [
  '<b>🎁 Начислить бонус</b>',
  '',
  '<code>/bonus @ник сумма комментарий</code>',
  '',
  'Вместо ника можно указать ссылку t.me или Telegram ID. Комментарий необязателен, его увидит пользователь.',
  `Сумма — от 1 до ${MAX_BONUS_RUB.toLocaleString('ru-RU')} ₽.`,
  '',
  'Пример: <code>/bonus @ivanov 100 За помощь с тестом</code>',
].join('\n');

// Подтверждения ждут в памяти процесса: state в telegram_generator_sessions ограничен CHECK-списком, а тут база
// не нужна. Перезапуск бота просто делает кнопку устаревшей — денег это не касается.
const BONUS_CONFIRM_TTL_MS = 15 * 60 * 1000;
const pendingBonuses = new Map();

function isBonusAdmin(telegramId) { return BONUS_ADMIN_IDS.has(String(telegramId)); }

function parseBonusCommand(text) {
  const match = /^\/bonus(?:@\w+)?(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+([\s\S]+))?$/i.exec(String(text || '').trim());
  if (!match) return null;
  if (!match[1] || !match[2]) return { ok: false, error: '' };
  const who = match[1].replace(/^https?:\/\//i, '').replace(/^t\.me\//i, '').replace(/^@/, '').replace(/\/+$/, '');
  const target = /^\d{4,15}$/.test(who) ? { telegramId: Number(who) }
    : /^[A-Za-z0-9_]{4,32}$/.test(who) ? { username: who } : null;
  if (!target) return { ok: false, error: 'Не понял, кому начислить: нужен @ник, ссылка t.me или Telegram ID.' };
  if (!/^\d{1,5}(?:[.,]\d{1,2})?$/.test(match[2])) return { ok: false, error: 'Сумма должна быть числом, например 100 или 99,50.' };
  const kopecks = Math.round(Number(match[2].replace(',', '.')) * 100);
  if (kopecks < 100 || kopecks > MAX_BONUS_RUB * 100) return { ok: false, error: `Сумма — от 1 до ${MAX_BONUS_RUB.toLocaleString('ru-RU')} ₽.` };
  return { ok: true, ...target, kopecks, note: String(match[3] || '').trim().slice(0, 200) };
}

async function findBonusRecipient({ telegramId, username }) {
  const fields = 'select=telegram_user_id,chat_id,username,first_name,last_name';
  const rows = telegramId
    ? await supabaseFetch(`telegram_bot_subscribers?telegram_user_id=eq.${telegramId}&${fields}&limit=1`)
    // В ilike символ _ — подстановочный, поэтому точное совпадение проверяем ещё раз здесь.
    : (await supabaseFetch(`telegram_bot_subscribers?username=ilike.${encodeURIComponent(username)}&${fields}&limit=5`))
      .filter(row => String(row.username || '').toLowerCase() === username.toLowerCase());
  return rows[0] || null;
}

function bonusRecipientName(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ');
  return [name, row.username ? `@${row.username}` : ''].filter(Boolean).join(' ') || `ID ${row.telegram_user_id}`;
}

// Тот же текст, что у начисления из админки (walletAdjust): одно событие — один текст (server/_bot-texts.js).
function bonusNoticeText({ kopecks, note, balanceKopecks }) {
  return botTexts.supportMoneyNoticeHtml({ kopecks, note, balanceKopecks });
}

async function startBonus(from, chatId, parsed) {
  if (!parsed.ok) return sendMessage(chatId, parsed.error ? `⚠️ ${parsed.error}\n\n${BONUS_USAGE}` : BONUS_USAGE);
  const recipient = await findBonusRecipient(parsed);
  if (!recipient) return sendMessage(chatId, '⚠️ Такого пользователя нет среди тех, кто запускал бота. Проверьте ник или укажите Telegram ID.');
  // Кабинета ещё нет — создаём сам, как при первом действии в боте: подписчик известен из telegram_bot_subscribers.
  const targetUser = await ensureUser({ id: recipient.telegram_user_id, username: recipient.username, first_name: recipient.first_name, last_name: recipient.last_name });
  const balance = await wallet.getBalanceKopecks(targetUser);
  const nonce = crypto.randomBytes(6).toString('hex');
  for (const [key, item] of pendingBonuses) if (item.expiresAt <= Date.now()) pendingBonuses.delete(key);
  pendingBonuses.set(nonce, { adminId: Number(from.id), expiresAt: Date.now() + BONUS_CONFIRM_TTL_MS, targetUser, telegramId: recipient.telegram_user_id, chatId: recipient.chat_id, name: bonusRecipientName(recipient), kopecks: parsed.kopecks, note: parsed.note });
  await sendMessage(chatId, [
    '<b>🎁 Начислить бонус?</b>',
    '',
    `Кому: ${escapeHtml(bonusRecipientName(recipient))} (ID <code>${recipient.telegram_user_id}</code>)`,
    `Сумма: <b>+${wallet.formatRub(parsed.kopecks / 100)}</b>`,
    `Сейчас на балансе: ${wallet.formatRub(balance / 100)}`,
    ...(parsed.note ? [`Комментарий: ${escapeHtml(parsed.note)}`] : []),
  ].join('\n'), { reply_markup: choiceKeyboard([
    [{ text: '✅ Начислить', callback_data: `bn:ok:${nonce}` }, { text: 'Отмена', callback_data: `bn:no:${nonce}` }],
  ]) });
}

async function finishBonus(from, chatId, messageId, action, nonce) {
  const bonus = pendingBonuses.get(nonce);
  // Убираем сразу: второе нажатие не дойдёт до начисления, а при ошибке начисления команду отправляют заново.
  pendingBonuses.delete(nonce);
  if (!bonus || bonus.adminId !== Number(from.id) || bonus.expiresAt <= Date.now()) return showScreen(chatId, messageId, 'Это подтверждение устарело. Деньги не начислены, отправьте /bonus заново.', { reply_markup: MENU_KEYBOARD });
  if (action === 'no') {
    return showScreen(chatId, messageId, 'Начисление отменено.', { reply_markup: MENU_KEYBOARD });
  }
  const result = await wallet.grantBonus({ userId: bonus.targetUser, kopecks: bonus.kopecks, eventKey: `admin_bonus:${nonce}`, note: bonus.note, adminTelegramId: from.id });
  if (result.duplicate) return showScreen(chatId, messageId, 'Этот бонус уже начислен, повторно деньги не зачислялись.', { reply_markup: MENU_KEYBOARD });
  console.log(`bot bonus by ${from.id} to ${bonus.telegramId} ${bonus.kopecks} kopecks`);
  const delivered = await sendMessage(bonus.chatId || bonus.telegramId, bonusNoticeText({ kopecks: bonus.kopecks, note: bonus.note, balanceKopecks: result.balanceKopecks }), { reply_markup: noticeMarkup({ inline_keyboard: botTexts.MONEY_KEYBOARD }) })
    .then(() => true)
    .catch(error => { console.warn('Бонус: уведомление не доставлено', error?.message || error); return false; });
  return showScreen(chatId, messageId, [
    `✅ Начислено <b>+${wallet.formatRub(bonus.kopecks / 100)}</b>: ${escapeHtml(bonus.name)}`,
    `На балансе теперь: ${wallet.formatRub(result.balanceKopecks / 100)}`,
    delivered ? 'Пользователь получил уведомление.' : '⚠️ Деньги начислены, но уведомление не доставлено: возможно, пользователь заблокировал бота.',
  ].join('\n'), { reply_markup: MENU_KEYBOARD });
}

const STALE_ACTION_TEXT = 'Это действие уже завершено или отменено. Начните заново кнопкой ниже.';
const RESULT_GONE_TEXT = 'Этот файл больше не хранится. Создайте стикер заново.';
const RESULT_GONE_KEYBOARD = choiceKeyboard([[{ text: '🏷 Стикеры и QR коробок', callback_data: 'menu:stickers' }], MENU_ROW]);

async function handleCallback(callback) {
  const from = callback.from, chatId = callback.message?.chat?.id;
  if (!chatId) return;
  // «Последний визит» — в фоне: ответ человеку его не ждёт.
  touchSubscriber(from, chatId).catch(error => console.warn('Подписчик бота: запись визита', error?.message || error));
  let data = String(callback.data || '');
  let messageId = callback.message?.message_id;
  // Кнопка под уведомлением (n:<callback>, server/_bot-notice.js): уведомление остаётся в чате — снимаем с него
  // кнопки-переходы (действия вроде «🚫 Это не я» остаются), а экран открываем новым сообщением.
  if (data.startsWith(NOTICE_PREFIX)) {
    data = data.slice(NOTICE_PREFIX.length);
    if (messageId) {
      telegramRequest('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keptRows(callback.message?.reply_markup) } })
        .catch(error => console.warn('Уведомление: кнопки не сняты', error?.message || error));
    }
    messageId = undefined;
  }
  if (data.startsWith('menu:')) { answerCallbackQuery(callback.id).catch(() => {}); await handleMenu(from, chatId, data.slice('menu:'.length), messageId); return; }
  const bonusAction = /^bn:(ok|no):([0-9a-f]{12})$/.exec(data);
  if (bonusAction) {
    answerCallbackQuery(callback.id).catch(() => {});
    if (isBonusAdmin(from.id)) await finishBonus(from, chatId, messageId, bonusAction[1], bonusAction[2]);
    return;
  }
  if (data === 'rvbuy:list') { answerCallbackQuery(callback.id).catch(() => {}); await showReviewPaywall(from, chatId, undefined, messageId); return; }
  // code:buy — кнопка «Купить генерации» из старых сообщений: теперь это пополнение баланса.
  if (data === 'topup:home' || data === 'code:buy') { answerCallbackQuery(callback.id).catch(() => {}); await showTopup(from, chatId, messageId); return; }
  // tpc:<токен заказа> — «🔄 Проверить оплату» на экране оплаты.
  const topupCheck = data.match(/^tpc:([A-Za-z0-9_-]{40,60})$/);
  if (topupCheck) { await checkTopupPayment(from, chatId, messageId, callback.id, topupCheck[1]); return; }
  // tp:<сумма>[:<then>] — пополнить (и купить): заказ ЮKassa создаётся здесь, ссылка на оплату — в том же сообщении.
  const topupMatch = data.match(/^tp:(\d{1,6})(?:~(\d{1,9}))?(?::(.+))?$/);
  if (topupMatch) {
    const amount = Number(topupMatch[1]);
    if (!wallet.validTopup(amount)) { await answerCallbackQuery(callback.id, 'Сумма больше не актуальна'); return; }
    answerCallbackQuery(callback.id, 'Готовлю оплату…').catch(() => {});
    await dropTopupAmountWait(from.id);
    await startTopupPayment(from, chatId, amount, topupMatch[3] || '', messageId, topupMatch[2] ? Number(topupMatch[2]) / 100 : null, data);
    return;
  }
  if (data === 'ref:towallet') { answerCallbackQuery(callback.id).catch(() => {}); await confirmReferralToWallet(from, chatId, messageId); return; }
  if (data === 'ref:towallet:yes') { answerCallbackQuery(callback.id).catch(() => {}); await referralToWallet(from, chatId, messageId); return; }
  if (data === 'topup:custom') { answerCallbackQuery(callback.id).catch(() => {}); await askTopupAmount(from, chatId, messageId); return; }
  const shopPay = data.match(/^shop:pay:(\d+):(.+)$/);
  if (shopPay) { answerCallbackQuery(callback.id).catch(() => {}); await payShopItem(from, chatId, messageId, shopPay[1], shopPay[2].split(':')); return; }
  if (data.startsWith('shop:')) { answerCallbackQuery(callback.id).catch(() => {}); await dropTopupAmountWait(from.id); await showShop(from, chatId, messageId, data.split(':').slice(1)); return; }
  if (data === 'rv:start' || data === 'rv:filters') { answerCallbackQuery(callback.id).catch(() => {}); await showReviewFilters(from, chatId, messageId); return; }
  // «⭐ К отзывам» под карточкой автора — новым сообщением: оплаченная карточка остаётся в чате.
  if (data === 'rv:back') { answerCallbackQuery(callback.id).catch(() => {}); await showReviewFilters(from, chatId); return; }
  // Вернуться туда, откуда открыли выбор пункта или вопрос «войти другим номером»: к поиску или к отзывам.
  if (data === 'rv:stay') { answerCallbackQuery(callback.id).catch(() => {}); await backToWbScreen(from, chatId, messageId); return; }
  // «Войти другим номером» стирает действующий вход — сначала вопрос (rv:relogin), стирает rv:relogin:ok.
  if (data === 'rv:relogin') {
    answerCallbackQuery(callback.id).catch(() => {});
    const connection = await getWbConnection(from.id);
    const point = connection?.session?.pointId ? ` (ПВЗ ${escapeHtml(connection.session.pointId)})` : '';
    await showScreen(chatId, messageId, `<b>Войти другим номером?</b>\nТекущий вход в WB${point} удалится. Потом отправите новый номер и код от WB.`, { reply_markup: choiceKeyboard([
      [{ text: '📱 Да, другим номером', callback_data: 'rv:relogin:ok' }, { text: '⬅️ Остаться', callback_data: 'rv:stay' }],
    ]) });
    return;
  }
  if (data === 'rv:relogin:ok' || data === 'cs:relogin') {
    answerCallbackQuery(callback.id).catch(() => {});
    const search = data === 'cs:relogin' || await wbPurpose(from) === 'search';
    localGoodsSnapshots.delete(Number(from.id));
    await deleteWbConnection(from.id);
    if (search) await startClientSearch(from, chatId, messageId); else await showReviewFilters(from, chatId, messageId);
    return;
  }
  // «🚪 Выйти из WB» — с подтверждением. rv:disconnect — та же кнопка в старых сообщениях («Отключить WB»).
  const logoutAsk = data === 'rv:disconnect' ? 'rv' : /^(rv|cs):logout$/.exec(data)?.[1];
  if (logoutAsk) {
    answerCallbackQuery(callback.id).catch(() => {});
    await showScreen(chatId, messageId, '<b>Выйти из WB?</b>\nОтзывы и поиск клиента перестанут работать, пока вы не войдёте заново — по номеру телефона и коду от WB.', { reply_markup: choiceKeyboard([
      [{ text: '🚪 Да, выйти', callback_data: `${logoutAsk}:logout:ok` }, { text: '⬅️ Остаться', callback_data: logoutAsk === 'cs' ? 'code:find' : 'rv:filters' }],
    ]) });
    return;
  }
  const logoutOk = /^(rv|cs):logout:ok$/.exec(data);
  if (logoutOk) {
    answerCallbackQuery(callback.id).catch(() => {});
    localGoodsSnapshots.delete(Number(from.id));
    await clearSession(from.id);
    await deleteWbConnection(from.id);
    const again = logoutOk[1] === 'cs' ? { text: '🔎 Войти снова', callback_data: 'code:find' } : { text: '⭐ Войти снова', callback_data: 'rv:filters' };
    await showScreen(chatId, messageId, 'Вы вышли из WB. Данные входа удалены из бота.', { reply_markup: choiceKeyboard([[again], MENU_ROW]) });
    return;
  }
  // «Отменить вход» (шаг телефона или кода) и «Оставить текущий ПВЗ» (список пунктов) — одна кнопка rv:cancel:
  // готовый вход с выбранным пунктом она не трогает, отменяет только незаконченный.
  if (data === 'rv:cancel') {
    const connection = await getWbConnection(from.id);
    const pointId = connection?.session?.pointId;
    if (connection?.session?.token && pointId && (connection.state === 'ready' || connection.state === 'await_point')) {
      if (connection.state !== 'ready') await saveWbConnection(from, chatId, 'ready', connection.session);
      answerCallbackQuery(callback.id, `Пункт не менялся — ПВЗ ${pointId}`).catch(() => {});
      await backToWbScreen(from, chatId, messageId);
      return;
    }
    answerCallbackQuery(callback.id).catch(() => {});
    if (connection?.session?.token && connection.state === 'await_point') {
      await showScreen(chatId, messageId, 'Вход в WB сохранён — пункт выберете, когда снова откроете отзывы или поиск клиента.', { reply_markup: MENU_KEYBOARD });
      return;
    }
    await cancelWbLogin(from, chatId);
    if (await wbPurpose(from) === 'search') await clearSession(from.id);
    await showScreen(chatId, messageId, 'Вход в WB отменён.', { reply_markup: MENU_KEYBOARD });
    return;
  }
  // «🔁 Выслать код заново» — новый код на тот же номер (он есть в зашифрованной сессии), не чаще раза в 30 секунд.
  if (data === 'rv:resend') {
    const connection = await getWbConnection(from.id);
    if (connection?.state !== 'await_code' || !connection.session?.phone) {
      answerCallbackQuery(callback.id, 'Этот вход уже отменён — начните заново').catch(() => {});
      await backToWbScreen(from, chatId, messageId);
      return;
    }
    const wait = Math.ceil(((wbResendAt.get(Number(from.id)) || 0) + WB_RESEND_COOLDOWN_MS - Date.now()) / 1000);
    if (wait > 0) { await answerCallbackQuery(callback.id, `Новый код можно запросить через ${wait} сек.`); return; }
    if (wbResendAt.size > 5000) wbResendAt.clear();
    wbResendAt.set(Number(from.id), Date.now());
    answerCallbackQuery(callback.id, 'Запрашиваю новый код…').catch(() => {});
    await requestWbCode(from, chatId, connection.session, connection.session.phone, { messageId, fresh: true });
    return;
  }
  // «📱 Другой номер» — снова шаг телефона (вход ещё не готов; готовый вход эта кнопка не трогает).
  if (data === 'rv:phone') {
    answerCallbackQuery(callback.id).catch(() => {});
    const connection = await getWbConnection(from.id);
    if (connection?.session?.token && (connection.state === 'ready' || connection.state === 'await_point')) return backToWbScreen(from, chatId, messageId);
    await saveWbConnection(from, chatId, 'await_phone', { deviceId: connection?.session?.deviceId || crypto.randomUUID() });
    await showScreen(chatId, messageId, await wbLoginPromptText(from, await wbPurpose(from)), { reply_markup: WB_LOGIN_KEYBOARD });
    return;
  }
  if (data === 'cs:points') {
    // Смена ПВЗ из поиска клиента: после выбора пункта вернуться к поиску, а не к отзывам.
    answerCallbackQuery(callback.id).catch(() => {});
    const connection = await getWbConnection(from.id);
    if (!connection?.session?.token) return startClientSearch(from, chatId, messageId);
    await saveSession(from, chatId, 'await_wb_for_search', { userId: await ensureUser(from) });
    await beginPointSelection(from, chatId, connection, messageId);
    return;
  }
  if (data === 'rv:points') {
    answerCallbackQuery(callback.id).catch(() => {});
    const connection = await getWbConnection(from.id);
    if (!connection?.session?.token) return showReviewFilters(from, chatId, messageId);
    await beginPointSelection(from, chatId, connection, messageId);
    return;
  }
  const pointMatch = data.match(/^rv:point:(\d+)$/);
  if (pointMatch) {
    const connection = await getWbConnection(from.id);
    if (!connection?.session?.token) { answerCallbackQuery(callback.id).catch(() => {}); return showReviewFilters(from, chatId, messageId); }
    const pointId = Number(pointMatch[1]);
    if (connection.state === 'ready' && Number(connection.session.pointId) === pointId) {
      answerCallbackQuery(callback.id, `ПВЗ ${pointId} уже открыт`).catch(() => {});
      return backToWbScreen(from, chatId, messageId);
    }
    if (!(connection.session.points || []).some(point => Number(point.id) === pointId)) {
      // Кнопка из старого списка: такого пункта у входа больше нет — показываем список заново.
      answerCallbackQuery(callback.id, 'Этого ПВЗ больше нет в списке').catch(() => {});
      return beginPointSelection(from, chatId, connection, messageId);
    }
    answerCallbackQuery(callback.id).catch(() => {});
    const session = await wbPvz.selectPoint(connection.session, pointId);
    await saveWbConnection(from, chatId, 'ready', session);
    await afterWbReady(from, chatId, messageId);
    return;
  }
  // Загрузка у WB идёт несколько секунд — всплывающая подсказка сразу, чтобы не жали второй раз.
  const filterMatch = data.match(/^rv:filter:(all|[1-5])$/);
  if (filterMatch) { answerCallbackQuery(callback.id, 'Загружаю отзывы…').catch(() => {}); await sendReviewPage(from, chatId, filterMatch[1], 0); return; }
  const reviewPageMatch = data.match(/^rv:page:(all|[1-5]):(\d+)$/);
  if (reviewPageMatch) { answerCallbackQuery(callback.id, 'Загружаю отзывы…').catch(() => {}); await sendReviewPage(from, chatId, reviewPageMatch[1], Number(reviewPageMatch[2])); return; }
  const authorPositionMatch = data.match(/^rv:who2:(all|[1-5]):(\d+):(\d+)(?::([0-9a-f]{8}))?$/);
  if (authorPositionMatch) { answerCallbackQuery(callback.id, 'Ищу клиента в WB…').catch(() => {}); await showReviewAuthorByPosition(from, chatId, authorPositionMatch[1], Number(authorPositionMatch[2]), Number(authorPositionMatch[3]), authorPositionMatch[4], messageId); return; }
  const historyMatch = data.match(/^rv:hist:(\d{1,12}):(\d{1,4})$/);
  if (historyMatch) { answerCallbackQuery(callback.id).catch(() => {}); await turnAuthorHistory(from, chatId, messageId, Number(historyMatch[1]), Number(historyMatch[2])); return; }
  const authorMatch = data.match(/^rv:who:(\d+)(?::(\d+))?$/);
  if (authorMatch) { answerCallbackQuery(callback.id).catch(() => {}); await revealReviewAuthor(from, chatId, Number(authorMatch[1]), Number(authorMatch[2] || 0)); return; }
  if (data === 'gen:start') { answerCallbackQuery(callback.id).catch(() => {}); await startGeneration(from, chatId); return; }
  // «➕ Ещё один по номеру» под готовым файлом — сразу ввод номера того же типа.
  const againMatch = data.match(/^gen:again:(product|box)$/);
  if (againMatch) { answerCallbackQuery(callback.id).catch(() => {}); await startAgainByNumber(from, chatId, againMatch[1]); return; }
  // Стикер по номеру (или QR коробки по 10 цифрам), найденному на фото или присланному цифрами, — без шагов мастера.
  const numMatch = data.match(/^gen:num:(\d{11})$/);
  if (numMatch) { answerCallbackQuery(callback.id).catch(() => {}); await startWithCode(from, chatId, numMatch[1], messageId); return; }
  const boxMatch = data.match(/^gen:box:(\d{10})$/);
  if (boxMatch) { answerCallbackQuery(callback.id).catch(() => {}); await startWithCode(from, chatId, boxMatch[1], messageId, 'box'); return; }
  if (data === 'orders:list') { answerCallbackQuery(callback.id).catch(() => {}); await showIndividualOrders(from, chatId); return; }
  const orderPay = data.match(/^ord:pay:([0-9a-f-]{36})$/i);
  if (orderPay) { answerCallbackQuery(callback.id, 'Готовлю оплату…').catch(() => {}); await payIndividualOrder(from, chatId, messageId, orderPay[1].toLowerCase()); return; }
  if (data === 'gen:cancel') {
    answerCallbackQuery(callback.id).catch(() => {}); await clearSession(from.id);
    await showScreen(chatId, messageId, 'Создание стикера отменено. Деньги не списаны.', { reply_markup: choiceKeyboard([[{ text: '🏷 Начать заново', callback_data: 'menu:stickers' }], MENU_ROW]) });
    return;
  }
  if (data === 'code:find') { answerCallbackQuery(callback.id).catch(() => {}); await startClientSearch(from, chatId, messageId); return; }
  // Запрос QR с компьютера: выдать / отклонить / выдать с баланса / снова экран выдачи («⬅️ Назад» с оплаты);
  // подтверждение замены привязки Telegram.
  const approvalMatch = data.match(/^cq:(ok|no|wallet|view):([0-9a-f-]{36})$/);
  if (approvalMatch) { await handleApprovalButton(from, chatId, messageId, callback.id, approvalMatch[1], approvalMatch[2]); return; }
  const linkMatch = data.match(/^cq:link:(yes|no):([A-Za-z0-9_-]{24})$/);
  if (linkMatch) { await handleLinkConfirm(from, chatId, messageId, callback.id, linkMatch[1], linkMatch[2]); return; }
  // Вход в программу: lg:ok|no:<КОД> (19 байт); «🚫 Это не я» под сообщением о новом ПК: dv:no:<id ПК> (42 байта).
  const loginMatch = data.match(/^lg:(ok|no):([A-Z2-9]{8})$/);
  if (loginMatch) { await handleLoginConfirm(from, chatId, messageId, callback.id, loginMatch[1], loginMatch[2]); return; }
  const notMeMatch = data.match(/^dv:no:([0-9a-f-]{36})$/i);
  if (notMeMatch) { await handleDeviceNotMe(from, chatId, messageId, callback.id, notMeMatch[1].toLowerCase()); return; }
  // QR клиента по голому номеру (offerForNumber): сначала подтверждение с ценой, выдача — по второй кнопке.
  const codeAsk = data.match(/^code:ask:(\d{7,12})$/);
  if (codeAsk) { answerCallbackQuery(callback.id).catch(() => {}); await askClientCodeConfirm(from, chatId, messageId, codeAsk[1]); return; }
  const codeOk = data.match(/^code:ok:(\d{7,12})$/);
  if (codeOk) { await confirmClientCodeFromNumber(from, chatId, messageId, callback.id, codeOk[1]); return; }
  // Кнопка из результатов поиска (code:qr:<ID>[:<ячейка>]) — выдача с отметкой нажатия, без второго вопроса.
  const codeQr = data.match(/^code:qr:(\d{1,12})(?::([0-9A-Za-zА-Яа-я-]{1,10}))?$/u);
  if (codeQr) { await pressClientQr(from, chatId, messageId, callback.id, codeQr[1], codeQr[2] || ''); return; }
  // QR не отправился, а код уже списан: тот же id списания — тот же QR без нового списания (app_code_once).
  const codeResend = data.match(/^code:re:(\d{1,12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  if (codeResend) { answerCallbackQuery(callback.id, 'Отправляю QR ещё раз…').catch(() => {}); await handleClientCode(from, chatId, codeResend[1], { requestId: codeResend[2] }); return; }
  if (data === 'code:enter') {
    answerCallbackQuery(callback.id).catch(() => {});
    const current = await getSession(from.id);
    // Из подтверждения генерации сохраняем черновик (после кода — сразу к подтверждению), из профиля начинаем с чистого.
    await askAccessCode(from, chatId, current?.state === 'confirm' && current.draft?.mode ? current.draft : {}, messageId);
    return;
  }
  if (data === 'code:cancel') { answerCallbackQuery(callback.id).catch(() => {}); await clearSession(from.id); await showProfile(from, chatId, messageId); return; }
  // Устаревшая кнопка (старый экран входа на сайт) — бот её больше не создаёт, в старых сообщениях ведёт в меню.
  if (data === 'account:continue') { answerCallbackQuery(callback.id).catch(() => {}); await showMainMenu(from, chatId); return; }
  // Другой вид или «прислать ещё раз» по готовому результату: денег не берём, ссылки подписываем заново (freshResult).
  const formatMatch = data.match(/^gen:format:(old|new):([^:]+:\d+)$/);
  if (formatMatch) {
    await answerCallbackQuery(callback.id, 'Готовлю файлы…');
    const result = await loadGenerationRequest(formatMatch[2], from.id);
    if (!result) return sendMessage(chatId, RESULT_GONE_TEXT, { reply_markup: RESULT_GONE_KEYBOARD });
    try { await deliverGeneration(chatId, formatMatch[2], result, formatMatch[1], repeatCaption(result, formatMatch[1])); }
    catch (error) {
      console.warn('Telegram sticker delivery failed', error.message);
      const view = deliveryFailedView(formatMatch[2], result, formatMatch[1]);
      await sendMessage(chatId, view.text, { reply_markup: view.reply_markup });
    }
    return;
  }
  const pageMatch = data.match(/^gen:page:(old|new):([^:]+:\d+):(\d+)$/);
  if (pageMatch) {
    answerCallbackQuery(callback.id).catch(() => {});
    const result = await loadGenerationRequest(pageMatch[2], from.id);
    if (!result) return sendMessage(chatId, RESULT_GONE_TEXT, { reply_markup: RESULT_GONE_KEYBOARD });
    try { await sendPreview(chatId, pageMatch[2], freshResult(result), Number(pageMatch[3]), pageMatch[1]); }
    catch (error) {
      console.warn('Telegram sticker preview failed', error.message);
      const view = deliveryFailedView(pageMatch[2], result, pageMatch[1]);
      await sendMessage(chatId, view.text, { reply_markup: view.reply_markup });
    }
    return;
  }
  const session = await getSession(from.id);
  // «🏷 Создать стикер» после покупки пакета приходит в новом сообщении (итог покупки), поэтому проверку
  // «кнопка не из текущего экрана мастера» ниже не проходит. Мастер на выборе «Пачка / По номеру» переносим
  // в нажатое сообщение; сессии нет или она от другого шага — мастер заново в этом же сообщении.
  if (data === 'gen:return-mode') {
    answerCallbackQuery(callback.id).catch(() => {});
    if (session?.state === 'choose_mode' && session.draft?.category) {
      const previousId = session.draft.msgId;
      await renderChooseMode(from, chatId, session.draft, messageId);
      if (previousId && previousId !== messageId) retireMessage(chatId, previousId).catch(() => {});
      return;
    }
    await startGeneration(from, chatId, messageId);
    return;
  }
  if (!session) {
    // Кнопка старого шага: действие закончено (создано, отменено, ушли в меню) или ожидание истекло.
    answerCallbackQuery(callback.id).catch(() => {});
    await showMainMenu(from, chatId, messageId, { notice: STALE_ACTION_TEXT });
    return;
  }
  const draft = session.draft || {};
  // Кнопки мастера работают только в его текущем сообщении: старые экраны выше в чате не трогают черновик.
  // Со старого экрана снимаем кнопки, чтобы по нему больше не нажимали.
  if (data.startsWith('gen:') && draft.msgId && messageId !== draft.msgId) {
    await answerCallbackQuery(callback.id, 'Это старый шаг — продолжайте в последнем сообщении ниже');
    if (messageId) telegramRequest('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return;
  }
  if (data === 'gen:back') { answerCallbackQuery(callback.id).catch(() => {}); await wizardBack(from, chatId, session, messageId); return; }
  // «🔄 Я пополнил» — перечитать баланс и коды и показать подтверждение заново.
  if (data === 'gen:recheck' && session.state === 'confirm') { answerCallbackQuery(callback.id).catch(() => {}); await requestConfirmation(from, chatId, draft, messageId); return; }
  if (data.startsWith('gen:kind:') && session.state === 'choose_kind') {
    answerCallbackQuery(callback.id).catch(() => {});
    draft.category = data.endsWith(':box') ? 'box' : 'product';
    await renderChooseMode(from, chatId, draft, messageId);
    return;
  }
  if (data.startsWith('gen:mode:') && session.state === 'choose_mode') {
    answerCallbackQuery(callback.id).catch(() => {});
    draft.mode = data.endsWith(':custom') ? 'custom' : 'range';
    if (draft.category === 'box') draft.prefix = 'TRBX';
    if (draft.mode === 'range') {
      draft.quantity = BATCH_QUANTITY;
      await requestConfirmation(from, chatId, draft, messageId);
    } else {
      await renderWizard(from, chatId, 'await_code', draft, messageId);
    }
    return;
  }
  const pickMatch = data.match(/^gen:pick:(\d{10,11})$/);
  if (pickMatch && session.state === 'await_code' && Array.isArray(draft.photoCodes) && draft.photoCodes.includes(pickMatch[1])) {
    answerCallbackQuery(callback.id).catch(() => {});
    draft.code = pickMatch[1]; delete draft.photoCodes; delete draft.pickFromText;
    await requestConfirmation(from, chatId, draft, messageId);
    return;
  }
  if (data === 'gen:confirm' && session.state === 'confirm') { answerCallbackQuery(callback.id).catch(() => {}); await confirmGeneration(callback, session); return; }
  // Двойное нажатие на текущем экране (шаг уже сменился, «Создать» уже выполняется) — экран не трогаем.
  if (messageId && messageId === draft.msgId) { await answerCallbackQuery(callback.id, 'Уже выполняю — подождите'); return; }
  // Кнопка из старого сообщения — понятный текст и меню вместо всплывающей надписи.
  answerCallbackQuery(callback.id).catch(() => {});
  await showMainMenu(from, chatId, messageId, { notice: STALE_ACTION_TEXT });
}

async function handleMessage(message) {
  const from = message.from, chatId = message.chat.id, text = String(message.text || '').trim();
  if (message.chat.type !== 'private') return sendMessage(chatId, 'Используйте личный чат с ботом.');
  // «Последний визит» и уведомление о новичке — в фоне: ответ человеку их не ждёт.
  touchSubscriber(from, chatId, text).catch(error => console.warn('Подписчик бота: запись визита', error?.message || error));
  const startMatch = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]+))?$/i.exec(text);
  if (startMatch) {
    const clubTarget = /^club(?:_(code|reviews))?$/.exec(startMatch[1] || '');
    // Незаконченный ввод и вход в WB больше не ждём (кроме перехода прямо к отзывам — там вход продолжается).
    await resetPending(from, chatId, clubTarget?.[1] === 'reviews' ? 'reviews' : 'start');
    // t.me/<бот>?start=link_<token> — привязать этот Telegram к аккаунту из программы «Помощник ПВЗ».
    const link = LINK_PAYLOAD.exec(startMatch[1] || '');
    if (link) return handleLinkStart(from, chatId, link[1]);
    // t.me/<бот>?start=login_<КОД> — подтвердить вход в программу (кнопка и QR на странице /app-login).
    const login = LOGIN_PAYLOAD.exec(startMatch[1] || '');
    if (login) return handleLoginStart(from, chatId, login[1]);
    // t.me/<бот>?start=r_<КОД> — переход по приглашению. Новичку аккаунт создаём сразу (строго после записи
    // перехода — bind_referral ищет переход «до регистрации»): приглашение засчитается без действий человека.
    const referralMatch = REFERRAL_PAYLOAD.exec(startMatch[1] || '');
    const referral = referralMatch ? await captureReferral(from, referralMatch[1]).catch(() => '') : '';
    if (referral === 'new' || referral === 'already_captured') {
      await ensureUser(from).catch(error => console.warn('Приглашение: аккаунт не создан', error?.message || error));
    }
    // t.me/<бот>?start=club — кнопка «🛠 Инструменты ПВЗ» из группы «Клуба вопросов» (zara-bot, с 09.11.2026):
    // запоминаем переход (скидка 20% на 30 дней при активной подписке) и показываем главное меню — приветствие
    // само называет скидку и срок; ?start=club_code | club_reviews — прежние кнопки: сразу нужный экран.
    if (clubTarget) {
      await markClubRef(from.id).catch(error => console.warn('Скидка клуба: отметка перехода', error?.message || error));
      if (!clubTarget[1]) return showMainMenu(from, chatId, undefined, { greet: true, referral, fromClub: true });
      if (clubTarget[1] === 'code') {
        // Экран кода клиента пишет про скидку сам.
        await sendMessage(chatId, greetingTitle(from));
        return showClientCode(chatId, undefined, from);
      }
      // Отзывы: первым может быть вход в WB по SMS — сначала польза и цена, потом вход.
      await sendMessage(chatId, await reviewsIntroText(from));
      return showReviewFilters(from, chatId);
    }
    // Одно сообщение: приветствие + инлайн-меню. Постоянную клавиатуру не шлём — «☰ Меню» есть на каждом экране.
    return showMainMenu(from, chatId, undefined, { greet: true, referral });
  }
  if (isBonusAdmin(from.id)) {
    const bonusCommand = parseBonusCommand(text);
    if (bonusCommand) return startBonus(from, chatId, bonusCommand);
  }
  if (LEGACY_BUTTONS.has(text)) await dropLegacyKeyboard(chatId);
  // /help не сбрасывает начатый ввод: человек открывает справку посреди шага и продолжает его.
  if (/^\/help(?:@\w+)?$/i.test(text) || text === '🆘 Помощь') return showHelp(from, chatId);
  // /cancel отменяет незаконченный ввод и вход в WB (телефон, код); готовый вход и выбранный пункт остаются.
  if (/^\/cancel(?:@\w+)?$/i.test(text)) { await clearSession(from.id); await cancelWbLogin(from, chatId); await sendMessage(chatId, 'Текущее действие отменено.', { reply_markup: MENU_KEYBOARD }); return; }
  // Остальные команды (и подписи старой постоянной клавиатуры) — как кнопки меню: незаконченный ввод закрывается.
  const command = commandTarget(text);
  if (command) {
    await resetPending(from, chatId, command);
    if (command === 'menu') return showMainMenu(from, chatId);
    if (command === 'stickers') return startGeneration(from, chatId);
    if (command === 'code') return showClientCode(chatId, undefined, from);
    if (command === 'profile') return showProfile(from, chatId);
    if (command === 'balance') return showTopup(from, chatId);
    if (command === 'invite') return showReferrals(from, chatId);
    if (command === 'reviews') return showReviewFilters(from, chatId);
    if (command === 'orders') return showIndividualOrders(from, chatId);
    if (command === 'product') return startForCategory(from, chatId, 'product');
    if (command === 'box') return startForCategory(from, chatId, 'box');
  }
  // Сначала — ввод, которого ждёт открытый экран (мастер, сумма, поиск). Иначе незаконченный вход в WB
  // («пришлите телефон») перехватывал бы, например, количество стикеров или ШК из 11 цифр.
  const session = await getSession(from.id);
  const draft = session?.draft || {};
  // «Код <ID>» → QR клиента сразу (платно). Не команда, если бот ждёт ввод для текущего шага: SMS-код WB или код
  // доступа («код 4821» там — это ввод), короткий номер в открытом поиске — тоже поиск.
  const codeCommand = parseCodeCommand(text);
  if (codeCommand && session?.state !== 'await_access_code' && !(session?.state === 'await_client_query' && codeCommand.digits.length < 7)) {
    const wb = await getWbConnection(from.id).catch(() => null);
    if (wb?.state !== 'await_code' && wb?.state !== 'await_phone') return handleCodeCommand(from, chatId, codeCommand.digits);
  }
  // Фото или скриншот с номером ШК — вместо ручного ввода.
  const image = shkVision.imageOf(message);
  if (image) return handlePhoto(from, chatId, message, image, session);
  if (session?.state === 'await_access_code') return redeemAccessCode(from, chatId, session, text);
  if (session?.state === 'await_topup_amount') return acceptTopupAmount(from, chatId, session, message, text);
  if (session?.state === 'await_client_query') return runClientSearch(from, chatId, text);
  // Ввод в мастер: сообщение пользователя убираем, ответ — новым экраном внизу (прежний экран мастера удаляется,
  // renderWizard без messageId), ошибка — строкой сверху.
  if (session?.state === 'await_code') {
    await deleteMessage(chatId, message.message_id).catch(() => {});
    const parsed = parseWizardNumber(text, draft.category);
    if (parsed.codes) { draft.photoCodes = parsed.codes; draft.pickFromText = true; return renderWizard(from, chatId, 'await_code', draft); }
    if (parsed.error) { draft.error = parsed.error; return renderWizard(from, chatId, 'await_code', draft); }
    delete draft.photoCodes; delete draft.pickFromText;
    draft.code = parsed.code; return requestConfirmation(from, chatId, draft);
  }
  const wbConnection = await getWbConnection(from.id);
  // Вход в WB (срок — 15 минут, см. expirePendingLogin). Сообщение с цифрами (номер, код) удаляем — бот обещал;
  // вопрос словами не трогаем, а отвечаем, чего ждём.
  if (wbConnection?.state === 'await_phone') {
    if (/\d/.test(text)) await deleteMessage(chatId, message.message_id).catch(() => {});
    const parsed = parseWbPhone(text);
    if (!parsed.phone) {
      const keyboard = parsed.foreign
        ? choiceKeyboard([[{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }], ...WB_LOGIN_KEYBOARD.inline_keyboard])
        : WB_LOGIN_KEYBOARD;
      return sendMessage(chatId, parsed.error, { reply_markup: keyboard });
    }
    return requestWbCode(from, chatId, wbConnection.session || { deviceId: crypto.randomUUID() }, parsed.phone);
  }
  if (wbConnection?.state === 'await_code') {
    if (/\d/.test(text)) await deleteMessage(chatId, message.message_id).catch(() => {});
    const code = text.replace(/\D/g, '');
    if (!/^\d{4,6}$/.test(code)) return sendMessage(chatId, 'Жду код от WB — это 4–6 цифр. Пришлите только цифры кода.', { reply_markup: WB_CODE_KEYBOARD });
    let session;
    try {
      session = await wbPvz.confirmCode(wbConnection.session, code);
    } catch (error) {
      console.warn('WB login code confirm failed', error?.status || '', error?.message);
      await saveWbConnection(from, chatId, 'await_code', wbConnection.session, { lastError: String(error?.message).slice(0, 500) });
      return sendMessage(chatId, wbCodeConfirmErrorText(error, wbConnection.session), { reply_markup: WB_CODE_KEYBOARD });
    }
    await saveWbConnection(from, chatId, 'await_point', session);
    try {
      await beginPointSelection(from, chatId, { ...wbConnection, state: 'await_point', session });
    } catch (error) {
      // Вход сохранён (await_point): «Проверить снова» (rv:points) сам вернёт и в поиск клиента, если шли за ним.
      console.warn('WB points after login failed', error?.status || '', error?.message);
      await saveWbConnection(from, chatId, 'await_point', session, { lastError: String(error?.message).slice(0, 500) });
      await sendMessage(chatId, 'Вход в WB выполнен, но список ваших ПВЗ пока не загрузился — WB не ответил. Нажмите «Проверить снова» через минуту: новый код не понадобится.', { reply_markup: choiceKeyboard([
        [{ text: '🔄 Проверить снова', callback_data: 'rv:points' }],
        MENU_ROW,
      ]) });
    }
    return;
  }
  // Голые цифры (скопировали ID клиента или ШК) — предлагаем действие, а не молча открываем меню.
  const bareNumber = text.replace(/\s+/g, '');
  if (/^\d{7,12}$/.test(bareNumber) && !['choose_kind', 'choose_mode', 'confirm', 'generating'].includes(session?.state)) {
    return offerForNumber(from, chatId, bareNumber);
  }
  if (!session) return showMainMenu(from, chatId, undefined, { notice: await unknownInputNotice(from, text) });
  // Шаг мастера ждёт нажатия кнопки, а пришёл текст — подсказка новым экраном внизу. На подтверждении «По номеру»
  // правильный по длине номер заменяет прежний: человек заметил опечатку и прислал номер заново.
  if (['choose_kind', 'choose_mode', 'confirm'].includes(session.state) && draft.msgId) {
    await deleteMessage(chatId, message.message_id).catch(() => {});
    if (session.state === 'confirm' && draft.mode === 'custom') {
      const parsed = parseWizardNumber(text, draft.category);
      if (parsed.code) { draft.code = parsed.code; return requestConfirmation(from, chatId, draft); }
    }
    draft.error = session.state !== 'confirm' ? 'Выберите вариант кнопкой ниже.'
      : draft.mode === 'custom' ? 'Чтобы изменить номер, нажмите «⬅️ Назад» или пришлите номер заново. Чтобы создать — «✅ Создать».'
        : 'Нажмите «✅ Создать» или «⬅️ Назад».';
    return renderWizard(from, chatId, session.state, draft);
  }
  if (session.state === 'generating') return sendMessage(chatId, '⏳ Создаю стикеры — подождите немного.');
  // Остальное (например, ждём входа через Mini App) — меню с подсказкой, без загадочных «завершите действие».
  await clearSession(from.id);
  return showMainMenu(from, chatId, undefined, { notice: await unknownInputNotice(from, text) });
}

function validWebhookSecret(req) {
  const expected = String(process.env.TELEGRAM_WEBHOOK_SECRET || ''), actual = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (expected.length < 16 || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function updateLabel(update) {
  if (update.callback_query) return `callback ${String(update.callback_query.data || '').slice(0, 40)}`;
  const message = update.message || {};
  if (message.photo) return 'message photo';
  const text = String(message.text || '');
  return `message ${text.startsWith('/') ? text.split(/\s/)[0] : text ? 'text' : 'other'}`;
}

// Ответ ограниченному в боте — не чаще раза в час на человека, чтобы не отвечать на каждое сообщение.
const RESTRICTED_REPLY_EVERY_MS = 60 * 60 * 1000;
const RESTRICTED_REPLY_MAX = 5000;
const restrictedReplies = new Map(); // telegram id → когда отвечали

function shouldReplyRestricted(tgId, now = Date.now()) {
  const last = restrictedReplies.get(tgId);
  if (last && now - last < RESTRICTED_REPLY_EVERY_MS) return false;
  if (restrictedReplies.size >= RESTRICTED_REPLY_MAX) {
    for (const [id, at] of restrictedReplies) if (now - at >= RESTRICTED_REPLY_EVERY_MS) restrictedReplies.delete(id);
    if (restrictedReplies.size >= RESTRICTED_REPLY_MAX) restrictedReplies.clear();
  }
  restrictedReplies.set(tgId, now);
  return true;
}

// answerCallbackQuery из _telegram-api не передаёт show_alert; предел текста у Telegram — 200 символов
function alertCallback(callbackId, text) {
  return telegramRequest('answerCallbackQuery', { callback_query_id: callbackId, text: String(text || '').slice(0, 200), show_alert: true }).catch(() => {});
}

// Под ответом об ограничении — куда писать. Общий текст ограничения (restrictionMessage в _user-controls.js) общий
// с сайтом и программой, поэтому строку про поддержку добавляет только бот. Кнопка — ссылка: callback-кнопки
// ограниченному всё равно не ответят.
const RESTRICTED_SUPPORT_LINE = 'Если считаете, что это ошибка, напишите в поддержку.';
const RESTRICTED_KEYBOARD = choiceKeyboard([[{ text: '✉️ Написать в поддержку', url: SUPPORT_URL }]]);

function restrictedText(message) {
  return `⛔ ${escapeHtml(message)}\n${RESTRICTED_SUPPORT_LINE}`;
}

// /start, /menu и /help ограниченному — ответ всегда (иначе бот выглядит зависшим); прочее — не чаще раза в час.
const RESTRICTED_ALWAYS_REPLY = /^\/(?:start|menu|help)(?:@\w+)?(?:\s|$)/i;

/** true — апдейт поглощён ограничением «Бот» (или «Полностью») из админки. */
async function rejectRestricted(update) {
  const tgId = update.message?.from?.id ?? update.callback_query?.from?.id;
  if (!tgId) return false;
  const restriction = await controls.restrictionForTelegram(tgId).catch(() => null);
  if (!controls.covers(restriction, 'bot')) return false;
  const cq = update.callback_query;
  if (cq) {
    // Кнопка: раз в час — сообщение с причиной и кнопкой-ссылкой поддержки (всплывашка тогда была бы повтором),
    // в остальное время — всплывающее окно с причиной и строкой про поддержку.
    const chatId = cq.message?.chat?.id;
    if (chatId && shouldReplyRestricted(tgId)) {
      answerCallbackQuery(cq.id).catch(() => {});
      await sendMessage(chatId, restrictedText(restriction.message), { reply_markup: RESTRICTED_KEYBOARD }).catch(() => {});
    } else {
      await alertCallback(cq.id, `${restriction.message}\n${RESTRICTED_SUPPORT_LINE}`);
    }
  } else if (update.message?.chat?.id && (RESTRICTED_ALWAYS_REPLY.test(String(update.message.text || '').trim()) || shouldReplyRestricted(tgId))) {
    await sendMessage(update.message.chat.id, restrictedText(restriction.message), { reply_markup: RESTRICTED_KEYBOARD }).catch(() => {});
  }
  return true;
}

/** Сбой на нашей стороне: что с деньгами и куда писать. incident — короткий код записи в журнале. */
function failureText(incident) {
  return [
    'Не получилось выполнить действие — сбой на нашей стороне.',
    `Попробуйте ещё раз через минуту. Если деньги списались, а результата нет, или ошибка повторяется — напишите в поддержку и назовите код: <code>${incident}</code>`,
  ].join('\n');
}

async function processUpdate(update) {
  const startedAt = Date.now();
  try {
    if (await rejectRestricted(update)) {
      botHealth.recordUpdate({ label: updateLabel(update), ms: Date.now() - startedAt });
      return;
    }
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message?.from && update.message?.chat) await handleMessage(update.message);
    const ms = Date.now() - startedAt;
    console.log(`bot ${updateLabel(update)} ${ms} ms`);
    botHealth.recordUpdate({ label: updateLabel(update), ms });
  } catch (error) {
    // Ограничение из админки (покупки, программа…) — показать его текст, а не «внутреннюю ошибку»
    if (error?.code === 'ACCOUNT_RESTRICTED') {
      botHealth.recordUpdate({ label: updateLabel(update), ms: Date.now() - startedAt });
      const cq = update.callback_query;
      const chatId = update.message?.chat?.id || cq?.message?.chat?.id;
      // Сообщение с причиной и поддержкой ниже — всплывающее окно с тем же текстом было бы повтором.
      if (cq) answerCallbackQuery(cq.id).catch(() => {});
      if (chatId) await sendMessage(chatId, restrictedText(error.message), { reply_markup: choiceKeyboard([...RESTRICTED_KEYBOARD.inline_keyboard, MENU_ROW]) }).catch(() => {});
      return;
    }
    // Ошибка WB (вход устарел, нет доступа, WB не отвечает) посреди отзывов или поиска — понятный ответ с повтором
    // той же кнопки, а не «сбой на нашей стороне». Не получилось ответить так — общий текст ниже.
    if (error?.name === 'WbPvzError') {
      const cq = update.callback_query;
      const from = cq?.from || update.message?.from;
      const chatId = update.message?.chat?.id || cq?.message?.chat?.id;
      const raw = String(cq?.data || '');
      const data = raw.startsWith(NOTICE_PREFIX) ? raw.slice(NOTICE_PREFIX.length) : raw;
      try {
        const purpose = /^(cs:|code:)/.test(data) ? 'search' : await wbPurpose(from);
        if (from && chatId && await replyWbFailure(from, chatId, error, { purpose, retry: data, money: /^rv:who/.test(data) })) {
          botHealth.recordUpdate({ label: updateLabel(update), ms: Date.now() - startedAt });
          return;
        }
      } catch (replyError) {
        console.warn('WB failure reply failed', replyError?.message || replyError);
      }
    }
    // Короткий код ошибки — в лог и человеку: по нему поддержка найдёт запись в журнале.
    const incident = crypto.randomBytes(3).toString('hex');
    const ms = Date.now() - startedAt;
    console.error(`Telegram generator bot failed [${incident}] ${updateLabel(update)} ${ms} ms`, error.message, error.details ? JSON.stringify(error.details).slice(0, 500) : '');
    botHealth.recordUpdate({ label: updateLabel(update), ms, failed: true, incident });
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) await sendMessage(chatId, failureText(incident), { reply_markup: supportKeyboard() }).catch(() => {});
  }
}

/**
 * Вебхук. Telegram получает 200 сразу после того, как апдейт закреплён за нами (dedupe), а обработка идёт
 * в фоне: релей и Telegram не ждут Supabase и WB, повторов и дублей не бывает. Локальный polling
 * (scripts/run-telegram-bot-local.cjs) передаёт req.waitForCompletion и ждёт обработку целиком.
 */
async function handleTelegramUpdate(req, res) {
  if (!validWebhookSecret(req)) return res.status(401).json({ ok: false });
  const update = req.body || {};
  if (!Number.isSafeInteger(Number(update.update_id))) return res.status(400).json({ ok: false });
  try {
    if (!await claimUpdate(update.update_id)) return res.status(200).json({ ok: true, duplicate: true });
  } catch (error) {
    // Не смогли закрепить апдейт (Supabase недоступен) — 502: Telegram пришлёт его ещё раз.
    console.error('Telegram update claim failed', error.message);
    return res.status(502).json({ ok: false });
  }
  const work = processUpdate(update);
  if (req.waitForCompletion) await work;
  return res.status(200).json({ ok: true });
}

/** Сайт отвязал/перепривязал Telegram у аккаунта — узел бота держит связку в памяти до 10 минут, сбрасываем по RPC. */
function forgetSiteUser(userId) { userCache.forgetSiteUser(userId); return true; }
function forgetTelegramUser(telegramId) { userCache.forgetTelegramUser(telegramId); return true; }
/** Админка сняла/поставила ограничение или безлимит — сбросить снимок на узле бота (по RPC с сайта). */
function invalidateUserControls() { controls.invalidate(); return true; }

module.exports = { BOT_COMMANDS, LEGACY_BUTTONS, syncBotCommands, dropLegacyKeyboard, afterWalletTopup, bindTelegramReferral, buyGenerationsWithWallet, claimErrorText, claimUpdate, clearSession, clientCodeEventKey, findClientsByQuery, findUser, forgetSiteUser, forgetTelegramUser, invalidateUserControls, freeUntilText, getSession, mainMenuKeyboard, profileKeyboard, saveSession, processUpdate, bonusNoticeText, isBonusAdmin, parseBonusCommand, topupAndBuyRow, topupPurchaseLines, topupRows, escapeHtml, findPickupEvents, formatPhone, isFreshSubscriber, newUserSource, formatReviewGoodsTime, handleTelegramUpdate, maskWbPhone, noPointsView, notifyAccountLinked, notifyMiniAppAuthorized, parseWizardNumber, publicUrl, reviewAuthorIds, reviewStars, reviewText, validWebhookSecret, wizardView };
