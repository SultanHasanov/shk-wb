// Экран «Система» админки (api/admin/data.js: resource=system[&force=1]).
//
// Только чтение: состояние бота и релея, вебхук, узел бота в Германии, диск, размер базы Supabase, бэкапы,
// текущий релиз, версии программ и признаки env. Каждый блок собирается отдельно: сбой одного — поле null,
// запрос целиком не падает никогда. Значения секретов наружу не отдаются — только «задан / не задан».
// Кеш 30 с (force=1 — не чаще раза в 10 с), счёт ПК на старых версиях — 10 мин (трафик Supabase).
const fs = require('fs');
const path = require('path');
const { supabaseFetch } = require('./_supabase');

const TTL_MS = 30_000;
const FORCE_MIN_MS = 10_000;
const OLD_DEVICES_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 5000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DB_LIMIT_BYTES = 524288000;
const BACKUP_FRESH_MS = 26 * 3600_000;
const ALERT_KEYS = Object.freeze(['updates', 'relay', 'webhook', 'bot-node']);

let cache = null; // { at, value }
let oldDevicesCache = null; // { at, minVersion, count }

async function safe(name, work) {
  try {
    return await work();
  } catch (error) {
    console.error(`admin system ${name}:`, error?.message || error);
    return null;
  }
}

/** Адрес без секретов: только origin и путь, длинные «токенные» куски пути скрыты. */
function publicUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const pathname = url.pathname.split('/').map(part => (/^[A-Za-z0-9_:-]{20,}$/.test(part) ? '…' : part)).join('/');
    return `${url.origin}${pathname === '/' ? '' : pathname}`;
  } catch {
    return null;
  }
}

function errorText(error) {
  return String(error?.message || error || 'Ошибка').slice(0, 200);
}

function botBlock() {
  const health = require('./_bot-health');
  const summary = health.summary();
  const state = summary.state || {};
  const alerts = {};
  for (const key of ALERT_KEYS) alerts[key] = { active: Boolean(state[key]?.active), sentAt: Number(state[key]?.sentAt) || null };
  const window = summary.window
    ? { total: summary.window.total, slow: summary.window.slow, failed: summary.window.failed, worstMs: summary.window.worst }
    : null;
  const anyAlert = alerts.updates.active || alerts.webhook.active;
  const status = anyAlert || summary.window?.degraded ? 'warning' : 'ok';
  return { status, processesUpdates: Boolean(summary.processesUpdates), lastUpdateAgoSec: summary.lastUpdateAgoSec ?? null, window, alerts };
}

async function relayBlock() {
  const { telegramRequest } = require('./_telegram-api');
  const base = publicUrl(process.env.TELEGRAM_API_BASE) || 'api.telegram.org';
  if (!String(process.env.TELEGRAM_BOT_TOKEN || '').trim()) return { status: 'unknown', base, latencyMs: null, error: 'TELEGRAM_BOT_TOKEN не задан' };
  const startedAt = Date.now();
  try {
    await telegramRequest('getMe', {}, { timeoutMs: TIMEOUT_MS, retries: 0 });
    const latencyMs = Date.now() - startedAt;
    return { status: latencyMs > 2500 ? 'warning' : 'ok', base, latencyMs, error: null };
  } catch (error) {
    return { status: 'down', base, latencyMs: Date.now() - startedAt, error: errorText(error) };
  }
}

async function webhookBlock() {
  if (!String(process.env.TELEGRAM_BOT_TOKEN || '').trim()) return null;
  const { telegramRequest } = require('./_telegram-api');
  const info = await telegramRequest('getWebhookInfo', {}, { timeoutMs: TIMEOUT_MS, retries: 0 });
  const pendingUpdates = Number(info?.pending_update_count || 0);
  const lastErrorMs = Number(info?.last_error_date || 0) * 1000;
  const freshError = lastErrorMs && Date.now() - lastErrorMs < 3 * 60_000;
  return {
    status: !info?.url ? 'warning' : pendingUpdates >= 20 || freshError ? 'warning' : 'ok',
    url: publicUrl(info?.url),
    pendingUpdates,
    lastErrorAt: lastErrorMs ? new Date(lastErrorMs).toISOString() : null,
    lastErrorMessage: info?.last_error_message ? String(info.last_error_message).slice(0, 300) : null,
  };
}

async function botNodeBlock() {
  const raw = String(process.env.BOT_NODE_URL || '').trim();
  if (!raw) return { status: 'unknown', url: null, latencyMs: null, error: null, release: null };
  const startedAt = Date.now();
  try {
    const response = await fetch(raw, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) return { status: 'down', url: publicUrl(raw), latencyMs, error: `HTTP ${response.status}`, release: null };
    return { status: latencyMs > 2500 ? 'warning' : 'ok', url: publicUrl(raw), latencyMs, error: null, release: null };
  } catch (error) {
    return { status: 'down', url: publicUrl(raw), latencyMs: Date.now() - startedAt, error: errorText(error), release: null };
  }
}

function currentRelease() {
  try {
    return path.basename(fs.readlinkSync(process.env.SHK_CURRENT_LINK || '/srv/shk-wb/current')) || null;
  } catch {
    return null;
  }
}

function siteBlock() {
  return { status: 'ok', uptimeSec: Math.round(process.uptime()), release: currentRelease(), role: process.env.BOT_ROLE || 'site' };
}

function egressBlock() {
  const note = String(process.env.SUPABASE_EGRESS_NOTE || '').trim();
  return { status: note ? 'warning' : 'unknown', note: note || null };
}

async function diskBlock() {
  const st = await fs.promises.statfs('/');
  const totalBytes = Number(st.blocks) * Number(st.bsize);
  const freeBytes = Number(st.bavail) * Number(st.bsize);
  if (!(totalBytes > 0)) return null;
  const alertFreeBytes = Number(process.env.DISK_ALERT_FREE_GB || 2) * GB;
  const usedPercent = Math.round((1 - freeBytes / totalBytes) * 1000) / 10;
  const status = freeBytes < alertFreeBytes ? 'down' : freeBytes < alertFreeBytes * 2 ? 'warning' : 'ok';
  return { status, totalBytes, freeBytes, usedPercent, alertFreeBytes };
}

async function databaseBlock() {
  const sizeBytes = Number(await supabaseFetch('rpc/app_db_size', { method: 'POST', body: '{}' }));
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
  const alertBytes = Number(process.env.SUPABASE_ALERT_MB || 400) * MB;
  const status = sizeBytes >= DB_LIMIT_BYTES * 0.95 ? 'down' : sizeBytes >= alertBytes ? 'warning' : 'ok';
  return { status, sizeBytes, limitBytes: DB_LIMIT_BYTES, alertBytes };
}

async function backupsBlock(now = Date.now()) {
  const dir = process.env.ADMIN_BACKUPS_DIR || '/srv/shk-wb/backups';
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return null; // папки нет — блока нет
  }
  const items = [];
  for (const name of names.filter(item => item.endsWith('.dump'))) {
    try {
      const stat = await fs.promises.stat(path.join(dir, name));
      if (stat.isFile()) items.push({ name, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), at: stat.mtimeMs });
    } catch { /* файл исчез между readdir и stat */ }
  }
  items.sort((a, b) => b.at - a.at);
  const top = items.slice(0, 14).map(({ at: _at, ...item }) => item);
  const lastAt = top[0]?.modifiedAt || null;
  const fresh = items[0] && now - items[0].at < BACKUP_FRESH_MS;
  return { status: fresh ? 'ok' : 'warning', dir, lastAt, items: top };
}

async function devicesBelow(minVersion, now = Date.now()) {
  if (!minVersion) return 0;
  if (oldDevicesCache && oldDevicesCache.minVersion === minVersion && now - oldDevicesCache.at < OLD_DEVICES_TTL_MS) return oldDevicesCache.count;
  const { isOlder } = require('./_program-version');
  const since = encodeURIComponent(new Date(now - 30 * 86400_000).toISOString());
  const rows = await supabaseFetch(`app_devices?revoked_at=is.null&last_seen_at=gt.${since}&select=app_version&limit=10000`);
  const count = (Array.isArray(rows) ? rows : []).filter(row => row.app_version && isOlder(row.app_version, minVersion)).length;
  oldDevicesCache = { at: now, minVersion, count };
  return count;
}

async function programsBlock() {
  const pvzHelper = await safe('pvz-helper', async () => {
    const { policy } = require('./_app-update');
    const current = policy('');
    const minVersion = current.minVersion || null;
    const devicesBelowMin = await devicesBelow(minVersion).catch(error => { console.error('admin system old devices:', error.message); return null; });
    return { latest: current.latest?.version || null, minVersion, mandatory: current.latest?.mandatory === true, devicesBelowMin };
  });
  const cellPrint = await safe('cell-print', () => {
    const latest = require('./_cell-print-update').readLatest();
    return { latest: latest?.version || null, signed: Boolean(latest?.signature && latest?.file) };
  });
  return { pvzHelper, cellPrint };
}

function accountsLabel(n) {
  const mod10 = n % 10, mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'аккаунт' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'аккаунта' : 'аккаунтов';
  return `${n} ${word}`;
}

/** Признаки env — никогда значения секретов. */
function envBlock() {
  const flag = name => (/^(1|true|yes)$/i.test(String(process.env[name] || '')) ? 'да' : 'нет');
  const unlimited = String(process.env.APP_UNLIMITED_USER_IDS || '').split(/[\s,]+/).filter(Boolean).length;
  const minVersion = String(process.env.PVZ_APP_MIN_VERSION || '').trim();
  return [
    { name: 'APP_MIRROR_DISABLED', value: flag('APP_MIRROR_DISABLED') },
    { name: 'APP_CLOUD_STORAGE_OFF', value: flag('APP_CLOUD_STORAGE_OFF') },
    { name: 'PVZ_APP_MIN_VERSION', value: minVersion && minVersion !== '0' ? minVersion : 'не задана' },
    { name: 'RESEND', value: process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL ? 'задан' : 'не задан' },
    { name: 'YOOKASSA', value: process.env.YOOKASSA_TEST_MODE !== 'false' ? 'тестовый' : 'боевой' },
    { name: 'ADMIN_TOTP', value: process.env.ADMIN_TOTP_SECRET ? 'включён' : 'выключен' },
    { name: 'BOT_NODE_URL', value: String(process.env.BOT_NODE_URL || '').trim() ? 'задан' : 'нет' },
    { name: 'APP_UNLIMITED_USER_IDS', value: accountsLabel(unlimited) },
  ];
}

async function collectFresh() {
  const [bot, relay, webhook, botNode, disk, database, backups, programs] = await Promise.all([
    safe('bot', botBlock),
    safe('relay', relayBlock),
    safe('webhook', webhookBlock),
    safe('bot-node', botNodeBlock),
    safe('disk', diskBlock),
    safe('database', databaseBlock),
    safe('backups', () => backupsBlock()),
    safe('programs', programsBlock),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    cached: false,
    bot,
    relay,
    webhook,
    botNode,
    site: siteBlock(),
    egress: egressBlock(),
    disk,
    database,
    backups,
    programs: programs || { pvzHelper: null, cellPrint: null },
    env: envBlock(),
  };
}

/** Собрать состояние с кешем 30 с; force — заново, но не чаще раза в 10 с. */
async function collectSystem({ force = false } = {}) {
  const now = Date.now();
  const age = cache ? now - cache.at : Infinity;
  if (cache && (force ? age < FORCE_MIN_MS : age < TTL_MS)) return { ...cache.value, cached: true };
  const value = await collectFresh();
  cache = { at: Date.now(), value };
  return value;
}

async function handleSystem(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  let value;
  try {
    value = await collectSystem({ force: req.query?.force === '1' });
  } catch (error) {
    // collectFresh сам не бросает; это подстраховка — экран всё равно получит ответ
    console.error('admin system:', error?.message || error);
    value = { generatedAt: new Date().toISOString(), cached: false, bot: null, relay: null, webhook: null, botNode: null, site: siteBlock(), egress: egressBlock(), disk: null, database: null, backups: null, programs: { pvzHelper: null, cellPrint: null }, env: envBlock() };
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json(value);
}

function resetForTests() {
  cache = null;
  oldDevicesCache = null;
}

module.exports = { handleSystem, collectSystem, publicUrl, resetForTests, TTL_MS };
