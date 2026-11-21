// Веб-версия «Помощника ПВЗ» в кабинете (/cabinet/pvz-web): то, что можно получить без компьютера пункта.
//
// Источник данных — сам WB: сервер входит в него под номером владельца (телефон + код от WB), как это делает
// Telegram-бот (server/_wb-pvz.js), и читает список товаров пункта (goods/list). Базы пункта на сервере нет и здесь
// она не появляется: список живёт в памяти процесса 2 минуты. Вход в WB хранится по аккаунту сайта
// (app_wb_web_sessions, миграция 20261125_pvz_web.sql) и с входом бота не связан — смена пункта в одном месте
// не ломает другое.
//
// Код клиента считается на сервере (server/_wb-code.js) и списывается как в боте: код из тарифа → пакет → баланс.
// Повтор того же клиента в те же сутки (по Москве) — без нового списания: id списания выводится из
// (аккаунт, клиент, день), а app_code_once и wallet_spend идемпотентны по ключу.
const crypto = require('crypto');
const QRCode = require('qrcode');
const { supabaseFetch } = require('./_supabase');
const wbPvz = require('./_wb-pvz');
const wbGoods = require('./_wb-goods');
const shkVision = require('./_shk-vision');
const account = require('./_app-account');
const approvals = require('./_code-approvals');
const controls = require('./_user-controls');
const wallet = require('./_wallet');
const { buildClientQr } = require('./_wb-code');
const { CLIENT_CODE_PRICE } = require('./_payments');
const { clubPrice } = require('./_club');
const { codeViaBotEnabledFor } = require('./_app-flags');
const { identityForUser } = require('./_telegram-identity');
const { notifyAdminSpend } = require('./_admin-alerts');
const { enforceRateLimit } = require('./_rate-limit');

const ACTION = 'pvz-web';
const CONNECTION_CACHE_MS = 60 * 1000;
const LOGIN_TTL_MS = 15 * 60 * 1000;      // незаконченный вход (ждём код) живёт столько же, сколько в боте
const GOODS_TTL_MS = 2 * 60 * 1000;
const MAX_SNAPSHOTS = 300;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
// WB отдаёт в списке и уже выданные / возвращённые товары — в ячейках их нет.
// Статусы сверены на живом пункте (21.11.2026): GOODS_READY — ждёт клиента, GOODS_DECLINED — клиент отказался, товар
// ещё в пункте, GOODS_STATUS_UTILIZATION — на утилизацию; GOODS_RECIEVED (опечатка WB) — выдан, GOODS_RETURNED и
// GOODS_RETURN_ERROR — возвращён. Выданные и возвращённые WB отдаёт примерно за две недели — это история.
const RECEIVED_STATUSES = new Set(['GOODS_RECIEVED', 'GOODS_RECEIVED']);
const RETURNED_STATUSES = new Set(['GOODS_RETURNED', 'GOODS_RETURN_ERROR']);
const statusOf = item => String(item?.status || '').toUpperCase();

function q(value) { return encodeURIComponent(String(value)); }

function fail(res, status, code, error, extra) {
  return res.status(status).json({ error, code, ...(extra || {}) });
}

// ---------- доступ ----------

/** Любой действующий платный тариф Помощника (или безлимит / бесплатный режим) открывает все веб-разделы. */
async function isAllowed(userId) {
  const ent = await account.entitlementsFor(userId, { cached: true });
  return Boolean(ent.plan || ent.free || ent.unlimited);
}

// ---------- вход в WB по аккаунту сайта ----------

const connectionCache = new Map();

function expirePending(row) {
  if (!row || row.state !== 'await_code') return row;
  const updated = Date.parse(row.updated_at || '');
  return Number.isFinite(updated) && Date.now() - updated > LOGIN_TTL_MS ? { ...row, state: 'idle' } : row;
}

async function getConnection(userId) {
  const cached = connectionCache.get(userId);
  if (cached && cached.until > Date.now()) return cached.row ? expirePending(structuredClone(cached.row)) : null;
  const rows = await supabaseFetch(`app_wb_web_sessions?user_id=eq.${q(userId)}&select=state,encrypted_session,selected_point_id,updated_at&limit=1`);
  const row = rows[0] || null;
  if (row) {
    try { row.session = wbPvz.decryptSession(row.encrypted_session); } catch { row.session = null; }
    delete row.encrypted_session;
  }
  if (connectionCache.size > 5000) connectionCache.clear();
  connectionCache.set(userId, { row, until: Date.now() + CONNECTION_CACHE_MS });
  return row ? expirePending(structuredClone(row)) : null;
}

async function saveConnection(userId, state, session) {
  connectionCache.delete(userId);
  await supabaseFetch('app_wb_web_sessions?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      user_id: userId, state,
      encrypted_session: session ? wbPvz.encryptSession(session) : null,
      selected_point_id: session?.pointId || null,
      updated_at: new Date().toISOString(),
    }),
  });
  connectionCache.delete(userId);
}

async function dropConnection(userId) {
  connectionCache.delete(userId);
  forgetGoods(userId);
  await supabaseFetch(`app_wb_web_sessions?user_id=eq.${q(userId)}`, { method: 'DELETE' });
  connectionCache.delete(userId);
}

function parsePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('9')) digits = `7${digits}`;
  return /^7\d{10}$/.test(digits) ? digits : null;
}

function text(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function pointView(point) {
  return { id: Number(point.id), name: text(point.name) || text(point.address) || text(point.full_address) || `ПВЗ ${point.id}` };
}

function wbView(connection) {
  const session = connection?.session;
  if (!session) return { state: 'none' };
  const points = (session.points || []).map(pointView);
  if (connection.state === 'await_code' && session.desktopLoginToken) return { state: 'await_code', phoneTail: String(session.phone || '').slice(-4) };
  if (connection.state === 'await_point' && session.token) return { state: 'await_point', points };
  if (connection.state === 'ready' && session.token) return { state: 'ready', points, pointId: Number(session.pointId) || null };
  return { state: 'none' };
}

/** Текст, который написал сам WB по-русски (не 5xx), — его можно показать человеку. */
function wbSaid(error) {
  const said = String(error?.wbMessage || '').trim();
  return said && !(Number(error?.status) >= 500) && said.length <= 200 && /[а-яё]/i.test(said) ? said : '';
}

/** Ошибка WB (его ответ или сеть до него) → ответ кабинету. Вход слетел — забываем его, фронт покажет экран входа. */
async function wbFailure(res, userId, error, { login = false } = {}) {
  const status = Number(error.status);
  const said = wbSaid(error);
  if (login) {
    if (status === 429) return fail(res, 429, 'WB_BUSY', 'WB временно не принимает попытки входа с этого номера. Подождите 10–15 минут.');
    if (said) return fail(res, 422, 'WB_REFUSED', `WB ответил: «${said}»`);
    if (status >= 400 && status < 500) return fail(res, 422, 'WB_REFUSED', 'WB не принял данные. Проверьте номер или код и попробуйте ещё раз.');
    return fail(res, 502, 'WB_DOWN', 'WB сейчас не отвечает. Попробуйте через минуту.');
  }
  if (status === 401) {
    await dropConnection(userId).catch(() => {});
    return fail(res, 409, 'WB_LOGIN_REQUIRED', 'Вход в WB закончился. Войдите заново — WB пришлёт новый код.');
  }
  if (status === 403) return fail(res, 403, 'WB_FORBIDDEN', said ? `WB не даёт доступ: «${said}»` : 'WB не даёт доступ к этому пункту с этим номером.');
  if (status === 429) return fail(res, 429, 'WB_BUSY', 'WB просит подождать — слишком много запросов. Попробуйте через минуту.');
  return fail(res, 502, 'WB_DOWN', 'WB сейчас не отвечает. Попробуйте через минуту.');
}

async function status(req, res, userId) {
  const [allowed, connection, codeViaBot] = await Promise.all([
    isAllowed(userId),
    getConnection(userId),
    codeViaBotEnabledFor(userId).catch(() => false),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ allowed, wb: wbView(connection), codeViaBot });
}

async function wbLogin(req, res, userId) {
  if (!await enforceRateLimit(req, res, { scope: 'pvz-web-login', limit: 6, windowSeconds: 600, key: userId })) return undefined;
  const body = req.body || {};
  const current = await getConnection(userId);
  const resend = body.resend === true && current?.state === 'await_code' && current.session?.phone;
  const phone = resend ? current.session.phone : parsePhone(body.phone);
  if (!phone) return fail(res, 400, 'VALIDATION_ERROR', 'Введите российский номер — 11 цифр, например 79991234567');
  const session = resend ? current.session : { deviceId: crypto.randomUUID() };
  const { ttl } = await wbPvz.requestCode(session, phone, { resend: Boolean(resend) });
  forgetGoods(userId);
  await saveConnection(userId, 'await_code', session);
  return res.status(200).json({ wb: { state: 'await_code', phoneTail: phone.slice(-4) }, ttl });
}

async function wbCode(req, res, userId) {
  if (!await enforceRateLimit(req, res, { scope: 'pvz-web-code', limit: 10, windowSeconds: 600, key: userId })) return undefined;
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (code.length < 4 || code.length > 8) return fail(res, 400, 'VALIDATION_ERROR', 'Введите код из сообщения WB');
  const connection = await getConnection(userId);
  if (connection?.state !== 'await_code' || !connection.session?.desktopLoginToken) {
    return fail(res, 409, 'WB_CODE_EXPIRED', 'Этот код уже не подойдёт. Запросите новый.');
  }
  const session = await wbPvz.confirmCode(connection.session, code);
  const points = await wbPvz.loadPoints(session);
  if (!points.length) {
    await dropConnection(userId);
    return fail(res, 409, 'WB_NO_POINTS', 'К этому номеру в WB не привязан ни один пункт. Войдите номером, с которым работаете на пункте.');
  }
  if (points.length === 1) {
    await wbPvz.selectPoint(session, points[0].id);
    await saveConnection(userId, 'ready', session);
  } else {
    await saveConnection(userId, 'await_point', session);
  }
  return res.status(200).json({ wb: wbView(await getConnection(userId)) });
}

async function wbPoint(req, res, userId) {
  const pointId = Number(req.body?.pointId);
  const connection = await getConnection(userId);
  if (!connection?.session?.token || !['await_point', 'ready'].includes(connection.state)) {
    return fail(res, 409, 'WB_LOGIN_REQUIRED', 'Сначала войдите в WB.');
  }
  if (!Number.isSafeInteger(pointId) || !(connection.session.points || []).some(p => Number(p.id) === pointId)) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Этот пункт недоступен вашему номеру WB');
  }
  await wbPvz.selectPoint(connection.session, pointId);
  forgetGoods(userId);
  await saveConnection(userId, 'ready', connection.session);
  return res.status(200).json({ wb: wbView(await getConnection(userId)) });
}

async function wbLogout(req, res, userId) {
  await dropConnection(userId);
  return res.status(200).json({ wb: { state: 'none' } });
}

// ---------- товары пункта ----------

const snapshots = new Map();   // userId → { pointId, goods, loadedAt }
const loading = new Map();     // userId → Promise

function forgetGoods(userId) {
  snapshots.delete(userId);
  loading.delete(userId);
}

async function readyConnection(res, userId) {
  const connection = await getConnection(userId);
  if (connection?.state === 'ready' && connection.session?.token && connection.session.pointId) return connection;
  fail(res, 409, 'WB_LOGIN_REQUIRED', 'Войдите в WB, чтобы увидеть данные пункта.');
  return null;
}

/** Весь список товаров выбранного пункта; fresh — мимо памяти (кнопка «Обновить»). */
async function loadSnapshot(userId, connection, { fresh = false } = {}) {
  const pointId = Number(connection.session.pointId);
  const hit = snapshots.get(userId);
  if (!fresh && hit && hit.pointId === pointId && Date.now() - hit.loadedAt < GOODS_TTL_MS) return hit;
  const pending = loading.get(userId);
  if (pending) return pending;
  const before = JSON.stringify(connection.session);
  const run = (async () => {
    const goods = await wbGoods.fetchAllGoods(connection.session);
    // переключение пункта выдаёт новый токен и shard — без записи каждый запрос переключал бы пункт заново
    if (JSON.stringify(connection.session) !== before) await saveConnection(userId, 'ready', connection.session).catch(() => {});
    const snapshot = { pointId, goods, loadedAt: Date.now() };
    if (snapshots.size >= MAX_SNAPSHOTS) snapshots.clear();
    snapshots.set(userId, snapshot);
    return snapshot;
  })();
  loading.set(userId, run);
  try { return await run; } finally { if (loading.get(userId) === run) loading.delete(userId); }
}

function phoneTail(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `${digits.slice(-4, -2)}-${digits.slice(-2)}` : '';
}

function firstText(item, fields) {
  for (const field of fields) {
    const value = text(item?.[field]);
    if (value) return value;
  }
  return '';
}

function daysSince(value, now) {
  const at = Date.parse(value || '');
  if (!Number.isFinite(at) || at > now) return null;
  return Math.floor((now - at) / 86400000) + 1;
}

/** Лежит ли товар в пункте: есть ячейка и клиент, статус — не «выдан» и не «возвращён». */
function inPoint(item) {
  const status = statusOf(item);
  return Boolean(wbGoods.goodCell(item)) && Boolean(wbGoods.goodSid(item)) && !RECEIVED_STATUSES.has(status) && !RETURNED_STATUSES.has(status);
}

/**
 * Товар для экрана. Сверено на живом goods/list (21.11.2026): описание — во вложенном info (name, brand,
 * subject_name, goods_size, color), артикул WB (nm) — vendor_code, цена — price_with_sale / price.
 */
function goodView(item) {
  const info = item.info && typeof item.info === 'object' ? item.info : {};
  const price = Number(item.price_with_sale ?? item.price);
  const nm = Number(item.vendor_code);
  const size = text(info.goods_size);
  return {
    title: firstText(info, ['name', 'subject_name']) || firstText(item, ['goods_name', 'name']),
    brand: firstText(info, ['brand']) || firstText(item, ['brand']),
    size: size && size !== '0' ? size : '',
    color: text(info.color),
    nm: Number.isSafeInteger(nm) && nm > 0 ? nm : null,
    shk: text(item.shk_code) || [...wbGoods.goodShks(item)][0] || '',
    price: Number.isFinite(price) && price > 0 ? price : null,
  };
}

/** Метки на товаре, который лежит в пункте: только те, что есть (ложные не шлём). */
function marksOf(item) {
  const status = statusOf(item);
  const marks = [];
  if (status === 'GOODS_DECLINED') marks.push('declined');
  if (status === 'GOODS_STATUS_UTILIZATION') marks.push('utilization');
  if (item.is_paid === false) marks.push('unpaid');
  if (item.try_on === true) marks.push('tryon');
  if (item.has_defect_mark === true) marks.push('defect');
  if (item.repackaging_status === 'NeedRepackaged') marks.push('repack');
  if (item.item_purpose === 'return_to_seller') marks.push('to_seller');
  return marks;
}

/** Ячейки пункта: клиент и его товары, которые сейчас лежат в пункте. */
function cellsView(goods, now = Date.now()) {
  const cells = new Map();
  for (const item of Array.isArray(goods) ? goods : []) {
    if (!inPoint(item)) continue;
    const cell = wbGoods.goodCell(item);
    const sid = wbGoods.goodSid(item);
    const key = `${cell}|${sid}`;
    const entry = cells.get(key) || { cell, sid, name: '', tail: '', days: null, goods: [] };
    if (!entry.name) entry.name = wbGoods.goodName(item);
    if (!entry.tail) entry.tail = phoneTail(wbGoods.goodPhone(item));
    const days = daysSince(item.status_updated, now);
    if (days != null && (entry.days == null || days > entry.days)) entry.days = days;
    entry.goods.push({ ...goodView(item), days, marks: marksOf(item) });
    cells.set(key, entry);
  }
  const num = value => Number(String(value).replace(/\D/g, '')) || 0;
  return [...cells.values()].sort((a, b) => num(a.cell) - num(b.cell) || a.cell.localeCompare(b.cell));
}

/**
 * История: выданные и возвращённые товары — кто, из какой ячейки, когда и какой сотрудник провёл операцию
 * (history[].employee_id — номер сотрудника в WB, имён WB здесь не отдаёт). Свежие сверху.
 */
function eventsView(goods) {
  const events = [];
  for (const item of Array.isArray(goods) ? goods : []) {
    const status = statusOf(item);
    const kind = RECEIVED_STATUSES.has(status) ? 'received' : RETURNED_STATUSES.has(status) ? 'returned' : null;
    const sid = wbGoods.goodSid(item);
    if (!kind || !sid) continue;
    const at = Date.parse(item.status_updated || '');
    if (!Number.isFinite(at)) continue;
    const last = Array.isArray(item.history) && item.history.length ? item.history[item.history.length - 1] : null;
    const employee = Number(last?.employee_id || last?.real_employee_id);
    events.push({
      kind, sid, at: new Date(at).toISOString(),
      cell: wbGoods.goodCell(item),
      tail: phoneTail(wbGoods.goodPhone(item)),
      employee: Number.isSafeInteger(employee) && employee > 0 ? String(employee) : '',
      ...goodView(item),
    });
  }
  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

async function goods(req, res, userId) {
  const fresh = String(req.query.fresh || '') === '1';
  if (fresh && !await enforceRateLimit(req, res, { scope: 'pvz-web-refresh', limit: 20, windowSeconds: 600, key: userId })) return undefined;
  const connection = await readyConnection(res, userId);
  if (!connection) return undefined;
  const snapshot = await loadSnapshot(userId, connection, { fresh });
  const cells = cellsView(snapshot.goods);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    pointId: snapshot.pointId,
    loadedAt: new Date(snapshot.loadedAt).toISOString(),
    cells,
    goodsCount: cells.reduce((sum, c) => sum + c.goods.length, 0),
    events: eventsView(snapshot.goods),
  });
}

/**
 * Какие поля WB отдаёт в записи товара — только названия, без значений. Нужно, чтобы сверить имена полей
 * (ШК, цена, название) на живом пункте, не выгружая данные клиентов.
 */
async function fields(req, res, userId) {
  const connection = await readyConnection(res, userId);
  if (!connection) return undefined;
  const snapshot = await loadSnapshot(userId, connection);
  const names = new Set();
  const statuses = new Set();
  for (const item of snapshot.goods.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    for (const [field, value] of Object.entries(item)) {
      names.add(field);
      if (value && typeof value === 'object' && !Array.isArray(value)) for (const inner of Object.keys(value)) names.add(`${field}.${inner}`);
    }
    if (item.status != null) statuses.add(String(item.status));
  }
  return res.status(200).json({ total: snapshot.goods.length, fields: [...names].sort(), statuses: [...statuses].sort() });
}

// ---------- поиск клиента ----------

function matchView(match, digits) {
  const why = [];
  if ([...match.cells].some(cell => cell.replace(/\D/g, '') === digits)) why.push('cell');
  if (match.sid === digits) why.push('sid');
  if (match.shks.size) why.push('shk');
  if (!why.length) why.push('phone');
  return { sid: match.sid, cells: [...match.cells], name: match.name, tail: phoneTail(match.phone), why };
}

function findMatches(snapshotGoods, digits) {
  const found = wbGoods.findClientsByQuery(snapshotGoods, digits);
  // полный номер телефона: середина у WB затёрта, совпасть может только хвост
  if (!found.length && wbGoods.phoneLike(digits)) {
    const tail = digits.slice(-4);
    return wbGoods.findClientsByQuery(snapshotGoods, tail).map(m => matchView(m, tail));
  }
  return found.map(m => matchView(m, digits));
}

async function search(req, res, userId) {
  if (!await enforceRateLimit(req, res, { scope: 'pvz-web-search', limit: 240, windowSeconds: 600, key: userId })) return undefined;
  const digits = String(req.body?.q || '').replace(/\D/g, '').slice(0, 20);
  if (!digits) return fail(res, 400, 'VALIDATION_ERROR', 'Введите номер ячейки, конец телефона, ШК или ID клиента');
  const connection = await readyConnection(res, userId);
  if (!connection) return undefined;
  const snapshot = await loadSnapshot(userId, connection);
  return res.status(200).json({ q: digits, matches: findMatches(snapshot.goods, digits).slice(0, 20) });
}

async function searchPhoto(req, res, userId) {
  if (!await enforceRateLimit(req, res, { scope: 'pvz-web-photo', limit: 30, windowSeconds: 600, key: userId })) return undefined;
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.image || ''));
  if (!match) return fail(res, 400, 'VALIDATION_ERROR', 'Пришлите фото в формате JPEG или PNG');
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) return fail(res, 413, 'PHOTO_TOO_LARGE', 'Фото слишком большое. Сфотографируйте этикетку ближе.');
  const connection = await readyConnection(res, userId);
  if (!connection) return undefined;
  let codes;
  try {
    codes = await shkVision.recognizeShk(buffer);
  } catch (error) {
    console.warn('pvz-web: photo recognition failed', error?.message || error);
    return fail(res, 422, 'PHOTO_UNREADABLE', 'Не удалось прочитать фото. Попробуйте ещё раз или введите ШК цифрами.');
  }
  if (!codes.length) return res.status(200).json({ codes: [], matches: [] });
  const snapshot = await loadSnapshot(userId, connection);
  const merged = wbGoods.mergeClientMatches(codes.map(code => wbGoods.findClientsByQuery(snapshot.goods, code).filter(m => m.shks.size)));
  return res.status(200).json({ codes, matches: merged.map(m => matchView(m, '')).slice(0, 20) });
}

// ---------- код клиента ----------

/** Один id списания на (аккаунт, клиент, московский день): повтор в те же сутки возвращает прежний QR без списания. */
function chargeRequestId(userId, sid, day) {
  const hex = crypto.createHash('sha256').update(`pvz-web:${userId}:${sid}:${day}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function moscowDay() {
  return approvals.moscowDayStart().toISOString().slice(0, 10);
}

async function chargePreview(userId) {
  const identity = await identityForUser(userId).catch(() => null);
  const charge = await approvals.nextCodeCharge(userId, identity ? Number(identity.telegram_user_id) : null);
  return { kind: charge.kind, line: approvals.chargeLine(charge) };
}

async function charge(req, res, userId) {
  return res.status(200).json(await chargePreview(userId));
}

async function qr(req, res, userId) {
  if (!await enforceRateLimit(req, res, { scope: 'pvz-web-qr', limit: 60, windowSeconds: 60, key: userId })) return undefined;
  const sid = String(req.body?.sid || '').trim();
  const cell = String(req.body?.cell || '').trim().slice(0, 16);
  if (!/^[1-9]\d{0,11}$/.test(sid)) return fail(res, 400, 'VALIDATION_ERROR', 'Некорректный ID клиента');
  // Включено «код только с подтверждением владельца в боте» — веб-версия не должна быть обходом этой защиты.
  if (await codeViaBotEnabledFor(userId)) {
    return fail(res, 403, 'APPROVAL_REQUIRED', 'Сейчас код клиента выдаётся только через Telegram-бот. Получите QR в боте: «Код клиента» → поиск.');
  }
  const day = moscowDay();
  let { qrText } = buildClientQr(sid);
  let spent;
  let charged = null;
  try {
    charged = await account.chargeClientCode(userId, null, { requestId: chargeRequestId(userId, sid, day), sid, qrText, meta: { via: 'web', ...(cell ? { cell } : {}) } });
  } catch (error) {
    if (error.code !== 'LIMIT_EXCEEDED') throw error;
  }
  if (charged) {
    qrText = charged.qrText || qrText;
    const b = charged.billing || {};
    spent = b.free || b.source === 'unlimited' ? 'Без списания.'
      : charged.replayed ? 'Сегодня этот клиент уже был — без нового списания.'
      : b.source === 'pack' ? 'Списан 1 код из пакета.' : 'Списан 1 код из тарифа.';
  } else {
    // коды тарифа и пакетов кончились — с баланса, если хватает (ограничение «Покупки» из админки запрещает и это)
    await controls.assertAllowed(userId, 'purchases');
    const identity = await identityForUser(userId).catch(() => null);
    const { price, club } = await clubPrice(identity ? Number(identity.telegram_user_id) : null, CLIENT_CODE_PRICE)
      .catch(() => ({ price: CLIENT_CODE_PRICE, club: false }));
    const paid = await supabaseFetch('rpc/wallet_spend', {
      method: 'POST',
      body: JSON.stringify({ p_user: userId, p_kopecks: price * 100, p_event_key: `qrweb:${userId}:${sid}:${day}`, p_details: { sid, club, via: 'web' } }),
    });
    if (!paid?.ok) {
      return fail(res, 402, 'WALLET_SHORT', `Коды тарифа закончились. Код клиента стоит ${wallet.formatRub(price)} с баланса — пополните баланс или докупите пакет кодов.`, {
        price, balance: Number(paid?.balance || 0) / 100,
      });
    }
    if (paid.duplicate === true) {
      spent = 'Сегодня этот клиент уже был — без нового списания.';
    } else {
      spent = `Списано ${wallet.formatRub(price)} с баланса.`;
      notifyAdminSpend({ userId, priceRub: price, title: `Код клиента (QR), веб-версия${club ? ', скидка клуба' : ''}`, balanceKopecks: paid.balance }).catch(() => {});
    }
  }
  const [image, next] = await Promise.all([
    QRCode.toDataURL(qrText, { width: 320, margin: 1 }),
    chargePreview(userId).catch(() => null),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  // Пятизначный код отдельно не отдаём: на выдаче нужен только QR.
  return res.status(200).json({ sid, cell, image, spent, next });
}

// ---------- вход ----------

function isOwnerAction(action) { return action === ACTION; }

const LOGIN_OPS = new Set(['wb-login', 'wb-code', 'wb-point']);

/** /api/cabinet/pvz-web/<op> — после requireUser в api/cabinet.js. Ошибки базы — наверх, их отвечает кабинет. */
async function handleOwner(req, res, user) {
  const op = String(req.query.op || '');
  const is = (name, method) => op === name && req.method === method;
  try {
    if (is('status', 'GET')) return await status(req, res, user.id);
    if (!await isAllowed(user.id)) return fail(res, 403, 'PVZ_WEB_REQUIRED', 'Веб-версия доступна с любым действующим тарифом «Помощника ПВЗ»');
    if (is('wb-login', 'POST')) return await wbLogin(req, res, user.id);
    if (is('wb-code', 'POST')) return await wbCode(req, res, user.id);
    if (is('wb-point', 'POST')) return await wbPoint(req, res, user.id);
    if (is('wb-logout', 'POST')) return await wbLogout(req, res, user.id);
    if (is('goods', 'GET')) return await goods(req, res, user.id);
    if (is('fields', 'GET')) return await fields(req, res, user.id);
    if (is('search', 'POST')) return await search(req, res, user.id);
    if (is('search-photo', 'POST')) return await searchPhoto(req, res, user.id);
    if (is('charge', 'GET')) return await charge(req, res, user.id);
    if (is('qr', 'POST')) return await qr(req, res, user.id);
    return fail(res, 404, 'NOT_FOUND', 'Метод не найден');
  } catch (error) {
    if (res.headersSent) throw error;
    if (error?.name === 'WbPvzError') return wbFailure(res, user.id, error, { login: LOGIN_OPS.has(op) });
    if (error.status && error.code) return fail(res, error.status, error.code, error.message, error.extra);
    throw error;
  }
}

module.exports = {
  handleOwner,
  isOwnerAction,
  _test: { cellsView, chargeRequestId, eventsView, findMatches, inPoint, parsePhone, phoneTail, wbView },
};
