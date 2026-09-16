begin;

-- Общий лимитер для serverless-инстансов. Ключи уже хешируются приложением,
-- поэтому IP, email и коды доступа в таблицу в открытом виде не попадают.
create table if not exists public.api_rate_limits (
  scope text not null,
  key_hash text not null,
  window_started_at timestamptz not null,
  hits integer not null check (hits >= 0),
  primary key (scope, key_hash)
);
alter table public.api_rate_limits enable row level security;
revoke all on table public.api_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.api_rate_limits to service_role;

create or replace function public.consume_api_rate_limit(
  p_scope text, p_key_hash text, p_limit integer, p_window_seconds integer
) returns boolean language plpgsql security definer set search_path = public as $$
declare current_hits integer;
begin
  if length(p_scope) not between 1 and 80 or length(p_key_hash) <> 64
     or p_limit not between 1 and 10000 or p_window_seconds not between 1 and 86400 then
    raise exception 'Invalid rate limit request';
  end if;
  insert into public.api_rate_limits(scope,key_hash,window_started_at,hits)
  values(p_scope,p_key_hash,now(),1)
  on conflict(scope,key_hash) do update set
    window_started_at=case when api_rate_limits.window_started_at <= now()-(p_window_seconds||' seconds')::interval then now() else api_rate_limits.window_started_at end,
    hits=case when api_rate_limits.window_started_at <= now()-(p_window_seconds||' seconds')::interval then 1 else api_rate_limits.hits+1 end
  returning hits into current_hits;
  return current_hits <= p_limit;
end; $$;
revoke all on function public.consume_api_rate_limit(text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.consume_api_rate_limit(text,text,integer,integer) to service_role;

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 120),
  email text not null check (length(email) between 3 and 254),
  topic text not null check (length(topic) between 1 and 120),
  message text not null check (length(message) between 20 and 5000),
  status text not null default 'new' check (status in ('new','in_progress','closed')),
  created_at timestamptz not null default now()
);
alter table public.support_requests enable row level security;
revoke all on table public.support_requests from public,anon,authenticated;
grant select,insert,update,delete on table public.support_requests to service_role;

-- Промокод резервируется на заказ и расходуется только после подтверждения
-- оплаты. Неоплаченные попытки больше не съедают usage_limit.
create table if not exists public.cell_print_promo_reservations (
  order_id uuid primary key references public.payment_orders(id) on delete cascade,
  promo_id bigint not null references public.cell_print_promocodes(id),
  consumed_at timestamptz,
  expires_at timestamptz not null default now()+interval '30 minutes',
  created_at timestamptz not null default now()
);
alter table public.cell_print_promo_reservations enable row level security;
revoke all on table public.cell_print_promo_reservations from public,anon,authenticated;
grant select,insert,update,delete on table public.cell_print_promo_reservations to service_role;

create or replace function public.reserve_cell_print_promo(p_order_id uuid,p_code text,p_scope text)
returns integer language plpgsql security definer set search_path=public as $$
declare promo public.cell_print_promocodes; reserved_count integer;
begin
  select * into promo from public.cell_print_promocodes
   where code=upper(btrim(p_code)) and active and (expires_at is null or expires_at>now())
     and (scope='all' or scope=p_scope) for update;
  if not found then raise exception 'Invalid promo'; end if;
  select count(*) into reserved_count from public.cell_print_promo_reservations
   where promo_id=promo.id and consumed_at is null and expires_at>now();
  if promo.used+reserved_count>=promo.usage_limit then raise exception 'Invalid promo'; end if;
  insert into public.cell_print_promo_reservations(order_id,promo_id) values(p_order_id,promo.id)
  on conflict(order_id) do nothing;
  return promo.discount_percent;
end; $$;

create or replace function public.commit_cell_print_promo(p_order_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare reservation public.cell_print_promo_reservations;
begin
  select * into reservation from public.cell_print_promo_reservations where order_id=p_order_id for update;
  if not found or reservation.consumed_at is not null then return; end if;
  update public.cell_print_promocodes set used=used+1 where id=reservation.promo_id;
  update public.cell_print_promo_reservations set consumed_at=now() where order_id=p_order_id;
end; $$;
revoke all on function public.reserve_cell_print_promo(uuid,text,text),public.commit_cell_print_promo(uuid) from public,anon,authenticated;
grant execute on function public.reserve_cell_print_promo(uuid,text,text),public.commit_cell_print_promo(uuid) to service_role;

-- Оплата и выдача результата теперь наблюдаются раздельно: оплаченный заказ с
-- ошибкой RPC остаётся доступен для безопасного повторного исполнения.
alter table public.payment_orders
  add column if not exists provider_status text,
  add column if not exists fulfillment_status text not null default 'pending'
    check (fulfillment_status in ('pending','processing','fulfilled','failed')),
  add column if not exists fulfilled_at timestamptz,
  add column if not exists fulfillment_error text,
  add column if not exists refund_status text not null default 'none'
    check (refund_status in ('none','partial','refunded','manual_review'));

update public.payment_orders set
  provider_status=coalesce(provider_status,status),
  fulfillment_status=case when status='succeeded' then 'fulfilled' else fulfillment_status end,
  fulfilled_at=case when status='succeeded' then coalesce(fulfilled_at,paid_at,updated_at) else fulfilled_at end;

-- Реферал закрепляется только за аккаунтом, созданным после перехода по ссылке.
-- Подписанное время перехода приходит из HttpOnly cookie и дополнительно
-- сверяется с auth.users.created_at.
drop function if exists public.bind_referral(uuid,text);
create or replace function public.bind_referral(p_user_id uuid,p_code text,p_captured_at timestamptz)
returns boolean language plpgsql security definer set search_path=public,auth as $$
declare referrer uuid; registered_at timestamptz;
begin
  select created_at into registered_at from auth.users where id=p_user_id;
  if registered_at is null or p_captured_at is null or p_captured_at>registered_at
     or p_captured_at<now()-interval '30 days' then return false; end if;
  select user_id into referrer from public.referral_accounts where referral_code=upper(btrim(p_code));
  if referrer is null or referrer=p_user_id then return false; end if;
  insert into public.referral_attributions(invited_user_id,referrer_user_id,referral_code)
  values(p_user_id,referrer,upper(btrim(p_code))) on conflict(invited_user_id) do nothing;
  return found;
end; $$;
revoke all on function public.bind_referral(uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.bind_referral(uuid,text,timestamptz) to service_role;

-- Возвращает зависшие резервы реферального баланса у заказов, которые так и не
-- были оплачены. Вызывается существующим cron кабинета.
create or replace function public.release_stale_payment_reservations()
returns integer language plpgsql security definer set search_path=public as $$
declare order_row public.payment_orders; released integer:=0;
begin
  for order_row in select * from public.payment_orders
    where status='pending' and created_at<now()-interval '2 hours' and referral_credit_kopecks>0
    for update skip locked
  loop
    insert into public.referral_ledger(user_id,kind,amount_kopecks,order_id,event_key)
    values(order_row.user_id,'spend_release',order_row.referral_credit_kopecks,order_row.id,'stale-release:'||order_row.id::text)
    on conflict(event_key) do nothing;
    if found then
      update public.referral_accounts set available_kopecks=available_kopecks+order_row.referral_credit_kopecks,
        reserved_kopecks=greatest(0,reserved_kopecks-order_row.referral_credit_kopecks),updated_at=now()
      where user_id=order_row.user_id;
      update public.payment_orders set status='canceled',provider_status=coalesce(provider_status,'canceled'),updated_at=now() where id=order_row.id;
      released:=released+1;
    end if;
  end loop;
  delete from public.cell_print_promo_reservations where consumed_at is null and expires_at<now();
  return released;
end; $$;
revoke all on function public.release_stale_payment_reservations() from public,anon,authenticated;
grant execute on function public.release_stale_payment_reservations() to service_role;

create table if not exists public.entitlement_refund_events (
  event_key text primary key,
  order_id uuid not null references public.payment_orders(id),
  result text not null,
  created_at timestamptz not null default now()
);
alter table public.entitlement_refund_events enable row level security;
revoke all on table public.entitlement_refund_events from public,anon,authenticated;
grant select,insert on table public.entitlement_refund_events to service_role;

create or replace function public.process_order_refund(p_order_id uuid,p_refund_kopecks bigint,p_event_key text)
returns text language plpgsql security definer set search_path=public as $$
declare o public.payment_orders; available_units integer; revoke_units integer; active_devices integer; result text:='manual_review'; existing_result text; refund_already_recorded boolean;
begin
  select e.result into existing_result from public.entitlement_refund_events e where e.event_key=p_event_key;
  if found then return existing_result; end if;
  select * into o from public.payment_orders where id=p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  refund_already_recorded:=exists(select 1 from public.referral_ledger where event_key=p_event_key);
  if not refund_already_recorded then
    update public.payment_orders set refunded_kopecks=refunded_kopecks+p_refund_kopecks where id=o.id returning * into o;
  end if;
  if o.refunded_kopecks<round(o.amount*100)::bigint then
    result:='partial';
  elsif o.product_kind='program' then
    result:='refunded';
  elsif o.product_kind='stickers' then
    select greatest(generation_limit-generation_used,0) into available_units from public.sticker_access_codes where code=o.access_code for update;
    revoke_units:=least(coalesce(available_units,0),coalesce(o.range_quantity,0)+coalesce(o.custom_quantity,0));
    update public.sticker_access_codes set generation_limit=generation_limit-revoke_units,
      active=case when generation_limit-revoke_units=0 then false else active end where code=o.access_code;
    result:=case when revoke_units=coalesce(o.range_quantity,0)+coalesce(o.custom_quantity,0) then 'refunded' else 'manual_review' end;
  elsif o.product_kind='program_license' then
    select greatest(usage_limit-used,0) into available_units from public.license_keys where key=o.program_license_key for update;
    revoke_units:=least(coalesce(available_units,0),coalesce(o.license_iterations,0));
    update public.license_keys set usage_limit=usage_limit-revoke_units,
      active=case when usage_limit-revoke_units=0 then false else active end where key=o.program_license_key;
    result:=case when revoke_units=coalesce(o.license_iterations,0) then 'refunded' else 'manual_review' end;
  elsif o.product_kind in ('cell_print_program','cell_print_license','cell_print_bundle') then
    select count(*) into active_devices from public.cell_print_activations a join public.cell_print_licenses l on l.id=a.license_id where l.key=o.cell_print_license_key;
    if active_devices=0 then
      if o.renewal_target_key is null then
        update public.cell_print_licenses set active=false where key=o.cell_print_license_key;
      else
        update public.cell_print_licenses set duration_days=greatest(0,duration_days-o.cell_print_duration_days),
          expires_at=case when expires_at is null then null else greatest(now(),expires_at-make_interval(days=>o.cell_print_duration_days)) end
        where key=o.cell_print_license_key;
      end if;
      result:='refunded';
    end if;
  end if;
  if result in ('refunded','manual_review') and o.user_id is not null and o.referral_credit_kopecks>0 then
    insert into public.referral_ledger(user_id,kind,amount_kopecks,order_id,event_key)
    values(o.user_id,'spend_release',o.referral_credit_kopecks,o.id,'refund-credit:'||p_event_key)
    on conflict(event_key) do nothing;
    if found then update public.referral_accounts set available_kopecks=available_kopecks+o.referral_credit_kopecks,updated_at=now() where user_id=o.user_id; end if;
  end if;
  update public.payment_orders set refund_status=result,updated_at=now() where id=o.id;
  insert into public.entitlement_refund_events(event_key,order_id,result) values(p_event_key,o.id,result);
  return result;
end; $$;
revoke all on function public.process_order_refund(uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.process_order_refund(uuid,bigint,text) to service_role;

create or replace function public.merge_printed_history_codes(p_user_id uuid,p_entry_id bigint,p_codes text[])
returns text[] language plpgsql security definer set search_path=public as $$
declare merged text[];
begin
  update public.user_generation_history h set printed_codes=(
    select coalesce(array_agg(value order by value),array[]::text[]) from (
      select distinct value from unnest(coalesce(h.printed_codes,array[]::text[])||coalesce(p_codes,array[]::text[])) value limit 500
    ) unique_codes
  ) where h.id=p_entry_id and h.user_id=p_user_id returning h.printed_codes into merged;
  if merged is null then raise exception 'History entry not found'; end if;
  return merged;
end; $$;
revoke all on function public.merge_printed_history_codes(uuid,bigint,text[]) from public,anon,authenticated;
grant execute on function public.merge_printed_history_codes(uuid,bigint,text[]) to service_role;

commit;
