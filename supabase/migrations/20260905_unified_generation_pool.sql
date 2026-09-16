begin;

-- ============================================================
-- 1. Единый пул генераций
-- ============================================================
-- Четыре пары лимитов (товары/коробки × массово/по номеру) оказались ловушкой:
-- человек видел «осталось 40», а генератор отвечал «лимит исчерпан», потому что
-- эти 40 лежали в другом ведре. Теперь счётчик один: любая генерация — товарный
-- стикер или QR коробки, пачкой или по номеру — тратит из него по единице за штуку.
-- Цена за штуку у всех четырёх видов и так была одинаковая, так что разделение
-- не давало ничего, кроме путаницы.
--
-- Старые четыре пары НЕ удаляем: в этом репозитории ещё ни разу не удаляли
-- колонку, а здесь они вдобавок единственный след состава прошлых покупок. Они
-- замораживаются — после этой миграции их не пишет ни одна функция и ни один
-- эндпоинт. Их CHECK'и (used <= limit) остаются и ничему не мешают: обе стороны
-- неравенства перестают меняться.

-- Перенос исторических значений должен выполниться ровно один раз. Если
-- колонки уже существуют, повторный ручной запуск мог бы вернуть полностью
-- потраченный остаток из замороженных старых счётчиков.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'sticker_access_codes'
       and column_name in ('generation_limit', 'generation_used')
  ) then
    raise exception '20260905_unified_generation_pool has already been applied';
  end if;
end $$;

alter table public.sticker_access_codes
  add column generation_limit integer not null default 0
  check (generation_limit >= 0);
alter table public.sticker_access_codes
  add column generation_used integer not null default 0
  check (generation_used >= 0 and generation_used <= generation_limit);

-- Новые покупки снова получают шесть цифр. Формат STK оставляем в CHECK только
-- ради уже выданных в короткий переходный период кодов — они не должны сломаться.
alter table public.sticker_access_codes
  drop constraint if exists sticker_access_codes_code_check;
alter table public.sticker_access_codes
  add constraint sticker_access_codes_code_check check (
    code ~ '^([0-9]{6}|STK-[A-F0-9]{32})$'
  );

-- Дефолт «10» тянется с самой первой миграции. Новый код доступа не должен
-- получать фантомные генерации в замороженных колонках.
alter table public.sticker_access_codes
  alter column range_generation_limit set default 0,
  alter column custom_generation_limit set default 0;

-- Перенос остатков. Никто ничего не теряет: складываем и лимиты, и использованное.
-- В каждой паре used <= limit, значит sum(used) <= sum(limit), и новый CHECK
-- выполним на любых данных. Защита выше запрещает повторный ручной запуск.
update public.sticker_access_codes
   set generation_limit = range_generation_limit + custom_generation_limit
                        + box_range_generation_limit + box_custom_generation_limit,
       generation_used  = range_generation_used  + custom_generation_used
                        + box_range_generation_used  + box_custom_generation_used
 where generation_limit = 0 and generation_used = 0;

-- Мёртвый спендер по старым парам: не вызывается ни из api/, ни из js/, но пока
-- он существует, любой новый вызов списал бы мимо общего пула.
drop function if exists public.consume_sticker_access(text, text, integer);

-- ============================================================
-- 2. Функции, которые тратят квоту
-- ============================================================

create or replace function public.allocate_return_stickers(
  p_quantity integer,
  p_requester_hash text,
  p_access_code text default null
)
returns table(batch_id uuid, code text, free_remaining integer)
language plpgsql security definer set search_path = public as $$
declare
  new_batch uuid;
  available_count integer;
  used_free integer;
  normalized_access_code text;
  access_updated integer;
begin
  if p_quantity < 1 or p_quantity > 500 or length(p_requester_hash) <> 64 then
    raise exception 'Invalid allocation request';
  end if;

  normalized_access_code := nullif(btrim(coalesce(p_access_code, '')), '');
  perform pg_advisory_xact_lock(hashtext(p_requester_hash));
  perform pg_advisory_xact_lock(hashtext('return_sticker_pool'));

  -- Бесплатный первый стикер считается как раньше — по строкам партий с
  -- access_code is null, отдельно на категорию и режим. Объединение пула его
  -- намеренно НЕ касается: это не забытый кусок, а решение.
  if normalized_access_code is null then
    select coalesce(sum(b.quantity), 0)::integer into used_free
      from public.return_sticker_batches b
     where b.requester_hash = p_requester_hash
       and b.access_code is null
       and b.generation_kind = 'range';
    if used_free + p_quantity > 1 then raise exception 'Sticker access code required'; end if;
  elsif not exists (
    select 1 from public.sticker_access_codes a
     where a.code = normalized_access_code and a.active
  ) then
    raise exception 'Invalid sticker access code';
  else
    update public.sticker_access_codes a
       set generation_used = a.generation_used + p_quantity
     where a.code = normalized_access_code
       and a.active
       and a.generation_used + p_quantity <= a.generation_limit;
    get diagnostics access_updated = row_count;
    if access_updated = 0 then raise exception 'Access code limit exceeded'; end if;
  end if;

  -- Квота списывается до выборки номеров из пула: если пул пуст, вся транзакция
  -- откатывается и списание отменяется вместе с ней.
  select count(*) into available_count
    from (
      select 1 from public.return_sticker_codes c
       where c.batch_id is null
       limit p_quantity
    ) available;
  if available_count < p_quantity then raise exception 'Not enough unused sticker codes'; end if;

  insert into public.return_sticker_batches(quantity, requester_hash, access_code, generation_kind)
  values (p_quantity, p_requester_hash, normalized_access_code, 'range')
  returning id into new_batch;

  return query
    with selected as (
      select c.code from public.return_sticker_codes c
       where c.batch_id is null
       order by c.code
       limit p_quantity
       for update skip locked
    ), updated as (
      update public.return_sticker_codes c
         set batch_id = new_batch, allocated_at = now()
        from selected s
       where c.code = s.code
      returning c.code
    )
    select new_batch, updated.code::text,
      case when normalized_access_code is null then greatest(1 - used_free - p_quantity, 0) else 0 end
      from updated order by updated.code;
end;
$$;

revoke all on function public.allocate_return_stickers(integer, text, text) from public, anon, authenticated;
grant execute on function public.allocate_return_stickers(integer, text, text) to service_role;

create or replace function public.authorize_custom_sticker(
  p_requester_hash text,
  p_access_code text default null
)
returns table(batch_id uuid, free_remaining integer)
language plpgsql security definer set search_path = public as $$
declare
  new_batch uuid;
  used_free integer;
  normalized_access_code text;
  access_updated integer;
begin
  if length(p_requester_hash) <> 64 then raise exception 'Invalid allocation request'; end if;
  normalized_access_code := nullif(btrim(coalesce(p_access_code, '')), '');
  perform pg_advisory_xact_lock(hashtext(p_requester_hash));

  if normalized_access_code is null then
    select coalesce(sum(b.quantity), 0)::integer into used_free
      from public.return_sticker_batches b
     where b.requester_hash = p_requester_hash
       and b.access_code is null
       and b.generation_kind = 'custom';
    if used_free + 1 > 1 then raise exception 'Sticker access code required'; end if;
  elsif not exists (
    select 1 from public.sticker_access_codes a
     where a.code = normalized_access_code and a.active
  ) then
    raise exception 'Invalid sticker access code';
  else
    update public.sticker_access_codes a
       set generation_used = a.generation_used + 1
     where a.code = normalized_access_code
       and a.active
       and a.generation_used < a.generation_limit;
    get diagnostics access_updated = row_count;
    if access_updated = 0 then raise exception 'Access code limit exceeded'; end if;
  end if;

  insert into public.return_sticker_batches(quantity, requester_hash, access_code, generation_kind)
  values (1, p_requester_hash, normalized_access_code, 'custom')
  returning id into new_batch;

  return query select new_batch, 0;
end;
$$;

revoke all on function public.authorize_custom_sticker(text, text) from public, anon, authenticated;
grant execute on function public.authorize_custom_sticker(text, text) to service_role;

-- ВНИМАНИЕ: у этой функции `code` — выходной параметр (returns table(... code text ...)),
-- поэтому КАЖДАЯ ссылка на sticker_access_codes.code обязана быть с алиасом. В
-- 20260826 алиасов не было, и платная массовая генерация QR коробок падала с
-- «column reference "code" is ambiguous» — работала только бесплатная ветка.
create or replace function public.allocate_return_box_codes(
  p_quantity integer,
  p_requester_hash text,
  p_access_code text default null,
  p_prefix text default 'TRBX'
)
returns table(batch_id uuid, code text, free_remaining integer)
language plpgsql security definer set search_path = public as $$
declare
  new_batch uuid;
  available_count integer;
  used_free integer;
  normalized_access text;
  normalized_prefix text;
  changed integer;
begin
  normalized_access := nullif(btrim(coalesce(p_access_code, '')), '');
  normalized_prefix := upper(btrim(coalesce(p_prefix, 'TRBX')));
  if p_quantity < 1 or p_quantity > 500 or length(p_requester_hash) <> 64
     or normalized_prefix !~ '^[A-Z0-9_-]{1,12}$' then
    raise exception 'Invalid box allocation request';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_requester_hash));
  perform pg_advisory_xact_lock(hashtext('return_box_pool'));

  if normalized_access is null then
    select coalesce(sum(b.quantity), 0)::integer into used_free
      from public.return_box_batches b
     where b.requester_hash = p_requester_hash
       and b.access_code is null
       and b.generation_kind = 'range';
    if used_free + p_quantity > 1 then raise exception 'Sticker access code required'; end if;
  elsif not exists (
    select 1 from public.sticker_access_codes a
     where a.code = normalized_access and a.active
  ) then
    raise exception 'Invalid sticker access code';
  else
    update public.sticker_access_codes a
       set generation_used = a.generation_used + p_quantity
     where a.code = normalized_access
       and a.active
       and a.generation_used + p_quantity <= a.generation_limit;
    get diagnostics changed = row_count;
    if changed = 0 then raise exception 'Access code limit exceeded'; end if;
  end if;

  select count(*) into available_count
    from (
      select 1 from public.return_box_codes c
       where c.batch_id is null
       limit p_quantity
    ) available;
  if available_count < p_quantity then raise exception 'Not enough unused box codes'; end if;

  insert into public.return_box_batches(quantity, requester_hash, access_code, prefix, generation_kind)
  values (p_quantity, p_requester_hash, normalized_access, normalized_prefix, 'range')
  returning id into new_batch;

  return query
    with selected as (
      select c.code from public.return_box_codes c
       where c.batch_id is null
       order by c.code
       limit p_quantity
       for update skip locked
    ), updated as (
      update public.return_box_codes c
         set batch_id = new_batch, allocated_at = now()
        from selected s
       where c.code = s.code
      returning c.code
    )
    select new_batch, updated.code::text,
      case when normalized_access is null then greatest(1 - used_free - p_quantity, 0) else 0 end
      from updated order by updated.code;
end;
$$;

revoke all on function public.allocate_return_box_codes(integer, text, text, text) from public, anon, authenticated;
grant execute on function public.allocate_return_box_codes(integer, text, text, text) to service_role;

create or replace function public.authorize_box_custom_sticker(
  p_requester_hash text,
  p_access_code text default null
)
returns table(batch_id uuid, free_remaining integer)
language plpgsql security definer set search_path = public as $$
declare
  new_batch uuid;
  used_free integer;
  normalized text;
  changed integer;
begin
  if length(p_requester_hash) <> 64 then raise exception 'Invalid allocation request'; end if;
  normalized := nullif(btrim(coalesce(p_access_code, '')), '');
  perform pg_advisory_xact_lock(hashtext(p_requester_hash));

  if normalized is null then
    select coalesce(sum(b.quantity), 0)::integer into used_free
      from public.return_box_batches b
     where b.requester_hash = p_requester_hash
       and b.access_code is null
       and b.generation_kind = 'custom';
    if used_free + 1 > 1 then raise exception 'Sticker access code required'; end if;
  elsif not exists (
    select 1 from public.sticker_access_codes a
     where a.code = normalized and a.active
  ) then
    raise exception 'Invalid sticker access code';
  else
    update public.sticker_access_codes a
       set generation_used = a.generation_used + 1
     where a.code = normalized
       and a.active
       and a.generation_used < a.generation_limit;
    get diagnostics changed = row_count;
    if changed = 0 then raise exception 'Access code limit exceeded'; end if;
  end if;

  insert into public.return_box_batches(quantity, requester_hash, access_code, prefix, generation_kind)
  values (1, p_requester_hash, normalized, 'TRBX', 'custom')
  returning id into new_batch;

  return query select new_batch, 0;
end;
$$;

revoke all on function public.authorize_box_custom_sticker(text, text) from public, anon, authenticated;
grant execute on function public.authorize_box_custom_sticker(text, text) to service_role;

-- ============================================================
-- 3. Пополнение существующего кода
-- ============================================================
-- Механика та же, что у продления лицензий из 20260904: заказ несёт
-- renewal_target_key, и функция исполнения не создаёт новый актив, а
-- увеличивает лимит существующего.

alter table public.payment_orders
  drop constraint if exists payment_orders_renewal_target_kind_check;
alter table public.payment_orders
  add constraint payment_orders_renewal_target_kind_check check (
    renewal_target_key is null
    or product_kind in ('program_license', 'cell_print_license', 'stickers')
  );

-- Один код теперь фигурирует в нескольких заказах: первый его создаёт, следующие
-- пополняют. UNIQUE на access_code это запрещал. Внешний ключ на
-- sticker_access_codes(code) не пострадает: он опирается на уникальный индекс
-- ссылаемой таблицы, а не на этот.
alter table public.payment_orders
  drop constraint if exists payment_orders_access_code_key;
create index if not exists payment_orders_access_code_idx
  on public.payment_orders(access_code)
  where access_code is not null;

create or replace function public.complete_payment_order(p_order_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  order_row public.payment_orders;
  target_row public.sticker_access_codes;
  generated_code text;
  units integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));
  select * into order_row from public.payment_orders
    where id = p_order_id and product_kind = 'stickers' for update;
  if not found then raise exception 'Order not found'; end if;

  -- Маркер исполнения — сам access_code заказа. Отдельного *_fulfilled_at, как у
  -- лицензий, не нужно: до исполнения он null и у новой покупки, и у пополнения
  -- (цель пополнения лежит в renewal_target_key), а проставляется он в той же
  -- транзакции, что и начисление. Ничто не имеет права проставлять access_code
  -- раньше начисления — на этом держится защита от повторного webhook.
  if order_row.access_code is not null then return order_row.access_code; end if;

  -- Пакет ложится в общий счётчик. Старые заказы, где в одном заказе было два
  -- пакета, складываются: столько же единиц, но уже универсальных.
  units := coalesce(order_row.range_quantity, 0) + coalesce(order_row.custom_quantity, 0);
  if units < 1 then raise exception 'Invalid sticker package'; end if;

  if order_row.renewal_target_key is not null then
    if order_row.user_id is null then raise exception 'Renewal requires an account'; end if;
    select * into target_row from public.sticker_access_codes a
      where a.code = btrim(order_row.renewal_target_key)
        and a.owner_user_id = order_row.user_id
        and a.active
      for update;
    if not found then raise exception 'Renewal target is unavailable'; end if;

    update public.sticker_access_codes
       set generation_limit = generation_limit + units
     where id = target_row.id;

    update public.payment_orders set
      access_code = target_row.code,
      status = 'succeeded', paid_at = coalesce(paid_at, now()), updated_at = now()
      where id = p_order_id;
    return target_row.code;
  end if;

  -- owner_user_id намеренно не проставляем: это делает триггер
  -- payment_order_accounting при переходе заказа в succeeded.
  loop
    generated_code := lpad(floor(random() * 1000000)::integer::text, 6, '0');
    begin
      insert into public.sticker_access_codes(code, name, active, generation_limit)
        values (generated_code, 'Пакет генераций ' || p_order_id, true, units);
      exit;
    exception when unique_violation then null;
    end;
  end loop;

  update public.payment_orders set
    access_code = generated_code,
    status = 'succeeded', paid_at = coalesce(paid_at, now()), updated_at = now()
    where id = p_order_id;
  return generated_code;
end;
$$;

revoke all on function public.complete_payment_order(uuid) from public, anon, authenticated;
grant execute on function public.complete_payment_order(uuid) to service_role;

-- Не полагаемся на имя автоограничения: если UNIQUE(access_code) почему-либо
-- осталось под другим именем, останавливаем миграцию до первого боевого пополнения.
do $$
begin
  if exists (
    select 1 from pg_constraint c
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
    where c.conrelid='public.payment_orders'::regclass and c.contype='u' and a.attname='access_code'
  ) then raise exception 'UNIQUE constraint on payment_orders.access_code still exists'; end if;
  if exists(select 1 from public.sticker_access_codes where generation_used>generation_limit)
    then raise exception 'Unified generation pool integrity check failed'; end if;
end $$;

commit;
