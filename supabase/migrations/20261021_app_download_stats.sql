begin;

-- Статистика «Помощника ПВЗ» для админки: скачивания установщика, новые компьютеры,
-- активные сегодня/за неделю, оплаты. IP не храним — только хеш с секретом сервера
-- (visitor), чтобы считать уникальных скачавших.

create table if not exists public.app_download_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  visitor text not null check (char_length(visitor) between 8 and 64),
  version text not null default '' check (char_length(version) <= 32),
  source text not null default '' check (char_length(source) <= 40),
  referer_host text not null default '' check (char_length(referer_host) <= 120)
);
create index if not exists app_download_events_time_idx on public.app_download_events(created_at desc);
alter table public.app_download_events enable row level security;

-- Сводка и разбивка по дням (московское время) за p_days дней.
create or replace function public.admin_app_stats(p_days integer default 30)
returns jsonb language sql stable security definer set search_path=public as $$
  with bounds as (
    select (now() at time zone 'Europe/Moscow')::date as today, greatest(1, least(p_days, 365)) as n
  ),
  days as (
    select generate_series(b.today - (b.n - 1), b.today, interval '1 day')::date as d from bounds b
  ),
  dl as (
    select (created_at at time zone 'Europe/Moscow')::date as d, count(*) as n, count(distinct visitor) as u
      from public.app_download_events group by 1
  ),
  dev as (
    select (created_at at time zone 'Europe/Moscow')::date as d, count(*) as n
      from public.app_devices group by 1
  ),
  paid as (
    select (coalesce(paid_at, updated_at, created_at) at time zone 'Europe/Moscow')::date as d, count(*) as n, coalesce(sum(amount), 0) as s
      from public.payment_orders
     where product_kind in ('app_subscription', 'app_addon') and status = 'succeeded'
     group by 1
  ),
  src as (
    select coalesce(nullif(source, ''), nullif(referer_host, ''), 'прямая ссылка') as k, count(*) as n, count(distinct visitor) as u
      from public.app_download_events
     where created_at > now() - make_interval(days => (select n from bounds))
     group by 1 order by 2 desc limit 10
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'downloads', (select count(*) from public.app_download_events),
      'downloadVisitors', (select count(distinct visitor) from public.app_download_events),
      'devices', (select count(*) from public.app_devices),
      'accounts', (select count(distinct user_id) from public.app_devices),
      'active24h', (select count(*) from public.app_devices where revoked_at is null and last_seen_at > now() - interval '1 day'),
      'active7d', (select count(*) from public.app_devices where revoked_at is null and last_seen_at > now() - interval '7 days'),
      'paidUsers', (select count(distinct user_id) from public.app_subscriptions
                     where not canceled and source = 'payment' and ends_at > now()),
      'revenue', (select coalesce(sum(amount), 0) from public.payment_orders
                   where product_kind in ('app_subscription', 'app_addon') and status = 'succeeded'),
      'since', (select min(created_at) from public.app_download_events)
    ),
    'days', (select coalesce(jsonb_agg(jsonb_build_object(
                'day', days.d,
                'downloads', coalesce(dl.n, 0),
                'visitors', coalesce(dl.u, 0),
                'devices', coalesce(dev.n, 0),
                'payments', coalesce(paid.n, 0),
                'revenue', coalesce(paid.s, 0)) order by days.d desc), '[]'::jsonb)
             from days left join dl on dl.d = days.d left join dev on dev.d = days.d left join paid on paid.d = days.d),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('source', k, 'downloads', n, 'visitors', u)), '[]'::jsonb) from src)
  );
$$;

revoke all on function public.admin_app_stats(integer) from public, anon, authenticated;
grant execute on function public.admin_app_stats(integer) to service_role;

commit;
