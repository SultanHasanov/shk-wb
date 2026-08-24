const { supabaseFetch } = require('./_supabase');

module.exports = async function handler(req,res){
  const action=String(req.query.action||'');
  try{
    if(action==='activate'&&req.method==='POST'){
      const key=String(req.body?.key||'').trim().toUpperCase();
      const deviceHash=String(req.body?.deviceHash||'').trim().toLowerCase();
      if(!/^CP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)||!/^[0-9a-f]{64}$/.test(deviceHash))return res.status(400).json({error:'Проверьте ключ и устройство'});
      try{return res.json(await supabaseFetch('rpc/activate_cell_print_license',{method:'POST',body:JSON.stringify({p_key:key,p_device_hash:deviceHash})}));}
      catch(error){const msg=String(error.details||error.message||'');if(msg.includes('expired'))return res.status(403).json({error:'Срок ключа истёк'});if(msg.includes('Device limit'))return res.status(409).json({error:'Достигнут лимит устройств'});return res.status(403).json({error:'Ключ недействителен или отозван'});}
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
