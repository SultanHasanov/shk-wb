const crypto = require('crypto');
const { requesterHash } = require('../_stickers');
const { sendApiError, supabaseFetch } = require('../_supabase');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return handleAccessStatus(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.body?.mode === 'custom' || req.body?.mode === 'box_custom') return handleCustom(req, res);
  const boxMode = req.body?.mode === 'box_range';
  const prefix = normalizePrefix(req.body?.prefix);
  if (boxMode && !prefix) return res.status(400).json({ error:'Префикс должен содержать 1–12 латинских букв, цифр, _ или -' });
  const quantity = Number(req.body?.quantity);
  const accessCode = String(req.body?.accessCode || '').trim();
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
    return res.status(400).json({ error: 'Количество должно быть от 1 до 500' });
  }
  if (accessCode && !/^\d{6}$/.test(accessCode)) {
    return res.status(400).json({ error: 'Ключ должен состоять из 6 цифр' });
  }
  try {
    const rows = await supabaseFetch(boxMode?'rpc/allocate_return_box_codes':'rpc/allocate_return_stickers', {
      method: 'POST',
      body: JSON.stringify({
        p_quantity: quantity,
        p_requester_hash: requesterHash(req),
        p_access_code: accessCode || null,
        ...(boxMode?{p_prefix:prefix}:{}),
      }),
    });
    if (!Array.isArray(rows) || rows.length !== quantity) throw new Error('Unexpected allocation result');
    const batchId = rows[0].batch_id;
    const access = accessCode ? await getAccessStatus(accessCode) : null;
    return res.status(201).json({
      batchId,
      quantity,
      freeRemaining: Number(rows[0].free_remaining || 0),
      stickers: rows.map((row) => ({
        code: row.code,
        imageUrl: `/api/stickers/image?batch=${encodeURIComponent(batchId)}&code=${encodeURIComponent(row.code)}${boxMode?`&variant=box&prefix=${encodeURIComponent(prefix)}`:''}`,
      })),
      pdfUrl: `/api/stickers/pdf?batch=${encodeURIComponent(batchId)}${boxMode?`&variant=box&prefix=${encodeURIComponent(prefix)}`:''}`,
      variant: boxMode ? 'box' : 'product', prefix: boxMode ? prefix : null,
      access,
    });
  } catch (error) {
    const details = JSON.stringify(error.details || '');
    if (details.includes('Not enough unused sticker codes')||details.includes('Not enough unused box codes')) {
      return res.status(409).json({ error: boxMode?'В диапазоне недостаточно свободных номеров коробок':'В пуле недостаточно свободных стикеров' });
    }
    if (details.includes('Sticker access code required')) {
      return res.status(403).json({
        error: 'Бесплатный лимит исчерпан. Введите шестизначный ключ.',
        code: 'ACCESS_CODE_REQUIRED',
      });
    }
    if (details.includes('Invalid sticker access code')) {
      return res.status(403).json({ error: 'Ключ не найден или отключён', code: 'INVALID_ACCESS_CODE' });
    }
    if (details.includes('Access code range limit exceeded')||details.includes('Access code box range limit exceeded')) {
      return res.status(403).json({ error: 'По этому ключу недостаточно доступных стикеров', code: 'ACCESS_CODE_LIMIT' });
    }
    const host = String(req.headers?.host || '');
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
      return res.status(502).json({
        error: 'Database request failed',
        details: error.details || error.message,
      });
    }
    return sendApiError(res, error);
  }
};

async function handleCustom(req, res) {
  const code = String(req.body?.code || '').trim();
  const boxMode = req.body?.mode === 'box_custom';
  const prefix = normalizePrefix(req.body?.prefix);
  const accessCode = String(req.body?.accessCode || '').trim();
  if (boxMode && !prefix) return res.status(400).json({ error:'Префикс должен содержать 1–12 латинских букв, цифр, _ или -' });
  if (!(boxMode ? /^\d{1,12}$/ : /^\d{11}$/).test(code)) return res.status(400).json({ error:boxMode?'Номер должен содержать от 1 до 12 цифр':'Номер должен содержать ровно 11 цифр' });
  if (accessCode && !/^\d{6}$/.test(accessCode)) return res.status(400).json({ error: 'Ключ должен состоять из 6 цифр' });
  try {
    const rows = await supabaseFetch(boxMode?'rpc/authorize_box_custom_sticker':'rpc/authorize_custom_sticker', {
      method: 'POST',
      body: JSON.stringify({ p_requester_hash: requesterHash(req), p_access_code: accessCode || null }),
    });
    const signedValue = boxMode ? `${prefix}:${code}` : code;
    const token = crypto.createHmac('sha256', process.env.STICKER_CLIENT_SECRET).update(signedValue).digest('base64url');
    const access = accessCode ? await getAccessStatus(accessCode) : null;
    return res.status(201).json({ code, prefix:boxMode?prefix:null, variant:boxMode?'box':'product', freeRemaining: Number(rows[0].free_remaining || 0), access, imageUrl: `/api/stickers/image?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}${boxMode?`&variant=box&prefix=${encodeURIComponent(prefix)}`:''}` });
  } catch (error) {
    const details = JSON.stringify(error.details || '');
    if (details.includes('Sticker access code required')) return res.status(403).json({ error:'Бесплатный лимит исчерпан. Введите шестизначный ключ.', code:'ACCESS_CODE_REQUIRED' });
    if (details.includes('Invalid sticker access code')) return res.status(403).json({ error:'Ключ не найден или отключён', code:'INVALID_ACCESS_CODE' });
    if (details.includes('Access code custom limit exceeded')||details.includes('Access code box custom limit exceeded')) return res.status(403).json({ error:'Лимит генераций по номеру для этого ключа исчерпан', code:'ACCESS_CODE_LIMIT' });
    return sendApiError(res, error);
  }
}

function normalizePrefix(value) {
  const prefix=String(value == null ? 'TRBX' : value).trim().toUpperCase();
  return /^[A-Z0-9_-]{1,12}$/.test(prefix) ? prefix : '';
}

async function getAccessStatus(accessCode) {
  const rows = await supabaseFetch(`sticker_access_codes?code=eq.${encodeURIComponent(accessCode)}&active=eq.true&select=range_generation_limit,range_generation_used,custom_generation_limit,custom_generation_used,box_range_generation_limit,box_range_generation_used,box_custom_generation_limit,box_custom_generation_used&limit=1`);
  if (!rows.length) return null;
  const row = rows[0];
  return {
    range: {
      used: Number(row.range_generation_used || 0),
      remaining: Math.max(0, Number(row.range_generation_limit || 0) - Number(row.range_generation_used || 0)),
    },
    custom: {
      used: Number(row.custom_generation_used || 0),
      remaining: Math.max(0, Number(row.custom_generation_limit || 0) - Number(row.custom_generation_used || 0)),
    },
    boxRange: {
      used:Number(row.box_range_generation_used||0),remaining:Math.max(0,Number(row.box_range_generation_limit||0)-Number(row.box_range_generation_used||0)),
    },
    boxCustom: {
      used:Number(row.box_custom_generation_used||0),remaining:Math.max(0,Number(row.box_custom_generation_limit||0)-Number(row.box_custom_generation_used||0)),
    },
  };
}

async function handleAccessStatus(req, res) {
  const accessCode = String(req.query?.accessCode || '').trim();
  if (!/^\d{6}$/.test(accessCode)) return res.status(400).json({ error: 'Invalid access code' });
  try {
    const access = await getAccessStatus(accessCode);
    if (!access) return res.status(404).json({ error: 'Access code not found', code: 'INVALID_ACCESS_CODE' });
    return res.status(200).json({ access });
  } catch (error) {
    return sendApiError(res, error);
  }
}
