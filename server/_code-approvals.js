// Код клиента с подтверждением владельца в Telegram-боте (04.11.2026, миграция 20261108_app_code_approvals.sql).
//
// Программа с любого ПК аккаунта создаёт запрос (сайт: createApproval + notifyOwner → сообщение владельцу
// с кнопками «Выдать / Отклонить»), владелец нажимает кнопку (узел бота: approve / decline), программа
// опрашивает статус (сайт: loadApproval). Обе стороны работают с таблицей app_code_approvals напрямую,
// RPC между сайтом и узлом не нужен. Списание — chargeClientCode (квота/пакеты, идемпотентно по id запроса),
// при пустой квоте владелец может выдать за CLIENT_CODE_PRICE с баланса (payWithWallet).
const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { editMessageText, sendMessage, sendPhoto } = require('./_telegram-api');
const { buildClientQr } = require('./_wb-code');
const { CLIENT_CODE_PRICE } = require('./_payments');
const { clubPrice } = require('./_club');
const wallet = require('./_wallet');
const account = require('./_app-account');
const { findIdentity, identityForUser, telegramLabel } = require('./_telegram-identity');
const userCache = require('./_telegram-user-cache');

const TTL_MS = 10 * 60 * 1000;          // сколько живёт запрос
const FLOOD_LIMIT = 10;                 // запросов с одного ПК …
const FLOOD_WINDOW_MS = 10 * 60 * 1000; // … за это окно
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const SELECT = 'id,user_id,device_id,sid,cell,point_wb,status,qr_text,billing,error,telegram_chat_id,telegram_message_id,created_at,expires_at,decided_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function publicUrl(path) {
  const origin = String(process.env.PUBLIC_APP_URL || 'https://shk-wb.ru').replace(/\/$/, '');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Подписанная ссылка на PNG QR-кода клиента (api/stickers/image в режиме qr), живёт час. */
function clientQrUrl(qrText) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = crypto.createHmac('sha256', process.env.STICKER_CLIENT_SECRET).update(`qr:${qrText}:${expires}`).digest('base64url');
  return publicUrl(`/api/stickers/image?qr=${encodeURIComponent(qrText)}&token=${encodeURIComponent(token)}&expires=${expires}&format=png`);
}

/** Начало текущих суток по Москве (коды клиента считаются по московской дате). */
function moscowDayStart(now = Date.now()) {
  return new Date(Math.floor((now + MOSCOW_OFFSET_MS) / 86400000) * 86400000 - MOSCOW_OFFSET_MS);
}

function moscowTime(iso) {
  const d = new Date(Date.parse(iso) + MOSCOW_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function isUuid(value) { return UUID_RE.test(String(value || '')); }

function codeFromQrText(qrText) {
  const value = String(qrText || '').split('_')[1];
  return /^\d{5}$/.test(value) ? Number(value) : null;
}

async function patchApproval(id, patch, filter = '') {
  const rows = await supabaseFetch(`app_code_approvals?id=eq.${encodeURIComponent(id)}${filter}&select=${SELECT}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

/** Просроченный pending помечаем при любом чтении — крона нет. */
async function expireIfNeeded(row) {
  if (!row || row.status !== 'pending' || Date.parse(row.expires_at) > Date.now()) return row;
  const updated = await patchApproval(row.id, { status: 'expired', decided_at: new Date().toISOString() }, '&status=eq.pending').catch(() => null);
  return updated || { ...row, status: 'expired' };
}

async function loadApproval(id) {
  if (!isUuid(id)) return null;
  const rows = await supabaseFetch(`app_code_approvals?id=eq.${encodeURIComponent(id)}&select=${SELECT}&limit=1`);
  return expireIfNeeded(rows[0] || null);
}

async function deviceInfo(deviceId) {
  const rows = await supabaseFetch(`app_devices?id=eq.${encodeURIComponent(deviceId)}&select=id,name,point_wb,role&limit=1`).catch(() => []);
  return rows[0] || null;
}

/** Строка «Коды: 3 из 10 в этом месяце · пакеты: 5» для сообщения владельцу (ошибка → без строки). */
async function quotaLine(userId) {
  if (account.isUnlimited(userId)) return null;
  try {
    const ent = await supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) });
    const limit = Number(ent?.codes_limit || 0), used = Number(ent?.codes_used || 0), packs = Number(ent?.packs_left || 0);
    const parts = [];
    if (limit > 0) parts.push(`${Math.min(used, limit)} из ${limit} в этом месяце`);
    if (packs > 0) parts.push(`в пакетах ещё ${packs}`);
    if (!parts.length) return `Коды тарифа закончились — выдача спишет ${CLIENT_CODE_PRICE} ₽ с баланса`;
    return `Коды: ${parts.join(' · ')}`;
  } catch {
    return null;
  }
}

/** Сегодняшняя (МСК) выдача того же клиента этому аккаунту — для строки «уже выдавали» и выдачи без списания. */
async function approvedToday(userId, sid, exceptId) {
  const since = moscowDayStart().toISOString();
  const rows = await supabaseFetch(
    `app_code_approvals?user_id=eq.${encodeURIComponent(userId)}&sid=eq.${encodeURIComponent(sid)}&status=eq.approved&decided_at=gte.${encodeURIComponent(since)}&select=${SELECT}&order=decided_at.desc&limit=1`,
  ).catch(() => []);
  const row = rows[0];
  return row && row.id !== exceptId && row.qr_text ? row : null;
}

async function ownerTelegramId(userId) {
  const identity = await identityForUser(userId);
  return identity ? { id: Number(identity.telegram_user_id), label: telegramLabel(identity) } : null;
}

/**
 * Запрос с ПК. Один pending на ПК (повторное нажатие возвращает его же), не больше FLOOD_LIMIT за окно.
 * Ошибки — account.appError с кодами TELEGRAM_NOT_LINKED / REQUEST_FLOOD.
 */
async function createApproval({ userId, device, sid, cell }) {
  const owner = await ownerTelegramId(userId);
  if (!owner) throw account.appError(409, 'TELEGRAM_NOT_LINKED', 'К аккаунту не подключён Telegram — код клиента выдаёт владелец через бот');
  const recent = await supabaseFetch(
    `app_code_approvals?device_id=eq.${encodeURIComponent(device.id)}&created_at=gte.${encodeURIComponent(new Date(Date.now() - FLOOD_WINDOW_MS).toISOString())}&select=${SELECT}&order=created_at.desc&limit=${FLOOD_LIMIT + 1}`,
  );
  const pending = await expireIfNeeded(recent.find(r => r.status === 'pending') || null);
  if (pending && pending.status === 'pending') return { row: pending, reused: true, owner };
  if (recent.length >= FLOOD_LIMIT) throw account.appError(429, 'REQUEST_FLOOD', 'Слишком много запросов с этого компьютера — подождите несколько минут');
  const rows = await supabaseFetch(`app_code_approvals?select=${SELECT}`, {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: userId, device_id: device.id, sid: String(sid), cell: cell || null, point_wb: device.point_wb || null,
      status: 'pending', expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    }),
  });
  return { row: rows[0], reused: false, owner };
}

function pendingKeyboard(row) {
  return { inline_keyboard: [[
    { text: '✅ Выдать', callback_data: `cq:ok:${row.id}` },
    { text: '❌ Отклонить', callback_data: `cq:no:${row.id}` },
  ]] };
}

function headerLines(row, deviceName) {
  const place = [`ПК «${escapeHtml(deviceName || 'без названия')}»`];
  if (row.cell) place.push(`ячейка ${escapeHtml(row.cell)}`);
  place.push(`клиент <code>${escapeHtml(row.sid)}</code>`);
  return ['<b>🔑 Запрос QR-кода клиента</b>', place.join(' · ')];
}

/** Сообщение владельцу о новом запросе. */
async function ownerMessage(row) {
  const [device, quota, earlier] = await Promise.all([deviceInfo(row.device_id), quotaLine(row.user_id), approvedToday(row.user_id, row.sid, row.id)]);
  const lines = headerLines(row, device?.name);
  if (earlier) {
    const earlierDevice = earlier.device_id === row.device_id ? null : await deviceInfo(earlier.device_id);
    lines.push(`Сегодня уже выдавали в ${moscowTime(earlier.decided_at)}${earlierDevice ? ` с ПК «${escapeHtml(earlierDevice.name)}»` : ''} — повтор без списания.`);
  } else if (quota) {
    lines.push(quota);
  }
  lines.push('', 'Сотрудник ждёт у компьютера. Запрос действует 10 минут.');
  return { text: lines.join('\n'), reply_markup: pendingKeyboard(row) };
}

/** Итоговый текст вместо кнопок — после решения, отмены или просрочки. */
async function finalText(row) {
  const device = await deviceInfo(row.device_id);
  const lines = headerLines(row, device?.name);
  const b = row.billing || {};
  const how = b.via === 'wallet' ? ` · списано ${wallet.formatRub(Number(b.rub || 0))} с баланса`
    : b.via === 'reuse' ? ' · повтор, без списания'
    : b.free ? ' · без списания'
    : b.source === 'pack' ? ' · списан 1 код из пакета'
    : b.source === 'quota' ? ' · списан 1 код тарифа' : '';
  const result = {
    approved: `✅ Выдано${how}. QR показан на компьютере.`,
    declined: '❌ Отклонено.',
    cancelled: '↩️ Отменено с компьютера.',
    expired: '⌛ Не выдан — истекли 10 минут.',
    undeliverable: '⚠️ Сообщение не доставлено.',
    failed: `⚠️ Не удалось выдать: ${escapeHtml(row.error || 'ошибка')}`,
  }[row.status] || row.status;
  lines.push('', result);
  return lines.join('\n');
}

async function updateOwnerMessage(row) {
  if (!row.telegram_chat_id || !row.telegram_message_id) return;
  const text = await finalText(row);
  await editMessageText(row.telegram_chat_id, row.telegram_message_id, text, { reply_markup: { inline_keyboard: [] } })
    .catch(error => { if (!/message is not modified/i.test(String(error.message))) console.warn('code approval: edit owner message', error.message); });
}

/** Отправить запрос владельцу. Не доставлено (бот заблокирован и т.п.) → status undeliverable. */
async function notifyOwner(row, owner) {
  const message = await ownerMessage(row);
  try {
    const sent = await sendMessage(owner.id, message.text, { reply_markup: message.reply_markup });
    return await patchApproval(row.id, { telegram_chat_id: owner.id, telegram_message_id: sent?.message_id || null }) || row;
  } catch (error) {
    const reason = /blocked|deactivated|chat not found|bot can't initiate/i.test(String(error.message)) ? 'Владелец заблокировал бота или не запускал его' : `Telegram: ${error.message}`;
    return await patchApproval(row.id, { status: 'undeliverable', error: reason.slice(0, 200), decided_at: new Date().toISOString() }, '&status=eq.pending') || { ...row, status: 'undeliverable', error: reason };
  }
}

/** Кто нажал кнопку — владелец этого запроса? */
async function isOwnerOf(row, telegramUserId) {
  if (!telegramUserId) return true; // вызов без Telegram (после пополнения) — доверяем вызывающему
  const cached = userCache.cachedUser(telegramUserId);
  const userId = cached ? cached.userId : (await findIdentity(telegramUserId))?.user_id || null;
  return userId === row.user_id;
}

/**
 * «Выдать». telegramUserId — кто нажал (проверка владельца), payWithWallet — списать CLIENT_CODE_PRICE с баланса
 * вместо квоты (кнопка после LIMIT_EXCEEDED или автоматически после пополнения).
 * Возвращает { outcome, row, ... }: approved | not_owner | stale | limit | wallet_short.
 */
async function approve(id, { telegramUserId = null, payWithWallet = false } = {}) {
  const row = await loadApproval(id);
  if (!row) return { outcome: 'stale', row: null };
  if (!await isOwnerOf(row, telegramUserId)) return { outcome: 'not_owner', row };
  if (row.status !== 'pending') return { outcome: 'stale', row };

  let qrText, billing;
  const earlier = await approvedToday(row.user_id, row.sid, row.id);
  if (earlier) {
    qrText = earlier.qr_text;
    billing = { via: 'reuse', of: earlier.id };
  } else if (payWithWallet) {
    qrText = buildClientQr(row.sid).qrText;
    const { price, club } = await clubPrice(telegramUserId || row.telegram_chat_id, CLIENT_CODE_PRICE);
    const spent = await supabaseFetch('rpc/wallet_spend', {
      method: 'POST',
      body: JSON.stringify({ p_user: row.user_id, p_kopecks: price * 100, p_event_key: `qr:${row.user_id}:${qrText}`, p_details: { sid: String(row.sid), club, approval: row.id } }),
    });
    if (!spent?.ok) return { outcome: 'wallet_short', row, price, balance: Number(spent?.balance || 0) / 100 };
    billing = { via: 'wallet', rub: price, club, balance: Number(spent.balance) / 100 };
  } else {
    qrText = buildClientQr(row.sid).qrText;
    try {
      const charged = await account.chargeClientCode(row.user_id, row.device_id, { requestId: row.id, sid: row.sid, qrText, meta: { via: 'approval', cell: row.cell || undefined } });
      qrText = charged.qrText || qrText;
      billing = charged.billing || { via: 'account' };
    } catch (error) {
      if (error.code === 'LIMIT_EXCEEDED') {
        const { price } = await clubPrice(telegramUserId || row.telegram_chat_id, CLIENT_CODE_PRICE).catch(() => ({ price: CLIENT_CODE_PRICE }));
        return { outcome: 'limit', row, price, balance: await wallet.getBalanceKopecks(row.user_id).then(k => k / 100).catch(() => 0) };
      }
      throw error;
    }
  }
  const updated = await patchApproval(row.id, { status: 'approved', qr_text: qrText, billing, decided_at: new Date().toISOString() }, '&status=eq.pending');
  if (!updated) {
    // Кто-то успел решить раньше (двойное нажатие): списание по id запроса идемпотентно, деньги с баланса —
    // возвращаем, чтобы не списать дважды.
    if (billing?.via === 'wallet') await supabaseFetch('rpc/admin_wallet_adjust', { method: 'POST', body: JSON.stringify({ p_user: row.user_id, p_kopecks: billing.rub * 100, p_note: `qr approval race ${row.id}` }) }).catch(() => {});
    return { outcome: 'stale', row: await loadApproval(id) };
  }
  await updateOwnerMessage(updated);
  return { outcome: 'approved', row: updated };
}

/** «Отклонить» в боте. */
async function decline(id, { telegramUserId = null } = {}) {
  const row = await loadApproval(id);
  if (!row) return { outcome: 'stale', row: null };
  if (!await isOwnerOf(row, telegramUserId)) return { outcome: 'not_owner', row };
  if (row.status !== 'pending') return { outcome: 'stale', row };
  const updated = await patchApproval(row.id, { status: 'declined', decided_at: new Date().toISOString() }, '&status=eq.pending');
  if (!updated) return { outcome: 'stale', row: await loadApproval(id) };
  await updateOwnerMessage(updated);
  return { outcome: 'declined', row: updated };
}

/** «Отменить» с ПК (клиент ушёл). Только свой запрос своего ПК. */
async function cancel(id, { userId, deviceId }) {
  const row = await loadApproval(id);
  if (!row || row.user_id !== userId || row.device_id !== deviceId) return null;
  if (row.status !== 'pending') return row;
  const updated = await patchApproval(row.id, { status: 'cancelled', decided_at: new Date().toISOString() }, '&status=eq.pending');
  if (!updated) return loadApproval(id);
  await updateOwnerMessage(updated);
  return updated;
}

/** Открытые запросы аккаунта — для экрана «Код клиента» в боте. */
async function pendingFor(userId) {
  const rows = await supabaseFetch(
    `app_code_approvals?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending&select=${SELECT}&order=created_at.asc&limit=10`,
  ).catch(() => []);
  const alive = [];
  for (const row of rows) {
    const current = await expireIfNeeded(row);
    if (current.status === 'pending') alive.push(current);
  }
  return alive;
}

/** Что отдать программе по запросу статуса. */
function statusPayload(row) {
  return {
    id: row.id,
    status: row.status,
    sid: row.sid,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    ...(row.status === 'approved' ? { qrText: row.qr_text, code: codeFromQrText(row.qr_text), billing: row.billing } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

/** Фото QR владельцу после выдачи — чтобы мог переслать, если компьютер не дождался. */
async function sendQrToOwner(row) {
  if (!row.telegram_chat_id || !row.qr_text) return;
  await sendPhoto(row.telegram_chat_id, clientQrUrl(row.qr_text), { caption: `Клиент ${row.sid} · код ${codeFromQrText(row.qr_text)}` }).catch(error => console.warn('code approval: photo to owner', error.message));
}

module.exports = {
  TTL_MS, FLOOD_LIMIT, FLOOD_WINDOW_MS,
  approve, cancel, clientQrUrl, codeFromQrText, createApproval, decline, finalText, loadApproval, moscowDayStart,
  notifyOwner, ownerMessage, ownerTelegramId, pendingFor, pendingKeyboard, sendQrToOwner, statusPayload, updateOwnerMessage,
};
