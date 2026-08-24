begin;

alter table public.payment_orders
  add column if not exists product_kind text not null default 'stickers'
  check (product_kind in ('stickers', 'program'));

alter table public.payment_orders drop constraint if exists payment_orders_check;
alter table public.payment_orders
  add constraint payment_orders_product_quantity_check check (
    (product_kind = 'stickers' and range_quantity + custom_quantity > 0)
    or (product_kind = 'program' and range_quantity = 0 and custom_quantity = 0)
  );

commit;
