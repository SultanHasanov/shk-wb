// Хранилище архива «Помощника ПВЗ» (app_archive_*): свой Postgres на сервере или Supabase.
// С 24.10 архив живёт в Postgres на shk-wb (selfhost/archive-schema.sql): в бесплатном Supabase
// он за сутки занял ~330 из 500 МБ и база ушла в «только чтение».
// ARCHIVE_DATABASE_URL задан (postgresql:///pvz_archive?host=/var/run/postgresql) — пишем туда;
// не задан (локальная разработка, тесты) — как раньше, в Supabase через REST.
const { supabaseFetch } = require('./_supabase');

const TABLES = Object.freeze(['app_archive_goods', 'app_archive_clients', 'app_archive_reviews', 'app_archive_shk']);
// Колонки, которые отдаём программе (без point_id/archived_at).
const COLUMNS = Object.freeze({
  app_archive_goods: 'uid,sid,status,purpose,updated,rank,data_enc,seq',
  app_archive_clients: 'sid,mobile_enc,name_enc,first_seen,last_seen,seq',
  app_archive_reviews: 'rid,rated_at,data_enc,seq',
  app_archive_shk: 'code,fetched_at,data_enc,seq',
});

let pool = null;
function db() {
  const url = process.env.ARCHIVE_DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    const { Pool, types } = require('pg');
    // seq — bigint: программа ждёт число, а не строку (до 2^53 хватит надолго)
    types.setTypeParser(20, v => Number(v));
    pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30000 });
    pool.on('error', error => console.error('archive db:', error.message));
  }
  return pool;
}

/** Приём пачки (аргументы как у SQL app_archive_push). Возвращает число изменённых записей. */
async function push(payload) {
  const p = db();
  if (!p) return Number(await supabaseFetch('rpc/app_archive_push', { method: 'POST', body: JSON.stringify(payload) })) || 0;
  const { rows } = await p.query('select app_archive_push($1, $2, $3, $4, $5) as n', [
    payload.p_point,
    JSON.stringify(payload.p_goods || []),
    JSON.stringify(payload.p_clients || []),
    JSON.stringify(payload.p_reviews || []),
    JSON.stringify(payload.p_shk || []),
  ]);
  return Number(rows[0]?.n) || 0;
}

/** Записи таблицы пункта с seq > since по возрастанию seq. */
async function pull(table, pointId, since, limit) {
  if (!TABLES.includes(table)) throw new Error(`unknown archive table ${table}`);
  const p = db();
  if (!p) {
    return supabaseFetch(`${table}?point_id=eq.${encodeURIComponent(pointId)}&seq=gt.${since}&select=${COLUMNS[table]}&order=seq.asc&limit=${limit}`);
  }
  const { rows } = await p.query(
    `select ${COLUMNS[table]} from ${table} where point_id = $1 and seq > $2 order by seq asc limit $3`,
    [pointId, since, limit],
  );
  return rows;
}

/** Удалить весь архив пункта (по просьбе владельца). */
async function purge(pointId) {
  const p = db();
  for (const table of TABLES) {
    if (p) await p.query(`delete from ${table} where point_id = $1`, [pointId]);
    else await supabaseFetch(`${table}?point_id=eq.${encodeURIComponent(pointId)}`, { method: 'DELETE' });
  }
}

/** Чистка архива старше года (крон). В Supabase это делает app_sync_maintenance. */
async function maintenance() {
  const p = db();
  if (!p) return null;
  const { rows } = await p.query('select app_archive_maintenance() as r');
  return rows[0]?.r || null;
}

// ---------- зеркало базы пункта ----------
// В своём Postgres отметки пункта (схема, время, порог удалений) — в app_mirror_points;
// в Supabase — колонки mirror_* в app_points.

/** Отметки зеркала пунктов: { [pointId]: { schema, floor, at } }. */
async function mirrorMeta(pointIds) {
  const ids = [...new Set(pointIds.filter(Boolean))];
  if (!ids.length) return {};
  const p = db();
  const rows = p
    ? (await p.query('select point_id as id, mirror_schema, mirror_floor, mirror_at from app_mirror_points where point_id = any($1::uuid[])', [ids])).rows
    : await supabaseFetch(`app_points?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,mirror_schema,mirror_floor,mirror_at`);
  return Object.fromEntries(rows.map(r => [r.id, {
    schema: r.mirror_schema || null,
    floor: Number(r.mirror_floor || 0),
    at: r.mirror_at instanceof Date ? r.mirror_at.toISOString() : r.mirror_at || null,
  }]));
}

async function mirrorPush(pointId, rows, schema) {
  const p = db();
  if (!p) {
    return Number(await supabaseFetch('rpc/app_mirror_push', {
      method: 'POST',
      body: JSON.stringify({ p_point: pointId, p_rows: rows, p_schema: schema }),
    })) || 0;
  }
  const { rows: out } = await p.query('select app_mirror_push($1, $2, $3) as n', [pointId, JSON.stringify(rows), schema ? JSON.stringify(schema) : null]);
  return Number(out[0]?.n) || 0;
}

async function mirrorPull(pointId, since, limit) {
  const p = db();
  if (!p) {
    return supabaseFetch(`app_point_rows?point_id=eq.${encodeURIComponent(pointId)}&seq=gt.${since}&select=tbl,pk,data_enc,seq&order=seq.asc&limit=${limit}`);
  }
  const { rows } = await p.query(
    'select tbl, pk, data_enc, seq from app_point_rows where point_id = $1 and seq > $2 order by seq asc limit $3',
    [pointId, since, limit],
  );
  return rows;
}

/** Стереть зеркало пункта (пункт отключили или удалили его данные). */
async function mirrorPurge(pointId) {
  const p = db();
  if (!p) {
    await supabaseFetch(`app_point_rows?point_id=eq.${encodeURIComponent(pointId)}`, { method: 'DELETE' });
    return;
  }
  await p.query('delete from app_point_rows where point_id = $1', [pointId]);
  await p.query('delete from app_mirror_points where point_id = $1', [pointId]);
}

module.exports = { TABLES, maintenance, mirrorMeta, mirrorPull, mirrorPurge, mirrorPush, pull, purge, push };
