begin;

create table if not exists public.referral_code_aliases (
  referral_code text primary key check (referral_code ~ '^[A-Z0-9]{6,16}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists referral_code_aliases_user_idx
  on public.referral_code_aliases(user_id);
alter table public.referral_code_aliases enable row level security;
revoke all on table public.referral_code_aliases from public, anon, authenticated;
grant select, insert, update, delete on table public.referral_code_aliases to service_role;

-- Старые ссылки объединённого кабинета продолжают приводить к новому владельцу.
create or replace function public.bind_referral(
  p_user_id uuid,
  p_code text,
  p_captured_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path=public,auth
as $$
declare referrer uuid; registered_at timestamptz; normalized text := upper(btrim(p_code));
begin
  select created_at into registered_at from auth.users where id=p_user_id;
  if registered_at is null or p_captured_at is null or p_captured_at>registered_at
     or p_captured_at<now()-interval '30 days' then return false; end if;
  select user_id into referrer from public.referral_accounts where referral_code=normalized;
  if referrer is null then
    select user_id into referrer from public.referral_code_aliases where referral_code=normalized;
  end if;
  if referrer is null or referrer=p_user_id then return false; end if;
  insert into public.referral_attributions(invited_user_id,referrer_user_id,referral_code)
  values(p_user_id,referrer,normalized) on conflict(invited_user_id) do nothing;
  return found;
end;
$$;

create or replace function public.ensure_referral_account(p_user_id uuid)
returns public.referral_accounts
language plpgsql
security definer
set search_path=public
as $$
declare result public.referral_accounts; candidate text;
begin
  select * into result from public.referral_accounts where user_id=p_user_id;
  if found then return result; end if;
  loop
    candidate := upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
    if exists(select 1 from public.referral_code_aliases where referral_code=candidate) then
      continue;
    end if;
    begin
      insert into public.referral_accounts(user_id,referral_code)
      values(p_user_id,candidate) returning * into result;
      return result;
    exception when unique_violation then null;
    end;
  end loop;
end;
$$;

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
  update public.user_telegram_identities set user_id=p_target_user_id,updated_at=now()
   where telegram_user_id=p_telegram_user_id;

  -- После переноса атрибуции восстанавливаем пропущенные начисления идемпотентно.
  perform public.award_referral_order(o.id) from public.payment_orders o
   where o.user_id=p_target_user_id and o.status='succeeded';

  return jsonb_build_object('sourceUserId',source_user_id,'deleteSource',true,
    'movedOrders',moved_orders,'movedHistory',moved_history,'movedCodes',moved_codes);
end;
$$;

revoke all on function public.bind_referral(uuid,text,timestamptz),
  public.ensure_referral_account(uuid), public.merge_telegram_account(bigint,uuid)
  from public,anon,authenticated;
grant execute on function public.bind_referral(uuid,text,timestamptz),
  public.ensure_referral_account(uuid), public.merge_telegram_account(bigint,uuid)
  to service_role;

commit;
