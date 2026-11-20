// Чат поддержки (супергруппа SUPPORT_CHAT_ID): бот удаляет запрещённое (_chat-rules.js), пишет причину в чате
// сообщением, которое само исчезает, и присылает владельцу (adminIds) «кому и за что» с кнопками «Мут», «Бан»,
// «Ошибка бота». Сам бот никого не мутит и не банит — это решает владелец (решение владельца, 20.11.2026).
// Другие группы бот не трогает и не отвечает в них. Сбой здесь — только в лог: в общий чат ошибок не пишем.
const { supabaseFetch, supabaseFetchWithMeta } = require('./_supabase');
const { deleteMessage, sendMessage, telegramRequest } = require('./_telegram-api');
const { adminIds } = require('./_admin-alerts');
const rules = require('./_chat-rules');

const NOTICE_TTL_MS = 60 * 1000; // сообщение с причиной удаления живёт минуту
const NOTICE_EVERY_MS = 30 * 1000; // и не чаще раза в 30 с на человека
const ALERT_EVERY_MS = 60 * 1000; // владельцу — не чаще раза в минуту на человека (серия ссылок — одно сообщение)
const ADMINS_TTL_MS = 10 * 60 * 1000;
const MENTION_TTL_MS = 24 * 60 * 60 * 1000;
const SUBSCRIBER_TTL_MS = 60 * 60 * 1000;
const NEWCOMER_MESSAGES = 3;
const FLOOD_WINDOW_MS = 10 * 1000, FLOOD_MAX = 5;
const REPEAT_WINDOW_MS = 60 * 1000, REPEAT_MAX = 3;
const REPORTS_PER_HOUR = 3;
const DEFAULT_MUTE_HOURS = 24;
const MAP_MAX = 5000;

let deps = { botUsername: async () => String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''), whoSummary: null };

/** Бот передаёт своё: имя бота (getMe) и сводку о человеке для /who. */
function configure(next) { deps = { ...deps, ...next }; }

function supportChatId() {
  const id = Number(process.env.SUPPORT_CHAT_ID || 0);
  return Number.isSafeInteger(id) && id < 0 ? id : null;
}

function isSupportChat(chat) {
  const id = supportChatId();
  return Boolean(id && chat && Number(chat.id) === id);
}

function isGroupChat(chat) { return chat?.type === 'group' || chat?.type === 'supergroup'; }

/** Апдейт из группы (или о членстве бота в группе) — обрабатывается здесь, а не личным ботом. */
function isGroupUpdate(update) {
  if (update?.my_chat_member) return isGroupChat(update.my_chat_member.chat);
  if (update?.chat_member) return true;
  const message = update?.message || update?.edited_message;
  return Boolean(message && isGroupChat(message.chat));
}

const escapeHtml = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nameOf = user => [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() || 'без имени';
const userLink = user => `<a href="tg://user?id=${Number(user.id)}">${escapeHtml(nameOf(user))}</a>`;
const userLine = user => `${userLink(user)}${user.username ? ` · @${escapeHtml(user.username)}` : ''} (<code>${Number(user.id)}</code>)`;

function boundedSet(map, key, value) {
  if (map.size >= MAP_MAX) map.delete(map.keys().next().value);
  map.set(key, value);
}

function throttled(map, key, everyMs, now = Date.now()) {
  const last = map.get(key);
  if (last && now - last < everyMs) return true;
  boundedSet(map, key, now);
  return false;
}

// --- Кто админ ---------------------------------------------------------------------------------------------

const adminCache = new Map(); // chatId → { at, ids:Set }

async function groupAdmins(chatId) {
  const cached = adminCache.get(chatId);
  if (cached && Date.now() - cached.at < ADMINS_TTL_MS) return cached.ids;
  try {
    const list = await telegramRequest('getChatAdministrators', { chat_id: chatId });
    const ids = new Set((list || []).map(member => Number(member.user?.id)).filter(Boolean));
    adminCache.set(chatId, { at: Date.now(), ids });
    return ids;
  } catch (error) {
    console.warn('Чат поддержки: список админов', error?.message || error);
    // Повторим через минуту, а пока — прошлый список или пустой
    adminCache.set(chatId, { at: Date.now() - ADMINS_TTL_MS + 60_000, ids: cached?.ids || new Set() });
    return cached?.ids || new Set();
  }
}

const isOwner = userId => adminIds().includes(String(userId));

async function isModerator(chatId, userId) {
  return isOwner(userId) || (await groupAdmins(chatId)).has(Number(userId));
}

// --- Свои имена в Telegram, упоминания, новички ------------------------------------------------------------

async function allowedTelegram(chat) {
  const names = ['wbtools_ru', 'wb_wpn_bot', 'shkwb_bot'];
  const bot = await deps.botUsername().catch(() => '');
  if (bot) names.push(bot);
  if (chat?.username) names.push(chat.username);
  for (const extra of String(process.env.SUPPORT_CHAT_ALLOWED_TELEGRAM || '').split(',')) names.push(extra.trim().replace(/^@/, ''));
  return new Set(names.filter(Boolean).map(name => name.toLowerCase()));
}

const mentionCache = new Map(); // имя → { at, kind }

/** Тип чата по @имени: channel / group / supergroup / private (getChat отвечает только для публичных чатов) или user. */
async function mentionKind(name) {
  const cached = mentionCache.get(name);
  if (cached && Date.now() - cached.at < MENTION_TTL_MS) return cached.kind;
  let kind = 'user';
  try {
    const chat = await telegramRequest('getChat', { chat_id: `@${name}` }, { retries: 0, timeoutMs: 4000 });
    kind = chat?.type || 'user';
  } catch (error) {
    if (!/not found|invalid/i.test(String(error?.message))) return 'user'; // сеть — не запоминаем
  }
  boundedSet(mentionCache, name, { at: Date.now(), kind });
  return kind;
}

async function mentionKinds(message, allowed) {
  const names = rules.findMentions(message).filter(name => !allowed.has(name) && !/bot$/.test(name)).slice(0, 5);
  const entries = await Promise.all(names.map(async name => [name, await mentionKind(name)]));
  return new Map(entries);
}

const messageCounts = new Map(); // tg → сколько сообщений в чате (с рестарта процесса)
const subscriberCache = new Map(); // tg → { at, known }

async function isBotSubscriber(tgId) {
  const cached = subscriberCache.get(tgId);
  if (cached && Date.now() - cached.at < SUBSCRIBER_TTL_MS) return cached.known;
  try {
    const rows = await supabaseFetch(`telegram_bot_subscribers?telegram_user_id=eq.${Number(tgId)}&select=telegram_user_id&limit=1`);
    const known = Array.isArray(rows) && rows.length > 0;
    boundedSet(subscriberCache, tgId, { at: Date.now(), known });
    return known;
  } catch {
    return true; // база не ответила — не считаем новичком (спам-фразы у своих не проверяем)
  }
}

/** Новичок: первые сообщения в чате и ни разу не открывал бота. */
async function isNewcomer(tgId) {
  if ((messageCounts.get(tgId) || 0) > NEWCOMER_MESSAGES) return false;
  return !(await isBotSubscriber(tgId));
}

// --- Флуд --------------------------------------------------------------------------------------------------

const floodLog = new Map(); // tg → [{ at, text }]

// Медленный режим для одного человека после флуда (встроенный в Telegram — только на весь чат): SLOW_MODE_MS
// после каждого его сообщения бот запрещает писать на SLOW_DELAY_S. Меньше 30 с Telegram считает запретом навсегда,
// поэтому 35 с. Человеку это видно как обычная задержка: поле ввода заблокировано, потом снова можно.
const SLOW_MODE_MS = 10 * 60 * 1000;
const SLOW_DELAY_S = 35;
const slowUntil = new Map(); // tg → до какого времени медленный режим

function inSlowMode(tgId, now = Date.now()) {
  const until = slowUntil.get(tgId);
  if (!until) return false;
  if (until > now) return true;
  slowUntil.delete(tgId);
  return false;
}

/** Задержка перед следующим сообщением: запрет писать на SLOW_DELAY_S, дальше права как у всех. */
async function slowDown(chatId, tgId) {
  try {
    await telegramRequest('restrictChatMember', {
      chat_id: chatId, user_id: Number(tgId), permissions: NO_PERMISSIONS,
      use_independent_chat_permissions: true, until_date: Math.floor(Date.now() / 1000) + SLOW_DELAY_S,
    });
  } catch (error) {
    console.warn('Чат поддержки: медленный режим', error?.message || error);
  }
}

const mediaGroups = new Map(); // media_group_id → at: альбом из 10 фото — одно сообщение, а не флуд

function isFlood(tgId, text, now = Date.now(), mediaGroupId = null) {
  if (mediaGroupId) {
    if (mediaGroups.has(mediaGroupId)) return false;
    boundedSet(mediaGroups, mediaGroupId, now);
  }
  const recent = (floodLog.get(tgId) || []).filter(item => now - item.at < REPEAT_WINDOW_MS);
  recent.push({ at: now, text: String(text || '').trim().toLowerCase() });
  boundedSet(floodLog, tgId, recent.slice(-20));
  const burst = recent.filter(item => now - item.at < FLOOD_WINDOW_MS).length > FLOOD_MAX;
  const sameText = recent[recent.length - 1].text;
  const repeats = sameText.length > 0 && recent.filter(item => item.text === sameText).length >= REPEAT_MAX;
  return burst || repeats;
}

// --- Сообщения в чате и владельцу --------------------------------------------------------------------------

function scheduleDelete(chatId, messageId, ms) {
  if (!messageId) return;
  const timer = setTimeout(() => deleteMessage(chatId, messageId).catch(() => {}), ms);
  timer.unref?.();
}

/** Сообщение в чате, которое само удалится через ms. */
async function sendTemp(chatId, text, ms = NOTICE_TTL_MS, extra = {}) {
  const sent = await sendMessage(chatId, text, extra).catch(error => { console.warn('Чат поддержки: сообщение', error?.message || error); return null; });
  scheduleDelete(chatId, sent?.message_id, ms);
  return sent;
}

async function toOwners(text, reply_markup) {
  await Promise.all(adminIds().map(id => sendMessage(id, text, reply_markup ? { reply_markup } : {})
    .catch(error => console.warn('Чат поддержки: сообщение владельцу', error?.message || error))));
}

function excerptOf(message) {
  const text = String(message?.text ?? message?.caption ?? '').trim();
  const kind = message?.photo ? '[фото] ' : message?.video ? '[видео] ' : message?.document ? '[файл] ' : message?.sticker ? '[стикер] ' : message?.voice ? '[голосовое] ' : '';
  return `${kind}${text}`.slice(0, 500) || '(без текста)';
}

function messageLink(chat, messageId) {
  if (chat?.username) return `https://t.me/${chat.username}/${messageId}`;
  const internal = rules.internalChatId(chat?.id);
  return internal ? `https://t.me/c/${internal}/${messageId}` : '';
}

async function saveWarning({ chatId, user, rule, reason, excerpt, messageId, issuedBy }) {
  try {
    const rows = await supabaseFetch('support_chat_warnings', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        chat_id: chatId, telegram_user_id: Number(user.id), username: user.username || null, name: nameOf(user).slice(0, 120),
        rule, reason: String(reason || '').slice(0, 300), excerpt: String(excerpt || '').slice(0, 600),
        message_id: messageId || null, issued_by: issuedBy || null,
      }),
    });
    return Array.isArray(rows) ? rows[0]?.id ?? null : null;
  } catch (error) {
    console.warn('Чат поддержки: запись предупреждения', error?.message || error);
    return null;
  }
}

async function warningCount(tgId) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabaseFetchWithMeta(`support_chat_warnings?telegram_user_id=eq.${Number(tgId)}&revoked_at=is.null&created_at=gte.${encodeURIComponent(since)}&select=id&limit=1`, { headers: { Range: '0-0' } })
    .catch(() => ({ count: null }));
  return count;
}

function punishKeyboard(tgId, warningId) {
  return {
    inline_keyboard: [
      [{ text: `🔇 Мут ${DEFAULT_MUTE_HOURS} ч`, callback_data: `md:mute:${tgId}` }, { text: '⛔ Бан', callback_data: `md:ban:${tgId}` }],
      ...(warningId ? [[{ text: '✅ Ошибка бота — снять', callback_data: `md:ok:${warningId}` }]] : []),
    ],
  };
}

const noticeAt = new Map(), alertAt = new Map();

/** Нарушение: удалить, объяснить в чате, записать и сообщить владельцу. */
async function punish(message, found) {
  const chat = message.chat, user = message.from;
  await deleteMessage(chat.id, message.message_id);
  if (!throttled(noticeAt, user.id, NOTICE_EVERY_MS)) {
    await sendTemp(chat.id, `${userLink(user)}, сообщение удалено: ${escapeHtml(found.reason)}`);
  }
  if (throttled(alertAt, user.id, ALERT_EVERY_MS)) return;
  const excerpt = excerptOf(message);
  const warningId = await saveWarning({ chatId: chat.id, user, rule: found.rule, reason: found.reason, excerpt, messageId: message.message_id });
  const count = await warningCount(user.id);
  await toOwners([
    '<b>⚠️ Предупреждение в чате поддержки</b>',
    `Кто: ${userLine(user)}`,
    `За что: ${escapeHtml(found.label)}${found.detail ? ` — <code>${escapeHtml(found.detail)}</code>` : ''}`,
    `Сообщение (удалено): <i>${escapeHtml(excerpt)}</i>`,
    ...(count != null ? [`Предупреждений за 30 дней: <b>${count}</b>`] : []),
  ].join('\n'), punishKeyboard(user.id, warningId));
}

// --- Мут, бан, снятие --------------------------------------------------------------------------------------

const NO_PERMISSIONS = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false,
  can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false,
  can_send_other_messages: false, can_add_web_page_previews: false, can_change_info: false,
  can_invite_users: false, can_pin_messages: false, can_manage_topics: false,
};

function mute(chatId, tgId, hours = DEFAULT_MUTE_HOURS) {
  return telegramRequest('restrictChatMember', {
    chat_id: chatId, user_id: Number(tgId), permissions: NO_PERMISSIONS,
    use_independent_chat_permissions: true, until_date: Math.floor(Date.now() / 1000) + Math.round(hours * 3600),
  });
}

/** Снять мут: права как у всех участников чата (из настроек группы). */
async function unmute(chatId, tgId) {
  slowUntil.delete(Number(tgId));
  const chat = await telegramRequest('getChat', { chat_id: chatId }).catch(() => null);
  const permissions = chat?.permissions || Object.fromEntries(Object.keys(NO_PERMISSIONS).map(key => [key, !['can_change_info', 'can_pin_messages', 'can_manage_topics'].includes(key)]));
  return telegramRequest('restrictChatMember', { chat_id: chatId, user_id: Number(tgId), permissions, use_independent_chat_permissions: true });
}

function ban(chatId, tgId) { return telegramRequest('banChatMember', { chat_id: chatId, user_id: Number(tgId) }); }
function unban(chatId, tgId) { return telegramRequest('unbanChatMember', { chat_id: chatId, user_id: Number(tgId), only_if_banned: true }); }

function rightsError(error) {
  const text = String(error?.message || error || '');
  if (/not enough rights|administrator|CHAT_ADMIN_REQUIRED/i.test(text)) return 'у бота нет прав администратора («Блокировка пользователей» / «Удаление сообщений»)';
  if (/can't remove chat owner|user is an administrator|USER_ADMIN_INVALID/i.test(text)) return 'это администратор чата';
  if (/user not found|PARTICIPANT_ID_INVALID/i.test(text)) return 'человека нет в чате';
  return text.slice(0, 120) || 'ошибка Telegram';
}

// --- Команды в чате ----------------------------------------------------------------------------------------

const RULES_TEXT = [
  '<b>📋 Правила чата поддержки</b>',
  '1. Вопросы — по «Помощнику ПВЗ», «ПВЗ Принт», боту и сайту shk-wb.ru.',
  '2. Ссылки — только на Wildberries, Ozon и shk-wb.ru. Остальные бот удаляет: так мы защищаем участников от мошенников.',
  '3. Без мата, оскорблений, рекламы и пересылок из других каналов.',
  '4. Не публикуйте номера карт, пароли, коды из SMS и коды входа WB — их видят все. Поддержка их никогда не просит.',
  'За нарушение бот удаляет сообщение и выдаёт предупреждение.',
].join('\n');

const reportsLog = new Map(); // tg → [at]

function reportAllowed(tgId, now = Date.now()) {
  const recent = (reportsLog.get(tgId) || []).filter(at => now - at < 60 * 60 * 1000);
  if (recent.length >= REPORTS_PER_HOUR) return false;
  recent.push(now);
  boundedSet(reportsLog, tgId, recent);
  return true;
}

async function dmIssuer(chatId, issuer, text, extra = {}) {
  try {
    await sendMessage(issuer.id, text, extra);
  } catch {
    await sendTemp(chatId, `${userLink(issuer)}, откройте личный чат с ботом и нажмите «Запустить» — ответ придёт туда.`, 30_000);
  }
}

async function recentWarningsText(tgId) {
  const filter = tgId ? `telegram_user_id=eq.${Number(tgId)}&` : '';
  const rows = await supabaseFetch(`support_chat_warnings?${filter}select=id,telegram_user_id,username,name,rule,excerpt,created_at,revoked_at&order=created_at.desc&limit=10`).catch(() => null);
  if (!Array.isArray(rows)) return 'Не получилось прочитать журнал предупреждений.';
  if (!rows.length) return tgId ? 'Предупреждений нет.' : 'Журнал предупреждений пуст.';
  const date = value => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  return [
    `<b>Предупреждения${tgId ? '' : ' в чате'} — последние ${rows.length}</b>`,
    ...rows.map(row => `${row.revoked_at ? '<s>' : ''}${date(row.created_at)} · ${escapeHtml(rules.RULES[row.rule]?.label || row.rule)}`
      + `${tgId ? '' : ` · ${escapeHtml(row.name || '')}${row.username ? ` @${escapeHtml(row.username)}` : ''} (<code>${row.telegram_user_id}</code>)`}`
      + `${row.revoked_at ? '</s> (снято)' : ''}\n   <i>${escapeHtml(String(row.excerpt || '').slice(0, 120))}</i>`),
  ].join('\n');
}

const COMMAND = /^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i;
const MODERATOR_COMMANDS = new Set(['who', 'warn', 'mute', 'unmute', 'ban', 'unban', 'warns']);

async function handleCommand(message, moderator) {
  const match = COMMAND.exec(String(message.text || '').trim());
  if (!match) return false;
  const [, rawName, target, rawArgs] = match;
  const bot = (await deps.botUsername().catch(() => '')).toLowerCase();
  if (target && bot && target.toLowerCase() !== bot) return false; // команда другому боту
  const name = rawName.toLowerCase(), args = String(rawArgs || '').trim();
  const chat = message.chat, issuer = message.from;
  await deleteMessage(chat.id, message.message_id);
  const reply = message.reply_to_message && !message.reply_to_message.forum_topic_created ? message.reply_to_message : null;
  const victim = reply?.from && !reply.sender_chat ? reply.from : null;

  if (name === 'rules') { await sendTemp(chat.id, RULES_TEXT, 2 * 60 * 1000); return true; }
  if (name === 'report') {
    if (!victim) { await sendTemp(chat.id, `${userLink(issuer)}, ответьте командой /report на сообщение, на которое жалуетесь.`, 20_000); return true; }
    if (!reportAllowed(issuer.id)) { await sendTemp(chat.id, `${userLink(issuer)}, жалобы — не больше ${REPORTS_PER_HOUR} в час.`, 20_000); return true; }
    const link = messageLink(chat, reply.message_id);
    await toOwners([
      '<b>🚩 Жалоба в чате поддержки</b>',
      `На кого: ${userLine(victim)}`,
      `Сообщение: <i>${escapeHtml(excerptOf(reply))}</i>`,
      ...(link ? [`<a href="${link}">Открыть в чате</a>`] : []),
      `Пожаловался: ${userLine(issuer)}`,
    ].join('\n'), { inline_keyboard: [
      [{ text: '🗑 Удалить сообщение', callback_data: `md:del:${reply.message_id}` }],
      [{ text: `🔇 Мут ${DEFAULT_MUTE_HOURS} ч`, callback_data: `md:mute:${victim.id}` }, { text: '⛔ Бан', callback_data: `md:ban:${victim.id}` }],
    ] });
    await sendTemp(chat.id, `${userLink(issuer)}, спасибо — жалоба отправлена поддержке.`, 15_000);
    return true;
  }
  if (MODERATOR_COMMANDS.has(name)) {
    if (!moderator) return true; // молча: команда уже удалена
    if (name === 'warns') { await dmIssuer(chat.id, issuer, await recentWarningsText(victim?.id)); return true; }
    if (!victim) { await sendTemp(chat.id, `Ответьте командой /${name} на сообщение участника.`, 15_000); return true; }
    if (await isModerator(chat.id, victim.id)) { await sendTemp(chat.id, 'Это администратор чата.', 15_000); return true; }
    try {
      if (name === 'who') {
        const summary = deps.whoSummary ? await deps.whoSummary(victim).catch(() => null) : null;
        const count = await warningCount(victim.id);
        await dmIssuer(chat.id, issuer, [
          '<b>👤 Участник чата поддержки</b>',
          userLine(victim),
          ...(summary ? ['', summary] : []),
          ...(count != null ? ['', `Предупреждений за 30 дней: <b>${count}</b>`] : []),
        ].join('\n'), { reply_markup: punishKeyboard(victim.id, null) });
      } else if (name === 'warn') {
        const reason = args || rules.RULES.manual.reason;
        await saveWarning({ chatId: chat.id, user: victim, rule: 'manual', reason, excerpt: excerptOf(reply), messageId: reply.message_id, issuedBy: issuer.id });
        await sendTemp(chat.id, `${userLink(victim)}, предупреждение: ${escapeHtml(reason)}`);
        if (!isOwner(issuer.id)) await toOwners(`<b>⚠️ ${userLink(issuer)} выдал(а) предупреждение</b>\nКому: ${userLine(victim)}\nЗа что: ${escapeHtml(reason)}`, punishKeyboard(victim.id, null));
      } else if (name === 'mute') {
        const hours = Math.min(Math.max(Number.parseFloat(args) || DEFAULT_MUTE_HOURS, 0.1), 24 * 365);
        await mute(chat.id, victim.id, hours);
        await sendTemp(chat.id, `${userLink(victim)} не может писать в чат ${hours} ч.`);
      } else if (name === 'unmute') {
        await unmute(chat.id, victim.id);
        await sendTemp(chat.id, `${userLink(victim)} снова может писать в чат.`);
      } else if (name === 'ban') {
        await ban(chat.id, victim.id);
        await deleteMessage(chat.id, reply.message_id);
        await sendTemp(chat.id, `${escapeHtml(nameOf(victim))} удалён(а) из чата.`);
      } else if (name === 'unban') {
        await unban(chat.id, victim.id);
        await sendTemp(chat.id, `${escapeHtml(nameOf(victim))} может вернуться в чат.`, 15_000);
      }
    } catch (error) {
      await sendTemp(chat.id, `Не получилось: ${escapeHtml(rightsError(error))}.`, 20_000);
    }
    return true;
  }
  // Команды личного бота (/start, /menu…) — подсказка с кнопкой в личный чат
  await sendTemp(chat.id, `${userLink(issuer)}, команды бота работают в личном чате.`, 30_000,
    bot ? { reply_markup: { inline_keyboard: [[{ text: '🤖 Открыть бота', url: `https://t.me/${bot}` }]] } } : {});
  return true;
}

// --- Кнопки владельца в личке (md:…) -----------------------------------------------------------------------

const MD_CALLBACK = /^md:(mute|unmute|ban|unban|ok|del):(\d+)$/;

function isModerationCallback(data) { return MD_CALLBACK.test(String(data || '')); }

function answer(callbackId, text, alert = false) {
  return telegramRequest('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text: String(text).slice(0, 200), show_alert: alert } : {}) }).catch(() => {});
}

function setButtons(callback, rows) {
  const chatId = callback.message?.chat?.id, messageId = callback.message?.message_id;
  if (!chatId || !messageId) return Promise.resolve();
  return telegramRequest('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } })
    .catch(error => console.warn('Чат поддержки: кнопки', error?.message || error));
}

function withoutButton(callback, prefix) {
  return (callback.message?.reply_markup?.inline_keyboard || [])
    .map(row => row.filter(button => !String(button.callback_data || '').startsWith(prefix)))
    .filter(row => row.length);
}

async function handleAdminCallback(callback) {
  const match = MD_CALLBACK.exec(String(callback.data || ''));
  if (!match) return false;
  if (!isOwner(callback.from?.id)) { await answer(callback.id, 'Нет доступа'); return true; }
  const chatId = supportChatId();
  if (!chatId) { await answer(callback.id, 'Чат поддержки не настроен (SUPPORT_CHAT_ID)', true); return true; }
  const [, action, id] = match;
  try {
    if (action === 'mute') {
      await mute(chatId, id);
      await setButtons(callback, [[{ text: '🔊 Снять мут', callback_data: `md:unmute:${id}` }, { text: '⛔ Бан', callback_data: `md:ban:${id}` }]]);
      await answer(callback.id, `Мут на ${DEFAULT_MUTE_HOURS} ч`);
    } else if (action === 'unmute') {
      await unmute(chatId, id);
      await setButtons(callback, punishKeyboard(id, null).inline_keyboard);
      await answer(callback.id, 'Мут снят');
    } else if (action === 'ban') {
      await ban(chatId, id);
      await setButtons(callback, [[{ text: '♻️ Разбанить', callback_data: `md:unban:${id}` }]]);
      await answer(callback.id, 'Удалён из чата');
    } else if (action === 'unban') {
      await unban(chatId, id);
      await setButtons(callback, punishKeyboard(id, null).inline_keyboard);
      await answer(callback.id, 'Бан снят — может вернуться по ссылке');
    } else if (action === 'ok') {
      await supabaseFetch(`support_chat_warnings?id=eq.${Number(id)}`, { method: 'PATCH', body: JSON.stringify({ revoked_at: new Date().toISOString() }) });
      await setButtons(callback, withoutButton(callback, 'md:ok:'));
      await answer(callback.id, 'Предупреждение снято');
    } else if (action === 'del') {
      await telegramRequest('deleteMessage', { chat_id: chatId, message_id: Number(id) });
      await setButtons(callback, withoutButton(callback, 'md:del:'));
      await answer(callback.id, 'Сообщение удалено');
    }
  } catch (error) {
    await answer(callback.id, `Не получилось: ${rightsError(error)}`, true);
  }
  return true;
}

// --- Членство бота в группах -------------------------------------------------------------------------------

async function handleBotMembership(update) {
  const event = update.my_chat_member;
  const chat = event?.chat, status = event?.new_chat_member?.status;
  if (!isGroupChat(chat) || !status) return;
  const title = `«${escapeHtml(chat.title || chat.username || chat.id)}»`;
  if (status === 'left' || status === 'kicked') {
    if (isSupportChat(chat)) await toOwners(`<b>⚠️ Бота убрали из чата поддержки ${title}</b>\nМодерация не работает, пока бот не вернётся администратором.`);
    return;
  }
  const member = event.new_chat_member;
  const lines = [`<b>🤖 Бот в группе ${title}</b>`, `ID группы: <code>${chat.id}</code>`];
  if (!isSupportChat(chat)) lines.push(`Чтобы бот модерировал её, пропишите <code>SUPPORT_CHAT_ID=${chat.id}</code> в .env узла бота и перезапустите его. Пока он в ней молчит.`);
  if (status !== 'administrator') lines.push('Сделайте бота администратором с правами «Удаление сообщений» и «Блокировка пользователей».');
  else if (!member.can_delete_messages || !member.can_restrict_members) lines.push('Не хватает прав: нужны «Удаление сообщений» и «Блокировка пользователей».');
  else lines.push('Права в порядке ✅');
  adminCache.delete(chat.id);
  await toOwners(lines.join('\n'));
}

// --- Вход ---------------------------------------------------------------------------------------------------

/** Апдейт из группы. Чужие группы — тишина. */
async function handleGroupUpdate(update) {
  if (update.my_chat_member) return handleBotMembership(update);
  const message = update.message || update.edited_message;
  if (!message || !isSupportChat(message.chat)) return;
  const edited = !update.message;
  const chat = message.chat;
  // «Вошёл / вышел» — служебный мусор
  if (message.new_chat_members || message.left_chat_member) { await deleteMessage(chat.id, message.message_id); return; }
  if (message.is_automatic_forward) return; // пост привязанного канала
  const user = message.from;
  if (!user) return;
  // Анонимный админ пишет от имени самого чата
  const moderator = message.sender_chat?.id === chat.id || await isModerator(chat.id, user.id);
  if (!edited && /^\//.test(String(message.text || '')) && await handleCommand(message, moderator)) return;
  if (moderator) return;
  const text = String(message.text ?? message.caption ?? '');
  if (!edited) {
    boundedSet(messageCounts, user.id, (messageCounts.get(user.id) || 0) + 1);
    if (isFlood(user.id, text, Date.now(), message.media_group_id || null)) {
      boundedSet(slowUntil, user.id, Date.now() + SLOW_MODE_MS);
      await punish(message, rules.verdict('flood'));
      await slowDown(chat.id, user.id);
      return;
    }
  }
  const allowed = await allowedTelegram(chat);
  const ctx = { chatId: chat.id, botUsername: await deps.botUsername().catch(() => ''), allowedTelegram: allowed, mentionKinds: await mentionKinds(message, allowed), newcomer: false };
  let found = rules.classify(message, ctx);
  if (!found && rules.findSpam(text) && await isNewcomer(user.id)) found = rules.classify(message, { ...ctx, newcomer: true });
  if (found) await punish(message, found);
  if (!edited && inSlowMode(user.id)) await slowDown(chat.id, user.id);
}

/** Для тестов: забыть всё, что держится в памяти. */
function resetSupportChatState() {
  for (const map of [adminCache, mentionCache, messageCounts, subscriberCache, floodLog, mediaGroups, slowUntil, noticeAt, alertAt, reportsLog]) map.clear();
}

module.exports = {
  RULES_TEXT, configure, handleAdminCallback, handleGroupUpdate, isFlood, isGroupUpdate, isModerationCallback,
  isSupportChat, resetSupportChatState, supportChatId,
};
