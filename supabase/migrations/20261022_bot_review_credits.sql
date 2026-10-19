begin;

-- Платное раскрытие авторов отзывов в Telegram-боте («👤 Кто оставил»).
-- Баланс раскрытий живёт на аккаунте сайта. Одно раскрытие = один клиент
-- в одном ПВЗ: повторный показ того же автора не списывается (bot_review_reveals).
-- Пакеты покупаются заказом product_kind='bot_reviews' (цены — REVIEW_PRICES в server/_payments.js).

create table if not exists public.bot_review_credits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  purchased integer not null default 0 check (purchased >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.bot_review_reveals (
  user_id uuid not null references auth.users(id) on delete cascade,
  point_id bigint not null,
  client_id bigint not null,
  free boolean not null default false,
  revealed_at timestamptz not null default now(),
  primary key (user_id, point_id, client_id)
);

alter table public.bot_review_credits enable row level security;
alter table public.bot_review_reveals enable row level security;
drop policy if exists bot_review_credits_own on public.bot_review_credits;
create policy bot_review_credits_own on public.bot_review_credits for select to authenticated using (user_id = auth.uid());
drop policy if exists bot_review_reveals_own on public.bot_review_reveals;
create policy bot_review_reveals_own on public.bot_review_reveals for select to authenticated using (user_id = auth.uid());

alter table public.payment_orders add column if not exists review_credits integer
  check (review_credits is null or review_credits > 0);
alter table public.payment_orders add column if not exists review_fulfilled_at timestamptz;

alter table public.payment_orders drop constraint if exists payment_orders_product_kind_check;
alter table public.payment_orders add constraint payment_orders_product_kind_check check
  (product_kind in ('stickers','program','program_license','cell_print_program','cell_print_license','cell_print_bundle','individual_stickers','app_subscription','app_addon','bot_reviews'));

alter table public.payment_orders drop constraint if exists payment_orders_product_quantity_check;
alter table public.payment_orders add constraint payment_orders_product_quantity_check check (
  (product_kind='stickers' and range_quantity+custom_quantity>0)
  or (product_kind in ('program','program_license','cell_print_program','cell_print_license','cell_print_bundle','individual_stickers','app_subscription','app_addon','bot_reviews')
      and range_quantity=0 and custom_quantity=0)
);

-- Зачислить раскрытия на баланс.
create or replace function public.bot_review_add(p_user uuid, p_amount integer)
returns integer language plpgsql security definer set search_path=public as $$
declare
  new_balance integer;
begin
  if p_user is null or p_amount is null or p_amount < 1 then raise exception 'Invalid review credits'; end if;
  insert into public.bot_review_credits(user_id, balance, purchased)
    values (p_user, p_amount, p_amount)
  on conflict (user_id) do update
    set balance = bot_review_credits.balance + excluded.balance,
        purchased = bot_review_credits.purchased + excluded.purchased,
        updated_at = now()
  returning balance into new_balance;
  return new_balance;
end;
$$;

-- Списать одно раскрытие. Уже раскрытый автор — бесплатно.
-- Ответ: {ok, free, balance}. ok=false — баланса нет, ничего не списано.
create or replace function public.bot_review_spend(p_user uuid, p_point bigint, p_client bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  new_balance integer;
begin
  perform pg_advisory_xact_lock(hashtext('bot_review:' || p_user::text));
  if exists (select 1 from public.bot_review_reveals
              where user_id = p_user and point_id = p_point and client_id = p_client) then
    select coalesce((select balance from public.bot_review_credits where user_id = p_user), 0) into new_balance;
    return jsonb_build_object('ok', true, 'free', true, 'balance', new_balance);
  end if;
  update public.bot_review_credits set balance = balance - 1, updated_at = now()
   where user_id = p_user and balance > 0
   returning balance into new_balance;
  if not found then
    return jsonb_build_object('ok', false, 'free', false,
      'balance', coalesce((select balance from public.bot_review_credits where user_id = p_user), 0));
  end if;
  insert into public.bot_review_reveals(user_id, point_id, client_id) values (p_user, p_point, p_client);
  return jsonb_build_object('ok', true, 'free', false, 'balance', new_balance);
end;
$$;

-- Оплаченный заказ → раскрытия на баланс. Идемпотентно по review_fulfilled_at.
create or replace function public.complete_bot_review_order(p_order_id uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare
  order_row public.payment_orders;
  new_balance integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));
  select * into order_row from public.payment_orders
   where id = p_order_id and product_kind = 'bot_reviews' for update;
  if not found then raise exception 'Review order not found'; end if;
  if order_row.user_id is null then raise exception 'Review credits require an account'; end if;
  if order_row.review_fulfilled_at is not null then
    return coalesce((select balance from public.bot_review_credits where user_id = order_row.user_id), 0);
  end if;
  if order_row.review_credits is null then raise exception 'Invalid review order'; end if;
  new_balance := public.bot_review_add(order_row.user_id, order_row.review_credits);
  update public.payment_orders set review_fulfilled_at = now(), status = 'succeeded',
         paid_at = coalesce(paid_at, now()), updated_at = now()
   where id = p_order_id;
  return new_balance;
end;
$$;

create or replace function public.admin_grant_bot_review_credits(p_user uuid, p_amount integer)
returns integer language plpgsql security definer set search_path=public as $$
begin
  return public.bot_review_add(p_user, p_amount);
end;
$$;

revoke all on function public.bot_review_add(uuid,integer) from public, anon, authenticated;
revoke all on function public.bot_review_spend(uuid,bigint,bigint) from public, anon, authenticated;
revoke all on function public.complete_bot_review_order(uuid) from public, anon, authenticated;
revoke all on function public.admin_grant_bot_review_credits(uuid,integer) from public, anon, authenticated;
grant execute on function public.bot_review_add(uuid,integer) to service_role;
grant execute on function public.bot_review_spend(uuid,bigint,bigint) to service_role;
grant execute on function public.complete_bot_review_order(uuid) to service_role;
grant execute on function public.admin_grant_bot_review_credits(uuid,integer) to service_role;

commit;
