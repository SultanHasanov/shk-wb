// Журнал админки, история доставок и блок «Требует внимания» (api/admin/data.js: resource=audit|deliveries|attention).
//
// Модуль прав не проверяет: зовётся после requireAdmin. Таблица действий ниже обязана совпадать
// с src/lib/admin-audit.ts (ACTION_META) — это проверяет src/api/admin-audit.test.ts.
const { supabaseFetch, supabaseFetchWithMeta } = require('./_supabase');
const messages = require('./_admin-messages');

/** action → категория (контракт 5.6). */
const ACTION_CATEGORY = Object.freeze({
  grantSticker: 'keys',
  topupSticker: 'keys',
  patchCode: 'keys',
  createIndividualStickerOrder: 'money',
  grantProgramKey: 'keys',
  patchProgramKey: 'keys',
  grantCellLicense: 'keys',
  patchCellLicense: 'keys',
  grantAppSubscription: 'keys',
  revokeAppSubscription: 'keys',
  grantAppAddon: 'keys',
  revokeAppAddon: 'keys',
  revokeAppPoint: 'keys',
  revokeAppDevice: 'keys',
  setDeviceRole: 'keys',
  attach: 'keys',
  profile: 'settings',
  appCodeViaBot: 'settings',
  setOverrides: 'limits',
  clearOverrides: 'limits',
  walletAdjust: 'money',
  restrict: 'restrict',
  updateRestriction: 'restrict',
  liftRestriction: 'restrict',
  block: 'restrict',
  unblock: 'restrict',
  message: 'messages',
  notify: 'messages',
  retryDelivery: 'messages',
  sendNews: 'messages',
  sendTelegramBroadcast: 'messages',
  logoutAll: 'settings',
  unlinkTelegram: 'settings',
  linkTelegram: 'settings',
  unlinkOAuth: 'settings',
  deleteAccount: 'deletions',
  deleteResource: 'deletions',
  createResource: 'settings',
  updateResource: 'settings',
  setAppFreeMode: 'settings',
  setAppCrackFallback: 'settings',
  setAppCodeViaBot: 'settings',
  setPaymentsEnabled: 'settings',
  upsertPriceTier: 'money',
  deletePriceTier: 'money',
  syncPaymentOrder: 'money',
  setStickerPoolRange: 'settings',
  setBoxPoolRange: 'settings',
  processWithdrawal: 'money',
  setKztRate: 'settings',
  createPartner: 'keys',
  grantPartnerPool: 'keys',
  updatePartner: 'keys',
  partnerPayment: 'money',
  togglePartnerItem: 'keys',
});

const DANGER_ACTIONS = new Set([
  'revokeAppSubscription', 'walletAdjust', 'restrict', 'updateRestriction', 'block',
  'sendNews', 'sendTelegramBroadcast', 'logoutAll', 'unlinkTelegram', 'linkTelegram', 'unlinkOAuth',
  'deleteAccount', 'deleteResource', 'setAppFreeMode', 'setAppCodeViaBot', 'setPaymentsEnabled',
  'setStickerPoolRange', 'setBoxPoolRange', 'processWithdrawal',
]);

const CATEGORIES = Object.freeze(['limits', 'restrict', 'messages', 'money', 'keys', 'settings', 'deletions', 'other']);
const KNOWN_ACTIONS = Object.freeze(Object.keys(ACTION_CATEGORY));
// Без колонки response: там целый ответ действия, журналу он не нужен (трафик Supabase).
const AUDIT_SELECT = 'id,created_at,action,target_user_id,payload,admin_fingerprint,reason,before,after,result,user_agent';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTENTION_TTL_MS = 60_000;
const STATS_TTL_MS = 60_000;
const DELIVERY_CHANNELS = new Set(['email', 'telegram', 'pc']);
const DELIVERY_STATUSES = new Set(['sent', 'failed', 'not_configured', 'pending', 'blocked', 'error']);

function categoryOf(action) {
  return ACTION_CATEGORY[action] || 'other';
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function auditEntryDto(row, labelsById = new Map()) {
  const label = row.target_user_id ? labelsById.get(row.target_user_id) : null;
  return {
    id: Number(row.id),
    createdAt: row.created_at,
    action: row.action,
    category: categoryOf(row.action),
    danger: DANGER_ACTIONS.has(row.action),
    targetUserId: row.target_user_id || null,
    target: row.target_user_id ? {
      userId: row.target_user_id,
      email: label?.email ?? null,
      displayName: label?.display_name ?? null,
      telegramUsername: label?.telegram_username ?? null,
    } : null,
    reason: row.reason ?? null,
    payload: plainObject(row.payload) || {},
    before: plainObject(row.before),
    after: plainObject(row.after),
    result: row.result ?? null,
    adminFingerprint: row.admin_fingerprint ?? null,
    userAgent: row.user_agent ?? null,
  };
}

function bad(res, error) {
  return res.status(400).json({ error, code: 'VALIDATION_ERROR' });
}

function sendError(res, error) {
  if (error?.status >= 400 && error.status < 500 && error.code) {
    return res.status(error.status).json({ error: error.message, code: error.code, ...(error.extra || {}) });
  }
  console.error(error?.message, error?.details || '');
  return res.status(502).json({ error: 'Database request failed' });
}

function parseLimit(value, fallback = 50) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

function parseIso(value) {
  if (value == null || value === '') return undefined;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function inList(list) {
  return `in.(${list.join(',')})`;
}

// ---------- журнал ----------

/** GET resource=audit — лента действий по курсору id (новые сверху). */
async function handleAudit(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const query = req.query || {};
  const limit = parseLimit(query.limit);
  if (limit == null) return bad(res, 'limit: от 1 до 100');
  const cursor = query.cursor == null || query.cursor === '' ? null : String(query.cursor);
  if (cursor != null && !/^\d{1,18}$/.test(cursor)) return bad(res, 'Некорректный курсор');
  const category = query.category ? String(query.category) : '';
  if (category && !CATEGORIES.includes(category)) return bad(res, 'Неизвестная категория');
  const action = query.action ? String(query.action) : '';
  if (action && !/^[A-Za-z]{1,60}$/.test(action)) return bad(res, 'Некорректное действие');
  const userId = query.userId ? String(query.userId) : '';
  if (userId && !UUID_RE.test(userId)) return bad(res, 'Некорректный пользователь');
  const from = parseIso(query.from);
  const to = parseIso(query.to);
  if (from === null || to === null) return bad(res, 'Некорректная дата');
  const danger = query.danger === '1' || query.danger === 'true';
  const q = String(query.q || '').replace(/[,()*:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

  const filters = [];
  if (cursor) filters.push(`id=lt.${cursor}`);
  // категория и «опасные» сводятся к одному списку действий (пересечение)
  let actions = null;
  if (category && category !== 'other') actions = KNOWN_ACTIONS.filter(name => ACTION_CATEGORY[name] === category);
  if (danger) actions = (actions || KNOWN_ACTIONS).filter(name => DANGER_ACTIONS.has(name));
  if (category === 'other') {
    if (danger) actions = [];
    else filters.push(`action=not.${inList(KNOWN_ACTIONS)}`);
  }
  if (actions && !actions.length) return res.json({ items: [], nextCursor: null, total: cursor ? null : 0 });
  if (actions) filters.push(`action=${inList(actions)}`);
  if (action) filters.push(`action=eq.${action}`);
  if (userId) filters.push(`target_user_id=eq.${userId}`);
  if (from) filters.push(`created_at=gte.${encodeURIComponent(from)}`);
  if (to) filters.push(`created_at=lte.${encodeURIComponent(to)}`);
  if (q) {
    if (UUID_RE.test(q)) filters.push(`target_user_id=eq.${q}`);
    else {
      const value = encodeURIComponent(`*${q}*`);
      filters.push(`or=(action.ilike.${value},reason.ilike.${value})`);
    }
  }
  const path = `admin_actions?select=${AUDIT_SELECT}${filters.map(f => `&${f}`).join('')}&order=id.desc&limit=${limit + 1}`;
  try {
    let rows;
    let total = null;
    if (cursor) rows = await supabaseFetch(path);
    else {
      const meta = await supabaseFetchWithMeta(path);
      rows = meta.data;
      total = meta.count;
    }
    rows = Array.isArray(rows) ? rows : [];
    const page = rows.slice(0, limit);
    const labels = await messages.userLabels(page.map(row => row.target_user_id));
    return res.json({
      items: page.map(row => auditEntryDto(row, labels)),
      nextCursor: rows.length > limit && page.length ? Number(page[page.length - 1].id) : null,
      total,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

// ---------- доставки ----------

let statsCache = null; // { at, value }

async function countOf(path) {
  const { count } = await supabaseFetchWithMeta(`${path}&limit=1`, { headers: { Range: '0-0' } });
  return Number(count || 0);
}

/** Счётчики за сутки, кеш 60 с. Сбой — нули (лента важнее счётчиков). */
async function deliveryStats24h(now = Date.now()) {
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value;
  const since = encodeURIComponent(new Date(now - 86400_000).toISOString());
  const nowIso = encodeURIComponent(new Date(now).toISOString());
  const base = `notification_deliveries?select=id&created_at=gte.${since}`;
  const safe = promise => promise.catch(error => { console.error('delivery stats:', error.message); return 0; });
  const [sent, failed, notConfigured, waitingPc] = await Promise.all([
    safe(countOf(`${base}&status=eq.sent`)),
    safe(countOf(`${base}&status=in.(failed,blocked)`)),
    safe(countOf(`${base}&status=eq.not_configured`)),
    safe(countOf(`app_device_messages?select=id&created_by=eq.admin&read_at=is.null&expires_at=gt.${nowIso}&created_at=gte.${since}`)),
  ]);
  const value = { sent, failed, notConfigured, waitingPc };
  statsCache = { at: now, value };
  return value;
}

/** GET resource=deliveries (лента), POST resource=deliveries&action=retry (повтор). */
async function handleDeliveries(req, res) {
  if (req.method === 'POST' && String(req.query?.action || '') === 'retry') return messages.retryDelivery(req, res);
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const query = req.query || {};
  const limit = parseLimit(query.limit);
  if (limit == null) return bad(res, 'limit: от 1 до 100');
  const before = parseIso(query.before);
  if (before === null) return bad(res, 'Некорректный курсор');
  const channel = query.channel ? String(query.channel) : '';
  if (channel && !DELIVERY_CHANNELS.has(channel)) return bad(res, 'Неизвестный канал');
  const status = query.status ? String(query.status) : '';
  if (status && !DELIVERY_STATUSES.has(status)) return bad(res, 'Неизвестный статус');
  const userId = query.userId ? String(query.userId) : '';
  if (userId && !UUID_RE.test(userId)) return bad(res, 'Некорректный пользователь');
  const filters = [];
  if (before) filters.push(`created_at=lt.${encodeURIComponent(before)}`);
  if (channel) filters.push(`channel=eq.${channel}`);
  if (status === 'error') filters.push('status=in.(failed,blocked)');
  else if (status) filters.push(`status=eq.${status}`);
  if (userId) filters.push(`user_id=eq.${userId}`);
  try {
    const [rows, stats24h] = await Promise.all([
      supabaseFetch(`notification_deliveries?select=*${filters.map(f => `&${f}`).join('')}&order=created_at.desc&limit=${limit + 1}`),
      deliveryStats24h(),
    ]);
    const list = Array.isArray(rows) ? rows : [];
    const page = list.slice(0, limit);
    return res.json({
      items: await messages.deliveryDtos(page),
      nextCursor: list.length > limit && page.length ? page[page.length - 1].created_at : null,
      stats24h,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

// ---------- «Требует внимания» ----------

let attentionCache = null; // { at, value }

/** Конец текущих суток по Москве (UTC+3, без перехода на летнее время). */
function endOfMoscowDay(now = Date.now()) {
  const msk = new Date(now + 3 * 3600_000);
  return new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() + 1) - 3 * 3600_000);
}

function userLabelText(label, userId) {
  if (!label) return userId;
  return label.display_name || label.email || (label.telegram_username ? `@${label.telegram_username}` : userId);
}

async function collectAttention(now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  const threshold = Number(process.env.ADMIN_POOL_LOW || 500) || 500;
  const block = async (name, work, fallback) => {
    try { return await work(); } catch (error) { console.error(`attention ${name}:`, error.message); return fallback; }
  };
  const [withdrawals, stuckOrders, stickerAvailable, boxAvailable, failedDeliveries24h, expiring, counts] = await Promise.all([
    block('withdrawals', async () => {
      const rows = await supabaseFetch('referral_withdrawals?status=in.(pending,approved)&select=amount_kopecks,created_at&order=created_at.asc&limit=1000');
      return {
        count: rows.length,
        amountKopecks: rows.reduce((sum, row) => sum + Number(row.amount_kopecks || 0), 0),
        oldestAt: rows[0]?.created_at || null,
      };
    }, { count: 0, amountKopecks: 0, oldestAt: null }),
    block('stuckOrders', async () => {
      const older = encodeURIComponent(new Date(now - 30 * 60_000).toISOString());
      const newer = encodeURIComponent(new Date(now - 2 * 86400_000).toISOString());
      const meta = await supabaseFetchWithMeta(`payment_orders?status=eq.pending&created_at=lt.${older}&created_at=gt.${newer}&select=created_at&order=created_at.asc&limit=1`, { headers: { Range: '0-0' } });
      return { count: Number(meta.count || 0), oldestAt: meta.data?.[0]?.created_at || null };
    }, { count: 0, oldestAt: null }),
    block('stickerPool', () => countOf('return_sticker_codes?select=code&batch_id=is.null'), null),
    block('boxPool', () => countOf('return_box_codes?select=code&batch_id=is.null'), null),
    block('failedDeliveries', async () => {
      const since = encodeURIComponent(new Date(now - 86400_000).toISOString());
      const rows = await supabaseFetch(`notification_deliveries?status=in.(failed,blocked)&created_at=gte.${since}&select=channel&limit=1000`);
      const byChannel = { email: 0, telegram: 0, pc: 0 };
      for (const row of rows) if (row.channel in byChannel) byChannel[row.channel] += 1;
      return { count: rows.length, byChannel };
    }, { count: 0, byChannel: { email: 0, telegram: 0, pc: 0 } }),
    block('restrictionsExpiringToday', async () => {
      const end = encodeURIComponent(endOfMoscowDay(now).toISOString());
      const meta = await supabaseFetchWithMeta(`user_restrictions?lifted_at=is.null&until=gt.${encodeURIComponent(nowIso)}&until=lte.${end}&select=user_id,until&order=until.asc&limit=5`);
      const rows = Array.isArray(meta.data) ? meta.data : [];
      const labels = await messages.userLabels(rows.map(row => row.user_id));
      return {
        count: Number(meta.count ?? rows.length),
        items: rows.map(row => ({ userId: row.user_id, label: userLabelText(labels.get(row.user_id), row.user_id), until: row.until })),
      };
    }, { count: 0, items: [] }),
    block('counts', () => supabaseFetch('rpc/admin_user_counts', { method: 'POST', body: '{}' }), null),
  ]);
  let onlinePcs = 0;
  try { onlinePcs = Number(require('./_app-relay').onlineCount(now)) || 0; } catch (error) { console.error('attention onlinePcs:', error.message); }
  const pool = available => ({ available: Number(available || 0), threshold, low: available != null && Number(available) < threshold });
  const value = {
    generatedAt: nowIso,
    withdrawals,
    stuckOrders,
    stickerPool: pool(stickerAvailable),
    boxPool: pool(boxAvailable),
    failedDeliveries24h,
    restrictionsExpiringToday: expiring,
    restrictedTotal: Number(counts?.restricted || 0),
    subscriptions: { active: Number(counts?.subscribed || 0), expiring7: Number(counts?.expiring || 0) },
    onlinePcs,
    usersTotal: Number(counts?.all || 0),
    total: 0,
  };
  value.total = [
    value.withdrawals.count > 0,
    value.stuckOrders.count > 0,
    value.stickerPool.low,
    value.boxPool.low,
    value.failedDeliveries24h.count > 0,
    value.restrictionsExpiringToday.count > 0,
  ].filter(Boolean).length;
  return value;
}

/** GET resource=attention — только счётчики, кеш 60 с. */
async function handleAttention(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  try {
    const now = Date.now();
    if (!attentionCache || now - attentionCache.at >= ATTENTION_TTL_MS) {
      attentionCache = { at: now, value: await collectAttention(now) };
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json(attentionCache.value);
  } catch (error) {
    return sendError(res, error);
  }
}

/** Крон (api/cabinet.js cronNotifications): доставки старше 180 дней, журнал старше 730 дней. */
async function runMaintenance() {
  return supabaseFetch('rpc/admin_maintenance', { method: 'POST', body: '{}' });
}

function resetForTests() {
  attentionCache = null;
  statsCache = null;
}

module.exports = {
  ACTION_CATEGORY, DANGER_ACTIONS, categoryOf, auditEntryDto, handleAudit, handleDeliveries, handleAttention, runMaintenance,
  CATEGORIES, endOfMoscowDay, resetForTests,
};
