begin;

-- Поиск SID клиента в боте (кнопка «Код клиента» → «Найти ID в боте»):
-- 'await_wb_for_search' — ждём вход в кабинет WB, чтобы после него открыть поиск;
-- 'await_client_query'  — ждём номер телефона или ячейки для поиска клиента.
alter table public.telegram_generator_sessions drop constraint if exists telegram_generator_sessions_state_check;
alter table public.telegram_generator_sessions add constraint telegram_generator_sessions_state_check check (state in (
  'choose_kind', 'choose_mode', 'await_prefix', 'await_quantity', 'await_code', 'confirm', 'generating',
  'await_access_code', 'await_topup_amount',
  'await_wb_for_search', 'await_client_query'
));

commit;
