const { supabaseFetch } = require('../server/_supabase');
const { enforceRateLimit } = require('../server/_rate-limit');
const { requireUser } = require('../server/_user-auth');
const { publicOrigin } = require('../server/_origin');
const account = require('../server/_app-account');
const cellPrintLink = require('../server/_cell-print-link');

// error.details — это распарсенный ответ PostgREST ({code,message,...}), а не строка.
// String() от объекта давал «[object Object]», поэтому проверки ниже не срабатывали
// никогда и «Достигнут лимит устройств» показывалось как «Ключ недействителен».
function activationMessage(error){
  const detail=error.details&&typeof error.details==='object'?String(error.details.message||''):String(error.details||'');
  return detail||String(error.message||'');
}
// Ошибки, которые база подняла осмысленно. Всё остальное — сбой вызова, а не отказ.
function isLicenseVerdict(msg){return /expired|Device limit|Invalid license|Invalid device/.test(msg);}
function activationFailure(res,error){
  const msg=activationMessage(error);
  if(msg.includes('expired'))return res.status(403).json({error:'Срок ключа истёк'});
  if(msg.includes('Device limit'))return res.status(409).json({error:'Достигнут лимит устройств'});
  return res.status(403).json({error:'Ключ недействителен или отозван'});
}
// Вход в «Печать ячеек» 2.x аккаунтом сайта. Те же сессии Supabase и та же страница
// подтверждения /app-login, что у «Помощника ПВЗ», но без регистрации ПК в подписке
// Помощника: у ключей «Печати ячеек» свой учёт компьютеров (cell_print_activations).
const HEX64=/^[0-9a-f]{64}$/;
function accountError(res,error){
  if(error.code&&error.status)return res.status(error.status).json({error:error.message,code:error.code});
  console.error(error);return res.status(502).json({error:'Сервис временно недоступен'});
}
// Новые версии «Печати ячеек» присылают deviceHash при входе и refresh. Регистрируем
// ПК в реестре аккаунта (кабинет его покажет и сможет отозвать); отозванный → 401
// DEVICE_REVOKED. Старые версии deviceHash не шлют — для них вход не меняется.
async function registerLoginDevice(session,body){
  const deviceHash=String(body.deviceHash||'').toLowerCase();
  if(!HEX64.test(deviceHash))return;
  const userId=session&&session.user&&session.user.id;
  if(!userId)return;
  await cellPrintLink.touchDevice(userId,deviceHash,body.deviceName,body.appVersion);
}
async function accountAction(action,req,res){
  const body=req.body&&typeof req.body==='object'?req.body:{};
  if(action==='login'&&req.method==='POST'){
    const login=String(body.email||'').trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)||!body.password)return res.status(400).json({error:'Введите почту и пароль',code:'VALIDATION_ERROR'});
    if(!await enforceRateLimit(req,res,{scope:'cell-login',limit:10,windowSeconds:600}))return;
    if(!await enforceRateLimit(req,res,{scope:'cell-login-email',limit:10,windowSeconds:600,key:login}))return;
    const session=await account.passwordLogin(login,String(body.password));
    await registerLoginDevice(session,body);
    return res.json({session:account.sessionPayload(session)});
  }
  if(action==='login-start'&&req.method==='POST'){
    if(!await enforceRateLimit(req,res,{scope:'cell-login-start',limit:10,windowSeconds:600}))return;
    const deviceHash=String(body.deviceHash||'').toLowerCase();
    if(!HEX64.test(deviceHash))return res.status(400).json({error:'Обновите программу',code:'DEVICE_REQUIRED'});
    // Метка программы в app_version — по ней страница /app-login пишет «Печать ячеек».
    const {code,secret}=await account.startBrowserLogin(deviceHash,body.deviceName,`cell-print/${String(body.appVersion||'').slice(0,16)}`);
    return res.status(201).json({code,secret,url:`${publicOrigin(req)}/app-login?code=${code}`,expiresIn:600});
  }
  if(action==='login-poll'&&req.method==='POST'){
    if(!await enforceRateLimit(req,res,{scope:'cell-login-poll',limit:200,windowSeconds:600}))return;
    const code=account.normalizeLoginCode(body.code);
    if(!code||!body.secret)return res.status(400).json({error:'Некорректный запрос',code:'VALIDATION_ERROR'});
    const result=await account.pollBrowserLogin(code,String(body.secret));
    if(result.status==='pending')return res.status(202).json({status:'pending'});
    await registerLoginDevice(result.session,body);
    return res.json({session:account.sessionPayload(result.session)});
  }
  if(action==='refresh'&&req.method==='POST'){
    if(!await enforceRateLimit(req,res,{scope:'cell-refresh',limit:60,windowSeconds:600}))return;
    if(!body.refreshToken)return res.status(400).json({error:'Нет сессии',code:'VALIDATION_ERROR'});
    const session=await account.refreshSession(String(body.refreshToken));
    await registerLoginDevice(session,body);
    return res.json({session:account.sessionPayload(session)});
  }
  const user=await requireUser(req,res);
  if(!user)return;
  if(action==='keys'&&req.method==='GET'){
    const device=String(req.query.device||'').toLowerCase();
    const rows=await supabaseFetch(`cell_print_licenses?owner_user_id=eq.${encodeURIComponent(user.id)}&select=key,marketplace_scope,expires_at,duration_days,device_limit,active,activated_at,created_at,cell_print_activations(device_hash)&order=created_at.desc`);
    const email=String(user.email||'');
    return res.json({
      email:email.endsWith('@users.invalid')?'Вход через Telegram':email,
      items:rows.map(r=>({
        key:r.key,scope:r.marketplace_scope||'legacy_unassigned',expiresAt:r.expires_at,durationDays:r.duration_days,
        deviceLimit:r.device_limit,devicesUsed:(r.cell_print_activations||[]).length,active:r.active!==false,
        thisDevice:HEX64.test(device)&&(r.cell_print_activations||[]).some(a=>a.device_hash===device),
      })),
    });
  }
  if(action==='claim'&&req.method==='POST'){
    const key=String(body.key||'').trim().toUpperCase();
    if(!/^CP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key))return res.status(400).json({error:'Проверьте ключ',code:'VALIDATION_ERROR'});
    try{await supabaseFetch('rpc/claim_user_asset',{method:'POST',body:JSON.stringify({p_user_id:user.id,p_kind:'cell_print',p_value:key})});}
    catch(error){return res.status(409).json({error:'Ключ уже привязан к другому аккаунту',code:'KEY_TAKEN'});}
    return res.json({ok:true});
  }
  if(action==='logout'&&req.method==='POST'){
    await account.logout(user._accessToken);
    return res.status(204).end();
  }
  return res.status(404).json({error:'Not found',code:'NOT_FOUND'});
}

// Привязка ПК к аккаунту: /api/cell-print/account/{link|devices|revoke}. Логика — в
// server/_cell-print-link.js; здесь только авторизация, лимит и маршрут по sub.
async function accountLinkAction(req,res){
  const sub=String(req.query.sub||'');
  const user=await requireUser(req,res);
  if(!user)return;
  const body=req.body&&typeof req.body==='object'?req.body:{};
  if(sub==='link'&&req.method==='POST'){
    if(!await enforceRateLimit(req,res,{scope:'cell-link',limit:30,windowSeconds:600}))return;
    if(!versionAtLeast(body.appVersion,'1.5.0'))return res.status(426).json({error:'Требуется обновление программы до версии 1.5.0',code:'UPDATE_REQUIRED'});
    return res.json(await cellPrintLink.linkDevice({
      user:user.id,
      deviceHash:String(body.deviceHash||'').toLowerCase(),
      legacyHash:body.legacyHash?String(body.legacyHash).toLowerCase():null,
      key:body.key?String(body.key).trim().toUpperCase():null,
      deviceName:body.deviceName,
      appVersion:body.appVersion,
      buyUrl:`${publicOrigin(req)}/cell-print#key`,
    }));
  }
  if(sub==='devices'&&req.method==='GET')return res.json(await cellPrintLink.listDevices(user.id));
  if(sub==='revoke'&&req.method==='POST'){
    await cellPrintLink.revokeDevice(user.id,String(body.deviceHash||'').toLowerCase());
    return res.json({ok:true});
  }
  return res.status(404).json({error:'Not found',code:'NOT_FOUND'});
}

function versionTuple(value){return String(value||'0').split('.').map(x=>Number(x)||0);}
function versionAtLeast(value,minimum){const a=versionTuple(value),b=versionTuple(minimum);for(let i=0;i<Math.max(a.length,b.length);i++){if((a[i]||0)!==(b[i]||0))return(a[i]||0)>(b[i]||0);}return true;}

module.exports = async function handler(req,res){
  const action=String(req.query.action||'');
  if(['login','login-start','login-poll','refresh','keys','claim','logout'].includes(action)){
    try{return await accountAction(action,req,res);}catch(error){return accountError(res,error);}
  }
  if(action==='account'){try{return await accountLinkAction(req,res);}catch(error){return accountError(res,error);}}
  try{
    if(action==='activate'&&req.method==='POST'){
      if(!await enforceRateLimit(req,res,{scope:'cell-activate',limit:20,windowSeconds:300}))return;
      const key=String(req.body?.key||'').trim().toUpperCase();
      if(!versionAtLeast(req.body?.appVersion,'1.5.0'))return res.status(426).json({error:'Требуется обновление программы до версии 1.5.0'});
      const deviceHash=String(req.body?.deviceHash||'').trim().toLowerCase();
      const legacyHash=String(req.body?.legacyDeviceHash||'').trim().toLowerCase();
      if(!/^CP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)||!/^[0-9a-f]{64}$/.test(deviceHash))return res.status(400).json({error:'Проверьте ключ и устройство'});
      if(legacyHash&&!/^[0-9a-f]{64}$/.test(legacyHash))return res.status(400).json({error:'Проверьте ключ и устройство'});
      const body={p_key:key,p_device_hash:deviceHash};
      if(legacyHash&&legacyHash!==deviceHash)body.p_legacy_hash=legacyHash;
      const call=payload=>supabaseFetch('rpc/activate_cell_print_license',{method:'POST',body:JSON.stringify(payload)});
      try{return res.json(await call(body));}
      catch(error){
        // База может быть ещё без параметра переноса отпечатка: такой вызов падает не
        // отказом по лицензии, а ошибкой поиска функции — тогда зовём по-старому.
        if(body.p_legacy_hash&&!isLicenseVerdict(activationMessage(error))){
          try{return res.json(await call({p_key:key,p_device_hash:deviceHash}));}
          catch(retry){return activationFailure(res,retry);}
        }
        return activationFailure(res,error);
      }
    }
    if(action==='feed'&&req.method==='GET'){
      const [announcements,releases]=await Promise.all([
        supabaseFetch('cell_print_announcements?select=id,text,url,button,level,starts_at,ends_at,created_at&active=eq.true&order=id.desc&limit=20'),
        supabaseFetch('cell_print_releases?select=version,minimum_version,download_url,notes,mandatory,updated_at&id=eq.true&limit=1')]);
      const now=Date.now(),visible=announcements.filter(x=>(!x.starts_at||Date.parse(x.starts_at)<=now)&&(!x.ends_at||Date.parse(x.ends_at)>=now)).slice(0,5);
      return res.json({announcements:visible,release:releases[0]||null});
    }
    return res.status(405).json({error:'Method not allowed'});
  }catch(error){console.error(error);return res.status(502).json({error:'Сервис временно недоступен'});}
};
