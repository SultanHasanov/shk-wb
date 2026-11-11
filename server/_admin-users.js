const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { authConfig, deleteAuthUser, getAuthUser } = require('./_user-auth');
const { createNotification } = require('./_notifications');
const {
  RESOURCES, addStickerGenerations, adminError, checkCellLicensePatch, checkStickerAccessPatch,
  createCellLicense, createProgramKey, createStickerAccessCode, isUuid, recordAdminAction, sendAdminError,
} = require('./_admin-grants');
const { ADDONS, PLANS, accountLimits, addonPrice, isAddon, isPlan, isTerm, mirrorLimit, orderSnapshot } = require('./_app-plans');
const { setCodeViaBotOffForUser } = require('./_app-flags');

/**
 * Раздел «Пользователи» админки.
 *
 * Вызывается из api/admin/data.js ПОСЛЕ requireAdmin — своей проверки прав здесь
 * нет намеренно, чтобы не было второго места, где её можно забыть обновить.
 * Отдельным файлом в api/ этот раздел быть не может: там уже 12 функций, это
 * потолок тарифа Vercel.
 *
 * Список и сводка идут одним RPC каждый: auth.users из схемы public не читается,
 * а Auth Admin REST не умеет ни искать по телефону или коду доступа, ни
 * сортировать по выручке — пришлось бы выкачивать всех пользователей на каждый
 * показ страницы.
 */

const SORTS = ['created_at', 'last_sign_in_at', 'revenue', 'generation_used', 'balance', 'expiring'];
const FILTERS = ['all', 'paying', 'free', 'telegram', 'banned', 'inactive', 'subscribed', 'expiring', 'unlimited', 'restricted'];
const COUNT_KEYS = ['all', 'paying', 'subscribed', 'expiring', 'unlimited', 'restricted', 'telegram', 'inactive', 'new30'];
const COUNTS_TTL_MS = 60_000;
const OAUTH_PROVIDERS = ['yandex', 'mailru', 'vkid'];
const SECTIONS_HERE = ['wallet', 'usage', 'charges', 'cellDevices', 'logins'];
const SECTIONS_MESSAGES = ['messages', 'deliveries', 'pcMessages'];

/**
 * Новые действия живут в своих модулях. require ленивый: _admin-restrictions и _admin-messages
 * тянут _app-account и бота, а им этот модуль не нужен — так нет ни циклов, ни лишней загрузки.
 * Делегат отвечает сам: (req, res, { userId }) => Promise<void>.
 */
const DELEGATED = {
  'POST setOverrides': () => require('./_admin-limits').setOverrides,
  'POST clearOverrides': () => require('./_admin-limits').clearOverrides,
  'POST walletAdjust': () => require('./_admin-limits').walletAdjust,
  'POST restrict': () => require('./_admin-restrictions').restrict,
  'POST updateRestriction': () => require('./_admin-restrictions').updateRestriction,
  'POST liftRestriction': () => require('./_admin-restrictions').liftRestrictionAction,
  'POST block': () => require('./_admin-restrictions').blockCompat,
  'POST unblock': () => require('./_admin-restrictions').unblockCompat,
  'GET messageTargets': () => require('./_admin-messages').messageTargets,
  'POST message': () => require('./_admin-messages').message,
  'POST notify': () => require('./_admin-messages').notifyCompat,
  // Связать аккаунт сайта с Telegram-ботом — только через поддержку (server/_admin-link.js).
  'GET linkTelegramPreview': () => require('./_admin-link').linkTelegramPreview,
  'POST linkTelegram': () => require('./_admin-link').linkTelegram,
};

function badRequest(res, error) {
  return res.status(400).json({ error, code: 'VALIDATION_ERROR' });
}

/** Причина из тела — в журнал каждого действия (необязательна у старых действий). */
function logOptions(req, extra = {}) {
  return { reason: req.body?.reason || null, ...extra };
}

function requiredReason(req) {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw adminError(400, 'VALIDATION_ERROR', 'Укажите причину для журнала');
  if (reason.length > 500) throw adminError(400, 'VALIDATION_ERROR', 'Причина длиннее 500 символов');
  return reason;
}

function account() {
  return require('./_app-account');
}

/** Безлимит по env или по снимку (_app-account.isUnlimited). Ошибка модуля не должна ронять список. */
function unlimitedByAccount(userId) {
  try {
    return Boolean(account().isUnlimited(userId));
  } catch (_) {
    return false;
  }
}

/** Только env-список владельцев — чтобы показать источник безлимита «env». */
function unlimitedByEnv(userId) {
  return String(process.env.APP_UNLIMITED_USER_IDS || '')
    .split(/[\s,]+/).filter(Boolean).map(s => s.toLowerCase())
    .includes(String(userId || '').toLowerCase());
}

function technical(email) {
  return Boolean(email?.endsWith('@users.invalid'));
}

function liveUntil(until, now = Date.now()) {
  return !until || Date.parse(until) > now;
}

let countsCache = null;

async function userCounts() {
  if (countsCache && Date.now() - countsCache.at < COUNTS_TTL_MS) return countsCache.value;
  const raw = await supabaseFetch('rpc/admin_user_counts', { method: 'POST', body: '{}' });
  const value = {};
  for (const key of COUNT_KEYS) value[key] = Number(raw?.[key] || 0);
  countsCache = { at: Date.now(), value };
  return value;
}

function loginMethodsFrom(authUser, telegramRow, oauthRows, subscriber) {
  return {
    email: {
      address: technical(authUser?.email) ? null : authUser?.email || null,
      confirmed: Boolean(authUser?.email_confirmed_at),
      technical: technical(authUser?.email),
    },
    telegram: telegramRow ? {
      username: telegramRow.username || null,
      telegramUserId: Number(telegramRow.telegram_user_id),
      linkedAt: telegramRow.created_at || null,
      bot: { started: Boolean(subscriber), blockedAt: subscriber?.blocked_at || null },
    } : null,
    oauth: (Array.isArray(oauthRows) ? oauthRows : []).map(row => ({
      provider: row.provider, email: row.email || null, displayName: row.display_name || null, linkedAt: row.created_at || null,
    })),
  };
}

async function telegramSubscriber(telegramUserId) {
  if (!telegramUserId) return null;
  const rows = await supabaseFetch(`telegram_bot_subscribers?telegram_user_id=eq.${encodeURIComponent(telegramUserId)}&select=blocked_at,activated_at&limit=1`).catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

/** Лимиты ПК, пунктов, зеркала и подборов для карточки: итог (null = безлимит) и «по тарифу» без ручных правок. */
function appLimits(ent, unlimited) {
  const plan = isPlan(ent?.plan) ? ent.plan : null;
  const addons = ent?.addons && typeof ent.addons === 'object' ? ent.addons : {};
  const total = accountLimits(plan, addons, ent?.device_limit, false, ent?.device_bonus, ent?.points_bonus);
  const base = accountLimits(plan, addons, ent?.device_limit, false, 0, 0);
  return {
    devices: unlimited ? null : total.devices,
    points: unlimited ? null : total.points,
    mirror: unlimited ? null : mirrorLimit(plan, addons, false, ent?.mirror_bonus),
    codesLimit: Number(ent?.codes_limit || 0),
    codesUsed: Number(ent?.codes_used || 0),
    base: {
      devices: base.devices,
      points: base.points,
      mirror: mirrorLimit(plan, addons, false, 0),
      codes: Number(ent?.codes_base ?? (plan ? ent?.codes_limit : 0) ?? 0) || 0,
    },
  };
}

function escapeTelegramHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rubText(value) {
  return `${Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ₽`;
}

/** Кнопки бота под сообщением о выдаче: раздел, куда смотреть, и меню (callback_data обрабатывает узел бота). */
function botKeyboard(...buttons) {
  return { inline_keyboard: [[...buttons, { text: '☰ Меню', callback_data: 'menu:home' }]] };
}

/**
 * Ручная выдача должна выглядеть для клиента так же, как покупка. Уведомление в кабинете и письмо — как раньше;
 * telegram ({ text, keyboard }) — отдельное сообщение в бот: у того, кто работает только в боте, почты нет
 * (telegram-…@users.invalid), и без него о выдаче он не узнает. Сбой Telegram не мешает выдаче.
 */
async function notifyUser(userId, title, body, link = '/cabinet/packages', telegram = null) {
  try {
    const user = await getAuthUser(userId);
    await createNotification({
      userId, kind: 'system', title, body, link,
      dedupeKey: `admin:${crypto.randomUUID()}`,
      email: user?.email?.endsWith('@users.invalid') ? null : user?.email,
    });
  } catch (error) {
    console.error('admin notification failed', error.message);
  }
  if (telegram?.text) await notifyTelegram(userId, telegram.text, telegram.keyboard);
}

async function notifyTelegram(userId, text, keyboard) {
  try {
    const rows = await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(userId)}&select=telegram_user_id&limit=1`);
    const telegramId = rows?.[0]?.telegram_user_id;
    if (!telegramId) return;
    // Через _telegram-api — с VPS сообщение уходит релеем, как напоминания из api/cabinet.js.
    await require('./_telegram-api').sendMessage(telegramId, text, keyboard ? { reply_markup: keyboard } : {});
  } catch (error) {
    console.warn('admin telegram notification failed', error.message);
  }
}

async function listUsers(req, res) {
  const page = Math.max(0, Number.parseInt(req.query.page || '0', 10) || 0);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize || '25', 10) || 25));
  const sort = SORTS.includes(String(req.query.sort)) ? String(req.query.sort) : 'created_at';
  const filter = FILTERS.includes(String(req.query.filter)) ? String(req.query.filter) : 'all';
  const rows = await supabaseFetch('rpc/admin_user_directory', {
    method: 'POST',
    body: JSON.stringify({
      p_search: String(req.query.q || '').slice(0, 120),
      p_limit: pageSize,
      p_offset: page * pageSize,
      p_sort: sort,
      p_filter: filter,
    }),
  });
  const now = Date.now();
  const items = (rows || []).map(row => {
    const plan = isPlan(row.app_plan) ? row.app_plan : null;
    const addons = row.app_addons && typeof row.app_addons === 'object' ? row.app_addons : {};
    // env-безлимит директория не знает — добавляем его здесь
    const unlimited = Boolean(row.unlimited) || unlimitedByAccount(row.user_id);
    const limits = accountLimits(plan, addons, row.app_device_limit, false, row.device_bonus, row.points_bonus);
    const paidUntil = row.app_paid_until || null;
    const endsAt = row.app_ends_at || null;
    const lastDay = paidUntil || endsAt;
    const restricted = Boolean(row.restricted);
    return {
      ...baseRow(row),
      walletKopecks: Number(row.wallet_kopecks || 0),
      app: {
        plan, endsAt, paidUntil,
        expiresInDays: lastDay ? Math.max(0, Math.ceil((Date.parse(lastDay) - now) / 86400000)) : null,
      },
      devices: { used: Number(row.devices_count || 0), limit: unlimited ? null : limits.devices },
      points: { used: Number(row.points_count || 0), limit: unlimited ? null : limits.points },
      lastSeenAt: row.last_seen_at || null,
      restricted,
      restriction: restricted
        ? { scopes: Array.isArray(row.restriction_scopes) && row.restriction_scopes.length ? row.restriction_scopes : ['all'], until: row.restriction_until || null }
        : null,
      unlimited,
      unlimitedUntil: row.unlimited ? row.unlimited_until || null : null,
    };
  });
  return res.json({ items, total: Number(rows?.[0]?.total_count || 0), page, pageSize, sort, filter });
}

function baseRow(row) {
  return {
    userId: row.user_id,
    email: row.email,
    emailConfirmed: row.email_confirmed,
    telegramOnly: row.telegram_only,
    banned: row.banned,
    createdAt: row.created_at,
    lastSignInAt: row.last_sign_in_at,
    displayName: row.display_name,
    phone: row.phone,
    payerStatus: row.payer_status,
    telegramUsername: row.telegram_username,
    codes: Number(row.codes_count || 0),
    generationLimit: Number(row.generation_limit || 0),
    generationUsed: Number(row.generation_used || 0),
    programKeys: Number(row.program_keys || 0),
    cellLicenses: Number(row.cell_licenses || 0),
    cellActive: Number(row.cell_active || 0),
    ordersPaid: Number(row.orders_paid || 0),
    revenueKopecks: Number(row.revenue_kopecks || 0),
    refundedKopecks: Number(row.refunded_kopecks || 0),
    lastOrderAt: row.last_order_at,
    referralCode: row.referral_code,
    referralEarnedKopecks: Number(row.referral_earned || 0),
    referralAvailableKopecks: Number(row.referral_available || 0),
    invited: Number(row.invited_count || 0),
  };
}

async function userDetail(req, res, userId) {
  const q = encodeURIComponent(userId);
  const [
    authUser, profiles, preferences, telegram, codes, programKeys, cellLicenses, orders, customOrders, referral, attributions,
    notifications, historyCount, actions, appSubscriptions, appDevices, appUsage, appEnt, appAddons, appPoints,
    overrideRows, restrictionRows, walletRows, oauthRows, bonusRows, partnerRows,
  ] = await Promise.all([
    getAuthUser(userId),
    supabaseFetch(`user_profiles?user_id=eq.${q}&select=*&limit=1`),
    supabaseFetch(`user_preferences?user_id=eq.${q}&select=*&limit=1`),
    supabaseFetch(`user_telegram_identities?user_id=eq.${q}&select=*&limit=1`),
    supabaseFetch(`sticker_access_codes?owner_user_id=eq.${q}&select=*&order=created_at.desc`),
    supabaseFetch(`license_keys?owner_user_id=eq.${q}&select=*&order=created_at.desc`),
    supabaseFetch(`cell_print_licenses?owner_user_id=eq.${q}&select=*&order=created_at.desc`),
    supabaseFetch(`payment_orders?user_id=eq.${q}&select=*&order=created_at.desc&limit=50`),
    supabaseFetch(`individual_sticker_orders?user_id=eq.${q}&select=id,title,quantity,total_amount,paid_amount,amount_due,credited_units,status,payment_order_id,fulfilled_at,created_at&order=created_at.desc&limit=50`),
    supabaseFetch(`referral_accounts?user_id=eq.${q}&select=*&limit=1`),
    supabaseFetch(`referral_attributions?referrer_user_id=eq.${q}&select=invited_user_id,attributed_at&order=attributed_at.desc&limit=100`),
    supabaseFetch(`in_app_notifications?user_id=eq.${q}&select=id,kind,title,created_at,read_at&order=created_at.desc&limit=20`),
    supabaseFetch(`user_generation_history?user_id=eq.${q}&select=id&limit=1000`),
    // без колонки response: там целый ответ действия, карточке он не нужен
    supabaseFetch(`admin_actions?target_user_id=eq.${q}&select=id,created_at,action,target_user_id,payload,admin_fingerprint,reason,before,after,result,user_agent&order=created_at.desc&limit=50`),
    // «Помощник ПВЗ»: подписки (отрезки), привязанные ПК и расход лимитов.
    supabaseFetch(`app_subscriptions?user_id=eq.${q}&select=*&order=starts_at.desc&limit=50`).catch(() => []),
    supabaseFetch(`app_devices?user_id=eq.${q}&select=*&order=last_seen_at.desc&limit=50`).catch(() => []),
    supabaseFetch(`app_usage?user_id=eq.${q}&select=*&order=created_at.desc&limit=100`).catch(() => []),
    supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) }).catch(() => null),
    supabaseFetch(`app_addons?user_id=eq.${q}&select=*&order=starts_at.desc&limit=50`).catch(() => []),
    supabaseFetch(`app_points?user_id=eq.${q}&select=id,wb_point_id,name,created_at,last_sync_at,mirror_at,revoked_at&order=created_at.asc`).catch(() => []),
    // Ручные лимиты, ограничение, кошелёк, способы входа, партнёр. Каждый запрос со своим catch:
    // карточка открывается и до миграций.
    supabaseFetch(`user_overrides?user_id=eq.${q}&select=*&limit=1`).catch(() => []),
    supabaseFetch(`user_restrictions?user_id=eq.${q}&lifted_at=is.null&select=*&limit=1`).catch(() => []),
    supabaseFetch(`wallet_accounts?user_id=eq.${q}&select=balance_kopecks,updated_at&limit=1`).catch(() => []),
    supabaseFetch(`user_oauth_identities?user_id=eq.${q}&select=provider,email,display_name,created_at&order=created_at.asc`).catch(() => []),
    supabaseFetch(`app_device_bonuses?user_id=eq.${q}&select=devices&limit=1`).catch(() => []),
    supabaseFetch(`partners?user_id=eq.${q}&select=id,name,active&limit=1`).catch(() => []),
  ]);
  if (!authUser) return res.status(404).json({ error: 'Пользователь не найден', code: 'NOT_FOUND' });
  const telegramRow = telegram[0] || null;
  const subscriber = telegramRow ? await telegramSubscriber(telegramRow.telegram_user_id) : null;
  let online = new Set();
  try {
    online = require('./_app-relay').onlineIds(userId);
  } catch (error) {
    console.error('relay online ids failed', error.message);
  }
  const overrideRow = Array.isArray(overrideRows) ? overrideRows[0] || null : null;
  const restrictionRow = Array.isArray(restrictionRows) ? restrictionRows[0] || null : null;
  const walletRow = Array.isArray(walletRows) ? walletRows[0] || null : null;
  const partnerRow = Array.isArray(partnerRows) ? partnerRows[0] || null : null;
  const envUnlimited = unlimitedByEnv(userId);
  const overrideUnlimited = (Boolean(overrideRow?.unlimited) && liveUntil(overrideRow?.unlimited_until)) || appEnt?.unlimited === true;
  const unlimitedActive = envUnlimited || overrideUnlimited || unlimitedByAccount(userId);
  const unlimitedSource = envUnlimited ? 'env' : unlimitedActive ? 'override' : null;
  const licenseIds = cellLicenses.map(row => row.id);
  const activations = licenseIds.length
    ? await supabaseFetch(`cell_print_activations?license_id=in.(${licenseIds.join(',')})&select=*&order=last_seen_at.desc`)
    : [];
  const invitedIds = attributions.map(row => row.invited_user_id);
  const invitedFilter = invitedIds.length ? `(${invitedIds.map(encodeURIComponent).join(',')})` : '';
  const [referralProfiles, referralOrders, referralLedger] = await Promise.all([
    invitedIds.length
      ? supabaseFetch(`user_profiles?user_id=in.${invitedFilter}&select=user_id,display_name,phone&limit=100`)
      : [],
    invitedIds.length
      ? supabaseFetch(`payment_orders?user_id=in.${invitedFilter}&select=id,user_id,status,product_kind,amount,gross_amount,refunded_kopecks,created_at,paid_at&order=created_at.desc&limit=5000`)
      : [],
    supabaseFetch(`referral_ledger?user_id=eq.${q}&kind=in.(reward,reversal)&select=kind,amount_kopecks,order_id,created_at&order=created_at.asc&limit=5000`),
  ]);
  const referralAuthUsers = [];
  for (let index = 0; index < invitedIds.length; index += 10) {
    referralAuthUsers.push(...await Promise.all(invitedIds.slice(index, index + 10).map(getAuthUser)));
  }
  const referralProfileById = new Map(referralProfiles.map(row => [row.user_id, row]));
  const referralAuthById = new Map(referralAuthUsers.filter(Boolean).map(row => [row.id, row]));
  const referredUsers = attributions.map(attribution => {
    const invitedUserId = attribution.invited_user_id;
    const invitedOrders = referralOrders.filter(row => row.user_id === invitedUserId);
    const orderIds = new Set(invitedOrders.map(row => row.id));
    const rewards = referralLedger.filter(row => orderIds.has(row.order_id));
    const auth = referralAuthById.get(invitedUserId);
    const profile = referralProfileById.get(invitedUserId);
    return {
      userId: invitedUserId,
      email: auth?.email?.endsWith('@users.invalid') ? null : auth?.email || null,
      displayName: profile?.display_name || auth?.user_metadata?.full_name || auth?.user_metadata?.username || null,
      phone: profile?.phone || auth?.phone || null,
      registeredAt: auth?.created_at || null,
      attributedAt: attribution.attributed_at,
      paidOrders: invitedOrders.filter(row => row.status === 'succeeded').length,
      paidKopecks: invitedOrders.filter(row => row.status === 'succeeded').reduce((sum, row) => sum + Math.round(Number(row.amount || 0) * 100), 0),
      refundedKopecks: invitedOrders.reduce((sum, row) => sum + Number(row.refunded_kopecks || 0), 0),
      rewardedKopecks: rewards.filter(row => row.kind === 'reward').reduce((sum, row) => sum + Number(row.amount_kopecks || 0), 0),
      reversedKopecks: -rewards.filter(row => row.kind === 'reversal').reduce((sum, row) => sum + Number(row.amount_kopecks || 0), 0),
      earnedKopecks: rewards.reduce((sum, row) => sum + Number(row.amount_kopecks || 0), 0),
      orders: invitedOrders.map(row => ({
        id: row.id,
        status: row.status,
        productKind: row.product_kind,
        amountKopecks: Math.round(Number(row.amount || 0) * 100),
        grossKopecks: Math.round(Number(row.gross_amount ?? row.amount ?? 0) * 100),
        refundedKopecks: Number(row.refunded_kopecks || 0),
        createdAt: row.created_at,
        paidAt: row.paid_at,
      })),
    };
  });
  const account = referral[0] || {};
  return res.json({
    userId,
    email: authUser.email?.endsWith('@users.invalid') ? null : authUser.email || null,
    telegramOnly: Boolean(authUser.email?.endsWith('@users.invalid')),
    emailConfirmed: Boolean(authUser.email_confirmed_at),
    banned: Boolean(authUser.banned_until && Date.parse(authUser.banned_until) > Date.now()),
    createdAt: authUser.created_at,
    lastSignInAt: authUser.last_sign_in_at || null,
    // Подтверждение удаления сверяется с этим значением, поэтому отдаём и
    // техническую почту telegram-аккаунта, у которой нет публичного вида.
    confirmValue: authUser.email || userId,
    profile: profiles[0] || null,
    preferences: preferences[0] || null,
    telegram: telegram[0] || null,
    codes: codes.map(RESOURCES.stickerAccess.fromDb),
    programKeys: programKeys.map(RESOURCES.key.fromDb),
    cellLicenses: cellLicenses.map(row => ({
      ...RESOURCES.cellLicense.fromDb(row),
      devices: activations.filter(a => a.license_id === row.id).map(RESOURCES.cellActivation.fromDb),
    })),
    orders,
    customOrders,
    referral: {
      code: account.referral_code || null,
      availableKopecks: Number(account.available_kopecks || 0),
      earnedKopecks: Number(account.earned_kopecks || 0),
      paidKopecks: Number(account.paid_kopecks || 0),
      invited: attributions.length,
      referrals: referredUsers,
    },
    notifications,
    historyEntries: historyCount.length,
    actions,
    overrides: require('./_admin-limits').overridesDto(overrideRow),
    legacyDeviceBonus: Number(bonusRows?.[0]?.devices || 0),
    restriction: restrictionRow ? require('./_admin-restrictions').restrictionDto(restrictionRow) : null,
    // то же правило, что в restrict: ограничить такой аккаунт можно только с force
    protected: unlimitedActive,
    partner: partnerRow ? { id: partnerRow.id, name: partnerRow.name, active: Boolean(partnerRow.active) } : null,
    unlimited: {
      active: unlimitedActive,
      source: unlimitedSource,
      until: unlimitedSource === 'override' ? overrideRow?.unlimited_until || appEnt?.unlimited_until || null : null,
    },
    wallet: { balanceKopecks: Number(walletRow?.balance_kopecks || 0), updatedAt: walletRow?.updated_at || null },
    loginMethods: loginMethodsFrom(authUser, telegramRow, oauthRows, subscriber),
    app: {
      entitlements: appEnt || null,
      limits: appLimits(appEnt, unlimitedActive),
      subscriptions: (appSubscriptions || []).map(s => ({
        id: s.id, plan: s.plan, startsAt: s.starts_at, endsAt: s.ends_at, canceled: s.canceled,
        source: s.source, monthlyPrice: Number(s.monthly_price), codes: s.codes_per_month,
        stickers: s.stickers_per_month, deviceLimit: s.device_limit, createdAt: s.created_at,
      })),
      devices: (appDevices || []).map(d => ({
        id: d.id, name: d.name, appVersion: d.app_version, lastSeenAt: d.last_seen_at,
        createdAt: d.created_at, revokedAt: d.revoked_at,
        role: d.role === 'owner' || d.role === 'work' ? d.role : null,
        online: online.has(d.id),
        pointWb: d.point_wb || null,
      })),
      usage: (appUsage || []).map(u => ({
        id: u.id, kind: u.kind, amount: u.amount, source: u.source, createdAt: u.created_at,
      })),
      points: (appPoints || []).map(p => ({
        id: p.id, wbPointId: String(p.wb_point_id), name: p.name, createdAt: p.created_at,
        lastSyncAt: p.last_sync_at, mirrorAt: p.mirror_at, revokedAt: p.revoked_at,
      })),
      addons: (appAddons || []).map(a => ({
        id: a.id, addon: a.addon, title: ADDONS[a.addon]?.title || a.addon, startsAt: a.starts_at, endsAt: a.ends_at,
        canceled: a.canceled, source: a.source, price: Number(a.price), createdAt: a.created_at,
      })),
    },
  });
}

/** Тяжёлые разделы карточки — по вкладкам, а не в detail (трафик Supabase). */
async function userSection(section, userId) {
  const q = encodeURIComponent(userId);
  if (section === 'wallet') {
    const [accounts, ledger] = await Promise.all([
      supabaseFetch(`wallet_accounts?user_id=eq.${q}&select=balance_kopecks&limit=1`).catch(() => []),
      supabaseFetch(`wallet_ledger?user_id=eq.${q}&select=id,kind,amount_kopecks,order_id,details,created_at&order=created_at.desc&limit=50`),
    ]);
    return {
      balanceKopecks: Number(accounts?.[0]?.balance_kopecks || 0),
      ledger: (ledger || []).map(row => ({
        id: Number(row.id), kind: row.kind, amountKopecks: Number(row.amount_kopecks || 0), orderId: row.order_id || null,
        note: typeof row.details?.note === 'string' && row.details.note ? row.details.note : null, createdAt: row.created_at,
      })),
    };
  }
  if (section === 'usage') {
    const [usage, devices] = await Promise.all([
      supabaseFetch(`app_usage?user_id=eq.${q}&select=id,kind,amount,source,device_id,meta,created_at&order=created_at.desc&limit=100`),
      supabaseFetch(`app_devices?user_id=eq.${q}&select=id,name&limit=200`).catch(() => []),
    ]);
    const names = new Map((devices || []).map(d => [d.id, d.name]));
    return {
      items: (usage || []).map(row => ({
        id: Number(row.id), kind: row.kind, amount: Number(row.amount || 0), source: row.source,
        deviceName: row.device_id ? names.get(row.device_id) || null : null,
        via: typeof row.meta?.via === 'string' ? row.meta.via : null, createdAt: row.created_at,
      })),
    };
  }
  if (section === 'charges') {
    const rows = await supabaseFetch(`sticker_generation_charges?user_id=eq.${q}&select=id,mode,category,quantity,price_kopecks,payment_source,status,created_at&order=created_at.desc&limit=50`);
    return {
      items: (rows || []).map(row => ({
        id: row.id, mode: row.mode, category: row.category, quantity: Number(row.quantity || 0),
        priceKopecks: Number(row.price_kopecks || 0), paymentSource: row.payment_source || 'wallet', status: row.status, createdAt: row.created_at,
      })),
    };
  }
  if (section === 'cellDevices') {
    const rows = await supabaseFetch(`cell_print_devices?user_id=eq.${q}&select=id,name,app_version,first_seen_at,last_seen_at,revoked_at&order=last_seen_at.desc&limit=50`);
    return {
      items: (rows || []).map(row => ({
        id: Number(row.id), name: row.name || '', appVersion: row.app_version || '', firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at || null,
      })),
    };
  }
  if (section === 'logins') {
    const [authUser, telegram, oauth] = await Promise.all([
      getAuthUser(userId),
      supabaseFetch(`user_telegram_identities?user_id=eq.${q}&select=telegram_user_id,username,created_at&limit=1`).catch(() => []),
      supabaseFetch(`user_oauth_identities?user_id=eq.${q}&select=provider,email,display_name,created_at&order=created_at.asc`).catch(() => []),
    ]);
    if (!authUser) throw adminError(404, 'NOT_FOUND', 'Пользователь не найден');
    const telegramRow = telegram?.[0] || null;
    const subscriber = telegramRow ? await telegramSubscriber(telegramRow.telegram_user_id) : null;
    return loginMethodsFrom(authUser, telegramRow, oauth, subscriber);
  }
  throw adminError(400, 'VALIDATION_ERROR', 'Неизвестный раздел карточки');
}

async function requireAuthUser(userId) {
  const authUser = await getAuthUser(userId);
  if (!authUser) throw adminError(404, 'NOT_FOUND', 'Пользователь не найден');
  return authUser;
}

/**
 * Завершить сеансы пользователя на сайте и в программе: у GoTrue Admin API нет «выйти везде», поэтому
 * открываем сеанс от имени пользователя (как вход через Telegram) и зовём logout?scope=global его токеном.
 * Ключи ПК и app_devices не трогаем — фоновая работа программы по ключу продолжается.
 */
async function logoutAll(req, res, userId) {
  const reason = requiredReason(req);
  const authUser = await requireAuthUser(userId);
  // Сеанс открывается через magiclink, а его проверка в GoTrue подтверждает почту. Неподтверждённую почту
  // так подтверждать нельзя — и сеансов у такого аккаунта нет: без подтверждения вход по паролю не пускает,
  // а Telegram, OAuth и программа создают аккаунты уже с подтверждённой почтой.
  if (!authUser.email_confirmed_at) {
    throw adminError(409, 'LOGOUT_UNAVAILABLE', 'Почта не подтверждена — у аккаунта нет открытых сеансов, завершать нечего');
  }
  let session;
  try {
    session = await account().sessionForUser(userId);
  } catch (error) {
    console.error('admin logoutAll session failed', error.message);
    throw adminError(409, 'LOGOUT_FAILED', 'Не удалось открыть сеанс пользователя, чтобы завершить остальные. Если аккаунт ограничен полностью, его сеансы уже завершены');
  }
  const { url, publishableKey } = authConfig();
  const response = await fetch(`${url}/auth/v1/logout?scope=global`, {
    method: 'POST',
    headers: { apikey: publishableKey, Authorization: `Bearer ${session?.access_token}` },
  });
  if (!response.ok) throw new Error(`GoTrue logout failed (${response.status})`);
  // В журнале отмечаем, что для выхода открывался сеанс от имени пользователя (magiclink без письма).
  await recordAdminAction(req, 'logoutAll', userId, { via: 'session_on_behalf' }, { reason, after: { sessions: 'ended' } });
  return res.json({ ok: true, devicesRevoked: 0 });
}

async function unlinkTelegram(req, res, userId) {
  const reason = requiredReason(req);
  const authUser = await requireAuthUser(userId);
  if (technical(authUser.email)) {
    throw adminError(409, 'LAST_LOGIN_METHOD', 'Это аккаунт Telegram без почты — после отвязки в него будет не войти');
  }
  const q = encodeURIComponent(userId);
  const rows = await supabaseFetch(`user_telegram_identities?user_id=eq.${q}&select=telegram_user_id,username&limit=1`);
  if (!rows.length) throw adminError(404, 'NOT_FOUND', 'Telegram не привязан');
  await supabaseFetch(`user_telegram_identities?user_id=eq.${q}`, { method: 'DELETE' });
  require('./_telegram-user-cache').forgetSiteUser(userId);
  // Бот живёт отдельным процессом (узел в Германии) и держит связку в памяти до 10 минут.
  await Promise.resolve()
    .then(() => require('./_bot-rpc').callBot('forgetSiteUser', userId))
    .catch(error => console.warn('bot cache reset after unlink failed', error.message));
  const label = rows[0].username ? `@${rows[0].username}` : `tg:${rows[0].telegram_user_id}`;
  await recordAdminAction(req, 'unlinkTelegram', userId, { telegramUserId: Number(rows[0].telegram_user_id) }, {
    reason, before: { telegram: label }, after: { telegram: null },
  });
  return res.json({ ok: true });
}

async function unlinkOAuth(req, res, userId) {
  const provider = String(req.body?.provider || '');
  if (!OAUTH_PROVIDERS.includes(provider)) throw adminError(400, 'VALIDATION_ERROR', 'Неизвестный способ входа');
  const reason = requiredReason(req);
  const authUser = await requireAuthUser(userId);
  const q = encodeURIComponent(userId);
  const oauth = require('./_oauth-login');
  // Правило кабинета: у аккаунта без почты должен остаться Telegram или другой провайдер.
  if (technical(authUser.email)) {
    const [tg, others] = await Promise.all([
      supabaseFetch(`user_telegram_identities?user_id=eq.${q}&select=user_id&limit=1`),
      oauth.identitiesForUser(userId),
    ]);
    if (!tg.length && others.filter(row => row.provider !== provider).length === 0) {
      throw adminError(409, 'LAST_LOGIN_METHOD', 'Это последний способ входа — после отвязки в аккаунт будет не войти');
    }
  }
  await oauth.unlinkIdentity(userId, provider);
  await recordAdminAction(req, 'unlinkOAuth', userId, { provider }, { reason, before: { provider }, after: { provider: null } });
  return res.json({ ok: true });
}

async function setDeviceRoleAction(req, res, userId) {
  const deviceId = String(req.body?.deviceId || '');
  const role = String(req.body?.role || '');
  if (!isUuid(deviceId)) throw adminError(400, 'VALIDATION_ERROR', 'Некорректное устройство');
  if (role !== 'owner' && role !== 'work') throw adminError(400, 'VALIDATION_ERROR', 'Роль компьютера: владелец или сотрудник');
  const result = await account().setDeviceRole({ id: userId, email: null }, deviceId, role, { by: null });
  await recordAdminAction(req, 'setDeviceRole', userId, { deviceId, role }, logOptions(req, { after: { role: result.role } }));
  return res.json(result);
}

async function handler(req, res) {
  const action = String(req.query.action || 'list');
  const userId = String(req.body?.userId || req.query.userId || '');
  try {
    const delegated = DELEGATED[`${req.method} ${action}`];
    if (delegated) {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      return await delegated()(req, res, { userId });
    }
    if (req.method === 'GET' && action === 'counts') return res.json(await userCounts());
    if (req.method === 'GET' && action === 'detailSection') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const section = String(req.query.section || '');
      if (SECTIONS_MESSAGES.includes(section)) return res.json(await require('./_admin-messages').userSection(section, userId));
      if (!SECTIONS_HERE.includes(section)) return badRequest(res, 'Неизвестный раздел карточки');
      return res.json(await userSection(section, userId));
    }
    if (req.method === 'POST' && ['logoutAll', 'unlinkTelegram', 'unlinkOAuth', 'setDeviceRole'].includes(action)) {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      if (action === 'logoutAll') return await logoutAll(req, res, userId);
      if (action === 'unlinkTelegram') return await unlinkTelegram(req, res, userId);
      if (action === 'unlinkOAuth') return await unlinkOAuth(req, res, userId);
      return await setDeviceRoleAction(req, res, userId);
    }
    if (req.method === 'GET' && action === 'summary') {
      return res.json(await supabaseFetch('rpc/admin_user_summary', { method: 'POST', body: '{}' }));
    }
    if (req.method === 'GET' && action === 'list') return await listUsers(req, res);
    if (req.method === 'GET' && action === 'detail') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      return await userDetail(req, res, userId);
    }

    if (req.method === 'POST' && action === 'grantSticker') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const created = await createStickerAccessCode({
        name: req.body?.name, limit: req.body?.limit, ownerUserId: userId,
      });
      if (created.error) return badRequest(res, created.error);
      await recordAdminAction(req, 'grantSticker', userId, { code: created.row.code, limit: created.row.generation_limit }, logOptions(req));
      await notifyUser(userId, 'Вам выдан код доступа',
        `Код ${created.row.code} — ${created.row.generation_limit} генераций. Он уже доступен в кабинете.`, undefined, {
          text: `🎁 <b>Вам выдан пакет стикеров</b>\n${created.row.generation_limit} шт., код доступа <code>${escapeTelegramHtml(created.row.code)}</code>. Он уже добавлен в ваш профиль.`,
          keyboard: botKeyboard({ text: '👤 Профиль', callback_data: 'menu:profile' }),
        });
      return res.status(201).json(RESOURCES.stickerAccess.fromDb(created.row));
    }
    if (req.method === 'POST' && action === 'createIndividualStickerOrder') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const title = String(req.body?.title || '').trim();
      const rawCodes = Array.isArray(req.body?.codes)
        ? req.body.codes
        : String(req.body?.codes || '').match(/(?<!\d)\d{11}(?!\d)/g) || [];
      const codes = [...new Set(rawCodes.map(value => String(value)))];
      const totalAmount = Number(req.body?.totalAmount);
      const creditUnits = Number(req.body?.creditUnits || 0);
      if (!title || title.length > 160 || !codes.length || codes.length > 10000 ||
          codes.some(code => !/^\d{11}$/.test(code)) || !Number.isFinite(totalAmount) || totalAmount < 0 ||
          !Number.isInteger(creditUnits) || creditUnits < 0 || creditUnits > codes.length)
        return badRequest(res, 'Проверьте название, номера, сумму и число зачтённых генераций');
      const created = await supabaseFetch('rpc/create_individual_sticker_order', {
        method: 'POST', body: JSON.stringify({
          p_user_id: userId, p_title: title, p_codes: codes,
          p_total_amount: totalAmount, p_credit_units: creditUnits,
        }),
      });
      const orderId = String(created);
      await recordAdminAction(req, 'createIndividualStickerOrder', userId, {
        orderId, quantity: codes.length, totalAmount, creditUnits,
      }, logOptions(req));
      // К оплате — как в create_individual_sticker_order: сумма минус зачтённые стикеры по средней цене.
      const amountDue = Math.round((totalAmount - Math.round(creditUnits * (totalAmount / codes.length) * 100) / 100) * 100) / 100;
      await notifyUser(userId, 'Выставлен индивидуальный заказ',
        `${title}: ${codes.length} стикеров. После оплаты они появятся в истории и станут доступны для скачивания.`, '/cabinet/orders', {
          // Всё зачтено стикерами из пакета (0 ₽) — не «оплатите 0 ₽», а «доплата не нужна».
          text: amountDue > 0
            ? `<b>📦 Вам выставлен заказ</b>\n«${escapeTelegramHtml(title)}» — ${codes.length} стикеров, ${rubText(amountDue)}.\nОплатите — и PDF появятся здесь, в боте.`
            : `<b>📦 Вам выставлен заказ</b>\n«${escapeTelegramHtml(title)}» — ${codes.length} стикеров, доплата не нужна.\nОткройте заказ и нажмите «Получить PDF».`,
          keyboard: { inline_keyboard: [[{ text: '📦 Открыть заказ', callback_data: 'orders:list' }]] },
        });
      return res.status(201).json({ id: orderId, quantity: codes.length });
    }
    if (req.method === 'POST' && action === 'topupSticker') {
      const codeId = Number(req.body?.codeId);
      if (!Number.isInteger(codeId)) return badRequest(res, 'Некорректный код');
      const result = await addStickerGenerations(codeId, req.body?.add);
      if (result.error) return badRequest(res, result.error);
      await recordAdminAction(req, 'topupSticker', userId, { codeId, add: Number(req.body?.add) }, logOptions(req));
      if (isUuid(userId)) {
        await notifyUser(userId, 'Пакет генераций пополнен',
          `К коду ${result.row.code} добавлено ${Number(req.body?.add)} генераций.`, undefined, {
            text: `🎁 <b>Пакет стикеров пополнен</b>\nК коду <code>${escapeTelegramHtml(result.row.code)}</code> добавлено ${Number(req.body?.add)} шт.`,
            keyboard: botKeyboard({ text: '👤 Профиль', callback_data: 'menu:profile' }),
          });
      }
      return res.json(RESOURCES.stickerAccess.fromDb(result.row));
    }
    if (req.method === 'POST' && action === 'grantProgramKey') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const created = await createProgramKey({
        key: req.body?.key, limit: req.body?.limit, note: req.body?.note, ownerUserId: userId,
      });
      if (created.error) return badRequest(res, created.error);
      await recordAdminAction(req, 'grantProgramKey', userId, { key: created.row.key, limit: created.row.usage_limit }, logOptions(req));
      await notifyUser(userId, 'Вам выдан пакет подборов «Помощник ПВЗ»',
        `Ключ ${created.row.key}, ${created.row.usage_limit} подборов.`, '/cabinet/keys', {
          text: `🎁 <b>Вам выдан пакет кодов клиента</b>\n${created.row.usage_limit} шт.`,
          keyboard: botKeyboard({ text: '🔑 Код клиента', callback_data: 'menu:code' }),
        });
      return res.status(201).json(RESOURCES.key.fromDb(created.row));
    }
    if (req.method === 'POST' && action === 'grantCellLicense') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const created = await createCellLicense({
        durationDays: req.body?.durationDays, deviceLimit: req.body?.deviceLimit,
        marketplaceScope: req.body?.marketplaceScope || 'wb', note: req.body?.note, ownerUserId: userId,
      });
      if (created.error) return badRequest(res, created.error);
      await recordAdminAction(req, 'grantCellLicense', userId, { key: created.row.key, durationDays: created.row.duration_days }, logOptions(req));
      await notifyUser(userId, 'Вам выдан ключ «Печати ячеек»',
        `Ключ ${created.row.key} на ${created.row.duration_days} дней, устройств: ${created.row.device_limit}.`, '/cabinet/keys', {
          text: `🎁 <b>Вам выдан ключ «ПВЗ Принт» (печать ячеек)</b>\n<code>${escapeTelegramHtml(created.row.key)}</code> — ${created.row.duration_days} дн., компьютеров: ${created.row.device_limit}.\nВведите ключ в программе «ПВЗ Принт».`,
          keyboard: botKeyboard({ text: '🖨 ПВЗ Принт', callback_data: 'menu:cellprint' }),
        });
      return res.status(201).json(RESOURCES.cellLicense.fromDb(created.row));
    }
    // Выдать подписку «Помощник ПВЗ» помимо оплаты: тариф применяется той же
    // логикой, что и платная (продление/повышение/понижение), source='admin'.
    if (req.method === 'POST' && action === 'grantAppSubscription') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const plan = String(req.body?.plan || '');
      const months = Number(req.body?.months || 0);
      if (!isPlan(plan) || !isTerm(months)) return badRequest(res, 'Выберите тариф и срок');
      const snap = orderSnapshot(plan, months);
      if (!snap) return badRequest(res, 'Не удалось собрать тариф');
      await supabaseFetch('rpc/admin_grant_app_subscription', {
        method: 'POST',
        body: JSON.stringify({ p_user: userId, p_plan: plan, p_months: months, p_snap: snap.app }),
      });
      await recordAdminAction(req, 'grantAppSubscription', userId, { plan, months }, logOptions(req));
      await notifyUser(userId, 'Вам выдана подписка «Помощник ПВЗ»',
        `Тариф ${PLANS[plan].title} на ${months} мес. Программа готова к работе.`, '/cabinet/subscription', {
          text: `🎁 <b>Вам выдана подписка «Помощник ПВЗ»</b>\nТариф «${escapeTelegramHtml(PLANS[plan].title)}» на ${months} мес. Программа готова к работе.`,
          keyboard: botKeyboard({ text: '💻 Помощник ПВЗ', callback_data: 'menu:helper' }),
        });
      return res.status(201).json({ ok: true });
    }
    // Отозвать конкретный отрезок подписки (активный обрывается сейчас).
    if (req.method === 'POST' && action === 'revokeAppSubscription') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const subId = String(req.body?.id || '');
      if (!isUuid(subId)) return badRequest(res, 'Некорректная подписка');
      await supabaseFetch('rpc/admin_revoke_app_subscription', {
        method: 'POST', body: JSON.stringify({ p_sub: subId }),
      });
      await recordAdminAction(req, 'revokeAppSubscription', userId, { id: subId }, logOptions(req));
      return res.status(200).json({ ok: true });
    }
    // Выдать доп. услугу (архив) помимо оплаты: продлевает от конца активной, source='admin'.
    if (req.method === 'POST' && action === 'grantAppAddon') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const addon = String(req.body?.addon || '');
      const months = Number(req.body?.months || 0);
      if (!isAddon(addon) || addonPrice(addon, months) == null) return badRequest(res, 'Выберите услугу и срок');
      await supabaseFetch('rpc/admin_grant_app_addon', {
        method: 'POST', body: JSON.stringify({ p_user: userId, p_addon: addon, p_months: months }),
      });
      await recordAdminAction(req, 'grantAppAddon', userId, { addon, months }, logOptions(req));
      const addonTitle = ADDONS[addon].kind === 'pack' ? `Вам подключено: «${ADDONS[addon].title}»` : `Вам подключена услуга «${ADDONS[addon].title}»`;
      const addonBody = ADDONS[addon].kind === 'pack'
        ? `Срок — ${months} мес. ${ADDONS[addon].summary}.`
        : `Срок — ${months} мес. Услуга работает вместе с тарифом «${PLANS[ADDONS[addon].minPlan].title}» или выше.`;
      await notifyUser(userId, addonTitle, addonBody, '/cabinet/subscription', {
        text: `🎁 <b>${escapeTelegramHtml(addonTitle)} («Помощник ПВЗ»)</b>\n${escapeTelegramHtml(addonBody)}`,
        keyboard: botKeyboard({ text: '💻 Помощник ПВЗ', callback_data: 'menu:helper' }),
      });
      return res.status(201).json({ ok: true });
    }
    if (req.method === 'POST' && action === 'revokeAppAddon') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const addonId = String(req.body?.id || '');
      if (!isUuid(addonId)) return badRequest(res, 'Некорректная услуга');
      await supabaseFetch('rpc/admin_revoke_app_addon', { method: 'POST', body: JSON.stringify({ p_addon_id: addonId }) });
      await recordAdminAction(req, 'revokeAppAddon', userId, { id: addonId }, logOptions(req));
      return res.status(200).json({ ok: true });
    }
    // Отключить пункт (освобождает слот в лимите пунктов; облачные данные пункта остаются).
    if (req.method === 'POST' && action === 'revokeAppPoint') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const pointId = String(req.body?.id || '');
      if (!isUuid(pointId)) return badRequest(res, 'Некорректный пункт');
      await supabaseFetch(`app_points?id=eq.${encodeURIComponent(pointId)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH', body: JSON.stringify({ revoked_at: new Date().toISOString() }),
      });
      await recordAdminAction(req, 'revokeAppPoint', userId, { id: pointId }, logOptions(req));
      return res.status(200).json({ ok: true });
    }
    // Отвязать ПК от аккаунта (освобождает слот в лимите устройств).
    if (req.method === 'POST' && action === 'revokeAppDevice') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const deviceId = String(req.body?.id || '');
      if (!isUuid(deviceId)) return badRequest(res, 'Некорректное устройство');
      await supabaseFetch(`app_devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH', body: JSON.stringify({ revoked_at: new Date().toISOString() }),
      });
      await recordAdminAction(req, 'revokeAppDevice', userId, { id: deviceId }, logOptions(req));
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'POST' && action === 'attach') {
      // Привязка уже существующего актива: человек купил без входа, а потом
      // завёл аккаунт, но код к нему не подтянулся.
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const kind = String(req.body?.kind || '');
      const value = String(req.body?.value || '').trim();
      const target = { sticker: ['sticker_access_codes', 'code'], program: ['license_keys', 'key'], cell_print: ['cell_print_licenses', 'key'] }[kind];
      if (!target || !/^[A-Za-z0-9-]{4,64}$/.test(value)) return badRequest(res, 'Проверьте тип и значение');
      const [table, column] = target;
      const rows = await supabaseFetch(`${table}?${column}=eq.${encodeURIComponent(kind === 'sticker' ? value : value.toUpperCase())}&owner_user_id=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ owner_user_id: userId }),
      });
      if (!rows.length) return res.status(409).json({ error: 'Актив не найден или уже принадлежит другому аккаунту' });
      await recordAdminAction(req, 'attach', userId, { kind, value }, logOptions(req));
      return res.json({ attached: true });
    }
    // notify, block и unblock — в таблице DELEGATED (_admin-messages, _admin-restrictions)
    if (req.method === 'POST' && action === 'profile') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const patch = { updated_at: new Date().toISOString() };
      if ('displayName' in (req.body || {})) patch.display_name = String(req.body.displayName || '').slice(0, 120);
      if ('phone' in (req.body || {})) patch.phone = String(req.body.phone || '').slice(0, 32);
      if ('payerStatus' in (req.body || {})) {
        if (!['individual', 'self_employed', 'entrepreneur'].includes(req.body.payerStatus)) return badRequest(res, 'Неизвестный статус плательщика');
        patch.payer_status = req.body.payerStatus;
      }
      const rows = await supabaseFetch(`user_profiles?user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      await recordAdminAction(req, 'profile', userId, patch, logOptions(req, { after: patch }));
      return res.json(rows[0] || {});
    }
    // Индивидуальное исключение из подтверждения кода клиента через бот: {enabled:false} → код напрямую
    // даже при включённом глобальном флаге app_code_via_bot (владелец без Telegram).
    if (req.method === 'POST' && action === 'appCodeViaBot') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const off = req.body?.enabled === false;
      await setCodeViaBotOffForUser(userId, off);
      await recordAdminAction(req, 'appCodeViaBot', userId, { enabled: !off }, logOptions(req));
      return res.json({ enabled: !off });
    }

    if (req.method === 'PATCH' && action === 'code') {
      const id = Number(req.body?.codeId);
      if (!Number.isInteger(id)) return badRequest(res, 'Некорректный код');
      const patch = {};
      if ('name' in (req.body || {})) patch.name = req.body.name;
      if ('limit' in (req.body || {})) patch.limit = req.body.limit;
      if ('active' in (req.body || {})) patch.active = req.body.active;
      const checked = await checkStickerAccessPatch(id, patch);
      if (checked.error) return res.status(checked.status || 400).json({ error: checked.error });
      const rows = await supabaseFetch(`sticker_access_codes?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(RESOURCES.stickerAccess.toDb(patch)),
      });
      await recordAdminAction(req, 'patchCode', userId, { codeId: id, ...patch }, logOptions(req, { after: patch }));
      return res.json(RESOURCES.stickerAccess.fromDb(rows[0]));
    }
    if (req.method === 'PATCH' && action === 'programKey') {
      const id = Number(req.body?.id);
      if (!Number.isInteger(id)) return badRequest(res, 'Некорректный ключ');
      const patch = {};
      if ('limit' in (req.body || {})) patch.limit = Number(req.body.limit);
      if ('active' in (req.body || {})) patch.active = Boolean(req.body.active);
      const rows = await supabaseFetch(`license_keys?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(RESOURCES.key.toDb(patch)),
      });
      await recordAdminAction(req, 'patchProgramKey', userId, { id, ...patch }, logOptions(req, { after: patch }));
      return res.json(RESOURCES.key.fromDb(rows[0]));
    }
    if (req.method === 'PATCH' && action === 'cellLicense') {
      const id = Number(req.body?.id);
      if (!Number.isInteger(id)) return badRequest(res, 'Некорректный ключ');
      const checked = await checkCellLicensePatch(id, req.body || {});
      if (checked.error) return res.status(checked.status || 400).json({ error: checked.error });
      const rows = await supabaseFetch(`cell_print_licenses?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ ...RESOURCES.cellLicense.toDb(req.body || {}), ...(checked.extra || {}) }),
      });
      await recordAdminAction(req, 'patchCellLicense', userId, { id, ...(req.body || {}) }, logOptions(req, { after: RESOURCES.cellLicense.fromDb(rows[0] || {}) }));
      return res.json(RESOURCES.cellLicense.fromDb(rows[0]));
    }

    if (req.method === 'DELETE' && action === 'account') {
      if (!isUuid(userId)) return badRequest(res, 'Некорректный идентификатор пользователя');
      const authUser = await getAuthUser(userId);
      if (!authUser) return res.status(404).json({ error: 'Пользователь не найден' });
      // Промах по строке в списке стоит слишком дорого: удаление необратимо,
      // поэтому просим ввести почту удаляемого вручную.
      const confirm = String(req.body?.confirm || '').trim();
      if (!confirm || confirm !== String(authUser.email || userId)) {
        return res.status(409).json({ error: 'Введите почту пользователя для подтверждения' });
      }
      await recordAdminAction(req, 'deleteAccount', userId, { email: authUser.email }, logOptions(req));
      await deleteAuthUser(userId);
      return res.status(204).end();
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return sendAdminError(res, error);
  }
}

handler.FILTERS = FILTERS;
handler.SORTS = SORTS;
handler.DELEGATED = DELEGATED;
handler.userSection = userSection;
module.exports = handler;
