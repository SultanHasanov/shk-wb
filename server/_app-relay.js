// Передатчик «Загрузка с другого ПК» (Помощник ПВЗ 1.6+): данные пункта идут с ПК на ПК,
// на сервере ничего не хранится дольше, чем нужно, чтобы их забрали.
//
//   ПК-источник держит долгий запрос inbox (25 с) и сообщает, какие пункты у него есть;
//   ПК-получатель шлёт ask → сервер будит источник → источник собирает пакет и кладёт его
//   кусками (put) → получатель забирает (get) и подтверждает (ack) → куски удаляются.
//   Незабранное удаляется через JOB_TTL_MS.
//
// Состояние — в памяти процесса (selfhost: один процесс на сервере), куски — файлы во временной
// папке. После перезапуска сервера ПК переподключатся за ≤25 с, незаконченные загрузки начнутся заново.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { supabaseFetch } = require('./_supabase');
const { appError, entitlementsFor } = require('./_app-account');

const WAIT_MS = 25_000;
const ONLINE_MS = 70_000;
const JOB_TTL_MS = 30 * 60_000;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_JOB_BYTES = 400 * 1024 * 1024;
const MAX_USER_BYTES = 600 * 1024 * 1024;
const MAX_POINTS = 50;
const KINDS = new Set(['current', 'history']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WB_RE = /^\d{1,15}$/;

function relayDir() {
  return process.env.RELAY_DIR || path.join(os.tmpdir(), 'shk-relay');
}

// userId → Map(deviceId → { name, points, seenAt, waiters:Set })
const presence = new Map();
// jobId → { id, user, from, to, wb, kind, since, createdAt, sent, chunks:Map(idx → {file,size,last}), bytes, error, waiters:Set }
const jobs = new Map();

function devicesOf(userId) {
  let map = presence.get(userId);
  if (!map) {
    map = new Map();
    presence.set(userId, map);
  }
  return map;
}

function wake(waiters) {
  for (const w of [...waiters]) w();
  waiters.clear();
}

// Ждать сигнала (или таймаута). Возвращает true, если разбудили.
function waitOn(waiters, ms) {
  return new Promise(resolve => {
    let done = false;
    const finish = woke => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      waiters.delete(onWake);
      resolve(woke);
    };
    const onWake = () => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    waiters.add(onWake);
  });
}

function str(value, max) {
  return value == null ? '' : String(value).slice(0, max);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Что ПК рассказывает о своих пунктах: только короткие поля, без данных.
function cleanPoints(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_POINTS).filter(p => p && WB_RE.test(String(p.wb || ''))).map(p => ({
    wb: String(p.wb),
    name: str(p.name, 120),
    live: p.live === true,
    at: str(p.at, 40) || null,
    rows: num(p.rows),
    history: num(p.history),
  }));
}

function userBytes(userId) {
  let total = 0;
  for (const job of jobs.values()) if (job.user === userId) total += job.bytes;
  return total;
}

function dropJob(job) {
  jobs.delete(job.id);
  wake(job.waiters);
  fs.rm(path.join(relayDir(), job.id), { recursive: true, force: true }, () => {});
}

function sweep(now = Date.now()) {
  for (const job of jobs.values()) {
    if (now - job.createdAt > JOB_TTL_MS) dropJob(job);
  }
  for (const [user, map] of presence) {
    for (const [id, d] of map) {
      if (now - d.seenAt > 7 * 24 * 3600_000 && !d.waiters.size) map.delete(id);
    }
    if (!map.size) presence.delete(user);
  }
}

let sweeper = null;
function startSweeper() {
  if (sweeper) return;
  // старые куски прошлого запуска больше никому не нужны
  fs.rm(relayDir(), { recursive: true, force: true }, () => {});
  sweeper = setInterval(sweep, 60_000);
  if (sweeper.unref) sweeper.unref();
}

// ---------- источник ----------

// Долгий запрос ПК: отметиться «в сети», рассказать о своих пунктах, забрать задания.
async function inbox(userId, device, body, { waitMs = WAIT_MS } = {}) {
  startSweeper();
  const map = devicesOf(userId);
  let entry = map.get(device.id);
  if (!entry) {
    entry = { waiters: new Set() };
    map.set(device.id, entry);
  }
  // название ПК — из аккаунта (его задают и меняют в профиле), а не то, что прислал ПК
  entry.name = device.name || str(body.name, 80) || 'Компьютер';
  entry.points = cleanPoints(body.points);
  entry.seenAt = Date.now();
  const take = () => {
    const out = [];
    for (const job of jobs.values()) {
      if (job.user === userId && job.to === device.id && !job.sent) {
        job.sent = true;
        out.push({ id: job.id, wb: job.wb, kind: job.kind, since: job.since });
      }
    }
    return out;
  };
  let list = take();
  if (!list.length && waitMs > 0) {
    await waitOn(entry.waiters, waitMs);
    list = take();
  }
  entry.seenAt = Date.now();
  return { jobs: list };
}

// Кусок пакета от источника (тело — байты). error — источник не смог собрать пакет.
function put(userId, device, query, bytes) {
  const job = jobs.get(str(query.job, 40));
  if (!job || job.user !== userId || job.to !== device.id) throw appError(404, 'JOB_GONE', 'Загрузка уже отменена');
  if (query.error) {
    job.error = str(query.error, 300);
    wake(job.waiters);
    return { ok: true };
  }
  const idx = Number(query.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx > 100_000) throw appError(400, 'VALIDATION_ERROR', 'Некорректный кусок');
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw appError(400, 'VALIDATION_ERROR', 'Пустой кусок');
  if (bytes.length > MAX_CHUNK_BYTES) throw appError(413, 'TOO_LARGE', 'Слишком большой кусок');
  if (job.bytes + bytes.length > MAX_JOB_BYTES || userBytes(userId) + bytes.length > MAX_USER_BYTES) {
    job.error = 'Слишком большой объём данных за раз';
    wake(job.waiters);
    throw appError(413, 'TOO_LARGE', job.error);
  }
  if (job.chunks.has(idx)) return { ok: true }; // повтор после обрыва
  const dir = path.join(relayDir(), job.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(idx));
  fs.writeFileSync(file, bytes);
  job.chunks.set(idx, { file, size: bytes.length, last: query.last === '1' || query.last === 'true' });
  job.bytes += bytes.length;
  wake(job.waiters);
  return { ok: true };
}

// ---------- получатель ----------

// Пункты, которые этот аккаунт может загружать с других ПК (услуга «Загрузка с другого ПК»,
// пакеты mirror_*: первые N пунктов аккаунта по порядку подключения).
async function allowedPoints(userId) {
  const { mirror } = await entitlementsFor(userId);
  if (mirror <= 0) return [];
  const rows = await supabaseFetch(`app_points?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=wb_point_id&order=created_at.asc&limit=${Math.min(mirror, 99)}`);
  return rows.map(r => String(r.wb_point_id));
}

// Все ПК аккаунта (кроме этого) и их пункты. «В сети» и подробности о пунктах — из памяти
// передатчика; ПК, которых в памяти нет (выключены, сервер перезапускался), берутся из
// app_devices — иначе получатель видел «других компьютеров нет», хотя в аккаунте они есть.
// accountDevices — listDevices() аккаунта; пустой список (сбой БД) — показываем только память.
function peers(userId, device, accountDevices = [], now = Date.now()) {
  startSweeper();
  const map = presence.get(userId) || new Map();
  const known = new Map((accountDevices || []).map(d => [d.id, d]));
  const devices = [];
  for (const [id, d] of map) {
    if (id === device.id || (known.size && !known.has(id))) continue;
    const acc = known.get(id);
    devices.push({
      id,
      name: acc?.name || d.name,
      online: now - d.seenAt < ONLINE_MS,
      seenAt: new Date(d.seenAt).toISOString(),
      points: d.points || [],
      appVersion: acc?.appVersion || null,
    });
  }
  for (const [id, acc] of known) {
    if (id === device.id || map.has(id)) continue;
    devices.push({
      id,
      name: acc.name || 'Компьютер',
      online: false,
      seenAt: acc.lastSeenAt ? new Date(acc.lastSeenAt).toISOString() : new Date(0).toISOString(),
      // что именно лежит на том ПК, станет известно, когда он включится; пока — только номер пункта
      points: acc.pointWb && WB_RE.test(String(acc.pointWb)) ? [{ wb: String(acc.pointWb), name: '', live: true }] : [],
      appVersion: acc.appVersion || null,
    });
  }
  devices.sort((a, b) => Number(b.online) - Number(a.online) || b.seenAt.localeCompare(a.seenAt));
  return { devices };
}

async function ask(userId, device, body) {
  startSweeper();
  const wb = str(body.wb, 20);
  const source = str(body.source, 40);
  const kind = str(body.kind, 20);
  if (!WB_RE.test(wb) || !UUID_RE.test(source) || !KINDS.has(kind)) throw appError(400, 'VALIDATION_ERROR', 'Некорректный запрос');
  if (source === device.id) throw appError(400, 'VALIDATION_ERROR', 'Это этот же компьютер');
  const allowed = await allowedPoints(userId);
  if (!allowed.includes(wb)) {
    throw appError(403, 'MIRROR_REQUIRED', 'Загрузка данных пункта с другого ПК — в услуге «Загрузка с другого ПК»', { allowed });
  }
  const since = body.since && typeof body.since === 'object' ? body.since : {};
  if (JSON.stringify(since).length > 4000) throw appError(400, 'VALIDATION_ERROR', 'Некорректный курсор');
  const entry = devicesOf(userId).get(source);
  const now = Date.now();
  if (!entry || now - entry.seenAt > ONLINE_MS) {
    return { offline: true, seenAt: entry ? new Date(entry.seenAt).toISOString() : null };
  }
  if (!(entry.points || []).some(p => p.wb === wb)) throw appError(404, 'POINT_NOT_ON_SOURCE', 'На том компьютере нет данных этого пункта');
  // прошлые незабранные загрузки этой же пары — отменяем, чтобы не копились
  for (const job of jobs.values()) {
    if (job.user === userId && job.from === device.id && job.to === source && job.wb === wb && job.kind === kind) dropJob(job);
  }
  const job = {
    id: crypto.randomUUID(),
    user: userId,
    from: device.id,
    to: source,
    wb,
    kind,
    since,
    createdAt: now,
    sent: false,
    chunks: new Map(),
    bytes: 0,
    error: null,
    waiters: new Set(),
  };
  jobs.set(job.id, job);
  wake(entry.waiters);
  return { job: job.id };
}

// Кусок idx: { bytes, last } | { error } | { pending: true }.
async function get(userId, device, query, { waitMs = WAIT_MS } = {}) {
  const job = jobs.get(str(query.job, 40));
  if (!job || job.user !== userId || job.from !== device.id) throw appError(404, 'JOB_GONE', 'Загрузка уже отменена');
  const idx = Number(query.idx);
  if (!Number.isInteger(idx) || idx < 0) throw appError(400, 'VALIDATION_ERROR', 'Некорректный кусок');
  const ready = () => job.chunks.get(idx) || (job.error ? { error: job.error } : null);
  let hit = ready();
  if (!hit && waitMs > 0) {
    await waitOn(job.waiters, waitMs);
    if (!jobs.has(job.id)) throw appError(404, 'JOB_GONE', 'Загрузка уже отменена');
    hit = ready();
  }
  if (!hit) return { pending: true, started: job.sent };
  if (hit.error) return { error: hit.error };
  return { bytes: fs.readFileSync(hit.file), last: hit.last };
}

function ack(userId, device, query) {
  const job = jobs.get(str(query.job, 40));
  if (job && job.user === userId && (job.from === device.id || job.to === device.id)) dropJob(job);
  return { ok: true };
}

function resetForTests() {
  for (const job of jobs.values()) dropJob(job);
  presence.clear();
}

module.exports = { ack, ask, get, inbox, peers, put, sweep, resetForTests, ONLINE_MS, JOB_TTL_MS };
