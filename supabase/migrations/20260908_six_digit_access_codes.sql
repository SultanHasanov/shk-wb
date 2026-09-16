begin;

-- Новые коды снова короткие и удобные для ручного ввода. Уже выданные STK-коды
-- остаются валидными по CHECK из 20260905 и продолжают работать.
create or replace function public.complete_payment_order(p_order_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  order_row public.payment_orders;
  target_row public.sticker_access_codes;
  generated_code text;
  units integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));
  select * into order_row from public.payment_orders
    where id = p_order_id and product_kind = 'stickers' for update;
  if not found then raise exception 'Order not found'; end if;
  if order_row.access_code is not null then return order_row.access_code; end if;

  units := coalesce(order_row.range_quantity, 0) + coalesce(order_row.custom_quantity, 0);
  if units < 1 then raise exception 'Invalid sticker package'; end if;

  if order_row.renewal_target_key is not null then
    if order_row.user_id is null then raise exception 'Renewal requires an account'; end if;
    select * into target_row from public.sticker_access_codes a
      where a.code = btrim(order_row.renewal_target_key)
        and a.owner_user_id = order_row.user_id
        and a.active
      for update;
    if not found then raise exception 'Renewal target is unavailable'; end if;
    update public.sticker_access_codes
       set generation_limit = generation_limit + units
     where id = target_row.id;
    update public.payment_orders set
      access_code = target_row.code,
      status = 'succeeded', paid_at = coalesce(paid_at, now()), updated_at = now()
      where id = p_order_id;
    return target_row.code;
  end if;

  loop
    generated_code := lpad(floor(random() * 1000000)::integer::text, 6, '0');
    begin
      insert into public.sticker_access_codes(code, name, active, generation_limit)
        values (generated_code, 'Пакет генераций ' || p_order_id, true, units);
      exit;
    exception when unique_violation then null;
    end;
  end loop;

  update public.payment_orders set
    access_code = generated_code,
    status = 'succeeded', paid_at = coalesce(paid_at, now()), updated_at = now()
    where id = p_order_id;
  return generated_code;
end;
$$;

revoke all on function public.complete_payment_order(uuid) from public, anon, authenticated;
grant execute on function public.complete_payment_order(uuid) to service_role;

commit;
