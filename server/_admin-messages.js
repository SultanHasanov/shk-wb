// Сообщения администрации одному пользователю (админка → карточка → «Написать»).
//
// Четыре канала: кабинет (in_app_notifications), почта (Resend), Telegram (бот), ПК «Помощника ПВЗ»
// (app_device_messages, created_by = 'admin'). Итог — по каждому каналу отдельно: ненастроенная почта,
// не запущенный бот или выключенный ПК не выдаются за «отправлено».
//
// Повтор: ключ доставки (dedupeBase) уникален на действие — message → id строки журнала, кошелёк →
// `wallet:<id>`, ограничение → `restrict:<id>` / `lift:<id>`. Строки notification_deliveries для Telegram
// и ПК вставляются ДО отправки: повтор того же действия упирается в уникальный dedupe_key (409) и второе
// сообщение не уходит.
//
// Модуль прав не проверяет: зовётся после requireAdmin (api/admin/data.js → _admin-users.js / _admin-audit.js).
const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { getAuthUser } = require('./_user-auth');
const { createNotification, sendEmail, resendSend, emailConfigured, NOT_CONFIGURED_ERROR } = require('./_notifications');
const { sendMessage } = require('./_telegram-api');
const { enforceRateLimit } = require('./_rate-limit');
// Модуль целиком, а не деструктуризация: функции повтора (runIdempotent и др.) берутся в момент вызова.
const grants = require('./_admin-grants');

const MESSAGE_LIMITS = Object.freeze({ subject: 160, body: 4000, link: 500, pc: 500, cabinetBody: 2000, telegram: 4096, devices: 10 });
const CHANNELS = Object.freeze(['cabinet', 'email', 'telegram', 'pc']);
const OK_STATUSES = new Set(['sent', 'queued', 'duplicate']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;
const EMAIL_FOOTER = '\n\n—\nПисьмо пришло, потому что у вас есть аккаунт на shk-wb.ru';

// ---------- общие помощники (переехали из _admin-cabinet.js без изменения поведения) ----------

function escapeHtml(value){return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function personalize(template,subscriber){
  const firstName=subscriber.first_name||'';
  const values={
    name:firstName||subscriber.username||'друг',
    first_name:firstName,
    last_name:subscriber.last_name||'',
    username:subscriber.username?`@${subscriber.username}`:'',
  };
  return template.replace(/[&<>]|\{(name|first_name|last_name|username)\}/g,(match,key)=>key?escapeHtml(values[key]):escapeHtml(match));
}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function sendWithRetry(chatId,text,options){
  try{return await sendMessage(chatId,text,options)}
  catch(error){
    const retryAfter=Number(error.details?.parameters?.retry_after||0);
    if(error.status===429&&retryAfter>0){await delay(Math.min(retryAfter,10)*1000);return sendMessage(chatId,text,options)}
    throw error;
  }
}

// ---------- тексты ----------

/** Текст окна на ПК: ровно так же считает src/lib/admin-controls.ts (pcMessageText). */
function pcMessageText(subject, body) {
  const text = `Администрация ШК ВБ: ${subject}\n${body}`.replace(/\r\n/g, '\n').trim();
  return text.length > MESSAGE_LIMITS.pc ? `${text.slice(0, MESSAGE_LIMITS.pc - 1)}…` : text;
}

/** '/x' → полный адрес сайта; 'https://…' как есть; иначе null. */
function absoluteLink(link) {
  const value = String(link || '').trim();
  if (!value) return null;
  if (value.startsWith('/')) return `${String(process.env.PUBLIC_APP_URL || 'https://shk-wb.ru').replace(/\/+$/, '')}${value}`;
  if (/^https:\/\/\S+$/.test(value)) return value;
  return null;
}

function isValidLink(link) {
  return link === '' || ((/^\/[^\s]*$/.test(link) || /^https:\/\/\S+$/.test(link)) && link.length <= MESSAGE_LIMITS.link);
}

function cabinetBody(body) {
  // check in_app_notifications.body ≤ 2000: slice(0,2000)+'…' дал бы 2001 символ
  return body.length > MESSAGE_LIMITS.cabinetBody ? `${body.slice(0, MESSAGE_LIMITS.cabinetBody - 1)}…` : body;
}

function emailText(body, link) {
  const url = absoluteLink(link);
  return `${body}${url ? `\n\n${url}` : ''}${EMAIL_FOOTER}`;
}

/** HTML для Telegram не длиннее 4096: обрезаем экранированный текст, не разрывая сущность «&amp;». */
function telegramText(subject, body) {
  const head = `<b>${escapeHtml(subject)}</b>\n\n`;
  let text = escapeHtml(body);
  const room = MESSAGE_LIMITS.telegram - head.length;
  if (text.length > room) text = `${text.slice(0, Math.max(0, room - 1)).replace(/&[a-z]*$/i, '')}…`;
  return head + text;
}

/**
 * Кнопки под сообщением в Telegram. keyboard — свои кнопки бота (callback_data вместо ссылки в кабинет сайта:
 * у того, кто работает только в боте, входа на сайт нет); без него — кнопка «Открыть» по ссылке.
 */
function telegramOptions(link, keyboard = null) {
  // Кнопки бота — n:<callback> (server/_bot-notice.js): раздел откроется новым сообщением, это останется в чате.
  if (Array.isArray(keyboard) && keyboard.length) return { parse_mode: 'HTML', reply_markup: { inline_keyboard: require('./_bot-notice').noticeRows(keyboard) } };
  const url = absoluteLink(link);
  return { parse_mode: 'HTML', ...(url ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть', url }]] } } : {}) };
}

function isTelegramUnavailable(error) {
  return error?.status === 403 || /blocked|chat not found|deactivated/i.test(String(error?.message || ''));
}

function cleanBody(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function errorText(error) {
  return String(error?.message || error || 'Ошибка').slice(0, 300);
}

function enc(value) {
  return encodeURIComponent(String(value));
}

function unique(list) {
  return [...new Set(list)];
}

function adminError(status, code, message, extra) {
  if (typeof grants.adminError === 'function') return grants.adminError(status, code, message, extra);
  return Object.assign(new Error(message), { status, code, extra });
}

function validationError(res, error) {
  return res.status(400).json({ error, code: 'VALIDATION_ERROR' });
}

// ---------- проверка тела ----------

function validateMessageBody(body) {
  const input = body && typeof body === 'object' ? body : {};
  const channels = Array.isArray(input.channels) ? input.channels.map(String) : [];
  if (!channels.length) return { error: 'Выберите хотя бы один канал' };
  if (channels.some(channel => !CHANNELS.includes(channel))) return { error: 'Неизвестный канал' };
  if (new Set(channels).size !== channels.length) return { error: 'Каналы повторяются' };
  const subject = String(input.subject ?? '').trim();
  if (!subject) return { error: 'Введите тему' };
  if (subject.length > MESSAGE_LIMITS.subject) return { error: `Тема — не больше ${MESSAGE_LIMITS.subject} символов` };
  const text = cleanBody(input.body);
  if (!text) return { error: 'Введите текст сообщения' };
  if (text.length > MESSAGE_LIMITS.body) return { error: `Текст — не больше ${MESSAGE_LIMITS.body} символов` };
  const link = String(input.link ?? '').trim();
  if (!isValidLink(link)) return { error: 'Ссылка: путь на сайте (/cabinet…) или адрес https://' };
  let deviceIds = [];
  if (channels.includes('pc')) {
    const raw = Array.isArray(input.deviceIds) ? input.deviceIds.map(String) : [];
    if (!raw.length) return { error: 'Выберите компьютер для сообщения на ПК' };
    if (raw.some(id => !UUID_RE.test(id))) return { error: 'Некорректный компьютер' };
    deviceIds = unique(raw);
    if (deviceIds.length > MESSAGE_LIMITS.devices) return { error: `Не больше ${MESSAGE_LIMITS.devices} компьютеров за раз` };
  }
  const idempotencyKey = String(input.idempotencyKey ?? '');
  if (!KEY_RE.test(idempotencyKey)) return { error: 'Нет ключа повтора — обновите страницу' };
  return { channels, subject, text, link: link || null, deviceIds, idempotencyKey };
}

// ---------- строки доставок ----------

/** Вставка строки доставки до отправки. 'duplicate' — такой dedupe_key уже есть (повтор действия). */
async function insertDelivery(row) {
  try {
    const rows = await supabaseFetch('notification_deliveries', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row),
    });
    return (Array.isArray(rows) ? rows[0] : null) || {};
  } catch (error) {
    if (error.status === 409) return 'duplicate';
    throw error;
  }
}

// Повтор с тем же ключом (после ошибки строка журнала забирается заново) упирается в уже вставленные строки.
// «duplicate» — успех только если та строка ушла или в пути; иначе отдаём её настоящий итог,
// чтобы неудавшаяся отправка не превратилась при повторе в «доставлено».
const DUPLICATE_OK = new Set(['sent', 'pending']);

/** Итог повтора по существующей строке доставки: duplicate (ушло/в пути) или её status с ошибкой. */
async function duplicateOutcome(dedupeKey) {
  let row = null;
  try {
    row = (await supabaseFetch(`notification_deliveries?dedupe_key=eq.${enc(dedupeKey)}&select=id,status,last_error&limit=1`))[0] || null;
  } catch (error) {
    console.error('notification_deliveries lookup failed', error.message);
    return { status: 'failed', error: 'Не удалось проверить прошлую попытку отправки' };
  }
  if (!row) return { status: 'failed', error: 'Прошлая попытка отправки не найдена' };
  if (DUPLICATE_OK.has(row.status)) return { status: 'duplicate', deliveryId: row.id };
  return { status: row.status, deliveryId: row.id, ...(row.last_error ? { error: String(row.last_error).slice(0, 300) } : {}) };
}

async function patchDelivery(id, patch) {
  if (!id) return;
  await supabaseFetch(`notification_deliveries?id=eq.${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
    .catch(error => console.error('notification_deliveries update failed', error.message));
}

// ---------- каналы ----------

async function deliverCabinet({ userId, subject, body, link, key }) {
  const notification = await createNotification({
    userId, kind: 'system', title: subject, body: cabinetBody(body), link: link || null, dedupeKey: key, email: null,
  });
  return notification
    ? { channel: 'cabinet', status: 'sent', notificationId: notification.id }
    : { channel: 'cabinet', status: 'duplicate' };
}

async function deliverEmail({ userId, subject, body, link, key, source, actionId, notificationId }) {
  const user = await getAuthUser(userId);
  const address = user?.email && !String(user.email).endsWith('@users.invalid') ? String(user.email) : null;
  if (!address) return { channel: 'email', status: 'no_address', recipient: null };
  if (!user.email_confirmed_at) return { channel: 'email', status: 'not_confirmed', recipient: address };
  const sent = await sendEmail({
    userId, notificationId: notificationId || null, to: address, subject, text: emailText(body, link),
    dedupeKey: `email:${key}`, source, adminActionId: actionId, recordUnconfigured: true,
  });
  if (sent.status === 'duplicate') return { channel: 'email', recipient: address, ...(await duplicateOutcome(`email:${key}`)) };
  return {
    channel: 'email', status: sent.status, recipient: address,
    ...(sent.providerId ? { providerId: sent.providerId } : {}),
    ...(sent.deliveryId ? { deliveryId: sent.deliveryId } : {}),
    ...(sent.error && sent.status !== 'sent' ? { error: sent.error } : {}),
  };
}

async function telegramTarget(userId) {
  const identities = await supabaseFetch(`user_telegram_identities?user_id=eq.${enc(userId)}&select=telegram_user_id,username&limit=1`);
  const identity = identities[0];
  if (!identity) return { identity: null, subscriber: null, ref: null };
  const ref = identity.username ? `@${identity.username}` : `tg:${identity.telegram_user_id}`;
  const subscribers = await supabaseFetch(`telegram_bot_subscribers?telegram_user_id=eq.${enc(identity.telegram_user_id)}&select=telegram_user_id,chat_id,blocked_at,activated_at&limit=1`);
  return { identity, subscriber: subscribers[0] || null, ref };
}

async function deliverTelegram({ userId, subject, body, link, key, source, actionId, telegram = null }) {
  // Свой текст и кнопки для Telegram (telegram: { subject?, body?, keyboard? }); кабинет и письмо — прежние.
  if (telegram) {
    subject = telegram.subject ? String(telegram.subject) : subject;
    body = telegram.body ? String(telegram.body) : body;
  }
  const { identity, subscriber, ref } = await telegramTarget(userId);
  if (!identity) return { channel: 'telegram', status: 'not_linked', recipient: null };
  if (!subscriber) return { channel: 'telegram', status: 'not_started', recipient: ref };
  if (subscriber.blocked_at) return { channel: 'telegram', status: 'blocked', recipient: ref };
  const delivery = await insertDelivery({
    user_id: userId, channel: 'telegram', recipient: String(subscriber.chat_id), channel_ref: ref,
    subject: subject.slice(0, 200), source, admin_action_id: actionId || null,
    dedupe_key: `tg:${key}`, attempts: 1, status: 'pending',
  });
  if (delivery === 'duplicate') return { channel: 'telegram', recipient: ref, ...(await duplicateOutcome(`tg:${key}`)) };
  try {
    const sent = await sendWithRetry(subscriber.chat_id, telegramText(subject, body), telegramOptions(link, telegram?.keyboard));
    const providerId = sent?.message_id != null ? String(sent.message_id) : null;
    await patchDelivery(delivery.id, { status: 'sent', provider_id: providerId, sent_at: new Date().toISOString() });
    return { channel: 'telegram', status: 'sent', recipient: ref, ...(providerId ? { providerId } : {}), ...(delivery.id ? { deliveryId: delivery.id } : {}) };
  } catch (error) {
    const blocked = isTelegramUnavailable(error);
    if (blocked) {
      await supabaseFetch(`telegram_bot_subscribers?telegram_user_id=eq.${enc(subscriber.telegram_user_id)}`, {
        method: 'PATCH', body: JSON.stringify({ blocked_at: new Date().toISOString() }),
      }).catch(() => {});
    }
    await patchDelivery(delivery.id, { status: blocked ? 'blocked' : 'failed', last_error: errorText(error) });
    return { channel: 'telegram', status: blocked ? 'blocked' : 'failed', recipient: ref, ...(delivery.id ? { deliveryId: delivery.id } : {}), error: errorText(error) };
  }
}

async function deliverPc({ userId, subject, body, key, source, actionId, deviceIds }) {
  if (!deviceIds.length) return [];
  const devices = await supabaseFetch(`app_devices?user_id=eq.${enc(userId)}&id=in.(${deviceIds.map(enc).join(',')})&select=id,name,revoked_at`).catch(() => []);
  const byId = new Map(devices.map(device => [device.id, device]));
  let online = new Set();
  try { online = require('./_app-relay').onlineIds(userId); } catch (_) { /* передатчик недоступен — «не в сети» */ }
  const text = pcMessageText(subject, body);
  const results = [];
  // По очереди: у send() свой предел неотвеченных сообщений на ПК, параллельные вставки его обходят.
  for (const deviceId of deviceIds) {
    const deviceName = byId.get(deviceId)?.name || null;
    const base = { channel: 'pc', deviceId, deviceName, online: online.has(deviceId) };
    let delivery;
    try {
      delivery = await insertDelivery({
        user_id: userId, channel: 'pc', recipient: deviceName || deviceId, subject: subject.slice(0, 200), source,
        admin_action_id: actionId || null, dedupe_key: `pc:${key}:${deviceId}`, attempts: 1, status: 'pending',
      });
    } catch (error) {
      results.push({ ...base, status: 'failed', error: errorText(error) });
      continue;
    }
    if (delivery === 'duplicate') { results.push({ ...base, ...(await duplicateOutcome(`pc:${key}:${deviceId}`)) }); continue; }
    try {
      const message = await require('./_app-messages').send({ userId, deviceId, text, createdBy: 'admin' });
      await patchDelivery(delivery.id, { channel_ref: message.id });
      results.push({ ...base, status: 'queued', messageId: message.id });
    } catch (error) {
      const status = error.status === 404 ? 'not_found' : error.status === 409 ? 'too_many_open' : 'failed';
      await patchDelivery(delivery.id, { status: 'failed', last_error: errorText(error) });
      results.push({ ...base, status, error: errorText(error) });
    }
  }
  return results;
}

/**
 * Разослать одно сообщение по каналам. Ошибка одного канала не мешает другим: она уходит в его итог.
 * dedupeBase обязателен и уникален на действие (см. шапку файла).
 * telegram — необязательно: { subject?, body?, keyboard? } только для Telegram (keyboard — inline_keyboard бота).
 */
async function deliver({ userId, channels, subject, body, link = null, deviceIds = [], actionId = null, source = 'admin', dedupeBase, telegram = null }) {
  if (dedupeBase == null || String(dedupeBase).trim() === '') throw new Error('deliver: dedupeBase is required');
  const key = `admin-msg:${String(dedupeBase)}`;
  const list = (Array.isArray(channels) ? channels : []).filter(channel => CHANNELS.includes(channel));
  const ctx = { userId, subject: String(subject || ''), body: String(body || ''), link: link || null, key, source, actionId, deviceIds: Array.isArray(deviceIds) ? deviceIds : [], telegram: telegram && typeof telegram === 'object' ? telegram : null };
  const guard = (channel, extra = {}) => error => {
    console.error(`admin message ${channel}:`, error.message);
    return { channel, status: 'failed', ...extra, error: errorText(error) };
  };
  const results = {};
  // Сначала кабинет: id уведомления пишется в строку доставки письма.
  if (list.includes('cabinet')) results.cabinet = await deliverCabinet(ctx).catch(guard('cabinet'));
  const notificationId = results.cabinet?.notificationId || null;
  await Promise.all([
    list.includes('email') && deliverEmail({ ...ctx, notificationId }).then(r => { results.email = r; }, e => { results.email = guard('email', { recipient: null })(e); }),
    list.includes('telegram') && deliverTelegram(ctx).then(r => { results.telegram = r; }, e => { results.telegram = guard('telegram', { recipient: null })(e); }),
    list.includes('pc') && deliverPc(ctx).then(r => { results.pc = r; }, e => {
      results.pc = ctx.deviceIds.map(deviceId => guard('pc', { deviceId, deviceName: null, online: false })(e));
    }),
  ]);
  return list.flatMap(channel => (channel === 'pc' ? results.pc || [] : results[channel] ? [results[channel]] : []));
}

function summarize(results) {
  const ok = results.filter(result => OK_STATUSES.has(result.status)).length;
  return { ok, total: results.length, result: ok === results.length && ok > 0 ? 'ok' : ok ? 'partial' : 'error' };
}

// ---------- действия админки ----------

/** GET messageTargets: какие каналы доступны этому пользователю и почему нет. */
async function messageTargets(req, res, { userId }) {
  try {
    const user = await getAuthUser(userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден', code: 'NOT_FOUND' });
    const now = new Date().toISOString();
    const [tg, devices, open] = await Promise.all([
      telegramTarget(userId).catch(() => ({ identity: null, subscriber: null, ref: null })),
      supabaseFetch(`app_devices?user_id=eq.${enc(userId)}&revoked_at=is.null&select=id,name,last_seen_at,role&order=last_seen_at.desc&limit=50`).catch(() => []),
      supabaseFetch(`app_device_messages?user_id=eq.${enc(userId)}&answered_at=is.null&expires_at=gt.${enc(now)}&select=device_id&limit=1000`).catch(() => []),
    ]);
    let online = new Set();
    try { online = require('./_app-relay').onlineIds(userId); } catch (_) { /* нет передатчика */ }
    const address = user.email && !String(user.email).endsWith('@users.invalid') ? String(user.email) : null;
    const confirmed = Boolean(user.email_confirmed_at);
    const configured = emailConfigured();
    const emailReason = !address ? 'no_address' : !confirmed ? 'not_confirmed' : !configured ? 'not_configured' : null;
    const telegramReason = !tg.identity ? 'not_linked' : !tg.subscriber ? 'not_started' : tg.subscriber.blocked_at ? 'blocked' : null;
    const openBy = new Map();
    for (const row of open) openBy.set(row.device_id, (openBy.get(row.device_id) || 0) + 1);
    const list = devices.map(device => ({
      id: device.id,
      name: device.name || 'Компьютер',
      online: online.has(device.id),
      lastSeenAt: device.last_seen_at || null,
      role: device.role === 'owner' || device.role === 'work' ? device.role : null,
      openMessages: openBy.get(device.id) || 0,
    }));
    return res.json({
      cabinet: { available: true },
      email: { available: !emailReason, address, confirmed, configured, reason: emailReason },
      telegram: { available: !telegramReason, username: tg.identity?.username || null, reason: telegramReason, blockedAt: tg.subscriber?.blocked_at || null },
      pc: { available: list.length > 0, reason: list.length ? null : 'no_devices', devices: list },
    });
  } catch (error) {
    return sendError(res, error);
  }
}

/** POST message: одно сообщение по выбранным каналам, итог по каждому. */
async function message(req, res, { userId }) {
  const checked = validateMessageBody(req.body);
  if (checked.error) return validationError(res, checked.error);
  if (!await enforceRateLimit(req, res, { scope: 'admin-message', limit: 30, windowSeconds: 600, key: 'admin' })) return;
  const { channels, subject, text, link, deviceIds, idempotencyKey } = checked;
  return grants.runIdempotent(req, res, {
    action: 'message', key: idempotencyKey, userId,
    payload: { channels, subject, body: text, link, deviceIds },
  }, async ({ actionId }) => {
    const results = await deliver({ userId, channels, subject, body: text, link, deviceIds, actionId, source: 'admin', dedupeBase: String(actionId) });
    const { ok, total, result } = summarize(results);
    return {
      status: 201,
      result,
      after: { channels, delivered: `${ok} из ${total}` },
      body: { actionId, messageRef: `msg_${actionId}`, sentAt: new Date().toISOString(), subject, results, summary: { ok, total } },
    };
  });
}

/** Старое окно «Уведомить» ({title, body, link?}): кабинет + почта, без ключа повтора. */
async function notifyCompat(req, res, { userId }) {
  const title = String(req.body?.title ?? '').trim();
  const text = cleanBody(req.body?.body);
  const link = String(req.body?.link ?? '').trim();
  if (!title || title.length > MESSAGE_LIMITS.subject || !text || text.length > MESSAGE_LIMITS.cabinetBody) return validationError(res, 'Заполните заголовок и текст');
  if (!isValidLink(link)) return validationError(res, 'Ссылка: путь на сайте (/cabinet…) или адрес https://');
  const key = KEY_RE.test(String(req.body?.idempotencyKey || '')) ? String(req.body.idempotencyKey) : `compat-${crypto.randomUUID()}`;
  const channels = ['cabinet', 'email'];
  return grants.runIdempotent(req, res, {
    action: 'notify', key, userId,
    payload: { title, channels, subject: title, body: text, link: link || null },
  }, async ({ actionId }) => {
    const results = await deliver({ userId, channels, subject: title, body: text, link: link || null, actionId, source: 'admin', dedupeBase: String(actionId) });
    const { ok, total, result } = summarize(results);
    return { status: 201, result, after: { channels, delivered: `${ok} из ${total}` }, body: { sent: ok > 0, results } };
  });
}

// ---------- ленты для карточки и журнала ----------

/** Подписи пользователей одним RPC (почта, имя, Telegram). Сбой — пустой список. */
async function userLabels(ids) {
  const list = unique((ids || []).filter(id => UUID_RE.test(String(id || '')))).slice(0, 200);
  if (!list.length) return new Map();
  const rows = await supabaseFetch('rpc/admin_user_labels', { method: 'POST', body: JSON.stringify({ p_ids: list }) }).catch(error => {
    console.error('admin_user_labels:', error.message);
    return [];
  });
  return new Map((Array.isArray(rows) ? rows : []).map(row => [row.user_id, row]));
}

function answerText(row) {
  if (!row?.answered_at) return null;
  if (row.answer_kind === 'reply') return row.reply_text || 'Ответ';
  let labels = {};
  try { labels = require('./_app-messages').ANSWERS || {}; } catch (_) { /* без подписей */ }
  return labels[row.answer_kind] || row.answer_kind || null;
}

function pcDerivedStatus(message, now = Date.now()) {
  if (!message) return null;
  if (message.delivered_at || message.read_at || message.answered_at) return 'sent';
  if (message.expires_at && Date.parse(message.expires_at) < now) return 'expired';
  return 'pending';
}

function retryable(row, actionName) {
  return row?.source === 'admin'
    && (row.channel === 'email' || row.channel === 'telegram')
    && (row.status === 'failed' || row.status === 'not_configured')
    && row.admin_action_id != null
    && (actionName === 'message' || actionName === 'notify');
}

/** Строки notification_deliveries → AdminDelivery[] (контракт 3.6). Догружает действия, сообщения ПК и подписи одним запросом каждое. */
async function deliveryDtos(rows, { labels = true } = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return [];
  const actionIds = unique(list.map(row => row.admin_action_id).filter(id => /^\d+$/.test(String(id ?? ''))));
  const pcIds = unique(list.filter(row => row.channel === 'pc' && UUID_RE.test(String(row.channel_ref || ''))).map(row => row.channel_ref));
  const [actions, pcRows, labelMap] = await Promise.all([
    actionIds.length ? supabaseFetch(`admin_actions?id=in.(${actionIds.join(',')})&select=id,action`).catch(() => []) : [],
    pcIds.length ? supabaseFetch(`app_device_messages?id=in.(${pcIds.join(',')})&select=id,delivered_at,read_at,answered_at,answer_kind,reply_text,expires_at`).catch(() => []) : [],
    labels ? userLabels(list.map(row => row.user_id)) : new Map(),
  ]);
  const actionById = new Map(actions.map(row => [String(row.id), row.action]));
  const pcById = new Map(pcRows.map(row => [row.id, row]));
  const now = Date.now();
  return list.map(row => {
    const pcMessage = row.channel === 'pc' ? pcById.get(row.channel_ref) || null : null;
    const status = row.channel === 'pc' && row.status === 'pending' && pcMessage ? pcDerivedStatus(pcMessage, now) : row.status;
    const label = row.user_id ? labelMap.get(row.user_id) : null;
    return {
      id: row.id,
      createdAt: row.created_at,
      channel: row.channel || 'email',
      status,
      recipient: row.recipient,
      channelRef: row.channel_ref ?? null,
      subject: row.subject ?? null,
      source: row.source || 'system',
      userId: row.user_id ?? null,
      user: label ? { email: label.email ?? null, displayName: label.display_name ?? null } : null,
      providerId: row.provider_id ?? null,
      attempts: Number(row.attempts || 0),
      lastError: row.last_error ?? null,
      sentAt: row.sent_at ?? null,
      adminActionId: row.admin_action_id != null ? Number(row.admin_action_id) : null,
      canRetry: retryable(row, actionById.get(String(row.admin_action_id))),
      pc: row.channel === 'pc' ? {
        deviceName: UUID_RE.test(String(row.recipient || '')) ? null : row.recipient || null,
        deliveredAt: pcMessage?.delivered_at ?? null,
        readAt: pcMessage?.read_at ?? null,
        answeredAt: pcMessage?.answered_at ?? null,
        answer: answerText(pcMessage),
      } : null,
    };
  });
}

const SENT_STATUS = Object.freeze({
  sent: 'sent', duplicate: 'sent', queued: 'pending', pending: 'pending', read: 'read', expired: 'expired',
  failed: 'failed', skipped: 'failed', not_found: 'failed', too_many_open: 'failed',
  not_configured: 'not_configured', blocked: 'blocked', not_linked: 'not_linked', not_started: 'not_started',
  no_address: 'no_address', not_confirmed: 'not_confirmed',
});

function sentStatus(value) {
  return SENT_STATUS[value] || 'failed';
}

/** Сообщения админа пользователю (журнал message/notify) с живым состоянием каналов. */
async function sentMessages(userId) {
  const q = enc(userId);
  const actions = await supabaseFetch(`admin_actions?target_user_id=eq.${q}&action=in.(message,notify)&select=id,created_at,action,payload,result,response&order=id.desc&limit=30`);
  if (!actions.length) return { items: [] };
  const ids = actions.map(row => row.id);
  const keys = ids.map(id => `admin-msg:${id}`);
  const [deliveries, notifications] = await Promise.all([
    supabaseFetch(`notification_deliveries?admin_action_id=in.(${ids.join(',')})&select=id,channel,status,recipient,channel_ref,sent_at,created_at,admin_action_id,dedupe_key&limit=500`).catch(() => []),
    supabaseFetch(`in_app_notifications?user_id=eq.${q}&dedupe_key=in.(${keys.map(key => `"${key}"`).join(',')})&select=dedupe_key,read_at,created_at&limit=100`).catch(() => []),
  ]);
  const pcIds = unique(deliveries.filter(row => row.channel === 'pc' && UUID_RE.test(String(row.channel_ref || ''))).map(row => row.channel_ref));
  const pcRows = pcIds.length
    ? await supabaseFetch(`app_device_messages?id=in.(${pcIds.join(',')})&select=id,delivered_at,read_at,answered_at,expires_at`).catch(() => [])
    : [];
  const pcById = new Map(pcRows.map(row => [row.id, row]));
  const notificationByKey = new Map(notifications.map(row => [row.dedupe_key, row]));
  const now = Date.now();
  const items = actions.map(action => {
    const payload = action.payload || {};
    const own = deliveries.filter(row => String(row.admin_action_id) === String(action.id));
    const results = Array.isArray(action.response?.results) ? action.response.results : null;
    const channelList = results
      ? results
      : (Array.isArray(payload.channels) ? payload.channels : ['cabinet']).flatMap(channel => (channel === 'pc'
        ? (Array.isArray(payload.deviceIds) ? payload.deviceIds : []).map(deviceId => ({ channel: 'pc', deviceId, status: 'pending' }))
        : [{ channel, status: 'sent' }]));
    const channels = channelList.map(result => {
      if (result.channel === 'cabinet') {
        const notification = notificationByKey.get(`admin-msg:${action.id}`);
        const status = notification?.read_at ? 'read' : sentStatus(result.status);
        return { channel: 'cabinet', status, recipient: null, at: notification?.read_at || notification?.created_at || action.created_at };
      }
      if (result.channel === 'pc') {
        const row = own.find(item => item.channel === 'pc' && String(item.dedupe_key || '').endsWith(`:${result.deviceId}`));
        const pcMessage = row ? pcById.get(row.channel_ref) : null;
        let status = sentStatus(result.status);
        if (pcMessage) {
          status = pcMessage.read_at || pcMessage.answered_at ? 'read'
            : pcMessage.delivered_at ? 'sent'
            : Date.parse(pcMessage.expires_at) < now ? 'expired' : 'pending';
        } else if (row && row.status === 'failed') status = 'failed';
        return {
          channel: 'pc', status, recipient: row?.recipient || result.deviceName || result.deviceId || null,
          deviceName: result.deviceName ?? row?.recipient ?? null,
          at: pcMessage?.read_at || pcMessage?.delivered_at || row?.created_at || action.created_at,
        };
      }
      const row = own.find(item => item.channel === result.channel);
      const status = row ? sentStatus(row.status) : sentStatus(result.status);
      return { channel: result.channel, status, recipient: result.recipient ?? row?.channel_ref ?? row?.recipient ?? null, at: row?.sent_at || row?.created_at || action.created_at };
    });
    return {
      actionId: Number(action.id),
      sentAt: action.response?.sentAt || action.created_at,
      subject: payload.subject || payload.title || '',
      body: payload.body || '',
      link: payload.link || null,
      channels,
    };
  });
  return { items };
}

/** Сообщения на ПК аккаунта — и владельца, и администрации. */
async function pcMessagesSection(userId) {
  const [list, devices] = await Promise.all([
    require('./_app-messages').list(userId, { limit: 50, includeAdmin: true }),
    supabaseFetch(`app_devices?user_id=eq.${enc(userId)}&select=id,name&limit=200`).catch(() => []),
  ]);
  const names = new Map(devices.map(device => [device.id, device.name]));
  return {
    items: list.items.map(item => ({
      id: item.id,
      deviceId: item.deviceId,
      deviceName: names.get(item.deviceId) || null,
      text: item.text,
      createdBy: item.createdBy || 'owner',
      status: item.status,
      createdAt: item.createdAt,
      deliveredAt: item.deliveredAt,
      readAt: item.readAt,
      answeredAt: item.answeredAt,
      answer: item.answer,
      answerLabel: item.answerLabel,
      reply: item.reply,
    })),
  };
}

/** Вкладки карточки: messages | deliveries | pcMessages (контракт 3.5). */
async function userSection(section, userId) {
  if (!UUID_RE.test(String(userId || ''))) throw adminError(400, 'VALIDATION_ERROR', 'Некорректный идентификатор пользователя');
  if (section === 'messages') return sentMessages(userId);
  if (section === 'deliveries') {
    const rows = await supabaseFetch(`notification_deliveries?user_id=eq.${enc(userId)}&select=*&order=created_at.desc&limit=50`);
    return { items: await deliveryDtos(rows, { labels: false }) };
  }
  if (section === 'pcMessages') return pcMessagesSection(userId);
  throw adminError(400, 'VALIDATION_ERROR', 'Неизвестный раздел');
}

/** POST resource=deliveries&action=retry {id, idempotencyKey}: повторить письмо или Telegram того же сообщения. */
async function retryDelivery(req, res) {
  const id = String(req.body?.id || '');
  const key = String(req.body?.idempotencyKey || '');
  if (!UUID_RE.test(id)) return validationError(res, 'Некорректная доставка');
  if (!KEY_RE.test(key)) return validationError(res, 'Нет ключа повтора — обновите страницу');
  let row;
  try {
    row = (await supabaseFetch(`notification_deliveries?id=eq.${enc(id)}&select=*&limit=1`))[0];
  } catch (error) {
    return sendError(res, error);
  }
  if (!row) return res.status(404).json({ error: 'Доставка не найдена', code: 'NOT_FOUND' });
  return grants.runIdempotent(req, res, {
    action: 'retryDelivery', key, userId: row.user_id || null, payload: { deliveryId: id, channel: row.channel },
  }, async () => {
    const action = row.admin_action_id != null
      ? (await supabaseFetch(`admin_actions?id=eq.${enc(row.admin_action_id)}&select=id,action,payload&limit=1`))[0]
      : null;
    const payload = action?.payload || {};
    const subject = String(payload.subject || payload.title || '');
    const body = String(payload.body || '');
    if (!retryable(row, action?.action) || !subject || !body) {
      throw adminError(409, 'NOT_RETRYABLE', 'Эту доставку нельзя повторить: повтор есть только у неудачных писем и сообщений в Telegram от «Написать»');
    }
    // Забираем строку атомарно (failed/not_configured → pending) ДО отправки: второй повтор с другим ключом
    // (другой админ, перезагрузка страницы) не пройдёт фильтр и второе письмо не уйдёт.
    const claimed = await supabaseFetch(`notification_deliveries?id=eq.${enc(id)}&status=in.(failed,not_configured)`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'pending' }),
    });
    if (!Array.isArray(claimed) || !claimed.length) {
      const current = (await supabaseFetch(`notification_deliveries?id=eq.${enc(id)}&select=status&limit=1`).catch(() => []))[0];
      if (current?.status === 'pending') throw adminError(409, 'IN_PROGRESS', 'Эту доставку уже повторяют — обновите список через минуту');
      throw adminError(409, 'NOT_RETRYABLE', 'Доставка уже не в статусе ошибки — обновите список');
    }
    const now = new Date().toISOString();
    let patch;
    if (row.channel === 'email') {
      if (!emailConfigured()) patch = { status: 'not_configured', last_error: NOT_CONFIGURED_ERROR };
      else {
        try {
          const providerId = await resendSend({ to: row.recipient, subject, text: emailText(body, payload.link) });
          patch = { status: 'sent', provider_id: providerId, sent_at: now, last_error: null };
        } catch (error) {
          patch = { status: 'failed', last_error: errorText(error) };
        }
      }
    } else {
      try {
        const sent = await sendWithRetry(row.recipient, telegramText(subject, body), telegramOptions(payload.link));
        patch = { status: 'sent', provider_id: sent?.message_id != null ? String(sent.message_id) : null, sent_at: now, last_error: null };
      } catch (error) {
        const blocked = isTelegramUnavailable(error);
        if (blocked) {
          await supabaseFetch(`telegram_bot_subscribers?chat_id=eq.${enc(row.recipient)}`, {
            method: 'PATCH', body: JSON.stringify({ blocked_at: now }),
          }).catch(() => {});
        }
        patch = { status: blocked ? 'blocked' : 'failed', last_error: errorText(error) };
      }
    }
    patch.attempts = Number(row.attempts || 0) + 1;
    const updated = await supabaseFetch(`notification_deliveries?id=eq.${enc(id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
    }).catch(error => { console.error('retry delivery update failed', error.message); return []; });
    const [delivery] = await deliveryDtos([(Array.isArray(updated) && updated[0]) || { ...row, ...patch }]);
    return {
      status: 200,
      result: patch.status === 'sent' ? 'ok' : 'error',
      before: { status: row.status, attempts: Number(row.attempts || 0) },
      after: { status: patch.status, attempts: patch.attempts },
      body: { delivery },
    };
  });
}

function sendError(res, error) {
  if (typeof grants.sendAdminError === 'function') return grants.sendAdminError(res, error);
  if (error?.status >= 400 && error.status < 500 && error.code) return res.status(error.status).json({ error: error.message, code: error.code, ...(error.extra || {}) });
  console.error(error?.message, error?.details || '');
  return res.status(502).json({ error: 'Database request failed' });
}

module.exports = {
  MESSAGE_LIMITS, CHANNELS, escapeHtml, personalize, delay, sendWithRetry, pcMessageText, absoluteLink,
  validateMessageBody, deliver, messageTargets, message, notifyCompat, userSection, retryDelivery,
  // для _admin-audit.js (журнал и доставки) и тестов
  deliveryDtos, userLabels, telegramText, emailText,
};
