-- Платная «Пачка 50» не выдавалась ни разу с 01.11.2026: в функциях с returns table(batch_id, code)
-- неуточнённое «where batch_id is null» неоднозначно (выходной параметр или столбец) → 42702 → PostgREST 400,
-- бот возвращал деньги и показывал код ошибки. Столбцы уточнены алиасом, как в allocate_return_stickers.

create or replace function public.allocate_paid_return_stickers(p_charge uuid,p_user uuid,p_requester_hash text)
returns table(batch_id uuid,code text) language plpgsql security definer set search_path=public as $$
declare new_batch uuid; available_count integer;
begin
  if length(p_requester_hash)<>64 then raise exception 'Invalid allocation request'; end if;
  perform public.consume_sticker_generation_charge(p_charge,p_user,'batch','product');
  perform pg_advisory_xact_lock(hashtext('return_sticker_pool'));
  select count(*) into available_count from(select 1 from public.return_sticker_codes c where c.batch_id is null limit 50)x;
  if available_count<50 then raise exception 'Not enough unused sticker codes'; end if;
  insert into public.return_sticker_batches(quantity,requester_hash,access_code,generation_kind)
    values(50,p_requester_hash,null,'range') returning id into new_batch;
  return query with selected as(select c.code from public.return_sticker_codes c where c.batch_id is null order by c.code limit 50 for update skip locked),
    updated as(update public.return_sticker_codes c set batch_id=new_batch,allocated_at=now() from selected s where c.code=s.code returning c.code)
    select new_batch,updated.code::text from updated order by updated.code;
end;$$;

create or replace function public.allocate_paid_return_box_codes(p_charge uuid,p_user uuid,p_requester_hash text,p_prefix text default 'TRBX')
returns table(batch_id uuid,code text) language plpgsql security definer set search_path=public as $$
declare new_batch uuid; available_count integer; normalized_prefix text:=upper(btrim(coalesce(p_prefix,'TRBX')));
begin
  if length(p_requester_hash)<>64 or normalized_prefix!~'^[A-Z0-9_-]{1,12}$' then raise exception 'Invalid box allocation request'; end if;
  perform public.consume_sticker_generation_charge(p_charge,p_user,'batch','box');
  perform pg_advisory_xact_lock(hashtext('return_box_pool'));
  select count(*) into available_count from(select 1 from public.return_box_codes c where c.batch_id is null limit 50)x;
  if available_count<50 then raise exception 'Not enough unused box codes'; end if;
  insert into public.return_box_batches(quantity,requester_hash,access_code,prefix,generation_kind)
    values(50,p_requester_hash,null,normalized_prefix,'range') returning id into new_batch;
  return query with selected as(select c.code from public.return_box_codes c where c.batch_id is null order by c.code limit 50 for update skip locked),
    updated as(update public.return_box_codes c set batch_id=new_batch,allocated_at=now() from selected s where c.code=s.code returning c.code)
    select new_batch,updated.code::text from updated order by updated.code;
end;$$;

revoke all on function public.allocate_paid_return_stickers(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.allocate_paid_return_box_codes(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.allocate_paid_return_stickers(uuid,uuid,text) to service_role;
grant execute on function public.allocate_paid_return_box_codes(uuid,uuid,text,text) to service_role;
