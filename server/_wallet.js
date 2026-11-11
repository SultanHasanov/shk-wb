// Баланс пользователя в рублях (таблицы wallet_*, миграция 20261023_wallet.sql).
// Пополняется заказом product_kind='wallet_topup', тратится в Telegram-боте.
//
// Покупка с баланса — обычный заказ payment_orders с amount=0 и wallet_paid_kopecks=<цена>:
// списание делает rpc wallet_pay_order, выдачу — штатный completeOrder (ключи, продления,
// подписки, генерации), при ошибке выдачи деньги возвращает wallet_refund_order.
const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { completeOrder, PACKAGE_PRICES } = require('./_payments');
const controls = require('./_user-controls');

const TOPUP_AMOUNTS = Object.freeze([100, 300, 500, 1000]);
const MIN_TOPUP = 25;
const MAX_TOPUP = 50000;
// Бонус к пополнению: от 1000 ₽ — +10%, от 500 ₽ — +5%.
const TOPUP_BONUS_STEPS = Object.freeze([[1000, 10], [500, 5]]);

function validTopup(rub) {
  const kopecks = Math.round(rub * 100);
  return Number.isFinite(rub) && rub >= MIN_TOPUP && rub <= MAX_TOPUP
    && Math.abs(kopecks - rub * 100) < 1e-6;
}

function topupBonusPercent(rub) {
  const step = TOPUP_BONUS_STEPS.find(([from]) => rub >= from);
  return step ? step[1] : 0;
}

/** Сколько рублей бонуса (целое, вниз) к пополнению на rub. */
function topupBonus(rub) {
  return Math.floor(rub * topupBonusPercent(rub) / 100);
}

const PACKS = Object.keys(PACKAGE_PRICES).map(Number).sort((a, b) => a - b);

/**
 * Цена N генераций с баланса по таблице пакетов: не дороже ближайшего пакета сверху
 * и не дороже N × цена штуки ближайшего пакета снизу. 1 шт — 5 ₽, 7 шт — 12 ₽, 300 шт — 94,50 ₽.
 */
function generationCost(units) {
  const n = Number(units);
  if (!Number.isInteger(n) || n < 1) return null;
  const upper = PACKS.find(pack => pack >= n);
  const lower = [...PACKS].reverse().find(pack => pack <= n);
  const candidates = [];
  if (upper) candidates.push(PACKAGE_PRICES[upper]);
  if (lower) candidates.push(n * PACKAGE_PRICES[lower] / lower);
  return Math.ceil(Math.min(...candidates) * 100) / 100;
}

/** Сколько генераций максимум можно купить на balanceRub (до 500 за раз — лимит пачки). */
function affordableGenerations(balanceRub) {
  // Пакет с самой низкой ценой штуки; считаем в копейках целыми, чтобы 135 ₽ дали ровно 500, а не 499.
  const best = PACKS.reduce((min, pack) => (PACKAGE_PRICES[pack] / pack < PACKAGE_PRICES[min] / min ? pack : min));
  const balanceKopecks = Math.round(Number(balanceRub) * 100);
  return Math.max(0, Math.floor((balanceKopecks * best) / Math.round(PACKAGE_PRICES[best] * 100)));
}

function formatRub(value) {
  const rub = Number(value) || 0;
  return `${rub.toLocaleString('ru-RU', { minimumFractionDigits: rub % 1 ? 2 : 0, maximumFractionDigits: 2 })} ₽`;
}

async function getBalanceKopecks(userId) {
  const rows = await supabaseFetch(`wallet_accounts?user_id=eq.${encodeURIComponent(userId)}&select=balance_kopecks&limit=1`);
  return Number(rows[0]?.balance_kopecks || 0);
}

/** Баланс + последние движения для кабинета/программы. */
async function walletSummary(userId, limit = 30) {
  const n = Math.max(1, Math.min(100, Number(limit) || 30));
  const uid = encodeURIComponent(userId);
  const [balanceKopecks, ledger] = await Promise.all([
    getBalanceKopecks(userId),
    supabaseFetch(`wallet_ledger?user_id=eq.${uid}&select=kind,amount_kopecks,order_id,details,created_at&order=created_at.desc&limit=${n}`).catch(() => []),
  ]);
  return {
    balanceKopecks,
    ledger: ledger.map(row => ({
      kind: row.kind,
      amountKopecks: Number(row.amount_kopecks || 0),
      orderId: row.order_id || null,
      note: row.details?.note || row.details?.reason || null,
      createdAt: row.created_at,
    })),
  };
}

/**
 * Бонус от администратора на баланс: запись журнала kind='bonus'. eventKey уникален —
 * повторный вызов с тем же ключом денег не добавит (duplicate: true).
 */
async function grantBonus({ userId, kopecks, eventKey, note = '', adminTelegramId = null }) {
  if (!userId || !eventKey || !Number.isSafeInteger(kopecks) || kopecks <= 0) throw new Error('Неверные данные бонуса');
  const details = { ...(note ? { note } : {}), ...(adminTelegramId ? { by: Number(adminTelegramId) } : {}) };
  const result = await supabaseFetch('rpc/wallet_move', {
    method: 'POST',
    body: JSON.stringify({ p_user: userId, p_kopecks: kopecks, p_kind: 'bonus', p_event_key: eventKey, p_details: details }),
  });
  if (!result?.ok) throw new Error('Бонус не начислен');
  return { duplicate: Boolean(result.duplicate), balanceKopecks: Number(result.balance) };
}

/**
 * Что стало с деньгами, когда покупка с баланса упала (error.walletOutcome) — по нему бот выбирает текст:
 * not_charged — до списания; refunded — списали и вернули; refund_failed — списали, а вернуть не вышло
 * (деньги возвращает поддержка вручную); unknown — ответ списания потерялся, и списание ещё может пройти позже.
 * error.orderId — заказ для поддержки, если он успел появиться.
 */
const WALLET_OUTCOMES = Object.freeze(['not_charged', 'refunded', 'refund_failed', 'unknown']);

function withOutcome(error, outcome, orderId = null) {
  const target = error instanceof Error ? error : new Error(String(error?.message || error || 'Wallet purchase failed'));
  target.walletOutcome = outcome;
  if (orderId) target.orderId = orderId;
  return target;
}

/** Вернуть деньги за заказ: { outcome, balanceKopecks? }. «Не списано» (not_paid) — тоже исход, а не ошибка. */
async function refundWalletOrder(orderId) {
  try {
    const result = await supabaseFetch('rpc/wallet_refund_order', { method: 'POST', body: JSON.stringify({ p_order_id: orderId }) });
    if (result?.ok) return { outcome: 'refunded', balanceKopecks: Number(result.balance) };
    if (result?.reason === 'not_paid') return { outcome: 'not_charged' };
    return { outcome: 'refund_failed' };
  } catch (error) {
    console.error('Wallet refund failed', orderId, error.message);
    return { outcome: 'refund_failed' };
  }
}

/**
 * Купить с баланса. fields — колонки заказа для выдачи (range_quantity, renewal_target_key,
 * cell_print_*, license_iterations, app_plan…). Возвращает { ok:true, order, balanceKopecks }
 * или { ok:false, error:'INSUFFICIENT', balanceKopecks, missingKopecks }. Сбой — Error с walletOutcome (см. выше);
 * ограничение аккаунта (ACCOUNT_RESTRICTED) — как было, до заказа.
 */
async function payWithWallet({ userId, productKind, fields = {}, priceRub, snapshot = {} }) {
  const priceKopecks = Math.round(Number(priceRub) * 100);
  if (!userId || !(priceKopecks > 0)) throw withOutcome(new Error('Invalid wallet purchase'), 'not_charged');
  // ограничение «Покупки» из админки: 403 ACCOUNT_RESTRICTED до вставки заказа
  await controls.assertAllowed(userId, 'purchases');
  let order;
  try {
    const balance = await getBalanceKopecks(userId);
    if (balance < priceKopecks) return { ok: false, error: 'INSUFFICIENT', balanceKopecks: balance, missingKopecks: priceKopecks - balance };
    order = (await insertWalletOrder({ userId, productKind, fields, priceKopecks, snapshot }))[0];
    if (!order?.id) throw new Error('Wallet order was not created');
  } catch (error) {
    throw withOutcome(error, 'not_charged');
  }
  let paid;
  try {
    paid = await supabaseFetch('rpc/wallet_pay_order', { method: 'POST', body: JSON.stringify({ p_order_id: order.id }) });
  } catch (error) {
    // Ответ потерялся — списание могло пройти. Возврат сам скажет: «не списано» (not_paid) или «вернули».
    // Но «не списано» здесь не окончательно: запрос списания мог ещё не дойти до базы (PostgREST не отменяет его
    // при обрыве), а wallet_pay_order статус заказа не смотрит — спишет и позже. Поэтому исход unknown: «проверьте баланс».
    const refund = await refundWalletOrder(order.id);
    if (refund.outcome === 'not_charged') {
      await supabaseFetch(`payment_orders?id=eq.${order.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'canceled', updated_at: new Date().toISOString() }) }).catch(() => {});
    }
    throw withOutcome(error, refund.outcome === 'not_charged' ? 'unknown' : refund.outcome, order.id);
  }
  if (!paid?.ok) {
    await supabaseFetch(`payment_orders?id=eq.${order.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'canceled', updated_at: new Date().toISOString() }) }).catch(() => {});
    return { ok: false, error: 'INSUFFICIENT', balanceKopecks: Number(paid?.balance || 0), missingKopecks: priceKopecks - Number(paid?.balance || 0) };
  }
  try {
    const completed = await completeOrder(order, { status: 'succeeded', paid: true });
    return { ok: true, order: completed, balanceKopecks: Number(paid.balance) };
  } catch (error) {
    const refund = await refundWalletOrder(order.id);
    throw withOutcome(error, refund.outcome, order.id);
  }
}

function insertWalletOrder({ userId, productKind, fields, priceKopecks, snapshot }) {
  return supabaseFetch('payment_orders', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      public_token: crypto.randomBytes(32).toString('base64url'),
      range_quantity: 0,
      custom_quantity: 0,
      ...fields,
      amount: 0,
      gross_amount: 0,
      pricing_snapshot: { ...snapshot, wallet: { priceKopecks } },
      product_kind: productKind,
      user_id: userId,
      provider_status: 'pending',
      fulfillment_status: 'pending',
      wallet_paid_kopecks: priceKopecks,
    }),
  });
}

module.exports = {
  MAX_TOPUP, MIN_TOPUP, TOPUP_AMOUNTS, TOPUP_BONUS_STEPS, WALLET_OUTCOMES,
  affordableGenerations, formatRub, generationCost, getBalanceKopecks, grantBonus, walletSummary, payWithWallet,
  topupBonus, topupBonusPercent, validTopup,
};
