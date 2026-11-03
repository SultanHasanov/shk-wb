// Внутренний RPC узла бота: сайт с VPS зовёт функции бота (afterWalletTopup, notifyMiniAppAuthorized,
// bindTelegramReferral), чтобы состояние бота жило в одном процессе. Снаружи доступен только через Caddy
// tg.shk-wb.ru:88/rpc с ограничением по IP сайта; плюс секрет BOT_RPC_SECRET. В роли site — 404.
const { ALLOWED, validRpcSecret } = require('../../server/_bot-rpc');
const { role } = require('../../selfhost/bot-role.cjs');

module.exports = async function handler(req, res) {
  if (role() !== 'bot') return res.status(404).type('text/plain').send('404: NOT_FOUND');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!validRpcSecret(req.headers['x-bot-rpc-secret'])) return res.status(401).json({ ok: false, error: 'Bad secret' });
  const fn = String(req.body?.fn || '');
  const args = Array.isArray(req.body?.args) ? req.body.args : [];
  if (!ALLOWED.has(fn)) return res.status(400).json({ ok: false, error: `Unknown function: ${fn}` });
  const startedAt = Date.now();
  try {
    const result = await require('../../server/_telegram-wb-bot')[fn](...args);
    console.log(`internal/bot ${fn} ${Date.now() - startedAt} ms`);
    return res.status(200).json({ ok: true, result: result === undefined ? null : result });
  } catch (error) {
    console.error(`internal/bot ${fn} failed`, error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
