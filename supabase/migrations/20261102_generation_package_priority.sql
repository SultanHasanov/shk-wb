begin;

-- Новые пакеты привязаны к режиму: поштучный пакет нельзя потратить на
-- дешёвую пачку и наоборот. NULL оставляем для старых кодов — они продолжают
-- работать в обоих режимах, пока пользователь не пополнит такой код.
alter table public.sticker_access_codes
  add column if not exists generation_mode text;
alter table public.sticker_access_codes
  drop constraint if exists sticker_access_codes_generation_mode_check;
alter table public.sticker_access_codes
  add constraint sticker_access_codes_generation_mode_check
  check (generation_mode is null or generation_mode in ('custom','batch'));

alter table public.sticker_generation_charges
  add column if not exists payment_source text not null default 'wallet',
  add column if not exists access_code text references public.sticker_access_codes(code);
alter table public.sticker_generation_charges
  drop constraint if exists sticker_generation_charges_payment_source_check;
alter table public.sticker_generation_charges
  add constraint sticker_generation_charges_payment_source_check
  check (payment_source in ('wallet','package'));
alter table public.sticker_generation_charges
  drop constraint if exists sticker_generation_charges_price_kopecks_check;
alter table public.sticker_generation_charges
  add constraint sticker_generation_charges_price_kopecks_check
  check (price_kopecks >= 0);

create or replace function public.reserve_sticker_generation(
  p_user uuid, p_request_key text, p_mode text, p_category text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  existing public.sticker_generation_charges;
  stale public.sticker_generation_charges;
  package_row public.sticker_access_codes;
  charge_id uuid := gen_random_uuid();
  use_discount boolean := false;
  charge_price integer;
  charge_quantity integer;
  current_balance bigint;
begin
  if p_user is null or length(btrim(coalesce(p_request_key,'')))<1
     or p_mode not in ('custom','batch') or p_category not in ('product','box') then
    raise exception 'Invalid generation charge';
  end if;
  perform pg_advisory_xact_lock(hashtext('sticker-generation:'||p_user::text));

  select * into existing from public.sticker_generation_charges
   where user_id=p_user and request_key=p_request_key;
  if found then
    return jsonb_build_object('ok',true,'duplicate',true,'chargeId',existing.id,
      'status',existing.status,'priceKopecks',existing.price_kopecks,
      'discountApplied',existing.discount_applied,'paymentSource',existing.payment_source,
      'packageCode',existing.access_code,
      'packageRemaining',case when existing.access_code is null then null else
        (select greatest(0,generation_limit-generation_used) from public.sticker_access_codes where code=existing.access_code) end,
      'balanceKopecks',coalesce((select balance_kopecks from public.wallet_accounts where user_id=p_user),0),
      'result',existing.result);
  end if;

  -- Незавершённый резерв старше пяти минут возвращаем в тот же источник.
  select * into stale from public.sticker_generation_charges
   where user_id=p_user and status in ('reserved','consumed') and created_at<now()-interval '5 minutes'
   order by created_at limit 1 for update;
  if found then
    if stale.payment_source='package' and stale.access_code is not null then
      update public.sticker_access_codes
         set generation_used=greatest(0,generation_used-stale.quantity)
       where code=stale.access_code;
    elsif stale.price_kopecks>0 then
      perform public.wallet_move(p_user,stale.price_kopecks,'refund','generation-refund:'||stale.id::text,
        null,jsonb_build_object('reason','stale_generation'));
      if stale.discount_applied then
        update public.sticker_generation_discounts set consumed_at=null where user_id=p_user;
      end if;
    end if;
    update public.sticker_generation_charges set status='refunded',completed_at=now() where id=stale.id;
  end if;
  if exists(select 1 from public.sticker_generation_charges where user_id=p_user and status in ('reserved','consumed')) then
    return jsonb_build_object('ok',false,'code','BUSY');
  end if;

  charge_quantity:=case when p_mode='batch' then 50 else 1 end;

  -- Сначала используем самый маленький подходящий остаток. Код с явно
  -- совпадающим режимом имеет приоритет над совместимым старым кодом.
  select * into package_row from public.sticker_access_codes
   where owner_user_id=p_user and active
     and (generation_mode=p_mode or generation_mode is null)
     and generation_limit-generation_used>=charge_quantity
   order by (generation_mode=p_mode) desc,
            generation_limit-generation_used asc, created_at asc
   limit 1 for update;
  if found then
    update public.sticker_access_codes
       set generation_used=generation_used+charge_quantity
     where id=package_row.id;
    insert into public.sticker_generation_charges(
      id,user_id,request_key,mode,category,quantity,price_kopecks,
      discount_applied,payment_source,access_code)
    values(charge_id,p_user,p_request_key,p_mode,p_category,charge_quantity,0,
      false,'package',package_row.code);
    return jsonb_build_object('ok',true,'duplicate',false,'chargeId',charge_id,
      'status','reserved','priceKopecks',0,'discountApplied',false,
      'paymentSource','package','packageCode',package_row.code,
      'packageRemaining',package_row.generation_limit-package_row.generation_used-charge_quantity,
      'balanceKopecks',coalesce((select balance_kopecks from public.wallet_accounts where user_id=p_user),0));
  end if;

  select eligible and consumed_at is null into use_discount
    from public.sticker_generation_discounts where user_id=p_user for update;
  use_discount:=coalesce(use_discount,false);
  charge_price:=case when p_mode='batch' then case when use_discount then 1600 else 2000 end
                     else case when use_discount then 600 else 750 end end;
  insert into public.wallet_accounts(user_id) values(p_user) on conflict(user_id) do nothing;
  select balance_kopecks into current_balance from public.wallet_accounts where user_id=p_user for update;
  if current_balance<charge_price then
    return jsonb_build_object('ok',false,'code','INSUFFICIENT','balanceKopecks',current_balance,
      'priceKopecks',charge_price,'discountApplied',use_discount,'paymentSource','wallet');
  end if;
  update public.wallet_accounts set balance_kopecks=balance_kopecks-charge_price,updated_at=now()
   where user_id=p_user returning balance_kopecks into current_balance;
  insert into public.wallet_ledger(user_id,kind,amount_kopecks,event_key,details)
   values(p_user,'spend',-charge_price,'generation-charge:'||charge_id::text,
     jsonb_build_object('mode',p_mode,'category',p_category,'quantity',charge_quantity,'discountApplied',use_discount));
  insert into public.sticker_generation_charges(
    id,user_id,request_key,mode,category,quantity,price_kopecks,
    discount_applied,payment_source)
  values(charge_id,p_user,p_request_key,p_mode,p_category,charge_quantity,charge_price,
    use_discount,'wallet');
  if use_discount then
    update public.sticker_generation_discounts set consumed_at=now() where user_id=p_user;
  end if;
  return jsonb_build_object('ok',true,'duplicate',false,'chargeId',charge_id,'status','reserved',
    'priceKopecks',charge_price,'discountApplied',use_discount,'paymentSource','wallet',
    'balanceKopecks',current_balance);
end;$$;

create or replace function public.refund_sticker_generation(p_charge uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.sticker_generation_charges; moved jsonb; current_balance bigint;
begin
  select * into c from public.sticker_generation_charges where id=p_charge for update;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
  if c.status='refunded' then
    return jsonb_build_object('ok',true,'duplicate',true,
      'balanceKopecks',coalesce((select balance_kopecks from public.wallet_accounts where user_id=c.user_id),0));
  end if;
  if c.status not in ('reserved','consumed') then return jsonb_build_object('ok',false,'code','ALREADY_FINISHED'); end if;
  if c.payment_source='package' and c.access_code is not null then
    update public.sticker_access_codes
       set generation_used=greatest(0,generation_used-c.quantity)
     where code=c.access_code;
    current_balance:=coalesce((select balance_kopecks from public.wallet_accounts where user_id=c.user_id),0);
  else
    moved:=public.wallet_move(c.user_id,c.price_kopecks,'refund','generation-refund:'||c.id::text,null,
      jsonb_build_object('reason','generation_failed'));
    current_balance:=(moved->>'balance')::bigint;
    if c.discount_applied then update public.sticker_generation_discounts set consumed_at=null where user_id=c.user_id; end if;
  end if;
  update public.sticker_generation_charges set status='refunded',completed_at=now() where id=c.id;
  return jsonb_build_object('ok',true,'duplicate',false,'paymentSource',c.payment_source,
    'balanceKopecks',current_balance);
end;$$;

-- Выдача и пополнение кодов сохраняют режим покупки.
create or replace function public.complete_payment_order(p_order_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare
  order_row public.payment_orders;
  target_row public.sticker_access_codes;
  generated_code text;
  units integer;
  purchase_mode text;
begin
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));
  select * into order_row from public.payment_orders
    where id=p_order_id and product_kind='stickers' for update;
  if not found then raise exception 'Order not found'; end if;
  if order_row.access_code is not null then return order_row.access_code; end if;
  units:=coalesce(order_row.range_quantity,0)+coalesce(order_row.custom_quantity,0);
  if units<1 then raise exception 'Invalid sticker package'; end if;
  if order_row.custom_quantity>0 and order_row.range_quantity=0 then purchase_mode:='custom';
  elsif order_row.range_quantity>0 and order_row.custom_quantity=0 then purchase_mode:='batch';
  else raise exception 'Mixed sticker package modes are not allowed';
  end if;

  if order_row.renewal_target_key is not null then
    if order_row.user_id is null then raise exception 'Renewal requires an account'; end if;
    select * into target_row from public.sticker_access_codes a
      where a.code=btrim(order_row.renewal_target_key)
        and a.owner_user_id=order_row.user_id and a.active
        and (a.generation_mode=purchase_mode or a.generation_mode is null)
      for update;
    if not found then raise exception 'Renewal target has another generation mode'; end if;
    update public.sticker_access_codes
       set generation_limit=generation_limit+units,
           generation_mode=coalesce(generation_mode,purchase_mode)
     where id=target_row.id;
    update public.payment_orders set access_code=target_row.code,status='succeeded',
      paid_at=coalesce(paid_at,now()),updated_at=now() where id=p_order_id;
    return target_row.code;
  end if;

  loop
    generated_code:=lpad(floor(random()*1000000)::integer::text,6,'0');
    begin
      insert into public.sticker_access_codes(code,name,active,generation_limit,generation_mode,owner_user_id)
      values(generated_code,'Пакет генераций '||p_order_id,true,units,purchase_mode,order_row.user_id);
      exit;
    exception when unique_violation then null;
    end;
  end loop;
  update public.payment_orders set access_code=generated_code,status='succeeded',
    paid_at=coalesce(paid_at,now()),updated_at=now() where id=p_order_id;
  return generated_code;
end;$$;

revoke all on function public.reserve_sticker_generation(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.refund_sticker_generation(uuid) from public,anon,authenticated;
revoke all on function public.complete_payment_order(uuid) from public,anon,authenticated;
grant execute on function public.reserve_sticker_generation(uuid,text,text,text) to service_role;
grant execute on function public.refund_sticker_generation(uuid) to service_role;
grant execute on function public.complete_payment_order(uuid) to service_role;

commit;
