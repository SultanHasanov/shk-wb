begin;

alter table public.payment_orders drop constraint if exists payment_orders_product_kind_check;
alter table public.payment_orders
  add constraint payment_orders_product_kind_check
  check (product_kind in ('stickers', 'program', 'program_license'));

alter table public.payment_orders drop constraint if exists payment_orders_product_quantity_check;
alter table public.payment_orders
  add constraint payment_orders_product_quantity_check check (
    (product_kind = 'stickers' and range_quantity + custom_quantity > 0)
    or (product_kind in ('program', 'program_license') and range_quantity = 0 and custom_quantity = 0)
  );

alter table public.payment_orders add column if not exists license_iterations integer
  check (license_iterations in (1,3,5,10,20));
alter table public.payment_orders add column if not exists program_license_key text unique
  references public.license_keys(key);

create or replace function public.complete_program_license_order(p_order_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare generated_key text; current_key text; iterations integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));
  select program_license_key, license_iterations into current_key, iterations
    from public.payment_orders where id = p_order_id and product_kind = 'program_license' for update;
  if not found then raise exception 'License order not found'; end if;
  if current_key is not null then return current_key; end if;
  if iterations not in (1,3,5,10,20) then raise exception 'Invalid license package'; end if;
  loop
    generated_key := 'WBPK-' || upper(substr(md5(random()::text || clock_timestamp()::text),1,4)) || '-' ||
      upper(substr(md5(random()::text || clock_timestamp()::text),1,4)) || '-' ||
      upper(substr(md5(random()::text || clock_timestamp()::text),1,4));
    begin
      insert into public.license_keys(key, usage_limit, used, active, note)
      values(generated_key, iterations, 0, true, 'Автопокупка ' || p_order_id::text);
      exit;
    exception when unique_violation then null;
    end;
  end loop;
  update public.payment_orders set program_license_key=generated_key,status='succeeded',
    paid_at=coalesce(paid_at,now()),updated_at=now() where id=p_order_id;
  return generated_key;
end;
$$;
revoke all on function public.complete_program_license_order(uuid) from public, anon, authenticated;
grant execute on function public.complete_program_license_order(uuid) to service_role;

commit;
