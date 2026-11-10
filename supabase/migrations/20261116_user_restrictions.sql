begin;

-- Ограничения аккаунта из админки по областям (вместо одной кнопки «Заблокировать»).
-- Области: all (полностью: GoTrue-бан + всё ниже), site, app, cell_print, bot, purchases, withdrawals.
-- Одно действующее ограничение на пользователя (частичный уникальный индекс).
-- disabled_items — что именно выключили при ограничении, чтобы при снятии вернуть ровно это:
--   {"sticker_access_codes":[id…], "license_keys":[id…], "cell_print_licenses":[id…], "legacy": true?,
--    "pending_tables": [таблица…]? — выключить не удалось, повторит следующее сохранение ограничения}
-- «Действует» = lifted_at is null and (until is null or until > now()).
-- «Просрочено, но не снято» = lifted_at is null and until <= now() — снимает таймер сайта (user_restrictions_due).

create table if not exists public.user_restrictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scopes text[] not null check (cardinality(scopes) between 1 and 7
     and scopes <@ array['all','site','app','cell_print','bot','purchases','withdrawals']::text[]),
  reason text not null check (char_length(reason) between 1 and 500),
  public_message text check (public_message is null or char_length(public_message) <= 300),
  until timestamptz,
  disabled_items jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by text,
  lifted_reason text check (lifted_reason is null or char_length(lifted_reason) <= 500)
);
create unique index if not exists user_restrictions_active_uidx on public.user_restrictions(user_id) where lifted_at is null;
create index if not exists user_restrictions_due_idx on public.user_restrictions(until) where lifted_at is null and until is not null;
create index if not exists user_restrictions_user_idx on public.user_restrictions(user_id, created_at desc);

alter table public.user_restrictions enable row level security;
revoke all on table public.user_restrictions from anon, authenticated;
grant select, insert, update, delete on table public.user_restrictions to service_role;

-- Перенос старых банов (GoTrue banned_until) — НЕ здесь, а в 20261119_user_restrictions_legacy_bans.sql,
-- который применяется ПОСЛЕ выкладки B3 (сервер, знающий про ограничения) на оба сервера. Этот файл едет
-- в фазе A, пока работает старый сервер: его кнопка «Разблокировать» снимает только GoTrue-бан и про
-- user_restrictions не знает — перенесённая заранее строка осталась бы действующей и после B3 закрыла бы
-- разблокированному человеку сайт, программу, бота и покупки.

-- Снимок для кеша в памяти сервера (server/_user-controls.js, раз в 60 с на процесс):
-- действующие безлимиты и только действующие ограничения. Просроченные сюда не попадают —
-- проверка прекращается ровно в until, даже если таймер ещё не снял запись.
create or replace function public.user_controls_snapshot()
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'generated_at', now(),
    'unlimited', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', o.user_id, 'until', o.unlimited_until))
        from public.user_overrides o
       where o.unlimited and (o.unlimited_until is null or o.unlimited_until > now())
    ), '[]'::jsonb),
    'restrictions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id,
               'user_id', r.user_id,
               'telegram_user_id', t.telegram_user_id,
               'scopes', to_jsonb(r.scopes),
               'until', r.until,
               'public_message', r.public_message) order by r.created_at)
        from public.user_restrictions r
        left join public.user_telegram_identities t on t.user_id = r.user_id
       where r.lifted_at is null and (r.until is null or r.until > now())
         -- перенесённый старый бан (legacy) действует, только пока стоит сам бан в GoTrue: если его сняли
         -- старой кнопкой «Разблокировать», запись устарела и закрывать доступ не должна
         and (coalesce(r.disabled_items->>'legacy', '') <> 'true'
              or exists (select 1 from auth.users u where u.id = r.user_id and u.banned_until > now()))
    ), '[]'::jsonb)
  );
$$;

-- Ограничения с истёкшим сроком, которые ещё не сняты (для таймера на сайте).
create or replace function public.user_restrictions_due(p_limit integer default 50)
returns setof public.user_restrictions language sql stable security definer set search_path=public as $$
  select * from public.user_restrictions r
   where r.lifted_at is null and r.until is not null and r.until <= now()
   order by r.until
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke all on function public.user_controls_snapshot() from public, anon, authenticated;
revoke all on function public.user_restrictions_due(integer) from public, anon, authenticated;
grant execute on function public.user_controls_snapshot() to service_role;
grant execute on function public.user_restrictions_due(integer) to service_role;

-- Объединение и перепривязка Telegram-кабинета (прошлые версии — 20260916230000 и 20260916200000)
-- знают про новые таблицы: технический кабинет после них удаляется, а user_restrictions и user_overrides
-- ссылаются на auth.users с on delete cascade. Без этого ограничение снималось бы привязкой Telegram к
-- новому кабинету с почтой, а ручные лимиты Telegram-only кабинета пропадали бы.
--   * ограниченный кабинет (действующая запись или GoTrue-бан) не объединяется и не перепривязывается;
--   * при объединении ручные лимиты переходят к основному кабинету (свои у него есть — складываются),
--     история снятых ограничений — тоже;
--   * перепривязка с удалением технического кабинета при ручных лимитах или истории ограничений
--     отказывает (TELEGRAM_ACCOUNT_NOT_EMPTY) — такой кабинет идёт через объединение.
create or replace function public.merge_telegram_account(
  p_telegram_user_id bigint,
  p_target_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  source_user_id uuid;
  source_email text;
  target_email text;
  source_ref public.referral_accounts;
  target_ref public.referral_accounts;
  moved_orders integer := 0;
  moved_history integer := 0;
  moved_codes integer := 0;
  source_ov public.user_overrides;
  target_ov public.user_overrides;
  t_codes boolean;
  s_codes boolean;
  t_slots boolean;
  s_slots boolean;
  t_unl boolean;
  s_unl boolean;
begin
  select t.user_id into source_user_id
    from public.user_telegram_identities t
   where t.telegram_user_id = p_telegram_user_id for update;
  select u.email into target_email from auth.users u
   where u.id=p_target_user_id and u.email_confirmed_at is not null;
  if target_email is null or target_email like '%@users.invalid' then
    raise exception 'TARGET_ACCOUNT_NOT_CONFIRMED';
  end if;
  if source_user_id is null then raise exception 'TELEGRAM_ACCOUNT_NOT_FOUND'; end if;
  if source_user_id=p_target_user_id then
    return jsonb_build_object('sourceUserId',source_user_id,'deleteSource',false);
  end if;
  if exists(select 1 from public.user_telegram_identities
             where user_id=p_target_user_id and telegram_user_id<>p_telegram_user_id) then
    raise exception 'TARGET_ACCOUNT_HAS_TELEGRAM';
  end if;
  select u.email into source_email from auth.users u where u.id=source_user_id;
  if coalesce(source_email,'') !~ '^telegram-[0-9]+@users[.]invalid$' then
    raise exception 'SOURCE_ACCOUNT_NOT_TECHNICAL';
  end if;
  -- Ограничение из админки объединением не сбрасывается: технический кабинет после него удаляется
  -- (user_restrictions — on delete cascade), а Telegram уходит к основному кабинету, где ограничения нет.
  -- Сначала ограничение снимает администратор. Текст исключения начинается с TELEGRAM_ACCOUNT_NOT_EMPTY —
  -- api/auth.js отвечает на него 409 «напишите в поддержку»; причина видна в логе.
  if exists(select 1 from public.user_restrictions r where r.user_id=source_user_id and r.lifted_at is null)
     or exists(select 1 from auth.users u where u.id=source_user_id and u.banned_until > now()) then
    raise exception 'TELEGRAM_ACCOUNT_NOT_EMPTY: SOURCE_ACCOUNT_RESTRICTED';
  end if;

  -- Сначала переносим реферальный счёт и сохраняем оба ранее выданных кода.
  select * into source_ref from public.referral_accounts where user_id=source_user_id for update;
  select * into target_ref from public.referral_accounts where user_id=p_target_user_id for update;
  if source_ref.user_id is not null and target_ref.user_id is null then
    update public.referral_accounts set user_id=p_target_user_id,updated_at=now()
     where user_id=source_user_id;
  elsif source_ref.user_id is not null then
    insert into public.referral_code_aliases(referral_code,user_id)
    values(source_ref.referral_code,p_target_user_id)
    on conflict(referral_code) do nothing;
    if exists(
      select 1 from public.referral_code_aliases
       where referral_code=source_ref.referral_code and user_id<>p_target_user_id
    ) then
      raise exception 'REFERRAL_CODE_ALIAS_CONFLICT';
    end if;
    update public.referral_accounts set
      available_kopecks=available_kopecks+source_ref.available_kopecks,
      reserved_kopecks=reserved_kopecks+source_ref.reserved_kopecks,
      earned_kopecks=earned_kopecks+source_ref.earned_kopecks,
      paid_kopecks=paid_kopecks+source_ref.paid_kopecks,
      debt_kopecks=debt_kopecks+source_ref.debt_kopecks,
      updated_at=now()
     where user_id=p_target_user_id;
    delete from public.referral_accounts where user_id=source_user_id;
  end if;
  update public.referral_ledger set user_id=p_target_user_id where user_id=source_user_id;
  update public.referral_withdrawals set user_id=p_target_user_id where user_id=source_user_id;

  -- Приглашённые остаются за объединённым владельцем; саморефералы удаляются.
  delete from public.referral_attributions
   where invited_user_id=p_target_user_id and referrer_user_id=source_user_id;
  update public.referral_attributions set referrer_user_id=p_target_user_id
   where referrer_user_id=source_user_id;
  if exists(select 1 from public.referral_attributions where invited_user_id=source_user_id) then
    if exists(select 1 from public.referral_attributions where invited_user_id=p_target_user_id)
       or exists(select 1 from public.referral_attributions
                  where invited_user_id=source_user_id and referrer_user_id=p_target_user_id) then
      delete from public.referral_attributions where invited_user_id=source_user_id;
    else
      update public.referral_attributions set invited_user_id=p_target_user_id
       where invited_user_id=source_user_id;
    end if;
  end if;

  -- Профиль основного кабинета имеет приоритет, но пустые поля и настройки
  -- дополняются значениями из Telegram-дубликата.
  insert into public.user_profiles(user_id,display_name,phone,payer_status,created_at,updated_at)
  select p_target_user_id,display_name,phone,payer_status,created_at,now()
    from public.user_profiles where user_id=source_user_id
  on conflict(user_id) do update set
    display_name=case when btrim(public.user_profiles.display_name)=''
      then excluded.display_name else public.user_profiles.display_name end,
    phone=case when btrim(public.user_profiles.phone)=''
      then excluded.phone else public.user_profiles.phone end,
    updated_at=now();
  delete from public.user_profiles where user_id=source_user_id;

  insert into public.user_preferences(
    user_id,thermal_print_settings,updated_at,notify_order_status,notify_key_expiry,
    notify_low_balance,notify_product_news,notification_consent_updated_at,
    notification_consent_source,history_imported_at,history_imported_count,
    history_import_notice_dismissed_at
  )
  select p_target_user_id,thermal_print_settings,now(),notify_order_status,notify_key_expiry,
    notify_low_balance,notify_product_news,notification_consent_updated_at,
    notification_consent_source,history_imported_at,history_imported_count,
    history_import_notice_dismissed_at
    from public.user_preferences where user_id=source_user_id
  on conflict(user_id) do update set
    thermal_print_settings=excluded.thermal_print_settings || public.user_preferences.thermal_print_settings,
    history_imported_at=case
      when public.user_preferences.history_imported_at is null then excluded.history_imported_at
      when excluded.history_imported_at is null then public.user_preferences.history_imported_at
      else greatest(public.user_preferences.history_imported_at,excluded.history_imported_at)
    end,
    history_imported_count=public.user_preferences.history_imported_count+excluded.history_imported_count,
    history_import_notice_dismissed_at=coalesce(
      public.user_preferences.history_import_notice_dismissed_at,
      excluded.history_import_notice_dismissed_at
    ),
    updated_at=now();
  delete from public.user_preferences where user_id=source_user_id;

  update public.payment_orders set user_id=p_target_user_id,updated_at=now()
   where user_id=source_user_id;
  get diagnostics moved_orders=row_count;
  update public.sticker_access_codes set owner_user_id=p_target_user_id
   where owner_user_id=source_user_id;
  get diagnostics moved_codes=row_count;
  update public.license_keys set owner_user_id=p_target_user_id where owner_user_id=source_user_id;
  update public.cell_print_licenses set owner_user_id=p_target_user_id where owner_user_id=source_user_id;

  delete from public.user_generation_history s where s.user_id=source_user_id
   and exists(select 1 from public.user_generation_history t
               where t.user_id=p_target_user_id and t.client_entry_id=s.client_entry_id);
  update public.user_generation_history set user_id=p_target_user_id where user_id=source_user_id;
  get diagnostics moved_history=row_count;
  delete from public.in_app_notifications s where s.user_id=source_user_id
   and exists(select 1 from public.in_app_notifications t
               where t.user_id=p_target_user_id and t.dedupe_key=s.dedupe_key);
  update public.in_app_notifications set user_id=p_target_user_id where user_id=source_user_id;
  update public.notification_deliveries set user_id=p_target_user_id where user_id=source_user_id;
  update public.telegram_generation_requests set user_id=p_target_user_id where user_id=source_user_id;
  update public.telegram_generator_sessions set user_id=p_target_user_id where user_id=source_user_id;
  -- Ручные лимиты из админки (user_overrides) не теряются вместе с техническим кабинетом:
  -- у основного своих нет — строка переходит целиком, есть — складываем по действующим значениям.
  select * into source_ov from public.user_overrides where user_id=source_user_id for update;
  if source_ov.user_id is not null then
    select * into target_ov from public.user_overrides where user_id=p_target_user_id for update;
    if target_ov.user_id is null then
      update public.user_overrides set user_id=p_target_user_id,updated_at=now(),updated_by='merge'
       where user_id=source_user_id;
    else
      t_codes := target_ov.codes_mode is not null and (target_ov.codes_until is null or target_ov.codes_until > now());
      s_codes := source_ov.codes_mode is not null and (source_ov.codes_until is null or source_ov.codes_until > now());
      t_slots := (target_ov.devices_bonus+target_ov.points_bonus+target_ov.mirror_bonus) > 0
                 and (target_ov.slots_until is null or target_ov.slots_until > now());
      s_slots := (source_ov.devices_bonus+source_ov.points_bonus+source_ov.mirror_bonus) > 0
                 and (source_ov.slots_until is null or source_ov.slots_until > now());
      t_unl := target_ov.unlimited and (target_ov.unlimited_until is null or target_ov.unlimited_until > now());
      s_unl := source_ov.unlimited and (source_ov.unlimited_until is null or source_ov.unlimited_until > now());
      update public.user_overrides set
        codes_mode=case when s_codes and not t_codes then source_ov.codes_mode else target_ov.codes_mode end,
        codes_monthly=case when s_codes and not t_codes then source_ov.codes_monthly else target_ov.codes_monthly end,
        codes_until=case when s_codes and not t_codes then source_ov.codes_until else target_ov.codes_until end,
        devices_bonus=greatest(case when t_slots then target_ov.devices_bonus else 0 end,
                               case when s_slots then source_ov.devices_bonus else 0 end),
        points_bonus=greatest(case when t_slots then target_ov.points_bonus else 0 end,
                              case when s_slots then source_ov.points_bonus else 0 end),
        mirror_bonus=greatest(case when t_slots then target_ov.mirror_bonus else 0 end,
                              case when s_slots then source_ov.mirror_bonus else 0 end),
        slots_until=case
          when t_slots and s_slots then
            case when target_ov.slots_until is null or source_ov.slots_until is null then null
                 else greatest(target_ov.slots_until,source_ov.slots_until) end
          when s_slots then source_ov.slots_until
          else target_ov.slots_until end,
        unlimited=t_unl or s_unl,
        unlimited_until=case
          when t_unl and s_unl then
            case when target_ov.unlimited_until is null or source_ov.unlimited_until is null then null
                 else greatest(target_ov.unlimited_until,source_ov.unlimited_until) end
          when s_unl then source_ov.unlimited_until
          else target_ov.unlimited_until end,
        note=coalesce(nullif(btrim(coalesce(target_ov.note,'')),''),source_ov.note),
        updated_at=now(),
        updated_by='merge'
       where user_id=p_target_user_id;
      delete from public.user_overrides where user_id=source_user_id;
    end if;
  end if;
  -- История снятых ограничений остаётся в карточке основного кабинета (действующих здесь нет — см. выше).
  update public.user_restrictions set user_id=p_target_user_id where user_id=source_user_id;

  update public.user_telegram_identities set user_id=p_target_user_id,updated_at=now()
   where telegram_user_id=p_telegram_user_id;

  -- После переноса атрибуции восстанавливаем пропущенные начисления идемпотентно.
  perform public.award_referral_order(o.id) from public.payment_orders o
   where o.user_id=p_target_user_id and o.status='succeeded';

  return jsonb_build_object('sourceUserId',source_user_id,'deleteSource',true,
    'movedOrders',moved_orders,'movedHistory',moved_history,'movedCodes',moved_codes);
end;
$$;

create or replace function public.relink_telegram_identity(
  p_telegram_user_id bigint,
  p_target_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  source_user_id uuid;
  source_email text;
  target_email text;
  source_is_technical boolean;
begin
  select t.user_id
    into source_user_id
    from public.user_telegram_identities t
   where t.telegram_user_id = p_telegram_user_id
   for update;

  select u.email
    into target_email
    from auth.users u
   where u.id = p_target_user_id
     and u.email_confirmed_at is not null;

  if target_email is null then
    raise exception 'TARGET_ACCOUNT_NOT_CONFIRMED';
  end if;
  if target_email like '%@users.invalid' then
    raise exception 'TARGET_ACCOUNT_MUST_HAVE_EMAIL';
  end if;

  if source_user_id is null then
    return jsonb_build_object('sourceUserId', null, 'deleteSource', false);
  end if;
  if source_user_id = p_target_user_id then
    return jsonb_build_object('sourceUserId', source_user_id, 'deleteSource', false);
  end if;
  if exists (
    select 1 from public.user_telegram_identities
     where user_id = p_target_user_id
       and telegram_user_id <> p_telegram_user_id
  ) then
    raise exception 'TARGET_ACCOUNT_HAS_TELEGRAM';
  end if;

  select u.email
    into source_email
    from auth.users u
   where u.id = source_user_id;
  source_is_technical := coalesce(source_email, '') ~ '^telegram-[0-9]+@users[.]invalid$';

  -- Ограничение из админки перепривязкой не сбрасывается: Telegram ушёл бы к кабинету без ограничения,
  -- а технический кабинет удалился бы вместе с записью (on delete cascade). Касается и кабинета с почтой.
  if exists (
    select 1 from public.user_restrictions r
     where r.user_id = source_user_id and r.lifted_at is null
  ) or exists (
    select 1 from auth.users u
     where u.id = source_user_id and u.banned_until > now()
  ) then
    raise exception 'TELEGRAM_ACCOUNT_NOT_EMPTY: SOURCE_ACCOUNT_RESTRICTED';
  end if;

  if source_is_technical and (
    exists (
      select 1 from public.payment_orders
       where user_id = source_user_id
         and status in ('waiting_for_capture', 'succeeded')
    )
    or exists (select 1 from public.sticker_access_codes where owner_user_id = source_user_id)
    or exists (select 1 from public.license_keys where owner_user_id = source_user_id)
    or exists (select 1 from public.cell_print_licenses where owner_user_id = source_user_id)
    or exists (select 1 from public.user_generation_history where user_id = source_user_id)
    or exists (
      select 1 from public.telegram_generation_requests
       where user_id = source_user_id
         and status in ('processing', 'completed')
    )
    or exists (select 1 from public.referral_ledger where user_id = source_user_id)
    or exists (select 1 from public.referral_withdrawals where user_id = source_user_id)
    -- ручные лимиты и история ограничений из админки удалились бы вместе с кабинетом — только объединение
    or exists (select 1 from public.user_overrides where user_id = source_user_id)
    or exists (select 1 from public.user_restrictions where user_id = source_user_id)
    or exists (
      select 1 from public.referral_attributions
       where referrer_user_id = source_user_id
    )
    or exists (
      select 1 from public.referral_accounts
       where user_id = source_user_id
         and (available_kopecks <> 0 or reserved_kopecks <> 0 or earned_kopecks <> 0
              or paid_kopecks <> 0 or debt_kopecks <> 0)
    )
  ) then
    raise exception 'TELEGRAM_ACCOUNT_NOT_EMPTY';
  end if;

  if source_is_technical then
    update public.payment_orders
       set user_id = p_target_user_id,
           updated_at = now()
     where user_id = source_user_id
       and status in ('pending', 'canceled');
  end if;

  update public.user_telegram_identities
     set user_id = p_target_user_id,
         updated_at = now()
   where telegram_user_id = p_telegram_user_id;

  return jsonb_build_object(
    'sourceUserId', source_user_id,
    'deleteSource', source_is_technical
  );
end;
$$;

revoke all on function public.merge_telegram_account(bigint, uuid) from public, anon, authenticated;
revoke all on function public.relink_telegram_identity(bigint, uuid) from public, anon, authenticated;
grant execute on function public.merge_telegram_account(bigint, uuid) to service_role;
grant execute on function public.relink_telegram_identity(bigint, uuid) to service_role;

commit;
