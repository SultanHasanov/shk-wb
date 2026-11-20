begin;

-- Предупреждения в чате поддержки (server/_support-chat.js): бот удаляет сообщение, пишет причину в чате
-- и присылает владельцу «кому и за что». Мут и бан — только руками владельца (кнопки в личке, команды в чате).
-- revoked_at — владелец нажал «Ошибка бота»: предупреждение не считается.
create table if not exists public.support_chat_warnings (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  telegram_user_id bigint not null,
  username text,
  name text not null default '',
  rule text not null check (char_length(rule) <= 32),
  reason text not null default '' check (char_length(reason) <= 300),
  excerpt text not null default '' check (char_length(excerpt) <= 600),
  message_id bigint,
  issued_by bigint,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists support_chat_warnings_user_idx
  on public.support_chat_warnings(telegram_user_id, created_at desc);
create index if not exists support_chat_warnings_recent_idx
  on public.support_chat_warnings(created_at desc);

alter table public.support_chat_warnings enable row level security;
revoke all on table public.support_chat_warnings from public, anon, authenticated;
grant select, insert, update, delete on table public.support_chat_warnings to service_role;

commit;
