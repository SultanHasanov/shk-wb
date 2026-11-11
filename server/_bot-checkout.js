// Оплата из бота без Mini App: бот сам создаёт заказ ЮKassa за пользователя (он уже знает user_id по
// Telegram-аккаунту) и даёт обычную кнопку-ссылку на страницу оплаты. Раньше кнопка открывала Mini App
// /bot-checkout, который входил в кабинет, слал «Вход выполнен» и только потом открывал ЮKassa — путало людей.
// Заказ создаёт тот же обработчик api/payments.js (action=create) через синтетический запрос с req.internalUser,
// чтобы цены, бонусы, рефералы, идемпотентность и вебхук ЮKassa остались общими с сайтом.
const { getAuthUser } = require('./_user-auth');

function responseStub() {
  const stub = { statusCode: 200, body: null };
  stub.status = code => { stub.statusCode = code; return stub; };
  stub.json = value => { stub.body = value; return stub; };
  stub.send = value => { stub.body = value; return stub; };
  stub.end = () => stub;
  stub.setHeader = () => stub;
  return stub;
}

/** Ошибка создания оплаты: текст обработчика (для лога), его код и HTTP-статус — по ним бот выбирает, что показать. */
function checkoutError(message, { code = null, status = null } = {}) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * Общий путь: аккаунт по userId → синтетический запрос в api/payments.js → { confirmationUrl, token }.
 * Нет аккаунта (объединён или удалён, а кеш связки ещё старый) — ошибка ACCOUNT_NOT_FOUND: бот сбросит кеш и повторит.
 */
async function createPayment(userId, body, { handler = require('../api/payments'), loadUser = getAuthUser } = {}) {
  const account = await loadUser(userId);
  if (!account?.id) throw checkoutError('Account not found for bot checkout', { code: 'ACCOUNT_NOT_FOUND', status: 404 });
  const req = {
    method: 'POST',
    query: { action: 'create' },
    // Лимит попыток считается по этому адресу: у каждого пользователя бота свой счётчик.
    headers: { host: 'shk-wb.ru', 'x-forwarded-for': `telegram-bot:${userId}` },
    body: { ...body, accepted: true, returnTo: 'telegram' },
    internalUser: { id: account.id, email: account.email || null },
  };
  const res = responseStub();
  await handler(req, res);
  if (res.statusCode >= 400 || !res.body?.confirmationUrl) {
    throw checkoutError(res.body?.error || `Не удалось создать оплату (${res.statusCode})`, { code: res.body?.code || null, status: res.statusCode });
  }
  return { confirmationUrl: res.body.confirmationUrl, token: res.body.token || null };
}

/**
 * Пополнение баланса из бота. then — что сделать после зачисления (afterWalletTopup), messageId — экран бота,
 * который после оплаты станет «Готово». Возвращает { confirmationUrl, token }; при отказе бросает Error с code и status.
 */
async function createTopupPayment({ userId, amount, then = '', messageId = null }, deps = {}) {
  return createPayment(userId, {
    productKind: 'wallet_topup',
    walletAmount: amount,
    walletThen: then || undefined,
    walletMessage: messageId || undefined,
  }, deps);
}

/**
 * Оплата индивидуального заказа стикеров из бота — тот же путь, что у кабинета (OrdersPage: productKind
 * individual_stickers + individualOrderId). Обработчик сам проверяет, что заказ этого пользователя и ждёт
 * оплаты, и отдаёт прежнюю ссылку, если заказ ЮKassa уже создан и не закрыт.
 */
async function createIndividualPayment({ userId, orderId }, deps = {}) {
  return createPayment(userId, { productKind: 'individual_stickers', individualOrderId: orderId }, deps);
}

module.exports = { createIndividualPayment, createTopupPayment };
