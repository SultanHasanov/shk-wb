// Облако «Помощника ПВЗ»: пункты аккаунта, архив по пункту, зеркало базы пункта,
// документы (заметки, сотрудники, график, настройки) и секреты (токены).
//
// Кто что может (проверяется на каждый запрос, ПК уже проверен requireDevice):
//   * отправлять архив и зеркало своего пункта — любой вошедший (собранное не теряется);
//   * скачивать архив — только с услугой «Архив»; зеркало — только пункты из пакетов «Пункт с любого ПК»
//     (или безлимит/бесплатный режим);
//   * документы и секреты — любой вошедший (это его же настройки).
// Пункт всегда ищется по (id, user_id) — чужой пункт не найдётся даже по точному id.
const { supabaseFetch } = require('./_supabase');
const { open, seal } = require('./_app-crypto');
const { appError, dbErrorCode, entitlementsFor } = require('./_app-account');
const archive = require('./_archive-db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PUSH_ROWS = 1000;
const MAX_PULL_ROWS = 2000;

const DOC_KEYS = Object.freeze({
  // по аккаунту
  notes: { scope: 'account' },
  settings: { scope: 'account' },
  // по пункту
  staff: { scope: 'point' },
  schedule: { scope: 'point' },
  video: { scope: 'point' },
});
const SECRET_KEYS = Object.freeze({
  telegram: { scope: 'account' },
  ivideon: { scope: 'point' },
});

function str(value, max) {
  if (value == null) return '';
  return String(value).slice(0, max);
}

async function requireArchive(userId) {
  const ent = await entitlementsFor(userId);
  if (!ent.features.includes('archive')) {
    throw appError(403, 'ARCHIVE_REQUIRED', 'Загрузка архива на другие ПК и просмотр других пунктов — в услуге «Архив клиентов»');
  }
  return ent;
}

// ---------- пункты ----------

async function listPoints(userId) {
  const rows = await supabaseFetch(`app_points?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=id,wb_point_id,name,last_sync_at,mirror_at,created_at,last_device_id&order=created_at.asc`);
  return rows.map(p => ({
    id: p.id,
    wbPointId: String(p.wb_point_id),
    name: p.name,
    lastSyncAt: p.last_sync_at,
    mirrorAt: p.mirror_at,
    createdAt: p.created_at,
    lastDeviceId: p.last_device_id,
  }));
}

async function registerPoint(userId, deviceId, wbPointId, name) {
  const wb = Number(wbPointId);
  if (!Number.isSafeInteger(wb) || wb <= 0) throw appError(400, 'VALIDATION_ERROR', 'Некорректный номер пункта');
  const { limits } = await entitlementsFor(userId);
  try {
    const id = await supabaseFetch('rpc/app_register_point', {
      method: 'POST',
      body: JSON.stringify({ p_user: userId, p_wb: wb, p_name: str(name, 200), p_limit: limits.points, p_device: deviceId }),
    });
    return { id, limit: limits.points };
  } catch (error) {
    if (dbErrorCode(error) === 'POINT_LIMIT') {
      throw appError(409, 'POINT_LIMIT', `По тарифу можно подключить пунктов: ${limits.points}. Отключите один из них или докупите пункт.`, {
        points: await listPoints(userId),
        limit: limits.points,
      });
    }
    throw error;
  }
}

async function ownPoint(userId, pointId) {
  if (!UUID_RE.test(String(pointId || ''))) throw appError(400, 'VALIDATION_ERROR', 'Некорректный пункт');
  const rows = await supabaseFetch(`app_points?id=eq.${encodeURIComponent(pointId)}&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=id,wb_point_id,name,mirror_schema,mirror_floor,mirror_at&limit=1`);
  if (!rows.length) throw appError(404, 'POINT_NOT_FOUND', 'Пункт не подключён к аккаунту');
  return rows[0];
}

// Отключить пункт: данные в облаке остаются (подключите снова — всё на месте).
async function revokePoint(userId, pointId) {
  await ownPoint(userId, pointId);
  await supabaseFetch(`app_points?id=eq.${encodeURIComponent(pointId)}&user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
}

// ---------- архив ----------

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function archivePush(userId, pointId, body) {
  await ownPoint(userId, pointId);
  const goods = asArray(body.goods);
  const clients = asArray(body.clients);
  const reviews = asArray(body.reviews);
  const shk = asArray(body.shk);
  if (goods.length + clients.length + reviews.length + shk.length > MAX_PUSH_ROWS) {
    throw appError(413, 'TOO_LARGE', `Не больше ${MAX_PUSH_ROWS} записей за раз`);
  }
  const payload = {
    p_point: pointId,
    p_goods: goods.filter(g => g && g.uid && g.sid && g.data).map(g => ({
      uid: str(g.uid, 80),
      sid: str(g.sid, 40),
      status: str(g.status, 40),
      purpose: str(g.purpose, 40),
      updated: str(g.updated, 40),
      rank: g.rank ? 1 : 0,
      data: seal(userId, str(g.data, 12000)),
    })),
    p_clients: clients.filter(c => c && c.sid).map(c => ({
      sid: str(c.sid, 40),
      mobile: seal(userId, str(c.mobile, 40)),
      name: seal(userId, str(c.name, 200)),
      first_seen: str(c.first_seen, 10),
      last_seen: str(c.last_seen, 10),
    })),
    p_reviews: reviews.filter(r => r && r.rid && r.data).map(r => ({
      rid: str(r.rid, 80),
      rated_at: str(r.rated_at, 40),
      data: seal(userId, str(r.data, 24000)),
    })),
    p_shk: shk.filter(x => x && x.code && x.data && x.fetched_at).map(x => ({
      code: str(x.code, 80),
      fetched_at: str(x.fetched_at, 40),
      data: seal(userId, str(x.data, 48000)),
    })),
  };
  const changed = await archive.push(payload);
  // в своём Postgres пунктов нет — отметку синхронизации ставим в Supabase сами
  if (process.env.ARCHIVE_DATABASE_URL) {
    await supabaseFetch(`app_points?id=eq.${encodeURIComponent(pointId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_sync_at: new Date().toISOString() }),
    }).catch(error => console.error('last_sync_at:', error.message));
  }
  return { changed };
}

function cursor(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}


/** Изменения архива пункта после курсоров since = {goods, clients, reviews, shk}. */
async function archivePull(userId, pointId, since = {}, limit = MAX_PULL_ROWS) {
  await requireArchive(userId);
  await ownPoint(userId, pointId);
  const n = Math.max(1, Math.min(MAX_PULL_ROWS, Number(limit) || MAX_PULL_ROWS));
  const [goods, clients, reviews, shk] = await Promise.all([
    archive.pull('app_archive_goods', pointId, cursor(since.goods), n),
    archive.pull('app_archive_clients', pointId, cursor(since.clients), n),
    archive.pull('app_archive_reviews', pointId, cursor(since.reviews), n),
    archive.pull('app_archive_shk', pointId, cursor(since.shk), n),
  ]);
  const last = (rows, prev) => (rows.length ? rows[rows.length - 1].seq : cursor(prev));
  return {
    goods: goods.map(g => ({ uid: g.uid, sid: g.sid, status: g.status, purpose: g.purpose, updated: g.updated, rank: g.rank, data: open(userId, g.data_enc) })).filter(g => g.data),
    clients: clients.map(c => ({ sid: c.sid, mobile: open(userId, c.mobile_enc) || '', name: open(userId, c.name_enc) || '', first_seen: c.first_seen, last_seen: c.last_seen })),
    reviews: reviews.map(r => ({ rid: r.rid, rated_at: r.rated_at, data: open(userId, r.data_enc) })).filter(r => r.data),
    shk: shk.map(x => ({ code: x.code, fetched_at: x.fetched_at, data: open(userId, x.data_enc) })).filter(x => x.data),
    next: {
      goods: last(goods, since.goods),
      clients: last(clients, since.clients),
      reviews: last(reviews, since.reviews),
      shk: last(shk, since.shk),
    },
    more: [goods, clients, reviews, shk].some(rows => rows.length >= n),
  };
}

// ---------- зеркало базы пункта ----------

const TABLE_RE = /^[a-z_]{1,40}$/;

// Зеркало — платная услуга (пакеты mirror_* в _app-plans.js): хранится только для первых
// N пунктов аккаунта по порядку подключения. Остальным отправку принимаем и не пишем, отдаём
// пусто — старые программы (1.5.0 шлют зеркало всем) не видят ошибки и не повторяют отправку.
// У такого пункта mirror_at остаётся пустым, поэтому после покупки программа отправит всё заново.
// APP_MIRROR_DISABLED=1 — выключить зеркало всем (аварийный выключатель).
function mirrorDisabled() {
  return /^(1|true|yes)$/i.test(String(process.env.APP_MIRROR_DISABLED || ''));
}

async function mirrorAllowed(userId, pointId) {
  if (mirrorDisabled()) return false;
  const { mirror } = await entitlementsFor(userId);
  if (mirror <= 0) return false;
  const rows = await supabaseFetch(`app_points?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=id&order=created_at.asc&limit=${mirror}`);
  return rows.some(r => r.id === pointId);
}

async function mirrorPush(userId, pointId, body) {
  await ownPoint(userId, pointId);
  if (!await mirrorAllowed(userId, pointId)) return { changed: 0, disabled: true };
  const rows = asArray(body.rows);
  if (rows.length > MAX_PUSH_ROWS) throw appError(413, 'TOO_LARGE', `Не больше ${MAX_PUSH_ROWS} строк за раз`);
  let schema = null;
  if (body.schema && typeof body.schema === 'object' && !Array.isArray(body.schema)) {
    schema = {};
    for (const [t, sql] of Object.entries(body.schema)) {
      // только CREATE TABLE известного вида: схема потом выполняется на других ПК
      if (TABLE_RE.test(t) && typeof sql === 'string' && sql.length < 20000 && /^CREATE TABLE/i.test(sql.trim()) && !sql.includes(';')) schema[t] = sql;
    }
  }
  const payload = rows
    .filter(r => r && TABLE_RE.test(String(r.t || '')) && r.k)
    .map(r => ({ t: r.t, k: str(r.k, 400), d: r.d == null ? null : seal(userId, str(r.d, 48000)) }));
  const changed = await supabaseFetch('rpc/app_mirror_push', {
    method: 'POST',
    body: JSON.stringify({ p_point: pointId, p_rows: payload, p_schema: schema }),
  });
  return { changed: Number(changed) || 0 };
}

async function mirrorPull(userId, pointId, since, limit = MAX_PULL_ROWS) {
  const point = await ownPoint(userId, pointId);
  const from = cursor(since);
  if (!await mirrorAllowed(userId, pointId)) {
    return { reset: false, schema: point.mirror_schema || null, at: point.mirror_at, rows: [], next: from, more: false, disabled: true };
  }
  // отстали дальше, чем помнятся удаления, — начинаем зеркало заново
  const reset = from > 0 && from < Number(point.mirror_floor || 0);
  const n = Math.max(1, Math.min(MAX_PULL_ROWS, Number(limit) || MAX_PULL_ROWS));
  const rows = await supabaseFetch(`app_point_rows?point_id=eq.${encodeURIComponent(pointId)}&seq=gt.${reset ? 0 : from}&select=tbl,pk,data_enc,seq&order=seq.asc&limit=${n}`);
  return {
    reset,
    schema: point.mirror_schema || null,
    at: point.mirror_at,
    rows: rows.map(r => ({ t: r.tbl, k: r.pk, d: r.data_enc ? open(userId, r.data_enc) : null })),
    next: rows.length ? rows[rows.length - 1].seq : (reset ? 0 : from),
    more: rows.length >= n,
  };
}

// ---------- документы и секреты ----------

async function scopeFor(userId, kind, pointId) {
  if (kind.scope === 'account') return 'account';
  const point = await ownPoint(userId, pointId);
  return point.id;
}

async function docsGet(userId, deviceId, { point, secret = false }) {
  const keys = secret ? SECRET_KEYS : DOC_KEYS;
  const scopes = ['account'];
  if (point) scopes.push((await ownPoint(userId, point)).id);
  const rows = await supabaseFetch(`app_docs?user_id=eq.${encodeURIComponent(userId)}&secret=eq.${secret}&scope=in.(${scopes.map(s => `"${s}"`).join(',')})&select=scope,key,version,data_enc,updated_at`);
  const out = {};
  for (const row of rows) {
    const kind = keys[row.key];
    if (!kind) continue;
    if ((kind.scope === 'account') !== (row.scope === 'account')) continue;
    const text = open(userId, row.data_enc, secret ? 'secret' : 'data');
    let data = null;
    try { data = text == null ? null : JSON.parse(text); } catch (_) { data = null; }
    out[row.key] = { version: row.version, data, updatedAt: row.updated_at };
  }
  if (secret && Object.keys(out).length) {
    await supabaseFetch('app_secret_access', {
      method: 'POST',
      body: JSON.stringify(Object.keys(out).map(key => ({ user_id: userId, device_id: deviceId, key, action: 'read' }))),
    }).catch(() => {});
  }
  return out;
}

async function docPut(userId, deviceId, { key, point, base, data, secret = false }) {
  const keys = secret ? SECRET_KEYS : DOC_KEYS;
  const kind = keys[String(key || '')];
  if (!kind) throw appError(400, 'VALIDATION_ERROR', 'Неизвестный документ');
  const scope = await scopeFor(userId, kind, point);
  const text = JSON.stringify(data ?? null);
  if (text.length > 2000000) throw appError(413, 'TOO_LARGE', 'Слишком большой документ');
  try {
    const version = await supabaseFetch('rpc/app_doc_put', {
      method: 'POST',
      body: JSON.stringify({
        p_user: userId,
        p_scope: scope,
        p_key: key,
        p_base: Number(base) || 0,
        p_data: seal(userId, text, secret ? 'secret' : 'data'),
        p_secret: Boolean(secret),
        p_device: deviceId,
      }),
    });
    if (secret) {
      await supabaseFetch('app_secret_access', {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, device_id: deviceId, key, action: 'write' }),
      }).catch(() => {});
    }
    return { version: Number(version) };
  } catch (error) {
    if (dbErrorCode(error) === 'VERSION_CONFLICT') {
      const current = await docsGet(userId, deviceId, { point: kind.scope === 'point' ? point : null, secret });
      throw appError(409, 'VERSION_CONFLICT', 'Документ уже изменили на другом ПК', { current: current[key] || null });
    }
    throw error;
  }
}

async function secretAccessLog(userId, limit = 30) {
  const rows = await supabaseFetch(`app_secret_access?user_id=eq.${encodeURIComponent(userId)}&select=key,action,created_at,device_id&order=created_at.desc&limit=${Math.max(1, Math.min(100, Number(limit) || 30))}`);
  const ids = [...new Set(rows.map(r => r.device_id).filter(Boolean))];
  const devices = ids.length ? await supabaseFetch(`app_devices?id=in.(${ids.join(',')})&select=id,name`).catch(() => []) : [];
  const names = Object.fromEntries(devices.map(d => [d.id, d.name]));
  return rows.map(r => ({ key: r.key, action: r.action, at: r.created_at, device: names[r.device_id] || null }));
}

// Удалить облачные данные пункта (архив, зеркало, документы пункта) — по просьбе владельца.
async function purgePoint(userId, pointId) {
  await ownPoint(userId, pointId);
  await archive.purge(pointId);
  await supabaseFetch(`app_point_rows?point_id=eq.${encodeURIComponent(pointId)}`, { method: 'DELETE' });
  await supabaseFetch(`app_docs?user_id=eq.${encodeURIComponent(userId)}&scope=eq.${encodeURIComponent(pointId)}`, { method: 'DELETE' });
  await supabaseFetch(`app_docs_history?user_id=eq.${encodeURIComponent(userId)}&scope=eq.${encodeURIComponent(pointId)}`, { method: 'DELETE' });
  await supabaseFetch(`app_points?id=eq.${encodeURIComponent(pointId)}&user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ revoked_at: new Date().toISOString(), mirror_schema: null, mirror_at: null, last_sync_at: null }),
  });
}

module.exports = {
  DOC_KEYS,
  SECRET_KEYS,
  archivePull,
  archivePush,
  docPut,
  docsGet,
  listPoints,
  mirrorPull,
  mirrorPush,
  ownPoint,
  purgePoint,
  registerPoint,
  revokePoint,
  secretAccessLog,
};
