const crypto = require('crypto');
const {
  clearSessionCookie, createSessionCookie, getRequiredEnv,
  isAuthenticated, requireAdmin, safeEqual,
} = require('../_admin-auth');
const { sendApiError, supabaseFetch, supabaseFetchWithMeta } = require('../_supabase');
const { hasYookassa, yookassa, completeOrder, PACKAGE_PRICES } = require('../_payments');

const RESOURCES = {
  key: {
    table: 'license_keys',
    toDb(body) {
      const out = {};
      if ('key' in body) out.key = body.key;
      if ('limit' in body) out.usage_limit = body.limit;
      if ('used' in body) out.used = body.used;
      if ('active' in body) out.active = body.active;
      if ('note' in body) out.note = body.note;
      if ('createdAt' in body) out.created_at = body.createdAt;
      return out;
    },
    fromDb(row) {
      return {
        id: row.id, key: row.key, limit: row.usage_limit, used: row.used,
        active: row.active, note: row.note, createdAt: row.created_at,
      };
    },
  },
  message: {
    table: 'announcements',
    toDb(body) {
      const out = {};
      for (const field of ['text', 'url', 'button', 'active']) {
        if (field in body) out[field] = body[field];
      }
      if ('createdAt' in body) out.created_at = body.createdAt;
      return out;
    },
    fromDb(row) {
      return {
        id: row.id, text: row.text, url: row.url, button: row.button,
        active: row.active, createdAt: row.created_at,
      };
    },
  },
  stickerAccess: {
    table: 'sticker_access_codes',
    toDb(body) {
      const out = {};
      if ('name' in body) out.name = String(body.name || '').trim();
      if ('active' in body) out.active = Boolean(body.active);
      if ('rangeLimit' in body) out.range_generation_limit = Number(body.rangeLimit);
      if ('customLimit' in body) out.custom_generation_limit = Number(body.customLimit);
      if ('boxRangeLimit' in body) out.box_range_generation_limit = Number(body.boxRangeLimit);
      if ('boxCustomLimit' in body) out.box_custom_generation_limit = Number(body.boxCustomLimit);
      return out;
    },
    fromDb(row) {
      return {
        id: row.id, code: row.code, name: row.name, active: row.active,
        rangeLimit: row.range_generation_limit, rangeUsed: row.range_generation_used,
        customLimit: row.custom_generation_limit, customUsed: row.custom_generation_used,
        boxRangeLimit:row.box_range_generation_limit,boxRangeUsed:row.box_range_generation_used,
        boxCustomLimit:row.box_custom_generation_limit,boxCustomUsed:row.box_custom_generation_used,
        createdAt: row.created_at,
      };
    },
  },
  programPromo: {
    table: 'program_promocodes',
    toDb(body) {
      const out = {};
      if ('code' in body) out.code = String(body.code || '').trim().toUpperCase();
      if ('limit' in body) out.usage_limit = Number(body.limit);
      if ('active' in body) out.active = Boolean(body.active);
      if ('note' in body) out.note = String(body.note || '').trim();
      return out;
    },
    fromDb(row) { return {id:row.id,code:row.code,limit:row.usage_limit,used:row.used,active:row.active,note:row.note,createdAt:row.created_at}; },
  },
  cellLicense:{table:'cell_print_licenses',toDb(body){const out={};if('durationDays'in body)out.duration_days=Number(body.durationDays);if('deviceLimit'in body)out.device_limit=Number(body.deviceLimit);if('active'in body)out.active=Boolean(body.active);if('note'in body)out.note=String(body.note||'').trim();if('source'in body)out.source=body.source;return out;},fromDb(r){return{id:r.id,key:r.key,durationDays:r.duration_days,deviceLimit:r.device_limit,active:r.active,activatedAt:r.activated_at,expiresAt:r.expires_at,note:r.note,createdAt:r.created_at};}},
  cellActivation:{table:'cell_print_activations',toDb(){return{};},fromDb(r){return{id:r.id,licenseId:r.license_id,deviceHash:r.device_hash,firstSeenAt:r.first_seen_at,lastSeenAt:r.last_seen_at};}},
  cellPromo:{table:'cell_print_promocodes',toDb(body){const out={};if('code'in body)out.code=String(body.code||'').trim().toUpperCase();if('discount'in body)out.discount_percent=Number(body.discount);if('scope'in body)out.scope=body.scope;if('limit'in body)out.usage_limit=Number(body.limit);if('expiresAt'in body)out.expires_at=body.expiresAt||null;if('active'in body)out.active=Boolean(body.active);if('note'in body)out.note=String(body.note||'').trim();return out;},fromDb(r){return{id:r.id,code:r.code,discount:r.discount_percent,scope:r.scope,limit:r.usage_limit,used:r.used,expiresAt:r.expires_at,active:r.active,note:r.note};}},
  cellAnnouncement:{table:'cell_print_announcements',toDb(body){const out={};for(const f of ['text','url','button','level','active'])if(f in body)out[f]=body[f];if('startsAt'in body)out.starts_at=body.startsAt||null;if('endsAt'in body)out.ends_at=body.endsAt||null;return out;},fromDb(r){return{id:r.id,text:r.text,url:r.url,button:r.button,level:r.level,startsAt:r.starts_at,endsAt:r.ends_at,active:r.active};}},
  cellRelease:{table:'cell_print_releases',toDb(body){const out={};if('version'in body)out.version=body.version;if('minimumVersion'in body)out.minimum_version=body.minimumVersion;if('downloadUrl'in body)out.download_url=body.downloadUrl;if('notes'in body)out.notes=body.notes;if('mandatory'in body)out.mandatory=Boolean(body.mandatory);out.updated_at=new Date().toISOString();return out;},fromDb(r){return{id:r.id,version:r.version,minimumVersion:r.minimum_version,downloadUrl:r.download_url,notes:r.notes,mandatory:r.mandatory};}},
};

function validateStickerAccess(body, creating) {
  if (creating || 'name' in body) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 120) return 'Введите имя';
  }
  for (const field of ['rangeLimit', 'customLimit','boxRangeLimit','boxCustomLimit']) {
    if (creating || field in body) {
      const value = Number(body[field]);
      if (!Number.isInteger(value) || value < 0 || value > 100000) return 'Лимиты должны быть целыми числами от 0 до 100000';
    }
  }
  return '';
}

function validateProgramPromo(body, creating) {
  if (creating || 'code' in body) if(!/^[A-Z0-9_-]{3,32}$/.test(String(body.code||'').trim().toUpperCase())) return 'Код: 3–32 латинские буквы, цифры, _ или -';
  if (creating || 'limit' in body) { const limit=Number(body.limit); if(!Number.isInteger(limit)||limit<1||limit>100000)return 'Лимит должен быть от 1 до 100000'; }
  if ('note' in body && String(body.note||'').trim().length>200)return 'Пометка слишком длинная';
  return '';
}

module.exports = async function handler(req, res) {
  if (req.query.auth === 'login') return handleLogin(req, res);
  if (req.query.auth === 'logout') return handleLogout(req, res);
  if (req.query.auth === 'session') return handleSession(req, res);
  if (!requireAdmin(req, res)) return;
  if (req.query.resource === 'stickerPool') return handleStickerPool(req, res);
  if (req.query.resource === 'boxPool') return handleBoxPool(req, res);
  if (req.query.resource === 'paymentAdmin') return handlePaymentAdmin(req, res);
  if (req.query.resource === 'stats') return handleStats(req, res);
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
      if(req.query.resource==='cellLicense'){
        const days=Number(req.body?.durationDays),devices=Number(req.body?.deviceLimit);if(![3,7,30,90,180,365].includes(days)||![1,2,3,5,10,20].includes(devices))return res.status(400).json({error:'Выберите срок и число устройств'});
        for(let attempt=0;attempt<12;attempt++){const part=()=>crypto.randomBytes(3).toString('hex').slice(0,4).toUpperCase(),key=`CP-${part()}-${part()}-${part()}`;try{const rows=await supabaseFetch(config.table,{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({key,source:'admin',...config.toDb(req.body||{})})});return res.status(201).json(config.fromDb(rows[0]));}catch(error){if(error.status!==409)throw error;}}
      }
      if (req.query.resource === 'programPromo') { const validationError=validateProgramPromo(req.body||{},true); if(validationError)return res.status(400).json({error:validationError}); }
      if (req.query.resource === 'stickerAccess') {
        const validationError = validateStickerAccess(req.body || {}, true);
        if (validationError) return res.status(400).json({ error: validationError });
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
          try {
            const rows = await supabaseFetch(config.table, {
              method: 'POST', headers: { Prefer: 'return=representation' },
              body: JSON.stringify({ code, range_usage_mode: 'sticker', ...config.toDb(req.body || {}) }),
            });
            return res.status(201).json(config.fromDb(rows[0]));
          } catch (error) {
            if (error.status !== 409) throw error;
          }
        }
        throw new Error('Could not generate a unique access code');
      }
      const rows = await supabaseFetch(config.table, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(config.toDb(req.body || {})),
      });
      return res.status(201).json(config.fromDb(rows[0]));
    }
    if (req.method === 'PATCH' && id) {
      if (req.query.resource === 'programPromo') {
        const validationError=validateProgramPromo(req.body||{},false);if(validationError)return res.status(400).json({error:validationError});
        if('limit' in req.body){const current=await supabaseFetch(`${config.table}?id=eq.${id}&select=used&limit=1`);if(!current.length)return res.status(404).json({error:'Промокод не найден'});if(Number(req.body.limit)<Number(current[0].used))return res.status(400).json({error:'Лимит не может быть меньше числа использований'});}
      }
      if (req.query.resource === 'stickerAccess') {
        const validationError = validateStickerAccess(req.body || {}, false);
        if (validationError) return res.status(400).json({ error: validationError });
        const current = await supabaseFetch(`${config.table}?id=eq.${id}&select=range_generation_used,custom_generation_used,box_range_generation_used,box_custom_generation_used`);
        if (!current.length) return res.status(404).json({ error: 'Not found' });
        if ('rangeLimit' in req.body && Number(req.body.rangeLimit) < current[0].range_generation_used) return res.status(400).json({ error: 'Лимит стикеров не может быть меньше уже использованного количества' });
        if ('customLimit' in req.body && Number(req.body.customLimit) < current[0].custom_generation_used) return res.status(400).json({ error: 'Лимит генераций по номеру не может быть меньше использованного' });
        if ('boxRangeLimit' in req.body && Number(req.body.boxRangeLimit) < current[0].box_range_generation_used) return res.status(400).json({ error:'Лимит QR коробок не может быть меньше использованного' });
        if ('boxCustomLimit' in req.body && Number(req.body.boxCustomLimit) < current[0].box_custom_generation_used) return res.status(400).json({ error:'Лимит QR коробок по номеру не может быть меньше использованного' });
      }
      const rows = await supabaseFetch(`${config.table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(config.toDb(req.body || {})),
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

function handleLogin(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  let configuredPassword;
  try {
    configuredPassword = getRequiredEnv('ADMIN_PASSWORD');
    getRequiredEnv('ADMIN_SESSION_SECRET');
  } catch (error) {
    console.error(error.message);
    return res.status(500).json({ error: 'Server is not configured' });
  }
  const password = req.body && req.body.password;
  if (typeof password !== 'string' || !safeEqual(password, configuredPassword)) {
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
      const payment=await yookassa(`payments/${encodeURIComponent(rows[0].yookassa_payment_id)}`);await supabaseFetch(`payment_orders?id=eq.${rows[0].id}`,{method:'PATCH',body:JSON.stringify({status:payment.status,updated_at:new Date().toISOString()})});await completeOrder(rows[0],payment);return res.json({status:payment.status});
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
