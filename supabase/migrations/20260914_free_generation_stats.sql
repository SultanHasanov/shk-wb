begin;

-- ============================================================
-- Статистика бесплатных генераций для админки
-- ============================================================
-- Первая генерация бесплатна: партия пишется с access_code is null. До сих пор
-- этот факт нигде не считался — админка видела только израсходованные лимиты
-- оплаченных кодов, то есть ровно ту часть, за которую заплатили.
--
-- Важное свойство схемы, которое видно в цифрах: бесплатная квота проверяется
-- отдельно на каждую пару «таблица × generation_kind» (см. 20260905), поэтому
-- один и тот же requester_hash может иметь до четырёх бесплатных партий:
-- товарные пачкой, товарные по номеру, коробки пачкой, коробки по номеру.
-- Поэтому «visitors» и «codes» расходятся, и это не ошибка подсчёта.
--
-- requester_hash — HMAC от IP-адреса (server/_stickers.js), а не от человека:
-- за одним хешем стоит один выходной IP, а не один пользователь.

-- Частичные индексы под фильтр access_code is null: обычные индексы по
-- (requester_hash, created_at) уже есть, но они не помогают выборке «все
-- бесплатные партии за период», которая и лежит в основе этой статистики.
create index if not exists return_sticker_batches_free_idx
  on public.return_sticker_batches (created_at desc)
  where access_code is null;

create index if not exists return_box_batches_free_idx
  on public.return_box_batches (created_at desc)
  where access_code is null;

create or replace function public.admin_free_generation_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with free_batches as (
    select 'product'::text as category, b.generation_kind as mode,
           b.quantity, b.requester_hash, b.created_at
      from public.return_sticker_batches b
     where b.access_code is null
    union all
    select 'box'::text, b.generation_kind, b.quantity, b.requester_hash, b.created_at
      from public.return_box_batches b
     where b.access_code is null
  ),
  -- Кто после бесплатной пробы генерировал уже по коду доступа, то есть купил.
  paid_hashes as (
    select b.requester_hash from public.return_sticker_batches b where b.access_code is not null
    union
    select b.requester_hash from public.return_box_batches b where b.access_code is not null
  )
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'codes', coalesce(sum(quantity), 0),
        'batches', count(*),
        'visitors', count(distinct requester_hash),
        'last24h', coalesce(sum(quantity) filter (where created_at > now() - interval '24 hours'), 0),
        'last7d', coalesce(sum(quantity) filter (where created_at > now() - interval '7 days'), 0),
        'last30d', coalesce(sum(quantity) filter (where created_at > now() - interval '30 days'), 0),
        'newVisitors30d', count(distinct requester_hash) filter (where created_at > now() - interval '30 days'),
        'lastAt', max(created_at)
      ) from free_batches
    ),
    'byKind', coalesce((
      select jsonb_agg(jsonb_build_object(
        'category', category, 'mode', mode, 'codes', codes, 'visitors', visitors
      ) order by codes desc)
      from (
        select category, mode,
               coalesce(sum(quantity), 0) as codes,
               count(distinct requester_hash) as visitors
          from free_batches group by 1, 2
      ) k
    ), '[]'::jsonb),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', d, 'codes', c, 'visitors', v) order by d desc)
      from (
        select (created_at at time zone 'Europe/Moscow')::date as d,
               coalesce(sum(quantity), 0) as c,
               count(distinct requester_hash) as v
          from free_batches
         where created_at > now() - interval '90 days'
         group by 1
      ) x
    ), '[]'::jsonb),
    'conversion', (
      select jsonb_build_object(
        'freeVisitors', count(*),
        'converted', count(*) filter (where converted)
      )
      from (
        -- distinct, а не group by: признак покупки однозначно определяется хешем,
        -- поэтому на каждый хеш остаётся ровно одна строка.
        select distinct f.requester_hash,
               f.requester_hash in (select p.requester_hash from paid_hashes p) as converted
          from free_batches f
      ) c
    )
  );
$$;

revoke all on function public.admin_free_generation_stats() from public, anon, authenticated;
grant execute on function public.admin_free_generation_stats() to service_role;

commit;
