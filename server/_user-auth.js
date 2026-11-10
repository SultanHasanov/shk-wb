const crypto = require('crypto');
const deviceCache = require('./_app-device-cache');

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function tokenExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp) * 1000 || 0;
  } catch (_) {
    return 0;
  }
}

function forgetUserToken(token) {
  if (token) deviceCache.forgetToken(tokenHash(token));
}

function authConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !publishableKey || !serviceKey) throw new Error('Supabase auth environment variables are not configured');
  return { url, publishableKey, serviceKey };
}

// cached — только для фоновых опросов программы: ответ Auth можно помнить до 2 минут (_app-device-cache.js).
// Хранится по хэшу и без самого токена. Сайт, кабинет, вход и оплаты всегда спрашивают Supabase.
async function optionalUser(req, { cached = false } = {}) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const hash = cached ? tokenHash(token) : null;
  if (cached) {
    const hit = deviceCache.getToken(hash);
    if (hit) return { ...hit, _accessToken: token };
  }
  const { url, publishableKey } = authConfig();
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json();
  if (cached) deviceCache.putToken(hash, { ...user }, tokenExpiryMs(token));
  user._accessToken = token;
  return user;
}

// options.scope ('site' | 'app' | 'cell_print' | …) — проверить ограничение аккаунта из админки по снимку в памяти
// (server/_user-controls.js). Ограничение — всегда 403 ACCOUNT_RESTRICTED, никогда 401: на 401 программа
// обновляет сессию, а на DEVICE_REVOKED стирает ключ ПК.
async function requireUser(req, res, options = {}) {
  const user = await optionalUser(req, options);
  if (!user) {
    res.status(401).json({ error: 'Требуется авторизация', code: 'AUTH_REQUIRED' });
    return null;
  }
  if (options && options.scope) {
    // Лениво: _user-controls не должен грузиться там, где requireUser без области
    const controls = require('./_user-controls');
    const r = await controls.restrictionFor(user.id);
    if (r && controls.covers(r, options.scope)) {
      res.status(403).json(controls.restrictedBody(r));
      return null;
    }
  }
  return user;
}

function sessionIssuedRecently(user, seconds = 600) {
  try {
    const payload = JSON.parse(Buffer.from(user._accessToken.split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.iat) >= Math.floor(Date.now() / 1000) - seconds;
  } catch (_) {
    return false;
  }
}

async function deleteAuthUser(userId) {
  const { url, serviceKey } = authConfig();
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!response.ok) throw new Error('Unable to delete auth user');
}

async function getAuthUser(userId) {
  const { url, serviceKey } = authConfig();
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`} });
  if (!response.ok) return null;
  return response.json();
}

function referralCookie(value) {
  const secret = process.env.REFERRAL_COOKIE_SECRET || process.env.STICKER_CLIENT_SECRET;
  if (!secret) throw new Error('REFERRAL_COOKIE_SECRET is not configured');
  const code = String(value || '').trim().toUpperCase();
  const capturedAt = Math.floor(Date.now() / 1000);
  const raw = `${code}.${capturedAt}`;
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('base64url');
  return `${raw}.${signature}`;
}

function readReferralCookie(req) {
  return readReferralCookieDetails(req)?.code || null;
}

function readReferralCookieDetails(req) {
  const header = String(req.headers.cookie || '');
  const match = header.match(/(?:^|;\s*)shk_ref=([^;]+)/);
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  const [code, capturedAt, signature] = value.split('.');
  const secret = process.env.REFERRAL_COOKIE_SECRET || process.env.STICKER_CLIENT_SECRET;
  if (!secret || !/^[A-Z0-9]{6,16}$/.test(code || '')) return null;
  const raw = `${code}.${capturedAt}`;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64url');
  if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  if (Number(capturedAt) < Math.floor(Date.now() / 1000) - 30 * 86400) return null;
  return { code, capturedAt:Number(capturedAt) };
}

module.exports = { authConfig, deleteAuthUser, forgetUserToken, getAuthUser, optionalUser, readReferralCookie, readReferralCookieDetails, referralCookie, requireUser, sessionIssuedRecently };
