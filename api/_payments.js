const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');

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
async function pricing(rangeQuantity, customQuantity) {
  function price(quantity) {
    if (!quantity) return { unit:0, total:0 };
    const total = PACKAGE_PRICES[quantity];
    if (!total) { const error = new Error('Выберите один из доступных пакетов'); error.status=400; throw error; }
    return { unit:Math.round(total / quantity * 10000) / 10000, total };
  }
  const range = price(rangeQuantity), custom = price(customQuantity);
  return { range, custom, total: Math.round((range.total + custom.total) * 100) / 100 };
}
async function completeOrder(order, payment) {
  if (payment.status !== 'succeeded' || payment.paid !== true) return order;
  if (order.product_kind === 'program') return { ...order, status:'succeeded' };
  if (order.product_kind === 'program_license') {
    const key=await supabaseFetch('rpc/complete_program_license_order',{method:'POST',body:JSON.stringify({p_order_id:order.id})});
    return {...order,program_license_key:String(key),status:'succeeded'};
  }
  if (['cell_print_program','cell_print_license','cell_print_bundle'].includes(order.product_kind)) {
    const key=await supabaseFetch('rpc/complete_cell_print_order',{method:'POST',body:JSON.stringify({p_order_id:order.id})});
    return {...order,cell_print_license_key:String(key),status:'succeeded'};
  }
  const code = await supabaseFetch('rpc/complete_payment_order', { method:'POST', body:JSON.stringify({p_order_id:order.id}) });
  const updated = { ...order, access_code:String(code), status:'succeeded' };
  return updated;
}
module.exports = { CELL_PRINT_PRICES, completeOrder, hasYookassa, LICENSE_PRICES, PACKAGE_PRICES, pricing, yookassa };
