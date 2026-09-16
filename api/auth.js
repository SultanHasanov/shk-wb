const { validateTelegram, validateTelegramWebApp } = require('../server/_telegram-auth.cjs');
const { handleTelegramUpdate, notifyMiniAppAuthorized } = require('../server/_telegram-wb-bot');
const { accountHasValuableData, accountMergePreview } = require('../server/_telegram-account');
const { referralCookie } = require('../server/_user-auth');
const crypto = require('crypto');
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 20;
const attempts = new Map();

function config() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!url || !serviceKey || !publishableKey || !botToken) throw new Error('Auth environment variables are not configured');
  return { url, serviceKey, publishableKey, botToken };
}

function json(res, status, body) {
  res.status(status).json(body);
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

function localRateLimited(req) {
  const now = Date.now();
  const key = clientIp(req);
  const recent = (attempts.get(key) || []).filter(time => now - time < RATE_WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > RATE_LIMIT;
}

async function rateLimited(req) {
  const { botToken } = config();
  const limiterKey = crypto.createHmac('sha256', botToken).update(clientIp(req)).digest('hex');
  try {
    return Boolean(await request('/rest/v1/rpc/consume_auth_rate_limit', {
      method: 'POST', body: JSON.stringify({ p_key: limiterKey, p_limit: RATE_LIMIT, p_window_seconds: 60 }),
    }));
  } catch (error) {
    console.warn('Durable auth rate limit unavailable, using local fallback', error.message);
    return localRateLimited(req);
  }
}

async function request(path, options = {}, usePublishable = false) {
  const { url, serviceKey, publishableKey } = config();
  const key = usePublishable ? publishableKey : serviceKey;
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.msg || data.message || data.error_description || 'Supabase request failed');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function currentUser(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { url, publishableKey } = config();
  const response = await fetch(`${url}/auth/v1/user`, { headers: { apikey: publishableKey, Authorization: `Bearer ${token}` } });
  return response.ok ? response.json() : null;
}

async function findIdentity(telegramId) {
  const rows = await request(`/rest/v1/user_telegram_identities?telegram_user_id=eq.${telegramId}&select=user_id`);
  return rows[0] || null;
}

async function saveIdentity(userId, telegram) {
  return request('/rest/v1/user_telegram_identities?on_conflict=telegram_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      user_id: userId,
      telegram_user_id: telegram.id,
      username: telegram.username || null,
      first_name: telegram.first_name || '',
      last_name: telegram.last_name || null,
      photo_url: telegram.photo_url || null,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function relinkIdentity(userId, telegram) {
  const result = await request('/rest/v1/rpc/relink_telegram_identity', {
    method: 'POST',
    body: JSON.stringify({ p_telegram_user_id: telegram.id, p_target_user_id: userId }),
  });
  const details = result || {};
  await saveIdentity(userId, telegram);
  if (details.deleteSource && details.sourceUserId && details.sourceUserId !== userId) {
    // Связь уже перенесена транзакцией. Неудачное удаление оставит только
    // недоступную пустую auth-запись и не откатит рабочий кабинет пользователя.
    await request(`/auth/v1/admin/users/${details.sourceUserId}`, { method: 'DELETE' })
      .catch(error => console.warn('Unable to delete empty Telegram account', error.message));
  }
  return details;
}

async function mergeTelegramAccount(userId, telegram) {
  const details = await request('/rest/v1/rpc/merge_telegram_account', {
    method: 'POST',
    body: JSON.stringify({ p_telegram_user_id: telegram.id, p_target_user_id: userId }),
  });
  await saveIdentity(userId, telegram);
  if (details?.deleteSource && details.sourceUserId && details.sourceUserId !== userId) {
    await request(`/auth/v1/admin/users/${details.sourceUserId}`, { method: 'DELETE' })
      .catch(error => console.warn('Unable to delete merged Telegram account', error.message));
  }
  return details || {};
}

function maskedEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!name || !domain) return 'email-кабинет';
  return `${name.slice(0, 2)}***@${domain}`;
}

async function createTelegramUser(telegram) {
  const technicalEmail = `telegram-${telegram.id}@users.invalid`;
  const user = await request('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email: technicalEmail,
      email_confirm: true,
      user_metadata: {
        auth_source: 'telegram', telegram_id: String(telegram.id), username: telegram.username || null,
        full_name: [telegram.first_name, telegram.last_name].filter(Boolean).join(' '), avatar_url: telegram.photo_url || null,
      },
    }),
  });
  try {
    await saveIdentity(user.id, telegram);
    return { id: user.id, email: technicalEmail };
  } catch (error) {
    await request(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' }).catch(() => {});
    const identity = await findIdentity(telegram.id);
    if (!identity) throw error;
    return { id: identity.user_id, email: `telegram-${telegram.id}@users.invalid` };
  }
}

async function magicLink(email) {
  const result = await request('/auth/v1/admin/generate_link', {
    method: 'POST', body: JSON.stringify({ type: 'magiclink', email }),
  });
  const tokenHash = result.properties?.hashed_token || result.hashed_token;
  if (!tokenHash) throw new Error('Supabase did not return a token');
  return tokenHash;
}

module.exports = async function handler(req, res) {
  if (req.query?.action === 'bot') {
    if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'telegram-wb-bot' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return handleTelegramUpdate(req, res);
  }
  if (req.query?.action === 'referral') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
    const code = String(req.body?.code || '').trim().toUpperCase();
    // Нижняя граница 6: новые коды короче, ранее выданные 10-символьные ещё в ходу
    if (!/^[A-Z0-9]{6,16}$/.test(code)) return json(res, 400, { error: 'Некорректная реферальная ссылка', code: 'INVALID_REFERRAL_CODE' });
    try {
      const value = referralCookie(code);
      res.setHeader('Set-Cookie', `shk_ref=${encodeURIComponent(value)}; Max-Age=${30 * 86400}; Path=/; HttpOnly; SameSite=Lax; Secure`);
      return res.status(204).end();
    } catch (error) {
      console.error(error);
      return json(res, 500, { error: 'Реферальная программа не настроена', code: 'REFERRAL_NOT_CONFIGURED' });
    }
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (await rateLimited(req)) return json(res, 429, { error: 'Слишком много попыток. Повторите через минуту' });
  try {
    const input = req.body || {};
    const { botToken } = config();
    const webAppUser = validateTelegramWebApp(input.webAppData, botToken);
    const telegram = webAppUser ? { ...webAppUser, mode: input.mode } : input;
    if (!webAppUser && !validateTelegram(telegram, botToken)) return json(res, 401, { error: 'Не удалось подтвердить данные Telegram' });

    if (telegram.mode === 'status') {
      const identity = await findIdentity(telegram.id);
      if (!identity) return json(res, 200, { state: 'unlinked', canConnect: true });
      const source = await request(`/auth/v1/admin/users/${identity.user_id}`);
      const technical = /^telegram-[0-9]+@users[.]invalid$/i.test(String(source.email || ''));
      const hasData = await accountHasValuableData(identity.user_id);
      return json(res, 200, {
        state: hasData ? 'has_data' : technical ? 'empty_technical' : 'linked',
        canConnect: technical,
      });
    }

    if (telegram.mode === 'prepare_merge') {
      const user = await currentUser(req);
      if (!user?.email || user.email.endsWith('@users.invalid')) {
        return json(res, 401, { error: 'Войдите по электронной почте в основной кабинет' });
      }
      const existing = await findIdentity(telegram.id);
      const targetIdentity = await request(`/rest/v1/user_telegram_identities?user_id=eq.${encodeURIComponent(user.id)}&select=telegram_user_id&limit=1`);
      if (targetIdentity.length && Number(targetIdentity[0].telegram_user_id) !== Number(telegram.id)) {
        return json(res, 409, { error: 'К основному кабинету уже привязан другой Telegram', code: 'TARGET_ACCOUNT_HAS_TELEGRAM' });
      }
      if (!existing || existing.user_id === user.id) {
        return json(res, 200, {
          action: 'relink', targetEmail: maskedEmail(user.email),
          summary: { orders: 0, history: 0, licenses: 0, codes: 0, generations: 0 },
        });
      }
      const source = await request(`/auth/v1/admin/users/${existing.user_id}`);
      if (!/^telegram-[0-9]+@users[.]invalid$/i.test(String(source.email || ''))) {
        return json(res, 409, { error: 'Текущий кабинет имеет собственный вход по почте. Для объединения обратитесь в поддержку.', code: 'SOURCE_ACCOUNT_NOT_TECHNICAL' });
      }
      const summary = await accountMergePreview(existing.user_id);
      if (summary.financialConflict) {
        return json(res, 409, { error: 'В текущем кабинете есть реферальные деньги или выплаты. Такое объединение выполнит поддержка.', code: 'TELEGRAM_ACCOUNT_FINANCIAL_CONFLICT' });
      }
      const { financialConflict, ...publicSummary } = summary;
      return json(res, 200, { action: 'merge', targetEmail: maskedEmail(user.email), summary: publicSummary });
    }

    if (telegram.mode === 'link') {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: 'Сначала войдите в аккаунт' });
      const existing = await findIdentity(telegram.id);
      if (existing && existing.user_id !== user.id) return json(res, 409, { error: 'Этот Telegram уже привязан к другому аккаунту' });
      await saveIdentity(user.id, telegram);
      return json(res, 200, { linked: true });
    }

    if (telegram.mode === 'relink') {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: 'Сначала войдите в кабинет с покупкой' });
      if (!user.email || user.email.endsWith('@users.invalid')) {
        return json(res, 400, { error: 'Войдите по электронной почте в кабинет с покупкой' });
      }
      await relinkIdentity(user.id, telegram);
      await notifyMiniAppAuthorized(telegram.id).catch(error => console.warn('Unable to notify relinked Telegram user', error.message));
      return json(res, 200, { linked: true, relinked: true });
    }

    if (telegram.mode === 'merge') {
      const user = await currentUser(req);
      if (!user?.email || user.email.endsWith('@users.invalid')) {
        return json(res, 401, { error: 'Сначала войдите в основной кабинет' });
      }
      const details = await mergeTelegramAccount(user.id, telegram);
      await notifyMiniAppAuthorized(telegram.id).catch(error => console.warn('Unable to notify merged Telegram user', error.message));
      return json(res, 200, { linked: true, merged: true, ...details });
    }

    let identity = await findIdentity(telegram.id);
    let account;
    if (identity) {
      const user = await request(`/auth/v1/admin/users/${identity.user_id}`);
      account = { id: user.id, email: user.email };
      await saveIdentity(user.id, telegram);
    } else {
      account = await createTelegramUser(telegram);
    }
    const tokenHash = await magicLink(account.email);
    if (webAppUser) await notifyMiniAppAuthorized(telegram.id).catch(error => console.warn('Unable to notify Telegram Mini App user', error.message));
    return json(res, 200, { token_hash: tokenHash });
  } catch (error) {
    console.error('Telegram auth failed', error.message);
    if (String(error.message).includes('TELEGRAM_ACCOUNT_NOT_EMPTY')) {
      return json(res, 409, { error: 'В текущем Telegram-кабинете уже есть данные. Напишите в поддержку — мы безопасно объединим кабинеты.', code: 'TELEGRAM_ACCOUNT_NOT_EMPTY' });
    }
    if (String(error.message).includes('TELEGRAM_ACCOUNT_FINANCIAL_CONFLICT')) {
      return json(res, 409, { error: 'В текущем кабинете есть реферальные деньги или выплаты. Обратитесь в поддержку для ручной сверки.', code: 'TELEGRAM_ACCOUNT_FINANCIAL_CONFLICT' });
    }
    if (String(error.message).includes('SOURCE_ACCOUNT_NOT_TECHNICAL')) {
      return json(res, 409, { error: 'Автоматически объединить можно только кабинет, созданный через Telegram', code: 'SOURCE_ACCOUNT_NOT_TECHNICAL' });
    }
    if (String(error.message).includes('TARGET_ACCOUNT_HAS_TELEGRAM')) {
      return json(res, 409, { error: 'К этому кабинету уже привязан другой Telegram', code: 'TARGET_ACCOUNT_HAS_TELEGRAM' });
    }
    if (String(error.message).includes('TARGET_ACCOUNT_')) {
      return json(res, 400, { error: 'Войдите по электронной почте в подтверждённый кабинет', code: 'INVALID_TARGET_ACCOUNT' });
    }
    return json(res, 500, { error: 'Не удалось выполнить вход через Telegram' });
  }
};
