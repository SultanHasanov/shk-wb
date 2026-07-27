begin;

create table if not exists public.daily_analytics (
  day date not null,
  event_type text not null check (event_type in ('site_visit', 'app_launch')),
  event_count bigint not null default 0 check (event_count >= 0),
  primary key (day, event_type)
);

create table if not exists public.app_stats (
  id smallint primary key default 1 check (id = 1),
  total_launches bigint not null default 0 check (total_launches >= 0),
  updated_at timestamptz not null default now()
);

insert into public.app_stats (id, total_launches) values (1, 0)
on conflict (id) do nothing;

alter table public.daily_analytics enable row level security;
alter table public.app_stats enable row level security;
revoke all on table public.daily_analytics from anon, authenticated;
revoke all on table public.app_stats from anon, authenticated;
grant select, insert, update, delete on table public.daily_analytics to service_role;
grant select, insert, update, delete on table public.app_stats to service_role;

create or replace function public.record_visit(p_visitor_id text)
returns bigint language plpgsql security definer set search_path = public as $$
declare new_total bigint;
begin
  update public.site_stats
     set total_visits = total_visits + 1, updated_at = now()
   where id = 1 returning total_visits into new_total;
  insert into public.site_visitors (visitor_id, visit_count, first_visit, last_visit)
  values (p_visitor_id, 1, now(), now())
  on conflict (visitor_id) do update
    set visit_count = public.site_visitors.visit_count + 1, last_visit = now();
  insert into public.daily_analytics (day, event_type, event_count)
  values ((now() at time zone 'Europe/Moscow')::date, 'site_visit', 1)
  on conflict (day, event_type) do update
    set event_count = public.daily_analytics.event_count + 1;
  return new_total;
end;
$$;

create or replace function public.record_app_launch()
returns bigint language plpgsql security definer set search_path = public as $$
declare new_total bigint;
begin
  update public.app_stats
     set total_launches = total_launches + 1, updated_at = now()
   where id = 1 returning total_launches into new_total;
  insert into public.daily_analytics (day, event_type, event_count)
  values ((now() at time zone 'Europe/Moscow')::date, 'app_launch', 1)
  on conflict (day, event_type) do update
    set event_count = public.daily_analytics.event_count + 1;
  return new_total;
end;
$$;

revoke all on function public.record_app_launch() from public, anon, authenticated;
grant execute on function public.record_app_launch() to service_role;

commit;
