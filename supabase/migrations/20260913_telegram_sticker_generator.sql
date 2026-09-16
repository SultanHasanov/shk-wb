begin;

-- Отзывы и WB-сессии больше не используются. Удаление намеренно стирает
-- зашифрованные токены старого бота, но сохраняет журнал update_id.
drop table if exists public.telegram_wb_connections;

create table if not exists public.telegram_generator_sessions (
  telegram_user_id bigint primary key,
  chat_id bigint not null,
  user_id uuid references auth.users(id) on delete cascade,
  state text not null check (state in (
    'choose_kind', 'choose_mode', 'await_prefix', 'await_quantity',
    'await_code', 'confirm', 'generating'
  )),
  draft jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_generation_requests (
  request_id text primary key,
  telegram_user_id bigint not null,
  chat_id bigint not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('processing', 'completed', 'failed')),
  draft jsonb not null default '{}'::jsonb,
  result jsonb,
  error text check (error is null or char_length(error) <= 500),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists telegram_generator_sessions_updated_idx
  on public.telegram_generator_sessions(updated_at);
create index if not exists telegram_generation_requests_user_idx
  on public.telegram_generation_requests(telegram_user_id, created_at desc);

alter table public.telegram_generator_sessions enable row level security;
alter table public.telegram_generation_requests enable row level security;
revoke all on table public.telegram_generator_sessions, public.telegram_generation_requests
  from public, anon, authenticated;
grant select, insert, update, delete on table public.telegram_generator_sessions, public.telegram_generation_requests
  to service_role;

commit;
