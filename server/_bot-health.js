// Здоровье Telegram-бота: сообщение админу, когда бот тормозит или не отвечает.
// Три проверки раз в минуту (BOT_HEALTH_CHECK_MS):
//   1. обработка апдейтов за последние 10 минут — много медленных (> BOT_HEALTH_SLOW_MS) или упавших;
//   2. релей Telegram — getMe дольше 5 с или с ошибкой два раза подряд;
//   3. вебхук — Telegram не может доставить апдейты (last_error_date свежий) или копится очередь.
// Повтор одного и того же — не чаще раза в 30 минут, «снова в порядке» — когда проверка прошла два раза подряд.
// Сообщение уходит через рабочий релей, а если сломан он — через запасной (TELEGRAM_API_FALLBACK_BASE, Supabase).
// Если лёг сам процесс, это сообщение не уйдёт — за этим следит сторож на немецком сервере (docs/telegram-bot.md).
const fs = require('fs');
const path = require('path');
const { adminIds } = require('./_admin-alerts');
const { telegramRequest } = require('./_telegram-api');

const CHECK_MS = Number(process.env.BOT_HEALTH_CHECK_MS || 60 * 1000);
const WINDOW_MS = 10 * 60 * 1000;
const SLOW_MS = Number(process.env.BOT_HEALTH_SLOW_MS || 3000);
const REPEAT_MS = 30 * 60 * 1000;
const RELAY_TIMEOUT_MS = 5000;
const STATE_FILE = process.env.BOT_HEALTH_STATE || '/srv/shk-wb/state/bot-health.json';

const records = [];
const relayFailures = { count: 0, lastError: '' };

/** Вызывается из processUpdate на каждый апдейт. */
function recordUpdate({ label = '', ms = 0, failed = false, incident = '' }) {
  const now = Date.now();
  records.push({ at: now, label, ms, failed, incident });
  while (records.length && now - records[0].at > WINDOW_MS) records.shift();
  if (records.length > 5000) records.splice(0, records.length - 5000);
}

/** Оценка окна апдейтов: чистая функция, чтобы тестировать без таймеров. */
function evaluateUpdates(items, { slowMs = SLOW_MS } = {}) {
  const total = items.length;
  const failed = items.filter(item => item.failed);
  const slow = items.filter(item => !item.failed && item.ms > slowMs);
  const degraded = failed.length >= 3 || (slow.length >= 3 && slow.length / Math.max(total, 1) >= 0.3);
  const worst = items.reduce((max, item) => Math.max(max, item.ms), 0);
  return { total, failed: failed.length, slow: slow.length, worst, degraded, incidents: failed.map(item => item.incident).filter(Boolean).slice(-5) };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (error) {
    console.error('bot health state:', error.message);
  }
}

async function deliver(text) {
  const bases = [process.env.TELEGRAM_API_BASE, process.env.TELEGRAM_API_FALLBACK_BASE].map(value => String(value || '').trim()).filter(Boolean);
  const targets = bases.length ? bases : [''];
  let lastError;
  for (const apiBase of targets) {
    try {
      await Promise.all(adminIds().map(id => telegramRequest('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true }, { apiBase })));
      return true;
    } catch (error) {
      lastError = error;
      console.warn(`bot health alert via ${apiBase || 'api.telegram.org'} failed: ${error.message}`);
    }
  }
  console.error('bot health alert not delivered', lastError?.message);
  return false;
}

/**
 * Состояние по каждой проверке в файле: { key: { active, sentAt, okStreak } }.
 * problem — текст проблемы (или null, если всё хорошо); okText — текст «снова в порядке».
 */
async function report(key, problem, okText, { now = Date.now(), send = deliver } = {}) {
  const all = readState();
  const state = all[key] || { active: false, sentAt: 0, okStreak: 0 };
  if (problem) {
    const repeat = now - (state.sentAt || 0) >= REPEAT_MS;
    if (!state.active || repeat) {
      if (await send(problem)) writeState({ ...all, [key]: { active: true, sentAt: now, okStreak: 0 } });
      else writeState({ ...all, [key]: { ...state, active: true, okStreak: 0 } });
    } else {
      writeState({ ...all, [key]: { ...state, okStreak: 0 } });
    }
    return;
  }
  if (!state.active) return;
  const okStreak = (state.okStreak || 0) + 1;
  if (okStreak < 2) { writeState({ ...all, [key]: { ...state, okStreak } }); return; }
  await send(okText);
  writeState({ ...all, [key]: { active: false, sentAt: now, okStreak } });
}

const sec = ms => (ms / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 });

async function checkUpdates() {
  const now = Date.now();
  while (records.length && now - records[0].at > WINDOW_MS) records.shift();
  const summary = evaluateUpdates(records);
  const problem = summary.degraded
    ? `⚠️ <b>Бот отвечает с перебоями</b>\n` +
      `За 10 минут: апдейтов ${summary.total}, медленных (дольше ${sec(SLOW_MS)} с) ${summary.slow}, с ошибкой ${summary.failed}, худший ${sec(summary.worst)} с.` +
      (summary.incidents.length ? `\nКоды ошибок: ${summary.incidents.join(', ')}` : '') +
      `\nСмотреть: <code>journalctl -u shk-wb --since "15 min ago" | grep -E "bot |fetch retry|bot failed"</code>`
    : null;
  await report('updates', problem, '✅ Бот снова отвечает нормально: за 10 минут медленных и упавших апдейтов нет.');
}

async function checkRelay() {
  const startedAt = Date.now();
  let error = '';
  try {
    await telegramRequest('getMe', {}, { timeoutMs: RELAY_TIMEOUT_MS, retries: 0 });
  } catch (err) {
    error = err.message;
  }
  const ms = Date.now() - startedAt;
  if (error || ms > RELAY_TIMEOUT_MS) {
    relayFailures.count += 1;
    relayFailures.lastError = error || `ответ ${sec(ms)} с`;
  } else {
    relayFailures.count = 0;
  }
  const base = String(process.env.TELEGRAM_API_BASE || 'api.telegram.org');
  const problem = relayFailures.count >= 2
    ? `🔴 <b>Релей Telegram не отвечает</b>\n${base}\n${relayFailures.count} проверки подряд: ${relayFailures.lastError}.\n` +
      `Бот не может отправлять сообщения. Откат на запасной релей — docs/telegram-bot.md.`
    : null;
  await report('relay', problem, `✅ Релей Telegram снова отвечает (${base}).`);
}

async function checkWebhook() {
  let info;
  try {
    info = await telegramRequest('getWebhookInfo', {}, { timeoutMs: RELAY_TIMEOUT_MS, retries: 0 });
  } catch {
    return; // релей лежит — об этом скажет checkRelay
  }
  const pending = Number(info?.pending_update_count || 0);
  const lastErrorAt = Number(info?.last_error_date || 0) * 1000;
  const freshError = lastErrorAt && Date.now() - lastErrorAt < 3 * 60 * 1000;
  const problem = pending >= 20 || freshError
    ? `🔴 <b>Telegram не может доставить апдейты боту</b>\n` +
      `В очереди: ${pending}.` +
      (lastErrorAt ? `\nПоследняя ошибка ${new Date(lastErrorAt).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК: ${info.last_error_message || ''}` : '') +
      `\nВебхук: ${info?.url || '—'}`
    : null;
  await report('webhook', problem, `✅ Telegram снова доставляет апдейты, очередь ${pending}.`);
}

// Сайт (роль site) следит за узлом бота в Германии: GET BOT_NODE_URL (tg.shk-wb.ru:88/webhook через Caddy
// в локальный процесс). Два провала подряд — сообщение; :88 лежит вместе с узлом, так что доставка пойдёт
// через TELEGRAM_API_FALLBACK_BASE (deliver перебирает оба).
const nodeFailures = { count: 0, lastError: '' };

async function checkBotNode() {
  const url = String(process.env.BOT_NODE_URL || '').trim();
  if (!url) return;
  const startedAt = Date.now();
  let error = '';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
    if (!response.ok) error = `HTTP ${response.status}`;
  } catch (err) {
    error = err.message;
  }
  if (error) { nodeFailures.count += 1; nodeFailures.lastError = error; } else nodeFailures.count = 0;
  const problem = nodeFailures.count >= 2
    ? `🔴 <b>Узел бота в Германии не отвечает</b>\n${url}\n${nodeFailures.count} проверки подряд: ${nodeFailures.lastError} (${sec(Date.now() - startedAt)} с).\n` +
      `Бот не обрабатывает сообщения. Проверить: ssh root@109.120.140.116, systemctl status shk-wb caddy. Откат на обработку на VPS — docs/telegram-bot.md.`
    : null;
  await report('bot-node', problem, `✅ Узел бота в Германии снова отвечает (${url}).`);
}

async function check() {
  const botNode = process.env.BOT_ROLE === 'bot';
  // Апдейты и вебхук проверяет тот, кто их обрабатывает (узел бота, а без него — сайт);
  // релей — оба (сайт шлёт через него сообщения); за узлом бота следит сайт.
  const processesUpdates = botNode || !String(process.env.BOT_NODE_URL || '').trim();
  if (processesUpdates) await checkUpdates().catch(error => console.error('bot health (updates):', error.message));
  await checkRelay().catch(error => console.error('bot health (relay):', error.message));
  if (processesUpdates) await checkWebhook().catch(error => console.error('bot health (webhook):', error.message));
  if (!botNode) await checkBotNode().catch(error => console.error('bot health (bot node):', error.message));
}

/**
 * Снимок для экрана «Система» в админке (без запросов наружу).
 * Окно апдейтов живёт в памяти того процесса, который их обрабатывает: при заданном BOT_NODE_URL
 * это узел в Германии, и у сайта window = null, lastUpdateAgoSec = null — это не ошибка.
 */
function summary(now = Date.now()) {
  const botNode = process.env.BOT_ROLE === 'bot';
  const processesUpdates = botNode || !String(process.env.BOT_NODE_URL || '').trim();
  const items = records.filter(item => now - item.at <= WINDOW_MS);
  const evaluated = processesUpdates ? evaluateUpdates(items) : null;
  const last = records.length ? records[records.length - 1].at : null;
  return {
    processesUpdates,
    slowMs: SLOW_MS,
    window: evaluated ? { total: evaluated.total, slow: evaluated.slow, failed: evaluated.failed, worst: evaluated.worst, degraded: evaluated.degraded } : null,
    lastUpdateAgoSec: processesUpdates && last ? Math.max(0, Math.round((now - last) / 1000)) : null,
    relayFailures: relayFailures.count,
    nodeFailures: nodeFailures.count,
    state: readState(),
  };
}

function startBotHealth() {
  const run = () => check();
  setTimeout(run, 90 * 1000).unref();
  setInterval(run, CHECK_MS).unref();
}

module.exports = { STATE_FILE, check, evaluateUpdates, recordUpdate, report, startBotHealth, summary };
