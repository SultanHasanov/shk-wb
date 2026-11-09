const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');

const fallback = new Map();

// Потолки на постоянный фоновый трафик программы (inbox, синхронизация) считаются в памяти: это пятая часть всех
// запросов к Supabase, а сервер — один процесс. Рестарт обнуляет счётчик, для потолка в сотни запросов это не важно.
// Лимиты входа, регистрации и оплат остаются в базе: их обнулять рестартом нельзя.
const MEMORY_SCOPES = new Set(['app-relay', 'app-user']);

function clientAddress(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim().slice(0, 128);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function fallbackConsume(scope, keyHash, limit, windowSeconds) {
  const now = Date.now();
  const id = `${scope}:${keyHash}`;
  const current = fallback.get(id);
  if (!current || current.resetAt <= now) {
    fallback.set(id, { hits: 1, resetAt: now + windowSeconds * 1000 });
    return true;
  }
  current.hits += 1;
  return current.hits <= limit;
}

async function enforceRateLimit(req, res, { scope, limit, windowSeconds, key }) {
  const keyHash = digest(key || clientAddress(req));
  let allowed;
  if (MEMORY_SCOPES.has(scope)) {
    allowed = fallbackConsume(scope, keyHash, limit, windowSeconds);
  } else {
    try {
      allowed = await supabaseFetch('rpc/consume_api_rate_limit', {
        method: 'POST',
        body: JSON.stringify({
          p_scope: scope,
          p_key_hash: keyHash,
          p_limit: limit,
          p_window_seconds: windowSeconds,
        }),
      });
    } catch (error) {
      // Локальная разработка и короткое окно между деплоем кода и схемы остаются
      // защищены хотя бы на одном инстансе. После миграции лимит общий для Vercel.
      allowed = fallbackConsume(scope, keyHash, limit, windowSeconds);
    }
  }
  if (allowed === true) return true;
  res.setHeader('Retry-After', String(windowSeconds));
  res.status(429).json({ error: 'Слишком много запросов. Попробуйте позже.' });
  return false;
}

module.exports = { clientAddress, enforceRateLimit };
