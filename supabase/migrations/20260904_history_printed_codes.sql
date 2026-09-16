begin;

-- Из пачки в 200 стикеров человек печатает по 10–15 за раз и через день уже не
-- помнит, где остановился. Отмечаем напечатанное на сервере, а не в браузере:
-- история и так заявлена как доступная со всех устройств, отметки должны вести
-- себя так же.
alter table public.user_generation_history
  add column if not exists printed_codes text[] not null default '{}';

commit;
