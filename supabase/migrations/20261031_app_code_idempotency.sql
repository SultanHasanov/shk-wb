-- One paid client-code request may be retried after the response is lost.
-- The request UUID and result are committed in the same transaction as the charge.
create table if not exists public.app_code_requests (
  request_id uuid primary key,
  subject text not null,
  sid text not null,
  qr_text text not null,
  billing jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.app_code_requests enable row level security;
revoke all on public.app_code_requests from anon, authenticated;

create or replace function public.app_code_once(
  p_request uuid,
  p_user uuid,
  p_device uuid,
  p_key text,
  p_sid text,
  p_qr_text text,
  p_meta jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  prior public.app_code_requests;
  key_row public.license_keys;
  subject_id text;
  charged jsonb;
begin
  if p_request is null or p_sid !~ '^[0-9]{1,12}$' or p_qr_text !~ ('^' || p_sid || '_[0-9]{5}_[0-9]{6}_1$') then
    raise exception 'INVALID_CODE_REQUEST';
  end if;
  if (p_user is null) = (p_key is null) then raise exception 'INVALID_CODE_SUBJECT'; end if;

  perform pg_advisory_xact_lock(hashtext('app_code_once:' || p_request::text));
  if p_user is not null then
    if p_device is null then raise exception 'DEVICE_REQUIRED'; end if;
    subject_id := 'user:' || p_user::text;
  else
    select * into key_row from public.license_keys where key = p_key;
    if key_row.id is null then raise exception 'LIMIT_EXCEEDED'; end if;
    subject_id := 'key:' || key_row.id::text;
  end if;

  select * into prior from public.app_code_requests where request_id = p_request;
  if prior.request_id is not null then
    if prior.subject <> subject_id or prior.sid <> p_sid then raise exception 'CODE_REQUEST_CONFLICT'; end if;
    return jsonb_build_object('qrText', prior.qr_text, 'billing', prior.billing, 'replayed', true);
  end if;

  if p_user is not null then
    charged := jsonb_build_object('via', 'account') || public.app_consume(p_user, p_device, 'code', 1, coalesce(p_meta, '{}'::jsonb));
  else
    select * into key_row from public.consume_license(p_key);
    if key_row.id is null then raise exception 'LIMIT_EXCEEDED'; end if;
    charged := jsonb_build_object('via', 'key', 'left', greatest(0, key_row.usage_limit - key_row.used));
  end if;

  insert into public.app_code_requests(request_id, subject, sid, qr_text, billing)
  values (p_request, subject_id, p_sid, p_qr_text, charged);
  return jsonb_build_object('qrText', p_qr_text, 'billing', charged, 'replayed', false);
end;
$$;

revoke all on function public.app_code_once(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.app_code_once(uuid, uuid, uuid, text, text, text, jsonb) to service_role;

create or replace function public.app_code_key_active(p_key text)
returns boolean language sql security definer set search_path = public as $$
  select exists(select 1 from public.license_keys where key = p_key and active and used < usage_limit);
$$;
revoke all on function public.app_code_key_active(text) from public, anon, authenticated;
grant execute on function public.app_code_key_active(text) to service_role;
