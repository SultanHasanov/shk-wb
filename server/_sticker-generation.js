const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { createNotification } = require('./_notifications');

function normalizePrefix(value) {
  const prefix = String(value == null ? 'TRBX' : value).trim().toUpperCase();
  return /^[A-Z0-9_-]{1,12}$/.test(prefix) ? prefix : '';
}

function generationError(code, message, status = 400) {
  const error = new Error(message); error.code = code; error.status = status; return error;
}

function mapDatabaseError(error, boxMode) {
  if (error.code) return error;
  const details = JSON.stringify(error.details || '');
  if (details.includes('Not enough unused sticker codes') || details.includes('Not enough unused box codes')) return generationError('POOL_EMPTY', boxMode ? 'В диапазоне недостаточно свободных номеров коробок' : 'В пуле недостаточно свободных стикеров', 409);
  if (details.includes('Sticker access code required')) return generationError('ACCESS_CODE_REQUIRED', 'Требуется пакет генераций', 403);
  if (details.includes('Invalid sticker access code')) return generationError('INVALID_ACCESS_CODE', 'Ключ не найден или отключён', 403);
  if (['Access code limit exceeded', 'Access code range limit exceeded', 'Access code box range limit exceeded', 'Access code custom limit exceeded', 'Access code box custom limit exceeded'].some(value => details.includes(value))) return generationError('ACCESS_CODE_LIMIT', 'По этому ключу недостаточно доступных генераций', 403);
  return error;
}

async function getAccessStatus(accessCode) {
  const rows = await supabaseFetch(`sticker_access_codes?code=eq.${encodeURIComponent(accessCode)}&active=eq.true&select=generation_limit,generation_used&limit=1`);
  if (!rows.length) return null;
  const total = Number(rows[0].generation_limit || 0), used = Number(rows[0].generation_used || 0);
  return { used, total, remaining: Math.max(0, total - used) };
}

async function assertAccessOwner(accessCode, userId) {
  const rows = await supabaseFetch(`sticker_access_codes?code=eq.${encodeURIComponent(accessCode)}&active=eq.true&select=owner_user_id&limit=1`);
  const ownerId = rows[0]?.owner_user_id;
  if (ownerId && ownerId !== userId) throw generationError('ACCESS_CODE_OWNER_REQUIRED', 'Этот код привязан к другому аккаунту. Войдите под владельцем кода.', 403);
}

async function selectAccessCode(userId, quantity = 1) {
  const rows = await supabaseFetch(`sticker_access_codes?owner_user_id=eq.${encodeURIComponent(userId)}&active=eq.true&select=code,generation_limit,generation_used,created_at&order=created_at.asc`);
  return rows.map(row => ({ ...row, remaining: Number(row.generation_limit || 0) - Number(row.generation_used || 0) }))
    .filter(row => row.remaining >= quantity)
    .sort((a, b) => a.remaining - b.remaining || String(a.created_at).localeCompare(String(b.created_at)))[0]?.code || null;
}

async function recordGeneration(entry) {
  if (!entry.userId) return;
  await supabaseFetch('user_generation_history?on_conflict=user_id,client_entry_id', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({ user_id: entry.userId, client_entry_id: entry.clientEntryId, mode: entry.mode, created_at: new Date().toISOString(), payload: { category: entry.category, prefix: entry.prefix, quantity: entry.quantity, code: entry.code || null, codes: entry.codes || [], batchId: entry.batchId || null, imported: false, channel: entry.channel || 'web' } }),
  });
  if (!entry.access || !entry.accessCode || Number(entry.access.remaining || 0) >= 20) return;
  const prefs = await supabaseFetch(`user_preferences?user_id=eq.${encodeURIComponent(entry.userId)}&select=notify_low_balance&limit=1`).catch(() => []);
  if (prefs[0]?.notify_low_balance !== true) return;
  const remaining = Number(entry.access.remaining || 0), threshold = remaining === 0 ? 'empty' : remaining < 5 ? 'under-5' : 'under-20';
  await createNotification({ userId: entry.userId, kind: 'low_balance', title: 'Заканчиваются генерации', body: `По коду ${entry.accessCode} осталось ${remaining} генераций.`, link: '/cabinet/packages', dedupeKey: `low-balance:${entry.accessCode}:${threshold}`, email: entry.email || null, emailEnabled: Boolean(entry.email) }).catch(() => {});
}

async function generateStickers(options) {
  const category = options.category === 'box' ? 'box' : 'product', mode = options.mode === 'custom' ? 'custom' : 'range';
  const boxMode = category === 'box', prefix = boxMode ? normalizePrefix(options.prefix) : '';
  if (boxMode && !prefix) throw generationError('VALIDATION_ERROR', 'Префикс должен содержать 1–12 латинских букв, цифр, _ или -');
  if (options.accessCode) await assertAccessOwner(options.accessCode, options.userId || null);
  try {
    if (mode === 'range') {
      const quantity = Number(options.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) throw generationError('VALIDATION_ERROR', 'Количество должно быть от 1 до 500');
      const rows = await supabaseFetch(boxMode ? 'rpc/allocate_return_box_codes' : 'rpc/allocate_return_stickers', { method: 'POST', body: JSON.stringify({ p_quantity: quantity, p_requester_hash: options.requesterHash, p_access_code: options.accessCode || null, ...(boxMode ? { p_prefix: prefix } : {}) }) });
      if (!Array.isArray(rows) || rows.length !== quantity) throw new Error('Unexpected allocation result');
      const batchId = rows[0].batch_id, access = options.accessCode ? await getAccessStatus(options.accessCode) : null;
      const result = { batchId, quantity, variant: category, prefix: boxMode ? prefix : null, access, items: rows.map(row => ({ code: String(row.code), imageUrl: `/api/stickers/image?batch=${encodeURIComponent(batchId)}&code=${encodeURIComponent(row.code)}${boxMode ? `&variant=box&prefix=${encodeURIComponent(prefix)}` : ''}` })), pdfUrl: `/api/stickers/pdf?batch=${encodeURIComponent(batchId)}${boxMode ? `&variant=box&prefix=${encodeURIComponent(prefix)}` : ''}` };
      await recordGeneration({ ...options, clientEntryId: options.clientEntryId || `server:${batchId}`, mode, category, prefix, quantity, codes: result.items.map(item => item.code), batchId, access });
      return result;
    }
    const code = String(options.code || '').trim(), codeLength = boxMode ? 10 : 11;
    if (!new RegExp(`^\\d{${codeLength}}$`).test(code)) throw generationError('VALIDATION_ERROR', `Номер должен содержать ровно ${codeLength} цифр`);
    await supabaseFetch(boxMode ? 'rpc/authorize_box_custom_sticker' : 'rpc/authorize_custom_sticker', { method: 'POST', body: JSON.stringify({ p_requester_hash: options.requesterHash, p_access_code: options.accessCode || null }) });
    const expires = Math.floor(Date.now() / 1000) + 3600, signedValue = `${boxMode ? `${prefix}:${code}` : code}:${expires}`;
    const token = crypto.createHmac('sha256', process.env.STICKER_CLIENT_SECRET).update(signedValue).digest('base64url');
    const access = options.accessCode ? await getAccessStatus(options.accessCode) : null;
    const signedQuery = `code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}&expires=${expires}${boxMode ? `&variant=box&prefix=${encodeURIComponent(prefix)}` : ''}`;
    const result = { code, quantity: 1, prefix: boxMode ? prefix : null, variant: category, access, imageUrl: `/api/stickers/image?${signedQuery}`, pdfUrl: `/api/stickers/pdf?${signedQuery}` };
    await recordGeneration({ ...options, clientEntryId: options.clientEntryId || `server:${crypto.randomUUID()}`, mode, category, prefix, quantity: 1, code, access });
    return result;
  } catch (error) { throw mapDatabaseError(error, boxMode); }
}

module.exports = { assertAccessOwner, generateStickers, getAccessStatus, normalizePrefix, selectAccessCode };
