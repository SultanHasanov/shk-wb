const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { createNotification } = require('./_notifications');
const { sendMessage } = require('./_telegram-api');

const PACKAGE_PRICES = Object.freeze({ 1:5, 20:12, 30:17, 40:22, 50:23, 100:36, 200:63, 500:135 });
const LICENSE_PRICES = Object.freeze({ 1:25, 3:40, 5:50, 10:90, 20:150 });
const CELL_PRINT_PRICES = Object.freeze({7:{1:50,2:85,3:115,5:175,10:300,20:500},30:{1:150,2:255,3:345,5:525,10:900,20:1500},90:{1:350,2:595,3:805,5:1225,10:2100,20:3500},180:{1:600,2:1020,3:1380,5:2100,10:3600,20:6000},365:{1:1000,2:1700,3:2300,5:3500,10:6000,20:10000}});

function hasYookassa() { return Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY); }
function authHeader() {
  return `Basic ${Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64')}`;
}
async function yookassa(path, options = {}) {
  if (!hasYookassa()) throw new Error('YooKassa is not configured');
  const response = await fetch(`https://api.yookassa.ru/v3/${path}`, {
    ...options,
    headers: { Authorization: authHeader(), 'Content-Type':'application/json', ...(options.headers || {}) },
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
    await notifyCompleted(completed);
    return completed;
  } catch(error) {
    await supabaseFetch(`payment_orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({provider_status:'succeeded',fulfillment_status:'failed',fulfillment_error:String(error.message||'Fulfillment failed').slice(0,1000),updated_at:new Date().toISOString()})}).catch(()=>{});
    throw error;
  }
}
async function notifyCompleted(order){
  if(!order.user_id)return;
  const prefs=await supabaseFetch(`user_preferences?user_id=eq.${encodeURIComponent(order.user_id)}&select=notify_order_status&limit=1`).catch(()=>[]);
  await createNotification({userId:order.user_id,kind:'order',title:'Заказ успешно оплачен',body:`Заказ ${String(order.id).slice(0,8)} готов. Данные покупки доступны в личном кабинете.`,link:'/cabinet/orders',dedupeKey:`order-succeeded:${order.id}`,email:order.email||null,emailEnabled:prefs[0]?.notify_order_status!==false}).catch(()=>{});
  if(order.product_kind==='individual_stickers'){
    const identities=await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(order.user_id)}&select=telegram_user_id&limit=1`).catch(()=>[]);
    const telegramId=identities[0]?.telegram_user_id;
    if(telegramId)await sendMessage(telegramId,'<b>Индивидуальный заказ оплачен ✅</b>\n\nСтикеры доступны в истории кабинета и через кнопку «Мои заказы» в боте.',{reply_markup:{inline_keyboard:[[{text:'📦 Мои заказы',callback_data:'orders:list'}],[{text:'🌐 Открыть кабинет',web_app:{url:'https://shk-wb.vercel.app/cabinet/history'}}]]}}).catch(()=>{});
  }else if(order.product_kind==='stickers'){
    const identities=await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(order.user_id)}&select=telegram_user_id&limit=1`).catch(()=>[]);
    const telegramId=identities[0]?.telegram_user_id;
    if(telegramId){
      const quantity=Number(order.range_quantity||0)+Number(order.custom_quantity||0);
      await sendMessage(telegramId,`<b>Оплата прошла ✅</b>\n\nПакет на ${quantity} шт. зачислен. Можно продолжить генерацию.`,{reply_markup:{inline_keyboard:[[{text:'➕ Создать ШК',callback_data:'gen:start'}]]}}).catch(()=>{});
    }
  }
}
module.exports = { CELL_PRINT_PRICES, completeOrder, hasYookassa, LICENSE_PRICES, PACKAGE_PRICES, pricing, yookassa };
