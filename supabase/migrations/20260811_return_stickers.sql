begin;

create extension if not exists pgcrypto;

create table if not exists public.return_sticker_batches (
  id uuid primary key default gen_random_uuid(),
  quantity integer not null check (quantity between 1 and 100),
  requester_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.return_sticker_codes (
  code bigint primary key check (code between 0 and 1099511627775),
  batch_id uuid references public.return_sticker_batches(id),
  allocated_at timestamptz,
  created_at timestamptz not null default now(),
  check ((batch_id is null) = (allocated_at is null))
);

create index if not exists return_sticker_codes_available_idx
  on public.return_sticker_codes (code) where batch_id is null;
create index if not exists return_sticker_codes_batch_idx
  on public.return_sticker_codes (batch_id) where batch_id is not null;
create index if not exists return_sticker_batches_requester_idx
  on public.return_sticker_batches (requester_hash, created_at);

alter table public.return_sticker_batches enable row level security;
alter table public.return_sticker_codes enable row level security;
revoke all on table public.return_sticker_batches from anon, authenticated;
revoke all on table public.return_sticker_codes from anon, authenticated;
grant select, insert, update on table public.return_sticker_batches to service_role;
grant select, insert, update on table public.return_sticker_codes to service_role;

create or replace function public.add_return_sticker_range(p_start bigint, p_end bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare inserted_count integer;
begin
  if p_start < 0 or p_end < p_start or p_end > 1099511627775 or p_end - p_start > 100000 then
    raise exception 'Invalid sticker range';
  end if;
  insert into public.return_sticker_codes(code)
  select value from generate_series(p_start, p_end) as value
  on conflict (code) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.allocate_return_stickers(p_quantity integer, p_requester_hash text)
returns table(batch_id uuid, code text)
language plpgsql security definer set search_path = public as $$
declare new_batch uuid;
declare available_count integer;
declare used_today integer;
begin
  if p_quantity < 1 or p_quantity > 100 or length(p_requester_hash) <> 64 then
    raise exception 'Invalid allocation request';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_requester_hash));
  perform pg_advisory_xact_lock(hashtext('return_sticker_pool'));
  select coalesce(sum(quantity), 0) into used_today
    from public.return_sticker_batches
   where requester_hash = p_requester_hash and created_at >= now() - interval '24 hours';
  if used_today + p_quantity > 200 then raise exception 'Daily sticker limit exceeded'; end if;

  select count(*) into available_count from (
    select 1 from public.return_sticker_codes c where c.batch_id is null limit p_quantity
  ) available;
  if available_count < p_quantity then raise exception 'Not enough unused sticker codes'; end if;

  insert into public.return_sticker_batches(quantity, requester_hash)
  values (p_quantity, p_requester_hash) returning id into new_batch;

  return query
  with selected as (
    select c.code from public.return_sticker_codes c
     where c.batch_id is null order by c.code limit p_quantity for update skip locked
  ), updated as (
    update public.return_sticker_codes c set batch_id = new_batch, allocated_at = now()
     from selected s where c.code = s.code returning c.code
  ) select new_batch, updated.code::text from updated order by updated.code;
end;
$$;

revoke all on function public.add_return_sticker_range(bigint, bigint) from public, anon, authenticated;
revoke all on function public.allocate_return_stickers(integer, text) from public, anon, authenticated;
grant execute on function public.add_return_sticker_range(bigint, bigint) to service_role;
grant execute on function public.allocate_return_stickers(integer, text) to service_role;

commit;
