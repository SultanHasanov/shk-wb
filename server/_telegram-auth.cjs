const crypto = require('crypto');

const MAX_AUTH_AGE_SECONDS = 10 * 60;

function validateTelegram(payload, botToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  const hash = typeof payload.hash === 'string' ? payload.hash : '';
  const authDate = Number(payload.auth_date);
  const id = Number(payload.id);
  if (!hash || !Number.isSafeInteger(id) || !Number.isFinite(authDate)) return false;
  const age = nowSeconds - authDate;
  if (age < -30 || age > MAX_AUTH_AGE_SECONDS) return false;
  const dataCheckString = Object.entries(payload)
    .filter(([key, value]) => key !== 'hash' && key !== 'mode' && value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const received = Buffer.from(hash, 'hex');
  const calculated = Buffer.from(expected, 'hex');
  return received.length === calculated.length && crypto.timingSafeEqual(received, calculated);
}

function validateTelegramWebApp(initData, botToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof initData !== 'string' || !initData || initData.length > 10000) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') || '';
  const authDate = Number(params.get('auth_date'));
  const userJson = params.get('user');
  if (!/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate) || !userJson) return null;
  const age = nowSeconds - authDate;
  if (age < -30 || age > MAX_AUTH_AGE_SECONDS) return null;
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const received = Buffer.from(hash, 'hex'), calculated = Buffer.from(expected, 'hex');
  if (received.length !== calculated.length || !crypto.timingSafeEqual(received, calculated)) return null;
  try {
    const user = JSON.parse(userJson);
    if (!Number.isSafeInteger(Number(user.id)) || typeof user.first_name !== 'string') return null;
    return { id: Number(user.id), first_name: user.first_name, last_name: user.last_name, username: user.username, photo_url: user.photo_url, auth_date: authDate };
  } catch (_) { return null; }
}

module.exports = { validateTelegram, validateTelegramWebApp };
