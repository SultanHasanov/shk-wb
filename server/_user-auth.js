const crypto = require('crypto');

function authConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !publishableKey || !serviceKey) throw new Error('Supabase auth environment variables are not configured');
  return { url, publishableKey, serviceKey };
}

async function optionalUser(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { url, publishableKey } = authConfig();
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json();
  user._accessToken = token;
  return user;
}

async function requireUser(req, res) {
  const user = await optionalUser(req);
  if (!user) {
    res.status(401).json({ error: 'Требуется авторизация', code: 'AUTH_REQUIRED' });
    return null;
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

module.exports = { deleteAuthUser, getAuthUser, optionalUser, readReferralCookie, readReferralCookieDetails, referralCookie, requireUser, sessionIssuedRecently };
