begin;

create table if not exists public.individual_sticker_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  codes jsonb not null check (jsonb_typeof(codes)='array' and jsonb_array_length(codes) between 1 and 10000),
  quantity integer not null check (quantity between 1 and 10000),
  total_amount numeric(10,2) not null check (total_amount>=0),
  paid_amount numeric(10,2) not null default 0 check (paid_amount>=0),
  amount_due numeric(10,2) not null check (amount_due>=0),
  credited_units integer not null default 0 check (credited_units>=0),
  status text not null default 'pending_payment' check (status in ('pending_payment','paid','canceled')),
  payment_order_id uuid references public.payment_orders(id) on delete set null,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (quantity=jsonb_array_length(codes)),
  check (round(total_amount-paid_amount,2)=amount_due)
);

create index if not exists individual_sticker_orders_user_idx
  on public.individual_sticker_orders(user_id,created_at desc);

alter table public.individual_sticker_orders enable row level security;
revoke all on table public.individual_sticker_orders from public,anon,authenticated;
grant select,insert,update,delete on table public.individual_sticker_orders to service_role;

create table if not exists public.individual_sticker_order_credits (
  order_id uuid not null references public.individual_sticker_orders(id) on delete cascade,
  access_code text not null references public.sticker_access_codes(code),
  units integer not null check (units>0),
  primary key(order_id,access_code)
);
alter table public.individual_sticker_order_credits enable row level security;
revoke all on table public.individual_sticker_order_credits from public,anon,authenticated;
grant select,insert,update,delete on table public.individual_sticker_order_credits to service_role;

create or replace function public.create_individual_sticker_order(
  p_user_id uuid,p_title text,p_codes jsonb,p_total_amount numeric,p_credit_units integer
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  new_id uuid;
  asset public.sticker_access_codes;
  remaining integer:=p_credit_units;
  take_units integer;
  count_codes integer;
  paid_value numeric(10,2);
begin
  if jsonb_typeof(p_codes)<>'array' then raise exception 'Invalid codes'; end if;
  select count(distinct value),count(*) into count_codes,take_units from jsonb_array_elements_text(p_codes);
  if count_codes<>take_units or count_codes<1 or count_codes>10000 then raise exception 'Codes must be unique'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_codes) where value !~ '^[0-9]{11}$') then raise exception 'Invalid sticker code'; end if;
  if p_credit_units<0 or p_credit_units>count_codes then raise exception 'Invalid credit amount'; end if;
  paid_value:=round(p_credit_units*(p_total_amount/count_codes),2);
  insert into public.individual_sticker_orders(user_id,title,codes,quantity,total_amount,paid_amount,amount_due,credited_units)
  values(p_user_id,btrim(p_title),p_codes,count_codes,p_total_amount,paid_value,round(p_total_amount-paid_value,2),p_credit_units)
  returning id into new_id;

  for asset in select * from public.sticker_access_codes
    where owner_user_id=p_user_id and active and generation_used<generation_limit
    order by created_at for update
  loop
    exit when remaining=0;
    take_units:=least(remaining,asset.generation_limit-asset.generation_used);
    update public.sticker_access_codes set generation_used=generation_used+take_units where id=asset.id;
    insert into public.individual_sticker_order_credits(order_id,access_code,units)
    values(new_id,asset.code,take_units);
    remaining:=remaining-take_units;
  end loop;
  if remaining<>0 then raise exception 'Not enough generation credits'; end if;
  return new_id;
end;$$;
revoke all on function public.create_individual_sticker_order(uuid,text,jsonb,numeric,integer) from public,anon,authenticated;
grant execute on function public.create_individual_sticker_order(uuid,text,jsonb,numeric,integer) to service_role;

alter table public.payment_orders
  add column if not exists individual_sticker_order_id uuid
  references public.individual_sticker_orders(id) on delete set null;

alter table public.payment_orders drop constraint if exists payment_orders_product_kind_check;
alter table public.payment_orders add constraint payment_orders_product_kind_check check
  (product_kind in ('stickers','program','program_license','cell_print_program','cell_print_license','cell_print_bundle','individual_stickers'));

alter table public.payment_orders drop constraint if exists payment_orders_product_quantity_check;
alter table public.payment_orders add constraint payment_orders_product_quantity_check check (
  (product_kind='stickers' and range_quantity+custom_quantity>0)
  or (product_kind in ('program','program_license','cell_print_program','cell_print_license','cell_print_bundle','individual_stickers')
      and range_quantity=0 and custom_quantity=0)
);

create unique index if not exists payment_orders_individual_sticker_order_idx
  on public.payment_orders(individual_sticker_order_id)
  where individual_sticker_order_id is not null and status not in ('canceled');

create or replace function public.complete_individual_sticker_order(p_payment_order_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  payment public.payment_orders;
  custom public.individual_sticker_orders;
  part integer:=0;
  start_at integer:=0;
  part_codes jsonb;
begin
  select * into payment from public.payment_orders
   where id=p_payment_order_id and product_kind='individual_stickers' for update;
  if not found or payment.individual_sticker_order_id is null then raise exception 'Individual order not found'; end if;

  select * into custom from public.individual_sticker_orders
   where id=payment.individual_sticker_order_id and user_id=payment.user_id for update;
  if not found then raise exception 'Individual order not found'; end if;
  if custom.status='paid' then return custom.id; end if;

  while start_at < custom.quantity loop
    select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into part_codes
      from jsonb_array_elements(custom.codes) with ordinality
     where ordinality > start_at and ordinality <= start_at+500;

    insert into public.user_generation_history(user_id,client_entry_id,mode,payload,created_at)
    values(custom.user_id,'individual:'||custom.id||':'||part,'range',jsonb_build_object(
      'category','product','quantity',jsonb_array_length(part_codes),'codes',part_codes,
      'individualOrderId',custom.id,'individualOrderTitle',custom.title
    ),now())
    on conflict(user_id,client_entry_id) do nothing;

    start_at:=start_at+500;
    part:=part+1;
  end loop;

  update public.individual_sticker_orders set status='paid',fulfilled_at=now(),updated_at=now(),
    payment_order_id=payment.id where id=custom.id;
  return custom.id;
end;$$;

revoke all on function public.complete_individual_sticker_order(uuid) from public,anon,authenticated;
grant execute on function public.complete_individual_sticker_order(uuid) to service_role;

commit;
