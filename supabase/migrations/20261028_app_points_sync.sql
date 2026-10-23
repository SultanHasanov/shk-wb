begin;

-- «Помощник ПВЗ»: пункты (ПВЗ) аккаунта, облачный архив по пункту, зеркало базы пункта
-- для просмотра с другого ПК, документы и секреты аккаунта, регистрация из программы,
-- пакеты доп. ПК и пунктов.
--
-- Главное правило — данные не теряются:
--   * архив только дополняется: запись меняется, лишь когда пришла более свежая
--     (updated больше, при равном — «богаче»: rank выше); удаления в API нет;
--   * зеркало — копия ТЕКУЩЕГО состояния базы WB пункта (там удаление честное: товар выдан
--     и ушёл из базы WB), сам архив при этом хранит всё;
--   * документы (заметки, сотрудники, график, настройки) меняются только с версией,
--     которую видел ПК (иначе VERSION_CONFLICT), прошлые 20 версий остаются в истории.
-- Содержимое (JSON товаров, телефоны, документы, секреты) шифрует сервер (server/_app-crypto.js),
-- в базе лежат только *_enc. Все таблицы — только для service role.

create sequence if not exists public.app_sync_seq;

-- ---------- пакеты ПК и пунктов ----------

alter table public.app_addons drop constraint if exists app_addons_addon_check;
alter table public.app_addons add constraint app_addons_addon_check
  check (addon in ('archive','devices_1','devices_3','points_1','points_3'));

alter table public.payment_orders drop constraint if exists payment_orders_app_addon_check;
alter table public.payment_orders add constraint payment_orders_app_addon_check
  check (app_addon is null or app_addon in ('archive','devices_1','devices_3','points_1','points_3'));
alter table public.payment_orders drop constraint if exists payment_orders_app_addon_months_check;
alter table public.payment_orders add constraint payment_orders_app_addon_months_check
  check (app_addon_months is null or app_addon_months in (1,3,6,12));

-- Новые лимиты ПК (Стандарт 2, Про 4) — действующим подпискам только вверх.
update public.app_subscriptions
   set device_limit = greatest(device_limit, case plan when 'standard' then 2 when 'pro' then 4 else 1 end)
 where not canceled and ends_at > now();

-- Регистрация ПК с лимитом, который считает сервер (тариф + пакеты, server/_app-plans.js).
create or replace function public.app_register_device(p_user uuid, p_hash text, p_name text, p_version text, p_limit integer)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  dev public.app_devices;
  active_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('app_devices:' || p_user::text));
  select * into dev from public.app_devices where user_id = p_user and device_hash = p_hash for update;
  if dev.id is not null and dev.revoked_at is null then
    update public.app_devices set last_seen_at = now(), name = left(coalesce(nullif(btrim(p_name), ''), name), 80),
           app_version = left(coalesce(p_version, ''), 32)
     where id = dev.id;
    return dev.id;
  end if;
  select count(*) into active_count from public.app_devices where user_id = p_user and revoked_at is null;
  if active_count >= greatest(coalesce(p_limit, 1), 1) then raise exception 'DEVICE_LIMIT'; end if;
  if dev.id is not null then
    update public.app_devices set revoked_at = null, last_seen_at = now(),
           name = left(coalesce(nullif(btrim(p_name), ''), name), 80), app_version = left(coalesce(p_version, ''), 32)
     where id = dev.id;
    return dev.id;
  end if;
  insert into public.app_devices(user_id, device_hash, name, app_version)
    values (p_user, p_hash, left(coalesce(nullif(btrim(p_name), ''), 'Компьютер'), 80), left(coalesce(p_version, ''), 32))
    returning id into dev.id;
  return dev.id;
end;
$$;

-- ---------- пункты ----------

create table if not exists public.app_points (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  wb_point_id bigint not null check (wb_point_id > 0),
  name text not null default '' check (char_length(name) <= 200),
  -- CREATE TABLE таблиц зеркала (схема базы WB, без данных)
  mirror_schema jsonb,
  -- ниже этого seq строк зеркала уже нет (чистка удалённых): кто отстал — качает заново
  mirror_floor bigint not null default 0,
  mirror_at timestamptz,
  last_sync_at timestamptz,
  last_device_id uuid references public.app_devices(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, wb_point_id)
);

create or replace function public.app_register_point(p_user uuid, p_wb bigint, p_name text, p_limit integer, p_device uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  pt public.app_points;
  active_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('app_points:' || p_user::text));
  select * into pt from public.app_points where user_id = p_user and wb_point_id = p_wb for update;
  if pt.id is not null and pt.revoked_at is null then
    update public.app_points set name = left(coalesce(nullif(btrim(p_name), ''), name), 200),
           last_device_id = coalesce(p_device, last_device_id)
     where id = pt.id;
    return pt.id;
  end if;
  select count(*) into active_count from public.app_points where user_id = p_user and revoked_at is null;
  if active_count >= greatest(coalesce(p_limit, 1), 1) then raise exception 'POINT_LIMIT'; end if;
  if pt.id is not null then
    -- пункт отключали: данные в облаке остались, просто снова открываем
    update public.app_points set revoked_at = null, name = left(coalesce(nullif(btrim(p_name), ''), name), 200),
           last_device_id = coalesce(p_device, last_device_id)
     where id = pt.id;
    return pt.id;
  end if;
  insert into public.app_points(user_id, wb_point_id, name, last_device_id)
    values (p_user, p_wb, left(coalesce(btrim(p_name), ''), 200), p_device)
    returning id into pt.id;
  return pt.id;
end;
$$;

-- ---------- облачный архив пункта ----------

create table if not exists public.app_archive_goods (
  point_id uuid not null references public.app_points(id) on delete cascade,
  uid text not null check (char_length(uid) between 1 and 80),
  sid text not null check (char_length(sid) between 1 and 40),
  status text check (char_length(status) <= 40),
  purpose text check (char_length(purpose) <= 40),
  updated text check (char_length(updated) <= 40),
  -- 1 — запись из пункта (с ячейкой): при равном updated она главнее записи «в пути»
  rank smallint not null default 0,
  data_enc text not null check (char_length(data_enc) <= 16000),
  archived_at timestamptz not null default now(),
  seq bigint not null default nextval('public.app_sync_seq'),
  primary key (point_id, uid)
);
create index if not exists app_archive_goods_seq_idx on public.app_archive_goods(point_id, seq);

create table if not exists public.app_archive_clients (
  point_id uuid not null references public.app_points(id) on delete cascade,
  sid text not null check (char_length(sid) between 1 and 40),
  mobile_enc text check (char_length(mobile_enc) <= 400),
  name_enc text check (char_length(name_enc) <= 800),
  first_seen text not null,
  last_seen text not null,
  seq bigint not null default nextval('public.app_sync_seq'),
  primary key (point_id, sid)
);
create index if not exists app_archive_clients_seq_idx on public.app_archive_clients(point_id, seq);

create table if not exists public.app_archive_reviews (
  point_id uuid not null references public.app_points(id) on delete cascade,
  rid text not null check (char_length(rid) between 1 and 80),
  rated_at text,
  data_enc text not null check (char_length(data_enc) <= 32000),
  seq bigint not null default nextval('public.app_sync_seq'),
  primary key (point_id, rid)
);
create index if not exists app_archive_reviews_seq_idx on public.app_archive_reviews(point_id, seq);

create table if not exists public.app_archive_shk (
  point_id uuid not null references public.app_points(id) on delete cascade,
  code text not null check (char_length(code) between 1 and 80),
  fetched_at text not null,
  data_enc text not null check (char_length(data_enc) <= 64000),
  seq bigint not null default nextval('public.app_sync_seq'),
  primary key (point_id, code)
);
create index if not exists app_archive_shk_seq_idx on public.app_archive_shk(point_id, seq);

-- Приём пачки архива. Ничего не удаляет; старое не перезаписывает новое.
-- Шифрование детерминированное (server/_app-crypto.js): одинаковые данные = одинаковый
-- data_enc, поэтому повтор той же записи не двигает seq и не гоняет данные по кругу.
create or replace function public.app_archive_push(p_point uuid, p_goods jsonb, p_clients jsonb, p_reviews jsonb, p_shk jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare
  changed bigint := 0;
  n bigint;
begin
  insert into public.app_archive_goods as cur (point_id, uid, sid, status, purpose, updated, rank, data_enc)
  select p_point, g->>'uid', g->>'sid', nullif(g->>'status', ''), nullif(g->>'purpose', ''),
         nullif(g->>'updated', ''), coalesce((g->>'rank')::smallint, 0), g->>'data'
    from jsonb_array_elements(coalesce(p_goods, '[]'::jsonb)) g
   where coalesce(g->>'uid', '') <> '' and coalesce(g->>'sid', '') <> '' and coalesce(g->>'data', '') <> ''
  on conflict (point_id, uid) do update
     set sid = excluded.sid, status = excluded.status, purpose = excluded.purpose, updated = excluded.updated,
         rank = excluded.rank, data_enc = excluded.data_enc, seq = nextval('public.app_sync_seq')
   where excluded.data_enc is distinct from cur.data_enc
     and (cur.updated is null
          or excluded.updated > cur.updated
          or (excluded.updated is not distinct from cur.updated and excluded.rank > cur.rank));
  get diagnostics n = row_count; changed := changed + n;

  insert into public.app_archive_clients as cur (point_id, sid, mobile_enc, name_enc, first_seen, last_seen)
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
         seq = nextval('public.app_sync_seq')
   where (excluded.mobile_enc is not null and excluded.mobile_enc is distinct from cur.mobile_enc)
      or (excluded.name_enc is not null and excluded.name_enc is distinct from cur.name_enc)
      or excluded.first_seen < cur.first_seen
      or excluded.last_seen > cur.last_seen;
  get diagnostics n = row_count; changed := changed + n;

  insert into public.app_archive_reviews as cur (point_id, rid, rated_at, data_enc)
  select p_point, r->>'rid', nullif(r->>'rated_at', ''), r->>'data'
    from jsonb_array_elements(coalesce(p_reviews, '[]'::jsonb)) r
   where coalesce(r->>'rid', '') <> '' and coalesce(r->>'data', '') <> ''
  on conflict (point_id, rid) do update
     set rated_at = coalesce(excluded.rated_at, cur.rated_at), data_enc = excluded.data_enc, seq = nextval('public.app_sync_seq')
   where excluded.data_enc is distinct from cur.data_enc;
  get diagnostics n = row_count; changed := changed + n;

  insert into public.app_archive_shk as cur (point_id, code, fetched_at, data_enc)
  select p_point, s->>'code', s->>'fetched_at', s->>'data'
    from jsonb_array_elements(coalesce(p_shk, '[]'::jsonb)) s
   where coalesce(s->>'code', '') <> '' and coalesce(s->>'fetched_at', '') <> '' and coalesce(s->>'data', '') <> ''
  on conflict (point_id, code) do update
     set fetched_at = excluded.fetched_at, data_enc = excluded.data_enc, seq = nextval('public.app_sync_seq')
   where excluded.fetched_at > cur.fetched_at and excluded.data_enc is distinct from cur.data_enc;
  get diagnostics n = row_count; changed := changed + n;

  update public.app_points set last_sync_at = now() where id = p_point;
  return changed;
end;
$$;

-- ---------- зеркало базы WB пункта ----------

create table if not exists public.app_point_rows (
  point_id uuid not null references public.app_points(id) on delete cascade,
  tbl text not null check (tbl ~ '^[a-z_]{1,40}$'),
  pk text not null check (char_length(pk) between 1 and 400),
  -- null = строки больше нет в базе WB (для тех, кто тянет изменения)
  data_enc text check (char_length(data_enc) <= 64000),
  updated_at timestamptz not null default now(),
  seq bigint not null default nextval('public.app_sync_seq'),
  primary key (point_id, tbl, pk)
);
create index if not exists app_point_rows_seq_idx on public.app_point_rows(point_id, seq);
create index if not exists app_point_rows_gone_idx on public.app_point_rows(point_id, updated_at) where data_enc is null;

create or replace function public.app_mirror_push(p_point uuid, p_rows jsonb, p_schema jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare
  n bigint;
  floor_seq bigint;
begin
  if p_schema is not null then
    update public.app_points set mirror_schema = p_schema where id = p_point;
  end if;
  insert into public.app_point_rows as cur (point_id, tbl, pk, data_enc)
  select p_point, r->>'t', r->>'k', nullif(r->>'d', '')
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
   where coalesce(r->>'t', '') <> '' and coalesce(r->>'k', '') <> ''
  on conflict (point_id, tbl, pk) do update
     set data_enc = excluded.data_enc, updated_at = now(), seq = nextval('public.app_sync_seq')
   where excluded.data_enc is distinct from cur.data_enc;
  get diagnostics n = row_count;
  -- удалённые строки помним 3 дня; кто не заходил дольше — перекачает зеркало целиком
  select max(seq) into floor_seq from public.app_point_rows
   where point_id = p_point and data_enc is null and updated_at < now() - interval '3 days';
  if floor_seq is not null then
    delete from public.app_point_rows
     where point_id = p_point and data_enc is null and updated_at < now() - interval '3 days';
    update public.app_points set mirror_floor = greatest(mirror_floor, floor_seq) where id = p_point;
  end if;
  update public.app_points set mirror_at = now() where id = p_point;
  return n;
end;
$$;

-- ---------- документы и секреты аккаунта ----------

create table if not exists public.app_docs (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 'account' или id пункта (app_points.id)
  scope text not null check (scope = 'account' or scope ~ '^[0-9a-f-]{36}$'),
  key text not null check (key ~ '^[a-z_]{1,40}$'),
  secret boolean not null default false,
  version integer not null default 1,
  data_enc text not null check (char_length(data_enc) <= 3000000),
  device_id uuid references public.app_devices(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, scope, key)
);

create table if not exists public.app_docs_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null,
  key text not null,
  version integer not null,
  data_enc text not null,
  device_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists app_docs_history_idx on public.app_docs_history(user_id, scope, key, version desc);

create or replace function public.app_doc_put(p_user uuid, p_scope text, p_key text, p_base integer, p_data text, p_secret boolean, p_device uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare
  cur public.app_docs;
begin
  perform pg_advisory_xact_lock(hashtext('app_docs:' || p_user::text || ':' || p_scope || ':' || p_key));
  select * into cur from public.app_docs where user_id = p_user and scope = p_scope and key = p_key for update;
  if cur.user_id is null then
    if coalesce(p_base, 0) <> 0 then raise exception 'VERSION_CONFLICT'; end if;
    insert into public.app_docs(user_id, scope, key, secret, version, data_enc, device_id)
      values (p_user, p_scope, p_key, coalesce(p_secret, false), 1, p_data, p_device);
    return 1;
  end if;
  if cur.version <> coalesce(p_base, -1) then raise exception 'VERSION_CONFLICT'; end if;
  if cur.data_enc = p_data then return cur.version; end if;
  -- секреты в историю не пишем: старый токен не должен жить дольше, чем нужен
  if not cur.secret then
    insert into public.app_docs_history(user_id, scope, key, version, data_enc, device_id)
      values (p_user, p_scope, p_key, cur.version, cur.data_enc, cur.device_id);
    delete from public.app_docs_history
     where user_id = p_user and scope = p_scope and key = p_key
       and version <= cur.version - 20;
  end if;
  update public.app_docs set version = cur.version + 1, data_enc = p_data, device_id = p_device, updated_at = now()
   where user_id = p_user and scope = p_scope and key = p_key;
  return cur.version + 1;
end;
$$;

-- Кто и когда забирал секреты (токены) — показывается в профиле.
create table if not exists public.app_secret_access (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.app_devices(id) on delete set null,
  key text not null,
  action text not null check (action in ('read','write')),
  created_at timestamptz not null default now()
);
create index if not exists app_secret_access_idx on public.app_secret_access(user_id, created_at desc);

-- ---------- регистрация из программы ----------

create table if not exists public.app_signup_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) <= 320),
  poll_secret_hash text not null,
  device_hash text not null check (device_hash ~ '^[a-f0-9]{64}$'),
  device_name text not null default 'Компьютер' check (char_length(device_name) <= 80),
  app_version text not null default '',
  user_id uuid references auth.users(id) on delete cascade,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 day'
);

-- Чистка служебного: просроченные запросы входа/регистрации, журнал секретов старше года,
-- архив старше 365 дней. Вызывается кроном (api/cabinet.js).
create or replace function public.app_sync_maintenance()
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  cut text := to_char(now() - interval '365 days', 'YYYY-MM-DD');
  a bigint; b bigint; c bigint;
begin
  delete from public.app_login_requests where expires_at < now() - interval '1 day';
  delete from public.app_signup_requests where expires_at < now() - interval '1 day';
  delete from public.app_secret_access where created_at < now() - interval '365 days';
  delete from public.app_archive_goods where coalesce(updated, to_char(archived_at, 'YYYY-MM-DD')) < cut;
  get diagnostics a = row_count;
  delete from public.app_archive_clients where last_seen < cut;
  get diagnostics b = row_count;
  delete from public.app_archive_reviews where coalesce(rated_at, '9999') < cut;
  get diagnostics c = row_count;
  delete from public.app_archive_shk where fetched_at < cut;
  return jsonb_build_object('goods', a, 'clients', b, 'reviews', c);
end;
$$;

-- ---------- доступ ----------

alter table public.app_points enable row level security;
alter table public.app_archive_goods enable row level security;
alter table public.app_archive_clients enable row level security;
alter table public.app_archive_reviews enable row level security;
alter table public.app_archive_shk enable row level security;
alter table public.app_point_rows enable row level security;
alter table public.app_docs enable row level security;
alter table public.app_docs_history enable row level security;
alter table public.app_secret_access enable row level security;
alter table public.app_signup_requests enable row level security;
-- политик нет: читать и писать может только сервер (service role)

revoke all on function public.app_register_device(uuid,text,text,text,integer) from public, anon, authenticated;
revoke all on function public.app_register_point(uuid,bigint,text,integer,uuid) from public, anon, authenticated;
revoke all on function public.app_archive_push(uuid,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.app_mirror_push(uuid,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.app_doc_put(uuid,text,text,integer,text,boolean,uuid) from public, anon, authenticated;
revoke all on function public.app_sync_maintenance() from public, anon, authenticated;
grant execute on function public.app_register_device(uuid,text,text,text,integer) to service_role;
grant execute on function public.app_register_point(uuid,bigint,text,integer,uuid) to service_role;
grant execute on function public.app_archive_push(uuid,jsonb,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.app_mirror_push(uuid,jsonb,jsonb) to service_role;
grant execute on function public.app_doc_put(uuid,text,text,integer,text,boolean,uuid) to service_role;
grant execute on function public.app_sync_maintenance() to service_role;
grant usage on sequence public.app_sync_seq to service_role;

commit;
