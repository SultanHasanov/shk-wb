begin;

-- Постоянный список людей, которые открывали личный чат с ботом. Сессии
-- генератора временные и поэтому не подходят ни для статистики, ни для рассылок.
create table if not exists public.telegram_bot_subscribers (
  telegram_user_id bigint primary key,
  chat_id bigint not null,
  username text,
  first_name text not null default '',
  last_name text,
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_broadcast_at timestamptz,
  blocked_at timestamptz
);

create index if not exists telegram_bot_subscribers_available_idx
  on public.telegram_bot_subscribers(activated_at desc)
  where blocked_at is null;

alter table public.telegram_bot_subscribers enable row level security;
revoke all on table public.telegram_bot_subscribers from public, anon, authenticated;
grant select, insert, update, delete on table public.telegram_bot_subscribers to service_role;

-- Уже привязанные Telegram-аккаунты точно общались с ботом. В личном чате
-- chat_id совпадает с telegram_user_id, поэтому их можно безопасно перенести.
insert into public.telegram_bot_subscribers (
  telegram_user_id, chat_id, username, first_name, last_name, activated_at, last_seen_at
)
select
  telegram_user_id, telegram_user_id, username, first_name, last_name, created_at, updated_at
from public.user_telegram_identities
on conflict (telegram_user_id) do nothing;

-- Сохраняем также людей без привязанного кабинета, если у них прямо сейчас
-- осталась сессия генератора. Имя обновится при следующем сообщении боту.
insert into public.telegram_bot_subscribers (
  telegram_user_id, chat_id, first_name, activated_at, last_seen_at
)
select telegram_user_id, chat_id, '', created_at, updated_at
from public.telegram_generator_sessions
on conflict (telegram_user_id) do nothing;

commit;
