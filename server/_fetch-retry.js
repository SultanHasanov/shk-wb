// fetch с таймаутом и одним повтором на сетевую ошибку. Связь VPS ↔ Cloudflare (за ним Supabase и релей
// Telegram) по нескольку раз в час рвётся на 15–50 с: без таймаута запрос висит минутами, с повтором
// чаще всего проходит со второй попытки. Повторяем ТОЛЬКО ошибки до ответа сервера (обрыв, таймаут):
// HTTP-ответ с любым статусом повтором не считается — его разбирает вызывающий код.

const DEFAULT_TIMEOUT_MS = 10_000;

function isNetworkError(error) {
  if (!error) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const code = String(error.cause?.code || error.code || '');
  if (/^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR)/.test(code)) return true;
  return error instanceof TypeError && /fetch failed|terminated|socket/i.test(String(error.message));
}

/**
 * @param {string} url
 * @param {RequestInit} options
 * @param {{ timeoutMs?: number, retries?: number, label?: string }} settings
 *   retries — сколько ПОВТОРОВ (не попыток) допустимо; 0 — только одна попытка.
 */
async function fetchWithRetry(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 0, label = '' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isNetworkError(error)) throw error;
      console.warn(`fetch retry${label ? ` (${label})` : ''}: ${error.message}${error.cause?.code ? ` [${error.cause.code}]` : ''}`);
    }
  }
  throw lastError;
}

module.exports = { DEFAULT_TIMEOUT_MS, fetchWithRetry, isNetworkError };
