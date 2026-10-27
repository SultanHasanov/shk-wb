begin;

-- Оплата каждой генерации привязана к режиму. Это не позволяет купить пачку
-- по оптовой цене и потратить её как 50 одиночных генераций.
create table if not exists public.sticker_generation_discounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  eligible boolean not null default false,
  consumed_at timestamptz,
  source jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.sticker_generation_charges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_key text not null,
  mode text not null check (mode in ('custom','batch')),
  category text not null check (category in ('product','box')),
  quantity integer not null check ((mode='custom' and quantity=1) or (mode='batch' and quantity=50)),
  price_kopecks integer not null check (price_kopecks in (600,750,1600,2000)),
  discount_applied boolean not null default false,
  status text not null default 'reserved' check (status in ('reserved','consumed','completed','refunded')),
  result jsonb,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  completed_at timestamptz,
  unique(user_id, request_key)
);
drop index if exists public.sticker_generation_one_reserved_idx;
create unique index sticker_generation_one_reserved_idx
  on public.sticker_generation_charges(user_id) where status in ('reserved','consumed');
create index if not exists sticker_generation_charges_user_idx
  on public.sticker_generation_charges(user_id, created_at desc);

alter table public.sticker_generation_discounts enable row level security;
alter table public.sticker_generation_charges enable row level security;
drop policy if exists sticker_generation_discounts_own on public.sticker_generation_discounts;
create policy sticker_generation_discounts_own on public.sticker_generation_discounts
  for select to authenticated using (user_id=auth.uid());
drop policy if exists sticker_generation_charges_own on public.sticker_generation_charges;
create policy sticker_generation_charges_own on public.sticker_generation_charges
  for select to authenticated using (user_id=auth.uid());

create or replace function public.reserve_sticker_generation(
  p_user uuid, p_request_key text, p_mode text, p_category text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  existing public.sticker_generation_charges;
  stale public.sticker_generation_charges;
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
      'discountApplied',existing.discount_applied,
      'balanceKopecks',coalesce((select balance_kopecks from public.wallet_accounts where user_id=p_user),0),
      'result',existing.result);
  end if;

  -- После аварийного обрыва до выдачи следующая попытка освобождает резерв.
  select * into stale from public.sticker_generation_charges
   where user_id=p_user and status in ('reserved','consumed') and created_at<now()-interval '5 minutes'
   order by created_at limit 1 for update;
  if found then
    perform public.wallet_move(p_user,stale.price_kopecks,'refund','generation-refund:'||stale.id::text,
      null,jsonb_build_object('reason','stale_generation'));
    update public.sticker_generation_charges set status='refunded',completed_at=now() where id=stale.id;
    if stale.discount_applied then
      update public.sticker_generation_discounts set consumed_at=null where user_id=p_user;
    end if;
  end if;
  if exists(select 1 from public.sticker_generation_charges where user_id=p_user and status in ('reserved','consumed')) then
    return jsonb_build_object('ok',false,'code','BUSY');
  end if;

  select eligible and consumed_at is null into use_discount
    from public.sticker_generation_discounts where user_id=p_user for update;
  use_discount:=coalesce(use_discount,false);
  charge_quantity:=case when p_mode='batch' then 50 else 1 end;
  charge_price:=case when p_mode='batch' then case when use_discount then 1600 else 2000 end
                     else case when use_discount then 600 else 750 end end;

  insert into public.wallet_accounts(user_id) values(p_user) on conflict(user_id) do nothing;
  select balance_kopecks into current_balance from public.wallet_accounts where user_id=p_user for update;
  if current_balance<charge_price then
    return jsonb_build_object('ok',false,'code','INSUFFICIENT','balanceKopecks',current_balance,
      'priceKopecks',charge_price,'discountApplied',use_discount);
  end if;
  update public.wallet_accounts set balance_kopecks=balance_kopecks-charge_price,updated_at=now()
   where user_id=p_user returning balance_kopecks into current_balance;
  insert into public.wallet_ledger(user_id,kind,amount_kopecks,event_key,details)
   values(p_user,'spend',-charge_price,'generation-charge:'||charge_id::text,
     jsonb_build_object('mode',p_mode,'category',p_category,'quantity',charge_quantity,'discountApplied',use_discount));
  insert into public.sticker_generation_charges(id,user_id,request_key,mode,category,quantity,price_kopecks,discount_applied)
   values(charge_id,p_user,p_request_key,p_mode,p_category,charge_quantity,charge_price,use_discount);
  if use_discount then
    update public.sticker_generation_discounts set consumed_at=now() where user_id=p_user;
  end if;
  return jsonb_build_object('ok',true,'duplicate',false,'chargeId',charge_id,'status','reserved',
    'priceKopecks',charge_price,'discountApplied',use_discount,'balanceKopecks',current_balance);
end;$$;

create or replace function public.refund_sticker_generation(p_charge uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.sticker_generation_charges; moved jsonb;
begin
  select * into c from public.sticker_generation_charges where id=p_charge for update;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
  if c.status='refunded' then
    return jsonb_build_object('ok',true,'duplicate',true,
      'balanceKopecks',coalesce((select balance_kopecks from public.wallet_accounts where user_id=c.user_id),0));
  end if;
  if c.status not in ('reserved','consumed') then return jsonb_build_object('ok',false,'code','ALREADY_FINISHED'); end if;
  moved:=public.wallet_move(c.user_id,c.price_kopecks,'refund','generation-refund:'||c.id::text,null,
    jsonb_build_object('reason','generation_failed'));
  update public.sticker_generation_charges set status='refunded',completed_at=now() where id=c.id;
  if c.discount_applied then update public.sticker_generation_discounts set consumed_at=null where user_id=c.user_id; end if;
  return jsonb_build_object('ok',true,'duplicate',false,'balanceKopecks',(moved->>'balance')::bigint);
end;$$;

create or replace function public.consume_sticker_generation_charge(
  p_charge uuid,p_user uuid,p_mode text,p_category text)
returns public.sticker_generation_charges language plpgsql security definer set search_path=public as $$
declare c public.sticker_generation_charges;
begin
  select * into c from public.sticker_generation_charges where id=p_charge for update;
  if not found or c.user_id<>p_user or c.mode<>p_mode or c.category<>p_category or c.status<>'reserved' then
    raise exception 'Invalid or consumed generation charge';
  end if;
  update public.sticker_generation_charges set status='consumed',consumed_at=now() where id=p_charge returning * into c;
  return c;
end;$$;

create or replace function public.finalize_sticker_generation(p_charge uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.sticker_generation_charges;
begin
  select * into c from public.sticker_generation_charges where id=p_charge for update;
  if not found then raise exception 'Generation charge not found'; end if;
  if c.status='completed' then return jsonb_build_object('ok',true,'duplicate',true); end if;
  if c.status<>'consumed' then raise exception 'Generation charge was not consumed'; end if;
  update public.sticker_generation_charges set status='completed',result=p_result,completed_at=now() where id=p_charge;
  return jsonb_build_object('ok',true,'duplicate',false);
end;$$;

create or replace function public.allocate_paid_return_stickers(p_charge uuid,p_user uuid,p_requester_hash text)
returns table(batch_id uuid,code text) language plpgsql security definer set search_path=public as $$
declare new_batch uuid; available_count integer;
begin
  if length(p_requester_hash)<>64 then raise exception 'Invalid allocation request'; end if;
  perform public.consume_sticker_generation_charge(p_charge,p_user,'batch','product');
  perform pg_advisory_xact_lock(hashtext('return_sticker_pool'));
  select count(*) into available_count from(select 1 from public.return_sticker_codes where batch_id is null limit 50)x;
  if available_count<50 then raise exception 'Not enough unused sticker codes'; end if;
  insert into public.return_sticker_batches(quantity,requester_hash,access_code,generation_kind)
    values(50,p_requester_hash,null,'range') returning id into new_batch;
  return query with selected as(select c.code from public.return_sticker_codes c where c.batch_id is null order by c.code limit 50 for update skip locked),
    updated as(update public.return_sticker_codes c set batch_id=new_batch,allocated_at=now() from selected s where c.code=s.code returning c.code)
    select new_batch,updated.code::text from updated order by updated.code;
end;$$;

create or replace function public.allocate_paid_return_box_codes(p_charge uuid,p_user uuid,p_requester_hash text,p_prefix text default 'TRBX')
returns table(batch_id uuid,code text) language plpgsql security definer set search_path=public as $$
declare new_batch uuid; available_count integer; normalized_prefix text:=upper(btrim(coalesce(p_prefix,'TRBX')));
begin
  if length(p_requester_hash)<>64 or normalized_prefix!~'^[A-Z0-9_-]{1,12}$' then raise exception 'Invalid box allocation request'; end if;
  perform public.consume_sticker_generation_charge(p_charge,p_user,'batch','box');
  perform pg_advisory_xact_lock(hashtext('return_box_pool'));
  select count(*) into available_count from(select 1 from public.return_box_codes where batch_id is null limit 50)x;
  if available_count<50 then raise exception 'Not enough unused box codes'; end if;
  insert into public.return_box_batches(quantity,requester_hash,access_code,prefix,generation_kind)
    values(50,p_requester_hash,null,normalized_prefix,'range') returning id into new_batch;
  return query with selected as(select c.code from public.return_box_codes c where c.batch_id is null order by c.code limit 50 for update skip locked),
    updated as(update public.return_box_codes c set batch_id=new_batch,allocated_at=now() from selected s where c.code=s.code returning c.code)
    select new_batch,updated.code::text from updated order by updated.code;
end;$$;

create or replace function public.authorize_paid_custom_sticker(p_charge uuid,p_user uuid,p_requester_hash text,p_category text,p_prefix text default 'TRBX')
returns table(batch_id uuid) language plpgsql security definer set search_path=public as $$
declare new_batch uuid; normalized_prefix text:=upper(btrim(coalesce(p_prefix,'TRBX')));
begin
  if length(p_requester_hash)<>64 or p_category not in('product','box') then raise exception 'Invalid allocation request'; end if;
  if p_category='box' and normalized_prefix!~'^[A-Z0-9_-]{1,12}$' then raise exception 'Invalid box allocation request'; end if;
  perform public.consume_sticker_generation_charge(p_charge,p_user,'custom',p_category);
  if p_category='box' then
    insert into public.return_box_batches(quantity,requester_hash,access_code,prefix,generation_kind)
      values(1,p_requester_hash,null,normalized_prefix,'custom') returning id into new_batch;
  else
    insert into public.return_sticker_batches(quantity,requester_hash,access_code,generation_kind)
      values(1,p_requester_hash,null,'custom') returning id into new_batch;
  end if;
  return query select new_batch;
end;$$;

-- Однократная конвертация оплаченных остатков. На одном коде могли быть
-- покупки и пополнения по разным ценам, поэтому используется их суммарная
-- фактическая стоимость и общая неиспользованная доля.
do $$
declare r record; converted bigint;
begin
  for r in
    with paid as(
      select o.user_id,coalesce(o.renewal_target_key,o.access_code) access_code,
        sum(o.range_quantity+o.custom_quantity)::bigint bought,
        sum(greatest(0,round(coalesce(o.amount,0)*100)::bigint+coalesce(o.wallet_paid_kopecks,0)-coalesce(o.refunded_kopecks,0)))::bigint paid,
        bool_or(o.range_quantity+o.custom_quantity>=100) large
      from public.payment_orders o where o.product_kind='stickers' and o.status='succeeded'
       and o.user_id is not null and coalesce(o.renewal_target_key,o.access_code) is not null
      group by o.user_id,coalesce(o.renewal_target_key,o.access_code)
    ), valued as(
      select p.*,least(p.bought,greatest(0,a.generation_limit-a.generation_used))::bigint remaining
      from paid p join public.sticker_access_codes a on a.code=p.access_code where p.bought>0
    )
    select user_id,sum(bought)::bigint bought,sum(remaining)::bigint remaining,
      sum(round(paid::numeric*remaining/bought))::bigint value,
      bool_or(large) large from valued group by user_id
  loop
    converted:=greatest(0,r.value);
    if converted>0 then
      perform public.wallet_move(r.user_id,converted,'admin','legacy-stickers-conversion:'||r.user_id::text,null,
        jsonb_build_object('reason','legacy_stickers_conversion','bought',r.bought,'remaining',r.remaining));
    end if;
    insert into public.sticker_generation_discounts(user_id,eligible,source)
      values(r.user_id,r.large and r.remaining*2>r.bought,jsonb_build_object('bought',r.bought,'remaining',r.remaining))
      on conflict(user_id) do update set eligible=excluded.eligible,source=excluded.source;
  end loop;
  update public.sticker_access_codes a set generation_used=generation_limit
   where exists(select 1 from public.payment_orders o where o.product_kind='stickers' and o.status='succeeded'
     and coalesce(o.renewal_target_key,o.access_code)=a.code);
end$$;

revoke all on function public.reserve_sticker_generation(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.refund_sticker_generation(uuid) from public,anon,authenticated;
revoke all on function public.consume_sticker_generation_charge(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.finalize_sticker_generation(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.allocate_paid_return_stickers(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.allocate_paid_return_box_codes(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.authorize_paid_custom_sticker(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.reserve_sticker_generation(uuid,text,text,text) to service_role;
grant execute on function public.refund_sticker_generation(uuid) to service_role;
grant execute on function public.consume_sticker_generation_charge(uuid,uuid,text,text) to service_role;
grant execute on function public.finalize_sticker_generation(uuid,jsonb) to service_role;
grant execute on function public.allocate_paid_return_stickers(uuid,uuid,text) to service_role;
grant execute on function public.allocate_paid_return_box_codes(uuid,uuid,text,text) to service_role;
grant execute on function public.authorize_paid_custom_sticker(uuid,uuid,text,text,text) to service_role;

commit;
