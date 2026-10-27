const crypto = require('crypto');
const { requesterHash } = require('../../server/_stickers');
const { sendApiError } = require('../../server/_supabase');
const { requireUser } = require('../../server/_user-auth');
const { enforceRateLimit } = require('../../server/_rate-limit');
const { generateStickers } = require('../../server/_sticker-generation');
const { BATCH_QUANTITY, finalizeGeneration, refundGeneration, reserveGeneration } = require('../../server/_generation-billing');

module.exports = async function handler(req, res) {
  if (!await enforceRateLimit(req, res, { scope: 'sticker-generation', limit: 60, windowSeconds: 60 })) return;
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let charge = null;
  try {
    const rawMode = req.body?.mode;
    if (!['range', 'custom', 'box_range', 'box_custom'].includes(rawMode)) {
      return res.status(400).json({ error: 'Выберите генерацию по номеру или пачку 50', code: 'VALIDATION_ERROR' });
    }
    const isCustom = rawMode === 'custom' || rawMode === 'box_custom';
    const category = rawMode === 'box_range' || rawMode === 'box_custom' ? 'box' : 'product';
    if (!isCustom && Number(req.body?.quantity) !== BATCH_QUANTITY) {
      return res.status(400).json({ error: 'Пачка содержит ровно 50 кодов', code: 'VALIDATION_ERROR' });
    }
    const requestKey = String(req.body?.requestId || req.headers['idempotency-key'] || crypto.randomUUID());
    charge = await reserveGeneration({ userId: user.id, requestKey, mode: isCustom ? 'custom' : 'batch', category });
    if (charge.duplicate && charge.status === 'completed' && charge.result) {
      return res.status(200).json(charge.result);
    }
    if (charge.duplicate) {
      return res.status(409).json({ error: 'Запрос уже обрабатывается', code: 'GENERATION_BUSY' });
    }
    const result = await generateStickers({
      userId: user.id,
      chargeId: charge.chargeId,
      requesterHash: requesterHash(req),
      category,
      mode: isCustom ? 'custom' : 'range',
      quantity: isCustom ? 1 : BATCH_QUANTITY,
      code: req.body?.code,
      prefix: req.body?.prefix,
      channel: req.headers['x-app-version'] ? 'app' : 'web',
      clientEntryId: `paid:${charge.chargeId}`,
      email: user.email?.endsWith('@users.invalid') ? null : user.email || null,
    });
    const response = { ...result, priceKopecks: charge.priceKopecks, discountApplied: charge.discountApplied, balanceKopecks: charge.balanceKopecks };
    await finalizeGeneration(charge.chargeId, response);
    return res.status(201).json(response);
  } catch (error) {
    if (charge?.chargeId) await refundGeneration(charge.chargeId).catch(() => {});
    if (error.code) return res.status(error.status || 400).json({ error: error.message, code: error.code });
    const host = String(req.headers?.host || '');
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return res.status(502).json({ error: 'Database request failed', details: error.details || error.message });
    return sendApiError(res, error);
  }
};
