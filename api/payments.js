const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { supabaseFetch } = require('./_supabase');
const { CELL_PRINT_PRICES, completeOrder, hasYookassa, LICENSE_PRICES, PACKAGE_PRICES, pricing, yookassa } = require('./_payments');
function publicOrder(row) {
  const program = row.product_kind === 'program', cellProgram=String(row.product_kind||'').startsWith('cell_print_');
  return { status:row.status, productKind:row.product_kind || 'stickers', stickerTarget:row.sticker_target||'product', rangeQuantity:row.range_quantity, customQuantity:row.custom_quantity,
    amount:Number(row.amount), accessCode:row.access_code, licenseKey:row.program_license_key||row.cell_print_license_key, licenseIterations:row.license_iterations,
    durationDays:row.cell_print_duration_days,deviceLimit:row.cell_print_device_limit,downloadUrl:row.status==='succeeded'?(cellProgram?'/api/payments/download-cell-print':program?`/api/payments/download?token=${encodeURIComponent(row.public_token)}`:null):null, createdAt:row.created_at };
}
async function getOrderBy(field, value) {
  const rows = await supabaseFetch(`payment_orders?${field}=eq.${encodeURIComponent(value)}&select=*&limit=1`);
  return rows[0] || null;
}
module.exports = async function handler(req, res) {
  const action = String(req.query.action || '');
  try {
    if (action === 'config' && req.method === 'GET') {
      const settings = await supabaseFetch('payment_settings?select=enabled&id=eq.true&limit=1');
      return res.json({ enabled:Boolean(settings[0]?.enabled && hasYookassa()), testMode:process.env.YOOKASSA_TEST_MODE !== 'false', packages:Object.entries(PACKAGE_PRICES).map(([quantity,total])=>({quantity:Number(quantity),total})),licensePackages:Object.entries(LICENSE_PRICES).map(([iterations,total])=>({iterations:Number(iterations),total})),cellPrintPrices:CELL_PRINT_PRICES });
    }
    if (action === 'create' && req.method === 'POST') {
      const requestedKind=String(req.body?.productKind||'');
      const stickerTarget=req.body?.stickerTarget==='box'?'box':'product';
      const cellKinds=['cell_print_program','cell_print_license','cell_print_bundle'];
      const productKind=requestedKind==='program'?'program':requestedKind==='program_license'?'program_license':cellKinds.includes(requestedKind)?requestedKind:'stickers';
      const rangeQuantity=Number(req.body?.rangeQuantity||0), customQuantity=Number(req.body?.customQuantity||0);
      const licenseIterations=Number(req.body?.licenseIterations||0);
      const cellDays=Number(req.body?.durationDays||0),deviceLimit=Number(req.body?.deviceLimit||0),promoCode=String(req.body?.promoCode||'').trim().toUpperCase();
      const allowed=(value)=>value===0||Object.prototype.hasOwnProperty.call(PACKAGE_PRICES,value);
      if (productKind==='stickers'&&(!Number.isInteger(rangeQuantity)||!Number.isInteger(customQuantity)||!allowed(rangeQuantity)||!allowed(customQuantity)||rangeQuantity+customQuantity<1)) return res.status(400).json({error:'Выберите один из доступных пакетов'});
      if(productKind==='program_license'&&!Object.prototype.hasOwnProperty.call(LICENSE_PRICES,licenseIterations))return res.status(400).json({error:'Выберите пакет итераций'});
      if(cellKinds.includes(productKind)){
        if(productKind==='cell_print_program'){if(cellDays!==3||deviceLimit!==1)return res.status(400).json({error:'Некорректный пробный пакет'});}
        else if(!CELL_PRINT_PRICES[cellDays]?.[deviceLimit])return res.status(400).json({error:'Выберите срок и число устройств'});
      }
      if (req.body?.accepted !== true) return res.status(400).json({error:'Необходимо принять оферту и политику'});
      const settings=await supabaseFetch('payment_settings?select=enabled&id=eq.true&limit=1');
      if (!settings[0]?.enabled||!hasYookassa()) return res.status(503).json({error:'Оплата пока не подключена'});
      let calculated=productKind==='program'?{program:{total:150},range:{unit:0,total:0},custom:{unit:0,total:0},total:150}:productKind==='program_license'?{license:{iterations:licenseIterations,total:LICENSE_PRICES[licenseIterations]},total:LICENSE_PRICES[licenseIterations]}:cellKinds.includes(productKind)?{cellPrint:{durationDays:cellDays,deviceLimit,program:['cell_print_program','cell_print_bundle'].includes(productKind),bonusDays:productKind==='cell_print_bundle'?3:0},total:(['cell_print_program','cell_print_bundle'].includes(productKind)?150:0)+(productKind==='cell_print_program'?0:CELL_PRINT_PRICES[cellDays][deviceLimit])}:await pricing(rangeQuantity,customQuantity);
      if(cellKinds.includes(productKind)&&promoCode){const scope=productKind==='cell_print_program'?'program':productKind==='cell_print_license'?'license':'all';const discount=Number(await supabaseFetch('rpc/consume_cell_print_promo',{method:'POST',body:JSON.stringify({p_code:promoCode,p_scope:scope})}));calculated.discountPercent=discount;calculated.total=Math.round(calculated.total*(100-discount))/100;}
      if (calculated.total < 0) return res.status(400).json({error:'Некорректная сумма'});
      const token=crypto.randomBytes(32).toString('base64url'), idempotence=crypto.randomUUID();
      const orderPayload={public_token:token,range_quantity:productKind==='stickers'?rangeQuantity:0,custom_quantity:productKind==='stickers'?customQuantity:0,amount:calculated.total,pricing_snapshot:calculated,idempotence_key:idempotence,product_kind:productKind};
      if(productKind==='stickers')orderPayload.sticker_target=stickerTarget;
      if(productKind==='program_license')orderPayload.license_iterations=licenseIterations;
      if(cellKinds.includes(productKind)){orderPayload.cell_print_duration_days=cellDays+(productKind==='cell_print_bundle'?3:0);orderPayload.cell_print_device_limit=deviceLimit;if(promoCode)orderPayload.promo_code=promoCode;}
      const inserted=await supabaseFetch('payment_orders',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(orderPayload)});
      const order=inserted[0];
      if(calculated.total===0){await supabaseFetch(`payment_orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({status:'succeeded',paid_at:new Date().toISOString(),updated_at:new Date().toISOString()})});await completeOrder({...order,status:'succeeded'}, {status:'succeeded',paid:true});return res.status(201).json({confirmationUrl:`/payment-result?token=${encodeURIComponent(token)}`,token});}
      try {
        const description=productKind==='program'?`Программа для Windows, заказ ${order.id}`:productKind==='program_license'?`Ключ программы: ${licenseIterations} итераций, заказ ${order.id}`:cellKinds.includes(productKind)?`Печать ячеек: ${cellDays} дней, ${deviceLimit} устройств, заказ ${order.id}`:`Доступ к генератору ${stickerTarget==='box'?'QR коробок':'стикеров товаров'}, заказ ${order.id}`;
        const payment=await yookassa('payments',{method:'POST',headers:{'Idempotence-Key':idempotence},body:JSON.stringify({amount:{value:calculated.total.toFixed(2),currency:'RUB'},capture:true,confirmation:{type:'redirect',return_url:`https://shk-wb.vercel.app/payment-result?token=${encodeURIComponent(token)}`},description,metadata:{order_id:order.id,product_kind:productKind}})});
        await supabaseFetch(`payment_orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({yookassa_payment_id:payment.id,status:payment.status,confirmation_url:payment.confirmation?.confirmation_url,updated_at:new Date().toISOString()})});
        return res.status(201).json({confirmationUrl:payment.confirmation?.confirmation_url,token});
      } catch(error) { await supabaseFetch(`payment_orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({status:'canceled',updated_at:new Date().toISOString()})}); throw error; }
    }
    if (action === 'promo' && req.method === 'POST') {
      if (req.body?.accepted !== true) return res.status(400).json({error:'Необходимо принять оферту и политику'});
      const promoCode=String(req.body?.promoCode||'').trim().toUpperCase();
      if(!/^[A-Z0-9_-]{3,32}$/.test(promoCode))return res.status(400).json({error:'Промокод недействителен или уже использован'});
      const token=crypto.randomBytes(32).toString('base64url');
      try {
        await supabaseFetch('rpc/redeem_program_promocode',{method:'POST',body:JSON.stringify({p_code:promoCode,p_public_token:token})});
      } catch(error) {
        if(error.status===400)return res.status(400).json({error:'Промокод недействителен или уже использован'});
        throw error;
      }
      return res.status(201).json({downloadUrl:`/api/payments/download?token=${encodeURIComponent(token)}`});
    }
    if (action === 'status' && req.method === 'GET') {
      const token=String(req.query.token||''); if(!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return res.status(400).json({error:'Некорректная ссылка заказа'});
      let order=await getOrderBy('public_token',token); if(!order) return res.status(404).json({error:'Заказ не найден'});
      if(order.yookassa_payment_id&&order.status!=='succeeded'){ const payment=await yookassa(`payments/${encodeURIComponent(order.yookassa_payment_id)}`); await supabaseFetch(`payment_orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({status:payment.status,updated_at:new Date().toISOString()})}); order=await completeOrder(order,payment); order.status=payment.status; }
      return res.json(publicOrder(order));
    }
    if (action === 'download' && req.method === 'GET') {
      const token=String(req.query.token||'');if(!/^[A-Za-z0-9_-]{40,100}$/.test(token))return res.status(400).end();
      let order=await getOrderBy('public_token',token);if(!order||!['program','cell_print_program','cell_print_bundle'].includes(order.product_kind))return res.status(404).end();
      if(order.status!=='succeeded'&&order.yookassa_payment_id){const payment=await yookassa(`payments/${encodeURIComponent(order.yookassa_payment_id)}`);if(payment.status==='succeeded'&&payment.paid===true){await supabaseFetch(`payment_orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({status:'succeeded',paid_at:new Date().toISOString(),updated_at:new Date().toISOString()})});order.status='succeeded';}}
      if(order.status!=='succeeded')return res.status(403).end();
      const isCell=order.product_kind.startsWith('cell_print_');const installer=path.join(__dirname,'_private',isCell?'cell-print-installer.exe':'program-installer.exe');
      const stat=fs.statSync(installer);res.setHeader('Content-Type','application/vnd.microsoft.portable-executable');res.setHeader('Content-Length',String(stat.size));res.setHeader('Content-Disposition',`attachment; filename="${isCell?'cell-print-1.0.11.exe':'program-windows-1.3.2.exe'}"`);res.setHeader('Cache-Control','private, no-store');return fs.createReadStream(installer).pipe(res);
    }
    if (action === 'download-cell-print' && req.method === 'GET') {
      const installer=path.join(__dirname,'_private','cell-print-installer.exe');
      const stat=fs.statSync(installer);res.setHeader('Content-Type','application/vnd.microsoft.portable-executable');res.setHeader('Content-Length',String(stat.size));res.setHeader('Content-Disposition','attachment; filename="cell-print-1.0.11.exe"');res.setHeader('Cache-Control','no-store');return fs.createReadStream(installer).pipe(res);
    }
    if (action === 'webhook' && req.method === 'POST') {
      const paymentId=String(req.body?.object?.id||''); if(!paymentId) return res.status(400).end();
      const payment=await yookassa(`payments/${encodeURIComponent(paymentId)}`);
      const order=await getOrderBy('yookassa_payment_id',paymentId); if(!order) return res.status(200).end();
      await supabaseFetch(`payment_orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({status:payment.status,updated_at:new Date().toISOString()})});
      await completeOrder(order,payment); return res.status(200).end();
    }
    return res.status(405).json({error:'Method not allowed'});
  } catch(error){ console.error(error.message,error.details||''); return res.status(error.status&&error.status<500?error.status:502).json({error:error.message||'Ошибка оплаты'}); }
};
