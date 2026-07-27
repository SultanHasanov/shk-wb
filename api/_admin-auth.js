const crypto = require('crypto');

const COOKIE_NAME = 'wb_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(expiresAt) {
  return crypto
    .createHmac('sha256', getRequiredEnv('ADMIN_SESSION_SECRET'))
    .update(String(expiresAt))
    .digest('base64url');
}

function createSessionCookie() {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = `${expiresAt}.${sign(expiresAt)}`;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function isAuthenticated(req) {
  const cookies = Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
  );
  const token = cookies[COOKIE_NAME];
  if (!token) return false;

  const [expiresAtText, signature] = token.split('.');
  const expiresAt = Number(expiresAtText);
  if (!expiresAt || expiresAt < Math.floor(Date.now() / 1000) || !signature) return false;
  return safeEqual(signature, sign(expiresAt));
}

function requireAdmin(req, res) {
  if (isAuthenticated(req)) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

module.exports = {
  clearSessionCookie,
  createSessionCookie,
  getRequiredEnv,
  isAuthenticated,
  requireAdmin,
  safeEqual,
};
