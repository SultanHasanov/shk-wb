#!/usr/bin/env node
// Перенос архива «Помощника ПВЗ» из Supabase в свой Postgres (selfhost/archive-schema.sql).
// Запуск на сервере из папки релиза, с переменными из /srv/shk-wb/.env:
//   set -a; . /srv/shk-wb/.env; set +a
//   ARCHIVE_DATABASE_URL=postgresql:///pvz_archive?host=/var/run/postgresql node selfhost/archive-copy.cjs full
//   ... переключить сервер (ARCHIVE_DATABASE_URL в .env, restart) ...
//   node selfhost/archive-copy.cjs delta <seq из вывода full>
// full  — всё, seq сохраняются (курсоры программ остаются верными), затем последовательность
//         поднимается выше Supabase с запасом, чтобы новые записи сервера были «новее».
// delta — записи Supabase новее перенесённых (дописанные, пока шёл перенос), N — максимальный
//         seq из вывода full; переносятся с НОВЫМИ seq: ПК, уже
//         скачавшие свежее, всё равно их получат. Существующие строки не перезаписывает,
//         если в своей базе запись уже новее (обновлена после переключения).
const { Pool } = require('pg');

const TABLES = {
  app_archive_goods: { key: ['point_id', 'uid'], cols: ['point_id', 'uid', 'sid', 'status', 'purpose', 'updated', 'rank', 'data_enc', 'archived_at', 'seq'] },
  app_archive_clients: { key: ['point_id', 'sid'], cols: ['point_id', 'sid', 'mobile_enc', 'name_enc', 'first_seen', 'last_seen', 'seq'] },
  app_archive_reviews: { key: ['point_id', 'rid'], cols: ['point_id', 'rid', 'rated_at', 'data_enc', 'seq'] },
  app_archive_shk: { key: ['point_id', 'code'], cols: ['point_id', 'code', 'fetched_at', 'data_enc', 'seq'] },
};
const PAGE = 1000;
const SEQ_MARGIN = 1_000_000;

const mode = process.argv[2];
const deltaFrom = Number(process.argv[3] || 0);
if (!['full', 'delta'].includes(mode) || (mode === 'delta' && !deltaFrom)) {
  console.error('usage: archive-copy.cjs full | delta <seq>');
  process.exit(2);
}
const base = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!base || !key || !process.env.ARCHIVE_DATABASE_URL) {
  console.error('нужны SUPABASE_URL, SUPABASE_SECRET_KEY, ARCHIVE_DATABASE_URL');
  process.exit(2);
}

// Постранично по пункту: индекс (point_id, seq) — сортировка по всей таблице упирается в таймаут.
async function page(table, point, since) {
  const url = `${base}/rest/v1/${table}?point_id=eq.${point}&seq=gt.${since}&select=${TABLES[table].cols.join(',')}&order=seq.asc&limit=${PAGE}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (res.ok) return res.json();
    if (attempt >= 5) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    await new Promise(r => setTimeout(r, 2000 * attempt));
  }
}

async function points() {
  const res = await fetch(`${base}/rest/v1/app_points?select=id`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`app_points: HTTP ${res.status}`);
  return (await res.json()).map(p => p.id);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.ARCHIVE_DATABASE_URL, max: 2 });
  const ids = await points();
  let maxSeq = 0;
  for (const [table, { key: pk, cols }] of Object.entries(TABLES)) for (const point of ids) {
    const insertCols = mode === 'full' ? cols : cols.filter(c => c !== 'seq');
    const updates = insertCols.filter(c => !pk.includes(c)).map(c => `${c} = excluded.${c}`);
    if (mode === 'delta') updates.push(`seq = nextval('app_sync_seq')`);
    // full: перенос как есть; delta: не трогаем строку, если своя уже обновлялась после переключения
    // (своя запись новее, если её seq выше значения, выставленного в конце full)
    const guard = mode === 'delta' ? ` where cur.seq <= ${deltaFrom + SEQ_MARGIN}` : '';
    // С последнего перенесённого seq пункта (full можно перезапускать). seq общий на все пункты,
    // поэтому отсчёт — по каждому пункту; в delta — только среди перенесённых строк (seq не выше
    // порога), записанные сервером после переключения не в счёт.
    const limitSeq = mode === 'full' ? Number.MAX_SAFE_INTEGER : deltaFrom + SEQ_MARGIN;
    const { rows: last } = await pool.query(`select coalesce(max(seq), 0) as s from ${table} where point_id = $1 and seq <= $2`, [point, limitSeq]);
    let since = Number(last[0].s);
    if (mode === 'full') maxSeq = Math.max(maxSeq, since);
    let total = 0;
    for (;;) {
      const rows = await page(table, point, since);
      if (!rows.length) break;
      const values = [];
      const tuples = rows.map((r, i) => `(${insertCols.map((c, j) => { values.push(r[c]); return `$${i * insertCols.length + j + 1}`; }).join(',')})`);
      await pool.query(
        `insert into ${table} as cur (${insertCols.join(',')}) values ${tuples.join(',')}
         on conflict (${pk.join(',')}) do update set ${updates.join(', ')}${guard}`,
        values,
      );
      since = rows[rows.length - 1].seq;
      maxSeq = Math.max(maxSeq, Number(since));
      total += rows.length;
      if (total % 20000 < PAGE) console.log(`${table} ${point.slice(0, 8)}: ${total}`);
    }
    if (total) console.log(`${table} ${point.slice(0, 8)}: готово, ${total} строк`);
  }
  if (mode === 'full') {
    // seq Supabase продолжают расти, пока сервер не переключён — запас, чтобы не пересечься
    const { rows } = await pool.query(`select setval('app_sync_seq', greatest((select last_value from app_sync_seq), $1)) as v`, [maxSeq + SEQ_MARGIN]);
    console.log(`максимальный seq Supabase: ${maxSeq}; последовательность своей базы: ${rows[0].v}`);
  }
  await pool.end();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
