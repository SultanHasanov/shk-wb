const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { createNotification, sendEmail } = require('./_notifications');
const { editMessageText, sendMessage } = require('./_telegram-api');
const topupScreen = require('./_topup-screen');
// Кнопки под уведомлениями — n:<callback>: бот откроет экран новым сообщением, уведомление останется (server/_bot-notice.js).
const { noticeMarkup } = require('./_bot-notice');
// Тексты, общие с ботом (вознаграждение за приглашение, проценты) — server/_bot-texts.js.
const botTexts = require('./_bot-texts');
const { notifyAdminOrder } = require('./_admin-alerts');
const { ADDONS } = require('./_app-plans');
const { shopCredentials } = require('./_sites');

const PACKAGE_PRICES = Object.freeze({ 1:5, 20:12, 30:17, 40:22, 50:23, 100:36, 200:63, 500:135 });
// Поштучная генерация по введённому пользователем номеру. Массовая пачка
// из 50 автоматически выделенных кодов за 20 ₽ остаётся отдельным продуктом.
const CUSTOM_GENERATION_PACKAGES = Object.freeze({ 1:7.5, 10:50, 20:90, 30:120, 50:175, 100:300 });
const LICENSE_PRICES = Object.freeze({ 1:50, 3:140, 5:220, 10:400, 20:700 });
// «Кто поставил оценку» в Telegram-боте: цена за одного автора, списывается с баланса
// (сама сумма списания зашита в bot_review_spend, миграция 20261023_wallet.sql — менять вместе).
const REVIEW_PRICE = 25;
// «Код клиента» в Telegram-боте: цена за один QR, списывается с баланса (rpc wallet_spend).
const CLIENT_CODE_PRICE = 50;
const CELL_PRINT_PRICES = Object.freeze({7:{1:79,2:135,3:179,5:279,10:469,20:790},30:{1:249,2:419,3:569,5:869,10:1490,20:2490},90:{1:599,2:1019,3:1379,5:2090,10:3590,20:5990},180:{1:1090,2:1850,3:2490,5:3790,10:6490,20:10900},365:{1:1990,2:3390,3:4590,5:6990,10:11990,20:19900}});

function hasYookassa(shop) { return Boolean(shopCredentials(shop)); }
function authHeader(shop) {
  const { shopId, secretKey } = shopCredentials(shop);
  return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`;
}
/** shop: магазин заказа (payment_orders.payment_shop). Без него запрос идёт в магазин основного сайта. */
async function yookassa(path, options = {}, shop) {
  if (!hasYookassa(shop)) throw new Error('YooKassa is not configured');
  const response = await fetch(`https://api.yookassa.ru/v3/${path}`, {
    ...options,
    headers: { Authorization: authHeader(shop), 'Content-Type':'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.description || 'YooKassa request failed'); error.status=response.status; error.details=data; throw error; }
  return data;
}
/* Пул генераций теперь общий, поэтому заказ — это просто список купленных
   пакетов. Список, а не одно число, потому что старый интерфейс умел класть в
   один заказ два пакета, и такой заказ должен считаться так же. */
async function pricing(quantities) {
  const packs = (Array.isArray(quantities) ? quantities : [quantities]).filter(Boolean);
  const priced = packs.map((quantity) => {
    const total = PACKAGE_PRICES[quantity];
    if (!total) { const error = new Error('Выберите один из доступных пакетов'); error.status=400; throw error; }
    return { quantity, unit:Math.round(total / quantity * 10000) / 10000, total };
  });
  return {
    packs: priced,
    units: priced.reduce((sum, pack) => sum + pack.quantity, 0),
    total: Math.round(priced.reduce((sum, pack) => sum + pack.total, 0) * 100) / 100,
  };
}
async function completeOrder(order, payment) {
  if (payment.status !== 'succeeded' || payment.paid !== true) return order;
  if (order.fulfillment_status === 'fulfilled') return order;
  const now=new Date().toISOString();
  await supabaseFetch(`payment_orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({provider_status:'succeeded',paid_at:order.paid_at||now,fulfillment_status:'processing',fulfillment_error:null,updated_at:now})});
  try {
    let completed={...order,provider_status:'succeeded'};
    if(order.product_kind==='program'){
      completed={...completed,status:'succeeded'};
    }else if(order.product_kind==='individual_stickers'){
      await supabaseFetch('rpc/complete_individual_sticker_order',{method:'POST',body:JSON.stringify({p_payment_order_id:order.id})});
      completed={...completed,status:'succeeded'};
    }else if(order.product_kind==='app_subscription'){
      await supabaseFetch('rpc/complete_app_subscription_order',{method:'POST',body:JSON.stringify({p_order_id:order.id})});
      completed={...completed,status:'succeeded'};
    }else if(order.product_kind==='app_addon'){
      await supabaseFetch('rpc/complete_app_addon_order',{method:'POST',body:JSON.stringify({p_order_id:order.id})});
      completed={...completed,status:'succeeded'};
    }else if(order.product_kind==='wallet_topup'){
      const balance=await supabaseFetch('rpc/complete_wallet_topup_order',{method:'POST',body:JSON.stringify({p_order_id:order.id})});
      completed={...completed,status:'succeeded',wallet_balance_kopecks:Number(balance)};
    }else if(order.product_kind==='program_license'){
      const key=await supabaseFetch('rpc/complete_program_license_order',{method:'POST',body:JSON.stringify({p_order_id:order.id})});
      completed={...completed,status:'succeeded',program_license_key:String(key)};
    }else if(['cell_print_program','cell_print_license','cell_print_bundle'].includes(order.product_kind)){
      if(order.promo_code)await supabaseFetch('rpc/commit_cell_print_promo',{method:'POST',body:JSON.stringify({p_order_id:order.id})});
      const key=await supabaseFetch('rpc/complete_cell_print_order',{method:'POST',body:JSON.stringify({p_order_id:order.id})});
      completed={...completed,status:'succeeded',cell_print_license_key:String(key)};
    }else{
      const code=await supabaseFetch('rpc/complete_payment_order',{method:'POST',body:JSON.stringify({p_order_id:order.id})});
      completed={...completed,status:'succeeded',access_code:String(code)};
    }
    const fulfilledAt=new Date().toISOString();
    await supabaseFetch(`payment_orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({status:'succeeded',provider_status:'succeeded',fulfillment_status:'fulfilled',fulfilled_at:fulfilledAt,fulfillment_error:null,paid_at:order.paid_at||now,updated_at:fulfilledAt})});
    completed={...completed,fulfillment_status:'fulfilled',fulfilled_at:fulfilledAt};
    await notifyAdminOrder(completed).catch(error=>console.error('Admin order alert failed',error.message));
    await notifyCompleted(completed);
    return completed;
  } catch(error) {
    await supabaseFetch(`payment_orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({provider_status:'succeeded',fulfillment_status:'failed',fulfillment_error:String(error.message||'Fulfillment failed').slice(0,1000),updated_at:new Date().toISOString()})}).catch(()=>{});
    throw error;
  }
}
async function telegramIdOf(userId){
  if(!userId)return null;
  const identities=await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(userId)}&select=telegram_user_id&limit=1`).catch(()=>[]);
  return identities[0]?.telegram_user_id||null;
}

/**
 * Править экран оплаты пополнения в боте (pricing_snapshot.wallet.message). Не трогаем, если в том же сообщении
 * человек уже открыл более новую оплату (нажал «Попробовать ещё раз» или другую сумму): экран теперь её.
 */
async function editTopupScreen(order,telegramId,text,options={}){
  const messageId=Number(order?.pricing_snapshot?.wallet?.message)||0;
  if(!telegramId||!messageId)return false;
  if(order.created_at){
    const newer=await supabaseFetch(`payment_orders?user_id=eq.${encodeURIComponent(order.user_id)}&product_kind=eq.wallet_topup&created_at=gt.${encodeURIComponent(order.created_at)}&pricing_snapshot->wallet->>message=eq.${messageId}&select=id&limit=1`).catch(()=>[]);
    if(Array.isArray(newer)&&newer.length)return false;
  }
  await editMessageText(telegramId,messageId,text,options).catch(error=>{if(!/not modified/i.test(String(error.message)))console.warn('Top-up screen edit failed',error.message);});
  return true;
}

/**
 * ЮKassa отменила платёж пополнения из бота (отказ банка или брошенная оплата — её ЮKassa отменяет сама через час):
 * экран оплаты в боте — «деньги не списаны» и «Попробовать ещё раз» вместо мёртвой ссылки. Нового сообщения не шлём:
 * брошенный платёж отменяется, когда человек давно ушёл, и уведомление через час только запутало бы.
 * Вызывать один раз — при переходе заказа в canceled (вебхук или запрос статуса).
 */
async function notifyTopupCanceled(order,payment){
  if(order?.product_kind!=='wallet_topup'||!order.user_id)return false;
  if(!order.pricing_snapshot?.wallet?.message)return false;
  const telegramId=await telegramIdOf(order.user_id);
  if(!telegramId)return false;
  const wallet=order.pricing_snapshot.wallet;
  const view=topupScreen.canceledScreen({amount:Number(wallet.amount||order.gross_amount||0),then:String(wallet.then||''),reason:String(payment?.cancellation_details?.reason||'')});
  return editTopupScreen(order,telegramId,view.text,{reply_markup:view.reply_markup});
}

/** Пригласившему — в Telegram-бот: «+X ₽ с оплаты друга». Награду пишет SQL-триггер при статусе succeeded. */
async function notifyReferralReward(order){
  if(!(Number(order.amount||0)>0))return;
  const rewards=await supabaseFetch(`referral_ledger?order_id=eq.${encodeURIComponent(order.id)}&kind=eq.reward&select=user_id,amount_kopecks&limit=1`);
  const reward=rewards[0];
  if(!reward?.user_id)return;
  const identities=await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(reward.user_id)}&select=telegram_user_id&limit=1`);
  const telegramId=identities[0]?.telegram_user_id;
  if(!telegramId)return;
  // Вознаграждение лежит не на балансе, а в «Можно забрать» экрана приглашений — пишем, сколько там накоплено.
  // Сбой чтения — без этой строки: сообщение о начислении важнее.
  const accounts=await supabaseFetch(`referral_accounts?user_id=eq.${encodeURIComponent(reward.user_id)}&select=available_kopecks&limit=1`).catch(()=>[]);
  const available=accounts[0]?.available_kopecks;
  const text=botTexts.referralRewardHtml({rewardKopecks:Number(reward.amount_kopecks),availableKopecks:available==null?null:Number(available)});
  await sendMessage(telegramId,text,{reply_markup:noticeMarkup({inline_keyboard:botTexts.REFERRAL_KEYBOARD})});
}
/**
 * Итог пополнения в бот (и покупка после него, afterWalletTopup) — один раз на заказ. Вебхук ЮKassa на сайте и
 * «🔄 Проверить оплату» (action=status на узле бота) могут завершить заказ одновременно: completeOrder заказ не
 * захватывает, и без этой метки пришли бы два «Баланс пополнен ✅», а «пополнить и получить QR» списал бы код дважды.
 * Метка — строка telegram_generation_requests (request_id первичный ключ). Сбой самой базы — сообщаем, как раньше:
 * потерять итог оплаты хуже редкого дубля.
 */
async function claimTopupNotice(order,telegramId){
  try{
    const rows=await supabaseFetch('telegram_generation_requests?on_conflict=request_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({request_id:`topup-done:${order.id}`,telegram_user_id:Number(telegramId),chat_id:Number(telegramId),user_id:order.user_id,status:'completed',draft:{orderId:order.id},completed_at:new Date().toISOString()})});
    return !Array.isArray(rows)||rows.length>0;
  }catch(error){
    console.warn('Top-up notice claim failed',order.id,error.message);
    return true;
  }
}

async function notifyCompleted(order){
  // Покупку с баланса делает бот и сам показывает результат — письма и сообщения не нужны.
  if(Number(order.wallet_paid_kopecks||0)>0)return;
  const secret=order.access_code||order.program_license_key||order.cell_print_license_key||null;
  const secretLabel=order.access_code?'Код доступа':'Ключ активации';
  const deliveryLine=secret?` ${secretLabel}: ${secret}.`:'';
  const body=order.product_kind==='app_subscription'
    ?`Подписка «Помощник ПВЗ» оплачена (заказ ${String(order.id).slice(0,8)}). Тариф уже доступен в программе — достаточно войти в аккаунт.`
    :order.product_kind==='app_addon'
    ?`«${(ADDONS[order.app_addon]||ADDONS.archive).title}» для «Помощника ПВЗ» подключено (заказ ${String(order.id).slice(0,8)}). В программе заработает в течение нескольких минут или по кнопке «Обновить».`
    :order.product_kind==='wallet_topup'
    ?`Баланс пополнен на ${(Number(order.wallet_topup_kopecks||0)/100).toLocaleString('ru-RU')} ₽ (заказ ${String(order.id).slice(0,8)}). Тратить его можно в Telegram-боте.`
    :`Заказ ${String(order.id).slice(0,8)} готов.${deliveryLine} Данные покупки доступны в личном кабинете.`;
  if(order.user_id){
    const prefs=await supabaseFetch(`user_preferences?user_id=eq.${encodeURIComponent(order.user_id)}&select=notify_order_status&limit=1`).catch(()=>[]);
    await createNotification({userId:order.user_id,kind:'order',title:'Заказ успешно оплачен',body,link:'/cabinet/orders',dedupeKey:`order-succeeded:${order.id}`,email:order.email||null,emailEnabled:prefs[0]?.notify_order_status!==false}).catch(()=>{});
  }else if(order.email){
    await sendEmail({userId:null,notificationId:null,to:order.email,subject:'Заказ успешно оплачен',text:body,dedupeKey:`email:order-succeeded:${order.id}`}).catch(()=>{});
  }
  if(!order.user_id)return;
  await notifyReferralReward(order).catch(()=>{});
  if(order.product_kind==='individual_stickers'){
    const identities=await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(order.user_id)}&select=telegram_user_id&limit=1`).catch(()=>[]);
    const telegramId=identities[0]?.telegram_user_id;
    // Ссылки на PDF подписаны на час — в сообщение их не кладём: кнопка «Мои заказы» строит свежие.
    if(telegramId)await sendMessage(telegramId,'<b>Индивидуальный заказ оплачен ✅</b>\n\nPDF со стикерами — по кнопке ниже.',{reply_markup:noticeMarkup({inline_keyboard:[[{text:'📄 Скачать стикеры',callback_data:'orders:list'}],[{text:'☰ Меню',callback_data:'menu:home'}]]})}).catch(()=>{});
  }else if(order.product_kind==='wallet_topup'){
    const telegramId=await telegramIdOf(order.user_id);
    if(!telegramId)return;
    if(!await claimTopupNotice(order,telegramId))return;
    const amounts=topupScreen.topupAmounts(order);
    const head=`<b>Баланс пополнен ✅</b>\n${topupScreen.creditedLine(amounts)}`;
    const balanceRub=order.wallet_balance_kopecks!=null?Number(order.wallet_balance_kopecks)/100:null;
    const then=order.pricing_snapshot?.wallet?.then;
    // Пополняли ради покупки («Пополнить на X ₽ и купить») — проводим её сразу, без повторных нажатий.
    // Экран покупки правит сам бот (afterWalletTopup): итог — в этом сообщении или ниже.
    if(then){
      const notice=await sendMessage(telegramId,`${head}\nОплачиваю покупку…`).catch(()=>null);
      // Через RPC на узел бота (или локально, если узла нет); модуль подключается лениво — прямой require дал бы цикл.
      const started=await require('./_bot-rpc').callBot('afterWalletTopup',order,notice?.message_id||null).catch(error=>{console.error('Auto purchase after top-up failed',error.message);return false;});
      if(!started){
        // «Оплачиваю покупку…» больше не правда; что делать — отдельным сообщением с прямой кнопкой к покупке.
        if(notice?.message_id)await editMessageText(telegramId,notice.message_id,head).catch(()=>{});
        const view=topupScreen.purchaseNotStartedText({balanceRub:balanceRub??NaN,then});
        await sendMessage(telegramId,view.text,{reply_markup:noticeMarkup({inline_keyboard:view.rows})}).catch(()=>{});
      }
      return;
    }
    // Экран оплаты в боте (если он есть и не занят более новой оплатой) — без мёртвой кнопки «Перейти к оплате».
    await editTopupScreen(order,telegramId,topupScreen.paidScreenText(amounts.paid),{reply_markup:{inline_keyboard:[]}});
    const balanceLine=balanceRub!=null?`\n💰 На балансе: <b>${topupScreen.formatRub(balanceRub)}</b>`:'';
    await sendMessage(telegramId,`${head}${balanceLine}`,{reply_markup:noticeMarkup({inline_keyboard:[[{text:'🏷 Стикеры и QR',callback_data:'menu:stickers'},{text:'🛒 Купить с баланса',callback_data:'shop:home'}],[{text:'👤 Профиль',callback_data:'menu:profile'},{text:'☰ Меню',callback_data:'menu:home'}]]})}).catch(()=>{});
  }else if(order.product_kind==='stickers'){
    const identities=await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(order.user_id)}&select=telegram_user_id&limit=1`).catch(()=>[]);
    const telegramId=identities[0]?.telegram_user_id;
    if(telegramId){
      const quantity=Number(order.range_quantity||0)+Number(order.custom_quantity||0);
      const codeLine=order.access_code?`\nКод доступа: <code>${order.access_code}</code>\n`:'';
      await sendMessage(telegramId,`<b>Оплата прошла ✅</b>\n\nПакет на ${quantity} шт. зачислен.${codeLine}\nМожно создавать стикеры.`,{reply_markup:noticeMarkup({inline_keyboard:[[{text:'🏷 Создать стикер',callback_data:'menu:stickers'}],[{text:'☰ Меню',callback_data:'menu:home'}]]})}).catch(()=>{});
    }
  }
}
module.exports = { CELL_PRINT_PRICES, CLIENT_CODE_PRICE, completeOrder, CUSTOM_GENERATION_PACKAGES, hasYookassa, LICENSE_PRICES, notifyReferralReward, notifyTopupCanceled, PACKAGE_PRICES, pricing, REVIEW_PRICE, yookassa };
