// Вход на сайт через Яндекс ID (OAuth 2.0) и через VK ID (OAuth 2.1 с PKCE; на экране VK ID — VK, ОК, Mail, QR).
//
// Схема та же, что у входа через Telegram (api/auth.js): сервер находит или создаёт пользователя
// Supabase, выписывает magic-link token_hash, а браузер обменивает его на сессию (auth.verifyOtp).
//
//   GET /api/auth/oauth/providers           → { providers: ['yandex', 'vkid'] } — что настроено в .env
//   GET /api/auth/oauth/:provider/start     → 302 к провайдеру; state подписан, nonce в cookie shk_oauth
//   GET /api/auth/oauth/:provider/callback  → обмен code → профиль → аккаунт → 302 /auth/oauth?token_hash=…
//
// Привязка к текущему кабинету (Профиль → «Способы входа»): start с ?mode=link и Bearer-токеном отвечает
// JSON { url } (fetch не умеет 302 на чужой домен), в state уезжает id пользователя; callback тогда не ищет
// аккаунт по почте, а просто сохраняет связку и возвращает на /cabinet/profile?oauth=linked.
// Чужая связка (этот Яндекс уже у другого кабинета) → /cabinet/profile?oauth=error&reason=taken.
//
// Аккаунт ищется по связке (provider, id) в user_oauth_identities, затем по почте провайдера
// (rpc auth_user_id_by_email), иначе создаётся с настоящей почтой (email_confirm: провайдер её подтвердил).
// Google намеренно не подключён.
const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { authConfig, optionalUser } = require('./_user-auth');
const { siteForRequest } = require('./_sites');

const STATE_TTL_SEC = 10 * 60;
const COOKIE = 'shk_oauth';
const SAFE_NEXT = /^\/[a-z0-9/_-]{0,80}(\?[a-z0-9=&_-]{0,80})?$/i;

const PROVIDERS = {
  yandex: {
    title: 'Яндекс ID',
    authorize: 'https://oauth.yandex.ru/authorize',
    token: 'https://oauth.yandex.ru/token',
    scope: 'login:email login:info login:avatar',
    env: ['YANDEX_OAUTH_CLIENT_ID', 'YANDEX_OAUTH_CLIENT_SECRET'],
    async profile(accessToken) {
      const response = await fetch('https://login.yandex.ru/info?format=json', { headers: { Authorization: `OAuth ${accessToken}` } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.id) throw new Error(`Yandex profile failed (${response.status})`);
      const avatar = data.is_avatar_empty === false && data.default_avatar_id
        ? `https://avatars.yandex.net/get-yapic/${data.default_avatar_id}/islands-200`
        : null;
      return {
        id: String(data.id),
        email: String(data.default_email || (Array.isArray(data.emails) ? data.emails[0] : '') || '').trim().toLowerCase() || null,
        name: String(data.real_name || data.display_name || data.login || '').trim(),
        avatar,
      };
    },
  },
  // Mail.ru: прямой OAuth Mail с 1 июля 2025 «только для продуктовых запросов» (новые приложения из o2.mail.ru/app
  // отвечают «bad client»), поэтому Mail, ОК и VK идут одной кнопкой через VK ID: id.vk.ru/authorize (общий экран;
  // ?via=mail_ru|ok_ru в start принудительно открывает конкретный способ),
  // PKCE (code_verifier в cookie рядом с nonce), обмен на id.vk.ru/oauth2/auth с service_token, профиль — oauth2/user_info.
  vkid: {
    title: 'VK ID',
    authorize: 'https://id.vk.ru/authorize',
    token: 'https://id.vk.ru/oauth2/auth',
    scope: 'email',
    env: ['VKID_APP_ID', 'VKID_SERVICE_TOKEN'],
    pkce: true,
    viaProviders: ['mail_ru', 'ok_ru'],
    async exchange({ code, deviceId, verifier, state, redirect }) {
      const { clientId, clientSecret } = credentials('vkid');
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, device_id: deviceId,
        redirect_uri: redirect, state, service_token: clientSecret,
      });
      const response = await fetch(this.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.access_token) throw new Error(`vkid token exchange failed (${response.status}) ${data.error || ''} ${data.error_description || ''}`.trim());
      return data.access_token;
    },
    async profile(accessToken) {
      const { clientId } = credentials('vkid');
      const response = await fetch('https://id.vk.ru/oauth2/user_info', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, access_token: accessToken }).toString(),
      });
      const data = await response.json().catch(() => ({}));
      const user = data.user;
      if (!response.ok || !user?.user_id) throw new Error(`vkid profile failed (${response.status}) ${data.error || ''}`.trim());
      // Без почты аккаунт не сопоставить: пишем, какие поля пришли (без значений), чтобы видеть, выключен ли доступ email в приложении.
      if (!user.email) console.warn(`[oauth:vkid] user_info без email; поля: ${Object.keys(user).join(",")}`);
      return {
        id: String(user.user_id),
        email: String(user.email || '').trim().toLowerCase() || null,
        name: [user.first_name, user.last_name].filter(Boolean).join(' ').trim(),
        avatar: user.avatar || null,
      };
    },
  },
};

function origin(req) {
  return siteForRequest(req).origin || String(process.env.PUBLIC_APP_URL || 'https://shk-wb.ru').replace(/\/$/, '');
}

function credentials(provider) {
  const spec = PROVIDERS[provider];
  if (!spec) return null;
  const [idKey, secretKey] = spec.env;
  const clientId = String(process.env[idKey] || '').trim();
  const clientSecret = String(process.env[secretKey] || '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function configuredProviders() {
  return Object.keys(PROVIDERS).filter(provider => credentials(provider));
}

/** Адрес возврата зависит от сайта: его нужно добавить в настройки приложений Яндекса и VK ID. */
function redirectUri(provider, req) {
  return `${origin(req)}/api/auth/oauth/${provider}/callback`;
}

function stateSecret() {
  const secret = process.env.OAUTH_STATE_SECRET || process.env.STICKER_CLIENT_SECRET;
  if (!secret) throw new Error('OAUTH_STATE_SECRET is not configured');
  return secret;
}

function sign(raw) {
  return crypto.createHmac('sha256', stateSecret()).update(raw).digest('base64url');
}

function makeState({ provider, next, nonce, linkUserId = null }) {
  const payload = { p: provider, n: next, t: Math.floor(Date.now() / 1000), r: nonce };
  if (linkUserId) payload.u = linkUserId;
  const raw = Buffer.from(JSON.stringify(payload)).toString('base64url');
  // VK ID пускает в state только [A-Za-z0-9_-]: подпись (43 символа base64url) приклеена без разделителя.
  return `${raw}${sign(raw)}`;
}

const SIGNATURE_LENGTH = 43;

function readState(value) {
  const text = String(value || '');
  if (text.length <= SIGNATURE_LENGTH) return null;
  const raw = text.slice(0, -SIGNATURE_LENGTH);
  const signature = text.slice(-SIGNATURE_LENGTH);
  const expected = sign(raw);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (Number(payload.t) < Math.floor(Date.now() / 1000) - STATE_TTL_SEC) return null;
  return payload;
}

/** cookie shk_oauth = nonce, для PKCE-провайдеров — nonce.code_verifier */
function readCookie(req) {
  const match = String(req.headers.cookie || '').match(/(?:^|;s*)shk_oauth=([^;]+)/);
  if (!match) return { nonce: null, verifier: null };
  const [nonce, verifier] = decodeURIComponent(match[1]).split('.');
  return { nonce: nonce || null, verifier: verifier || null };
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function cookieHeader(value, maxAge) {
  return `${COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Secure`;
}

function safeNext(value) {
  const next = String(value || '').trim();
  return SAFE_NEXT.test(next) && !next.startsWith('//') ? next : '/cabinet';
}

function redirect(res, location, cookie) {
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.setHeader('Cache-Control', 'no-store');
  res.status(302);
  res.setHeader('Location', location);
  res.end();
}

function failRedirect(res, reason, cookie) {
  redirect(res, `/?auth=login&oauth=error&reason=${encodeURIComponent(reason)}`, cookie);
}

async function exchangeCode(provider, code, req) {
  const spec = PROVIDERS[provider];
  const { clientId, clientSecret } = credentials(provider);
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri(provider, req),
  });
  const response = await fetch(spec.token, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: body.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(`${provider} token exchange failed (${response.status}) ${data.error || ''}`.trim());
  return data.access_token;
}

// --- аккаунт в Supabase -----------------------------------------------------------------------

async function authAdmin(path, { method = 'GET', body } = {}) {
  const { url, serviceKey } = authConfig();
  const response = await fetch(`${url}/auth/v1/admin/${path}`, {
    method,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.msg || data.message || data.error_description || `Auth admin request failed (${response.status})`);
    error.status = response.status;
    error.authCode = data.error_code || null;
    throw error;
  }
  return data;
}

async function findIdentity(provider, providerUserId) {
  const rows = await supabaseFetch(
    `user_oauth_identities?provider=eq.${encodeURIComponent(provider)}&provider_user_id=eq.${encodeURIComponent(providerUserId)}&select=user_id&limit=1`,
  );
  return rows?.[0]?.user_id || null;
}

async function identitiesForUser(userId) {
  const rows = await supabaseFetch(`user_oauth_identities?user_id=eq.${encodeURIComponent(userId)}&select=provider,email,display_name,updated_at&order=updated_at.desc`);
  return Array.isArray(rows) ? rows : [];
}

async function saveIdentity(provider, profile, userId) {
  await supabaseFetch('user_oauth_identities?on_conflict=provider,provider_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      provider, provider_user_id: profile.id, user_id: userId,
      email: profile.email, display_name: profile.name || null, avatar_url: profile.avatar || null, updated_at: new Date().toISOString(),
    }),
  });
}

async function unlinkIdentity(userId, provider) {
  await supabaseFetch(`user_oauth_identities?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(provider)}`, { method: 'DELETE' });
}

async function userIdByEmail(email) {
  if (!email) return null;
  const id = await supabaseFetch('rpc/auth_user_id_by_email', { method: 'POST', body: JSON.stringify({ p_email: email }) });
  return typeof id === 'string' && id ? id : null;
}

async function createUser(provider, profile) {
  try {
    const user = await authAdmin('users', {
      method: 'POST',
      body: {
        email: profile.email,
        email_confirm: true,
        user_metadata: { auth_source: provider, full_name: profile.name || null, avatar_url: profile.avatar || null },
      },
    });
    return user.id;
  } catch (error) {
    // Параллельная регистрация той же почтой: аккаунт уже есть — берём его.
    if (error.status === 422 || error.authCode === 'email_exists') {
      const existing = await userIdByEmail(profile.email);
      if (existing) return existing;
    }
    throw error;
  }
}

/** Находит или создаёт аккаунт для профиля провайдера. Возвращает { userId, email, created }. */
async function resolveAccount(provider, profile) {
  const linked = await findIdentity(provider, profile.id);
  if (linked) {
    const user = await authAdmin(`users/${linked}`);
    await saveIdentity(provider, profile, linked);
    return { userId: linked, email: user.email, created: false };
  }
  if (!profile.email) {
    const error = new Error('NO_EMAIL');
    error.code = 'NO_EMAIL';
    throw error;
  }
  const byEmail = await userIdByEmail(profile.email);
  if (byEmail) {
    await saveIdentity(provider, profile, byEmail);
    const user = await authAdmin(`users/${byEmail}`);
    return { userId: byEmail, email: user.email, created: false };
  }
  const userId = await createUser(provider, profile);
  await saveIdentity(provider, profile, userId);
  return { userId, email: profile.email, created: true };
}

async function magicLinkTokenHash(email) {
  const result = await authAdmin('generate_link', { method: 'POST', body: { type: 'magiclink', email } });
  const tokenHash = result.properties?.hashed_token || result.hashed_token;
  if (!tokenHash) throw new Error('Supabase did not return a token');
  return tokenHash;
}

// --- HTTP --------------------------------------------------------------------------------------

function handleProviders(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // Telegram привязывает виджет входа к одному домену, поэтому у отдельного сайта свой бот для входа.
  const telegramBot = siteForRequest(req).origin ? String(process.env.PVZPRINT_TELEGRAM_BOT_USERNAME || '').trim() : '';
  res.status(200).json({ providers: configuredProviders().map(id => ({ id, title: PROVIDERS[id].title })), ...(telegramBot ? { telegramBot } : {}) });
}

async function handleStart(req, res, provider) {
  const spec = PROVIDERS[provider];
  const creds = spec && credentials(provider);
  if (!creds) return res.status(404).json({ error: 'Этот способ входа не подключён', code: 'PROVIDER_NOT_CONFIGURED' });
  const link = String(req.query?.mode || '') === 'link';
  let linkUserId = null;
  if (link) {
    const user = await optionalUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется авторизация', code: 'AUTH_REQUIRED' });
    linkUserId = user.id;
  }
  const next = link ? '/cabinet/profile' : safeNext(req.query?.next);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const state = makeState({ provider, next, nonce, linkUserId });
  const url = new URL(spec.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('redirect_uri', redirectUri(provider, req));
  url.searchParams.set('scope', spec.scope);
  url.searchParams.set('state', state);
  if (provider === 'yandex') url.searchParams.set('force_confirm', 'yes');
  const via = String(req.query?.via || '');
  if (spec.viaProviders?.includes(via)) url.searchParams.set('provider', via);
  let cookieValue = nonce;
  if (spec.pkce) {
    const { verifier, challenge } = pkcePair();
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    cookieValue = `${nonce}.${verifier}`;
  }
  if (link) {
    res.setHeader('Set-Cookie', cookieHeader(cookieValue, STATE_TTL_SEC));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url: url.toString() });
  }
  redirect(res, url.toString(), cookieHeader(cookieValue, STATE_TTL_SEC));
}

/** Режим привязки: связку получает кабинет из state, аккаунт по почте не ищется и не создаётся. */
async function linkToAccount(provider, profile, userId) {
  const existing = await findIdentity(provider, profile.id);
  if (existing && existing !== userId) {
    const error = new Error('TAKEN');
    error.code = 'TAKEN';
    throw error;
  }
  await saveIdentity(provider, profile, userId);
}

async function handleCallback(req, res, provider) {
  const clear = cookieHeader('', 0);
  if (!PROVIDERS[provider] || !credentials(provider)) return failRedirect(res, 'provider', clear);
  const query = req.query || {};
  if (query.error) return failRedirect(res, query.error === 'access_denied' ? 'denied' : 'provider', clear);
  const state = readState(query.state);
  const { nonce, verifier } = readCookie(req);
  if (!state || state.p !== provider || !nonce || state.r !== nonce) return failRedirect(res, 'state', clear);
  const code = String(query.code || '').trim();
  const spec = PROVIDERS[provider];
  if (!code || (spec.pkce && !verifier)) return failRedirect(res, 'state', clear);
  try {
    const accessToken = spec.exchange
      ? await spec.exchange({ code, deviceId: String(query.device_id || ''), verifier, state: String(query.state), redirect: redirectUri(provider, req) })
      : await exchangeCode(provider, code, req);
    const profile = await PROVIDERS[provider].profile(accessToken);
    if (state.u) {
      await linkToAccount(provider, profile, String(state.u));
      return redirect(res, `/cabinet/profile?oauth=linked&provider=${provider}`, clear);
    }
    const account = await resolveAccount(provider, profile);
    const tokenHash = await magicLinkTokenHash(account.email);
    const target = new URL('/auth/oauth', origin());
    target.searchParams.set('token_hash', tokenHash);
    target.searchParams.set('next', safeNext(state.n));
    target.searchParams.set('provider', provider);
    if (account.created) target.searchParams.set('new', '1');
    return redirect(res, target.pathname + target.search, clear);
  } catch (error) {
    if (state.u) {
      const reason = error.code === 'TAKEN' ? 'taken' : 'failed';
      if (reason === 'failed') console.error(`[oauth:${provider}] link failed`, error.message);
      return redirect(res, `/cabinet/profile?oauth=error&reason=${reason}`, clear);
    }
    if (error.code === 'NO_EMAIL') return failRedirect(res, 'no_email', clear);
    console.error(`[oauth:${provider}] login failed`, error.message);
    return failRedirect(res, 'failed', clear);
  }
}

async function handleOAuth(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const step = String(req.query?.step || '');
  const provider = String(req.query?.provider || '').toLowerCase();
  if (step === 'providers') return handleProviders(req, res);
  if (step === 'start') return handleStart(req, res, provider);
  if (step === 'callback') return handleCallback(req, res, provider);
  return res.status(404).json({ error: 'Not found' });
}

module.exports = {
  PROVIDERS, configuredProviders, handleOAuth, identitiesForUser, makeState, readState, redirectUri, resolveAccount, safeNext, unlinkIdentity,
};
