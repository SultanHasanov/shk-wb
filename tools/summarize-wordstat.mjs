import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2] || 'research/wordstat/2026-10-28';
const { results } = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'));
const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const csv = (headers, rows) => [headers, ...rows].map(row => row.map(quote).join(',')).join('\n') + '\n';
const pairs = new Map();
for (const row of results) {
  const key = `${row.group}\u0000${row.phrase}\u0000${row.region}`;
  if (!pairs.has(key)) pairs.set(key, { group: row.group, phrase: row.phrase, region: row.region });
  const p = pairs.get(key);
  p[`${row.kind}_${row.match}_${row.device}`] = row;
}
const freq = [];
const dynamics = [];
const related = [];
for (const p of pairs.values()) {
  const count = (match, device = 'all') => p[`top_${match}_${device}`]?.data?.totalCount ?? '';
  const status = (match, device = 'all') => {
    const row = p[`top_${match}_${device}`];
    return row?.missing ? 'quota_pending' : row?.error ? 'error' : row?.data?.totalCount === undefined ? 'no_count_returned' : 'ok';
  };
  freq.push([p.group, p.phrase, p.region,
    count('broad'), status('broad'), count('phrase'), status('phrase'), count('exact'), status('exact'),
    count('broad', 'phone'), status('broad', 'phone'), count('broad', 'desktop'), status('broad', 'desktop')]);
  for (const device of ['all', 'phone', 'desktop']) {
    for (const item of p[`dynamics_broad_${device}`]?.data?.results || []) {
      dynamics.push([p.group, p.phrase, p.region, device, item.date?.slice(0, 7), item.count ?? '', item.share ?? '']);
    }
  }
  const top = p.top_broad_all?.data;
  for (const [kind, items] of [['contains', top?.results], ['also_search', top?.associations]]) {
    for (const item of items || []) related.push([p.group, p.phrase, p.region, kind, item.phrase, item.count]);
  }
}
await Promise.all([
  writeFile(join(dir, 'frequencies.csv'), '\ufeff' + csv(['group','phrase','region','broad_30d','broad_status','phrase_30d','phrase_status','exact_30d','exact_status','phone_broad_30d','phone_status','desktop_broad_30d','desktop_status'], freq)),
  writeFile(join(dir, 'dynamics.csv'), '\ufeff' + csv(['group','phrase','region','device','month','count','share'], dynamics)),
  writeFile(join(dir, 'related_queries.csv'), '\ufeff' + csv(['group','source_phrase','region','kind','query','count_30d'], related)),
]);
console.log(JSON.stringify({ phraseRegionPairs: pairs.size, frequencyRows: freq.length,
  monthlyRows: dynamics.length, relatedRows: related.length }));
