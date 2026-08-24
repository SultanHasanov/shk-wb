begin;
alter table if exists public.payment_orders alter column email drop not null;
commit;
