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

/**
 * Пополнение баланса из бота. then — что сделать после зачисления (afterWalletTopup), messageId — экран бота,
 * который после оплаты станет «Готово». Возвращает { confirmationUrl, token }; при отказе бросает Error с текстом для человека.
 */
async function createTopupPayment({ userId, amount, then = '', messageId = null }, { handler = require('../api/payments'), loadUser = getAuthUser } = {}) {
  const account = await loadUser(userId);
  if (!account?.id) throw new Error('Кабинет не найден — войдите заново');
  const req = {
    method: 'POST',
    query: { action: 'create' },
    // Лимит попыток считается по этому адресу: у каждого пользователя бота свой счётчик.
    headers: { host: 'shk-wb.ru', 'x-forwarded-for': `telegram-bot:${userId}` },
    body: {
      productKind: 'wallet_topup',
      walletAmount: amount,
      walletThen: then || undefined,
      walletMessage: messageId || undefined,
      accepted: true,
      returnTo: 'telegram',
    },
    internalUser: { id: account.id, email: account.email || null },
  };
  const res = responseStub();
  await handler(req, res);
  if (res.statusCode >= 400 || !res.body?.confirmationUrl) {
    throw new Error(res.body?.error || `Не удалось создать оплату (${res.statusCode})`);
  }
  return { confirmationUrl: res.body.confirmationUrl, token: res.body.token || null };
}

module.exports = { createTopupPayment };
