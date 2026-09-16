begin;

-- Перепривязка выполняется одной транзакцией после того, как API независимо
-- проверил Telegram initData и access token целевого кабинета. Обычным
-- клиентам функция недоступна: вызывать её может только service_role.
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

  -- Реальный email-кабинет можно отключить от бота: он остаётся доступен по
  -- почте. Технический Telegram-only кабинет удалить можно только пустым.
  if source_is_technical and (
    exists (select 1 from public.payment_orders where user_id = source_user_id)
    or exists (select 1 from public.sticker_access_codes where owner_user_id = source_user_id)
    or exists (select 1 from public.license_keys where owner_user_id = source_user_id)
    or exists (select 1 from public.cell_print_licenses where owner_user_id = source_user_id)
    or exists (select 1 from public.user_generation_history where user_id = source_user_id)
    or exists (select 1 from public.telegram_generation_requests where user_id = source_user_id)
    or exists (select 1 from public.referral_ledger where user_id = source_user_id)
    or exists (select 1 from public.referral_withdrawals where user_id = source_user_id)
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

revoke all on function public.relink_telegram_identity(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.relink_telegram_identity(bigint, uuid)
  to service_role;

commit;
