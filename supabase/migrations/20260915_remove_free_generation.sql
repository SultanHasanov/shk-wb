begin;

-- ============================================================
-- Бесплатная первая генерация отменена
-- ============================================================
-- До сих пор партия с access_code is null означала «первый раз бесплатно»:
-- квота считалась отдельно на каждую пару «таблица × generation_kind», поэтому
-- с одного requester_hash можно было получить до четырёх бесплатных кодов
-- (см. 20260905). Теперь генерация без действующего кода доступа невозможна.
--
-- Сообщение об ошибке оставлено прежним — 'Sticker access code required':
-- server/_sticker-generation.js уже переводит его в ACCESS_CODE_REQUIRED и
-- понятный текст «Требуется пакет генераций», и менять эту цепочку незачем.
--
-- Исторические строки с access_code is null НЕ удаляются: это единственный след
-- прошлых бесплатных генераций, на них построена статистика в админке
-- (admin_free_generation_stats из 20260914). Новых таких строк не появится.
--
-- Функции пересоздаются через drop, а не create or replace: из результата
-- уходит колонка free_remaining, а сменить возвращаемый тип заменой нельзя.
-- Единственный вызывающий код — server/_sticker-generation.js.

drop function if exists public.allocate_return_stickers(integer, text, text);
drop function if exists public.authorize_custom_sticker(text, text);
drop function if exists public.allocate_return_box_codes(integer, text, text, text);
drop function if exists public.authorize_box_custom_sticker(text, text);

-- ------------------------------------------------------------
-- Товарные стикеры, пачкой
-- ------------------------------------------------------------
create function public.allocate_return_stickers(
  p_quantity integer,
  p_requester_hash text,
  p_access_code text default null
)
returns table(batch_id uuid, code text)
language plpgsql security definer set search_path = public as $$
declare
  new_batch uuid;
  available_count integer;
  normalized_access_code text;
  access_updated integer;
begin
  if p_quantity < 1 or p_quantity > 500 or length(p_requester_hash) <> 64 then
    raise exception 'Invalid allocation request';
  end if;

  normalized_access_code := nullif(btrim(coalesce(p_access_code, '')), '');
  if normalized_access_code is null then raise exception 'Sticker access code required'; end if;

  perform pg_advisory_xact_lock(hashtext(p_requester_hash));
  perform pg_advisory_xact_lock(hashtext('return_sticker_pool'));

  if not exists (
    select 1 from public.sticker_access_codes a
     where a.code = normalized_access_code and a.active
  ) then
    raise exception 'Invalid sticker access code';
  end if;

  update public.sticker_access_codes a
     set generation_used = a.generation_used + p_quantity
   where a.code = normalized_access_code
     and a.active
     and a.generation_used + p_quantity <= a.generation_limit;
  get diagnostics access_updated = row_count;
  if access_updated = 0 then raise exception 'Access code limit exceeded'; end if;

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
    select new_batch, updated.code::text from updated order by updated.code;
end;
$$;

revoke all on function public.allocate_return_stickers(integer, text, text) from public, anon, authenticated;
grant execute on function public.allocate_return_stickers(integer, text, text) to service_role;

-- ------------------------------------------------------------
-- Товарный стикер по конкретному номеру
-- ------------------------------------------------------------
create function public.authorize_custom_sticker(
  p_requester_hash text,
  p_access_code text default null
)
returns table(batch_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  new_batch uuid;
  normalized_access_code text;
  access_updated integer;
begin
  if length(p_requester_hash) <> 64 then raise exception 'Invalid allocation request'; end if;
  normalized_access_code := nullif(btrim(coalesce(p_access_code, '')), '');
  if normalized_access_code is null then raise exception 'Sticker access code required'; end if;

  perform pg_advisory_xact_lock(hashtext(p_requester_hash));

  if not exists (
    select 1 from public.sticker_access_codes a
     where a.code = normalized_access_code and a.active
  ) then
    raise exception 'Invalid sticker access code';
  end if;

  update public.sticker_access_codes a
     set generation_used = a.generation_used + 1
   where a.code = normalized_access_code
     and a.active
     and a.generation_used < a.generation_limit;
  get diagnostics access_updated = row_count;
  if access_updated = 0 then raise exception 'Access code limit exceeded'; end if;

  insert into public.return_sticker_batches(quantity, requester_hash, access_code, generation_kind)
  values (1, p_requester_hash, normalized_access_code, 'custom')
  returning id into new_batch;

  return query select new_batch;
end;
$$;

revoke all on function public.authorize_custom_sticker(text, text) from public, anon, authenticated;
grant execute on function public.authorize_custom_sticker(text, text) to service_role;

-- ------------------------------------------------------------
-- QR коробок, пачкой
-- ВНИМАНИЕ: `code` — выходной параметр, поэтому каждая ссылка на
-- sticker_access_codes.code обязана быть с алиасом (история из 20260826).
-- ------------------------------------------------------------
create function public.allocate_return_box_codes(
  p_quantity integer,
  p_requester_hash text,
  p_access_code text default null,
  p_prefix text default 'TRBX'
)
returns table(batch_id uuid, code text)
language plpgsql security definer set search_path = public as $$
declare
  new_batch uuid;
  available_count integer;
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
  if normalized_access is null then raise exception 'Sticker access code required'; end if;

  perform pg_advisory_xact_lock(hashtext(p_requester_hash));
  perform pg_advisory_xact_lock(hashtext('return_box_pool'));

  if not exists (
    select 1 from public.sticker_access_codes a
     where a.code = normalized_access and a.active
  ) then
    raise exception 'Invalid sticker access code';
  end if;

  update public.sticker_access_codes a
     set generation_used = a.generation_used + p_quantity
   where a.code = normalized_access
     and a.active
     and a.generation_used + p_quantity <= a.generation_limit;
  get diagnostics changed = row_count;
  if changed = 0 then raise exception 'Access code limit exceeded'; end if;

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
    select new_batch, updated.code::text from updated order by updated.code;
end;
$$;

revoke all on function public.allocate_return_box_codes(integer, text, text, text) from public, anon, authenticated;
grant execute on function public.allocate_return_box_codes(integer, text, text, text) to service_role;

-- ------------------------------------------------------------
-- QR коробки по конкретному номеру
-- ------------------------------------------------------------
create function public.authorize_box_custom_sticker(
  p_requester_hash text,
  p_access_code text default null
)
returns table(batch_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  new_batch uuid;
  normalized text;
  changed integer;
begin
  if length(p_requester_hash) <> 64 then raise exception 'Invalid allocation request'; end if;
  normalized := nullif(btrim(coalesce(p_access_code, '')), '');
  if normalized is null then raise exception 'Sticker access code required'; end if;

  perform pg_advisory_xact_lock(hashtext(p_requester_hash));

  if not exists (
    select 1 from public.sticker_access_codes a
     where a.code = normalized and a.active
  ) then
    raise exception 'Invalid sticker access code';
  end if;

  update public.sticker_access_codes a
     set generation_used = a.generation_used + 1
   where a.code = normalized
     and a.active
     and a.generation_used < a.generation_limit;
  get diagnostics changed = row_count;
  if changed = 0 then raise exception 'Access code limit exceeded'; end if;

  insert into public.return_box_batches(quantity, requester_hash, access_code, prefix, generation_kind)
  values (1, p_requester_hash, normalized, 'TRBX', 'custom')
  returning id into new_batch;

  return query select new_batch;
end;
$$;

revoke all on function public.authorize_box_custom_sticker(text, text) from public, anon, authenticated;
grant execute on function public.authorize_box_custom_sticker(text, text) to service_role;

commit;
