const { supabaseFetch } = require('../server/_supabase');
const { enforceRateLimit } = require('../server/_rate-limit');

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

module.exports = async function handler(req,res){
  const action=String(req.query.action||'');
  try{
    if(action==='activate'&&req.method==='POST'){
      if(!await enforceRateLimit(req,res,{scope:'cell-activate',limit:20,windowSeconds:300}))return;
      const key=String(req.body?.key||'').trim().toUpperCase();
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
