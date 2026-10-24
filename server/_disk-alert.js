// Предупреждение админу в Telegram, когда на диске сервера кончается место: на нём живут
// архив и зеркало «Помощника ПВЗ» (Postgres pvz_archive) и их бэкапы — диск надо успеть увеличить.
// Раз в 15 минут смотрим свободное место на /. Меньше DISK_ALERT_FREE_GB (2 ГБ) — сообщение,
// пока места мало — повтор раз в сутки; освободилось больше порога + 0.5 ГБ — «место есть».
// Состояние — в файле, чтобы перезапуск сервера не слал сообщение заново.
const fs = require('fs');
const path = require('path');
const { sendToAdmins } = require('./_admin-alerts');

const CHECK_MS = 15 * 60 * 1000;
const REPEAT_MS = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;
const STATE_FILE = process.env.DISK_ALERT_STATE || '/srv/shk-wb/state/disk-alert.json';

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

async function check() {
  const limit = Number(process.env.DISK_ALERT_FREE_GB || 2) * GB;
  const st = await fs.promises.statfs('/');
  const free = st.bavail * st.bsize;
  const total = st.blocks * st.bsize;
  const state = readState();
  const now = Date.now();
  if (free < limit) {
    if (state.low && now - (state.sentAt || 0) < REPEAT_MS) return;
    await sendToAdmins(
      `⚠️ <b>Мало места на сервере shk-wb</b>\n` +
      `Свободно ${gb(free)} ГБ из ${gb(total)} ГБ.\n` +
      `Там архив и зеркало «Помощника ПВЗ» — когда место кончится, они перестанут сохраняться.\n` +
      `Увеличьте диск: Simple Cloud → shk-wb → «Конфигурация сервера».`,
    );
    writeState({ low: true, sentAt: now });
  } else if (state.low && free > limit + GB / 2) {
    await sendToAdmins(`✅ Место на сервере shk-wb есть: свободно ${gb(free)} ГБ из ${gb(total)} ГБ.`);
    writeState({ low: false, sentAt: now });
  }
}

function startDiskAlert() {
  const run = () => check().catch(error => console.error('disk alert:', error.message));
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, CHECK_MS).unref();
}

module.exports = { check, startDiskAlert };
