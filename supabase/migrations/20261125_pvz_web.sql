-- Веб-версия «Помощника ПВЗ» в кабинете (/cabinet/pvz-web, server/_pvz-web.js).
--
-- 1) Вход в WB по аккаунту сайта. У бота вход привязан к Telegram ID (telegram_wb_connections), у веб-версии —
--    к пользователю сайта. Сессия WB лежит зашифрованной (AES-256-GCM, server/_wb-pvz.js encryptSession).
create table if not exists public.app_wb_web_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state text not null default 'idle' check (state in ('idle', 'await_code', 'await_point', 'ready')),
  encrypted_session text,
  selected_point_id bigint,
  updated_at timestamptz not null default now()
);
alter table public.app_wb_web_sessions enable row level security;
revoke all on public.app_wb_web_sessions from anon, authenticated;

-- 2) app_code_once: код клиента без ПК (p_device null) списывается не только из бота (via = 'bot'),
--    но и из веб-версии (via = 'web'). Остальное без изменений (20261108_app_code_approvals.sql).
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
    if p_device is null and coalesce(p_meta->>'via', '') not in ('bot', 'web') then raise exception 'DEVICE_REQUIRED'; end if;
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
