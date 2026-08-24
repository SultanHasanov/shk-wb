begin;

create or replace function public.get_sticker_generation_stats()
returns table(return_stickers bigint, custom_stickers bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(quantity) filter (where generation_kind = 'range'), 0)::bigint,
    coalesce(sum(quantity) filter (where generation_kind = 'custom'), 0)::bigint
  from public.return_sticker_batches;
$$;

revoke all on function public.get_sticker_generation_stats() from public, anon, authenticated;
grant execute on function public.get_sticker_generation_stats() to service_role;

commit;
