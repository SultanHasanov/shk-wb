const crypto=require('crypto');
const {requireAdmin}=require('./_admin-auth');
const {supabaseFetch}=require('./_supabase');
const {getAuthUser}=require('./_user-auth');
const {createNotification}=require('./_notifications');

module.exports=async function handler(req,res){
  if(!requireAdmin(req,res))return;
  const action=String(req.query.cabinet||'withdrawals');
  try{
    if(action==='withdrawals'&&req.method==='GET'){
      const rows=await supabaseFetch('referral_withdrawals?select=*&order=created_at.desc&limit=200');
      return res.json(rows);
    }
    if(action==='withdrawal'&&req.method==='PATCH'){
      const id=String(req.body?.id||''),status=String(req.body?.status||''),note=String(req.body?.note||'');
      if(!/^[0-9a-f-]{36}$/i.test(id)||!['approved','paid','rejected'].includes(status))return res.status(400).json({error:'Invalid request'});
      const fingerprint=crypto.createHash('sha256').update(String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'admin')).digest('hex').slice(0,24);
      const result=await supabaseFetch('rpc/process_referral_withdrawal',{method:'POST',body:JSON.stringify({p_withdrawal_id:id,p_status:status,p_admin_fingerprint:fingerprint,p_note:note})});return res.json(result);
    }
    if(action==='news'&&req.method==='POST'){
      const title=String(req.body?.title||'').trim(),body=String(req.body?.body||'').trim(),link=String(req.body?.link||'').trim()||null;
      if(!title||title.length>160||!body||body.length>2000)return res.status(400).json({error:'Заполните заголовок и текст'});
      let sent=0,offset=0;const campaign=crypto.randomUUID();
      while(true){
        const prefs=await supabaseFetch(`user_preferences?notify_product_news=eq.true&select=user_id&order=user_id.asc&offset=${offset}&limit=200`);
        if(!prefs.length)break;
        for(let i=0;i<prefs.length;i+=10){await Promise.all(prefs.slice(i,i+10).map(async pref=>{const user=await getAuthUser(pref.user_id);await createNotification({userId:pref.user_id,kind:'product_news',title,body,link,dedupeKey:`news:${campaign}`,email:user?.email?.endsWith('@users.invalid')?null:user?.email,emailEnabled:true});sent++;}));}
        offset+=prefs.length;if(prefs.length<200)break;
      }
      return res.status(201).json({sent,campaign});
    }
    return res.status(405).json({error:'Method not allowed'});
  }catch(error){console.error(error);return res.status(502).json({error:error.message||'Admin request failed'});}
};
