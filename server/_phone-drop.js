// «С телефона» (Помощник ПВЗ 1.16+): файлы с телефона на компьютер через одноразовый QR.
//
//   ПК: phone-start → токен и ссылка https://shk-wb.ru/t/<токен> (рисует QR) → держит долгий
//   запрос phone-pull и забирает куски по порядку, подтверждая предыдущий (ack) → кусок удаляется.
//   Телефон: open (первое открытие привязывает ссылку к этому телефону: секрет в ответе) →
//   file (объявить файл) → chunk × N (куски по CHUNK_BYTES, идемпотентно по номеру).
//
// Сервер — только передатчик: куски лежат во временной папке, пока ПК их не забрал. Состояние —
// в памяти процесса (selfhost: один процесс), папка чистится при старте. Перезапуск сервера обрывает
// сеанс: телефон видит «ссылка недействительна», ПК — «приём завершён», принятое на ПК остаётся.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appError } = require('./_app-account');

// Пределы — в одном месте, чтобы потом развести по тарифам.
const LIMITS = Object.freeze({
  chunkBytes: 3 * 1024 * 1024,        // тело запроса на сервере не больше 4,5 МБ
  fileBytes: 500 * 1024 * 1024,
  sessionBytes: 2 * 1024 * 1024 * 1024,
  sessionFiles: 200,
});
const SESSION_BUFFER_BYTES = 200 * 1024 * 1024;   // незабранного на сеанс: дальше телефон ждёт ПК
const GLOBAL_BUFFER_BYTES = 3 * 1024 * 1024 * 1024;
const MIN_FREE_BYTES = 4 * 1024 * 1024 * 1024;
const OPEN_TTL_MS = 10 * 60_000;    // QR без сканирования
const IDLE_TTL_MS = 30 * 60_000;    // сеанс без активности
const WAIT_MS = 25_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[0-9a-f]{16}$/;

function dropDir() {
  return process.env.PHONE_DROP_DIR || path.join(os.tmpdir(), 'shk-phone');
}

// token → session
const sessions = new Map();

function wakeAll(waiters) {
  for (const w of [...waiters]) w();
  waiters.clear();
}

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

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function bufferedBytes() {
  let total = 0;
  for (const s of sessions.values()) total += s.buffered;
  return total;
}

function freeBytes() {
  try {
    const st = fs.statfsSync(path.dirname(dropDir()));
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Infinity; // старый Node или нет папки — не мешаем
  }
}

function dropSession(s, reason = 'closed') {
  if (!sessions.has(s.token)) return;
  sessions.delete(s.token);
  s.closed = reason;
  wakeAll(s.pcWaiters);
  wakeAll(s.phoneWaiters);
  fs.rm(path.join(dropDir(), s.id), { recursive: true, force: true }, () => {});
}

function sweep(now = Date.now()) {
  for (const s of sessions.values()) {
    if (!s.opened && now - s.createdAt > OPEN_TTL_MS) dropSession(s, 'expired');
    else if (now - s.touchedAt > IDLE_TTL_MS) dropSession(s, 'expired');
  }
}

let sweeper = null;
function startSweeper() {
  if (sweeper) return;
  fs.rm(dropDir(), { recursive: true, force: true }, () => {});
  sweeper = setInterval(sweep, 60_000);
  if (sweeper.unref) sweeper.unref();
}

function touch(s) {
  s.touchedAt = Date.now();
}

// ---------- имена и типы ----------

function cleanName(value) {
  let name = String(value || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').trim();
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name || 'файл';
}

function cleanMime(value) {
  const mime = String(value || '').toLowerCase().slice(0, 100);
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : '';
}

function fileView(f) {
  return {
    id: f.id, name: f.name, size: f.size, mime: f.mime,
    chunks: f.total, received: f.got.size, delivered: f.next, done: f.next >= f.total, canceled: f.canceled || false,
  };
}

function stateView(s) {
  return {
    opened: s.opened,
    expiresAt: new Date((s.opened ? s.touchedAt + IDLE_TTL_MS : s.createdAt + OPEN_TTL_MS)).toISOString(),
    files: [...s.files.values()].map(fileView),
    closed: s.closed || null,
  };
}

// ---------- компьютер ----------

/** Новый сеанс приёма для этого ПК (прошлый, если был, закрывается). */
function start(userId, device, origin) {
  startSweeper();
  for (const s of sessions.values()) if (s.user === userId && s.device === device.id) dropSession(s, 'replaced');
  if (bufferedBytes() >= GLOBAL_BUFFER_BYTES || freeBytes() < MIN_FREE_BYTES) {
    throw appError(503, 'PHONE_BUSY', 'Сервер сейчас занят приёмом файлов — попробуйте через несколько минут');
  }
  const now = Date.now();
  const s = {
    id: crypto.randomBytes(8).toString('hex'),
    token: crypto.randomBytes(32).toString('base64url'),
    user: userId,
    device: device.id,
    deviceName: String(device.name || 'Компьютер').slice(0, 80),
    createdAt: now,
    touchedAt: now,
    opened: false,
    secretHash: null,
    files: new Map(),
    order: [],
    total: 0,
    buffered: 0,
    version: 0,
    closed: null,
    pcWaiters: new Set(),
    phoneWaiters: new Set(),
  };
  sessions.set(s.token, s);
  return { token: s.token, url: `${origin}/t/${s.token}`, expiresAt: new Date(now + OPEN_TTL_MS).toISOString(), limits: LIMITS };
}

function ownSession(userId, device, token) {
  const s = sessions.get(String(token || ''));
  if (!s || s.user !== userId || s.device !== device.id) throw appError(404, 'PHONE_GONE', 'Приём уже завершён');
  return s;
}

function close(userId, device, query) {
  const s = sessions.get(String(query.token || ''));
  if (s && s.user === userId && s.device === device.id) dropSession(s, 'closed');
  return { ok: true };
}

// Следующий кусок по порядку: { chunk: {file, idx, last, bytes, name, size, mime} } | { state }.
// ack=<fileId>:<idx> — ПК записал этот кусок, его можно удалить.
async function pull(userId, device, query, { waitMs = WAIT_MS } = {}) {
  // без touch(): ПК держит запрос постоянно — сеанс истекает по бездействию телефона
  const s = ownSession(userId, device, query.token);
  const ack = String(query.ack || '');
  if (ack) {
    const [fid, rawIdx] = ack.split(':');
    const f = s.files.get(fid);
    const idx = Number(rawIdx);
    if (f && Number.isInteger(idx) && idx === f.next) {
      const c = f.chunks.get(idx);
      if (c) {
        f.chunks.delete(idx);
        s.buffered -= c.size;
        fs.rm(c.file, { force: true }, () => {});
      }
      f.next = idx + 1;
      wakeAll(s.phoneWaiters);
      // файл забран целиком — состояние сменилось: ответить сразу, а не ждать 25 с со старым «принято N»
      if (f.next >= f.total) s.version += 1;
    }
  }
  const version = Number(query.v);
  const ready = () => {
    for (const fid of s.order) {
      const f = s.files.get(fid);
      if (!f || f.canceled || f.next >= f.total) continue;
      const c = f.chunks.get(f.next);
      if (c) return { f, c, idx: f.next };
    }
    return null;
  };
  let hit = ready();
  // без куска ждём, только если ПК уже видел текущее состояние (иначе — сразу показать «телефон подключён»)
  if (!hit && waitMs > 0 && version === s.version) {
    await waitOn(s.pcWaiters, waitMs);
    if (!sessions.has(s.token)) return { state: stateView(s), v: -1 };
    hit = ready();
  }
  if (!hit) return { state: stateView(s), v: s.version };
  return {
    chunk: {
      file: hit.f.id, idx: hit.idx, last: hit.idx === hit.f.total - 1,
      name: hit.f.name, size: hit.f.size, mime: hit.f.mime, chunkBytes: LIMITS.chunkBytes,
      bytes: fs.readFileSync(hit.c.file),
    },
  };
}

function bump(s) {
  s.version += 1;
  wakeAll(s.pcWaiters);
}

// ---------- телефон (без входа) ----------

function phoneSession(token, secret, { allowUnopened = false } = {}) {
  startSweeper();
  const s = TOKEN_RE.test(String(token || '')) ? sessions.get(String(token)) : null;
  if (!s) throw appError(404, 'LINK_GONE', 'Ссылка недействительна или устарела — покажите новый QR на компьютере');
  if (!s.opened) {
    if (allowUnopened) return s;
    throw appError(409, 'LINK_NOT_OPENED', 'Откройте ссылку заново');
  }
  const given = sha(secret || '');
  if (!crypto.timingSafeEqual(given, s.secretHash)) {
    throw appError(409, 'LINK_USED', 'Эта ссылка уже открыта на другом телефоне — покажите новый QR на компьютере');
  }
  return s;
}

function phoneInfo(s) {
  return { pcName: s.deviceName, limits: LIMITS, files: [...s.files.values()].map(fileView) };
}

/** Первое открытие привязывает ссылку к телефону; повтор с тем же секретом — то же состояние. */
function open(token, body) {
  const s = phoneSession(token, body?.secret, { allowUnopened: true });
  if (!s.opened) {
    const secret = crypto.randomBytes(24).toString('base64url');
    s.opened = true;
    s.secretHash = sha(secret);
    touch(s);
    bump(s);
    return { secret, ...phoneInfo(s) };
  }
  phoneSession(token, body?.secret);
  touch(s);
  return phoneInfo(s);
}

function fileStart(token, secret, body) {
  const s = phoneSession(token, secret);
  touch(s);
  const size = Number(body?.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw appError(400, 'VALIDATION_ERROR', 'Пустой файл не отправить');
  if (size > LIMITS.fileBytes) throw appError(413, 'FILE_TOO_LARGE', `Файл больше ${Math.round(LIMITS.fileBytes / 1024 / 1024)} МБ`);
  if (s.files.size >= LIMITS.sessionFiles) throw appError(413, 'TOO_MANY_FILES', `За один раз — не больше ${LIMITS.sessionFiles} файлов. Покажите новый QR`);
  if (s.total + size > LIMITS.sessionBytes) throw appError(413, 'SESSION_TOO_LARGE', 'За один раз — не больше 2 ГБ. Покажите новый QR на компьютере');
  const f = {
    id: crypto.randomBytes(8).toString('hex'),
    name: cleanName(body?.name),
    mime: cleanMime(body?.mime),
    size,
    total: Math.ceil(size / LIMITS.chunkBytes),
    got: new Set(),
    chunks: new Map(),
    next: 0,
    canceled: false,
  };
  s.files.set(f.id, f);
  s.order.push(f.id);
  s.total += size;
  bump(s);
  return { file: f.id, chunkBytes: LIMITS.chunkBytes };
}

// Кусок файла. Сервер держит не больше SESSION_BUFFER_BYTES незабранного: дальше телефон ждёт,
// пока ПК заберёт (долгий запрос до WAIT_MS), и при занятости получает 429 «повторить».
async function chunk(token, secret, query, bytes, { waitMs = WAIT_MS } = {}) {
  const s = phoneSession(token, secret);
  touch(s);
  const fid = String(query.file || '');
  const f = ID_RE.test(fid) ? s.files.get(fid) : null;
  if (!f || f.canceled) throw appError(404, 'FILE_GONE', 'Файл отменён');
  const idx = Number(query.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= f.total) throw appError(400, 'VALIDATION_ERROR', 'Некорректный кусок');
  if (f.got.has(idx)) return { ok: true, repeated: true }; // повтор после обрыва
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw appError(400, 'VALIDATION_ERROR', 'Пустой кусок');
  const expected = idx === f.total - 1 ? f.size - idx * LIMITS.chunkBytes : LIMITS.chunkBytes;
  if (bytes.length !== expected) throw appError(400, 'VALIDATION_ERROR', 'Размер куска не совпадает');
  if (s.buffered + bytes.length > SESSION_BUFFER_BYTES || bufferedBytes() + bytes.length > GLOBAL_BUFFER_BYTES) {
    if (waitMs > 0) await waitOn(s.phoneWaiters, waitMs);
    if (!sessions.has(s.token)) throw appError(404, 'LINK_GONE', 'Компьютер завершил приём');
    if (s.buffered + bytes.length > SESSION_BUFFER_BYTES || bufferedBytes() + bytes.length > GLOBAL_BUFFER_BYTES) {
      throw appError(429, 'PC_BEHIND', 'Компьютер ещё забирает прошлые файлы — подождите', { retry: true });
    }
  }
  if (f.got.has(idx)) return { ok: true, repeated: true };
  const dir = path.join(dropDir(), s.id, f.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(idx));
  fs.writeFileSync(file, bytes);
  f.got.add(idx);
  f.chunks.set(idx, { file, size: bytes.length });
  s.buffered += bytes.length;
  wakeAll(s.pcWaiters);
  return { ok: true };
}

function cancelFile(token, secret, query) {
  const s = phoneSession(token, secret);
  const f = s.files.get(String(query.file || ''));
  if (f && !f.canceled && f.next < f.total) {
    f.canceled = true;
    for (const c of f.chunks.values()) {
      s.buffered -= c.size;
      fs.rm(c.file, { force: true }, () => {});
    }
    f.chunks.clear();
    s.total -= f.size;
    bump(s);
  }
  return { ok: true };
}

/** Что уже доехало до компьютера — для галочек на телефоне. */
function phoneState(token, secret) {
  const s = phoneSession(token, secret);
  return phoneInfo(s);
}

function resetForTests() {
  for (const s of [...sessions.values()]) dropSession(s);
}

module.exports = {
  LIMITS, OPEN_TTL_MS, IDLE_TTL_MS,
  start, close, pull, open, fileStart, chunk, cancelFile, phoneState, sweep, resetForTests, cleanName,
};
