// Предупреждение админу в Telegram, когда на диске сервера кончается место: на нём живут
// архив и зеркало «Помощника ПВЗ» (Postgres pvz_archive) и их бэкапы — диск надо успеть увеличить.
// Раз в 15 минут смотрим свободное место на /. Меньше DISK_ALERT_FREE_GB (2 ГБ) — сообщение,
// пока места мало — повтор раз в сутки; освободилось больше порога + 0.5 ГБ — «место есть».
// Так же следим за базой Supabase: бесплатный тариф при 500 МБ переводит её в «только чтение»
// (24.10 из-за этого не работали вход, оплаты и бот). Порог — SUPABASE_ALERT_MB (400 МБ).
// Состояние — в файле, чтобы перезапуск сервера не слал сообщение заново.
const fs = require('fs');
const path = require('path');
const { sendToAdmins } = require('./_admin-alerts');
const { supabaseFetch } = require('./_supabase');

const CHECK_MS = 15 * 60 * 1000;
const REPEAT_MS = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;
const STATE_FILE = process.env.DISK_ALERT_STATE || '/srv/shk-wb/state/disk-alert.json';

const MB = 1024 ** 2;
const SUPABASE_LIMIT_MB = 500;

const mb = bytes => Math.round(bytes / MB).toLocaleString('ru-RU');
const gb = bytes => (bytes / GB).toLocaleString('ru-RU', { maximumFractionDigits: 1 });

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (error) {
    console.error('disk alert state:', error.message);
  }
}

// Состояние по каждой проверке: { disk: {low, sentAt}, supabase: {low, sentAt} }.
async function alert(key, low, recovered, lowText, okText) {
  const all = readState();
  const state = all[key] || {};
  const now = Date.now();
  if (low) {
    if (state.low && now - (state.sentAt || 0) < REPEAT_MS) return;
    await sendToAdmins(lowText());
    writeState({ ...all, [key]: { low: true, sentAt: now } });
  } else if (state.low && recovered) {
    await sendToAdmins(okText());
    writeState({ ...all, [key]: { low: false, sentAt: now } });
  }
}

async function checkDisk() {
  const limit = Number(process.env.DISK_ALERT_FREE_GB || 2) * GB;
  const st = await fs.promises.statfs('/');
  const free = st.bavail * st.bsize;
  const total = st.blocks * st.bsize;
  await alert('disk', free < limit, free > limit + GB / 2, () => (
    `⚠️ <b>Мало места на сервере shk-wb</b>\n` +
    `Свободно ${gb(free)} ГБ из ${gb(total)} ГБ.\n` +
    `Там архив и зеркало «Помощника ПВЗ» — когда место кончится, они перестанут сохраняться.\n` +
    `Увеличьте диск: Simple Cloud → shk-wb → «Конфигурация сервера».`
  ), () => `✅ Место на сервере shk-wb есть: свободно ${gb(free)} ГБ из ${gb(total)} ГБ.`);
}

async function checkSupabase() {
  const limit = Number(process.env.SUPABASE_ALERT_MB || 400) * MB;
  const size = Number(await supabaseFetch('rpc/app_db_size', { method: 'POST', body: '{}' }));
  if (!Number.isFinite(size) || size <= 0) return;
  await alert('supabase', size >= limit, size < limit - 25 * MB, () => (
    `⚠️ <b>База Supabase почти заполнена</b>\n` +
    `Занято ${mb(size)} МБ из ${SUPABASE_LIMIT_MB} МБ бесплатного тарифа.\n` +
    `При ${SUPABASE_LIMIT_MB} МБ база станет «только для чтения»: перестанут работать вход, оплаты и бот.\n` +
    `Посмотрите, какая таблица выросла: Supabase → Database → Tables (сортировка по размеру).`
  ), () => `✅ База Supabase: занято ${mb(size)} МБ из ${SUPABASE_LIMIT_MB} МБ.`);
}

async function check() {
  await checkDisk().catch(error => console.error('disk alert:', error.message));
  await checkSupabase().catch(error => console.error('supabase size alert:', error.message));
}

function startDiskAlert() {
  const run = () => check();
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, CHECK_MS).unref();
}

module.exports = { check, startDiskAlert };
