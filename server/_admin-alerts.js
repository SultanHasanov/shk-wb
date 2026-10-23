const { supabaseFetch } = require('./_supabase');
const { sendMessage } = require('./_telegram-api');

// Уведомления админу в Telegram о каждой оплате: заказы (ЮKassa и покупки с баланса) и списания
// с баланса в боте («Код клиента», «Кто поставил оценку»). Кому — ADMIN_PAYMENT_TELEGRAM_IDS через запятую.
const DEFAULT_ADMIN_IDS = '439335621';

const PRODUCT_TITLES = {
  stickers: 'Пакет генераций ШК',
  individual_stickers: 'Индивидуальный заказ стикеров',
  program: 'Программа «Подбор кодов»',
  program_license: 'Пакет подборов (WBPK)',
  app_subscription: 'Подписка «Помощник ПВЗ»',
  app_addon: 'Услуга «Архив клиентов»',
  wallet_topup: 'Пополнение баланса',
  cell_print_program: 'Печать ячеек',
  cell_print_license: 'Печать ячеек — ключ',
  cell_print_bundle: 'Печать ячеек — комплект',
};

function adminIds() {
  return String(process.env.ADMIN_PAYMENT_TELEGRAM_IDS ?? DEFAULT_ADMIN_IDS).split(',').map(value => value.trim()).filter(Boolean);
}

const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rub = value => `${Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

/** «Кто платил»: Telegram (@username / имя) и почта, если есть. */
async function payerLine(userId, email) {
  const parts = [];
  if (userId) {
    const rows = await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(userId)}&select=telegram_user_id,username,first_name&limit=1`).catch(() => []);
    const tg = rows[0];
    if (tg?.telegram_user_id) {
      const name = tg.username ? `@${tg.username}` : (tg.first_name || 'Telegram');
      parts.push(`<a href="tg://user?id=${tg.telegram_user_id}">${escapeHtml(name)}</a> (${tg.telegram_user_id})`);
    }
  }
  if (email) parts.push(escapeHtml(email));
  return parts.length ? parts.join(' · ') : 'без аккаунта';
}

async function sendToAdmins(text) {
  await Promise.all(adminIds().map(id => sendMessage(id, text, { disable_web_page_preview: true }).catch(error => {
    console.error('Admin payment alert failed', error.message);
  })));
}

/** Заказ выполнен: оплата картой/СБП или покупка с баланса. */
async function notifyAdminOrder(order) {
  const walletRub = Number(order.wallet_paid_kopecks || 0) / 100;
  const paidRub = Number(order.gross_amount || order.amount || 0);
  let title = PRODUCT_TITLES[order.product_kind] || order.product_kind || 'Заказ';
  if (order.product_kind === 'app_subscription' && order.app_plan) title += ` · ${order.app_plan}${order.app_term_months ? `, ${order.app_term_months} мес.` : ''}`;
  if (order.product_kind === 'stickers') {
    const quantity = Number(order.range_quantity || 0) + Number(order.custom_quantity || 0);
    if (quantity) title += ` · ${quantity} шт.`;
  }
  const lines = [walletRub > 0 ? `<b>🛒 Покупка с баланса: ${rub(walletRub)}</b>` : `<b>💰 Оплата: ${rub(paidRub)}</b>`, escapeHtml(title)];
  if (order.product_kind === 'wallet_topup') {
    const credited = Number(order.wallet_topup_kopecks || 0) / 100;
    if (credited && credited !== paidRub) lines.push(`Зачислено ${rub(credited)} (с бонусом)`);
  }
  if (order.promo_code) lines.push(`Промокод: ${escapeHtml(order.promo_code)}`);
  lines.push(`Кто: ${await payerLine(order.user_id, order.email)}`);
  lines.push(`<i>Заказ ${String(order.id).slice(0, 8)}</i>`);
  await sendToAdmins(lines.join('\n'));
}

/** Списание с баланса в боте без заказа (wallet_spend / bot_review_spend). */
async function notifyAdminSpend({ userId, priceRub, title, balanceKopecks }) {
  const lines = [`<b>🛒 Списание с баланса: ${rub(priceRub)}</b>`, escapeHtml(title)];
  lines.push(`Кто: ${await payerLine(userId, null)}`);
  if (balanceKopecks != null) lines.push(`<i>Остаток на балансе ${rub(Number(balanceKopecks) / 100)}</i>`);
  await sendToAdmins(lines.join('\n'));
}

module.exports = { notifyAdminOrder, notifyAdminSpend };
