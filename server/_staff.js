// «Сотрудники» на сайте: график, зарплата и люди пунктов (кабинет → /cabinet/staff).
//
// Данные — те же документы, что синхронизирует «Помощник ПВЗ»: app_docs, ключи staff и schedule, область — пункт
// (server/_app-sync.js). Сайт читает и пишет их от имени владельца, без ПК (device_id = null — в истории это
// «с сайта»). Запись — та же app_doc_put со сверкой версии: если на сервере уже другая версия, ответ 409
// с текущей, браузер сливает правки (src/lib/staff-core/merge.ts) и повторяет. Формат документов не меняется,
// поэтому программы 1.9–1.14 подхватывают правки сайта обычной синхронизацией.
//
// Ссылка для сотрудников (/grafik/<token>, миграция 20261123_staff_share_links.sql) отдаёт только имена,
// смены и часы — без ставок, выплат, телефонов и номеров WB.
const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { open } = require('./_app-crypto');
const { entitlementsFor } = require('./_app-account');
const sync = require('./_app-sync');
const deviceCache = require('./_app-device-cache');
const { enforceRateLimit } = require('./_rate-limit');

const KEYS = ['staff', 'schedule'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9]{12,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const PUBLIC_CACHE_MS = 60 * 1000;

function q(value) { return encodeURIComponent(String(value)); }

function fail(res, status, code, error, extra) {
  return res.status(status).json({ error, code, ...(extra || {}) });
}

async function hasStaff(userId) {
  // cached: признак раздела меняется только с покупкой, а запись тарифа сбрасывает эту память (_supabase.js)
  const ent = await entitlementsFor(userId, { cached: true });
  return ent.features.includes('staff');
}

// ---------- документы пункта ----------

function decode(userId, row) {
  const text = open(userId, row.data_enc, 'data');
  let data = null;
  try { data = text == null ? null : JSON.parse(text); } catch (_) { data = null; }
  return { version: row.version, data, updatedAt: row.updated_at, fromSite: !row.device_id };
}

/** staff и schedule одного пункта. Память общая с программой: её запись (app_doc_put) сразу сбрасывает это чтение. */
async function pointDocs(userId, pointId) {
  const part = `staffdocs:${pointId}`;
  let rows = deviceCache.getUserData(userId, part);
  if (!rows) {
    const epoch = deviceCache.currentDataEpoch();
    rows = await supabaseFetch(`app_docs?user_id=eq.${q(userId)}&secret=eq.false&scope=eq.${q(pointId)}&key=in.(staff,schedule)&select=key,version,data_enc,updated_at,device_id`);
    deviceCache.putUserData(userId, part, rows, epoch);
  }
  const out = { staff: null, schedule: null };
  for (const row of rows) if (KEYS.includes(row.key)) out[row.key] = decode(userId, row);
  return out;
}

function pointView(p) {
  return { id: p.id, name: p.name || `Пункт ${p.wbPointId || p.wb_point_id}`, wbPointId: String(p.wbPointId ?? p.wb_point_id ?? '') };
}

// ---------- проверка того, что пишет сайт ----------

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);

function idList(list, label, max) {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return `${label}: ожидался список`;
  if (list.length > max) return `${label}: слишком много записей`;
  const seen = new Set();
  for (const x of list) {
    // программа сливает такие списки по id: элемент без строкового id превратил бы весь список в одно значение
    if (!isObj(x) || typeof x.id !== 'string' || !x.id || x.id.length > 64) return `${label}: у записи нет id`;
    if (seen.has(x.id)) return `${label}: повторяется id ${x.id}`;
    seen.add(x.id);
  }
  return null;
}

function validate(key, data) {
  if (!isObj(data)) return 'Документ должен быть объектом';
  if (key === 'staff') {
    if (!Array.isArray(data.staff_list)) return 'Нет списка сотрудников';
    const err = idList(data.staff_list, 'Сотрудники', 500);
    if (err) return err;
    for (const s of data.staff_list) if (typeof s.name !== 'string' || s.name.length > 200) return 'Некорректное имя сотрудника';
    return null;
  }
  if (!isObj(data.shifts)) return 'Нет смен';
  for (const [day, list] of Object.entries(data.shifts)) {
    if (!DAY_RE.test(day) || !Array.isArray(list)) return `Некорректный день ${day}`;
    const seen = new Set();
    for (const sh of list) {
      if (!isObj(sh) || typeof sh.staffId !== 'string' || !sh.staffId) return `Некорректная смена ${day}`;
      if (seen.has(sh.staffId)) return `У сотрудника две смены ${day}`;
      seen.add(sh.staffId);
    }
  }
  for (const [field, label] of [['adjustments', 'Премии и штрафы'], ['payments', 'Выплаты'], ['deductions', 'Удержания WB']]) {
    const err = idList(data[field], label, 20000);
    if (err) return err;
  }
  return null;
}

function filled(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return false;
}

const VITAL = { staff: 'staff_list', schedule: 'shifts' };

// ---------- обработчики владельца ----------

async function overview(req, res, userId) {
  const [points, allowed] = await Promise.all([sync.listPoints(userId), hasStaff(userId)]);
  return res.status(200).json({ allowed, points: points.map(pointView) });
}

async function getPoint(req, res, userId) {
  const point = await sync.ownPoint(userId, req.query.point);
  const docs = await pointDocs(userId, point.id);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ point: pointView(point), ...docs });
}

async function getAll(req, res, userId) {
  const points = await sync.listPoints(userId);
  const out = [];
  for (const p of points) out.push({ point: pointView(p), ...(await pointDocs(userId, p.id)) });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ points: out });
}

async function putDoc(req, res, userId) {
  const b = req.body || {};
  const key = String(b.key || '');
  if (!KEYS.includes(key)) return fail(res, 400, 'VALIDATION_ERROR', 'Неизвестный документ');
  const point = await sync.ownPoint(userId, b.point);
  const error = validate(key, b.data);
  if (error) return fail(res, 400, 'VALIDATION_ERROR', error);
  // Предохранитель, как в программе (docs::keep_vital): сайт не стирает всех сотрудников или все смены разом
  // без явного подтверждения. Программа с данными на ПК всё равно вернула бы их обратно.
  if (!b.confirmEmpty && !filled(b.data[VITAL[key]])) {
    const current = (await pointDocs(userId, point.id))[key];
    if (current && current.data && filled(current.data[VITAL[key]])) {
      return fail(res, 409, 'EMPTY_GUARD', key === 'staff' ? 'Список сотрудников стал бы пустым' : 'В графике не осталось бы ни одной смены', { current });
    }
  }
  try {
    const out = await sync.docPut(userId, null, { key, point: point.id, base: b.base, data: b.data });
    return res.status(200).json(out);
  } catch (err) {
    if (err.code === 'VERSION_CONFLICT') {
      // docPut отдаёт текущую версию вместе с документами аккаунта — берём только свою
      const current = (await pointDocs(userId, point.id))[key];
      return fail(res, 409, 'VERSION_CONFLICT', 'График уже изменили в другом месте', { current });
    }
    throw err;
  }
}

/** Кто и когда записал версии документа: из app_docs_history (последние 20) и текущей строки. */
async function history(req, res, userId) {
  const point = await sync.ownPoint(userId, req.query.point || req.body?.point);
  const key = String(req.query.key || req.body?.key || '');
  if (!KEYS.includes(key)) return fail(res, 400, 'VALIDATION_ERROR', 'Неизвестный документ');
  if (req.method === 'POST') return restore(req, res, userId, point, key);
  const [current, rows] = await Promise.all([
    supabaseFetch(`app_docs?user_id=eq.${q(userId)}&scope=eq.${q(point.id)}&key=eq.${q(key)}&secret=eq.false&select=version,device_id,updated_at`),
    supabaseFetch(`app_docs_history?user_id=eq.${q(userId)}&scope=eq.${q(point.id)}&key=eq.${q(key)}&select=version,device_id,created_at&order=version.desc&limit=20`),
  ]);
  const ids = [...new Set([...current, ...rows].map(r => r.device_id).filter(Boolean))];
  const devices = ids.length ? await supabaseFetch(`app_devices?id=in.(${ids.map(q).join(',')})&user_id=eq.${q(userId)}&select=id,name`).catch(() => []) : [];
  const names = Object.fromEntries(devices.map(d => [d.id, d.name]));
  const who = id => (id ? names[id] || 'компьютер' : 'сайт');
  // строка истории версии N пишется в момент, когда её заменила N+1: время записи N — время архивации N−1
  const archivedAt = Object.fromEntries(rows.map(r => [r.version, r.created_at]));
  const items = [];
  if (current[0]) items.push({ version: current[0].version, at: current[0].updated_at, by: who(current[0].device_id), current: true });
  for (const r of rows) items.push({ version: r.version, at: archivedAt[r.version - 1] || null, by: who(r.device_id), current: false });
  return res.status(200).json({ items });
}

async function restore(req, res, userId, point, key) {
  const version = Number(req.body?.version);
  if (!Number.isSafeInteger(version) || version <= 0) return fail(res, 400, 'VALIDATION_ERROR', 'Некорректная версия');
  const [row] = await supabaseFetch(`app_docs_history?user_id=eq.${q(userId)}&scope=eq.${q(point.id)}&key=eq.${q(key)}&version=eq.${version}&select=data_enc&limit=1`);
  if (!row) return fail(res, 404, 'NOT_FOUND', 'Этой версии уже нет в истории');
  const text = open(userId, row.data_enc, 'data');
  let data = null;
  try { data = text == null ? null : JSON.parse(text); } catch (_) { data = null; }
  if (!data || validate(key, data)) return fail(res, 422, 'UNREADABLE', 'Эту версию не удалось прочитать');
  const [current] = await supabaseFetch(`app_docs?user_id=eq.${q(userId)}&scope=eq.${q(point.id)}&key=eq.${q(key)}&secret=eq.false&select=version`);
  // обычная запись поверх текущей: прежняя версия сама уйдёт в историю, вернуть можно и обратно
  const out = await sync.docPut(userId, null, { key, point: point.id, base: current ? current.version : 0, data });
  return res.status(200).json({ ...out, data });
}

// ---------- ссылка для сотрудников ----------

function newToken() {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (const byte of bytes) out += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
  return out;
}

function publicUrl(token) {
  const origin = String(process.env.PUBLIC_APP_URL || 'https://shk-wb.ru').replace(/\/$/, '');
  return `${origin}/grafik/${token}`;
}

function linkView(row) {
  return row ? { token: row.token, url: publicUrl(row.token), shortNames: row.short_names, showSubs: row.show_subs, createdAt: row.created_at } : null;
}

const publicCache = new Map();

async function link(req, res, userId) {
  const point = await sync.ownPoint(userId, req.query.point || req.body?.point);
  const active = `staff_share_links?user_id=eq.${q(userId)}&point_id=eq.${q(point.id)}&revoked_at=is.null`;
  if (req.method === 'GET') {
    const rows = await supabaseFetch(`${active}&select=token,short_names,show_subs,created_at&limit=1`);
    return res.status(200).json({ link: linkView(rows[0]) });
  }
  const now = new Date().toISOString();
  const old = await supabaseFetch(`${active}&select=token`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ revoked_at: now }) });
  for (const r of old) publicCache.delete(r.token);
  if (req.method === 'DELETE') return res.status(200).json({ link: null });
  if (req.method !== 'POST') return fail(res, 405, 'METHOD', 'Method not allowed');
  const b = req.body || {};
  const rows = await supabaseFetch('staff_share_links?select=token,short_names,show_subs,created_at', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: userId, point_id: point.id, token: newToken(), short_names: b.shortNames !== false, show_subs: b.showSubs !== false }),
  });
  return res.status(201).json({ link: linkView(rows[0]) });
}

// ---------- что видит сотрудник ----------

function minutes(t) {
  const [h, m] = String(t || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function clock(m) { return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; }

function hoursOf(sh, dayHours) {
  const a = minutes(dayHours.from), b = minutes(dayHours.to);
  if (sh.kind === 'custom' && sh.from && sh.to) return `${clock(minutes(sh.from))}–${clock(minutes(sh.to))}`;
  if (sh.kind === 'half') return `${clock(a)}–${clock(a + Math.round((b - a) / 2))}`;
  return `${clock(a)}–${clock(b)}`;
}

function monthShift(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Только то, что нужно сотруднику: имена, дни, часы, замены. Три месяца: прошлый, этот и следующий. */
function publicView(point, staffDoc, schedule, row, today) {
  const dayHours = { from: '09:00', to: '21:00', ...(schedule?.dayHours || {}) };
  const month = today.slice(0, 7);
  const months = [monthShift(month, -1), month, monthShift(month, 1)];
  const list = Array.isArray(staffDoc?.staff_list) ? staffDoc.staff_list : [];
  const shortName = name => String(name || '').trim().split(/\s+/)[0] || 'Сотрудник';
  const nameOf = id => {
    const s = list.find(x => x.id === id);
    const full = s?.name || schedule?.removedNames?.[id] || 'Сотрудник';
    return row.short_names ? shortName(full) : String(full).trim();
  };
  const keys = new Map();
  const keyOf = id => {
    if (!keys.has(id)) keys.set(id, `p${keys.size + 1}`);
    return keys.get(id);
  };
  const days = {};
  for (const [day, shifts] of Object.entries(schedule?.shifts || {})) {
    if (!months.includes(day.slice(0, 7)) || !Array.isArray(shifts) || !shifts.length) continue;
    days[day] = shifts.map(sh => ({ k: keyOf(sh.staffId), h: hoursOf(sh, dayHours), ...(row.show_subs && sh.replaces ? { sub: nameOf(sh.replaces) } : {}) }));
  }
  // в фильтре «чьи смены» — все работающие, даже без смен в эти месяцы
  for (const s of list) if (s.active !== false) keyOf(s.id);
  const people = [...keys.entries()].map(([id, k]) => ({ k, name: nameOf(id) }));
  const owner = (Array.isArray(schedule?.ownerDays) ? schedule.ownerDays : []).filter(d => months.includes(String(d).slice(0, 7)));
  return { point: point.name || 'Пункт выдачи', months, dayHours: { from: clock(minutes(dayHours.from)), to: clock(minutes(dayHours.to)) }, people, days, owner };
}

function todayMsk() {
  // график ведут по местному дню пункта; без часового пояса пункта берём московский
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

async function handlePublic(req, res) {
  try {
    if (req.method !== 'GET') return fail(res, 405, 'METHOD', 'Method not allowed');
    const token = String(req.query.token || '');
    const gone = () => fail(res, 404, 'LINK_INACTIVE', 'Ссылка не работает. Попросите у владельца пункта новую.');
    if (!TOKEN_RE.test(token)) return gone();
    if (!await enforceRateLimit(req, res, { scope: 'staff-public', limit: 120, windowSeconds: 600 })) return;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const hit = publicCache.get(token);
    if (hit && hit.until > Date.now()) return hit.body ? res.status(200).json(hit.body) : gone();
    const [row] = await supabaseFetch(`staff_share_links?token=eq.${q(token)}&revoked_at=is.null&select=user_id,point_id,short_names,show_subs&limit=1`);
    let body = null;
    if (row && UUID_RE.test(row.point_id) && await hasStaff(row.user_id)) {
      const point = await sync.ownPoint(row.user_id, row.point_id).catch(() => null);
      if (point) {
        const docs = await pointDocs(row.user_id, point.id);
        const updated = [docs.schedule?.updatedAt, docs.staff?.updatedAt].filter(Boolean).sort().pop() || null;
        body = { ...publicView(point, docs.staff?.data, docs.schedule?.data, row, todayMsk()), updatedAt: updated };
      }
    }
    if (publicCache.size > 2000) publicCache.clear();
    publicCache.set(token, { body, until: Date.now() + PUBLIC_CACHE_MS });
    return body ? res.status(200).json(body) : gone();
  } catch (error) {
    console.error('staff public', error.message);
    if (!res.headersSent) return fail(res, 502, 'SERVER_ERROR', 'Не удалось загрузить график. Попробуйте ещё раз.');
  }
}

// ---------- вход ----------

const OWNER_ACTIONS = new Set(['staff', 'staff-all', 'staff-history', 'staff-link']);

function isOwnerAction(action) { return OWNER_ACTIONS.has(action); }
function isPublicAction(action) { return action === 'staff-public'; }

/** /api/cabinet/staff* — после requireUser в api/cabinet.js. Ошибки базы — наверх, их отвечает кабинет. */
async function handleOwner(req, res, user, action) {
  if (!await enforceRateLimit(req, res, { scope: 'staff-owner', limit: 600, windowSeconds: 600, key: user.id })) return;
  try {
    if (action === 'staff' && req.method === 'GET' && !req.query.point) return await overview(req, res, user.id);
    if (!await hasStaff(user.id)) return fail(res, 403, 'STAFF_REQUIRED', 'Раздел «Сотрудники» входит в тарифы «Стандарт» и «Про»');
    if (action === 'staff' && req.method === 'GET') return await getPoint(req, res, user.id);
    if (action === 'staff' && req.method === 'PUT') return await putDoc(req, res, user.id);
    if (action === 'staff-all' && req.method === 'GET') return await getAll(req, res, user.id);
    if (action === 'staff-history' && (req.method === 'GET' || req.method === 'POST')) return await history(req, res, user.id);
    if (action === 'staff-link') return await link(req, res, user.id);
    return fail(res, 404, 'NOT_FOUND', 'Метод не найден');
  } catch (error) {
    // ошибки _app-sync (пункт не найден, документ велик) — с понятным текстом
    if (error.status && error.code && !res.headersSent) return fail(res, error.status, error.code, error.message, error.extra);
    throw error;
  }
}

module.exports = {
  handleOwner,
  handlePublic,
  isOwnerAction,
  isPublicAction,
  _test: { publicView, validate, hoursOf, forgetPublic: () => publicCache.clear() },
};
