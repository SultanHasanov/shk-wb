import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';

const cacheOnly = process.argv.includes('--cache-only');
const apiKey = process.env.YANDEX_SEARCH_API_KEY;
const folderId = process.env.YANDEX_SEARCH_FOLDER_ID;
if (!folderId || (!cacheOnly && !apiKey)) throw new Error('Set YANDEX_SEARCH_FOLDER_ID and, unless --cache-only, YANDEX_SEARCH_API_KEY');
const maxNew = Number(process.env.WORDSTAT_MAX_NEW || 90);
let newCalls = 0;
let halted = false;

const outDir = process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'research/wordstat/2026-10-28';
await mkdir(outDir, { recursive: true });
const cacheFile = join(outDir, 'responses.json');
let cache = {};
try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch {}
let saveQueue = Promise.resolve();
function persistCache() {
  saveQueue = saveQueue.then(async () => {
    await writeFile(`${cacheFile}.tmp`, JSON.stringify(cache), 'utf8');
    await rename(`${cacheFile}.tmp`, cacheFile);
  });
  return saveQueue;
}

const groups = {
  generator: [
    'шк вб', 'генератор шк вб', 'генератор шк wb', 'штрихкод вб',
    'возвратные стикеры вб', 'стикер возврата вб', 'qr код коробки вб',
    'шк коробов wb', 'возвратная коробка вб', 'стикеры вб 58х40',
    'термопринтер стикеры вб',
  ],
  pvz_program: [
    'программа для пвз вб', 'помощник пвз', 'код клиента пвз',
    'код клиента по ячейке', 'узнать код получения вб', 'подбор кода пвз',
    'досье клиента пвз', 'отзывы пвз',
  ],
  cell_print: [
    'печать ячеек', 'номер ячейки пвз печать', 'этикетка ячейки вб',
    'принтер для пвз', 'niimbot пвз', 'xprinter пвз',
  ],
  networks: ['сеть пвз вб', 'несколько пвз', 'автоматизация пвз', 'открыть пвз вб'],
  brand_competitors: ['шк вб ру', 'shk-wb', 'wbcash', 'omni пвз'],
  telegram: ['бот шк вб', 'генератор шк телеграм'],
  kz_kazakh_exploratory: [
    'пвз бағдарламасы', 'тапсырысты алу коды wildberries',
    'ұяшық нөмірін басып шығару', 'қайтару стикері wildberries',
    'wildberries штрих коды', 'wildberries қайтару жапсырмасы',
  ],
};
const regions = [{ name: 'RU', id: '225' }, { name: 'KZ', id: '159' }];
const phrases = Object.entries(groups).flatMap(([group, items]) => items.flatMap(phrase =>
  (group === 'kz_kazakh_exploratory' ? [regions[1]] : regions).map(region => ({ group, phrase, region }))));

function exact(phrase) {
  return `"${phrase.split(/\s+/).map(word => `!${word}`).join(' ')}"`;
}
function keyFor(method, body) {
  return createHash('sha256').update(JSON.stringify({ method, body })).digest('hex');
}
function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpsRequest(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
      timeout: 30000,
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 300) }; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}
async function request(method, body) {
  const key = keyFor(method, body);
  if (cache[key]) return cache[key];
  if (cacheOnly || halted) return null;
  if (newCalls >= maxNew) { halted = true; return null; }
  newCalls++;
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await postJson(`https://searchapi.api.cloud.yandex.net/v2/wordstat/${method}`,
      { Authorization: `Api-Key ${apiKey}`, 'Content-Type': 'application/json' }, body);
    const data = res.data;
    if (res.ok) {
      cache[key] = data;
      await persistCache();
      return data;
    }
    last = `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`;
    if (res.status === 429) { halted = true; break; }
    if (![500, 502, 503, 504].includes(res.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw new Error(last);
}

const tasks = [];
for (const item of phrases) {
  const base = { regions: [item.region.id], folderId };
  for (const [match, query] of [
    ['broad', item.phrase], ['phrase', `"${item.phrase}"`], ['exact', exact(item.phrase)],
  ]) {
    tasks.push({ ...item, kind: 'top', match, device: 'all', method: 'topRequests',
      body: { ...base, phrase: query, numPhrases: match === 'broad' ? 30 : 1, devices: ['DEVICE_ALL'] } });
  }
  for (const [device, code] of [['phone', 'DEVICE_PHONE'], ['desktop', 'DEVICE_DESKTOP']]) {
    tasks.push({ ...item, kind: 'top', match: 'broad', device, method: 'topRequests',
      body: { ...base, phrase: item.phrase, numPhrases: 1, devices: [code] } });
  }
  for (const [device, code] of [['all', 'DEVICE_ALL'], ['phone', 'DEVICE_PHONE'], ['desktop', 'DEVICE_DESKTOP']]) {
    tasks.push({ ...item, kind: 'dynamics', match: 'broad', device, method: 'dynamics',
      body: { ...base, phrase: item.phrase, period: 'PERIOD_MONTHLY',
        fromDate: '2025-10-01T00:00:00Z', toDate: '2026-09-30T23:59:59Z', devices: [code] } });
  }
}

const errors = {};
let cursor = 0;
async function worker() {
  while (cursor < tasks.length && !halted) {
    const task = tasks[cursor++];
    try {
      await request(task.method, task.body);
    } catch (error) {
      errors[keyFor(task.method, task.body)] = String(error.message);
    }
    if (cursor % 50 === 0) process.stderr.write(`Visited ${cursor}/${tasks.length}\n`);
    if (!cacheOnly) await new Promise(resolve => setTimeout(resolve, 150));
  }
}
await Promise.all(Array.from({ length: 3 }, worker));
const results = tasks.map(task => {
  const key = keyFor(task.method, task.body);
  return { group: task.group, phrase: task.phrase, region: task.region.name,
    kind: task.kind, match: task.match, device: task.device,
    ...(cache[key] ? { data: cache[key] } : errors[key] ? { error: errors[key] } : { missing: true }) };
});
await writeFile(join(outDir, 'data.json'), JSON.stringify({ collectedAt: new Date().toISOString(),
  months: ['2025-10', '2026-09'], results }, null, 2), 'utf8');
process.stdout.write(JSON.stringify({ tasks: tasks.length, completed: results.filter(r => r.data).length,
  missing: results.filter(r => r.missing).length, errors: results.filter(r => r.error).length,
  newCalls, cacheEntries: Object.keys(cache).length }) + '\n');
