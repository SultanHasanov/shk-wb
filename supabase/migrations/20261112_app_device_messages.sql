-- Сообщения владельца на конкретный ПК (кабинет → «Сообщения на ПК», 05.11.2026). ПК забирает их
-- в relay-inbox (по ключу устройства — и без входа), показывает окно поверх всего, отвечает кнопкой
-- или текстом (messages-ack). Не доставленное за 3 дня — expired; старше 30 дней убирает крон кабинета.
create table if not exists public.app_device_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  device_id uuid not null references public.app_devices(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 500),
  created_by text not null default 'owner' check (created_by in ('owner')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 days',
  delivered_at timestamptz,
  read_at timestamptz,
  answered_at timestamptz,
  answer_kind text check (answer_kind is null or answer_kind in ('ok','done','cannot','closed','reply')),
  reply_text text check (reply_text is null or char_length(reply_text) <= 500)
);
create index if not exists app_device_messages_device_open_idx
  on public.app_device_messages(device_id, created_at) where read_at is null;
create index if not exists app_device_messages_user_idx
  on public.app_device_messages(user_id, created_at desc);
alter table public.app_device_messages enable row level security;
revoke all on public.app_device_messages from anon, authenticated;

-- Уведомление кабинета «ответ с ПК».
alter table public.in_app_notifications drop constraint if exists in_app_notifications_kind_check;
alter table public.in_app_notifications add constraint in_app_notifications_kind_check
  check (kind in ('order','key_expiry','low_balance','product_news','system','pc_reply'));
