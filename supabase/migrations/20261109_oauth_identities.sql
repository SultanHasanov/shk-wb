-- Вход через Яндекс ID и Mail.ru (api/auth?action=oauth, server/_oauth-login.js).
-- Связка «провайдер + id у провайдера → аккаунт» живёт отдельно от Telegram: почта у провайдера может
-- поменяться, а вход должен остаться. Совпадение по почте используется один раз, при первом входе.
begin;

create table if not exists public.user_oauth_identities (
  provider text not null check (provider in ('yandex', 'mailru')),
  provider_user_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, provider_user_id)
);

create index if not exists user_oauth_identities_user_idx on public.user_oauth_identities(user_id);

alter table public.user_oauth_identities enable row level security;
revoke all on table public.user_oauth_identities from public, anon, authenticated;
grant select, insert, update, delete on table public.user_oauth_identities to service_role;

-- auth.users из схемы public не читается (см. 20260909_admin_user_directory.sql); для сопоставления
-- по почте нужен один id. Только service_role: функция отдаёт существование аккаунта по почте.
create or replace function public.auth_user_id_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select u.id
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
    and u.deleted_at is null
  order by (u.email_confirmed_at is not null) desc, u.created_at
  limit 1;
$$;

revoke all on function public.auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_user_id_by_email(text) to service_role;

commit;
