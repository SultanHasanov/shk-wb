// Сообщения владельца на ПК «Помощника ПВЗ» (кабинет → «Сообщения на ПК»).
//
//   Владелец пишет в кабинете (send) → строка в app_device_messages, спящий inbox того ПК будится →
//   ПК забирает непрочитанные в ответе relay-inbox (pull, ставится delivered_at) → показывает окно
//   поверх всего и подтверждает показ (ack read) → менеджер жмёт кнопку или пишет ответ (ack ok|done|
//   cannot|closed|reply) → владельцу уведомление в кабинете и в Telegram.
//
// Сообщение может написать и администрация (админка → «Написать» → ПК, created_by = 'admin'): тогда ответ
// с ПК уходит админам в Telegram (sendToAdmins), а не владельцу, и в кабинете владельца такие сообщения не видны.
//
// Авторизация ПК — ключ устройства или сессия (api/app.js deviceActions): работает и без входа в аккаунт.
const { supabaseFetch } = require('./_supabase');
const { appError } = require('./_app-account');
const { createNotification } = require('./_notifications');
const relay = require('./_app-relay');

const SELECT = 'id,user_id,device_id,text,created_at,expires_at,delivered_at,read_at,answered_at,answer_kind,reply_text,created_by';
const CREATED_BY = new Set(['owner', 'admin']);
const MAX_TEXT = 500;
const MAX_OPEN = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANSWERS = Object.freeze({ ok: 'Хорошо', done: 'Сделано', cannot: 'Не могу', closed: 'Закрыл окно', reply: 'Ответ' });

// inbox каждого ПК спрашивал базу дважды за цикл (PATCH + SELECT), почти всегда впустую — это была треть всех
// запросов к Supabase. Теперь «сообщений нет» помним в памяти: сообщения пишет только этот процесс (send).
// Срок — подстраховка на случай строки, добавленной мимо send (руками в SQL): ПК увидит её не позже, чем через него.
const EMPTY_TTL_MS = 10 * 60_000;
const knownEmpty = new Map(); // deviceId → до какого времени считать, что непрочитанных нет
let sendEpoch = 0; // растёт с каждой отправкой: чтение, начатое до неё, не имеет права запомнить «пусто»

function forgetEmpty(deviceId) {
  sendEpoch += 1;
  knownEmpty.delete(deviceId);
}

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, max);
}

function enc(value) {
  return encodeURIComponent(String(value));
}

function mapMessage(row, now = Date.now()) {
  const status = row.answered_at ? 'answered'
    : row.read_at ? 'read'
    : row.delivered_at ? 'delivered'
    : new Date(row.expires_at).getTime() < now ? 'expired'
    : 'pending';
  return {
    id: row.id,
    deviceId: row.device_id,
    text: row.text,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    answeredAt: row.answered_at,
    answer: row.answer_kind,
    answerLabel: row.answer_kind ? ANSWERS[row.answer_kind] : null,
    reply: row.reply_text,
    createdBy: row.created_by === 'admin' ? 'admin' : 'owner',
    status,
  };
}

/**
 * Кабинет (или админка, createdBy = 'admin'): отправить сообщение на ПК аккаунта.
 * 404 — ПК не свой или отключён, 409 — слишком много неотвеченных.
 */
async function send({ userId, deviceId, text, createdBy = 'owner' }) {
  if (!CREATED_BY.has(createdBy)) throw appError(400, 'VALIDATION_ERROR', 'Некорректный отправитель');
  const clean = cleanText(text, MAX_TEXT + 1);
  if (!UUID_RE.test(String(deviceId || ''))) throw appError(400, 'VALIDATION_ERROR', 'Некорректное устройство');
  if (!clean) throw appError(400, 'VALIDATION_ERROR', 'Введите текст сообщения');
  if (clean.length > MAX_TEXT) throw appError(400, 'VALIDATION_ERROR', `Не больше ${MAX_TEXT} символов`);
  const devices = await supabaseFetch(`app_devices?id=eq.${enc(deviceId)}&user_id=eq.${enc(userId)}&revoked_at=is.null&select=id,name&limit=1`);
  if (!devices.length) throw appError(404, 'NOT_FOUND', 'Компьютер не найден или отключён');
  const open = await supabaseFetch(`app_device_messages?device_id=eq.${enc(deviceId)}&answered_at=is.null&expires_at=gt.${enc(new Date().toISOString())}&select=id&limit=${MAX_OPEN}`);
  if (open.length >= MAX_OPEN) throw appError(409, 'TOO_MANY_OPEN', `На этом компьютере уже ${MAX_OPEN} сообщений без ответа — дождитесь ответа`);
  let rows;
  try {
    rows = await supabaseFetch('app_device_messages', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ user_id: userId, device_id: deviceId, text: clean, created_by: createdBy }),
    });
  } finally {
    // и при ошибке: ответ мог потеряться, а строка — записаться
    forgetEmpty(deviceId);
  }
  relay.wake(userId, deviceId);
  return mapMessage(rows[0]);
}

/** Кабинет: лента сообщений аккаунта (по ПК или все). Сообщения администрации — только с includeAdmin (админка). */
async function list(userId, { deviceId, limit = 50, includeAdmin = false } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (deviceId && !UUID_RE.test(String(deviceId))) throw appError(400, 'VALIDATION_ERROR', 'Некорректное устройство');
  const byDevice = deviceId ? `&device_id=eq.${enc(deviceId)}` : '';
  const byAuthor = includeAdmin ? '' : '&created_by=eq.owner';
  const rows = await supabaseFetch(`app_device_messages?user_id=eq.${enc(userId)}${byDevice}${byAuthor}&select=${SELECT}&order=created_at.desc&limit=${n}`);
  const now = Date.now();
  return { items: rows.map(row => mapMessage(row, now)) };
}

/**
 * ПК: непоказанные сообщения (в ответе relay-inbox). Помечает доставку; отдаёт всё с read_at = null,
 * чтобы потерянный ответ inbox не терял сообщение — ПК дедуплицирует по id.
 */
async function pull(userId, deviceId) {
  if ((knownEmpty.get(deviceId) || 0) > Date.now()) return [];
  const epoch = sendEpoch;
  const now = new Date().toISOString();
  const base = `app_device_messages?user_id=eq.${enc(userId)}&device_id=eq.${enc(deviceId)}&expires_at=gt.${enc(now)}`;
  await supabaseFetch(`${base}&delivered_at=is.null`, { method: 'PATCH', body: JSON.stringify({ delivered_at: now }) }).catch(() => {});
  const rows = await supabaseFetch(`${base}&read_at=is.null&select=id,text,created_at&order=created_at.asc&limit=${MAX_OPEN}`);
  if (rows.length) knownEmpty.delete(deviceId);
  else if (epoch === sendEpoch) knownEmpty.set(deviceId, Date.now() + EMPTY_TTL_MS);
  return rows.map(row => ({ id: row.id, text: row.text, createdAt: row.created_at }));
}

/** ПК: показано (read) или ответ (ok|done|cannot|closed|reply + текст). При ответе — уведомить владельца. */
async function ack(userId, device, { id, status, reply } = {}) {
  if (!UUID_RE.test(String(id || ''))) throw appError(400, 'VALIDATION_ERROR', 'Некорректное сообщение');
  const kind = String(status || '');
  if (kind !== 'read' && !ANSWERS[kind]) throw appError(400, 'VALIDATION_ERROR', 'Некорректный статус');
  const replyText = kind === 'reply' ? cleanText(reply) : '';
  if (kind === 'reply' && !replyText) throw appError(400, 'VALIDATION_ERROR', 'Введите текст ответа');
  const now = new Date().toISOString();
  const where = `app_device_messages?id=eq.${enc(id)}&user_id=eq.${enc(userId)}&device_id=eq.${enc(device.id)}`;
  const patch = kind === 'read'
    ? { filter: '&read_at=is.null', body: { read_at: now, delivered_at: now } }
    : { filter: '&answered_at=is.null', body: { answered_at: now, read_at: now, delivered_at: now, answer_kind: kind, reply_text: replyText || null } };
  const rows = await supabaseFetch(`${where}${patch.filter}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch.body),
  });
  if (!rows.length) {
    // уже помечено (повтор с ПК) — не ошибка; 404 только если строки нет вовсе
    const existing = await supabaseFetch(`${where}&select=${SELECT}&limit=1`);
    if (!existing.length) throw appError(404, 'NOT_FOUND', 'Сообщение не найдено');
    return mapMessage(existing[0]);
  }
  if (kind !== 'read') {
    if (rows[0].created_by === 'admin') await notifyAdmins(rows[0], device).catch(error => console.warn('pc message: notify admins:', error.message));
    else await notifyOwner(rows[0], device).catch(error => console.warn('pc message: notify owner:', error.message));
  }
  return mapMessage(rows[0]);
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Владельцу: уведомление в кабинете + Telegram (если привязан). Ошибки Telegram не роняют ack. */
async function notifyOwner(row, device) {
  const label = ANSWERS[row.answer_kind] || 'Ответ';
  const answer = row.answer_kind === 'reply' ? `Ответ: ${row.reply_text}` : label;
  const quoted = row.text.length > 120 ? `${row.text.slice(0, 120)}…` : row.text;
  const name = device.name || 'Компьютер';
  await createNotification({
    userId: row.user_id,
    kind: 'pc_reply',
    title: `Ответ с ПК «${name}»`.slice(0, 160),
    body: `${answer}\nНа сообщение: «${quoted}»`.slice(0, 2000),
    link: `/cabinet/pc-messages?device=${row.device_id}`,
    dedupeKey: `pc-reply:${row.id}`,
    email: null,
  });
  const { ownerTelegramId } = require('./_code-approvals');
  const owner = await ownerTelegramId(row.user_id).catch(() => null);
  if (!owner) return;
  const { sendMessage } = require('./_telegram-api');
  const html = `💬 <b>Ответ с ПК «${escapeHtml(name)}»</b>\n${escapeHtml(answer)}\n\n<i>На сообщение:</i> ${escapeHtml(quoted)}`;
  await sendMessage(owner.id, html, { parse_mode: 'HTML' });
}

/** Ответ на сообщение администрации — админам в Telegram; уведомление в кабинет владельцу не создаётся. */
async function notifyAdmins(row, device) {
  const label = ANSWERS[row.answer_kind] || 'Ответ';
  const answer = row.answer_kind === 'reply' ? `Ответ: ${row.reply_text}` : label;
  const quoted = row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text;
  const name = device.name || 'Компьютер';
  const html = `💬 <b>Ответ с ПК «${escapeHtml(name)}»</b> на сообщение администрации
` +
    `Пользователь: <code>${escapeHtml(row.user_id)}</code>
${escapeHtml(answer)}

<i>На сообщение:</i> ${escapeHtml(quoted)}`;
  await require('./_admin-alerts').sendToAdmins(html);
}

/** Крон кабинета: сообщения старше 30 дней. */
async function cleanup(days = 30) {
  const before = new Date(Date.now() - days * 86400_000).toISOString();
  await supabaseFetch(`app_device_messages?created_at=lt.${enc(before)}`, { method: 'DELETE' });
}

function resetForTests() {
  knownEmpty.clear();
}

module.exports = { ANSWERS, EMPTY_TTL_MS, MAX_OPEN, MAX_TEXT, ack, cleanup, list, mapMessage, pull, resetForTests, send };
