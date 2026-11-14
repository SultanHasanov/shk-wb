-- QR-коды для анонимных отзывов клиентов пункта (кабинет → «Отзывы клиентов», 15.11.2026).
-- Владелец создаёт QR (feedback_boards), печатает карточку; клиент без входа открывает /o/<slug>,
-- ставит оценку, пишет комментарий, прикладывает до 3 фото (feedback_entries). Владелец получает
-- отзыв в кабинете, в Telegram и на почту. Отзыв анонимный: ни IP, ни User-Agent, ни контактов
-- здесь нет. Фото лежат на диске VPS (FEEDBACK_PHOTO_DIR), в базе — только их идентификаторы.
-- Браузер в таблицы не ходит: всё через сервер с service role (server/_feedback.js).
begin;

create table if not exists public.feedback_boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slug text not null unique check (slug ~ '^[A-Z0-9]{8}$'),
  label text not null default '' check (char_length(label) <= 60),
  place text not null default '' check (char_length(place) <= 80),
  address text not null default '' check (char_length(address) <= 120),
  headline text not null default '' check (char_length(headline) <= 60),
  note text not null default '' check (char_length(note) <= 140),
  design jsonb not null default '{}'::jsonb,
  notify_telegram boolean not null default true,
  notify_email boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists feedback_boards_user_idx on public.feedback_boards(user_id, created_at);
alter table public.feedback_boards enable row level security;
revoke all on public.feedback_boards from anon, authenticated;

create table if not exists public.feedback_entries (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.feedback_boards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  kind text not null check (kind in ('thanks','idea','complaint')),
  comment text not null default '' check (char_length(comment) <= 1000),
  photos jsonb not null default '[]'::jsonb check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 3),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists feedback_entries_user_idx on public.feedback_entries(user_id, created_at desc);
create index if not exists feedback_entries_board_idx on public.feedback_entries(board_id, created_at desc);
create index if not exists feedback_entries_unread_idx on public.feedback_entries(user_id) where read_at is null;
alter table public.feedback_entries enable row level security;
revoke all on public.feedback_entries from anon, authenticated;

-- Уведомление кабинета «новый отзыв клиента».
alter table public.in_app_notifications drop constraint if exists in_app_notifications_kind_check;
alter table public.in_app_notifications add constraint in_app_notifications_kind_check
  check (kind in ('order','key_expiry','low_balance','product_news','system','pc_reply','feedback'));

-- ---------------------------------------------------------------------------------------------
-- Слияние и перепривязка Telegram-аккаунта (20261120_account_merge_full.sql) не знают о QR-отзывах:
-- после merge_telegram_account сервер удаляет технический аккаунт, и его QR с отзывами ушли бы каскадом,
-- а relink_telegram_identity удалил бы «пустой» аккаунт, у которого есть QR. Функции не переписываем
-- целиком (450 строк): прежние версии остаются под именем *_core, поверх — обёртки с теми же
-- сигнатурами. relink_telegram_identity вызывает account_merge_summary по имени — получит обёртку.
-- ---------------------------------------------------------------------------------------------
do $rename$
begin
  if to_regprocedure('public.merge_telegram_account_core(bigint,uuid)') is null then
    alter function public.merge_telegram_account(bigint, uuid) rename to merge_telegram_account_core;
  end if;
  if to_regprocedure('public.account_merge_summary_core(uuid)') is null then
    alter function public.account_merge_summary(uuid) rename to account_merge_summary_core;
  end if;
end;
$rename$;

create or replace function public.account_merge_summary(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  core jsonb;
  boards_n integer := 0;
begin
  core := public.account_merge_summary_core(p_user);
  if core is null then return null; end if;
  select count(*) into boards_n from public.feedback_boards where user_id = p_user;
  return core || jsonb_build_object(
    'feedbackBoards', boards_n,
    'empty', coalesce((core->>'empty')::boolean, false) and boards_n = 0
  );
end;
$$;

create or replace function public.merge_telegram_account(
  p_telegram_user_id bigint,
  p_target_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  source_user_id uuid;
  result jsonb;
begin
  select t.user_id into source_user_id
    from public.user_telegram_identities t
   where t.telegram_user_id = p_telegram_user_id;
  -- Все проверки и перенос остального — прежняя функция; отказ там откатывает и этот перенос.
  result := public.merge_telegram_account_core(p_telegram_user_id, p_target_user_id);
  if source_user_id is not null and source_user_id <> p_target_user_id then
    update public.feedback_boards set user_id = p_target_user_id where user_id = source_user_id;
    update public.feedback_entries set user_id = p_target_user_id where user_id = source_user_id;
  end if;
  return result;
end;
$$;

revoke all on function public.account_merge_summary(uuid) from public, anon, authenticated;
revoke all on function public.merge_telegram_account(bigint, uuid) from public, anon, authenticated;
revoke all on function public.account_merge_summary_core(uuid) from public, anon, authenticated;
revoke all on function public.merge_telegram_account_core(bigint, uuid) from public, anon, authenticated;
grant execute on function public.account_merge_summary(uuid) to service_role;
grant execute on function public.merge_telegram_account(bigint, uuid) to service_role;
grant execute on function public.account_merge_summary_core(uuid) to service_role;
grant execute on function public.merge_telegram_account_core(bigint, uuid) to service_role;

commit;
