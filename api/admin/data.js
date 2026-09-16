const {
  clearSessionCookie, createSessionCookie, getRequiredEnv,
  isAuthenticated, requireAdmin, safeEqual, verifyAdminTotp,
} = require('../../server/_admin-auth');
const { sendApiError, supabaseFetch, supabaseFetchWithMeta } = require('../../server/_supabase');
const { hasYookassa, yookassa, completeOrder, PACKAGE_PRICES } = require('../../server/_payments');
const handleCabinetAdmin = require('../../server/_admin-cabinet');
const handleAdminUsers = require('../../server/_admin-users');
const { enforceRateLimit } = require('../../server/_rate-limit');
// Выдача кодов и ключей живёт в общем модуле: тем же самым занимается раздел
// «Пользователи», и вторая копия проверок разошлась бы с этой.
const {
  RESOURCES, checkCellLicensePatch, checkProgramPromoPatch, checkStickerAccessPatch,
  createCellLicense, createStickerAccessCode, validateProgramPromo,
} = require('../../server/_admin-grants');

module.exports = async function handler(req, res) {
  if (req.query.cabinet) return handleCabinetAdmin(req, res);
  if (req.query.auth === 'login') return handleLogin(req, res);
  if (req.query.auth === 'logout') return handleLogout(req, res);
  if (req.query.auth === 'session') return handleSession(req, res);
  if (!requireAdmin(req, res)) return;
  if (req.query.resource === 'users') return handleAdminUsers(req, res);
  if (req.query.resource === 'stickerPool') return handleStickerPool(req, res);
  if (req.query.resource === 'boxPool') return handleBoxPool(req, res);
  if (req.query.resource === 'paymentAdmin') return handlePaymentAdmin(req, res);
  if (req.query.resource === 'stats') return handleStats(req, res);
  if (req.query.resource === 'freeGenerations') return handleFreeGenerations(req, res);
  const config = RESOURCES[req.query.resource];
  const id = req.query.id;
  if (!config || (id && !/^\d+$/.test(String(id)) && !(req.query.resource === 'cellRelease' && id === 'true'))) {
    return res.status(400).json({ error: 'Invalid resource' });
  }

  try {
    if (req.method === 'GET') {
      const rows = await supabaseFetch(`${config.table}?select=*&order=id.desc`);
      return res.status(200).json(rows.map(config.fromDb));
    }
    if (req.method === 'POST') {
      if (req.query.resource === 'cellLicense') {
        const created = await createCellLicense(req.body || {});
        if (created.error) return res.status(400).json({ error: created.error });
        return res.status(201).json(config.fromDb(created.row));
      }
      if (req.query.resource === 'programPromo') { const validationError=validateProgramPromo(req.body||{},true); if(validationError)return res.status(400).json({error:validationError}); }
      if (req.query.resource === 'stickerAccess') {
        const created = await createStickerAccessCode(req.body || {});
        if (created.error) return res.status(400).json({ error: created.error });
        return res.status(201).json(config.fromDb(created.row));
      }
      const rows = await supabaseFetch(config.table, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(config.toDb(req.body || {})),
      });
      return res.status(201).json(config.fromDb(rows[0]));
    }
    if (req.method === 'PATCH' && id) {
      let extra = null;
      if (req.query.resource === 'cellLicense') {
        const checked = await checkCellLicensePatch(id, req.body || {});
        if (checked.error) return res.status(checked.status || 400).json({ error: checked.error });
        extra = checked.extra;
      }
      if (req.query.resource === 'programPromo') {
        const checked = await checkProgramPromoPatch(id, req.body || {});
        if (checked.error) return res.status(checked.status || 400).json({ error: checked.error });
      }
      if (req.query.resource === 'stickerAccess') {
        const checked = await checkStickerAccessPatch(id, req.body || {});
        if (checked.error) return res.status(checked.status || 400).json({ error: checked.error });
      }
      const rows = await supabaseFetch(`${config.table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ ...config.toDb(req.body || {}), ...(extra || {}) }),
      });
      return res.status(200).json(config.fromDb(rows[0]));
    }
    if (req.method === 'DELETE' && id) {
      if(req.query.resource==='cellLicense'){const current=await supabaseFetch(`${config.table}?id=eq.${id}&select=activated_at&limit=1`);if(current[0]?.activated_at)return res.status(409).json({error:'Активированный ключ можно только отозвать'});}
      await supabaseFetch(`${config.table}?id=eq.${id}`, { method: 'DELETE' });
      return res.status(204).end();
    }
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return sendApiError(res, error);
  }
};

async function handleLogin(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!await enforceRateLimit(req, res, { scope:'admin-login', limit:5, windowSeconds:900 })) return;
  let configuredPassword;
  try {
    configuredPassword = getRequiredEnv('ADMIN_PASSWORD');
    getRequiredEnv('ADMIN_SESSION_SECRET');
  } catch (error) {
    console.error(error.message);
    return res.status(500).json({ error: 'Server is not configured' });
  }
  const entered = req.body && req.body.password;
  const separator=typeof entered==='string'?entered.lastIndexOf(':'):-1;
  const password=process.env.ADMIN_TOTP_SECRET&&separator>0?entered.slice(0,separator):entered;
  const otp=process.env.ADMIN_TOTP_SECRET&&separator>0?entered.slice(separator+1):'';
  if (typeof password !== 'string' || !safeEqual(password, configuredPassword) || !verifyAdminTotp(otp)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.setHeader('Set-Cookie', createSessionCookie());
  return res.status(204).end();
}

function handleLogout(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Set-Cookie', clearSessionCookie());
  return res.status(204).end();
}

function handleSession(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  return res.status(isAuthenticated(req) ? 204 : 401).end();
}

async function handleStats(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const [siteRows, appRows, uniqueVisitors, daily] = await Promise.all([
      supabaseFetch('site_stats?select=total_visits&id=eq.1&limit=1'),
      supabaseFetch('app_stats?select=total_launches&id=eq.1&limit=1'),
      supabaseFetchWithMeta('site_visitors?select=visitor_id&limit=1', { headers: { Range: '0-0' } }),
      supabaseFetch('daily_analytics?select=day,event_type,event_count&order=day.desc&limit=730'),
    ]);
    const byDay={}; for(const row of daily){if(!byDay[row.day])byDay[row.day]={day:row.day,siteVisits:0,uniqueVisitors:0,appLaunches:0};if(row.event_type==='site_visit')byDay[row.day].siteVisits=Number(row.event_count);if(row.event_type==='unique_site_visit')byDay[row.day].uniqueVisitors=Number(row.event_count);if(row.event_type==='app_launch')byDay[row.day].appLaunches=Number(row.event_count)}
    return res.json({ totals:{siteVisits:Number(siteRows[0]?.total_visits||0),uniqueVisitors:Number(uniqueVisitors.count||0),appLaunches:Number(appRows[0]?.total_launches||0)}, days:Object.values(byDay).sort((a,b)=>b.day.localeCompare(a.day)) });
  } catch(error){ return sendApiError(res,error); }
}

/** Бесплатные первые генерации: партии с access_code is null. */
async function handleFreeGenerations(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow','GET'); return res.status(405).json({error:'Method not allowed'}); }
  try {
    return res.json(await supabaseFetch('rpc/admin_free_generation_stats', { method: 'POST', body: '{}' }));
  } catch(error){ return sendApiError(res,error); }
}

async function handlePaymentAdmin(req, res) {
  try {
    const operation=String(req.query.operation||'overview');
    if(req.method==='GET'){
      const [settings,tiers,orders]=await Promise.all([
        supabaseFetch('payment_settings?select=*&id=eq.true&limit=1'),
        supabaseFetch('payment_price_tiers?select=*&order=kind.asc,min_quantity.asc'),
        supabaseFetch('payment_orders?select=*&order=created_at.desc&limit=100'),
      ]);
      return res.json({enabled:Boolean(settings[0]?.enabled),readiness:{yookassa:hasYookassa(),testMode:process.env.YOOKASSA_TEST_MODE!=='false'},tiers,packages:Object.entries(PACKAGE_PRICES).map(([quantity,total])=>({quantity:Number(quantity),total})),orders});
    }
    if(req.method==='POST'&&operation==='settings'){
      const enabled=Boolean(req.body?.enabled); if(enabled&&!hasYookassa())return res.status(400).json({error:'Сначала добавьте реквизиты ЮKassa в Vercel'});
      await supabaseFetch('payment_settings?id=eq.true',{method:'PATCH',body:JSON.stringify({enabled,updated_at:new Date().toISOString()})}); return res.json({enabled});
    }
    if(req.method==='POST'&&operation==='tier'){
      const kind=String(req.body?.kind),min=Number(req.body?.minQuantity),price=Number(req.body?.unitPrice);
      if(!['range','custom'].includes(kind)||!Number.isInteger(min)||min<1||min>100||!Number.isFinite(price)||price<=0)return res.status(400).json({error:'Проверьте ступень цены'});
      const rows=await supabaseFetch('payment_price_tiers',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({kind,min_quantity:min,unit_price:price,active:true})});return res.status(201).json(rows[0]);
    }
    if(req.method==='DELETE'&&operation==='tier'&&/^\d+$/.test(String(req.query.id||''))){await supabaseFetch(`payment_price_tiers?id=eq.${req.query.id}`,{method:'DELETE'});return res.status(204).end()}
    if(req.method==='POST'&&operation==='sync'){
      const rows=await supabaseFetch(`payment_orders?id=eq.${encodeURIComponent(req.body?.id)}&select=*&limit=1`);if(!rows[0]?.yookassa_payment_id)return res.status(404).json({error:'Платёж не найден'});
      const payment=await yookassa(`payments/${encodeURIComponent(rows[0].yookassa_payment_id)}`);await supabaseFetch(`payment_orders?id=eq.${rows[0].id}`,{method:'PATCH',body:JSON.stringify({provider_status:payment.status,...(payment.status==='succeeded'?{}:{status:payment.status}),updated_at:new Date().toISOString()})});await completeOrder(rows[0],payment);return res.json({status:payment.status});
    }
    return res.status(405).json({error:'Method not allowed'});
  }catch(error){return sendApiError(res,error)}
}

async function handleBoxPool(req,res){
  try{
    if(req.method==='GET'){
      const page=Math.max(0,Math.min(100000,Number.parseInt(req.query.page||'0',10)||0)),pageSize=100,from=page*pageSize,to=from+pageSize-1;
      const [total,available,used]=await Promise.all([
        supabaseFetchWithMeta('return_box_codes?select=code&limit=1',{headers:{Range:'0-0'}}),
        supabaseFetchWithMeta('return_box_codes?select=code&batch_id=is.null&order=code.asc&limit=1',{headers:{Range:'0-0'}}),
        supabaseFetchWithMeta(`return_box_codes?select=code,batch_id,allocated_at&batch_id=not.is.null&order=allocated_at.desc&offset=${from}&limit=${pageSize}`,{headers:{Range:`${from}-${to}`}}),
      ]);
      const last=await supabaseFetch('return_box_codes?select=code&batch_id=is.null&order=code.desc&limit=1');
      return res.status(200).json({total:total.count||0,available:available.count||0,used:used.count||0,start:available.data?.[0]?.code!=null?String(available.data[0].code):null,end:last?.[0]?.code!=null?String(last[0].code):null,recentUsed:(used.data||[]).map(row=>({code:String(row.code),batchId:row.batch_id,allocatedAt:row.allocated_at})),page,pageSize});
    }
    if(req.method==='POST'){
      const start=String(req.body?.start||'').trim(),end=String(req.body?.end||'').trim();
      if(!/^\d{1,12}$/.test(start)||!/^\d{1,12}$/.test(end))return res.status(400).json({error:'Начало и конец должны содержать от 1 до 12 цифр'});
      const first=BigInt(start),last=BigInt(end);if(last<first||last-first>100000n||last>1099511627775n)return res.status(400).json({error:'Диапазон должен содержать не более 100 001 номера'});
      const inserted=await supabaseFetch('rpc/add_return_box_range',{method:'POST',body:JSON.stringify({p_start:start,p_end:end})});
      await supabaseFetch(`return_box_codes?batch_id=is.null&or=(code.lt.${start},code.gt.${end})`,{method:'DELETE'});
      return res.status(200).json({start,end,inserted:Number(inserted||0)});
    }
    return res.status(405).json({error:'Method not allowed'});
  }catch(error){return sendApiError(res,error)}
}

async function handleStickerPool(req, res) {
  try {
    if (req.method === 'GET') {
      const page = Math.max(0, Math.min(100000, Number.parseInt(req.query.page || '0', 10) || 0));
      const pageSize = 100;
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const [total, available, used] = await Promise.all([
        supabaseFetchWithMeta('return_sticker_codes?select=code&limit=1', { headers: { Range: '0-0' } }),
        supabaseFetchWithMeta('return_sticker_codes?select=code&batch_id=is.null&order=code.asc&limit=1', { headers: { Range: '0-0' } }),
        supabaseFetchWithMeta(`return_sticker_codes?select=code,batch_id,allocated_at&batch_id=not.is.null&order=allocated_at.desc&offset=${from}&limit=${pageSize}`, { headers: { Range: `${from}-${to}` } }),
      ]);
      const lastAvailable = await supabaseFetch('return_sticker_codes?select=code&batch_id=is.null&order=code.desc&limit=1');
      return res.status(200).json({
        total: total.count || 0,
        available: available.count || 0,
        used: used.count || 0,
        start: available.data?.[0]?.code != null ? String(available.data[0].code) : null,
        end: lastAvailable?.[0]?.code != null ? String(lastAvailable[0].code) : null,
        recentUsed: (used.data || []).map((row) => ({
          code: String(row.code), batchId: row.batch_id, allocatedAt: row.allocated_at,
        })),
        page,
        pageSize,
      });
    }
    if (req.method === 'POST') {
      const start = String(req.body?.start || '').trim();
      const end = String(req.body?.end || '').trim();
      if (!/^\d{1,12}$/.test(start) || !/^\d{1,12}$/.test(end)) {
        return res.status(400).json({ error: 'Начало и конец должны содержать от 1 до 12 цифр' });
      }
      const startNumber = BigInt(start);
      const endNumber = BigInt(end);
      if (endNumber < startNumber || endNumber - startNumber > 100000n || endNumber > 1099511627775n) {
        return res.status(400).json({ error: 'Диапазон должен содержать не более 100 001 номера' });
      }
      const inserted = await supabaseFetch('rpc/add_return_sticker_range', {
        method: 'POST', body: JSON.stringify({ p_start: start, p_end: end }),
      });
      await supabaseFetch(`return_sticker_codes?batch_id=is.null&or=(code.lt.${start},code.gt.${end})`, { method: 'DELETE' });
      return res.status(200).json({ start, end, inserted: Number(inserted || 0) });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return sendApiError(res, error);
  }
}
