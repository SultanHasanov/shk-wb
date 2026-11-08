-- Магазин ЮKassa, в котором оплачен заказ. Пусто у заказов основного сайта.
-- Статус платежа и возврат можно проверить только реквизитами того же магазина.
alter table public.payment_orders
  add column if not exists payment_shop text
  check (payment_shop is null or payment_shop in ('pvzprint'));

notify pgrst, 'reload schema';
