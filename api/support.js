const { enforceRateLimit } = require('../server/_rate-limit');
const { supabaseFetch } = require('../server/_supabase');

const TOPICS = new Set(['Оплата и возврат','Ключ и активация','Настройка печати','Не приходит код доступа','Другое']);

async function sendSupportEmail(request) {
  if (!process.env.RESEND_API_KEY || !process.env.SUPPORT_EMAIL_FROM || !process.env.SUPPORT_EMAIL_TO) return;
  const response = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({from:process.env.SUPPORT_EMAIL_FROM,to:[process.env.SUPPORT_EMAIL_TO],reply_to:request.email,subject:`Поддержка: ${request.topic}`,text:`Имя: ${request.name}\nEmail: ${request.email}\n\n${request.message}`}),
  });
  if (!response.ok) throw new Error(`Support email failed (${response.status})`);
}

module.exports = async function handler(req,res) {
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  if(!await enforceRateLimit(req,res,{scope:'support',limit:5,windowSeconds:3600}))return;
  const name=String(req.body?.name||'').trim(),email=String(req.body?.email||'').trim().toLowerCase();
  const topic=String(req.body?.topic||'').trim(),message=String(req.body?.message||'').trim();
  if(String(req.body?.website||'').trim())return res.status(202).json({ok:true});
  if(name.length<2||name.length>120||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!TOPICS.has(topic)||message.length<20||message.length>5000||req.body?.consent!==true)return res.status(400).json({error:'Проверьте поля обращения'});
  try{
    const rows=await supabaseFetch('support_requests',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({name,email,topic,message})});
    await sendSupportEmail({name,email,topic,message}).catch(error=>console.error(error.message));
    return res.status(201).json({ok:true,id:rows[0]?.id});
  }catch(error){console.error(error.message,error.details||'');return res.status(502).json({error:'Не удалось отправить обращение. Напишите нам в Telegram или попробуйте позже.'});}
};
