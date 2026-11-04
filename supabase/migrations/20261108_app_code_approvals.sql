-- Код клиента выдаётся только с подтверждением владельца в Telegram-боте (04.11.2026).
-- Программа создаёт запрос (сайт), владелец нажимает «Выдать» в боте (узел бота), программа опрашивает статус.
-- Обе стороны ходят в эти таблицы напрямую — RPC между сайтом и узлом не нужен.
create table if not exists public.app_code_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  device_id uuid not null references public.app_devices(id) on delete cascade,
  sid text not null,
  cell text,
  point_wb text,
  status text not null default 'pending'
    check (status in ('pending','approved','declined','cancelled','expired','undeliverable','failed')),
  qr_text text,
  billing jsonb,
  error text,
  telegram_chat_id bigint,
  telegram_message_id bigint,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz
);
create index if not exists app_code_approvals_user_idx on public.app_code_approvals(user_id, status, created_at desc);
create index if not exists app_code_approvals_device_pending_idx on public.app_code_approvals(device_id, created_at desc);
alter table public.app_code_approvals enable row level security;
revoke all on public.app_code_approvals from anon, authenticated;

-- Одноразовая ссылка t.me/<бот>?start=link_<token> из программы (только с ПК владельца): привязывает Telegram к аккаунту.
create table if not exists public.app_telegram_link_tokens (
  token text primary key,
  user_id uuid not null,
  device_id uuid,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.app_telegram_link_tokens enable row level security;
revoke all on public.app_telegram_link_tokens from anon, authenticated;

-- app_code_once: прямой «Код <SID>» в боте списывает квоту тарифа без ПК (p_device null, via = 'bot').
-- Остальное без изменений (20261031_app_code_idempotency.sql).
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
    if p_device is null and coalesce(p_meta->>'via', '') <> 'bot' then raise exception 'DEVICE_REQUIRED'; end if;
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
