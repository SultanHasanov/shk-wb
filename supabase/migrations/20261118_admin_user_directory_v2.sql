begin;

-- Директория пользователей v2 (база — 20260909): все прежние колонки в прежнем порядке + баланс,
-- тариф и срок, ПК, пункты, последний сеанс ПК, ограничение и безлимит; total_count остаётся последней.
-- Тип результата меняется, поэтому функция пересоздаётся drop + create в одной транзакции вместе с правами:
-- окна без функции (и без revoke) снаружи не видно.
--
-- Порядок запроса важен для трафика и скорости:
--   base     — по всем строкам только дешёвые поля, нужные фильтру и сортировке;
--   filtered — поиск и фильтр, total_count считается здесь;
--   page     — одна страница;
--   итог     — тяжёлые поля (подписка, пакеты, бонусы, ПК, пункты, ограничение) только для строк страницы.
-- p_sort и p_filter разбираются через case по белому списку: динамический SQL тут был бы инъекцией.
--
-- ВАЖНО: функция читает auth.users — право снимается со всех и выдаётся только service_role (ниже).

drop function if exists public.admin_user_directory(text, integer, integer, text, text);

create function public.admin_user_directory(
  p_search text default '',
  p_limit integer default 25,
  p_offset integer default 0,
  p_sort text default 'created_at',
  p_filter text default 'all'
)
returns table (
  user_id uuid,
  email text,
  email_confirmed boolean,
  telegram_only boolean,
  banned boolean,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  display_name text,
  phone text,
  payer_status text,
  telegram_username text,
  codes_count integer,
  generation_limit bigint,
  generation_used bigint,
  program_keys integer,
  cell_licenses integer,
  cell_active integer,
  orders_paid integer,
  revenue_kopecks bigint,
  refunded_kopecks bigint,
  last_order_at timestamptz,
  referral_code text,
  referral_earned bigint,
  referral_available bigint,
  invited_count integer,
  wallet_kopecks bigint,
  app_plan text,
  app_ends_at timestamptz,
  app_paid_until timestamptz,
  app_device_limit integer,
  app_addons jsonb,
  device_bonus integer,
  points_bonus integer,
  mirror_bonus integer,
  devices_count integer,
  points_count integer,
  last_seen_at timestamptz,
  restricted boolean,
  restriction_scopes text[],
  restriction_until timestamptz,
  unlimited boolean,
  unlimited_until timestamptz,
  total_count bigint
)
language sql
stable
security definer
set search_path=public,auth
as $$
  with needle as (
    select nullif(btrim(coalesce(p_search, '')), '') as q
  ),
  base as (
    select
      u.id,
      u.email::text as email,
      u.email_confirmed_at is not null as email_confirmed,
      coalesce(u.email, '') like '%@users.invalid' as telegram_only,
      coalesce(u.banned_until, to_timestamp(0)) > now() as banned,
      u.banned_until,
      u.created_at,
      u.last_sign_in_at,
      p.display_name::text as display_name,
      p.phone::text as phone,
      p.payer_status::text as payer_status,
      t.username::text as telegram_username,
      r.referral_code::text as referral_code,
      coalesce(r.earned_kopecks, 0)::bigint as referral_earned,
      coalesce(r.available_kopecks, 0)::bigint as referral_available,
      s.codes_count, s.generation_limit, s.generation_used,
      k.program_keys,
      c.cell_licenses, c.cell_active,
      o.orders_paid, o.revenue_kopecks, o.refunded_kopecks, o.last_order_at,
      i.invited_count,
      -- дешёвые поля для фильтра и сортировки
      coalesce(w.balance_kopecks, 0)::bigint as wallet_kopecks,
      sp.paid_until as app_paid_until,
      coalesce(sp.is_subscribed, false) as is_subscribed,
      (exists (select 1 from public.user_restrictions ur
                where ur.user_id = u.id and ur.lifted_at is null and (ur.until is null or ur.until > now()))
       or coalesce(u.banned_until, to_timestamp(0)) > now()) as is_restricted,
      exists (select 1 from public.user_overrides uo
               where uo.user_id = u.id and uo.unlimited and (uo.unlimited_until is null or uo.unlimited_until > now())) as is_unlimited,
      t.user_id is not null as has_telegram
    from auth.users u
    left join public.user_profiles p on p.user_id = u.id
    left join public.user_telegram_identities t on t.user_id = u.id
    left join public.referral_accounts r on r.user_id = u.id
    left join public.wallet_accounts w on w.user_id = u.id
    left join lateral (
      select count(*)::integer as codes_count,
             coalesce(sum(a.generation_limit), 0)::bigint as generation_limit,
             coalesce(sum(a.generation_used), 0)::bigint as generation_used
        from public.sticker_access_codes a where a.owner_user_id = u.id
    ) s on true
    left join lateral (
      select count(*)::integer as program_keys
        from public.license_keys a where a.owner_user_id = u.id
    ) k on true
    left join lateral (
      select count(*)::integer as cell_licenses,
             count(*) filter (where a.active and (a.expires_at is null or a.expires_at > now()))::integer as cell_active
        from public.cell_print_licenses a where a.owner_user_id = u.id
    ) c on true
    left join lateral (
      select count(*)::integer as orders_paid,
             coalesce(sum(round(a.amount * 100)), 0)::bigint as revenue_kopecks,
             coalesce(sum(a.refunded_kopecks), 0)::bigint as refunded_kopecks,
             max(coalesce(a.paid_at, a.created_at)) as last_order_at
        from public.payment_orders a where a.user_id = u.id and a.status = 'succeeded'
    ) o on true
    left join lateral (
      select count(*)::integer as invited_count
        from public.referral_attributions a where a.referrer_user_id = u.id
    ) i on true
    left join lateral (
      select max(a.ends_at) filter (where a.ends_at > now()) as paid_until,
             bool_or(a.starts_at <= now() and a.ends_at > now()) as is_subscribed
        from public.app_subscriptions a where a.user_id = u.id and not a.canceled
    ) sp on true
  ),
  filtered as (
    select b.*, count(*) over ()::bigint as total_count
      from base b, needle n
     where (
       n.q is null
       or b.email ilike '%' || n.q || '%'
       or coalesce(b.display_name, '') ilike '%' || n.q || '%'
       or coalesce(b.phone, '') ilike '%' || n.q || '%'
       or coalesce(b.telegram_username, '') ilike '%' || n.q || '%'
       or coalesce(b.referral_code, '') ilike '%' || n.q || '%'
       or b.id::text = n.q
       or exists (select 1 from public.sticker_access_codes a where a.owner_user_id = b.id and a.code ilike '%' || n.q || '%')
       or exists (select 1 from public.license_keys a where a.owner_user_id = b.id and a.key ilike '%' || n.q || '%')
       or exists (select 1 from public.cell_print_licenses a where a.owner_user_id = b.id and a.key ilike '%' || n.q || '%')
     )
     and case coalesce(p_filter, 'all')
       when 'paying' then b.orders_paid > 0
       when 'free' then b.orders_paid = 0
       when 'telegram' then b.has_telegram
       when 'banned' then b.banned
       when 'inactive' then b.last_sign_in_at is null or b.last_sign_in_at < now() - interval '30 days'
       when 'subscribed' then b.is_subscribed
       when 'expiring' then b.is_subscribed and b.app_paid_until <= now() + interval '7 days'
       when 'unlimited' then b.is_unlimited
       when 'restricted' then b.is_restricted
       else true
     end
  ),
  page as (
    -- Номер строки по выбранной сортировке: им же упорядочен итог (порядок CTE после join не гарантирован).
    select f.*,
           row_number() over (order by
             case when coalesce(p_sort, 'created_at') = 'created_at' then f.created_at end desc nulls last,
             case when p_sort = 'last_sign_in_at' then f.last_sign_in_at end desc nulls last,
             case when p_sort = 'revenue' then f.revenue_kopecks end desc nulls last,
             case when p_sort = 'generation_used' then f.generation_used end desc nulls last,
             case when p_sort = 'balance' then f.wallet_kopecks end desc nulls last,
             case when p_sort = 'expiring' then f.app_paid_until end asc nulls last,
             f.created_at desc,
             f.id
           ) as rn
      from filtered f
     order by rn
     limit greatest(1, least(coalesce(p_limit, 25), 100))
    offset greatest(0, coalesce(p_offset, 0))
  )
  select
    pg.id, pg.email, pg.email_confirmed, pg.telegram_only, pg.banned, pg.created_at, pg.last_sign_in_at,
    pg.display_name, pg.phone, pg.payer_status, pg.telegram_username,
    pg.codes_count, pg.generation_limit, pg.generation_used,
    pg.program_keys, pg.cell_licenses, pg.cell_active,
    pg.orders_paid, pg.revenue_kopecks, pg.refunded_kopecks, pg.last_order_at,
    pg.referral_code, pg.referral_earned, pg.referral_available, pg.invited_count,
    pg.wallet_kopecks,
    cs.plan::text as app_plan,
    cs.ends_at as app_ends_at,
    pg.app_paid_until,
    cs.device_limit::integer as app_device_limit,
    coalesce(ad.addons, '{}'::jsonb) as app_addons,
    -- как в app_entitlements: места действуют до slots_until, старая надбавка ПК — через greatest
    greatest(coalesce(lb.devices, 0),
             case when ov.user_id is not null and (ov.slots_until is null or ov.slots_until > now())
                  then ov.devices_bonus else 0 end)::integer as device_bonus,
    (case when ov.user_id is not null and (ov.slots_until is null or ov.slots_until > now())
          then ov.points_bonus else 0 end)::integer as points_bonus,
    (case when ov.user_id is not null and (ov.slots_until is null or ov.slots_until > now())
          then ov.mirror_bonus else 0 end)::integer as mirror_bonus,
    coalesce(dv.devices_count, 0)::integer as devices_count,
    coalesce(pt.points_count, 0)::integer as points_count,
    dv.last_seen_at,
    pg.is_restricted as restricted,
    case when rs.id is not null then rs.scopes
         when pg.banned then array['all']::text[]
         else null::text[] end as restriction_scopes,
    -- старый GoTrue-бан без строки: бессрочный (876000h) показываем как «навсегда»
    case when rs.id is not null then rs.until
         when pg.banned then case when pg.banned_until > now() + interval '50 years' then null else pg.banned_until end
         else null end as restriction_until,
    pg.is_unlimited as unlimited,
    case when pg.is_unlimited then ov.unlimited_until else null end as unlimited_until,
    pg.total_count
  from page pg
  left join public.user_overrides ov on ov.user_id = pg.id
  left join public.app_device_bonuses lb on lb.user_id = pg.id
  left join lateral (
    select cur.plan, cur.ends_at, cur.device_limit
      from public.app_current_subscription(pg.id) cur
     where cur.id is not null
  ) cs on true
  left join lateral (
    select jsonb_object_agg(x.addon, jsonb_build_object('ends_at', x.ends_at)) as addons
      from (select a.addon, max(a.ends_at) as ends_at from public.app_addons a
             where a.user_id = pg.id and not a.canceled and a.starts_at <= now() and a.ends_at > now()
             group by a.addon) x
  ) ad on true
  left join lateral (
    select count(*) filter (where d.revoked_at is null)::integer as devices_count,
           max(d.last_seen_at) as last_seen_at
      from public.app_devices d where d.user_id = pg.id
  ) dv on true
  left join lateral (
    select count(*)::integer as points_count
      from public.app_points a where a.user_id = pg.id and a.revoked_at is null
  ) pt on true
  left join lateral (
    select ur.id, ur.scopes, ur.until
      from public.user_restrictions ur
     where ur.user_id = pg.id and ur.lifted_at is null and (ur.until is null or ur.until > now())
     order by ur.created_at desc
     limit 1
  ) rs on true
  order by pg.rn;
$$;

revoke all on function public.admin_user_directory(text, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.admin_user_directory(text, integer, integer, text, text) to service_role;

-- Счётчики для чипов фильтра в списке пользователей — те же определения, что у фильтров директории.
create or replace function public.admin_user_counts()
returns jsonb
language sql
stable
security definer
set search_path=public,auth
as $$
  with b as (
    select
      u.created_at,
      u.last_sign_in_at,
      exists (select 1 from public.payment_orders o where o.user_id = u.id and o.status = 'succeeded') as paying,
      coalesce(sp.is_subscribed, false) as subscribed,
      sp.paid_until,
      (exists (select 1 from public.user_restrictions ur
                where ur.user_id = u.id and ur.lifted_at is null and (ur.until is null or ur.until > now()))
       or coalesce(u.banned_until, to_timestamp(0)) > now()) as restricted,
      exists (select 1 from public.user_overrides uo
               where uo.user_id = u.id and uo.unlimited and (uo.unlimited_until is null or uo.unlimited_until > now())) as unlimited,
      exists (select 1 from public.user_telegram_identities t where t.user_id = u.id) as telegram
    from auth.users u
    left join lateral (
      select max(a.ends_at) filter (where a.ends_at > now()) as paid_until,
             bool_or(a.starts_at <= now() and a.ends_at > now()) as is_subscribed
        from public.app_subscriptions a where a.user_id = u.id and not a.canceled
    ) sp on true
  )
  select jsonb_build_object(
    'all', count(*),
    'paying', count(*) filter (where b.paying),
    'subscribed', count(*) filter (where b.subscribed),
    'expiring', count(*) filter (where b.subscribed and b.paid_until <= now() + interval '7 days'),
    'unlimited', count(*) filter (where b.unlimited),
    'restricted', count(*) filter (where b.restricted),
    'telegram', count(*) filter (where b.telegram),
    'inactive', count(*) filter (where b.last_sign_in_at is null or b.last_sign_in_at < now() - interval '30 days'),
    'new30', count(*) filter (where b.created_at > now() - interval '30 days')
  ) from b;
$$;

revoke all on function public.admin_user_counts() from public, anon, authenticated;
grant execute on function public.admin_user_counts() to service_role;

commit;
