-- Постоянная надбавка ПК для аккаунта «Помощника ПВЗ».
-- Лимит ПК живёт в каждой строке app_subscriptions (снимок тарифа), и при продлении новая строка
-- получает тарифный лимит заново — разовая правка подписки пропадает. Надбавка хранится отдельно
-- и прибавляется сервером к лимиту тарифа (или к 1 ПК без тарифа) при каждом расчёте.
-- Выдаёт админ вручную (строкой в таблице), клиентам таблица не видна.

create table if not exists public.app_device_bonuses (
  user_id uuid primary key references auth.users(id) on delete cascade,
  devices integer not null check (devices between 1 and 20),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.app_device_bonuses enable row level security;
revoke all on table public.app_device_bonuses from anon, authenticated;
grant all on table public.app_device_bonuses to service_role;

-- app_entitlements: всё как в 20261020 + поле device_bonus (в обеих ветках: с подпиской и без).
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
  bonus integer;
begin
  select coalesce(sum(greatest(usage_limit - used, 0)), 0) into packs
    from public.license_keys where owner_user_id = p_user and active;
  select coalesce(jsonb_object_agg(a.addon, jsonb_build_object('ends_at', a.ends_at)), '{}'::jsonb) into addons
    from (select addon, max(ends_at) as ends_at from public.app_addons
           where user_id = p_user and not canceled and starts_at <= now() and ends_at > now()
           group by addon) a;
  select coalesce(max(devices), 0) into bonus from public.app_device_bonuses where user_id = p_user;
  sub := public.app_current_subscription(p_user);
  if sub.id is null then
    return jsonb_build_object('plan', null, 'packs_left', packs, 'device_limit', 1, 'addons', addons,
                              'device_bonus', bonus);
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
    'addons', addons,
    'device_bonus', bonus
  );
end;
$$;

revoke all on function public.app_entitlements(uuid) from public, anon, authenticated;
grant execute on function public.app_entitlements(uuid) to service_role;
