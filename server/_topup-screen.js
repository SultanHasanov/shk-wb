// Экран оплаты пополнения в Telegram-боте и что с ним становится потом. Экран рисует бот (узел BOT_ROLE=bot),
// а правят его и сайт (вебхук ЮKassa, notifyCompleted в server/_payments.js), и бот (кнопка «🔄 Проверить оплату»),
// кнопки обрабатывает узел бота — поэтому тексты и callback_data собираются здесь, в одном месте.
// Модуль без зависимостей: его подключает server/_payments.js, а _wallet.js сам зависит от _payments.

const CALLBACK_LIMIT = 64; // лимит callback_data у Telegram, байт
const MENU_ROW = Object.freeze([{ text: '☰ Меню', callback_data: 'menu:home' }]);

function rub(value) {
  const amount = Number(value) || 0;
  return `${amount.toLocaleString('ru-RU', { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 })} ₽`;
}

function fits(data) { return Buffer.byteLength(data) <= CALLBACK_LIMIT; }

/**
 * «⬅️ Назад» с экрана оплаты — туда, откуда пришли, без потери выбора: из мастера стикеров — снова подтверждение
 * (gen:recheck перечитает баланс в том же сообщении), из магазина — экран товара. menu:home здесь стирал черновик,
 * и после оплаты стикер уже не создавался сам.
 */
function topupBackData(then) {
  if (!then) return 'topup:home';
  if (then === 'gen') return 'gen:recheck';
  if (then.startsWith('shop:')) return then;
  return 'menu:home';
}

/** «Попробовать ещё раз» — то же пополнение с той же покупкой; не влезло в 64 байта — просто пополнение. */
function topupRetryData(amount, then) {
  const full = then ? `tp:${amount}:${then}` : `tp:${amount}`;
  return fits(full) ? full : `tp:${amount}`;
}

/** «🔄 Проверить оплату»: tpc:<public_token заказа> (43 символа). Токен без формата — кнопки нет. */
function topupCheckData(token) {
  const value = String(token || '');
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(value)) return null;
  const data = `tpc:${value}`;
  return fits(data) ? data : null;
}

/** Сколько заплатили и сколько зачислили по заказу пополнения: { paid, bonus, credited } в рублях. */
function topupAmounts(order) {
  const wallet = order?.pricing_snapshot?.wallet || {};
  const credited = Number(order?.wallet_topup_kopecks || 0) / 100;
  const paid = Number(order?.gross_amount || wallet.amount || 0) || credited;
  return { paid, credited: credited || paid, bonus: Math.max(0, Math.round(((credited || paid) - paid) * 100) / 100) };
}

/** «Оплачено 500 ₽ + бонус 25 ₽ = +525 ₽» — одна строка, чтобы «+525 ₽ (бонус 25 ₽)» не читалось двояко. */
function creditedLine({ paid, bonus }) {
  return bonus > 0 ? `Оплачено ${rub(paid)} + бонус ${rub(bonus)} = <b>+${rub(paid + bonus)}</b>` : `Оплачено <b>${rub(paid)}</b>`;
}

/** Экран оплаты после зачисления: кнопка «Перейти к оплате» больше не нужна, итог — в сообщении ниже. */
function paidScreenText(amount) {
  return `<b>💳 Пополнение на ${rub(amount)}</b>\n✅ Оплачено — деньги на балансе. Подробности ниже ⬇️`;
}

/**
 * Экран оплаты, когда ЮKassa отменила платёж. reason — cancellation_details.reason: брошенный платёж ЮKassa отменяет
 * сама примерно через час (expired_on_confirmation) — тогда без слов «не прошла», только «ссылка устарела».
 */
function canceledScreen({ amount, then = '', reason = '' }) {
  const expired = reason === 'expired_on_confirmation';
  const text = expired
    ? [`<b>💳 Пополнение на ${rub(amount)}</b>`, 'Ссылка на оплату устарела. Деньги не списаны, баланс не изменился.'].join('\n')
    : ['<b>Оплата не прошла</b>', 'Деньги не списаны, баланс не изменился. Если банк всё же списал сумму — он вернёт её сам.'].join('\n');
  return {
    text,
    reply_markup: { inline_keyboard: [
      [{ text: '🔄 Попробовать ещё раз', callback_data: topupRetryData(amount, then) }],
      [{ text: '⬅️ Назад', callback_data: topupBackData(then) }, ...MENU_ROW],
    ] },
  };
}

/**
 * Пополняли ради покупки, а она сама не прошла (узел бота не ответил, выбор сбросился): прямая кнопка к этой покупке.
 * Кнопки ведут на экраны с подтверждением, а не на списание: при таймауте покупка могла и пройти.
 */
function purchaseRetry(then) {
  const value = String(then || '');
  if (value === 'gen') return { lead: 'стикер не создался', note: 'Номер придётся ввести заново.', button: { text: '🏷 Создать стикер', callback_data: 'menu:stickers' } };
  if (value.startsWith('rv:')) return { lead: 'автор оценки не открылся', note: '', button: { text: '⭐ К отзывам', callback_data: 'rv:filters' } };
  const qr = /^qr:(\d{7,12})$/.exec(value);
  if (qr) return { lead: 'QR-код клиента не выдан', note: '', button: { text: '🔑 Получить QR', callback_data: `code:ask:${qr[1]}` } };
  if (value.startsWith('qr:') || value.startsWith('cqa:')) return { lead: 'QR-код клиента не выдан', note: '', button: { text: '🔑 Код клиента', callback_data: 'menu:code' } };
  if (value.startsWith('shop:') && fits(value)) return { lead: 'покупка не прошла', note: '', button: { text: '🛒 Открыть покупку', callback_data: value } };
  return { lead: 'покупка не прошла', note: '', button: { text: '🛒 Купить с баланса', callback_data: 'shop:home' } };
}

function purchaseNotStartedText({ balanceRub, then }) {
  const retry = purchaseRetry(then);
  return {
    text: [
      `Баланс пополнен, но ${retry.lead} автоматически.`,
      'Проверьте, пришёл ли результат выше. Если нет — нажмите кнопку ниже: оплатится с баланса, картой платить ещё раз не нужно.',
      ...(retry.note ? [retry.note] : []),
      ...(Number.isFinite(balanceRub) ? [`💰 На балансе: <b>${rub(balanceRub)}</b>`] : []),
    ].join('\n'),
    rows: [[retry.button], MENU_ROW],
  };
}

module.exports = {
  formatRub: rub,
  canceledScreen, creditedLine, paidScreenText, purchaseNotStartedText, purchaseRetry, topupAmounts,
  topupBackData, topupCheckData, topupRetryData,
};
