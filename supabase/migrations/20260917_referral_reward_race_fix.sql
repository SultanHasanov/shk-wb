begin;

-- A referral can be attached shortly after an already-paid order (for example,
-- when the first authenticated cabinet request arrives after the YooKassa
-- callback). Awarding only from the payment status trigger loses that reward.
-- This helper is idempotent through referral_ledger.event_key and is used from
-- both sides of the race.
create or replace function public.award_referral_order(p_order_id uuid)
returns bigint
language plpgsql
security definer
set search_path=public
as $$
declare
  order_row record;
  referrer uuid;
  reward bigint;
  inserted integer:=0;
begin
  select id,user_id,status,amount,coalesce(refunded_kopecks,0) as refunded_kopecks
    into order_row
    from public.payment_orders
   where id=p_order_id;

  if not found or order_row.status<>'succeeded' or order_row.user_id is null then
    return 0;
  end if;

  -- Serializes an order transition with a concurrent referral attribution.
  perform pg_advisory_xact_lock(hashtext('referral-user:'||order_row.user_id::text));

  select referrer_user_id into referrer
    from public.referral_attributions
   where invited_user_id=order_row.user_id;

  reward:=floor(order_row.amount*100*0.10)::bigint;
  if referrer is null or reward<=0 then return 0; end if;

  perform public.ensure_referral_account(referrer);
  insert into public.referral_ledger(user_id,kind,amount_kopecks,order_id,event_key,details)
  values(referrer,'reward',reward,order_row.id,'order-reward:'||order_row.id::text,
    jsonb_build_object('invitedUserId',order_row.user_id))
  on conflict(event_key) do nothing;
  get diagnostics inserted=row_count;

  if inserted=1 then
    update public.referral_accounts
       set available_kopecks=available_kopecks+greatest(reward-debt_kopecks,0),
           debt_kopecks=greatest(debt_kopecks-reward,0),
           earned_kopecks=earned_kopecks+reward,
           updated_at=now()
     where user_id=referrer;
  end if;

  -- A late attribution can arrive after a partial or complete refund. Record
  -- the matching reversal as well, so the backfill never overstates earnings.
  if order_row.refunded_kopecks>0 then
    perform public.reverse_referral_reward(
      order_row.id,
      order_row.refunded_kopecks,
      'late-referral-refund:'||order_row.id::text
    );
  end if;

  return case when inserted=1 then reward else 0 end;
end;
$$;

revoke all on function public.award_referral_order(uuid) from public,anon,authenticated;

create or replace function public.on_late_referral_attribution()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare order_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('referral-user:'||new.invited_user_id::text));
  for order_id in
    select id from public.payment_orders
     where user_id=new.invited_user_id and status='succeeded'
     order by paid_at nulls last,created_at,id
  loop
    perform public.award_referral_order(order_id);
  end loop;
  return new;
end;
$$;

create or replace function public.on_referral_payment_transition()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  perform public.award_referral_order(new.id);
  return new;
end;
$$;

drop trigger if exists late_referral_attribution_accounting on public.referral_attributions;
create trigger late_referral_attribution_accounting
after insert on public.referral_attributions
for each row execute function public.on_late_referral_attribution();

drop trigger if exists referral_payment_transition_accounting on public.payment_orders;
create trigger referral_payment_transition_accounting
after update of status,user_id on public.payment_orders
for each row
when (new.status='succeeded' and
      (old.status is distinct from 'succeeded' or old.user_id is distinct from new.user_id))
execute function public.on_referral_payment_transition();

revoke all on function public.on_late_referral_attribution(),
  public.on_referral_payment_transition() from public,anon,authenticated;

-- Repair every historical paid referral order that was missed by the old
-- status-only trigger. award_referral_order is idempotent, so reapplying or a
-- concurrent payment callback cannot duplicate money.
do $$
declare item record;
begin
  for item in
    select o.id
      from public.payment_orders o
      join public.referral_attributions a on a.invited_user_id=o.user_id
     where o.status='succeeded'
       and not exists (
         select 1 from public.referral_ledger l
          where l.event_key='order-reward:'||o.id::text
       )
     order by o.paid_at nulls last,o.created_at,o.id
  loop
    perform public.award_referral_order(item.id);
  end loop;
end;
$$;

commit;
