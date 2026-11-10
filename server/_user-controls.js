// Ограничения аккаунтов и безлимит из админки — снимок в памяти процесса.
// Горячие пути (requireUser, аренда прав, ключ ПК, бот) в базу за ограничениями не ходят: раз в 60 с одна
// общая загрузка rpc/user_controls_snapshot (только действующие ограничения и безлимиты). База недоступна —
// остаётся прошлый снимок, повтор через 10 с; самой первой загрузки нет — пустой снимок (fail-open).
// Устаревший снимок обновляется в фоне (stale-while-revalidate): запрос ждёт загрузку только самой первой,
// при force и один раз после invalidate() — иначе при обрывах связи до Supabase каждый запрос раз в минуту
// висел бы до таймаута fetch (10 с).
// Сроки дополнительно проверяются в памяти: ограничение с истёкшим until перестаёт действовать сразу.
//
// Зависит только от ./_supabase. ./_admin-restrictions подгружается лениво в таймере снятия (иначе цикл:
// _admin-restrictions → _app-account → _user-controls).
const { supabaseFetch } = require('./_supabase');

const SCOPES = Object.freeze(['all', 'site', 'app', 'cell_print', 'bot', 'purchases', 'withdrawals']);
const TTL_MS = 60_000;
const RETRY_MS = 10_000;
const EXPIRY_EVERY_MS = 5 * 60_000;
const EXPIRY_FIRST_MS = 60_000;

/**
 * Restriction (в памяти):
 * { id, userId, telegramUserId: number|null, scopes: string[], until: string|null, publicMessage: string|null, message: string }
 */

const EMPTY = Object.freeze({ generatedAt: null, byUser: new Map(), byTelegram: new Map(), unlimited: new Map() });

let snapshot = null;      // разобранный снимок или null — ещё не загружался
let loadedAt = 0;         // когда загружен (мс); Infinity — снимок задан тестом и не обновляется
let retryAt = 0;          // после ошибки: раньше этого времени базу не спрашиваем
let inflight = null;      // общая загрузка
let generation = 0;       // invalidate() во время загрузки — её результат устарел, но всё равно лучше прошлого
let awaitFresh = false;   // после invalidate(): следующая загрузка ждётся (изменение из админки действует сразу)

const dayMonth = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });

function restrictionMessage({ publicMessage, until } = {}) {
  const custom = String(publicMessage || '').trim();
  if (custom) return custom;
  const ms = until ? Date.parse(until) : NaN;
  return 'Доступ ограничен администратором.' + (Number.isFinite(ms) ? ` До ${dayMonth.format(new Date(ms))}` : '');
}

function covers(restriction, scope) {
  if (!restriction || !Array.isArray(restriction.scopes)) return false;
  return restriction.scopes.includes('all') || (!!scope && restriction.scopes.includes(scope));
}

function telegramKey(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseSnapshot(json) {
  const data = json && typeof json === 'object' ? json : {};
  const byUser = new Map();
  const byTelegram = new Map();
  const unlimited = new Map();
  for (const row of Array.isArray(data.restrictions) ? data.restrictions : []) {
    if (!row || !row.user_id) continue;
    const scopes = (Array.isArray(row.scopes) ? row.scopes : []).filter(s => SCOPES.includes(s));
    if (!scopes.length) continue;
    const r = {
      id: row.id || null,
      userId: String(row.user_id),
      telegramUserId: telegramKey(row.telegram_user_id),
      scopes,
      until: row.until || null,
      publicMessage: row.public_message || null,
    };
    r.message = restrictionMessage(r);
    Object.freeze(r.scopes);
    Object.freeze(r);
    byUser.set(r.userId, r);
    if (r.telegramUserId) byTelegram.set(r.telegramUserId, r);
  }
  for (const row of Array.isArray(data.unlimited) ? data.unlimited : []) {
    if (row && row.user_id) unlimited.set(String(row.user_id), row.until || null);
  }
  return { generatedAt: data.generated_at || null, byUser, byTelegram, unlimited };
}

function disabledInTests() {
  return !!process.env.VITEST && process.env.USER_CONTROLS_IN_TESTS !== '1';
}

function stale(now = Date.now()) {
  return !snapshot || now - loadedAt >= TTL_MS;
}

function startLoad() {
  if (inflight) return inflight;
  const gen = generation;
  const promise = (async () => {
    try {
      const json = await supabaseFetch('rpc/user_controls_snapshot', { method: 'POST', body: '{}' });
      // invalidate() пришёл во время загрузки — её результат мог не увидеть изменение: берём его,
      // только если другого снимка нет, и свежим не отмечаем (следующий вызов загрузит заново)
      if (gen === generation) {
        snapshot = parseSnapshot(json);
        loadedAt = Date.now();
        retryAt = 0;
      } else if (!snapshot) {
        snapshot = parseSnapshot(json);
      }
    } catch (error) {
      console.error('user controls snapshot:', error.message);
      if (gen === generation) retryAt = Date.now() + RETRY_MS;
      // первой загрузки не было — работаем без ограничений (fail-open), свежим снимок не отмечаем
      if (!snapshot) snapshot = parseSnapshot(null);
    } finally {
      // загрузка после invalidate() завершилась (успешно или нет) — дальше снова обновление в фоне,
      // чтобы при недоступной базе запросы не ждали таймаут раз за разом
      if (gen === generation) awaitFresh = false;
      if (inflight === promise) inflight = null;
    }
    return snapshot;
  })();
  inflight = promise;
  return promise;
}

async function loadSnapshot({ force = false } = {}) {
  if (loadedAt === Infinity) return snapshot;
  if (disabledInTests()) return snapshot || EMPTY;
  // ждём загрузку: самая первая (снимка нет), принудительная или первая после invalidate()
  if (force || !snapshot) return startLoad();
  if (awaitFresh) return startLoad();
  const now = Date.now();
  if (!stale(now)) return snapshot;
  // устарел — отдаём прошлый, обновляем в фоне (не чаще, чем позволяет окно повтора после ошибки)
  if (retryAt <= now) startLoad().catch(() => {});
  return snapshot;
}

/** Синхронно: последний снимок; устарел — обновление в фоне. */
function cachedSnapshot() {
  if (loadedAt !== Infinity && !disabledInTests() && stale() && retryAt <= Date.now()) startLoad().catch(() => {});
  return snapshot || EMPTY;
}

function active(r, now = Date.now()) {
  if (!r) return null;
  if (r.until && Date.parse(r.until) <= now) return null;
  return r;
}

function pickUser(snap, userId) {
  if (!userId) return null;
  return active(snap.byUser.get(String(userId)) || null);
}

async function restrictionFor(userId) {
  if (!userId) return null;
  return pickUser(await loadSnapshot(), userId);
}

function restrictionForCached(userId) {
  if (!userId) return null;
  return pickUser(cachedSnapshot(), userId);
}

async function restrictionForTelegram(telegramId) {
  const key = telegramKey(telegramId);
  if (!key) return null;
  const snap = await loadSnapshot();
  return active(snap.byTelegram.get(key) || null);
}

async function isRestricted(userId, scope) {
  return covers(await restrictionFor(userId), scope);
}

function restrictedError(r) {
  return Object.assign(new Error(r.message), { status: 403, code: 'ACCOUNT_RESTRICTED', extra: { until: r.until } });
}

async function assertAllowed(userId, scope) {
  const r = await restrictionFor(userId);
  if (covers(r, scope)) throw restrictedError(r);
}

function restrictedBody(r) {
  return { error: r.message, code: 'ACCOUNT_RESTRICTED', until: r.until || null };
}

function isUnlimitedCached(userId) {
  if (!userId) return false;
  const snap = cachedSnapshot();
  const key = String(userId);
  if (!snap.unlimited.has(key)) return false;
  const until = snap.unlimited.get(key);
  return !until || Date.parse(until) > Date.now();
}

function invalidate() {
  generation += 1;
  awaitFresh = true;
  if (loadedAt !== Infinity) loadedAt = 0;
  retryAt = 0;
  inflight = null; // идущая загрузка могла начаться до изменения — следующий вызов начнёт новую
}

// Снятие ограничений с истёкшим сроком. Только на сайте (selfhost/server.cjs), не на узле бота.
let expiryTimers = null;
let expiryRunning = false;

async function liftDue() {
  if (expiryRunning) return;
  expiryRunning = true;
  try {
    const rows = await supabaseFetch('rpc/user_restrictions_due', { method: 'POST', body: JSON.stringify({ p_limit: 50 }) });
    if (!Array.isArray(rows) || !rows.length) return;
    const { liftRestriction } = require('./_admin-restrictions');
    for (const row of rows) {
      try {
        await liftRestriction(row, 'Срок ограничения истёк', { by: 'auto' });
      } catch (error) {
        console.error(`user restriction ${row?.id} auto lift:`, error.message);
      }
    }
  } catch (error) {
    console.error('user restrictions due:', error.message);
  } finally {
    expiryRunning = false;
  }
}

function startExpiryWatch() {
  if (expiryTimers) return;
  expiryTimers = {};
  expiryTimers.first = setTimeout(() => {
    liftDue();
    expiryTimers.every = setInterval(liftDue, EXPIRY_EVERY_MS);
    expiryTimers.every.unref?.();
  }, EXPIRY_FIRST_MS);
  expiryTimers.first.unref?.();
}

/** Тесты: задать снимок (как вернул бы rpc/user_controls_snapshot) или null — сбросить всё состояние. */
function __setSnapshotForTests(json) {
  if (json == null) {
    snapshot = null;
    loadedAt = 0;
    retryAt = 0;
    inflight = null;
    generation += 1;
    awaitFresh = false;
    if (expiryTimers) {
      clearTimeout(expiryTimers.first);
      clearInterval(expiryTimers.every);
      expiryTimers = null;
    }
    return;
  }
  snapshot = parseSnapshot(json);
  loadedAt = Infinity;
  retryAt = 0;
}

module.exports = {
  SCOPES, TTL_MS, covers, restrictionMessage, loadSnapshot, restrictionFor, restrictionForCached, restrictionForTelegram,
  isRestricted, assertAllowed, restrictedBody, isUnlimitedCached, invalidate, startExpiryWatch, __setSnapshotForTests,
  __liftDueForTests: liftDue,
};
