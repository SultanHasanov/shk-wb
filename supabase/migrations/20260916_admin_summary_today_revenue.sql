begin;

-- ============================================================
-- Выручка за сегодня в сводке админки
-- ============================================================
-- В admin_user_summary были только «всего» и «за 30 дней»: чтобы узнать кассу
-- за текущий день, приходилось открывать раздел оплаты и складывать заказы
-- глазами. Добавляем todayKopecks/todayOrders и вчерашний день для сравнения.
--
-- Границы суток считаем в Europe/Moscow, как и график регистраций выше по
-- этому же запросу: по UTC «сегодня» начиналось бы в три часа ночи по Москве.
create or replace function public.admin_user_summary()
returns jsonb
language sql
stable
security definer
set search_path=public,auth
as $$
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'users', count(*),
        'confirmed', count(*) filter (where email_confirmed_at is not null),
        'telegramOnly', count(*) filter (where coalesce(email, '') like '%@users.invalid'),
        'banned', count(*) filter (where coalesce(banned_until, to_timestamp(0)) > now()),
        'new7', count(*) filter (where created_at > now() - interval '7 days'),
        'new30', count(*) filter (where created_at > now() - interval '30 days'),
        'active7', count(*) filter (where last_sign_in_at > now() - interval '7 days'),
        'active30', count(*) filter (where last_sign_in_at > now() - interval '30 days')
      ) from auth.users
    ),
    'registrations', jsonb_build_object(
      'days', coalesce((
        select jsonb_agg(jsonb_build_object('day', d, 'count', c) order by d)
        from (
          select (created_at at time zone 'Europe/Moscow')::date as d, count(*) as c
            from auth.users where created_at > now() - interval '90 days'
           group by 1
        ) x
      ), '[]'::jsonb),
      'weeks', coalesce((
        select jsonb_agg(jsonb_build_object('week', w, 'count', c) order by w)
        from (
          select date_trunc('week', created_at at time zone 'Europe/Moscow')::date as w, count(*) as c
            from auth.users where created_at > now() - interval '52 weeks'
           group by 1
        ) x
      ), '[]'::jsonb)
    ),
    'revenue', (
      -- amount — это касса после списания реферального баланса, gross_amount — цена
      -- до него. Обе величины нужны: первая сходится с ЮKassa, вторая показывает оборот.
      select jsonb_build_object(
        'paidOrders', count(*),
        'payingUsers', count(distinct user_id) filter (where user_id is not null),
        'amountKopecks', coalesce(sum(round(amount * 100)), 0),
        'grossKopecks', coalesce(sum(round(coalesce(gross_amount, amount) * 100)), 0),
        'refundedKopecks', coalesce(sum(refunded_kopecks), 0),
        'referralCreditKopecks', coalesce(sum(referral_credit_kopecks), 0),
        'last30Kopecks', coalesce(sum(round(amount * 100)) filter (where coalesce(paid_at, created_at) > now() - interval '30 days'), 0),
        'todayKopecks', coalesce(sum(round(amount * 100)) filter (
          where (coalesce(paid_at, created_at) at time zone 'Europe/Moscow')::date
              = (now() at time zone 'Europe/Moscow')::date
        ), 0),
        'todayOrders', count(*) filter (
          where (coalesce(paid_at, created_at) at time zone 'Europe/Moscow')::date
              = (now() at time zone 'Europe/Moscow')::date
        ),
        'yesterdayKopecks', coalesce(sum(round(amount * 100)) filter (
          where (coalesce(paid_at, created_at) at time zone 'Europe/Moscow')::date
              = (now() at time zone 'Europe/Moscow')::date - 1
        ), 0),
        'byKind', coalesce((
          select jsonb_agg(jsonb_build_object('kind', kind, 'orders', orders, 'amountKopecks', amount_kopecks) order by amount_kopecks desc)
          from (
            select product_kind as kind, count(*) as orders, coalesce(sum(round(amount * 100)), 0) as amount_kopecks
              from public.payment_orders where status = 'succeeded' group by 1
          ) y
        ), '[]'::jsonb)
      ) from public.payment_orders where status = 'succeeded'
    ),
    'generations', (
      select jsonb_build_object(
        'codes', count(*),
        'owned', count(*) filter (where owner_user_id is not null),
        'limit', coalesce(sum(generation_limit), 0),
        'used', coalesce(sum(generation_used), 0)
      ) from public.sticker_access_codes
    ),
    'assets', jsonb_build_object(
      'programKeys', (select count(*) from public.license_keys),
      'cellLicenses', (select count(*) from public.cell_print_licenses),
      'cellActive', (select count(*) from public.cell_print_licenses where active and (expires_at is null or expires_at > now())),
      'cellDevices', (select count(*) from public.cell_print_activations)
    ),
    'referrals', jsonb_build_object(
      'accounts', (select count(*) from public.referral_accounts),
      'attributions', (select count(*) from public.referral_attributions),
      'earnedKopecks', (select coalesce(sum(earned_kopecks), 0) from public.referral_accounts),
      'availableKopecks', (select coalesce(sum(available_kopecks), 0) from public.referral_accounts),
      'paidKopecks', (select coalesce(sum(paid_kopecks), 0) from public.referral_accounts),
      'pendingWithdrawals', (select count(*) from public.referral_withdrawals where status = 'pending')
    )
  );
$$;

-- create or replace сбрасывает права не всегда, но повторить дешевле, чем
-- однажды отдать почты всех пользователей владельцу публичного ключа.
revoke all on function public.admin_user_summary() from public, anon, authenticated;
grant execute on function public.admin_user_summary() to service_role;

commit;
