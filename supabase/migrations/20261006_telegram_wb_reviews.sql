begin;

create table if not exists public.telegram_wb_connections (
  telegram_user_id bigint primary key,
  chat_id bigint not null,
  state text not null default 'idle'
    check (state in ('idle','await_phone','await_code','await_point','ready')),
  encrypted_session text,
  selected_point_id bigint,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_wb_connections_state_idx
  on public.telegram_wb_connections(state, updated_at desc);

alter table public.telegram_wb_connections enable row level security;
revoke all on table public.telegram_wb_connections from public, anon, authenticated;
grant select, insert, update, delete on table public.telegram_wb_connections to service_role;

commit;
