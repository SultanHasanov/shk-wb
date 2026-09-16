begin;

create table if not exists public.telegram_wb_connections (
  telegram_user_id bigint primary key,
  chat_id bigint not null,
  username text,
  first_name text not null default '',
  last_name text,
  state text not null default 'idle'
    check (state in ('idle','await_phone','await_code','await_point','ready')),
  encrypted_session text,
  selected_point_id bigint,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_bot_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);

create index if not exists telegram_wb_connections_state_idx
  on public.telegram_wb_connections(state, updated_at desc);
create index if not exists telegram_bot_updates_received_idx
  on public.telegram_bot_updates(received_at);

alter table public.telegram_wb_connections enable row level security;
alter table public.telegram_bot_updates enable row level security;

revoke all on table public.telegram_wb_connections, public.telegram_bot_updates
  from public, anon, authenticated;
grant select, insert, update, delete on table public.telegram_wb_connections, public.telegram_bot_updates
  to service_role;

commit;
