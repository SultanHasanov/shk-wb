begin;

alter table public.sticker_access_codes
  add column if not exists range_usage_mode text not null default 'sticker'
  check (range_usage_mode in ('request', 'sticker'));

alter table public.sticker_access_codes
  alter column range_usage_mode set default 'sticker';

-- Rebuild historical usage from the actual number of stickers allocated.
-- The value is capped by the issued limit because the table constraint does
-- not permit used > limit; such a key correctly becomes exhausted.
update public.sticker_access_codes a
   set range_usage_mode = 'sticker',
       range_generation_used = least(
         a.range_generation_limit,
         greatest(
           a.range_generation_used,
           coalesce((
             select sum(b.quantity)::integer
               from public.return_sticker_batches b
              where b.access_code = a.code
                and b.generation_kind = 'range'
           ), 0)
         )
       );

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
  used_today integer;
  used_free integer;
  normalized_access_code text;
  access_updated integer;
begin
  if p_quantity < 1 or p_quantity > 100 or length(p_requester_hash) <> 64 then
    raise exception 'Invalid allocation request';
  end if;
  normalized_access_code := nullif(btrim(coalesce(p_access_code, '')), '');
  perform pg_advisory_xact_lock(hashtext(p_requester_hash));
  perform pg_advisory_xact_lock(hashtext('return_sticker_pool'));

  if normalized_access_code is null then
    select coalesce(sum(b.quantity), 0)::integer into used_free
      from public.return_sticker_batches b
     where b.requester_hash = p_requester_hash and b.access_code is null
       and b.generation_kind = 'range';
    if used_free + p_quantity > 1 then raise exception 'Sticker access code required'; end if;
  elsif not exists (
    select 1 from public.sticker_access_codes a
     where a.code = normalized_access_code and a.active
  ) then
    raise exception 'Invalid sticker access code';
  else
    update public.sticker_access_codes a
       set range_generation_used = a.range_generation_used + p_quantity,
           range_usage_mode = 'sticker'
     where a.code = normalized_access_code and a.active
       and a.range_generation_used + p_quantity <= a.range_generation_limit;
    get diagnostics access_updated = row_count;
    if access_updated = 0 then raise exception 'Access code range limit exceeded'; end if;
  end if;

  select coalesce(sum(b.quantity), 0)::integer into used_today
    from public.return_sticker_batches b
   where b.requester_hash = p_requester_hash and b.created_at >= now() - interval '24 hours';
  if used_today + p_quantity > 200 then raise exception 'Daily sticker limit exceeded'; end if;
  select count(*) into available_count from (
    select 1 from public.return_sticker_codes c where c.batch_id is null limit p_quantity
  ) available;
  if available_count < p_quantity then raise exception 'Not enough unused sticker codes'; end if;

  insert into public.return_sticker_batches(quantity, requester_hash, access_code, generation_kind)
  values (p_quantity, p_requester_hash, normalized_access_code, 'range') returning id into new_batch;
  return query
  with selected as (
    select c.code from public.return_sticker_codes c
     where c.batch_id is null order by c.code limit p_quantity for update skip locked
  ), updated as (
    update public.return_sticker_codes c set batch_id = new_batch, allocated_at = now()
     from selected s where c.code = s.code returning c.code
  )
  select new_batch, updated.code::text,
    case when normalized_access_code is null then greatest(1 - used_free - p_quantity, 0) else 0 end
  from updated order by updated.code;
end;
$$;

revoke all on function public.allocate_return_stickers(integer, text, text) from public, anon, authenticated;
grant execute on function public.allocate_return_stickers(integer, text, text) to service_role;

commit;
