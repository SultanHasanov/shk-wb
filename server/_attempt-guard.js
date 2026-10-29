// Защита от перебора кодов и ключей: считаем ТОЛЬКО неудачные попытки. Перед
// обработкой — peek (без инкремента); после неудачи — recordFailure (инкремент
// через consume_api_rate_limit). Успешный запрос ничего не инкрементит, поэтому
// легитимный пользователь никогда не упирается в лимит. Можно проверять сразу
// несколько измерений (IP, подсеть, сам код) — у каждого свой scope и окно.
const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { clientAddress } = require('./_rate-limit');

// Отдельная память-резерв (не пересекается со счётчиком всех запросов в _rate-limit):
// защищает один инстанс в локалке и в окне между деплоем кода и схемы.
const fallback = new Map();

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** /24-подсеть IPv4 для группового лимита; для прочего — сам адрес. */
function subnetOf(req) {
  const ip = clientAddress(req);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : ip;
}

function fallbackPeek(scope, keyHash, limit) {
  const current = fallback.get(`${scope}:${keyHash}`);
  if (!current || current.resetAt <= Date.now()) return true;
  return current.hits < limit;
}

function fallbackFail(scope, keyHash, windowSeconds) {
  const id = `${scope}:${keyHash}`;
  const now = Date.now();
  const current = fallback.get(id);
  if (!current || current.resetAt <= now) fallback.set(id, { hits: 1, resetAt: now + windowSeconds * 1000 });
  else current.hits += 1;
}

/** true — попыток в окне меньше лимита, можно продолжать. Инкремент не делает. */
async function allowAttempt(req, { scope, limit, windowSeconds, key }) {
  const keyHash = digest(key || clientAddress(req));
  try {
    return await supabaseFetch('rpc/peek_api_rate_limit', {
      method: 'POST',
      body: JSON.stringify({ p_scope: scope, p_key_hash: keyHash, p_limit: limit, p_window_seconds: windowSeconds }),
    });
  } catch (error) {
    return fallbackPeek(scope, keyHash, limit);
  }
}

/** Зафиксировать неудачную попытку (успех не вызываем — он не считается). */
async function recordFailure(req, { scope, windowSeconds, key }) {
  const keyHash = digest(key || clientAddress(req));
  try {
    // p_limit здесь не влияет на сохранённые hits — нужен лишь для валидации вызова.
    await supabaseFetch('rpc/consume_api_rate_limit', {
      method: 'POST',
      body: JSON.stringify({ p_scope: scope, p_key_hash: keyHash, p_limit: 10000, p_window_seconds: windowSeconds }),
    });
  } catch (error) {
    fallbackFail(scope, keyHash, windowSeconds);
  }
}

/**
 * Проверить все измерения ДО обработки. При превышении любого — ответить 429 и
 * вернуть false. Иначе true. dims — массив {scope, limit, windowSeconds, key}.
 */
async function guardAttempts(req, res, dims) {
  for (const dim of dims) {
    if (!(await allowAttempt(req, dim))) {
      res.setHeader('Retry-After', String(dim.windowSeconds));
      res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.', code: 'TOO_MANY_ATTEMPTS' });
      return false;
    }
  }
  return true;
}

/** Зафиксировать неудачу по всем измерениям. */
async function recordFailures(req, dims) {
  for (const dim of dims) await recordFailure(req, dim);
}

module.exports = { allowAttempt, recordFailure, guardAttempts, recordFailures, subnetOf };
