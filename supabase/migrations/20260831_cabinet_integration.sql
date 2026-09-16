begin;

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 120),
  phone text not null default '' check (char_length(phone) <= 32),
  payer_status text not null default 'individual'
    check (payer_status in ('individual','self_employed','entrepreneur')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_preferences
  add column if not exists notify_order_status boolean not null default true,
  add column if not exists notify_key_expiry boolean not null default true,
  add column if not exists notify_low_balance boolean not null default false,
  add column if not exists notify_product_news boolean not null default true,
  add column if not exists notification_consent_updated_at timestamptz not null default now(),
  add column if not exists notification_consent_source text not null default 'registration',
  add column if not exists history_imported_at timestamptz,
  add column if not exists history_imported_count integer not null default 0,
  add column if not exists history_import_notice_dismissed_at timestamptz;

create table if not exists public.in_app_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('order','key_expiry','low_balance','product_news','system')),
  title text not null check (char_length(title) between 1 and 160),
  body text not null default '' check (char_length(body) <= 2000),
  link text check (link is null or char_length(link) <= 500),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 240),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id, dedupe_key)
);

create index if not exists in_app_notifications_user_idx
  on public.in_app_notifications(user_id, created_at desc);
create index if not exists in_app_notifications_unread_idx
  on public.in_app_notifications(user_id, created_at desc) where read_at is null;

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  notification_id uuid references public.in_app_notifications(id) on delete set null,
  channel text not null default 'email' check (channel='email'),
  recipient text not null,
  dedupe_key text not null unique,
  provider_id text,
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists public.referral_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  referral_code text not null unique check (referral_code ~ '^[A-Z0-9]{8,16}$'),
  available_kopecks bigint not null default 0 check (available_kopecks >= 0),
  reserved_kopecks bigint not null default 0 check (reserved_kopecks >= 0),
  earned_kopecks bigint not null default 0 check (earned_kopecks >= 0),
  paid_kopecks bigint not null default 0 check (paid_kopecks >= 0),
  debt_kopecks bigint not null default 0 check (debt_kopecks >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.referral_attributions (
  invited_user_id uuid primary key references auth.users(id) on delete cascade,
  referrer_user_id uuid not null references auth.users(id) on delete cascade,
  referral_code text not null,
  attributed_at timestamptz not null default now(),
  check (invited_user_id <> referrer_user_id)
);
create index if not exists referral_attributions_referrer_idx
  on public.referral_attributions(referrer_user_id, attributed_at desc);

create table if not exists public.referral_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('reward','spend','spend_release','withdraw_hold','withdraw_release','withdraw_paid','forfeit','reversal')),
  amount_kopecks bigint not null check (amount_kopecks <> 0),
  order_id uuid references public.payment_orders(id) on delete set null,
  event_key text not null unique,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists referral_ledger_user_idx on public.referral_ledger(user_id, created_at desc);

create table if not exists public.referral_withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  amount_kopecks bigint not null check (amount_kopecks >= 50000),
  sbp_phone text not null check (char_length(sbp_phone) between 7 and 32),
  bank_name text not null check (char_length(bank_name) between 2 and 120),
  status text not null default 'pending' check (status in ('pending','approved','paid','rejected','canceled')),
  admin_note text not null default '' check (char_length(admin_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists referral_withdrawals_user_idx on public.referral_withdrawals(user_id, created_at desc);

create table if not exists public.referral_admin_audit (
  id bigint generated by default as identity primary key,
  withdrawal_id uuid references public.referral_withdrawals(id) on delete set null,
  from_status text,
  to_status text not null,
  admin_fingerprint text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

alter table public.payment_orders
  add column if not exists gross_amount numeric(10,2),
  add column if not exists referral_credit_kopecks bigint not null default 0 check (referral_credit_kopecks >= 0),
  add column if not exists refunded_kopecks bigint not null default 0 check (refunded_kopecks >= 0),
  add column if not exists receipt_url text;
update public.payment_orders set gross_amount=amount where gross_amount is null;
alter table public.payment_orders alter column gross_amount set not null;
alter table public.payment_orders drop constraint if exists payment_orders_amount_check;
alter table public.payment_orders add constraint payment_orders_amount_check check (amount >= 0);

alter table public.user_profiles enable row level security;
alter table public.in_app_notifications enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.referral_accounts enable row level security;
alter table public.referral_attributions enable row level security;
alter table public.referral_ledger enable row level security;
alter table public.referral_withdrawals enable row level security;
alter table public.referral_admin_audit enable row level security;

revoke all on table public.user_profiles, public.in_app_notifications, public.notification_deliveries,
  public.referral_accounts, public.referral_attributions, public.referral_ledger,
  public.referral_withdrawals, public.referral_admin_audit from public, anon, authenticated;
grant select, insert, update, delete on table public.user_profiles, public.in_app_notifications,
  public.notification_deliveries, public.referral_accounts, public.referral_attributions,
  public.referral_ledger, public.referral_withdrawals, public.referral_admin_audit to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.ensure_referral_account(p_user_id uuid)
returns public.referral_accounts language plpgsql security definer set search_path=public as $$
declare result public.referral_accounts; candidate text;
begin
  select * into result from public.referral_accounts where user_id=p_user_id;
  if found then return result; end if;
  loop
    candidate := upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
    begin
      insert into public.referral_accounts(user_id,referral_code) values(p_user_id,candidate) returning * into result;
      return result;
    exception when unique_violation then null;
    end;
  end loop;
end;$$;

create or replace function public.bind_referral(p_user_id uuid,p_code text)
returns boolean language plpgsql security definer set search_path=public,auth as $$
declare referrer uuid; created timestamptz;
begin
  select user_id into referrer from public.referral_accounts where referral_code=upper(btrim(p_code));
  if referrer is null or referrer=p_user_id then return false; end if;
  select created_at into created from auth.users where id=p_user_id;
  if created is null or created < now()-interval '30 minutes' then return false; end if;
  insert into public.referral_attributions(invited_user_id,referrer_user_id,referral_code)
    values(p_user_id,referrer,upper(btrim(p_code))) on conflict(invited_user_id) do nothing;
  return found;
end;$$;

create or replace function public.apply_referral_credit(p_user_id uuid,p_order_id uuid,p_requested_kopecks bigint)
returns bigint language plpgsql security definer set search_path=public as $$
declare account public.referral_accounts; order_row public.payment_orders; used bigint;
begin
  if p_requested_kopecks<=0 then return 0; end if;
  select * into order_row from public.payment_orders where id=p_order_id and user_id=p_user_id and status='pending' for update;
  if not found then raise exception 'Order not found'; end if;
  select * into account from public.referral_accounts where user_id=p_user_id for update;
  if not found then return 0; end if;
  used:=least(p_requested_kopecks,account.available_kopecks,round(order_row.gross_amount*100)::bigint);
  if used<=0 then return 0; end if;
  update public.referral_accounts set available_kopecks=available_kopecks-used,reserved_kopecks=reserved_kopecks+used,updated_at=now() where user_id=p_user_id;
  update public.payment_orders set referral_credit_kopecks=used,amount=(round(gross_amount*100)::bigint-used)/100.0,updated_at=now() where id=p_order_id;
  insert into public.referral_ledger(user_id,kind,amount_kopecks,order_id,event_key)
    values(p_user_id,'spend',-used,p_order_id,'order-spend:'||p_order_id::text);
  return used;
end;$$;

create or replace function public.create_referral_withdrawal(p_user_id uuid,p_amount_kopecks bigint,p_phone text,p_bank text)
returns uuid language plpgsql security definer set search_path=public as $$
declare account public.referral_accounts; result uuid:=gen_random_uuid();
begin
  if p_amount_kopecks<50000 then raise exception 'Minimum withdrawal is 500 RUB'; end if;
  select * into account from public.referral_accounts where user_id=p_user_id for update;
  if not found or account.available_kopecks<p_amount_kopecks then raise exception 'Insufficient referral balance'; end if;
  update public.referral_accounts set available_kopecks=available_kopecks-p_amount_kopecks,reserved_kopecks=reserved_kopecks+p_amount_kopecks,updated_at=now() where user_id=p_user_id;
  insert into public.referral_withdrawals(id,user_id,amount_kopecks,sbp_phone,bank_name)
    values(result,p_user_id,p_amount_kopecks,btrim(p_phone),btrim(p_bank));
  insert into public.referral_ledger(user_id,kind,amount_kopecks,event_key,details)
    values(p_user_id,'withdraw_hold',-p_amount_kopecks,'withdraw-hold:'||result::text,jsonb_build_object('withdrawalId',result));
  return result;
end;$$;

create or replace function public.process_referral_withdrawal(p_withdrawal_id uuid,p_status text,p_admin_fingerprint text,p_note text default '')
returns public.referral_withdrawals language plpgsql security definer set search_path=public as $$
declare item public.referral_withdrawals; previous text;
begin
  select * into item from public.referral_withdrawals where id=p_withdrawal_id for update;
  if not found then raise exception 'Withdrawal not found'; end if;
  previous:=item.status;
  if not ((previous='pending' and p_status in ('approved','rejected')) or (previous='approved' and p_status in ('paid','rejected'))) then raise exception 'Invalid withdrawal transition'; end if;
  if p_status='rejected' and item.user_id is not null then
    update public.referral_accounts set available_kopecks=available_kopecks+item.amount_kopecks,reserved_kopecks=greatest(0,reserved_kopecks-item.amount_kopecks),updated_at=now() where user_id=item.user_id;
    insert into public.referral_ledger(user_id,kind,amount_kopecks,event_key,details) values(item.user_id,'withdraw_release',item.amount_kopecks,'withdraw-release:'||item.id::text,jsonb_build_object('withdrawalId',item.id));
  elsif p_status='paid' and item.user_id is not null then
    update public.referral_accounts set reserved_kopecks=greatest(0,reserved_kopecks-item.amount_kopecks),paid_kopecks=paid_kopecks+item.amount_kopecks,updated_at=now() where user_id=item.user_id;
    insert into public.referral_ledger(user_id,kind,amount_kopecks,event_key,details) values(item.user_id,'withdraw_paid',-item.amount_kopecks,'withdraw-paid:'||item.id::text,jsonb_build_object('withdrawalId',item.id));
  end if;
  update public.referral_withdrawals set status=p_status,admin_note=left(coalesce(p_note,''),1000),updated_at=now(),processed_at=case when p_status in ('paid','rejected') then now() else processed_at end where id=item.id returning * into item;
  insert into public.referral_admin_audit(withdrawal_id,from_status,to_status,admin_fingerprint,note) values(item.id,previous,p_status,p_admin_fingerprint,left(coalesce(p_note,''),1000));
  return item;
end;$$;

create or replace function public.on_payment_order_accounting()
returns trigger language plpgsql security definer set search_path=public as $$
declare referrer uuid; reward bigint;
begin
  if new.status='succeeded' and new.user_id is not null then
    update public.sticker_access_codes set owner_user_id=new.user_id where code=new.access_code and owner_user_id is null;
    update public.license_keys set owner_user_id=new.user_id where key=new.program_license_key and owner_user_id is null;
    update public.cell_print_licenses set owner_user_id=new.user_id where key=new.cell_print_license_key and owner_user_id is null;
  end if;
  if new.status='succeeded' and old.status is distinct from 'succeeded' then
    if new.user_id is not null then
      update public.sticker_access_codes set owner_user_id=new.user_id where code=new.access_code and owner_user_id is null;
      update public.license_keys set owner_user_id=new.user_id where key=new.program_license_key and owner_user_id is null;
      update public.cell_print_licenses set owner_user_id=new.user_id where key=new.cell_print_license_key and owner_user_id is null;
      if new.referral_credit_kopecks>0 then
        update public.referral_accounts set reserved_kopecks=greatest(0,reserved_kopecks-new.referral_credit_kopecks),updated_at=now() where user_id=new.user_id;
      end if;
      select referrer_user_id into referrer from public.referral_attributions where invited_user_id=new.user_id;
      reward:=floor(new.amount*100*0.10)::bigint;
      if referrer is not null and reward>0 then
        perform public.ensure_referral_account(referrer);
        insert into public.referral_ledger(user_id,kind,amount_kopecks,order_id,event_key,details)
          values(referrer,'reward',reward,new.id,'order-reward:'||new.id::text,jsonb_build_object('invitedUserId',new.user_id))
          on conflict(event_key) do nothing;
        if found then update public.referral_accounts set available_kopecks=available_kopecks+greatest(reward-debt_kopecks,0),debt_kopecks=greatest(debt_kopecks-reward,0),earned_kopecks=earned_kopecks+reward,updated_at=now() where user_id=referrer; end if;
      end if;
    end if;
  elsif new.status='canceled' and old.status is distinct from 'canceled' and new.user_id is not null and new.referral_credit_kopecks>0 then
    insert into public.referral_ledger(user_id,kind,amount_kopecks,order_id,event_key)
      values(new.user_id,'spend_release',new.referral_credit_kopecks,new.id,'order-release:'||new.id::text)
      on conflict(event_key) do nothing;
    if found then
      update public.referral_accounts set available_kopecks=available_kopecks+new.referral_credit_kopecks,reserved_kopecks=greatest(0,reserved_kopecks-new.referral_credit_kopecks),updated_at=now() where user_id=new.user_id;
    end if;
  end if;
  return new;
end;$$;

create or replace function public.reverse_referral_reward(p_order_id uuid,p_refund_kopecks bigint,p_event_key text)
returns bigint language plpgsql security definer set search_path=public as $$
declare reward_row public.referral_ledger; account public.referral_accounts; order_cash bigint; original_reward bigint; already_reversed bigint; reversal bigint; from_available bigint;
begin
  select * into reward_row from public.referral_ledger where order_id=p_order_id and kind='reward' limit 1;
  if not found or p_refund_kopecks<=0 then return 0; end if;
  if exists(select 1 from public.referral_ledger where event_key=p_event_key) then return 0; end if;
  select round(amount*100)::bigint into order_cash from public.payment_orders where id=p_order_id for update;
  original_reward:=reward_row.amount_kopecks;
  select coalesce(-sum(amount_kopecks),0)::bigint into already_reversed from public.referral_ledger where order_id=p_order_id and kind='reversal';
  reversal:=least(original_reward-already_reversed,floor(original_reward*least(p_refund_kopecks,order_cash)::numeric/greatest(order_cash,1))::bigint);
  if reversal<=0 then return 0; end if;
  select * into account from public.referral_accounts where user_id=reward_row.user_id for update;
  from_available:=least(account.available_kopecks,reversal);
  update public.referral_accounts set available_kopecks=available_kopecks-from_available,debt_kopecks=debt_kopecks+(reversal-from_available),earned_kopecks=greatest(0,earned_kopecks-reversal),updated_at=now() where user_id=reward_row.user_id;
  insert into public.referral_ledger(user_id,kind,amount_kopecks,order_id,event_key,details) values(reward_row.user_id,'reversal',-reversal,p_order_id,p_event_key,jsonb_build_object('refundKopecks',p_refund_kopecks));
  update public.payment_orders set refunded_kopecks=refunded_kopecks+p_refund_kopecks,updated_at=now() where id=p_order_id;
  return reversal;
end;$$;

drop trigger if exists payment_order_accounting on public.payment_orders;
create trigger payment_order_accounting after update on public.payment_orders
for each row execute function public.on_payment_order_accounting();

revoke all on function public.ensure_referral_account(uuid), public.bind_referral(uuid,text),
 public.apply_referral_credit(uuid,uuid,bigint), public.create_referral_withdrawal(uuid,bigint,text,text) from public,anon,authenticated;
revoke all on function public.process_referral_withdrawal(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.reverse_referral_reward(uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.ensure_referral_account(uuid), public.bind_referral(uuid,text),
 public.apply_referral_credit(uuid,uuid,bigint), public.create_referral_withdrawal(uuid,bigint,text,text) to service_role;
grant execute on function public.process_referral_withdrawal(uuid,text,text,text) to service_role;
grant execute on function public.reverse_referral_reward(uuid,bigint,text) to service_role;

commit;
