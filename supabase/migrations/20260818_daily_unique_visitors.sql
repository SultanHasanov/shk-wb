begin;

alter table public.daily_analytics
  drop constraint if exists daily_analytics_event_type_check;
alter table public.daily_analytics
  add constraint daily_analytics_event_type_check
  check (event_type in ('site_visit', 'unique_site_visit', 'app_launch'));

create table if not exists public.site_visitor_days (
  day date not null,
  visitor_id text not null,
  created_at timestamptz not null default now(),
  primary key (day, visitor_id)
);

alter table public.site_visitor_days enable row level security;
revoke all on table public.site_visitor_days from anon, authenticated;
grant select, insert, update, delete on table public.site_visitor_days to service_role;

create or replace function public.record_visit(p_visitor_id text)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  new_total bigint;
  visit_day date := (now() at time zone 'Europe/Moscow')::date;
  inserted_rows integer;
begin
  update public.site_stats
     set total_visits = total_visits + 1, updated_at = now()
   where id = 1 returning total_visits into new_total;

  insert into public.site_visitors (visitor_id, visit_count, first_visit, last_visit)
  values (p_visitor_id, 1, now(), now())
  on conflict (visitor_id) do update
    set visit_count = public.site_visitors.visit_count + 1,
        last_visit = now();

  insert into public.daily_analytics (day, event_type, event_count)
  values (visit_day, 'site_visit', 1)
  on conflict (day, event_type) do update
    set event_count = public.daily_analytics.event_count + 1;

  insert into public.site_visitor_days (day, visitor_id)
  values (visit_day, p_visitor_id)
  on conflict (day, visitor_id) do nothing;
  get diagnostics inserted_rows = row_count;

  if inserted_rows = 1 then
    insert into public.daily_analytics (day, event_type, event_count)
    values (visit_day, 'unique_site_visit', 1)
    on conflict (day, event_type) do update
      set event_count = public.daily_analytics.event_count + 1;
  end if;

  return new_total;
end;
$$;

revoke all on function public.record_visit(text) from public, anon, authenticated;
grant execute on function public.record_visit(text) to service_role;

commit;
