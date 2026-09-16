begin;

create table if not exists public.user_telegram_identities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  telegram_user_id bigint not null unique,
  username text,
  first_name text not null default '',
  last_name text,
  photo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_telegram_username_idx
  on public.user_telegram_identities(lower(username)) where username is not null;

alter table public.user_telegram_identities enable row level security;
revoke all on table public.user_telegram_identities from public, anon, authenticated;
grant select, insert, update, delete on table public.user_telegram_identities to service_role;

create table if not exists public.auth_rate_limits (
  limiter_key text primary key,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 1
);

alter table public.auth_rate_limits enable row level security;
revoke all on table public.auth_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.auth_rate_limits to service_role;

create or replace function public.consume_auth_rate_limit(
  p_key text,
  p_limit integer default 20,
  p_window_seconds integer default 60
) returns boolean
language plpgsql security definer set search_path=public as $$
declare current_count integer;
begin
  insert into public.auth_rate_limits(limiter_key, window_started_at, attempt_count)
  values (p_key, now(), 1)
  on conflict (limiter_key) do update set
    window_started_at = case
      when auth_rate_limits.window_started_at < now() - make_interval(secs => p_window_seconds) then now()
      else auth_rate_limits.window_started_at
    end,
    attempt_count = case
      when auth_rate_limits.window_started_at < now() - make_interval(secs => p_window_seconds) then 1
      else auth_rate_limits.attempt_count + 1
    end
  returning attempt_count into current_count;
  return current_count > p_limit;
end;$$;

revoke all on function public.consume_auth_rate_limit(text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_auth_rate_limit(text,integer,integer) to service_role;

commit;
