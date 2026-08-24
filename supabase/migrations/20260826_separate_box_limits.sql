begin;

alter table public.sticker_access_codes add column if not exists box_range_generation_limit integer not null default 0 check(box_range_generation_limit>=0);
alter table public.sticker_access_codes add column if not exists box_range_generation_used integer not null default 0 check(box_range_generation_used>=0 and box_range_generation_used<=box_range_generation_limit);
alter table public.sticker_access_codes add column if not exists box_custom_generation_limit integer not null default 0 check(box_custom_generation_limit>=0);
alter table public.sticker_access_codes add column if not exists box_custom_generation_used integer not null default 0 check(box_custom_generation_used>=0 and box_custom_generation_used<=box_custom_generation_limit);
alter table public.payment_orders add column if not exists sticker_target text not null default 'product' check(sticker_target in('product','box'));
alter table public.return_box_batches add column if not exists generation_kind text not null default 'range' check(generation_kind in('range','custom'));

create or replace function public.complete_payment_order(p_order_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare generated_code text;current_code text;rq integer;cq integer;target text;
begin
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));
  select access_code,range_quantity,custom_quantity,sticker_target into current_code,rq,cq,target from public.payment_orders where id=p_order_id for update;
  if not found then raise exception 'Order not found';end if;if current_code is not null then return current_code;end if;
  loop generated_code:=lpad(floor(random()*1000000)::integer::text,6,'0');
    begin
      if target='box' then
        insert into public.sticker_access_codes(code,name,active,range_generation_limit,custom_generation_limit,box_range_generation_limit,box_custom_generation_limit,range_usage_mode)
          values(generated_code,'Покупка QR коробок '||p_order_id,true,0,0,rq,cq,'sticker');
      else
        insert into public.sticker_access_codes(code,name,active,range_generation_limit,custom_generation_limit,box_range_generation_limit,box_custom_generation_limit,range_usage_mode)
          values(generated_code,'Покупка стикеров товаров '||p_order_id,true,rq,cq,0,0,'sticker');
      end if;exit;exception when unique_violation then null;end;
  end loop;
  update public.payment_orders set access_code=generated_code,status='succeeded',paid_at=coalesce(paid_at,now()),updated_at=now() where id=p_order_id;
  return generated_code;
end;$$;
revoke all on function public.complete_payment_order(uuid) from public,anon,authenticated;
grant execute on function public.complete_payment_order(uuid) to service_role;

create or replace function public.authorize_box_custom_sticker(p_requester_hash text,p_access_code text default null)
returns table(batch_id uuid,free_remaining integer) language plpgsql security definer set search_path=public as $$
declare new_batch uuid;used_free integer;normalized text;changed integer;
begin
  if length(p_requester_hash)<>64 then raise exception 'Invalid allocation request';end if;normalized:=nullif(btrim(coalesce(p_access_code,'')),'');perform pg_advisory_xact_lock(hashtext(p_requester_hash));
  if normalized is null then
    select coalesce(sum(quantity),0)::integer into used_free from public.return_box_batches where requester_hash=p_requester_hash and access_code is null and generation_kind='custom';
    if used_free+1>1 then raise exception 'Sticker access code required';end if;
  elsif not exists(select 1 from public.sticker_access_codes where code=normalized and active) then raise exception 'Invalid sticker access code';
  else
    update public.sticker_access_codes set box_custom_generation_used=box_custom_generation_used+1 where code=normalized and active and box_custom_generation_used<box_custom_generation_limit;
    get diagnostics changed=row_count;if changed=0 then raise exception 'Access code box custom limit exceeded';end if;
  end if;
  insert into public.return_box_batches(quantity,requester_hash,access_code,prefix,generation_kind) values(1,p_requester_hash,normalized,'TRBX','custom') returning id into new_batch;
  return query select new_batch,0;
end;$$;
revoke all on function public.authorize_box_custom_sticker(text,text) from public,anon,authenticated;
grant execute on function public.authorize_box_custom_sticker(text,text) to service_role;

create or replace function public.allocate_return_box_codes(p_quantity integer,p_requester_hash text,p_access_code text default null,p_prefix text default 'TRBX')
returns table(batch_id uuid,code text,free_remaining integer) language plpgsql security definer set search_path=public as $$
declare new_batch uuid;available_count integer;used_free integer;normalized_access text;normalized_prefix text;changed integer;
begin
  normalized_access:=nullif(btrim(coalesce(p_access_code,'')),'');normalized_prefix:=upper(btrim(coalesce(p_prefix,'TRBX')));
  if p_quantity<1 or p_quantity>500 or length(p_requester_hash)<>64 or normalized_prefix!~'^[A-Z0-9_-]{1,12}$' then raise exception 'Invalid box allocation request';end if;
  perform pg_advisory_xact_lock(hashtext(p_requester_hash));perform pg_advisory_xact_lock(hashtext('return_box_pool'));
  if normalized_access is null then select coalesce(sum(quantity),0)::integer into used_free from public.return_box_batches where requester_hash=p_requester_hash and access_code is null and generation_kind='range';if used_free+p_quantity>1 then raise exception 'Sticker access code required';end if;
  elsif not exists(select 1 from public.sticker_access_codes where code=normalized_access and active) then raise exception 'Invalid sticker access code';
  else update public.sticker_access_codes set box_range_generation_used=box_range_generation_used+p_quantity where code=normalized_access and active and box_range_generation_used+p_quantity<=box_range_generation_limit;get diagnostics changed=row_count;if changed=0 then raise exception 'Access code box range limit exceeded';end if;end if;
  select count(*) into available_count from(select 1 from public.return_box_codes where batch_id is null limit p_quantity)x;if available_count<p_quantity then raise exception 'Not enough unused box codes';end if;
  insert into public.return_box_batches(quantity,requester_hash,access_code,prefix,generation_kind)values(p_quantity,p_requester_hash,normalized_access,normalized_prefix,'range')returning id into new_batch;
  return query with selected as(select c.code from public.return_box_codes c where c.batch_id is null order by c.code limit p_quantity for update skip locked),updated as(update public.return_box_codes c set batch_id=new_batch,allocated_at=now() from selected s where c.code=s.code returning c.code)select new_batch,updated.code::text,case when normalized_access is null then greatest(1-used_free-p_quantity,0)else 0 end from updated order by updated.code;
end;$$;
revoke all on function public.allocate_return_box_codes(integer,text,text,text) from public,anon,authenticated;
grant execute on function public.allocate_return_box_codes(integer,text,text,text) to service_role;

commit;
