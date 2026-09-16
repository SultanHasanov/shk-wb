begin;

alter table public.payment_orders
  add column if not exists renewal_target_key text,
  add column if not exists license_fulfilled_at timestamptz;

alter table public.payment_orders
  drop constraint if exists payment_orders_renewal_target_kind_check;
alter table public.payment_orders
  add constraint payment_orders_renewal_target_kind_check check (
    renewal_target_key is null
    or product_kind in ('program_license', 'cell_print_license')
  );

-- Один ключ «Подбора кодов» теперь может фигурировать в нескольких заказах:
-- первый заказ создаёт его, последующие пополняют тот же ключ.
alter table public.payment_orders
  drop constraint if exists payment_orders_program_license_key_key;
create index if not exists payment_orders_program_license_key_idx
  on public.payment_orders(program_license_key)
  where program_license_key is not null;
create index if not exists payment_orders_renewal_target_key_idx
  on public.payment_orders(renewal_target_key)
  where renewal_target_key is not null;

-- Старые заказы уже выдали ключи до появления явного маркера исполнения.
-- Backfill не даёт повторному старому webhook выдать доступ второй раз.
update public.payment_orders
  set license_fulfilled_at=coalesce(paid_at,updated_at,now())
  where license_fulfilled_at is null
    and (program_license_key is not null or cell_print_license_key is not null);

create or replace function public.complete_program_license_order(p_order_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare
  order_row public.payment_orders;
  license_row public.license_keys;
  generated_key text;
begin
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));
  select * into order_row from public.payment_orders
    where id=p_order_id and product_kind='program_license' for update;
  if not found then raise exception 'License order not found'; end if;
  if order_row.license_fulfilled_at is not null then
    return order_row.program_license_key;
  end if;
  if order_row.license_iterations not in (1,3,5,10,20) then
    raise exception 'Invalid license package';
  end if;

  if order_row.renewal_target_key is not null then
    if order_row.user_id is null then raise exception 'Renewal requires an account'; end if;
    select * into license_row from public.license_keys
      where key=upper(btrim(order_row.renewal_target_key))
        and owner_user_id=order_row.user_id and active=true
      for update;
    if not found then raise exception 'Renewal target is unavailable'; end if;
    update public.license_keys
      set usage_limit=usage_limit+order_row.license_iterations
      where id=license_row.id
      returning * into license_row;
    update public.payment_orders set
      program_license_key=license_row.key,
      license_fulfilled_at=now(),
      status='succeeded',paid_at=coalesce(paid_at,now()),updated_at=now()
      where id=p_order_id;
    return license_row.key;
  end if;

  loop
    generated_key := 'WBPK-' || upper(substr(md5(random()::text || clock_timestamp()::text),1,4)) || '-' ||
      upper(substr(md5(random()::text || clock_timestamp()::text),1,4)) || '-' ||
      upper(substr(md5(random()::text || clock_timestamp()::text),1,4));
    begin
      insert into public.license_keys(key,usage_limit,used,active,note,owner_user_id)
        values(generated_key,order_row.license_iterations,0,true,'Автопокупка '||p_order_id::text,order_row.user_id);
      exit;
    exception when unique_violation then null;
    end;
  end loop;
  update public.payment_orders set
    program_license_key=generated_key,
    license_fulfilled_at=now(),
    status='succeeded',paid_at=coalesce(paid_at,now()),updated_at=now()
    where id=p_order_id;
  return generated_key;
end;
$$;

create or replace function public.complete_cell_print_order(p_order_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare
  order_row public.payment_orders;
  license_row public.cell_print_licenses;
  generated_key text;
  active_devices integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));
  select * into order_row from public.payment_orders
    where id=p_order_id and product_kind in ('cell_print_program','cell_print_license','cell_print_bundle')
    for update;
  if not found then raise exception 'Order not found'; end if;
  if order_row.license_fulfilled_at is not null then
    return order_row.cell_print_license_key;
  end if;

  if order_row.renewal_target_key is not null then
    if order_row.product_kind<>'cell_print_license' or order_row.user_id is null then
      raise exception 'Invalid renewal order';
    end if;
    select * into license_row from public.cell_print_licenses
      where key=upper(btrim(order_row.renewal_target_key))
        and owner_user_id=order_row.user_id and active=true
      for update;
    if not found then raise exception 'Renewal target is unavailable'; end if;
    select count(*) into active_devices from public.cell_print_activations
      where license_id=license_row.id;
    if active_devices>order_row.cell_print_device_limit then
      raise exception 'Device limit is below active device count';
    end if;
    update public.cell_print_licenses set
      duration_days=duration_days+order_row.cell_print_duration_days,
      device_limit=order_row.cell_print_device_limit,
      expires_at=case
        when activated_at is null then null
        else greatest(coalesce(expires_at,now()),now())+
          make_interval(days=>order_row.cell_print_duration_days)
      end
      where id=license_row.id
      returning * into license_row;
    update public.payment_orders set
      cell_print_license_key=license_row.key,
      license_fulfilled_at=now(),
      status='succeeded',paid_at=coalesce(paid_at,now()),updated_at=now()
      where id=p_order_id;
    return license_row.key;
  end if;

  loop
    generated_key := 'CP-'||upper(substr(md5(random()::text||clock_timestamp()),1,4))||'-'||
      upper(substr(md5(random()::text||clock_timestamp()),1,4))||'-'||
      upper(substr(md5(random()::text||clock_timestamp()),1,4));
    begin
      insert into public.cell_print_licenses(key,duration_days,device_limit,source,note,owner_user_id)
        values(generated_key,order_row.cell_print_duration_days,order_row.cell_print_device_limit,
          'payment','Заказ '||p_order_id,order_row.user_id);
      exit;
    exception when unique_violation then null;
    end;
  end loop;
  update public.payment_orders set
    cell_print_license_key=generated_key,
    license_fulfilled_at=now(),
    status='succeeded',paid_at=coalesce(paid_at,now()),updated_at=now()
    where id=p_order_id;
  return generated_key;
end;
$$;

revoke all on function public.complete_program_license_order(uuid) from public,anon,authenticated;
revoke all on function public.complete_cell_print_order(uuid) from public,anon,authenticated;
grant execute on function public.complete_program_license_order(uuid) to service_role;
grant execute on function public.complete_cell_print_order(uuid) to service_role;

commit;
