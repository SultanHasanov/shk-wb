begin;

-- Журнал админки «было → стало», ключ повтора, сообщения от администрации и ленты доставок.

-- admin_actions (20260909): причина, снимки до/после, итог, браузер, ключ повтора и сохранённый ответ.
-- idempotency_key хранится как "<action>:<key>" — повтор того же действия отдаёт сохранённый response.
alter table public.admin_actions
  add column if not exists reason text check (reason is null or char_length(reason) <= 500),
  add column if not exists before jsonb,
  add column if not exists after jsonb,
  add column if not exists result text check (result is null or result in ('ok','error','partial','pending')),
  add column if not exists user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  add column if not exists idempotency_key text check (idempotency_key is null or char_length(idempotency_key) <= 200),
  add column if not exists response jsonb;
create unique index if not exists admin_actions_idempotency_uidx on public.admin_actions(idempotency_key) where idempotency_key is not null;
create index if not exists admin_actions_action_idx on public.admin_actions(action, created_at desc);

-- app_device_messages (20261112): сообщение на ПК теперь может написать и администрация.
-- Имя старой проверки не угадываем: снимаем все check-ограничения, где упомянут created_by.
do $$
declare c record;
begin
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.app_device_messages'::regclass and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ~ '\mcreated_by\M'
  loop
    execute format('alter table public.app_device_messages drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.app_device_messages add constraint app_device_messages_created_by_check check (created_by in ('owner','admin'));

-- notification_deliveries (20260831): кроме почты — Telegram и ПК, новые статусы, источник и связь с журналом.
-- Тем же приёмом снимаем проверки по channel и по status (\m…\M — целое слово, channel_ref не задевается).
do $$
declare c record;
begin
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.notification_deliveries'::regclass and con.contype = 'c'
       and (pg_get_constraintdef(con.oid) ~ '\mchannel\M' or pg_get_constraintdef(con.oid) ~ '\mstatus\M')
  loop
    execute format('alter table public.notification_deliveries drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.notification_deliveries add constraint notification_deliveries_channel_check check (channel in ('email','telegram','pc'));
alter table public.notification_deliveries add constraint notification_deliveries_status_check
  check (status in ('pending','sent','failed','skipped','not_configured','blocked'));
-- channel_ref: для telegram — @username или tg:<id>; для pc — app_device_messages.id (uuid текстом).
alter table public.notification_deliveries
  add column if not exists channel_ref text check (channel_ref is null or char_length(channel_ref) <= 200),
  add column if not exists subject text check (subject is null or char_length(subject) <= 200),
  add column if not exists source text not null default 'system' check (source in ('system','admin','broadcast')),
  add column if not exists admin_action_id bigint references public.admin_actions(id) on delete set null;
create index if not exists notification_deliveries_created_idx on public.notification_deliveries(created_at desc);
create index if not exists notification_deliveries_user_idx on public.notification_deliveries(user_id, created_at desc);
create index if not exists notification_deliveries_status_idx on public.notification_deliveries(status, created_at desc);
create index if not exists notification_deliveries_action_idx on public.notification_deliveries(admin_action_id) where admin_action_id is not null;

-- Перегрузка ручной правки кошелька с ключом повтора: повтор с тем же ключом ничего не меняет
-- (wallet_move идемпотентен по event_key). БЕЗ default у p_event_key — иначе PostgREST не отличит её
-- от старой admin_wallet_adjust(uuid,bigint,text default ''), которую зовут бот и _code-approvals.js.
-- Старую функцию этот файл не трогает.
create or replace function public.admin_wallet_adjust(p_user uuid, p_kopecks bigint, p_note text, p_event_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if p_event_key is null or char_length(p_event_key) not between 8 and 200 then
    raise exception 'Invalid event key';
  end if;
  return public.wallet_move(p_user, p_kopecks, 'admin', 'admin:' || p_event_key, null,
                            jsonb_build_object('note', coalesce(p_note, ''), 'source', 'panel'));
end;
$$;

revoke all on function public.admin_wallet_adjust(uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.admin_wallet_adjust(uuid, bigint, text, text) to service_role;

-- Чистка: доставки старше 180 дней, журнал старше 730 дней. Зовёт крон кабинета (cronNotifications).
create or replace function public.admin_maintenance()
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  d integer := 0;
  a integer := 0;
begin
  delete from public.notification_deliveries where created_at < now() - interval '180 days';
  get diagnostics d = row_count;
  delete from public.admin_actions where created_at < now() - interval '730 days';
  get diagnostics a = row_count;
  return jsonb_build_object('deliveries_deleted', d, 'actions_deleted', a);
end;
$$;

revoke all on function public.admin_maintenance() from public, anon, authenticated;
grant execute on function public.admin_maintenance() to service_role;

-- Подписи пользователей для журнала и доставок одним запросом (до 200 id).
-- Читает auth.users — права только у service_role. Колонки приводятся явно: email в auth.users — varchar,
-- и SQL-функция returns table без ::text не создаётся («return type mismatch»).
create or replace function public.admin_user_labels(p_ids uuid[])
returns table(user_id uuid, email text, display_name text, telegram_username text, telegram_only boolean)
language sql stable security definer set search_path=public,auth as $$
  select u.id,
         u.email::text,
         p.display_name::text,
         t.username::text,
         coalesce(u.email, '') like '%@users.invalid'
    from auth.users u
    left join public.user_profiles p on p.user_id = u.id
    left join public.user_telegram_identities t on t.user_id = u.id
   where u.id = any(p_ids[1:200]);
$$;

revoke all on function public.admin_user_labels(uuid[]) from public, anon, authenticated;
grant execute on function public.admin_user_labels(uuid[]) to service_role;

commit;
