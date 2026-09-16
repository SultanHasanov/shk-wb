const crypto=require('crypto');
const {requireAdmin}=require('./_admin-auth');
const {supabaseFetch,supabaseFetchWithMeta}=require('./_supabase');
const {getAuthUser}=require('./_user-auth');
const {createNotification}=require('./_notifications');
const {sendMessage}=require('./_telegram-api');

function escapeHtml(value){return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function personalize(template,subscriber){
  const firstName=subscriber.first_name||'';
  const values={
    name:firstName||subscriber.username||'друг',
    first_name:firstName,
    last_name:subscriber.last_name||'',
    username:subscriber.username?`@${subscriber.username}`:'',
  };
  return template.replace(/[&<>]|\{(name|first_name|last_name|username)\}/g,(match,key)=>key?escapeHtml(values[key]):escapeHtml(match));
}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function sendBroadcastMessage(subscriber,text,button,url){
  const options=button&&url?{reply_markup:{inline_keyboard:[[{text:button,url}]]}}:{};
  try{return await sendMessage(subscriber.chat_id,personalize(text,subscriber),options)}
  catch(error){
    const retryAfter=Number(error.details?.parameters?.retry_after||0);
    if(error.status===429&&retryAfter>0){await delay(Math.min(retryAfter,10)*1000);return sendMessage(subscriber.chat_id,personalize(text,subscriber),options)}
    throw error;
  }
}

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
    if(action==='telegram-audience'&&req.method==='GET'){
      const [all,active]=await Promise.all([
        supabaseFetchWithMeta('telegram_bot_subscribers?select=telegram_user_id&limit=1',{headers:{Range:'0-0'}}),
        supabaseFetchWithMeta('telegram_bot_subscribers?blocked_at=is.null&select=telegram_user_id&limit=1',{headers:{Range:'0-0'}}),
      ]);
      const activated=all.count||0,available=active.count||0;
      return res.json({activated,available,blocked:activated-available});
    }
    if(action==='telegram-broadcast'&&req.method==='POST'){
      const text=String(req.body?.text||'').trim();
      const button=String(req.body?.button||'').trim();
      const url=String(req.body?.url||'').trim();
      if(!text||text.length>3500)return res.status(400).json({error:'Введите текст до 3500 символов'});
      if((button&&!url)||(!button&&url)||button.length>64)return res.status(400).json({error:'Для кнопки нужны подпись и ссылка'});
      if(url){try{const parsed=new URL(url);if(parsed.protocol!=='https:')throw new Error()}catch{return res.status(400).json({error:'Укажите корректную https-ссылку'})}}
      let sent=0,failed=0,blocked=0,total=0,lastTelegramId=null;
      while(true){
        const cursor=lastTelegramId==null?'':`&telegram_user_id=gt.${lastTelegramId}`;
        const subscribers=await supabaseFetch(`telegram_bot_subscribers?blocked_at=is.null${cursor}&select=telegram_user_id,chat_id,username,first_name,last_name&order=telegram_user_id.asc&limit=200`);
        if(!subscribers.length)break;
        total+=subscribers.length;
        lastTelegramId=subscribers[subscribers.length-1].telegram_user_id;
        for(let offset=0;offset<subscribers.length;offset+=20){
          const results=await Promise.all(subscribers.slice(offset,offset+20).map(async subscriber=>{
          try{
            await sendBroadcastMessage(subscriber,text,button,url);
            await supabaseFetch(`telegram_bot_subscribers?telegram_user_id=eq.${subscriber.telegram_user_id}`,{method:'PATCH',body:JSON.stringify({last_broadcast_at:new Date().toISOString()})});
            return 'sent';
          }catch(error){
            const unavailable=error.status===403||/blocked|chat not found|deactivated/i.test(String(error.message||''));
            if(unavailable)await supabaseFetch(`telegram_bot_subscribers?telegram_user_id=eq.${subscriber.telegram_user_id}`,{method:'PATCH',body:JSON.stringify({blocked_at:new Date().toISOString()})}).catch(()=>{});
            return unavailable?'blocked':'failed';
          }
          }));
          for(const result of results){if(result==='sent')sent++;else if(result==='blocked')blocked++;else failed++}
          if(offset+20<subscribers.length)await delay(750);
        }
        if(subscribers.length<200)break;
      }
      return res.status(201).json({sent,failed,blocked,total});
    }
    return res.status(405).json({error:'Method not allowed'});
  }catch(error){console.error(error);return res.status(502).json({error:error.message||'Admin request failed'});}
};
