-- Пачка товарных стикеров больше 100 штук падала с 502 «Database request failed».
--
-- Лимит 500 подняли ещё в 20260816_sticker_batch_500_no_daily_limit.sql, но
-- только внутри функций выдачи. Check-констрейнт самой таблицы остался таким,
-- каким его завели в 20260811_return_stickers.sql — between 1 and 100. Форма,
-- API и allocate_return_stickers пропускали 150 штук, а вставка строки
-- отбивалась Postgres'ом с кодом 23514, и ошибка доходила до пользователя
-- обезличенной.
--
-- У return_box_batches ограничение изначально написано как between 1 and 500,
-- поэтому коробок это не касалось и здесь не трогается.

alter table public.return_sticker_batches
  drop constraint if exists return_sticker_batches_quantity_check;

alter table public.return_sticker_batches
  add constraint return_sticker_batches_quantity_check
  check (quantity between 1 and 500);
