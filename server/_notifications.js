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

const NOT_CONFIGURED_ERROR = 'Почта не настроена: нет RESEND_API_KEY или RESEND_FROM_EMAIL';

function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

/** Само письмо через Resend, без строки доставки (её ведут вызывающие). Возвращает id письма у Resend. */
async function resendSend({ to, subject, text }) {
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.RESEND_FROM_EMAIL,to:[to],subject,text})});
  const result=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(result.message||'Resend request failed');
  return result.id||null;
}

function emailResult(status, { providerId = null, deliveryId = null, error = null } = {}) {
  return { status, providerId, deliveryId, error };
}

/**
 * Письмо через Resend со строкой в notification_deliveries.
 * Возвращает итог: sent | failed | not_configured | duplicate (повтор dedupeKey — 409 при вставке).
 * Без Resend строку пишем только при recordUnconfigured (админка показывает «почта не настроена»),
 * старые вызовы (createNotification, оплаты, рассылки) её не пишут — как раньше.
 */
async function sendEmail({ userId, notificationId, to, subject, text, dedupeKey, source = 'system', adminActionId = null, recordUnconfigured = false }) {
  const configured = emailConfigured();
  const base = {
    user_id: userId || null,
    notification_id: notificationId || null,
    recipient: to,
    dedupe_key: dedupeKey,
    attempts: 1,
    subject: subject ? String(subject).slice(0, 200) : null,
    source,
    admin_action_id: adminActionId || null,
  };
  if (!configured) {
    if (!recordUnconfigured) return emailResult('not_configured', { error: NOT_CONFIGURED_ERROR });
    try {
      const rows = await supabaseFetch('notification_deliveries', {
        method:'POST', headers:{ Prefer:'return=representation' },
        body:JSON.stringify({ ...base, channel:'email', status:'not_configured', last_error:NOT_CONFIGURED_ERROR }),
      });
      return emailResult('not_configured', { deliveryId: rows?.[0]?.id || null, error: NOT_CONFIGURED_ERROR });
    } catch (error) {
      if (error.status===409) return emailResult('duplicate');
      throw error;
    }
  }
  let delivery;
  try {
    const rows = await supabaseFetch('notification_deliveries', {
      method:'POST', headers:{ Prefer:'return=representation' },
      body:JSON.stringify(base),
    });
    delivery=rows[0];
  } catch (error) {
    if (error.status===409) return emailResult('duplicate');
    throw error;
  }
  try {
    const providerId=await resendSend({ to, subject, text });
    await supabaseFetch(`notification_deliveries?id=eq.${delivery.id}`,{method:'PATCH',body:JSON.stringify({status:'sent',provider_id:providerId,sent_at:new Date().toISOString()})});
    return emailResult('sent', { providerId, deliveryId: delivery.id });
  } catch(error) {
    const message=String(error.message||error).slice(0,1000);
    await supabaseFetch(`notification_deliveries?id=eq.${delivery.id}`,{method:'PATCH',body:JSON.stringify({status:'failed',last_error:message})}).catch(()=>{});
    return emailResult('failed', { deliveryId: delivery.id, error: message });
  }
}

module.exports={createNotification,sendEmail,resendSend,emailConfigured,NOT_CONFIGURED_ERROR};
