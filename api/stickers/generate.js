const crypto = require('crypto');
const { requesterHash } = require('../../server/_stickers');
const { sendApiError } = require('../../server/_supabase');
const { optionalUser } = require('../../server/_user-auth');
const { enforceRateLimit } = require('../../server/_rate-limit');
const { generateStickers } = require('../../server/_sticker-generation');
const { BATCH_QUANTITY, finalizeGeneration, refundGeneration, reserveGeneration } = require('../../server/_generation-billing');
const { guardAttempts, recordFailures, recordFailure, allowAttempt, subnetOf } = require('../../server/_attempt-guard');
const { sendToAdmins } = require('../../server/_admin-alerts');

// Всплеск перебора гостевых кодов: уведомляем админа не чаще раза в час на подсеть.
async function alertGuestBruteforce(req, subnet) {
  try {
    if (await allowAttempt(req, { scope: 'guest-code-alert', limit: 1, windowSeconds: 3600, key: subnet })) {
      await sendToAdmins(`⚠️ Подбор гостевых кодов генерации: подсеть ${subnet} временно заблокирована (много неверных кодов).`);
      await recordFailure(req, { scope: 'guest-code-alert', windowSeconds: 3600, key: subnet });
    }
  } catch (_) { /* оповещение не должно влиять на ответ генерации */ }
}

module.exports = async function handler(req, res) {
  if (!await enforceRateLimit(req, res, { scope: 'sticker-generation', limit: 60, windowSeconds: 60 })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await optionalUser(req);
  let charge = null;
  let guestFailureDims = null;
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
    const accessCode = String(req.body?.accessCode || '').trim().toUpperCase();
    if (user) {
      charge = await reserveGeneration({ userId: user.id, requestKey, mode: isCustom ? 'custom' : 'batch', category });
      if (charge.duplicate && charge.status === 'completed' && charge.result) {
        return res.status(200).json(charge.result);
      }
      if (charge.duplicate) {
        return res.status(409).json({ error: 'Запрос уже обрабатывается', code: 'GENERATION_BUSY' });
      }
    } else if (!accessCode) {
      return res.status(401).json({ error: 'Войдите или купите генерацию без регистрации', code: 'AUTH_OR_ACCESS_CODE_REQUIRED' });
    }
    // Анти-перебор гостевых кодов доступа: считаем ТОЛЬКО неверные коды (успешная
    // генерация лимит не расходует). Измерения — IP, /24-подсеть и сам код.
    if (!user) {
      guestFailureDims = [
        { scope: 'guest-code-ip', limit: 20, windowSeconds: 3600 },
        { scope: 'guest-code-subnet', limit: 40, windowSeconds: 3600, key: subnetOf(req) },
        { scope: 'guest-code-value', limit: 5, windowSeconds: 3600, key: accessCode },
      ];
      if (!(await guardAttempts(req, res, guestFailureDims))) { await alertGuestBruteforce(req, subnetOf(req)); return; }
    }
    const result = await generateStickers({
      userId: user?.id || null,
      chargeId: charge?.chargeId || null,
      accessCode: user ? null : accessCode,
      requesterHash: requesterHash(req),
      category,
      mode: isCustom ? 'custom' : 'range',
      quantity: isCustom ? 1 : BATCH_QUANTITY,
      code: req.body?.code,
      prefix: req.body?.prefix,
      channel: req.headers['x-app-version'] ? 'app' : 'web',
      clientEntryId: charge?.chargeId ? `paid:${charge.chargeId}` : `guest:${requestKey}`,
      email: user?.email?.endsWith('@users.invalid') ? null : user?.email || null,
    });
    const response = user
      ? {
          ...result,
          priceKopecks: charge.priceKopecks,
          discountApplied: charge.discountApplied,
          balanceKopecks: charge.balanceKopecks,
          paymentSource: charge.paymentSource,
          packageRemaining: charge.packageRemaining,
        }
      : result;
    if (charge?.chargeId) await finalizeGeneration(charge.chargeId, response);
    return res.status(201).json(response);
  } catch (error) {
    if (charge?.chargeId) await refundGeneration(charge.chargeId).catch(() => {});
    // Неверный гостевой код — засчитываем попытку (прочие ошибки лимит не трогают).
    if (guestFailureDims && error.code === 'INVALID_ACCESS_CODE') await recordFailures(req, guestFailureDims).catch(() => {});
    if (error.code) return res.status(error.status || 400).json({ error: error.message, code: error.code });
    const host = String(req.headers?.host || '');
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return res.status(502).json({ error: 'Database request failed', details: error.details || error.message });
    return sendApiError(res, error);
  }
};
