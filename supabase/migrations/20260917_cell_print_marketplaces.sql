-- Separate Wildberries/Ozon entitlements for cell-print licenses.
alter table public.cell_print_licenses
  add column if not exists marketplace_scope text not null default 'legacy_unassigned';

alter table public.cell_print_licenses
  drop constraint if exists cell_print_licenses_marketplace_scope_check;
alter table public.cell_print_licenses
  add constraint cell_print_licenses_marketplace_scope_check
  check (marketplace_scope in ('wb','ozon','both','legacy_unassigned'));

alter table public.payment_orders
  add column if not exists cell_print_marketplace_scope text;
alter table public.payment_orders
  drop constraint if exists payment_orders_cell_print_marketplace_scope_check;
alter table public.payment_orders
  add constraint payment_orders_cell_print_marketplace_scope_check
  check (cell_print_marketplace_scope is null or cell_print_marketplace_scope in ('wb','ozon','both'));

drop function if exists public.activate_cell_print_license(text, text, text);
create or replace function public.activate_cell_print_license(
  p_key text, p_device_hash text, p_legacy_hash text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare lic public.cell_print_licenses; count_devices integer;
begin
  if p_device_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid device'; end if;
  if p_legacy_hash is not null and p_legacy_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid device'; end if;
  select * into lic from public.cell_print_licenses where key=upper(btrim(p_key)) for update;
  if not found or not lic.active then raise exception 'Invalid license'; end if;
  if lic.activated_at is null then
    update public.cell_print_licenses set activated_at=now(),expires_at=now()+make_interval(days=>duration_days)
      where id=lic.id returning * into lic;
  end if;
  if lic.expires_at<=now() then raise exception 'License expired'; end if;
  if exists(select 1 from public.cell_print_activations where license_id=lic.id and device_hash=p_device_hash) then
    update public.cell_print_activations set last_seen_at=now() where license_id=lic.id and device_hash=p_device_hash;
  elsif p_legacy_hash is not null and exists(select 1 from public.cell_print_activations where license_id=lic.id and device_hash=p_legacy_hash) then
    update public.cell_print_activations set device_hash=p_device_hash,last_seen_at=now()
      where license_id=lic.id and device_hash=p_legacy_hash;
  else
    select count(*) into count_devices from public.cell_print_activations where license_id=lic.id;
    if count_devices>=lic.device_limit then raise exception 'Device limit reached'; end if;
    insert into public.cell_print_activations(license_id,device_hash) values(lic.id,p_device_hash);
  end if;
  select count(*) into count_devices from public.cell_print_activations where license_id=lic.id;
  return jsonb_build_object('active',true,'expiresAt',lic.expires_at,'deviceLimit',lic.device_limit,
    'devicesUsed',count_devices,'marketplaceScope',lic.marketplace_scope,'serverTime',now());
end;$$;
revoke all on function public.activate_cell_print_license(text,text,text) from public,anon,authenticated;
grant execute on function public.activate_cell_print_license(text,text,text) to service_role;

-- Recreate checkout completion so newly purchased keys inherit the selected entitlement.
create or replace function public.complete_cell_print_order(p_order_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare o public.payment_orders; lic public.cell_print_licenses; generated text; active_devices integer;
begin
  select * into o from public.payment_orders where id=p_order_id and product_kind in
    ('cell_print_program','cell_print_license','cell_print_bundle') for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status='succeeded' and o.cell_print_license_key is not null then return o.cell_print_license_key; end if;
  if o.renewal_target_key is not null then
    if o.product_kind<>'cell_print_license' or o.user_id is null then raise exception 'Invalid renewal'; end if;
    select * into lic from public.cell_print_licenses where key=o.renewal_target_key and owner_user_id=o.user_id for update;
    if not found then raise exception 'License not found'; end if;
    if o.cell_print_marketplace_scope is not null and o.cell_print_marketplace_scope<>lic.marketplace_scope then raise exception 'License scope mismatch'; end if;
    select count(*) into active_devices from public.cell_print_activations where license_id=lic.id;
    if active_devices>o.cell_print_device_limit then raise exception 'Device limit reached'; end if;
    update public.cell_print_licenses set duration_days=duration_days+o.cell_print_duration_days,
      device_limit=o.cell_print_device_limit,active=true,
      expires_at=case when expires_at is null then null else greatest(now(),expires_at)+make_interval(days=>o.cell_print_duration_days) end
      where id=lic.id returning * into lic;
    generated:=lic.key;
  else
    loop
      generated:='CP-'||upper(substr(md5(random()::text),1,4))||'-'||upper(substr(md5(random()::text),5,4))||'-'||upper(substr(md5(random()::text),9,4));
      begin
        insert into public.cell_print_licenses(key,duration_days,device_limit,marketplace_scope,source,note,owner_user_id)
        values(generated,o.cell_print_duration_days,o.cell_print_device_limit,coalesce(o.cell_print_marketplace_scope,'wb'),'payment','Заказ '||p_order_id,o.user_id);
        exit;
      exception when unique_violation then null; end;
    end loop;
  end if;
  update public.payment_orders set cell_print_license_key=generated,status='succeeded',paid_at=coalesce(paid_at,now()),updated_at=now() where id=p_order_id;
  return generated;
end;$$;
revoke all on function public.complete_cell_print_order(uuid) from public,anon,authenticated;
grant execute on function public.complete_cell_print_order(uuid) to service_role;
