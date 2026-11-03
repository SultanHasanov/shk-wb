// Роль процесса selfhost/server.cjs: `site` (VPS в РФ, сайт и API целиком) или `bot` (узел бота в Германии).
// Узел бота отдаёт только вебхук Telegram, картинки/PDF стикеров для Telegram и внутренний RPC с сайта;
// всё остальное — 404, статики нет, монитор диска не запускается. См. docs/telegram-bot.md.
const BOT_API = new Set(['auth', 'telegram/webhook', 'stickers/image', 'stickers/pdf', 'internal/bot']);

function role() {
  return process.env.BOT_ROLE === 'bot' ? 'bot' : 'site';
}

/** Можно ли в этой роли обслужить /api/<relative> с таким query. */
function allowsApi(relative, query = {}) {
  if (role() !== 'bot') return true;
  if (!BOT_API.has(relative)) return false;
  // api/auth.js — это и вход на сайт, и вебхук (action=bot); узлу бота нужен только вебхук.
  if (relative === 'auth') return query.action === 'bot';
  return true;
}

module.exports = { BOT_API, allowsApi, role };
