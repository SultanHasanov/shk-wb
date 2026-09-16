begin;

-- Админке нужны сведения о пользователях, а auth.users из схемы public не видна:
-- вьюх над ней нет, RLS закрывает всё. Auth Admin REST отдаёт список постранично
-- и не умеет искать по телефону или коду доступа, поэтому директорию собираем
-- security definer функцией — тем же приёмом, что claim_user_asset в 20260824.
--
-- ВАЖНО: обе функции читают auth.users, поэтому право на них снимается со всех и
-- выдаётся только service_role (в самом низу файла). Без этого функция в public
-- становится публичным доступом к почтам всех пользователей.

create table if not exists public.admin_actions (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  action text not null,
  target_user_id uuid,
  payload jsonb not null default '{}'::jsonb,
  admin_fingerprint text
);
create index if not exists admin_actions_created_idx on public.admin_actions(created_at desc);
create index if not exists admin_actions_user_idx on public.admin_actions(target_user_id, created_at desc);
alter table public.admin_actions enable row level security;
revoke all on table public.admin_actions from anon, authenticated;
grant select, insert, update, delete on table public.admin_actions to service_role;
grant usage, select on sequence public.admin_actions_id_seq to service_role;

create index if not exists payment_orders_user_status_idx on public.payment_orders(user_id, status);
create index if not exists referral_attributions_referrer_idx on public.referral_attributions(referrer_user_id);
create index if not exists user_profiles_phone_idx on public.user_profiles(phone);

-- Пополнение лимита из админки идёт параллельно с генерацией у пользователя.
-- Чтение-с-изменением на стороне Node потеряло бы одно из двух, поэтому прибавка
-- делается одним оператором.
create or replace function public.admin_grant_generations(p_code_id bigint, p_add integer)
returns public.sticker_access_codes
language plpgsql
security definer
set search_path=public
as $$
declare result public.sticker_access_codes;
begin
  if p_add is null or p_add < 1 or p_add > 100000 then
    raise exception 'Invalid generation amount';
  end if;
  update public.sticker_access_codes
     set generation_limit = least(generation_limit + p_add, 1000000)
   where id = p_code_id
  returning * into result;
  if not found then raise exception 'Access code not found'; end if;
  return result;
end;
$$;

-- Директория пользователей: одна страница списка = один запрос.
-- p_sort и p_filter разбираются через case по белому списку: динамический SQL тут
-- был бы инъекцией через админский запрос.
create or replace function public.admin_user_directory(
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
      u.created_at,
      u.last_sign_in_at,
      p.display_name,
      p.phone,
      p.payer_status,
      t.username as telegram_username,
      r.referral_code,
      coalesce(r.earned_kopecks, 0)::bigint as referral_earned,
      coalesce(r.available_kopecks, 0)::bigint as referral_available,
      s.codes_count, s.generation_limit, s.generation_used,
      k.program_keys,
      c.cell_licenses, c.cell_active,
      o.orders_paid, o.revenue_kopecks, o.refunded_kopecks, o.last_order_at,
      i.invited_count
    from auth.users u
    left join public.user_profiles p on p.user_id = u.id
    left join public.user_telegram_identities t on t.user_id = u.id
    left join public.referral_accounts r on r.user_id = u.id
    left join lateral (
      select count(*)::integer as codes_count,
             coalesce(sum(generation_limit), 0)::bigint as generation_limit,
             coalesce(sum(generation_used), 0)::bigint as generation_used
        from public.sticker_access_codes where owner_user_id = u.id
    ) s on true
    left join lateral (
      select count(*)::integer as program_keys
        from public.license_keys where owner_user_id = u.id
    ) k on true
    left join lateral (
      select count(*)::integer as cell_licenses,
             count(*) filter (where active and (expires_at is null or expires_at > now()))::integer as cell_active
        from public.cell_print_licenses where owner_user_id = u.id
    ) c on true
    left join lateral (
      select count(*)::integer as orders_paid,
             coalesce(sum(round(amount * 100)), 0)::bigint as revenue_kopecks,
             coalesce(sum(refunded_kopecks), 0)::bigint as refunded_kopecks,
             max(coalesce(paid_at, created_at)) as last_order_at
        from public.payment_orders where user_id = u.id and status = 'succeeded'
    ) o on true
    left join lateral (
      select count(*)::integer as invited_count
        from public.referral_attributions where referrer_user_id = u.id
    ) i on true
  ),
  filtered as (
    select b.* from base b, needle n
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
      when 'telegram' then b.telegram_only
      when 'banned' then b.banned
      when 'inactive' then b.last_sign_in_at is null or b.last_sign_in_at < now() - interval '30 days'
      else true
    end
  )
  select
    f.id, f.email, f.email_confirmed, f.telegram_only, f.banned, f.created_at, f.last_sign_in_at,
    f.display_name, f.phone, f.payer_status, f.telegram_username,
    f.codes_count, f.generation_limit, f.generation_used,
    f.program_keys, f.cell_licenses, f.cell_active,
    f.orders_paid, f.revenue_kopecks, f.refunded_kopecks, f.last_order_at,
    f.referral_code, f.referral_earned, f.referral_available, f.invited_count,
    count(*) over ()::bigint as total_count
  from filtered f
  order by
    case when coalesce(p_sort, 'created_at') = 'created_at' then f.created_at end desc nulls last,
    case when p_sort = 'last_sign_in_at' then f.last_sign_in_at end desc nulls last,
    case when p_sort = 'revenue' then f.revenue_kopecks end desc nulls last,
    case when p_sort = 'generation_used' then f.generation_used end desc nulls last,
    f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 25), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- Сводка для верхних плиток и графика регистраций.
create or replace function public.admin_user_summary()
returns jsonb
language sql
stable
security definer
set search_path=public,auth
as $$
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'users', count(*),
        'confirmed', count(*) filter (where email_confirmed_at is not null),
        'telegramOnly', count(*) filter (where coalesce(email, '') like '%@users.invalid'),
        'banned', count(*) filter (where coalesce(banned_until, to_timestamp(0)) > now()),
        'new7', count(*) filter (where created_at > now() - interval '7 days'),
        'new30', count(*) filter (where created_at > now() - interval '30 days'),
        'active7', count(*) filter (where last_sign_in_at > now() - interval '7 days'),
        'active30', count(*) filter (where last_sign_in_at > now() - interval '30 days')
      ) from auth.users
    ),
    'registrations', jsonb_build_object(
      'days', coalesce((
        select jsonb_agg(jsonb_build_object('day', d, 'count', c) order by d)
        from (
          select (created_at at time zone 'Europe/Moscow')::date as d, count(*) as c
            from auth.users where created_at > now() - interval '90 days'
           group by 1
        ) x
      ), '[]'::jsonb),
      'weeks', coalesce((
        select jsonb_agg(jsonb_build_object('week', w, 'count', c) order by w)
        from (
          select date_trunc('week', created_at at time zone 'Europe/Moscow')::date as w, count(*) as c
            from auth.users where created_at > now() - interval '52 weeks'
           group by 1
        ) x
      ), '[]'::jsonb)
    ),
    'revenue', (
      -- amount — это касса после списания реферального баланса, gross_amount — цена
      -- до него. Обе величины нужны: первая сходится с ЮKassa, вторая показывает оборот.
      select jsonb_build_object(
        'paidOrders', count(*),
        'payingUsers', count(distinct user_id) filter (where user_id is not null),
        'amountKopecks', coalesce(sum(round(amount * 100)), 0),
        'grossKopecks', coalesce(sum(round(coalesce(gross_amount, amount) * 100)), 0),
        'refundedKopecks', coalesce(sum(refunded_kopecks), 0),
        'referralCreditKopecks', coalesce(sum(referral_credit_kopecks), 0),
        'last30Kopecks', coalesce(sum(round(amount * 100)) filter (where coalesce(paid_at, created_at) > now() - interval '30 days'), 0),
        'byKind', coalesce((
          select jsonb_agg(jsonb_build_object('kind', kind, 'orders', orders, 'amountKopecks', amount_kopecks) order by amount_kopecks desc)
          from (
            select product_kind as kind, count(*) as orders, coalesce(sum(round(amount * 100)), 0) as amount_kopecks
              from public.payment_orders where status = 'succeeded' group by 1
          ) y
        ), '[]'::jsonb)
      ) from public.payment_orders where status = 'succeeded'
    ),
    'generations', (
      select jsonb_build_object(
        'codes', count(*),
        'owned', count(*) filter (where owner_user_id is not null),
        'limit', coalesce(sum(generation_limit), 0),
        'used', coalesce(sum(generation_used), 0)
      ) from public.sticker_access_codes
    ),
    'assets', jsonb_build_object(
      'programKeys', (select count(*) from public.license_keys),
      'cellLicenses', (select count(*) from public.cell_print_licenses),
      'cellActive', (select count(*) from public.cell_print_licenses where active and (expires_at is null or expires_at > now())),
      'cellDevices', (select count(*) from public.cell_print_activations)
    ),
    'referrals', jsonb_build_object(
      'accounts', (select count(*) from public.referral_accounts),
      'attributions', (select count(*) from public.referral_attributions),
      'earnedKopecks', (select coalesce(sum(earned_kopecks), 0) from public.referral_accounts),
      'availableKopecks', (select coalesce(sum(available_kopecks), 0) from public.referral_accounts),
      'paidKopecks', (select coalesce(sum(paid_kopecks), 0) from public.referral_accounts),
      'pendingWithdrawals', (select count(*) from public.referral_withdrawals where status = 'pending')
    )
  );
$$;

revoke all on function public.admin_user_directory(text,integer,integer,text,text) from public, anon, authenticated;
revoke all on function public.admin_user_summary() from public, anon, authenticated;
revoke all on function public.admin_grant_generations(bigint,integer) from public, anon, authenticated;
grant execute on function public.admin_user_directory(text,integer,integer,text,text) to service_role;
grant execute on function public.admin_user_summary() to service_role;
grant execute on function public.admin_grant_generations(bigint,integer) to service_role;

-- Счётчик генераций считал только товарные стикеры. С 20260905 пул общий, и QR
-- коробок тратят его наравне, поэтому публичная цифра занижала результат.
create or replace function public.get_sticker_generation_stats()
returns table(return_stickers bigint, custom_stickers bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    (
      coalesce((select sum(quantity) filter (where generation_kind = 'range') from public.return_sticker_batches), 0)
      + coalesce((select sum(quantity) filter (where generation_kind = 'range') from public.return_box_batches), 0)
    )::bigint,
    (
      coalesce((select sum(quantity) filter (where generation_kind = 'custom') from public.return_sticker_batches), 0)
      + coalesce((select sum(quantity) filter (where generation_kind = 'custom') from public.return_box_batches), 0)
    )::bigint;
$$;

commit;
