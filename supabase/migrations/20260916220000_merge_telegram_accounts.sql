begin;

-- Объединяет технический Telegram-only кабинет с подтверждённым email-кабинетом.
-- API перед вызовом независимо проверяет Telegram initData и access token цели;
-- сама функция повторяет критические проверки и переносит данные транзакционно.
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
  moved_orders integer := 0;
  moved_history integer := 0;
  moved_codes integer := 0;
begin
  select t.user_id into source_user_id
    from public.user_telegram_identities t
   where t.telegram_user_id = p_telegram_user_id
   for update;

  select u.email into target_email
    from auth.users u
   where u.id = p_target_user_id and u.email_confirmed_at is not null;
  if target_email is null or target_email like '%@users.invalid' then
    raise exception 'TARGET_ACCOUNT_NOT_CONFIRMED';
  end if;
  if source_user_id is null then raise exception 'TELEGRAM_ACCOUNT_NOT_FOUND'; end if;
  if source_user_id = p_target_user_id then
    return jsonb_build_object('sourceUserId', source_user_id, 'deleteSource', false);
  end if;
  if exists (
    select 1 from public.user_telegram_identities
     where user_id = p_target_user_id and telegram_user_id <> p_telegram_user_id
  ) then raise exception 'TARGET_ACCOUNT_HAS_TELEGRAM'; end if;

  select u.email into source_email from auth.users u where u.id = source_user_id;
  if coalesce(source_email, '') !~ '^telegram-[0-9]+@users[.]invalid$' then
    raise exception 'SOURCE_ACCOUNT_NOT_TECHNICAL';
  end if;

  -- Денежные реферальные отношения требуют ручной сверки. Обычные покупки,
  -- пакеты и история ниже переносятся автоматически.
  if exists (select 1 from public.referral_ledger where user_id = source_user_id)
     or exists (select 1 from public.referral_withdrawals where user_id = source_user_id)
     or exists (select 1 from public.referral_attributions where referrer_user_id = source_user_id)
     or exists (
       select 1 from public.referral_accounts
        where user_id = source_user_id
          and (available_kopecks <> 0 or reserved_kopecks <> 0 or earned_kopecks <> 0
               or paid_kopecks <> 0 or debt_kopecks <> 0)
     ) then
    raise exception 'TELEGRAM_ACCOUNT_FINANCIAL_CONFLICT';
  end if;

  update public.payment_orders set user_id = p_target_user_id, updated_at = now()
   where user_id = source_user_id;
  get diagnostics moved_orders = row_count;

  update public.sticker_access_codes set owner_user_id = p_target_user_id
   where owner_user_id = source_user_id;
  get diagnostics moved_codes = row_count;
  update public.license_keys set owner_user_id = p_target_user_id
   where owner_user_id = source_user_id;
  update public.cell_print_licenses set owner_user_id = p_target_user_id
   where owner_user_id = source_user_id;

  delete from public.user_generation_history s
   where s.user_id = source_user_id
     and exists (
       select 1 from public.user_generation_history t
        where t.user_id = p_target_user_id and t.client_entry_id = s.client_entry_id
     );
  update public.user_generation_history set user_id = p_target_user_id
   where user_id = source_user_id;
  get diagnostics moved_history = row_count;

  delete from public.in_app_notifications s
   where s.user_id = source_user_id
     and exists (
       select 1 from public.in_app_notifications t
        where t.user_id = p_target_user_id and t.dedupe_key = s.dedupe_key
     );
  update public.in_app_notifications set user_id = p_target_user_id
   where user_id = source_user_id;
  update public.notification_deliveries set user_id = p_target_user_id
   where user_id = source_user_id;
  update public.telegram_generation_requests set user_id = p_target_user_id
   where user_id = source_user_id;
  update public.telegram_generator_sessions set user_id = p_target_user_id
   where user_id = source_user_id;

  if exists (select 1 from public.referral_attributions where invited_user_id = source_user_id) then
    if exists (select 1 from public.referral_attributions where invited_user_id = p_target_user_id)
       or exists (
         select 1 from public.referral_attributions
          where invited_user_id = source_user_id and referrer_user_id = p_target_user_id
       ) then
      delete from public.referral_attributions where invited_user_id = source_user_id;
    else
      update public.referral_attributions set invited_user_id = p_target_user_id
       where invited_user_id = source_user_id;
    end if;
  end if;

  update public.user_telegram_identities
     set user_id = p_target_user_id, updated_at = now()
   where telegram_user_id = p_telegram_user_id;

  return jsonb_build_object(
    'sourceUserId', source_user_id,
    'deleteSource', true,
    'movedOrders', moved_orders,
    'movedHistory', moved_history,
    'movedCodes', moved_codes
  );
end;
$$;

revoke all on function public.merge_telegram_account(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.merge_telegram_account(bigint, uuid)
  to service_role;

commit;
