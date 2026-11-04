// Связка Telegram ↔ аккаунт сайта (user_telegram_identities) для серверных модулей и узла бота.
// api/auth.js делает ту же вставку своим клиентом Supabase (вход виджетом / Mini App) — формат строки общий.
const { supabaseFetch } = require('./_supabase');
const userCache = require('./_telegram-user-cache');

/** Аккаунт, к которому привязан этот Telegram (или null). */
async function findIdentity(telegramId) {
  const rows = await supabaseFetch(`user_telegram_identities?telegram_user_id=eq.${encodeURIComponent(telegramId)}&select=user_id,username,first_name&limit=1`);
  return rows[0] || null;
}

/** Telegram, привязанный к аккаунту (или null). У аккаунта одна связка — первая по updated_at. */
async function identityForUser(userId) {
  const rows = await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(userId)}&select=telegram_user_id,username,first_name&order=updated_at.desc&limit=1`);
  return rows[0] || null;
}

/** Привязать Telegram к аккаунту (upsert по telegram_user_id). Старая связка этого аккаунта с другим Telegram удаляется. */
async function saveIdentity(userId, telegram, { replace = false } = {}) {
  if (replace) {
    await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(userId)}&telegram_user_id=neq.${encodeURIComponent(telegram.id)}`, { method: 'DELETE' });
    userCache.forgetSiteUser(userId);
  }
  const rows = await supabaseFetch('user_telegram_identities?on_conflict=telegram_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      user_id: userId,
      telegram_user_id: Number(telegram.id),
      username: telegram.username || null,
      first_name: telegram.first_name || '',
      last_name: telegram.last_name || null,
      photo_url: telegram.photo_url || null,
      updated_at: new Date().toISOString(),
    }),
  });
  // Бот держит связку telegram → user_id в памяти; после привязки он должен увидеть её сразу.
  userCache.forgetTelegramUser(telegram.id);
  return rows;
}

function telegramLabel(identity) {
  if (!identity) return null;
  return identity.username ? `@${identity.username}` : identity.first_name || String(identity.telegram_user_id || '');
}

module.exports = { findIdentity, identityForUser, saveIdentity, telegramLabel };
