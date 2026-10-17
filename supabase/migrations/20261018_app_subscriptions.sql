begin;

-- Подписки программы «Помощник ПВЗ»: вход по аккаунту сайта, тарифы со сроком
-- и месячными лимитами, ограничение числа ПК.
--
-- Подписка — это отрезки времени [starts_at, ends_at) с тарифом и снимком лимитов
-- на момент покупки (смена цен в конфиге не трогает уже купленное). Текущий
-- тариф = отрезок, внутри которого сейчас now(). Поэтому истечение не требует
-- крона: отрезок просто заканчивается.
--   * тот же тариф — продлеваем последний отрезок;
--   * тариф выше — остаток всех будущих отрезков переводим в дни нового тарифа
--     по цене (дни × старая цена / новая цена) и начинаем новый отрезок сейчас;
--   * тариф ниже — ставим новый отрезок в очередь после последнего.
--
-- Месячное окно лимитов отсчитывается от starts_at отрезка: при оплате на год
-- лимит всё равно обновляется каждый месяц. Неизрасходованное не переносится.
-- Сверх месячной квоты подбор кода берётся из пакетов — license_keys владельца
-- (бывшие ключи WBPK). Стикеры сверх квоты Про — из своих sticker_access_codes.

create table if not exists public.app_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('basic','standard','pro')),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  canceled boolean not null default false,
  monthly_price numeric(10,2) not null check (monthly_price >= 0),
  codes_per_month integer not null check (codes_per_month >= 0),
  stickers_per_month integer not null check (stickers_per_month >= 0),
  device_limit integer not null check (device_limit between 1 and 20),
  source_order_id uuid references public.payment_orders(id) on delete set null,
  source text not null default 'payment' check (source in ('payment','admin','partner')),
  reminded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists app_subscriptions_user_time_idx
  on public.app_subscriptions(user_id, ends_at desc) where not canceled;

create table if not exists public.app_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_hash text not null check (device_hash ~ '^[a-f0-9]{64}$'),
  name text not null default 'Компьютер' check (char_length(name) <= 80),
  app_version text not null default '' check (char_length(app_version) <= 32),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, device_hash)
);

create table if not exists public.app_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid references public.app_subscriptions(id) on delete set null,
  device_id uuid references public.app_devices(id) on delete set null,
  kind text not null check (kind in ('code','sticker')),
  amount integer not null check (amount between 1 and 500),
  source text not null check (source in ('quota','pack')),
  license_key_id bigint references public.license_keys(id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists app_usage_user_time_idx on public.app_usage(user_id, created_at desc);
create index if not exists app_usage_quota_idx on public.app_usage(subscription_id, kind, created_at) where source = 'quota';

-- Вход в программу через браузер (аккаунты Telegram без пароля): программа
-- показывает код, человек подтверждает его на сайте, программа забирает сессию
-- по секрету, который видела только она.
create table if not exists public.app_login_requests (
  code text primary key check (code ~ '^[A-Z2-9]{8}$'),
  poll_secret_hash text not null,
  device_hash text not null check (device_hash ~ '^[a-f0-9]{64}$'),
  device_name text not null default 'Компьютер' check (char_length(device_name) <= 80),
  app_version text not null default '',
  user_id uuid references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','consumed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

alter table public.payment_orders add column if not exists app_plan text
  check (app_plan is null or app_plan in ('basic','standard','pro'));
alter table public.payment_orders add column if not exists app_term_months integer
  check (app_term_months is null or app_term_months in (1,3,6,12));
alter table public.payment_orders add column if not exists app_fulfilled_at timestamptz;

alter table public.payment_orders drop constraint if exists payment_orders_product_kind_check;
alter table public.payment_orders add constraint payment_orders_product_kind_check check
  (product_kind in ('stickers','program','program_license','cell_print_program','cell_print_license','cell_print_bundle','individual_stickers','app_subscription'));

alter table public.payment_orders drop constraint if exists payment_orders_product_quantity_check;
alter table public.payment_orders add constraint payment_orders_product_quantity_check check (
  (product_kind='stickers' and range_quantity+custom_quantity>0)
  or (product_kind in ('program','program_license','cell_print_program','cell_print_license','cell_print_bundle','individual_stickers','app_subscription')
      and range_quantity=0 and custom_quantity=0)
);

-- Месячная квота стикеров Про выдаётся обычным кодом генераций владельца:
-- генератор, PDF и история уже умеют с ним работать. Код живёт одно окно.
alter table public.sticker_access_codes add column if not exists app_subscription_id uuid
  references public.app_subscriptions(id) on delete set null;
alter table public.sticker_access_codes add column if not exists app_window_start timestamptz;
create unique index if not exists sticker_access_codes_app_window_idx
  on public.sticker_access_codes(app_subscription_id, app_window_start) where app_subscription_id is not null;

alter table public.app_subscriptions enable row level security;
alter table public.app_devices enable row level security;
alter table public.app_usage enable row level security;
alter table public.app_login_requests enable row level security;

drop policy if exists app_subscriptions_own on public.app_subscriptions;
create policy app_subscriptions_own on public.app_subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists app_devices_own on public.app_devices;
create policy app_devices_own on public.app_devices for select to authenticated using (user_id = auth.uid());
drop policy if exists app_usage_own on public.app_usage;
create policy app_usage_own on public.app_usage for select to authenticated using (user_id = auth.uid());

-- Текущий отрезок подписки.
create or replace function public.app_current_subscription(p_user uuid)
returns public.app_subscriptions language sql stable security definer set search_path=public as $$
  select * from public.app_subscriptions
   where user_id = p_user and not canceled and starts_at <= now() and ends_at > now()
   order by starts_at desc limit 1;
$$;

-- Начало текущего месячного окна отрезка.
create or replace function public.app_window_start(p_starts timestamptz)
returns timestamptz language sql stable as $$
  select p_starts + make_interval(months =>
    (extract(year from age(now(), p_starts))::int * 12 + extract(month from age(now(), p_starts))::int));
$$;

-- Всё, что нужно программе и кабинету: тариф, срок, лимиты окна, пакеты.
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
begin
  select coalesce(sum(greatest(usage_limit - used, 0)), 0) into packs
    from public.license_keys where owner_user_id = p_user and active;
  sub := public.app_current_subscription(p_user);
  if sub.id is null then
    return jsonb_build_object('plan', null, 'packs_left', packs, 'device_limit', 1);
  end if;
  win := public.app_window_start(sub.starts_at);
  select coalesce(sum(amount) filter (where kind = 'code'), 0),
         coalesce(sum(amount) filter (where kind = 'sticker'), 0)
    into codes_used, stickers_used
    from public.app_usage
   where subscription_id = sub.id and source = 'quota' and created_at >= win;
  -- Стикеры квоты тратятся через код окна — считаем по нему.
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
    'packs_left', packs
  );
end;
$$;

-- Списание подбора кода: квота окна → пакеты (по старшинству). Атомарно.
create or replace function public.app_consume(p_user uuid, p_device uuid, p_kind text, p_amount integer, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  sub public.app_subscriptions;
  win timestamptz;
  used_now integer;
  pack public.license_keys;
begin
  if p_kind <> 'code' then raise exception 'UNSUPPORTED_KIND'; end if;
  if p_amount is null or p_amount <> 1 then raise exception 'INVALID_AMOUNT'; end if;
  perform pg_advisory_xact_lock(hashtext('app_consume:' || p_user::text));
  sub := public.app_current_subscription(p_user);
  if sub.id is not null then
    win := public.app_window_start(sub.starts_at);
    select coalesce(sum(amount), 0) into used_now from public.app_usage
     where subscription_id = sub.id and kind = 'code' and source = 'quota' and created_at >= win;
    if used_now + p_amount <= sub.codes_per_month then
      insert into public.app_usage(user_id, subscription_id, device_id, kind, amount, source, meta)
        values (p_user, sub.id, p_device, p_kind, p_amount, 'quota', coalesce(p_meta, '{}'::jsonb));
      return jsonb_build_object('source', 'quota');
    end if;
  end if;
  select * into pack from public.license_keys
   where owner_user_id = p_user and active and used + p_amount <= usage_limit
   order by created_at, id limit 1 for update;
  if pack.id is null then raise exception 'LIMIT_EXCEEDED'; end if;
  update public.license_keys set used = used + p_amount where id = pack.id;
  insert into public.app_usage(user_id, subscription_id, device_id, kind, amount, source, license_key_id, meta)
    values (p_user, sub.id, p_device, p_kind, p_amount, 'pack', pack.id, coalesce(p_meta, '{}'::jsonb));
  return jsonb_build_object('source', 'pack', 'key', pack.key);
end;
$$;

-- Код стикеров текущего окна Про: создаёт при первом обращении, гасит прошлые окна.
create or replace function public.app_sticker_quota_code(p_user uuid)
returns text language plpgsql security definer set search_path=public as $$
declare
  sub public.app_subscriptions;
  win timestamptz;
  found_code text;
  generated_code text;
begin
  perform pg_advisory_xact_lock(hashtext('app_stickers:' || p_user::text));
  update public.sticker_access_codes c set active = false
   where c.owner_user_id = p_user and c.app_subscription_id is not null and c.active
     and not exists (select 1 from public.app_subscriptions s
                      where s.id = c.app_subscription_id and not s.canceled
                        and s.starts_at <= now() and s.ends_at > now()
                        and public.app_window_start(s.starts_at) = c.app_window_start);
  sub := public.app_current_subscription(p_user);
  if sub.id is null or sub.stickers_per_month <= 0 then return null; end if;
  win := public.app_window_start(sub.starts_at);
  select code into found_code from public.sticker_access_codes
   where app_subscription_id = sub.id and app_window_start = win;
  if found_code is not null then return found_code; end if;
  loop
    generated_code := lpad(floor(random() * 1000000)::integer::text, 6, '0');
    begin
      insert into public.sticker_access_codes(code, name, active, generation_limit, owner_user_id, app_subscription_id, app_window_start)
        values (generated_code, 'Тариф Про · стикеры до ' || to_char(win + interval '1 month', 'DD.MM.YYYY'),
                true, sub.stickers_per_month, p_user, sub.id, win);
      exit;
    exception when unique_violation then null;
    end;
  end loop;
  return generated_code;
end;
$$;

-- Регистрация ПК при входе. Отключённый ПК можно вернуть, если есть место.
create or replace function public.app_register_device(p_user uuid, p_hash text, p_name text, p_version text)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  dev public.app_devices;
  lim integer;
  active_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('app_devices:' || p_user::text));
  lim := coalesce((public.app_current_subscription(p_user)).device_limit, 1);
  select * into dev from public.app_devices where user_id = p_user and device_hash = p_hash for update;
  if dev.id is not null and dev.revoked_at is null then
    update public.app_devices set last_seen_at = now(), name = left(coalesce(nullif(btrim(p_name), ''), name), 80),
           app_version = left(coalesce(p_version, ''), 32)
     where id = dev.id;
    return dev.id;
  end if;
  select count(*) into active_count from public.app_devices where user_id = p_user and revoked_at is null;
  if active_count >= lim then raise exception 'DEVICE_LIMIT'; end if;
  if dev.id is not null then
    update public.app_devices set revoked_at = null, last_seen_at = now(),
           name = left(coalesce(nullif(btrim(p_name), ''), name), 80), app_version = left(coalesce(p_version, ''), 32)
     where id = dev.id;
    return dev.id;
  end if;
  insert into public.app_devices(user_id, device_hash, name, app_version)
    values (p_user, p_hash, left(coalesce(nullif(btrim(p_name), ''), 'Компьютер'), 80), left(coalesce(p_version, ''), 32))
    returning id into dev.id;
  return dev.id;
end;
$$;

-- Оплаченный заказ подписки → отрезок. Идемпотентно по app_fulfilled_at.
create or replace function public.complete_app_subscription_order(p_order_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  order_row public.payment_orders;
  snap jsonb;
  cur public.app_subscriptions;
  rank_new integer;
  rank_cur integer;
  new_price numeric;
  last_row public.app_subscriptions;
  extra_days numeric := 0;
  r public.app_subscriptions;
  new_id uuid;
  term interval;
begin
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));
  select * into order_row from public.payment_orders
   where id = p_order_id and product_kind = 'app_subscription' for update;
  if not found then raise exception 'Subscription order not found'; end if;
  if order_row.app_fulfilled_at is not null then
    select id into new_id from public.app_subscriptions where source_order_id = p_order_id order by created_at desc limit 1;
    return new_id;
  end if;
  if order_row.user_id is null then raise exception 'Subscription requires an account'; end if;
  snap := order_row.pricing_snapshot -> 'app';
  if snap is null or order_row.app_plan is null or order_row.app_term_months is null then
    raise exception 'Invalid subscription order';
  end if;
  perform pg_advisory_xact_lock(hashtext('app_subs:' || order_row.user_id::text));
  term := make_interval(months => order_row.app_term_months);
  new_price := (snap->>'monthly_price')::numeric;
  rank_new := array_position(array['basic','standard','pro'], order_row.app_plan);
  cur := public.app_current_subscription(order_row.user_id);
  select * into last_row from public.app_subscriptions
   where user_id = order_row.user_id and not canceled and ends_at > now()
   order by ends_at desc limit 1;

  if cur.id is null and last_row.id is null then
    insert into public.app_subscriptions(user_id, plan, starts_at, ends_at, monthly_price, codes_per_month, stickers_per_month, device_limit, source_order_id)
      values (order_row.user_id, order_row.app_plan, now(), now() + term, new_price,
              (snap->>'codes')::int, (snap->>'stickers')::int, (snap->>'devices')::int, p_order_id)
      returning id into new_id;
  else
    rank_cur := array_position(array['basic','standard','pro'], coalesce(cur.plan, last_row.plan));
    if last_row.plan = order_row.app_plan and rank_new <= rank_cur then
      -- Продление того же тарифа (или уже стоящего в очереди).
      update public.app_subscriptions set ends_at = ends_at + term where id = last_row.id returning id into new_id;
    elsif rank_new > rank_cur then
      -- Повышение: остаток всех отрезков переводим в дни нового тарифа по цене.
      for r in select * from public.app_subscriptions
                where user_id = order_row.user_id and not canceled and ends_at > now() loop
        extra_days := extra_days
          + extract(epoch from (r.ends_at - greatest(r.starts_at, now()))) / 86400.0
            * r.monthly_price / greatest(new_price, 1);
        if r.starts_at <= now() then
          update public.app_subscriptions set ends_at = now() where id = r.id;
        else
          update public.app_subscriptions set canceled = true where id = r.id;
        end if;
      end loop;
      insert into public.app_subscriptions(user_id, plan, starts_at, ends_at, monthly_price, codes_per_month, stickers_per_month, device_limit, source_order_id)
        values (order_row.user_id, order_row.app_plan, now(),
                now() + term + make_interval(days => floor(extra_days)::int), new_price,
                (snap->>'codes')::int, (snap->>'stickers')::int, (snap->>'devices')::int, p_order_id)
        returning id into new_id;
    else
      -- Понижение: новый отрезок после последнего оплаченного.
      insert into public.app_subscriptions(user_id, plan, starts_at, ends_at, monthly_price, codes_per_month, stickers_per_month, device_limit, source_order_id)
        values (order_row.user_id, order_row.app_plan, last_row.ends_at, last_row.ends_at + term, new_price,
                (snap->>'codes')::int, (snap->>'stickers')::int, (snap->>'devices')::int, p_order_id)
        returning id into new_id;
    end if;
  end if;

  update public.payment_orders set app_fulfilled_at = now(), status = 'succeeded',
         paid_at = coalesce(paid_at, now()), updated_at = now()
   where id = p_order_id;
  return new_id;
end;
$$;

revoke all on function public.app_current_subscription(uuid) from public, anon, authenticated;
revoke all on function public.app_entitlements(uuid) from public, anon, authenticated;
revoke all on function public.app_consume(uuid,uuid,text,integer,jsonb) from public, anon, authenticated;
revoke all on function public.app_sticker_quota_code(uuid) from public, anon, authenticated;
revoke all on function public.app_register_device(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.complete_app_subscription_order(uuid) from public, anon, authenticated;
grant execute on function public.app_current_subscription(uuid) to service_role;
grant execute on function public.app_entitlements(uuid) to service_role;
grant execute on function public.app_consume(uuid,uuid,text,integer,jsonb) to service_role;
grant execute on function public.app_sticker_quota_code(uuid) to service_role;
grant execute on function public.app_register_device(uuid,text,text,text) to service_role;
grant execute on function public.complete_app_subscription_order(uuid) to service_role;

commit;
