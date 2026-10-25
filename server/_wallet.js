// Баланс пользователя в рублях (таблицы wallet_*, миграция 20261023_wallet.sql).
// Пополняется заказом product_kind='wallet_topup', тратится в Telegram-боте.
//
// Покупка с баланса — обычный заказ payment_orders с amount=0 и wallet_paid_kopecks=<цена>:
// списание делает rpc wallet_pay_order, выдачу — штатный completeOrder (ключи, продления,
// подписки, генерации), при ошибке выдачи деньги возвращает wallet_refund_order.
const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { completeOrder, PACKAGE_PRICES } = require('./_payments');

const TOPUP_AMOUNTS = Object.freeze([100, 300, 500, 1000]);
const MIN_TOPUP = 25;
const MAX_TOPUP = 50000;
// Бонус к пополнению: от 1000 ₽ — +10%, от 500 ₽ — +5%.
const TOPUP_BONUS_STEPS = Object.freeze([[1000, 10], [500, 5]]);

function validTopup(rub) {
  return Number.isInteger(rub) && rub >= MIN_TOPUP && rub <= MAX_TOPUP;
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
 * Купить с баланса. fields — колонки заказа для выдачи (range_quantity, renewal_target_key,
 * cell_print_*, license_iterations, app_plan…). Возвращает { ok:true, order, balanceKopecks }
 * или { ok:false, error:'INSUFFICIENT', balanceKopecks, missingKopecks }.
 */
async function payWithWallet({ userId, productKind, fields = {}, priceRub, snapshot = {} }) {
  const priceKopecks = Math.round(Number(priceRub) * 100);
  if (!userId || !(priceKopecks > 0)) throw new Error('Invalid wallet purchase');
  const balance = await getBalanceKopecks(userId);
  if (balance < priceKopecks) return { ok: false, error: 'INSUFFICIENT', balanceKopecks: balance, missingKopecks: priceKopecks - balance };
  const inserted = await supabaseFetch('payment_orders', {
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
  const order = inserted[0];
  const paid = await supabaseFetch('rpc/wallet_pay_order', { method: 'POST', body: JSON.stringify({ p_order_id: order.id }) });
  if (!paid?.ok) {
    await supabaseFetch(`payment_orders?id=eq.${order.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'canceled', updated_at: new Date().toISOString() }) }).catch(() => {});
    return { ok: false, error: 'INSUFFICIENT', balanceKopecks: Number(paid?.balance || 0), missingKopecks: priceKopecks - Number(paid?.balance || 0) };
  }
  try {
    const completed = await completeOrder(order, { status: 'succeeded', paid: true });
    return { ok: true, order: completed, balanceKopecks: Number(paid.balance) };
  } catch (error) {
    await supabaseFetch('rpc/wallet_refund_order', { method: 'POST', body: JSON.stringify({ p_order_id: order.id }) }).catch(() => {});
    throw error;
  }
}

module.exports = {
  MAX_TOPUP, MIN_TOPUP, TOPUP_AMOUNTS, TOPUP_BONUS_STEPS,
  affordableGenerations, formatRub, generationCost, getBalanceKopecks, walletSummary, payWithWallet,
  topupBonus, topupBonusPercent, validTopup,
};
