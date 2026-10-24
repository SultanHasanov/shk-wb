-- Архив и зеркало «Помощника ПВЗ» в своём Postgres на сервере (база pvz_archive, роль shkwb, только сокет).
-- Перенесён из Supabase (20261028_app_points_sync.sql): таблицы и app_archive_push — те же,
-- seq сохранены при переносе, поэтому курсоры программ остаются верными.
-- Пункты (app_points) живут в Supabase, поэтому внешнего ключа на них здесь нет:
-- принадлежность пункта проверяет сервер (_app-sync.js ownPoint) до каждого запроса.
-- Применение (идемпотентно): sudo -u shkwb psql -d pvz_archive -f selfhost/archive-schema.sql

create sequence if not exists app_sync_seq;

create table if not exists app_archive_goods (
  point_id uuid not null,
  uid text not null check (char_length(uid) between 1 and 80),
  sid text not null check (char_length(sid) between 1 and 40),
  status text check (char_length(status) <= 40),
  purpose text check (char_length(purpose) <= 40),
  updated text check (char_length(updated) <= 40),
  -- 1 — запись из пункта (с ячейкой): при равном updated она главнее записи «в пути»
  rank smallint not null default 0,
  data_enc text not null check (char_length(data_enc) <= 16000),
  archived_at timestamptz not null default now(),
  seq bigint not null default nextval('app_sync_seq'),
  primary key (point_id, uid)
);
create index if not exists app_archive_goods_seq_idx on app_archive_goods(point_id, seq);

create table if not exists app_archive_clients (
  point_id uuid not null,
  sid text not null check (char_length(sid) between 1 and 40),
  mobile_enc text check (char_length(mobile_enc) <= 400),
  name_enc text check (char_length(name_enc) <= 800),
  first_seen text not null,
  last_seen text not null,
  seq bigint not null default nextval('app_sync_seq'),
  primary key (point_id, sid)
);
create index if not exists app_archive_clients_seq_idx on app_archive_clients(point_id, seq);

create table if not exists app_archive_reviews (
  point_id uuid not null,
  rid text not null check (char_length(rid) between 1 and 80),
  rated_at text,
  data_enc text not null check (char_length(data_enc) <= 32000),
  seq bigint not null default nextval('app_sync_seq'),
  primary key (point_id, rid)
);
create index if not exists app_archive_reviews_seq_idx on app_archive_reviews(point_id, seq);

create table if not exists app_archive_shk (
  point_id uuid not null,
  code text not null check (char_length(code) between 1 and 80),
  fetched_at text not null,
  data_enc text not null check (char_length(data_enc) <= 64000),
  seq bigint not null default nextval('app_sync_seq'),
  primary key (point_id, code)
);
create index if not exists app_archive_shk_seq_idx on app_archive_shk(point_id, seq);

-- Приём пачки архива. Ничего не удаляет; старое не перезаписывает новое.
-- Шифрование детерминированное (server/_app-crypto.js): одинаковые данные = одинаковый
-- data_enc, поэтому повтор той же записи не двигает seq и не гоняет данные по кругу.
-- last_sync_at пункта сервер обновляет в Supabase сам.
create or replace function app_archive_push(p_point uuid, p_goods jsonb, p_clients jsonb, p_reviews jsonb, p_shk jsonb)
returns bigint language plpgsql as $$
declare
  changed bigint := 0;
  n bigint;
begin
  insert into app_archive_goods as cur (point_id, uid, sid, status, purpose, updated, rank, data_enc)
  select p_point, g->>'uid', g->>'sid', nullif(g->>'status', ''), nullif(g->>'purpose', ''),
         nullif(g->>'updated', ''), coalesce((g->>'rank')::smallint, 0), g->>'data'
    from jsonb_array_elements(coalesce(p_goods, '[]'::jsonb)) g
   where coalesce(g->>'uid', '') <> '' and coalesce(g->>'sid', '') <> '' and coalesce(g->>'data', '') <> ''
  on conflict (point_id, uid) do update
     set sid = excluded.sid, status = excluded.status, purpose = excluded.purpose, updated = excluded.updated,
         rank = excluded.rank, data_enc = excluded.data_enc, seq = nextval('app_sync_seq')
   where excluded.data_enc is distinct from cur.data_enc
     and (cur.updated is null
          or excluded.updated > cur.updated
          or (excluded.updated is not distinct from cur.updated and excluded.rank > cur.rank));
  get diagnostics n = row_count; changed := changed + n;

  insert into app_archive_clients as cur (point_id, sid, mobile_enc, name_enc, first_seen, last_seen)
  select p_point, c->>'sid', nullif(c->>'mobile', ''), nullif(c->>'name', ''),
         coalesce(nullif(c->>'first_seen', ''), to_char(now(), 'YYYY-MM-DD')),
         coalesce(nullif(c->>'last_seen', ''), to_char(now(), 'YYYY-MM-DD'))
    from jsonb_array_elements(coalesce(p_clients, '[]'::jsonb)) c
   where coalesce(c->>'sid', '') <> ''
  on conflict (point_id, sid) do update
     set mobile_enc = coalesce(excluded.mobile_enc, cur.mobile_enc),
         name_enc = coalesce(excluded.name_enc, cur.name_enc),
         first_seen = least(cur.first_seen, excluded.first_seen),
         last_seen = greatest(cur.last_seen, excluded.last_seen),
         seq = nextval('app_sync_seq')
   where (excluded.mobile_enc is not null and excluded.mobile_enc is distinct from cur.mobile_enc)
      or (excluded.name_enc is not null and excluded.name_enc is distinct from cur.name_enc)
      or excluded.first_seen < cur.first_seen
      or excluded.last_seen > cur.last_seen;
  get diagnostics n = row_count; changed := changed + n;

  insert into app_archive_reviews as cur (point_id, rid, rated_at, data_enc)
  select p_point, r->>'rid', nullif(r->>'rated_at', ''), r->>'data'
    from jsonb_array_elements(coalesce(p_reviews, '[]'::jsonb)) r
   where coalesce(r->>'rid', '') <> '' and coalesce(r->>'data', '') <> ''
  on conflict (point_id, rid) do update
     set rated_at = coalesce(excluded.rated_at, cur.rated_at), data_enc = excluded.data_enc, seq = nextval('app_sync_seq')
   where excluded.data_enc is distinct from cur.data_enc;
  get diagnostics n = row_count; changed := changed + n;

  insert into app_archive_shk as cur (point_id, code, fetched_at, data_enc)
  select p_point, s->>'code', s->>'fetched_at', s->>'data'
    from jsonb_array_elements(coalesce(p_shk, '[]'::jsonb)) s
   where coalesce(s->>'code', '') <> '' and coalesce(s->>'fetched_at', '') <> '' and coalesce(s->>'data', '') <> ''
  on conflict (point_id, code) do update
     set fetched_at = excluded.fetched_at, data_enc = excluded.data_enc, seq = nextval('app_sync_seq')
   where excluded.fetched_at > cur.fetched_at and excluded.data_enc is distinct from cur.data_enc;
  get diagnostics n = row_count; changed := changed + n;

  return changed;
end;
$$;

-- Архив старше 365 дней — как app_sync_maintenance в Supabase. Вызывается кроном (api/cabinet.js).
create or replace function app_archive_maintenance()
returns jsonb language plpgsql as $$
declare
  cut text := to_char(now() - interval '365 days', 'YYYY-MM-DD');
  a bigint; b bigint; c bigint; d bigint;
begin
  delete from app_archive_goods where coalesce(updated, to_char(archived_at, 'YYYY-MM-DD')) < cut;
  get diagnostics a = row_count;
  delete from app_archive_clients where last_seen < cut;
  get diagnostics b = row_count;
  delete from app_archive_reviews where coalesce(rated_at, '9999') < cut;
  get diagnostics c = row_count;
  delete from app_archive_shk where fetched_at < cut;
  get diagnostics d = row_count;
  return jsonb_build_object('goods', a, 'clients', b, 'reviews', c, 'shk', d);
end;
$$;

-- ---------- зеркало базы WB пункта (услуга «Пункт с любого ПК») ----------
-- Было в Supabase (app_point_rows + колонки mirror_* в app_points): 12 пунктов заняли 1 ГБ.
-- Отметки пункта (схема таблиц, время, порог удалений) — здесь же, в app_mirror_points.

create table if not exists app_point_rows (
  point_id uuid not null,
  tbl text not null check (tbl ~ '^[a-z_]{1,40}$'),
  pk text not null check (char_length(pk) between 1 and 400),
  -- null = строки больше нет в базе WB (для тех, кто тянет изменения)
  data_enc text check (char_length(data_enc) <= 64000),
  updated_at timestamptz not null default now(),
  seq bigint not null default nextval('app_sync_seq'),
  primary key (point_id, tbl, pk)
);
create index if not exists app_point_rows_seq_idx on app_point_rows(point_id, seq);
create index if not exists app_point_rows_gone_idx on app_point_rows(point_id, updated_at) where data_enc is null;

create table if not exists app_mirror_points (
  point_id uuid primary key,
  mirror_schema jsonb,
  mirror_floor bigint not null default 0,
  mirror_at timestamptz
);

create or replace function app_mirror_push(p_point uuid, p_rows jsonb, p_schema jsonb)
returns bigint language plpgsql as $$
declare
  n bigint;
  floor_seq bigint;
begin
  insert into app_mirror_points (point_id) values (p_point) on conflict do nothing;
  if p_schema is not null then
    update app_mirror_points set mirror_schema = p_schema where point_id = p_point;
  end if;
  insert into app_point_rows as cur (point_id, tbl, pk, data_enc)
  select p_point, r->>'t', r->>'k', nullif(r->>'d', '')
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
   where coalesce(r->>'t', '') <> '' and coalesce(r->>'k', '') <> ''
  on conflict (point_id, tbl, pk) do update
     set data_enc = excluded.data_enc, updated_at = now(), seq = nextval('app_sync_seq')
   where excluded.data_enc is distinct from cur.data_enc;
  get diagnostics n = row_count;
  -- удалённые строки помним 3 дня; кто не заходил дольше — перекачает зеркало целиком
  select max(seq) into floor_seq from app_point_rows
   where point_id = p_point and data_enc is null and updated_at < now() - interval '3 days';
  if floor_seq is not null then
    delete from app_point_rows
     where point_id = p_point and data_enc is null and updated_at < now() - interval '3 days';
    update app_mirror_points set mirror_floor = greatest(mirror_floor, floor_seq) where point_id = p_point;
  end if;
  update app_mirror_points set mirror_at = now() where point_id = p_point;
  return n;
end;
$$;
