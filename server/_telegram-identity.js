// Связка Telegram ↔ аккаунт сайта (user_telegram_identities) для серверных модулей и узла бота.
// api/auth.js делает ту же вставку своим клиентом Supabase (вход виджетом / Mini App) — формат строки общий.
const { supabaseFetch } = require('./_supabase');
const userCache = require('./_telegram-user-cache');
const { fetchWithRetry } = require('./_fetch-retry');
const { accountHasValuableData } = require('./_telegram-account');

function technicalEmail(telegramId) { return `telegram-${Number(telegramId)}@users.invalid`; }

async function authAdmin(pathname, options = {}) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase environment variables are not configured');
  const response = await fetchWithRetry(`${url}/auth/v1/admin${pathname}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  }, { retries: 0, label: 'supabase auth' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.msg || data.message || data.error_description || `Supabase auth request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

/**
 * Кабинет для этого Telegram: существующая связка, иначе технический аккаунт telegram-<id>@users.invalid —
 * такой же, какой создаёт вход через Mini App (api/auth.js). Бот зовёт это при первом действии, чтобы
 * баланс, покупки и отзывы работали без входа на сайт; привязать настоящий кабинет можно потом из профиля.
 * Возвращает { userId, created }.
 */
async function ensureTechnicalAccount(telegram) {
  const existing = await findIdentity(telegram.id);
  if (existing) return { userId: existing.user_id, created: false };
  const email = technicalEmail(telegram.id);
  let userId = null;
  try {
    const user = await authAdmin('/users', {
      method: 'POST',
      body: JSON.stringify({
        email, email_confirm: true,
        user_metadata: {
          auth_source: 'telegram', telegram_id: String(telegram.id), username: telegram.username || null,
          full_name: [telegram.first_name, telegram.last_name].filter(Boolean).join(' '), avatar_url: telegram.photo_url || null,
        },
      }),
    });
    userId = user.id;
  } catch (error) {
    // Почта уже занята: аккаунт был создан раньше (например, связку отвязали в кабинете) — находим его по почте.
    if (error.status !== 422 && error.status !== 400) throw error;
    userId = await supabaseFetch('rpc/auth_user_id_by_email', { method: 'POST', body: JSON.stringify({ p_email: email }) });
    if (!userId) throw error;
  }
  try {
    await saveIdentity(userId, telegram);
  } catch (error) {
    // Гонка: связка появилась параллельно (вход через сайт) — берём её, свежесозданный пустой аккаунт удаляем.
    const identity = await findIdentity(telegram.id);
    if (!identity) throw error;
    if (identity.user_id !== userId) await authAdmin(`/users/${userId}`, { method: 'DELETE' }).catch(() => {});
    return { userId: identity.user_id, created: false };
  }
  return { userId, created: true };
}

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

// RPC с текстом исключения базы в message: вызывающие (api/auth.js, админка, бот) различают исходы
// по подстрокам TELEGRAM_ACCOUNT_NOT_EMPTY, TARGET_ACCOUNT_HAS_TELEGRAM, MERGE_BUSY… — как раньше,
// когда api/auth.js ходил в Supabase своим клиентом.
async function identityRpc(name, body) {
  try {
    return await supabaseFetch(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    const details = error.details && typeof error.details === 'object' ? error.details : {};
    const message = details.message || details.msg || details.error_description;
    if (!message) throw error;
    const wrapped = new Error(message);
    wrapped.status = error.status;
    wrapped.code = details.code;
    wrapped.details = error.details;
    throw wrapped;
  }
}

/**
 * Удалить технический аккаунт после перепривязки/объединения. true — удалён (или попытка удаления
 * сделана), false — оставлен.
 * Связь уже перенесена транзакцией. Неудачное удаление оставит только недоступную auth-запись
 * и не откатит рабочий аккаунт пользователя.
 * Перед удалением — свежая сводка: списание или начисление на исходный аккаунт, ждавшее замка счёта
 * во время слияния, после него заново создаёт счёт (wallet_move: insert … on conflict do nothing)
 * с деньгами, и удаление унесло бы их каскадом. Непустой аккаунт (и при сбое проверки) не удаляем —
 * остаток переносит поддержка вручную: повторное слияние его уже не найдёт, Telegram привязан к основному.
 */
async function deleteSourceAccount(sourceUserId, label) {
  let valuable;
  try {
    valuable = await accountHasValuableData(sourceUserId);
  } catch (error) {
    console.warn(label, `check of ${sourceUserId} failed, account kept:`, error.message);
    return false;
  }
  if (valuable) {
    console.warn(label, `account ${sourceUserId} is not empty after the move, kept for manual review`);
    return false;
  }
  await authAdmin(`/users/${encodeURIComponent(sourceUserId)}`, { method: 'DELETE' })
    .catch(error => console.warn(label, error.message));
  userCache.forgetSiteUser(sourceUserId);
  return true;
}

/**
 * Перепривязать Telegram к аккаунту сайта (rpc relink_telegram_identity). Технический аккаунт бота
 * удаляется, только если он пуст (иначе TELEGRAM_ACCOUNT_NOT_EMPTY — нужно объединение).
 * telegram — { id, username?, first_name?, last_name?, photo_url? }. Возвращает ответ RPC.
 */
async function relinkIdentity(userId, telegram) {
  const result = await identityRpc('relink_telegram_identity', { p_telegram_user_id: telegram.id, p_target_user_id: userId });
  const details = result || {};
  await saveIdentity(userId, telegram);
  if (details.deleteSource && details.sourceUserId && details.sourceUserId !== userId) {
    if (!await deleteSourceAccount(details.sourceUserId, 'Unable to delete empty Telegram account')) details.sourceKept = true;
  }
  return details;
}

/**
 * Объединить технический аккаунт бота с аккаунтом сайта (rpc merge_telegram_account): баланс, покупки,
 * подписки и ПК переходят к userId, исходный аккаунт удаляется. Возвращает ответ RPC
 * (movedWalletKopecks, movedSubscriptions, movedDevices…).
 */
async function mergeTelegramAccount(userId, telegram) {
  const details = (await identityRpc('merge_telegram_account', { p_telegram_user_id: telegram.id, p_target_user_id: userId })) || {};
  await saveIdentity(userId, telegram);
  if (details.deleteSource && details.sourceUserId && details.sourceUserId !== userId) {
    if (!await deleteSourceAccount(details.sourceUserId, 'Unable to delete merged Telegram account')) details.sourceKept = true;
  }
  return details;
}

module.exports = {
  ensureTechnicalAccount, findIdentity, identityForUser, mergeTelegramAccount, relinkIdentity, saveIdentity,
  technicalEmail, telegramLabel,
};
