-- A code or license may appear in multiple renewal/top-up orders.
-- Link every eligible order without assigning multiple RETURNING rows to a scalar.
-- Ownership checks and claiming a single order by its unique token stay unchanged.
begin;

create or replace function public.claim_user_asset(p_user_id uuid, p_kind text, p_value text)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare changed integer; linked_order uuid;
begin
  if not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then
    raise exception 'User is not confirmed';
  end if;
  if p_kind='sticker' then
    update public.sticker_access_codes set owner_user_id=p_user_id
      where code=btrim(p_value) and (owner_user_id is null or owner_user_id=p_user_id);
    get diagnostics changed=row_count;
    if changed=0 then
      if exists(select 1 from public.sticker_access_codes where code=btrim(p_value)) then raise exception 'Asset belongs to another user'; end if;
      raise exception 'Asset not found';
    end if;
    update public.payment_orders set user_id=p_user_id
      where access_code=btrim(p_value) and (user_id is null or user_id=p_user_id);
  elsif p_kind='program' then
    update public.license_keys set owner_user_id=p_user_id
      where key=upper(btrim(p_value)) and (owner_user_id is null or owner_user_id=p_user_id);
    get diagnostics changed=row_count;
    if changed=0 then
      if exists(select 1 from public.license_keys where key=upper(btrim(p_value))) then raise exception 'Asset belongs to another user'; end if;
      raise exception 'Asset not found';
    end if;
    update public.payment_orders set user_id=p_user_id
      where program_license_key=upper(btrim(p_value)) and (user_id is null or user_id=p_user_id);
  elsif p_kind='cell_print' then
    update public.cell_print_licenses set owner_user_id=p_user_id
      where key=upper(btrim(p_value)) and (owner_user_id is null or owner_user_id=p_user_id);
    get diagnostics changed=row_count;
    if changed=0 then
      if exists(select 1 from public.cell_print_licenses where key=upper(btrim(p_value))) then raise exception 'Asset belongs to another user'; end if;
      raise exception 'Asset not found';
    end if;
    update public.payment_orders set user_id=p_user_id
      where cell_print_license_key=upper(btrim(p_value)) and (user_id is null or user_id=p_user_id);
  elsif p_kind='order' then
    update public.payment_orders set user_id=p_user_id
      where public_token=p_value and status='succeeded' and (user_id is null or user_id=p_user_id)
      returning id into linked_order;
    get diagnostics changed=row_count;
    if changed=0 then
      if exists(select 1 from public.payment_orders where public_token=p_value and user_id is distinct from p_user_id) then raise exception 'Asset belongs to another user'; end if;
      raise exception 'Order not found';
    end if;
    update public.sticker_access_codes a set owner_user_id=p_user_id from public.payment_orders o
      where o.id=linked_order and a.code=o.access_code and (a.owner_user_id is null or a.owner_user_id=p_user_id);
    update public.license_keys a set owner_user_id=p_user_id from public.payment_orders o
      where o.id=linked_order and a.key=o.program_license_key and (a.owner_user_id is null or a.owner_user_id=p_user_id);
    update public.cell_print_licenses a set owner_user_id=p_user_id from public.payment_orders o
      where o.id=linked_order and a.key=o.cell_print_license_key and (a.owner_user_id is null or a.owner_user_id=p_user_id);
  else raise exception 'Invalid asset kind';
  end if;
  return jsonb_build_object('claimed',true,'kind',p_kind);
end;$$;
revoke all on function public.claim_user_asset(uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_user_asset(uuid,text,text) to service_role;


commit;
