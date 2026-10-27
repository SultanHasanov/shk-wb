const { supabaseFetch } = require('./_supabase');

const GENERATION_PRICES = Object.freeze({ custom: 750, batch: 2000 });
const GENERATION_DISCOUNT_PRICES = Object.freeze({ custom: 600, batch: 1600 });
const BATCH_QUANTITY = 50;

function billingError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeMode(mode) {
  return mode === 'custom' ? 'custom' : mode === 'range' || mode === 'batch' ? 'batch' : '';
}

function parseResult(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function reserveGeneration({ userId, requestKey, mode, category }) {
  const normalizedMode = normalizeMode(mode);
  if (!userId || !normalizedMode || !['product', 'box'].includes(category) || !String(requestKey || '').trim()) {
    throw billingError('VALIDATION_ERROR', 'Некорректные параметры оплаты генерации');
  }
  const result = parseResult(await supabaseFetch('rpc/reserve_sticker_generation', {
    method: 'POST',
    body: JSON.stringify({
      p_user: userId,
      p_request_key: String(requestKey).slice(0, 160),
      p_mode: normalizedMode,
      p_category: category,
    }),
  }));
  if (!result?.ok) {
    if (result?.code === 'INSUFFICIENT') {
      throw billingError('INSUFFICIENT_BALANCE', 'Недостаточно денег на балансе', 402);
    }
    if (result?.code === 'BUSY') {
      throw billingError('GENERATION_BUSY', 'Дождитесь завершения предыдущей генерации', 409);
    }
    throw billingError('BILLING_ERROR', 'Не удалось зарезервировать оплату', 409);
  }
  return result;
}

async function refundGeneration(chargeId) {
  if (!chargeId) return null;
  return parseResult(await supabaseFetch('rpc/refund_sticker_generation', {
    method: 'POST', body: JSON.stringify({ p_charge: chargeId }),
  }));
}

async function finalizeGeneration(chargeId, result) {
  return parseResult(await supabaseFetch('rpc/finalize_sticker_generation', {
    method: 'POST', body: JSON.stringify({ p_charge: chargeId, p_result: result }),
  }));
}

module.exports = {
  BATCH_QUANTITY,
  GENERATION_DISCOUNT_PRICES,
  GENERATION_PRICES,
  finalizeGeneration,
  normalizeMode,
  refundGeneration,
  reserveGeneration,
};
