// Вызовы бота со стороны сайта (оплата «пополнить и купить», вход через Telegram). Когда бот живёт отдельным
// процессом на узле в Германии (BOT_RPC_URL), вызов уходит туда по HTTP — там же его кеши сессий и связок;
// узел не ответил или BOT_RPC_URL не задан — выполняем локально, как раньше (модуль бота есть и на сайте).
const crypto = require('crypto');
const { fetchWithRetry } = require('./_fetch-retry');

const ALLOWED = new Set(['afterWalletTopup', 'notifyMiniAppAuthorized', 'bindTelegramReferral', 'forgetSiteUser', 'forgetTelegramUser', 'invalidateUserControls']);

function rpcConfig() {
  const url = String(process.env.BOT_RPC_URL || '').trim();
  const secret = String(process.env.BOT_RPC_SECRET || '').trim();
  return url && secret.length >= 16 ? { url, secret } : null;
}

function localBot() {
  // Лениво: _payments → _bot-rpc → бот → _wallet → _payments; прямой require на верхнем уровне дал бы цикл.
  return require('./_telegram-wb-bot');
}

async function callBot(fn, ...args) {
  if (!ALLOWED.has(fn)) throw new Error(`Unknown bot function: ${fn}`);
  const config = rpcConfig();
  if (config) {
    try {
      const response = await fetchWithRetry(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bot-Rpc-Secret': config.secret },
        body: JSON.stringify({ fn, args }),
      }, { retries: 1, label: `bot rpc ${fn}` });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok === true) return data.result;
      throw new Error(data.error || `HTTP ${response.status}`);
    } catch (error) {
      console.warn(`bot rpc ${fn} failed, running locally: ${error.message}`);
    }
  }
  return localBot()[fn](...args);
}

/** Проверка секрета на узле бота. */
function validRpcSecret(header) {
  const expected = String(process.env.BOT_RPC_SECRET || ''), actual = String(header || '');
  if (expected.length < 16 || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

module.exports = { ALLOWED, callBot, validRpcSecret };
