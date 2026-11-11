const crypto=require('crypto');
const {requireAdmin}=require('./_admin-auth');
const {supabaseFetch,supabaseFetchWithMeta}=require('./_supabase');
const {getAuthUser}=require('./_user-auth');
const {createNotification,sendEmail,emailConfigured}=require('./_notifications');
const {deleteMessage}=require('./_telegram-api');
// Общие помощники рассылок живут в _admin-messages.js (ими же пользуется «Написать» в карточке).
const {personalize,delay,sendWithRetry}=require('./_admin-messages');
// Журнал и ключ повтора — модуль целиком: функции берутся в момент вызова.
const grants=require('./_admin-grants');

// До этой даты бот слал постоянную (reply) клавиатуру; у активировавших бота раньше она висит до сих пор,
// пока не придёт сообщение с remove_keyboard (семикнопочная ушла 20.10.2026, двухкнопочная — 26.10.2026).
const LEGACY_KEYBOARD_BEFORE='2026-10-27T00:00:00Z';
// Под каждой рассылкой — «☰ Меню» (callback menu:home обрабатывает _telegram-wb-bot.js): без кнопок человек
// отвечает на рассылку текстом, а бот такой ответ не понимает. n:<callback> — меню откроется новым сообщением,
// а рассылка останется в чате (server/_bot-notice.js).
const MENU_BUTTON={text:'☰ Меню',callback_data:require('./_bot-notice').noticeData('menu:home')};
/**
 * У сообщения один reply_markup, поэтому снятие старой клавиатуры и инлайн-кнопка в одном сообщении невозможны.
 * При removeKeyboard сначала уходит служебное сообщение с remove_keyboard и тут же удаляется (клавиатура остаётся
 * снятой), а затем — само сообщение с кнопками: ссылкой админа (если задана) и «☰ Меню».
 */
async function sendBroadcastMessage(subscriber,text,button,url,removeKeyboard=false){
  if(removeKeyboard){
    const service=await sendWithRetry(subscriber.chat_id,'Меню обновлено',{reply_markup:{remove_keyboard:true}});
    if(service?.message_id)await deleteMessage(subscriber.chat_id,service.message_id).catch(()=>{});
  }
  const inline=[...(button&&url?[[{text:button,url}]]:[]),[MENU_BUTTON]];
  return sendWithRetry(subscriber.chat_id,personalize(text,subscriber),{reply_markup:{inline_keyboard:inline}});
}

// Рассылка идёт минутами, а «зависший» ключ повтора через 120 с можно забрать заново: пока рассылка с этим
// ключом идёт в этом процессе (selfhost — один процесс), повтор получает 409, а не второй круг.
const running=new Set();

/**
 * Строки доставки рассылки (notification_deliveries, source 'broadcast', ключ bc:<кампания>:<telegram_user_id>)
 * ставятся ДО отправки каждой пачки: повтор с тем же ключом (после ошибки или перезапуска) пропускает тех,
 * до кого рассылка уже дошла или могла дойти (pending), и шлёт только оставшимся. Неудачные (failed)
 * повтор забирает заново; у заблокировавших бота строка удаляется — их исключает blocked_at подписчика.
 */
function broadcastKey(campaign,telegramUserId){return `bc:${campaign}:${telegramUserId}`}
function quotedList(values){return values.map(value=>`"${String(value).replace(/"/g,'')}"`).join(',')}
async function claimBroadcastRecipients(subscribers,{campaign,subject,actionId}){
  if(!subscribers.length)return new Map();
  const rows=subscribers.map(subscriber=>({
    user_id:null,channel:'telegram',recipient:String(subscriber.chat_id),
    channel_ref:subscriber.username?`@${subscriber.username}`:`tg:${subscriber.telegram_user_id}`,
    subject,source:'broadcast',admin_action_id:actionId||null,
    dedupe_key:broadcastKey(campaign,subscriber.telegram_user_id),attempts:1,status:'pending',
  }));
  const inserted=await supabaseFetch('notification_deliveries?on_conflict=dedupe_key',{
    method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify(rows),
  });
  const claimed=new Map((Array.isArray(inserted)?inserted:[]).map(row=>[row.dedupe_key,row.id]));
  const conflicts=rows.map(row=>row.dedupe_key).filter(key=>!claimed.has(key));
  if(conflicts.length){
    // Повтор рассылки: строки уже есть. Забираем только неудачные; sent и pending (могло дойти) пропускаем.
    const retried=await supabaseFetch(`notification_deliveries?dedupe_key=in.(${quotedList(conflicts)})&status=eq.failed`,{
      method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({status:'pending',last_error:null}),
    });
    for(const row of Array.isArray(retried)?retried:[])claimed.set(row.dedupe_key,row.id);
  }
  return claimed;
}
async function settleBroadcastClaims(outcomes){
  const now=new Date().toISOString();
  const ids=status=>outcomes.filter(item=>item.status===status&&item.deliveryId).map(item=>item.deliveryId);
  const sentIds=ids('sent'),blockedIds=ids('blocked');
  const reached=outcomes.filter(item=>item.status==='sent').map(item=>item.subscriber.telegram_user_id);
  const log=label=>error=>console.error(`broadcast ${label} failed`,error.message);
  await Promise.all([
    sentIds.length&&supabaseFetch(`notification_deliveries?id=in.(${sentIds.join(',')})`,{method:'PATCH',body:JSON.stringify({status:'sent',sent_at:now})}).catch(log('sent update')),
    ...outcomes.filter(item=>item.status==='failed'&&item.deliveryId).map(item=>supabaseFetch(`notification_deliveries?id=eq.${item.deliveryId}`,{method:'PATCH',body:JSON.stringify({status:'failed',last_error:item.error||'Telegram не принял сообщение'})}).catch(log('failed update'))),
    blockedIds.length&&supabaseFetch(`notification_deliveries?id=in.(${blockedIds.join(',')})`,{method:'DELETE'}).catch(log('blocked cleanup')),
    reached.length&&supabaseFetch(`telegram_bot_subscribers?telegram_user_id=in.(${reached.join(',')})`,{method:'PATCH',body:JSON.stringify({last_broadcast_at:now})}).catch(log('last_broadcast_at')),
  ]);
}

function reasonOf(req){const value=String(req.body?.reason||'').trim();return value?value.slice(0,500):null}
function keyOf(req){const value=String(req.body?.idempotencyKey||'').trim();return value||null}

/**
 * Действие с журналом: с ключом повтора — через runIdempotent (повтор отдаёт тот же ответ), без ключа — как раньше,
 * и после успеха строка admin_actions. work → { status, body, payload, before?, after? }.
 */
async function journaled(req,res,{action,key,userId=null,payload},work){
  const reason=reasonOf(req);
  if(key){
    const slot=`${action}:${key}`;
    if(running.has(slot))return res.status(409).json({error:'Запрос уже выполняется',code:'IN_PROGRESS'});
    running.add(slot);
    try{
      return await grants.runIdempotent(req,res,{action,key,userId,payload},async ctx=>({...(await work(ctx||{})),reason}));
    }finally{running.delete(slot)}
  }
  const done=await work({actionId:null});
  await grants.recordAdminAction(req,action,userId,done.payload||payload,{before:done.before??null,after:done.after??null,reason});
  return res.status(done.status).json(done.body);
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
      const fingerprint=grants.adminFingerprint(req);
      const current=await supabaseFetch(`referral_withdrawals?id=eq.${id}&select=status,user_id,amount_kopecks&limit=1`).catch(()=>[]);
      const result=await supabaseFetch('rpc/process_referral_withdrawal',{method:'POST',body:JSON.stringify({p_withdrawal_id:id,p_status:status,p_admin_fingerprint:fingerprint,p_note:note})});
      await grants.recordAdminAction(req,'processWithdrawal',current[0]?.user_id||null,{withdrawalId:id,amountKopecks:current[0]?.amount_kopecks??null},{before:current[0]?{status:current[0].status}:null,after:{status,note},reason:reasonOf(req)});
      return res.json(result);
    }
    if(action==='news'&&req.method==='POST'){
      const title=String(req.body?.title||'').trim(),body=String(req.body?.body||'').trim(),link=String(req.body?.link||'').trim()||null;
      if(!title||title.length>160||!body||body.length>2000)return res.status(400).json({error:'Заполните заголовок и текст'});
      const key=keyOf(req);
      // С ключом повтора кампания = ключ: dedupe_key уведомления тот же, повтор никому не пришлёт новость второй раз.
      const campaign=key||crypto.randomUUID();
      return journaled(req,res,{action:'sendNews',key,payload:{title,campaign}},async({actionId})=>{
        let sent=0,emails=0,offset=0;
        // Письмо — отдельно от уведомления и с ключом на пользователя: dedupe_key строк доставки уникален на всю
        // таблицу, общий `email:news:<кампания>` пропустил бы письмо всем, кроме первого подписчика.
        const notifyOne=async pref=>{
          const user=await getAuthUser(pref.user_id);
          const notification=await createNotification({userId:pref.user_id,kind:'product_news',title,body,link,dedupeKey:`news:${campaign}`,email:null});
          const address=user?.email&&!String(user.email).endsWith('@users.invalid')?String(user.email):null;
          const mail=address?await sendEmail({userId:pref.user_id,notificationId:notification?.id||null,to:address,subject:title,text:body,dedupeKey:`email:news:${campaign}:${pref.user_id}`,source:'broadcast',adminActionId:actionId||null}):null;
          if(mail?.status==='sent')emails++;
          if(notification||mail?.status==='sent')sent++;
        };
        while(true){
          const prefs=await supabaseFetch(`user_preferences?notify_product_news=eq.true&select=user_id&order=user_id.asc&offset=${offset}&limit=200`);
          if(!prefs.length)break;
          for(let i=0;i<prefs.length;i+=10){await Promise.all(prefs.slice(i,i+10).map(notifyOne));}
          offset+=prefs.length;if(prefs.length<200)break;
        }
        return {status:201,body:{sent,emails,emailConfigured:emailConfigured(),campaign},payload:{title,campaign,sent,emails},after:{sent,emails}};
      });
    }
    if(action==='telegram-audience'&&req.method==='GET'){
      const [all,active,legacyRows]=await Promise.all([
        supabaseFetchWithMeta('telegram_bot_subscribers?select=telegram_user_id&limit=1',{headers:{Range:'0-0'}}),
        supabaseFetchWithMeta('telegram_bot_subscribers?blocked_at=is.null&select=telegram_user_id&limit=1',{headers:{Range:'0-0'}}),
        supabaseFetchWithMeta(`telegram_bot_subscribers?blocked_at=is.null&activated_at=lt.${LEGACY_KEYBOARD_BEFORE}&select=telegram_user_id&limit=1`,{headers:{Range:'0-0'}}),
      ]);
      const activated=all.count||0,available=active.count||0,legacy=legacyRows.count||0;
      return res.json({activated,available,blocked:activated-available,legacy,legacyBefore:LEGACY_KEYBOARD_BEFORE});
    }
    if(action==='telegram-broadcast'&&req.method==='POST'){
      const text=String(req.body?.text||'').trim();
      const button=String(req.body?.button||'').trim();
      const url=String(req.body?.url||'').trim();
      if(!text||text.length>3500)return res.status(400).json({error:'Введите текст до 3500 символов'});
      if((button&&!url)||(!button&&url)||button.length>64)return res.status(400).json({error:'Для кнопки нужны подпись и ссылка'});
      if(url){try{const parsed=new URL(url);if(parsed.protocol!=='https:')throw new Error()}catch{return res.status(400).json({error:'Укажите корректную https-ссылку'})}}
      const removeKeyboard=req.body?.removeKeyboard===true;
      const onlyLegacy=req.body?.onlyLegacy===true;
      const legacyFilter=onlyLegacy?`&activated_at=lt.${LEGACY_KEYBOARD_BEFORE}`:'';
      const preview={textPreview:text.slice(0,200),onlyLegacy,removeKeyboard};
      const key=keyOf(req);
      // С ключом повтора кампания = ключ: повтор продолжит рассылку с тех, до кого она ещё не дошла.
      const campaign=key||crypto.randomUUID();
      const subject=text.slice(0,200);
      return journaled(req,res,{action:'sendTelegramBroadcast',key,payload:{...preview,campaign}},async({actionId})=>{
        let sent=0,failed=0,blocked=0,total=0,alreadySent=0,lastTelegramId=null;
        while(true){
          const cursor=lastTelegramId==null?'':`&telegram_user_id=gt.${lastTelegramId}`;
          const subscribers=await supabaseFetch(`telegram_bot_subscribers?blocked_at=is.null${legacyFilter}${cursor}&select=telegram_user_id,chat_id,username,first_name,last_name&order=telegram_user_id.asc&limit=200`);
          if(!subscribers.length)break;
          total+=subscribers.length;
          lastTelegramId=subscribers[subscribers.length-1].telegram_user_id;
          for(let offset=0;offset<subscribers.length;offset+=20){
            const chunk=subscribers.slice(offset,offset+20);
            // Сбой постановки строк бросает до отправки этой пачки: повтор с тем же ключом продолжит с неё.
            const claimed=await claimBroadcastRecipients(chunk,{campaign,subject,actionId});
            const targets=chunk.filter(subscriber=>claimed.has(broadcastKey(campaign,subscriber.telegram_user_id)));
            alreadySent+=chunk.length-targets.length;
            const outcomes=await Promise.all(targets.map(async subscriber=>{
              const deliveryId=claimed.get(broadcastKey(campaign,subscriber.telegram_user_id));
              try{
                await sendBroadcastMessage(subscriber,text,button,url,removeKeyboard);
                return {subscriber,deliveryId,status:'sent'};
              }catch(error){
                const unavailable=error.status===403||/blocked|chat not found|deactivated/i.test(String(error.message||''));
                if(unavailable)await supabaseFetch(`telegram_bot_subscribers?telegram_user_id=eq.${subscriber.telegram_user_id}`,{method:'PATCH',body:JSON.stringify({blocked_at:new Date().toISOString()})}).catch(()=>{});
                return {subscriber,deliveryId,status:unavailable?'blocked':'failed',error:String(error.message||error).slice(0,300)};
              }
            }));
            await settleBroadcastClaims(outcomes);
            for(const {status} of outcomes){if(status==='sent')sent++;else if(status==='blocked')blocked++;else failed++}
            if(targets.length&&offset+20<subscribers.length)await delay(750);
          }
          if(subscribers.length<200)break;
        }
        const totals={sent,failed,blocked,total,alreadySent};
        return {status:201,body:totals,payload:{...preview,campaign,...totals},after:totals};
      });
    }
    return res.status(405).json({error:'Method not allowed'});
  }catch(error){
    if(error?.status>=400&&error.status<500&&error.code)return res.status(error.status).json({error:error.message,code:error.code,...(error.extra||{})});
    console.error(error);return res.status(502).json({error:error.message||'Admin request failed'});
  }
};
