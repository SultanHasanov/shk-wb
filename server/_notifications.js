const { supabaseFetch } = require('./_supabase');

async function createNotification({ userId, kind, title, body = '', link = null, dedupeKey, email, emailEnabled = true }) {
  const rows = await supabaseFetch('in_app_notifications?on_conflict=user_id,dedupe_key', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ user_id:userId, kind, title, body, link, dedupe_key:dedupeKey }),
  });
  const notification = Array.isArray(rows) ? rows[0] : null;
  if (notification && email && emailEnabled) await sendEmail({ userId, notificationId:notification.id, to:email, subject:title, text:body, dedupeKey:`email:${dedupeKey}` });
  return notification;
}

async function sendEmail({ userId, notificationId, to, subject, text, dedupeKey }) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) return null;
  let delivery;
  try {
    const rows = await supabaseFetch('notification_deliveries', {
      method:'POST', headers:{ Prefer:'return=representation' },
      body:JSON.stringify({ user_id:userId, notification_id:notificationId, recipient:to, dedupe_key:dedupeKey, attempts:1 }),
    });
    delivery=rows[0];
  } catch (error) {
    if (error.status===409) return null;
    throw error;
  }
  try {
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.RESEND_FROM_EMAIL,to:[to],subject,text})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(result.message||'Resend request failed');
    await supabaseFetch(`notification_deliveries?id=eq.${delivery.id}`,{method:'PATCH',body:JSON.stringify({status:'sent',provider_id:result.id||null,sent_at:new Date().toISOString()})});
    return result.id||null;
  } catch(error) {
    await supabaseFetch(`notification_deliveries?id=eq.${delivery.id}`,{method:'PATCH',body:JSON.stringify({status:'failed',last_error:String(error.message||error).slice(0,1000)})}).catch(()=>{});
    return null;
  }
}

module.exports={createNotification,sendEmail};
