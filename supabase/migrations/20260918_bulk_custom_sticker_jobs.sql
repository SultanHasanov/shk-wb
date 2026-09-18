begin;

create table public.custom_sticker_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft','running','paused_no_credits','completed','failed')),
  total_count integer not null default 0 check (total_count >= 0),
  generated_count integer not null default 0 check (generated_count >= 0 and generated_count <= total_count),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index custom_sticker_jobs_user_idx on public.custom_sticker_jobs(user_id,updated_at desc);

create table public.custom_sticker_job_items (
  job_id uuid not null references public.custom_sticker_jobs(id) on delete cascade,
  position integer not null check (position > 0),
  code text not null check (code ~ '^[0-9]{11}$'),
  history_id bigint references public.user_generation_history(id) on delete set null,
  generated_at timestamptz,
  primary key(job_id,position),
  unique(job_id,code)
);
create index custom_sticker_job_items_pending_idx
  on public.custom_sticker_job_items(job_id,position) where generated_at is null;

create table public.custom_sticker_job_credits (
  job_id uuid not null references public.custom_sticker_jobs(id) on delete cascade,
  history_id bigint not null references public.user_generation_history(id) on delete cascade,
  access_code text not null references public.sticker_access_codes(code),
  units integer not null check (units > 0),
  primary key(job_id,history_id,access_code)
);

alter table public.custom_sticker_jobs enable row level security;
alter table public.custom_sticker_job_items enable row level security;
alter table public.custom_sticker_job_credits enable row level security;
revoke all on table public.custom_sticker_jobs,public.custom_sticker_job_items,public.custom_sticker_job_credits from public,anon,authenticated;
grant select,insert,update,delete on table public.custom_sticker_jobs,public.custom_sticker_job_items,public.custom_sticker_job_credits to service_role;

create or replace function public.save_custom_sticker_job(p_user_id uuid,p_job_id uuid,p_codes jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  result_id uuid;
  code_count integer;
begin
  if jsonb_typeof(p_codes) <> 'array' then raise exception 'Invalid codes'; end if;
  code_count := jsonb_array_length(p_codes);
  if code_count < 1 then raise exception 'Codes required'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_codes) where value !~ '^[0-9]{11}$') then
    raise exception 'Invalid sticker code';
  end if;
  if (select count(distinct value) from jsonb_array_elements_text(p_codes)) <> code_count then
    raise exception 'Codes must be unique';
  end if;

  if p_job_id is null then
    insert into public.custom_sticker_jobs(user_id,total_count) values(p_user_id,code_count) returning id into result_id;
  else
    select id into result_id from public.custom_sticker_jobs
      where id=p_job_id and user_id=p_user_id and status='draft' for update;
    if not found then raise exception 'Draft not found'; end if;
    delete from public.custom_sticker_job_items where job_id=result_id;
    update public.custom_sticker_jobs set total_count=code_count,updated_at=now(),error=null where id=result_id;
  end if;

  insert into public.custom_sticker_job_items(job_id,position,code)
  select result_id,ordinality,value from jsonb_array_elements_text(p_codes) with ordinality;
  return result_id;
end;$$;

create or replace function public.process_custom_sticker_job(p_user_id uuid,p_job_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  job public.custom_sticker_jobs;
  asset public.sticker_access_codes;
  available integer;
  batch_size integer;
  remaining integer;
  take_units integer;
  part integer;
  part_codes jsonb;
  new_history_id bigint;
  next_status text;
begin
  select * into job from public.custom_sticker_jobs where id=p_job_id and user_id=p_user_id for update;
  if not found then raise exception 'Job not found'; end if;
  if job.status='draft' then
    update public.custom_sticker_jobs set status='running',updated_at=now() where id=job.id;
  elsif job.status='completed' then
    return jsonb_build_object('id',job.id,'status',job.status,'total',job.total_count,'generated',job.generated_count,'remaining',0);
  end if;

  select coalesce(sum(generation_limit-generation_used),0)::integer into available
  from public.sticker_access_codes
  where owner_user_id=p_user_id and active and generation_used<generation_limit;
  batch_size:=least(500,available,job.total_count-job.generated_count);
  if batch_size <= 0 then
    next_status:=case when job.generated_count>=job.total_count then 'completed' else 'paused_no_credits' end;
    update public.custom_sticker_jobs set status=next_status,updated_at=now(),completed_at=case when next_status='completed' then now() else null end where id=job.id;
    return jsonb_build_object('id',job.id,'status',next_status,'total',job.total_count,'generated',job.generated_count,'remaining',job.total_count-job.generated_count);
  end if;

  select coalesce(jsonb_agg(code order by position),'[]'::jsonb) into part_codes
  from (select code,position from public.custom_sticker_job_items where job_id=job.id and generated_at is null order by position limit batch_size) selected;
  batch_size:=jsonb_array_length(part_codes);
  select count(distinct history_id)::integer into part
  from public.custom_sticker_job_items where job_id=job.id and history_id is not null;
  insert into public.user_generation_history(user_id,client_entry_id,mode,payload,created_at)
  values(p_user_id,'custom-list:'||job.id||':'||part,'range',jsonb_build_object(
    'category','product','quantity',batch_size,'codes',part_codes,'customJobId',job.id,'customJobPart',part
  ),now()) returning id into new_history_id;

  remaining:=batch_size;
  for asset in select * from public.sticker_access_codes
    where owner_user_id=p_user_id and active and generation_used<generation_limit order by created_at for update
  loop
    exit when remaining=0;
    take_units:=least(remaining,asset.generation_limit-asset.generation_used);
    update public.sticker_access_codes set generation_used=generation_used+take_units where id=asset.id;
    insert into public.custom_sticker_job_credits(job_id,history_id,access_code,units)
    values(job.id,new_history_id,asset.code,take_units);
    remaining:=remaining-take_units;
  end loop;
  if remaining<>0 then raise exception 'Not enough generation credits'; end if;

  update public.custom_sticker_job_items set generated_at=now(),history_id=new_history_id
  where job_id=job.id and code in (select value from jsonb_array_elements_text(part_codes));
  job.generated_count:=job.generated_count+batch_size;
  next_status:=case when job.generated_count>=job.total_count then 'completed' else 'running' end;
  update public.custom_sticker_jobs set generated_count=job.generated_count,status=next_status,updated_at=now(),
    completed_at=case when next_status='completed' then now() else null end,error=null where id=job.id;
  return jsonb_build_object('id',job.id,'status',next_status,'total',job.total_count,'generated',job.generated_count,
    'remaining',job.total_count-job.generated_count,'historyId',new_history_id,'batchSize',batch_size);
end;$$;

revoke all on function public.save_custom_sticker_job(uuid,uuid,jsonb),public.process_custom_sticker_job(uuid,uuid) from public,anon,authenticated;
grant execute on function public.save_custom_sticker_job(uuid,uuid,jsonb),public.process_custom_sticker_job(uuid,uuid) to service_role;

commit;
