begin;

-- Ручные лимиты аккаунта из админки («Админка на максималках», фаза A).
-- Одна строка на пользователя: прибавка или замена месячной квоты кодов, надбавки мест
-- (ПК, пункты, зеркало — с одним общим сроком) и безлимит со сроком.
-- Правки живут отдельно от app_subscriptions: строка подписки — снимок тарифа, и при продлении
-- новая строка получает тарифные лимиты заново, а ручная правка пропала бы.
--
-- «Действует»:
--   коды      — codes_mode is not null and (codes_until is null or codes_until > now());
--   места     — slots_until is null or slots_until > now();
--   безлимит  — unlimited and (unlimited_until is null or unlimited_until > now()).
-- Клиентам таблица не видна: пишет только сервер через app_user_override.

create table if not exists public.user_overrides (
  user_id uuid primary key references auth.users(id) on delete cascade,
  codes_mode text check (codes_mode is null or codes_mode in ('add','set')),
  codes_monthly integer not null default 0 check (codes_monthly between 0 and 100000),
  codes_until timestamptz,
  devices_bonus integer not null default 0 check (devices_bonus between 0 and 20),
  points_bonus  integer not null default 0 check (points_bonus  between 0 and 20),
  mirror_bonus  integer not null default 0 check (mirror_bonus  between 0 and 20),
  slots_until timestamptz,
  unlimited boolean not null default false,
  unlimited_until timestamptz,
  note text check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists user_overrides_unlimited_idx on public.user_overrides(user_id) where unlimited;

alter table public.user_overrides enable row level security;
revoke all on table public.user_overrides from anon, authenticated;
grant select, insert, update, delete on table public.user_overrides to service_role;

-- Перенос постоянной надбавки ПК (20261110). Таблица app_device_bonuses пока остаётся:
-- app_entitlements берёт greatest(...) из обеих на переходный период, сервер удаляет строку
-- app_device_bonuses при первой правке мест из админки. note там без предела длины — обрезаем.
insert into public.user_overrides(user_id, devices_bonus, note, updated_by)
select user_id, devices, left(note, 300), 'migration' from public.app_device_bonuses
on conflict (user_id) do update set devices_bonus = greatest(public.user_overrides.devices_bonus, excluded.devices_bonus);

-- Правка ручных лимитов одним вызовом. Меняются только поля, ключи которых есть в p_patch;
-- {"clear": true} удаляет строку. Возвращает {before, after} — плоские строки для журнала.
create or replace function public.app_user_override(p_user uuid, p_patch jsonb, p_by text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  cur public.user_overrides;
  patch jsonb := coalesce(p_patch, '{}'::jsonb);
  before_row jsonb;
  after_row jsonb;
begin
  if p_user is null then raise exception 'Invalid user'; end if;
  -- Строки может ещё не быть, и for update её не заблокирует: два параллельных вызова
  -- разводим замком по пользователю.
  perform pg_advisory_xact_lock(hashtext('user_overrides:' || p_user::text));
  select * into cur from public.user_overrides where user_id = p_user for update;
  before_row := case when cur.user_id is not null then to_jsonb(cur) else null end;

  if coalesce((patch->>'clear')::boolean, false) then
    delete from public.user_overrides where user_id = p_user;
    return jsonb_build_object('before', before_row, 'after', null);
  end if;

  insert into public.user_overrides(user_id, updated_by) values (p_user, p_by)
  on conflict (user_id) do nothing;

  update public.user_overrides o set
    codes_mode = case when patch ? 'codes_mode' then nullif(patch->>'codes_mode', '') else o.codes_mode end,
    codes_monthly = case when patch ? 'codes_monthly' then coalesce((patch->>'codes_monthly')::integer, 0) else o.codes_monthly end,
    codes_until = case when patch ? 'codes_until' then nullif(patch->>'codes_until', '')::timestamptz else o.codes_until end,
    devices_bonus = case when patch ? 'devices_bonus' then coalesce((patch->>'devices_bonus')::integer, 0) else o.devices_bonus end,
    points_bonus = case when patch ? 'points_bonus' then coalesce((patch->>'points_bonus')::integer, 0) else o.points_bonus end,
    mirror_bonus = case when patch ? 'mirror_bonus' then coalesce((patch->>'mirror_bonus')::integer, 0) else o.mirror_bonus end,
    slots_until = case when patch ? 'slots_until' then nullif(patch->>'slots_until', '')::timestamptz else o.slots_until end,
    unlimited = case when patch ? 'unlimited' then coalesce((patch->>'unlimited')::boolean, false) else o.unlimited end,
    unlimited_until = case when patch ? 'unlimited_until' then nullif(patch->>'unlimited_until', '')::timestamptz else o.unlimited_until end,
    note = case when patch ? 'note' then nullif(btrim(coalesce(patch->>'note', '')), '') else o.note end,
    updated_at = now(),
    updated_by = p_by
  where o.user_id = p_user
  returning * into cur;

  after_row := to_jsonb(cur);
  return jsonb_build_object('before', before_row, 'after', after_row);
end;
$$;

revoke all on function public.app_user_override(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.app_user_override(uuid, jsonb, text) to service_role;

-- app_entitlements: всё как в 20261110 (все прежние ключи в обеих ветках) + ручные лимиты.
-- Новые ключи в обеих ветках: device_bonus, points_bonus, mirror_bonus, unlimited, unlimited_until,
-- codes_base (тарифная квота кодов без ручных правок), override (строка правок или null).
-- Без подписки с действующей ручной квотой кодов — окно календарного месяца по МСК.
create or replace function public.app_entitlements(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  sub public.app_subscriptions;
  win timestamptz;
  codes_used integer := 0;
  stickers_used integer := 0;
  next_plan text;
  last_end timestamptz;
  packs integer;
  addons jsonb;
  bonus integer;
  ov public.user_overrides;
  unl boolean;
  codes_on boolean;
  slots_on boolean;
  msk_win timestamptz;
  extra jsonb;
begin
  select coalesce(sum(greatest(usage_limit - used, 0)), 0) into packs
    from public.license_keys where owner_user_id = p_user and active;
  select coalesce(jsonb_object_agg(a.addon, jsonb_build_object('ends_at', a.ends_at)), '{}'::jsonb) into addons
    from (select addon, max(ends_at) as ends_at from public.app_addons
           where user_id = p_user and not canceled and starts_at <= now() and ends_at > now()
           group by addon) a;

  -- НЕ `ov := (select * …)`: скалярный подзапрос с несколькими колонками — ошибка.
  select * into ov from public.user_overrides where user_id = p_user;
  unl := coalesce(ov.unlimited and (ov.unlimited_until is null or ov.unlimited_until > now()), false);
  codes_on := coalesce(ov.codes_mode is not null and (ov.codes_until is null or ov.codes_until > now()), false);
  slots_on := coalesce(ov.user_id is not null and (ov.slots_until is null or ov.slots_until > now()), false);
  -- Переходный период: старая надбавка ПК из app_device_bonuses ещё учитывается.
  bonus := greatest(coalesce((select max(devices) from public.app_device_bonuses where user_id = p_user), 0),
                    case when slots_on then ov.devices_bonus else 0 end);

  sub := public.app_current_subscription(p_user);

  extra := jsonb_build_object(
    'device_bonus', bonus,
    'points_bonus', case when slots_on then ov.points_bonus else 0 end,
    'mirror_bonus', case when slots_on then ov.mirror_bonus else 0 end,
    'unlimited', unl,
    'unlimited_until', case when unl then ov.unlimited_until else null end,
    'codes_base', coalesce(sub.codes_per_month, 0),
    'override', case when ov.user_id is null then null else jsonb_build_object(
      'codes_mode', ov.codes_mode,
      'codes_monthly', ov.codes_monthly,
      'codes_until', ov.codes_until,
      'devices_bonus', ov.devices_bonus,
      'points_bonus', ov.points_bonus,
      'mirror_bonus', ov.mirror_bonus,
      'slots_until', ov.slots_until,
      'unlimited', ov.unlimited,
      'unlimited_until', ov.unlimited_until,
      'note', ov.note,
      'updated_at', ov.updated_at) end
  );

  if sub.id is null then
    if codes_on then
      -- Ручная квота без подписки: календарный месяц по Москве.
      msk_win := date_trunc('month', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow';
      select coalesce(sum(amount), 0) into codes_used
        from public.app_usage
       where user_id = p_user and subscription_id is null and kind = 'code' and source = 'quota'
         and created_at >= msk_win;
      return jsonb_build_object('plan', null, 'packs_left', packs, 'device_limit', 1, 'addons', addons,
                                'window_start', msk_win,
                                'window_end', msk_win + interval '1 month',
                                'codes_limit', ov.codes_monthly,
                                'codes_used', codes_used)
             || extra;
    end if;
    return jsonb_build_object('plan', null, 'packs_left', packs, 'device_limit', 1, 'addons', addons) || extra;
  end if;

  win := public.app_window_start(sub.starts_at);
  select coalesce(sum(amount) filter (where kind = 'code'), 0),
         coalesce(sum(amount) filter (where kind = 'sticker'), 0)
    into codes_used, stickers_used
    from public.app_usage
   where subscription_id = sub.id and source = 'quota' and created_at >= win;
  select coalesce(max(generation_used), stickers_used) into stickers_used
    from public.sticker_access_codes where app_subscription_id = sub.id and app_window_start = win;
  select plan into next_plan from public.app_subscriptions
   where user_id = p_user and not canceled and starts_at >= sub.ends_at
   order by starts_at limit 1;
  select max(ends_at) into last_end from public.app_subscriptions
   where user_id = p_user and not canceled and ends_at > now();
  return jsonb_build_object(
    'plan', sub.plan,
    'subscription_id', sub.id,
    'starts_at', sub.starts_at,
    'ends_at', sub.ends_at,
    'paid_until', last_end,
    'next_plan', next_plan,
    'device_limit', sub.device_limit,
    'window_start', win,
    'window_end', win + interval '1 month',
    'codes_limit', case when codes_on and ov.codes_mode = 'add' then sub.codes_per_month + ov.codes_monthly
                        when codes_on and ov.codes_mode = 'set' then ov.codes_monthly
                        else sub.codes_per_month end,
    'codes_used', codes_used,
    'stickers_limit', sub.stickers_per_month,
    'stickers_used', stickers_used,
    'packs_left', packs,
    'addons', addons
  ) || extra;
end;
$$;

revoke all on function public.app_entitlements(uuid) from public, anon, authenticated;
grant execute on function public.app_entitlements(uuid) to service_role;

-- app_consume: как в 20261018 + ручные лимиты.
--   безлимит → {source:'unlimited'}, строка app_usage не пишется;
--   с подпиской — квота окна с учётом ручной правки (add/set);
--   без подписки и с действующей ручной квотой — календарный месяц МСК, строки quota с subscription_id null;
--   дальше пакеты, как было.
-- app_code_once склеивает {'via':'account'} || app_consume(...) — новое source проходит как есть.
create or replace function public.app_consume(p_user uuid, p_device uuid, p_kind text, p_amount integer, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  sub public.app_subscriptions;
  win timestamptz;
  used_now integer;
  pack public.license_keys;
  ov public.user_overrides;
  unl boolean;
  codes_on boolean;
  quota_limit integer;
  msk_win timestamptz;
begin
  if p_kind <> 'code' then raise exception 'UNSUPPORTED_KIND'; end if;
  if p_amount is null or p_amount <> 1 then raise exception 'INVALID_AMOUNT'; end if;
  perform pg_advisory_xact_lock(hashtext('app_consume:' || p_user::text));

  select * into ov from public.user_overrides where user_id = p_user;
  unl := coalesce(ov.unlimited and (ov.unlimited_until is null or ov.unlimited_until > now()), false);
  if unl then
    return jsonb_build_object('source', 'unlimited');
  end if;
  codes_on := coalesce(ov.codes_mode is not null and (ov.codes_until is null or ov.codes_until > now()), false);

  sub := public.app_current_subscription(p_user);
  if sub.id is not null then
    win := public.app_window_start(sub.starts_at);
    quota_limit := case when codes_on and ov.codes_mode = 'add' then sub.codes_per_month + ov.codes_monthly
                        when codes_on and ov.codes_mode = 'set' then ov.codes_monthly
                        else sub.codes_per_month end;
    select coalesce(sum(amount), 0) into used_now from public.app_usage
     where subscription_id = sub.id and kind = 'code' and source = 'quota' and created_at >= win;
    if used_now + p_amount <= quota_limit then
      insert into public.app_usage(user_id, subscription_id, device_id, kind, amount, source, meta)
        values (p_user, sub.id, p_device, p_kind, p_amount, 'quota', coalesce(p_meta, '{}'::jsonb));
      return jsonb_build_object('source', 'quota');
    end if;
  elsif codes_on then
    msk_win := date_trunc('month', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow';
    select coalesce(sum(amount), 0) into used_now from public.app_usage
     where user_id = p_user and subscription_id is null and kind = 'code' and source = 'quota'
       and created_at >= msk_win;
    if used_now + p_amount <= ov.codes_monthly then
      insert into public.app_usage(user_id, subscription_id, device_id, kind, amount, source, meta)
        values (p_user, null, p_device, 'code', 1, 'quota', coalesce(p_meta, '{}'::jsonb));
      return jsonb_build_object('source', 'quota');
    end if;
  end if;

  select * into pack from public.license_keys
   where owner_user_id = p_user and active and used + p_amount <= usage_limit
   order by created_at, id limit 1 for update;
  if pack.id is null then raise exception 'LIMIT_EXCEEDED'; end if;
  update public.license_keys set used = used + p_amount where id = pack.id;
  insert into public.app_usage(user_id, subscription_id, device_id, kind, amount, source, license_key_id, meta)
    values (p_user, sub.id, p_device, p_kind, p_amount, 'pack', pack.id, coalesce(p_meta, '{}'::jsonb));
  return jsonb_build_object('source', 'pack', 'key', pack.key);
end;
$$;

revoke all on function public.app_consume(uuid, uuid, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.app_consume(uuid, uuid, text, integer, jsonb) to service_role;

commit;

-- Перенос env-безлимита (APP_UNLIMITED_USER_IDS). UUID в репозитории неизвестны: ведущий выполняет
-- руками после чтения /srv/shk-wb/.env и .env узла бота, по строке на каждый UUID. Env-безлимит
-- в коде работает до фазы D, поэтому выкладку это не блокирует.
-- insert into public.user_overrides(user_id, unlimited, note, updated_by)
-- values ('<uuid>', true, 'перенос APP_UNLIMITED_USER_IDS', 'migration')
-- on conflict (user_id) do update set unlimited = true;
