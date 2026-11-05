-- Индивидуальное отключение подтверждения кода клиента через Telegram-бот (флаг app_code_via_bot).
-- true у аккаунта → при включённом глобальном флаге код этому аккаунту выдаётся напрямую, как при выключенном.
-- Нужно владельцам без Telegram. Переключается из админки (страница пользователя).
begin;

alter table public.user_profiles
  add column if not exists app_code_via_bot_off boolean not null default false;

commit;
