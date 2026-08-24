begin;

create table if not exists public.return_box_batches (
  id uuid primary key default gen_random_uuid(),
  quantity integer not null check (quantity between 1 and 500),
  requester_hash text not null check (length(requester_hash)=64),
  access_code text references public.sticker_access_codes(code),
  prefix text not null default 'TRBX' check (prefix ~ '^[A-Z0-9_-]{1,12}$'),
  generation_kind text not null default 'range' check(generation_kind in('range','custom')),
  created_at timestamptz not null default now()
);

create table if not exists public.return_box_codes (
  code bigint primary key check (code between 0 and 1099511627775),
  batch_id uuid references public.return_box_batches(id),
  allocated_at timestamptz,
  created_at timestamptz not null default now(),
  check ((batch_id is null) = (allocated_at is null))
);

create index if not exists return_box_codes_available_idx on public.return_box_codes(code) where batch_id is null;
create index if not exists return_box_codes_batch_idx on public.return_box_codes(batch_id) where batch_id is not null;
create index if not exists return_box_batches_requester_idx on public.return_box_batches(requester_hash,created_at desc);

alter table public.return_box_batches enable row level security;
alter table public.return_box_codes enable row level security;
revoke all on table public.return_box_batches,public.return_box_codes from anon,authenticated;
grant select,insert,update,delete on table public.return_box_batches,public.return_box_codes to service_role;

create or replace function public.add_return_box_range(p_start bigint,p_end bigint)
returns integer language plpgsql security definer set search_path=public as $$
declare inserted_count integer;
begin
  if p_start<0 or p_end<p_start or p_end>1099511627775 or p_end-p_start>100000 then raise exception 'Invalid box range';end if;
  insert into public.return_box_codes(code) select value from generate_series(p_start,p_end) value on conflict(code) do nothing;
  get diagnostics inserted_count=row_count;return inserted_count;
end;$$;
revoke all on function public.add_return_box_range(bigint,bigint) from public,anon,authenticated;
grant execute on function public.add_return_box_range(bigint,bigint) to service_role;

create or replace function public.allocate_return_box_codes(p_quantity integer,p_requester_hash text,p_access_code text default null,p_prefix text default 'TRBX')
returns table(batch_id uuid,code text,free_remaining integer)
language plpgsql security definer set search_path=public as $$
declare new_batch uuid;available_count integer;used_free integer;normalized_access text;normalized_prefix text;access_updated integer;
begin
  normalized_access:=nullif(btrim(coalesce(p_access_code,'')),'');normalized_prefix:=upper(btrim(coalesce(p_prefix,'TRBX')));
  if p_quantity<1 or p_quantity>500 or length(p_requester_hash)<>64 or normalized_prefix!~'^[A-Z0-9_-]{1,12}$' then raise exception 'Invalid box allocation request';end if;
  perform pg_advisory_xact_lock(hashtext(p_requester_hash));perform pg_advisory_xact_lock(hashtext('return_box_pool'));
  if normalized_access is null then
    select coalesce(sum(quantity),0)::integer into used_free from public.return_box_batches where requester_hash=p_requester_hash and access_code is null and generation_kind='range';
    if used_free+p_quantity>1 then raise exception 'Sticker access code required';end if;
  elsif not exists(select 1 from public.sticker_access_codes where code=normalized_access and active) then raise exception 'Invalid sticker access code';
  else
    update public.sticker_access_codes set range_generation_used=range_generation_used+p_quantity,range_usage_mode='sticker'
      where code=normalized_access and active and range_generation_used+p_quantity<=range_generation_limit;
    get diagnostics access_updated=row_count;if access_updated=0 then raise exception 'Access code range limit exceeded';end if;
  end if;
  select count(*) into available_count from(select 1 from public.return_box_codes where batch_id is null limit p_quantity)x;
  if available_count<p_quantity then raise exception 'Not enough unused box codes';end if;
  insert into public.return_box_batches(quantity,requester_hash,access_code,prefix,generation_kind) values(p_quantity,p_requester_hash,normalized_access,normalized_prefix,'range') returning id into new_batch;
  return query with selected as(select c.code from public.return_box_codes c where c.batch_id is null order by c.code limit p_quantity for update skip locked),updated as(update public.return_box_codes c set batch_id=new_batch,allocated_at=now() from selected s where c.code=s.code returning c.code)
    select new_batch,updated.code::text,case when normalized_access is null then greatest(1-used_free-p_quantity,0) else 0 end from updated order by updated.code;
end;$$;
revoke all on function public.allocate_return_box_codes(integer,text,text,text) from public,anon,authenticated;
grant execute on function public.allocate_return_box_codes(integer,text,text,text) to service_role;

commit;
