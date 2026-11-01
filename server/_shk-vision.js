// Номер ШК с фото или скриншота — локально, без внешних сервисов (tesseract.js + sharp).
//
// Что присылают люди: скриншоты приложения WB Point («Подмена», «Зависшие ШК», карточка ШК) и фото
// экрана ноутбука с WB-PVZ («Возврат»). ШК там напечатан текстом: 11 цифр подряд («ШК 47671114039»,
// хвост выделен цветом или жирным) или «7 цифр + пробел + 4 цифры» («4894976 8172»).
// Рядом — баркод из 13 цифр, номер ПВЗ из 8, цены, даты, ячейка: ни одно из них не даёт 11 цифр.
//
// Настройки подобраны на пяти реальных примерах (src/test/fixtures/shk-*): серый, ширина 2000 px,
// normalize, PSM 11 (разреженный текст), в словаре только цифры и пробел. Не нашли — второй и третий
// проход с другой подготовкой картинки. Языковой файл лежит в server/assets/tessdata — сервер
// не ходит за ним в интернет.
const path = require('path');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CODES = 5;
const LANG_PATH = path.join(__dirname, 'assets', 'tessdata');
const OCR_TIMEOUT_MS = 30_000;
// Воркер держит в памяти ~100–150 МБ: после простоя выгружаем.
const WORKER_IDLE_MS = 5 * 60 * 1000;

/** Картинка из сообщения: самое крупное фото или документ-картинка до 10 МБ. */
function imageOf(message) {
  const photos = message?.photo;
  if (Array.isArray(photos) && photos.length) {
    const largest = photos[photos.length - 1];
    if (largest?.file_id) return { fileId: largest.file_id, mime: 'image/jpeg' };
  }
  const document = message?.document;
  if (document?.file_id && String(document.mime_type || '').startsWith('image/') && Number(document.file_size || 0) <= MAX_IMAGE_BYTES) {
    return { fileId: document.file_id, mime: document.mime_type };
  }
  return null;
}

/**
 * Номера ШК из распознанного текста. length — 11 для товаров, 10 для коробок.
 * Берём только целые группы цифр нужной длины; для товаров ещё «7 цифр + 4 цифры» (WB-PVZ на ПК),
 * где после четырёх цифр может прилипнуть одна лишняя от значка «копировать».
 * Порядок — как на экране (сверху вниз), повторы схлопываются, не больше пяти.
 */
function extractShkCodes(text, length = 11) {
  const codes = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const groups = line.match(/\d+/g) || [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (group.length === length) { codes.push(group); continue; }
      // «4894976 8172»; значок «копировать» справа от номера в WB-PVZ OCR читает как «0» → «4894976 81720».
      const next = groups[index + 1];
      if (length === 11 && group.length === 7 && (next?.length === 4 || next?.length === 5)) {
        codes.push(group + next.slice(0, 4));
        index += 1;
      }
    }
  }
  return [...new Set(codes)].slice(0, MAX_CODES);
}

// Подготовка картинки: первый вариант — основной, остальные — если он не дал номера.
const PREPARE = [
  sharp => sharp.grayscale().resize({ width: 2000 }).normalize(),
  sharp => sharp.grayscale().resize({ width: 1400 }).normalize(),
  sharp => sharp.grayscale().resize({ width: 2000 }).normalize().threshold(150),
];

let workerPromise = null;
let idleTimer = null;
let queue = Promise.resolve();

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, PSM } = require('tesseract.js');
      const worker = await createWorker('eng', 1, { langPath: LANG_PATH, gzip: true, cacheMethod: 'none' });
      await worker.setParameters({ tessedit_char_whitelist: '0123456789 ', tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      return worker;
    })().catch(error => { workerPromise = null; throw error; });
  }
  return workerPromise;
}

async function stopWorker() {
  const pending = workerPromise;
  workerPromise = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (pending) await pending.then(worker => worker.terminate()).catch(() => {});
}

function scheduleIdleStop() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { stopWorker(); }, WORKER_IDLE_MS);
  idleTimer.unref?.();
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Распознавание заняло слишком долго')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function recognizeNow(buffer, length) {
  const sharp = require('sharp');
  const worker = await getWorker();
  for (const prepare of PREPARE) {
    const image = await prepare(sharp(buffer, { failOn: 'none' }).rotate()).png().toBuffer();
    const { data } = await worker.recognize(image);
    const codes = extractShkCodes(data?.text, length);
    if (codes.length) return codes;
  }
  return [];
}

/**
 * Номера ШК на картинке (0–5). Распознавания идут по одному: OCR грузит процессор, а VPS один.
 * Зависло — воркер перезапускаем, чтобы следующее фото не встало в ту же очередь.
 */
function recognizeShk(buffer, { length = 11 } = {}) {
  const run = queue.then(async () => {
    try {
      return await withTimeout(recognizeNow(buffer, length), OCR_TIMEOUT_MS);
    } catch (error) {
      await stopWorker();
      throw error;
    } finally {
      scheduleIdleStop();
    }
  });
  queue = run.catch(() => {});
  return run;
}

module.exports = { MAX_IMAGE_BYTES, extractShkCodes, imageOf, recognizeShk, stopWorker };
