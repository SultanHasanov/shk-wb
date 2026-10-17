const { requesterHash } = require('../../server/_stickers');
const { sendApiError } = require('../../server/_supabase');
const { optionalUser } = require('../../server/_user-auth');
const { isAccessCode, normalizeAccessCode } = require('../../server/_access-code');
const { enforceRateLimit } = require('../../server/_rate-limit');
const { assertAccessOwner, generateStickers, getAccessStatus, selectAccessCode } = require('../../server/_sticker-generation');
const { supabaseFetch } = require('../../server/_supabase');

// Вошедший без кода: сначала квота стикеров тарифа Про (код текущего месяца),
// затем свои пакеты генераций. Так программа печатает без ввода кода.
async function accountAccessCode(userId, quantity) {
  const quotaCode = await supabaseFetch('rpc/app_sticker_quota_code', { method: 'POST', body: JSON.stringify({ p_user: userId }) }).catch(() => null);
  if (quotaCode) {
    const status = await getAccessStatus(String(quotaCode));
    if (status && status.remaining >= quantity) return String(quotaCode);
  }
  return selectAccessCode(userId, quantity);
}

module.exports = async function handler(req, res) {
  if (!await enforceRateLimit(req, res, { scope: 'sticker-generation', limit: 60, windowSeconds: 60 })) return;
  const accessCode = normalizeAccessCode(req.method === 'GET' ? req.query?.accessCode : req.body?.accessCode);
  if (accessCode && !isAccessCode(accessCode)) return res.status(400).json({ error: 'Некорректный код доступа' });
  try {
    const user = await optionalUser(req);
    if (req.method === 'GET') {
      if (!accessCode) return res.status(400).json({ error: 'Invalid access code' });
      await assertAccessOwner(accessCode, user?.id || null);
      const access = await getAccessStatus(accessCode);
      if (!access) return res.status(404).json({ error: 'Access code not found', code: 'INVALID_ACCESS_CODE' });
      return res.status(200).json({ access });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const rawMode = req.body?.mode;
    const isCustom = rawMode === 'custom' || rawMode === 'box_custom';
    const effectiveCode = accessCode || (user ? await accountAccessCode(user.id, isCustom ? 1 : Math.max(1, Number(req.body?.quantity) || 1)) : null);
    const result = await generateStickers({
      userId: user?.id || null,
      accessCode: effectiveCode || null,
      requesterHash: requesterHash(req),
      category: rawMode === 'box_range' || rawMode === 'box_custom' ? 'box' : 'product',
      mode: isCustom ? 'custom' : 'range',
      quantity: req.body?.quantity,
      code: req.body?.code,
      prefix: req.body?.prefix,
      channel: req.headers['x-app-version'] ? 'app' : 'web',
      email: user?.email?.endsWith('@users.invalid') ? null : user?.email || null,
    });
    return res.status(201).json(result);
  } catch (error) {
    if (error.code) return res.status(error.status || 400).json({ error: error.message, code: error.code });
    const host = String(req.headers?.host || '');
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return res.status(502).json({ error: 'Database request failed', details: error.details || error.message });
    return sendApiError(res, error);
  }
};
