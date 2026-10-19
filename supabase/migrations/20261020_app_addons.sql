begin;

-- Доп. услуги «Помощника ПВЗ», покупаются отдельно от тарифа на свой срок.
-- Пока одна: 'archive' — чтение архива клиентов на ПК (сам архив программа
-- собирает всегда, услуга только открывает доступ к нему; после окончания
-- данные не удаляются и снова открываются при повторной покупке).
--
-- Услуга — отрезки [starts_at, ends_at), как подписка. Покупка при активной
-- услуге продлевает её от последнего ends_at, иначе начинается сейчас.
-- Тариф не ниже Стандарта проверяет сервер при оплате (server/_app-plans.js).

create table if not exists public.app_addons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  addon text not null check (addon in ('archive')),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  canceled boolean not null default false,
  price numeric(10,2) not null default 0 check (price >= 0),
  source_order_id uuid references public.payment_orders(id) on delete set null,
  source text not null default 'payment' check (source in ('payment','admin','partner')),
  reminded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists app_addons_user_time_idx
  on public.app_addons(user_id, addon, ends_at desc) where not canceled;

alter table public.app_addons enable row level security;
drop policy if exists app_addons_own on public.app_addons;
create policy app_addons_own on public.app_addons for select to authenticated using (user_id = auth.uid());

alter table public.payment_orders add column if not exists app_addon text
  check (app_addon is null or app_addon in ('archive'));
alter table public.payment_orders add column if not exists app_addon_months integer
  check (app_addon_months is null or app_addon_months in (6,12));

alter table public.payment_orders drop constraint if exists payment_orders_product_kind_check;
alter table public.payment_orders add constraint payment_orders_product_kind_check check
  (product_kind in ('stickers','program','program_license','cell_print_program','cell_print_license','cell_print_bundle','individual_stickers','app_subscription','app_addon'));

alter table public.payment_orders drop constraint if exists payment_orders_product_quantity_check;
alter table public.payment_orders add constraint payment_orders_product_quantity_check check (
  (product_kind='stickers' and range_quantity+custom_quantity>0)
  or (product_kind in ('program','program_license','cell_print_program','cell_print_license','cell_print_bundle','individual_stickers','app_subscription','app_addon')
      and range_quantity=0 and custom_quantity=0)
);

-- Применить отрезок услуги: продление от конца активной или новый с now().
create or replace function public.app_apply_addon(
  p_user uuid, p_addon text, p_months integer, p_price numeric,
  p_source text default 'payment', p_order_id uuid default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  last_end timestamptz;
  new_id uuid;
begin
  if p_addon is null or p_months is null or p_months < 1 then
    raise exception 'Invalid addon';
  end if;
  perform pg_advisory_xact_lock(hashtext('app_addons:' || p_user::text));
  select max(ends_at) into last_end from public.app_addons
   where user_id = p_user and addon = p_addon and not canceled and ends_at > now();
  insert into public.app_addons(user_id, addon, starts_at, ends_at, price, source_order_id, source)
    values (p_user, p_addon, coalesce(last_end, now()),
            coalesce(last_end, now()) + make_interval(months => p_months),
            coalesce(p_price, 0), p_order_id, p_source)
    returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.complete_app_addon_order(p_order_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  order_row public.payment_orders;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));
  select * into order_row from public.payment_orders
   where id = p_order_id and product_kind = 'app_addon' for update;
  if not found then raise exception 'Addon order not found'; end if;
  if order_row.app_fulfilled_at is not null then
    select id into new_id from public.app_addons where source_order_id = p_order_id order by created_at desc limit 1;
    return new_id;
  end if;
  if order_row.user_id is null then raise exception 'Addon requires an account'; end if;
  if order_row.app_addon is null or order_row.app_addon_months is null then
    raise exception 'Invalid addon order';
  end if;
  new_id := public.app_apply_addon(order_row.user_id, order_row.app_addon, order_row.app_addon_months,
                                   order_row.amount, 'payment', p_order_id);
  update public.payment_orders set app_fulfilled_at = now(), status = 'succeeded',
         paid_at = coalesce(paid_at, now()), updated_at = now()
   where id = p_order_id;
  return new_id;
end;
$$;

create or replace function public.admin_grant_app_addon(p_user uuid, p_addon text, p_months integer)
returns uuid language plpgsql security definer set search_path=public as $$
begin
  return public.app_apply_addon(p_user, p_addon, p_months, 0, 'admin', null);
end;
$$;

-- Отзыв: идущий отрезок обрываем сейчас, будущий отменяем. Сам архив на ПК не трогается.
create or replace function public.admin_revoke_app_addon(p_addon_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.app_addons
     set canceled = true,
         ends_at = case when starts_at < now() then now() else ends_at end
   where id = p_addon_id;
end;
$$;

-- app_entitlements: всё как в 20261018 + поле addons {archive: {ends_at}}.
-- Услуги отдаём и без подписки — сервер сам решает, открывать ли их (нужен тариф).
create or replace function public.app_entitlements(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  sub public.app_subscriptions;
  win timestamptz;
  codes_used integer := 0;
  stickers_used integer := 0;
  next_plan text;
  last_end timestamptz;
  packs integer;
  addons jsonb;
begin
  select coalesce(sum(greatest(usage_limit - used, 0)), 0) into packs
    from public.license_keys where owner_user_id = p_user and active;
  select coalesce(jsonb_object_agg(a.addon, jsonb_build_object('ends_at', a.ends_at)), '{}'::jsonb) into addons
    from (select addon, max(ends_at) as ends_at from public.app_addons
           where user_id = p_user and not canceled and starts_at <= now() and ends_at > now()
           group by addon) a;
  sub := public.app_current_subscription(p_user);
  if sub.id is null then
    return jsonb_build_object('plan', null, 'packs_left', packs, 'device_limit', 1, 'addons', addons);
  end if;
  win := public.app_window_start(sub.starts_at);
  select coalesce(sum(amount) filter (where kind = 'code'), 0),
         coalesce(sum(amount) filter (where kind = 'sticker'), 0)
    into codes_used, stickers_used
    from public.app_usage
   where subscription_id = sub.id and source = 'quota' and created_at >= win;
  select coalesce(max(generation_used), stickers_used) into stickers_used
    from public.sticker_access_codes where app_subscription_id = sub.id and app_window_start = win;
  select plan into next_plan from public.app_subscriptions
   where user_id = p_user and not canceled and starts_at >= sub.ends_at
   order by starts_at limit 1;
  select max(ends_at) into last_end from public.app_subscriptions
   where user_id = p_user and not canceled and ends_at > now();
  return jsonb_build_object(
    'plan', sub.plan,
    'subscription_id', sub.id,
    'starts_at', sub.starts_at,
    'ends_at', sub.ends_at,
    'paid_until', last_end,
    'next_plan', next_plan,
    'device_limit', sub.device_limit,
    'window_start', win,
    'window_end', win + interval '1 month',
    'codes_limit', sub.codes_per_month,
    'codes_used', codes_used,
    'stickers_limit', sub.stickers_per_month,
    'stickers_used', stickers_used,
    'packs_left', packs,
    'addons', addons
  );
end;
$$;

revoke all on function public.app_apply_addon(uuid,text,integer,numeric,text,uuid) from public, anon, authenticated;
revoke all on function public.complete_app_addon_order(uuid) from public, anon, authenticated;
revoke all on function public.admin_grant_app_addon(uuid,text,integer) from public, anon, authenticated;
revoke all on function public.admin_revoke_app_addon(uuid) from public, anon, authenticated;
grant execute on function public.app_apply_addon(uuid,text,integer,numeric,text,uuid) to service_role;
grant execute on function public.complete_app_addon_order(uuid) to service_role;
grant execute on function public.admin_grant_app_addon(uuid,text,integer) to service_role;
grant execute on function public.admin_revoke_app_addon(uuid) to service_role;

commit;
