begin;

-- Состояния сессии Telegram-бота. 'await_access_code' (ввод кода доступа) бот писал и раньше,
-- но его не было в проверке — сохранение падало с 400. 'await_topup_amount' — ввод своей
-- суммы пополнения баланса (20261023_wallet.sql).
alter table public.telegram_generator_sessions drop constraint if exists telegram_generator_sessions_state_check;
alter table public.telegram_generator_sessions add constraint telegram_generator_sessions_state_check check (state in (
  'choose_kind', 'choose_mode', 'await_prefix', 'await_quantity', 'await_code', 'confirm', 'generating',
  'await_access_code', 'await_topup_amount'
));

commit;
