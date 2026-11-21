// Приглашение в общий чат после покупки, пополнения или генерации (решение владельца 21.11.2026: без срока):
// каждому один раз, тем, кого ещё нет в чате. Выключить можно датой в SUPPORT_CHAT_INVITE_UNTIL (после неё — молчит).
// «Уже приглашали» — строка в api_rate_limits (scope support-chat-invite, ключ — sha256 Telegram ID): без новой таблицы,
// чистки у неё нет. Работает и на узле бота, и на сайте (оплаты): Telegram через telegramRequest, база — supabaseFetch.
const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { sendMessage, telegramRequest } = require('./_telegram-api');

const SCOPE = 'support-chat-invite';
const DELAY_MS = 3000; // после результата покупки/генерации, чтобы приглашение пришло следом, а не вперемешку

const INVITE_TEXT = [
  '💬 <b>У нас появился общий чат — «Чат · WB Инструменты»</b>',
  '',
  'Там отвечаем на вопросы по боту, «Помощнику ПВЗ» и «ПВЗ Принт», а сотрудники и владельцы ПВЗ Wildberries и Ozon делятся опытом.',
  'Заходите — спросить, подсказать или просто познакомиться.',
].join('\n');

/** Адрес чата из SUPPORT_CHAT_URL (как в _bot-texts.js), читается при каждом вызове. */
function chatUrl() {
  const url = String(process.env.SUPPORT_CHAT_URL || '').trim();
  return /^https:\/\/t\.me\/[\w+]+$/.test(url) ? url : '';
}

/** Срок приглашений: по умолчанию без срока; SUPPORT_CHAT_INVITE_UNTIL=<дата> — выключить после неё. */
function inviteUntil() {
  const raw = String(process.env.SUPPORT_CHAT_INVITE_UNTIL || '').trim();
  if (!raw) return Infinity;
  const until = Date.parse(raw);
  return Number.isFinite(until) ? until : Infinity;
}

function inviteActive(now = Date.now()) {
  return Boolean(chatUrl()) && now <= inviteUntil();
}

function supportChatId() {
  const id = Number(process.env.SUPPORT_CHAT_ID || 0);
  return Number.isSafeInteger(id) && id < 0 ? id : null;
}

async function alreadyInChat(telegramId) {
  const chatId = supportChatId();
  if (!chatId) return false;
  const member = await telegramRequest('getChatMember', { chat_id: chatId, user_id: Number(telegramId) }, { retries: 0, timeoutMs: 5000 }).catch(() => null);
  return ['creator', 'administrator', 'member', 'restricted'].includes(member?.status) && member?.is_member !== false;
}

/** true — этого человека ещё не приглашали (и теперь отмечен). */
async function claimInvite(telegramId) {
  const keyHash = crypto.createHash('sha256').update(String(telegramId)).digest('hex');
  const rows = await supabaseFetch('api_rate_limits?on_conflict=scope,key_hash', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ scope: SCOPE, key_hash: keyHash, window_started_at: new Date().toISOString(), hits: 1 }),
  });
  return Array.isArray(rows) && rows.length > 0;
}

/** Отправить приглашение сейчас (с проверками). Возвращает, что вышло: sent | inactive | member | already. */
async function sendInvite(telegramId) {
  if (!telegramId || !inviteActive()) return 'inactive';
  if (await alreadyInChat(telegramId)) return 'member';
  if (!await claimInvite(telegramId)) return 'already';
  await sendMessage(Number(telegramId), INVITE_TEXT, { reply_markup: { inline_keyboard: [[{ text: '💬 Перейти в чат', url: chatUrl() }]] } });
  return 'sent';
}

/** После покупки / пополнения / генерации: приглашение следом, в фоне. Ошибка — только в лог. */
function inviteAfterAction(telegramId) {
  if (!telegramId || !inviteActive() || process.env.TELEGRAM_LOCAL_POLLING === '1') return;
  const timer = setTimeout(() => {
    sendInvite(telegramId).catch(error => console.warn('Приглашение в чат', error?.message || error));
  }, DELAY_MS);
  timer.unref?.();
}

/** То же по аккаунту сайта: Telegram берём из привязки. */
async function inviteUserAfterAction(userId) {
  if (!userId || !inviteActive()) return;
  const rows = await supabaseFetch(`user_telegram_identities?user_id=eq.${encodeURIComponent(userId)}&select=telegram_user_id&limit=1`).catch(() => []);
  inviteAfterAction(rows?.[0]?.telegram_user_id);
}

module.exports = { INVITE_TEXT, inviteActive, inviteAfterAction, inviteUserAfterAction, sendInvite };
