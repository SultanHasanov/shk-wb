begin;

alter table public.payment_orders
  drop constraint if exists payment_orders_range_quantity_check,
  drop constraint if exists payment_orders_custom_quantity_check;

alter table public.payment_orders
  add constraint payment_orders_range_quantity_check
    check (range_quantity between 0 and 500),
  add constraint payment_orders_custom_quantity_check
    check (custom_quantity between 0 and 500);

commit;
