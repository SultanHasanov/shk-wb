begin;

-- Полное слияние Telegram-аккаунта с аккаунтом сайта (связка «через поддержку»).
--
-- Прошлая версия merge_telegram_account (20261116_user_restrictions.sql) переносила заказы, коды, ключи и
-- рефералку, но не баланс бота, подписки «Помощника», ПК и остальное: после неё api/auth.js удаляет
-- исходного пользователя, и всё это уходило каскадом (on delete cascade). relink_telegram_identity
-- и server/_telegram-account.js accountHasValuableData не смотрели кошелёк и подписки — аккаунт
-- с бонусом или подпиской от админа считался пустым и удалялся.
--
-- Здесь:
--   * account_merge_summary(p_user) — счётчики по всем значимым таблицам и флаг empty; один источник
--     правды для перепривязки, предпросмотра в админке, бота и accountHasValuableData;
--   * relink_telegram_identity — технический аккаунт удаляется только при пустой сводке
--     (иначе TELEGRAM_ACCOUNT_NOT_EMPTY — такой аккаунт идёт через объединение);
--   * merge_telegram_account — переносит всё, что раньше терялось. Сигнатуры прежние: старый код
--     (api/auth.js) работает с новыми функциями без изменений.
--
-- Облачные данные «Помощника» (app_points, app_docs и архив/зеркало пункта в своём Postgres) зашифрованы
-- ключом, выведенным из user_id (server/_app-crypto.js: HKDF(APP_DATA_KEY, user_id)). Перевесить их
-- в SQL нельзя: под другим user_id они не расшифруются, а строки зеркала без данных программа примет
-- за удалённые и сотрёт их на других ПК. Поэтому объединение с такими данными отказывает
-- (MERGE_CLOUD_DATA) — их нужно сначала перешифровать на сервере (отдельная задача; как поступать
-- с такими аккаунтами, решает владелец — см. план, A1).

-- Отметка пробного периода «ПВЗ Принт» может остаться без аккаунта (см. merge_telegram_account):
-- запрет второго пробного на том же компьютере держится по device_hash.
alter table public.cell_print_trial_claims alter column user_id drop not null;

-- ---------------------------------------------------------------------------------------------
-- Сводка аккаунта
-- ---------------------------------------------------------------------------------------------
create or replace function public.account_merge_summary(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_email text;
  v_technical boolean;
  v_restricted boolean;
  wallet_kopecks bigint := 0;
  wallet_ops integer := 0;
  paid_orders integer := 0;
  pending_orders integer := 0;
  sticker_codes integer := 0;
  stickers_left bigint := 0;
  license_keys_n integer := 0;
  cell_licenses_n integer := 0;
  history_n integer := 0;
  gen_requests integer := 0;
  gen_charges integer := 0;
  gen_reserved integer := 0;
  subs_n integer := 0;
  subs_active integer := 0;
  addons_n integer := 0;
  devices_n integer := 0;
  cell_devices_n integer := 0;
  points_n integer := 0;
  docs_n integer := 0;
  usage_n integer := 0;
  review_credits_n integer := 0;
  review_reveals_n integer := 0;
  individual_n integer := 0;
  custom_jobs_n integer := 0;
  partner_b boolean := false;
  oauth_n integer := 0;
  overrides_n integer := 0;
  device_bonus_n integer := 0;
  restrictions_n integer := 0;
  ref_balance bigint := 0;
  ref_nonzero boolean := false;
  ref_ops integer := 0;
  ref_withdrawals integer := 0;
  invited_n integer := 0;
begin
  if p_user is null then raise exception 'ACCOUNT_REQUIRED'; end if;
  select u.email into v_email from auth.users u where u.id = p_user;
  v_technical := coalesce(v_email, '') ~ '^telegram-[0-9]+@users[.]invalid$';
  v_restricted := exists (select 1 from public.user_restrictions r where r.user_id = p_user and r.lifted_at is null)
               or exists (select 1 from auth.users u where u.id = p_user and u.banned_until > now());

  select coalesce(max(balance_kopecks), 0) into wallet_kopecks from public.wallet_accounts where user_id = p_user;
  select count(*) into wallet_ops from public.wallet_ledger where user_id = p_user;
  select count(*) filter (where status in ('waiting_for_capture', 'succeeded')),
         count(*) filter (where status not in ('waiting_for_capture', 'succeeded'))
    into paid_orders, pending_orders
    from public.payment_orders where user_id = p_user;
  select count(*), coalesce(sum(greatest(coalesce(generation_limit, 0) - coalesce(generation_used, 0), 0)), 0)
    into sticker_codes, stickers_left
    from public.sticker_access_codes where owner_user_id = p_user;
  select count(*) into license_keys_n from public.license_keys where owner_user_id = p_user;
  select count(*) into cell_licenses_n from public.cell_print_licenses where owner_user_id = p_user;
  select count(*) into history_n from public.user_generation_history where user_id = p_user;
  select count(*) into gen_requests from public.telegram_generation_requests
   where user_id = p_user and status in ('processing', 'completed');
  select count(*), count(*) filter (where status in ('reserved', 'consumed'))
    into gen_charges, gen_reserved
    from public.sticker_generation_charges where user_id = p_user;
  select count(*), count(*) filter (where not canceled and ends_at > now())
    into subs_n, subs_active
    from public.app_subscriptions where user_id = p_user;
  select count(*) into addons_n from public.app_addons where user_id = p_user;
  select count(*) into devices_n from public.app_devices where user_id = p_user;
  select count(*) into cell_devices_n from public.cell_print_devices where user_id = p_user;
  select count(*) into points_n from public.app_points where user_id = p_user and revoked_at is null;
  select count(*) into docs_n from public.app_docs where user_id = p_user;
  select count(*) into usage_n from public.app_usage where user_id = p_user;
  select count(*) into review_credits_n from public.bot_review_credits
   where user_id = p_user and (balance > 0 or purchased > 0);
  select count(*) into review_reveals_n from public.bot_review_reveals where user_id = p_user;
  select count(*) into individual_n from public.individual_sticker_orders where user_id = p_user;
  select count(*) into custom_jobs_n from public.custom_sticker_jobs where user_id = p_user;
  partner_b := exists (select 1 from public.partners where user_id = p_user);
  select count(*) into oauth_n from public.user_oauth_identities where user_id = p_user;
  select count(*) into overrides_n from public.user_overrides where user_id = p_user;
  select count(*) into device_bonus_n from public.app_device_bonuses where user_id = p_user;
  select count(*) into restrictions_n from public.user_restrictions where user_id = p_user;
  select coalesce(sum(available_kopecks + reserved_kopecks), 0),
         coalesce(bool_or(available_kopecks <> 0 or reserved_kopecks <> 0 or earned_kopecks <> 0
                          or paid_kopecks <> 0 or debt_kopecks <> 0), false)
    into ref_balance, ref_nonzero
    from public.referral_accounts where user_id = p_user;
  select count(*) into ref_ops from public.referral_ledger where user_id = p_user;
  select count(*) into ref_withdrawals from public.referral_withdrawals where user_id = p_user;
  select count(*) into invited_n from public.referral_attributions where referrer_user_id = p_user;

  return jsonb_build_object(
    'userId', p_user,
    'technical', v_technical,
    'restricted', v_restricted,
    'walletKopecks', wallet_kopecks,
    'walletOperations', wallet_ops,
    'paidOrders', paid_orders,
    'pendingOrders', pending_orders,
    'stickerCodes', sticker_codes,
    'stickersLeft', stickers_left,
    'licenseKeys', license_keys_n,
    'cellPrintLicenses', cell_licenses_n,
    'generationHistory', history_n,
    'generationRequests', gen_requests,
    'generationCharges', gen_charges,
    'generationReserved', gen_reserved,
    'subscriptions', subs_n,
    'activeSubscriptions', subs_active,
    'addons', addons_n,
    'devices', devices_n,
    'cellPrintDevices', cell_devices_n,
    'points', points_n,
    'docs', docs_n,
    'appUsage', usage_n,
    'reviewCredits', review_credits_n,
    'reviewReveals', review_reveals_n,
    'individualOrders', individual_n,
    'customJobs', custom_jobs_n,
    'partner', partner_b,
    'oauthIdentities', oauth_n,
    'overrides', overrides_n + device_bonus_n,
    'restrictions', restrictions_n,
    'referralBalanceKopecks', ref_balance,
    'referralOperations', ref_ops,
    'referralWithdrawals', ref_withdrawals,
    'invitedUsers', invited_n,
    -- Пустой = удалить аккаунт можно без потерь. Незавершённые заказы (pending/canceled) не в счёт —
    -- перепривязка переносит их сама.
    'empty', wallet_kopecks = 0 and wallet_ops = 0 and paid_orders = 0
      and sticker_codes = 0 and license_keys_n = 0 and cell_licenses_n = 0
      and history_n = 0 and gen_requests = 0 and gen_charges = 0
      and subs_n = 0 and addons_n = 0 and devices_n = 0 and cell_devices_n = 0
      and points_n = 0 and docs_n = 0 and usage_n = 0
      and review_credits_n = 0 and review_reveals_n = 0
      and individual_n = 0 and custom_jobs_n = 0 and not partner_b and oauth_n = 0
      and overrides_n = 0 and device_bonus_n = 0 and restrictions_n = 0
      and not ref_nonzero and ref_ops = 0 and ref_withdrawals = 0 and invited_n = 0
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Объединение: Telegram-аккаунт (технический telegram-<id>@users.invalid) → аккаунт сайта с почтой
-- ---------------------------------------------------------------------------------------------
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
  moved_wallet bigint := 0;
  moved_subs integer := 0;
  moved_devices integer := 0;
  source_ov public.user_overrides;
  target_ov public.user_overrides;
  t_codes boolean;
  s_codes boolean;
  t_slots boolean;
  s_slots boolean;
  t_unl boolean;
  s_unl boolean;
  lock_key text;
  cursor_at timestamptz;
  remaining interval;
  sub public.app_subscriptions;
  addon_row public.app_addons;
  dev record;
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
    return jsonb_build_object('sourceUserId',source_user_id,'deleteSource',false,
      'movedWalletKopecks',0,'movedSubscriptions',0,'movedDevices',0);
  end if;
  if exists(select 1 from public.user_telegram_identities
             where user_id=p_target_user_id and telegram_user_id<>p_telegram_user_id) then
    raise exception 'TARGET_ACCOUNT_HAS_TELEGRAM';
  end if;
  select u.email into source_email from auth.users u where u.id=source_user_id;
  if coalesce(source_email,'') !~ '^telegram-[0-9]+@users[.]invalid$' then
    raise exception 'SOURCE_ACCOUNT_NOT_TECHNICAL';
  end if;
  -- Ограничение из админки объединением не сбрасывается: технический аккаунт после него удаляется
  -- (user_restrictions — on delete cascade), а Telegram уходит к основному аккаунту, где ограничения нет.
  -- Сначала ограничение снимает администратор. Текст исключения начинается с TELEGRAM_ACCOUNT_NOT_EMPTY —
  -- api/auth.js отвечает на него 409 «напишите в поддержку»; причина видна в логе.
  if exists(select 1 from public.user_restrictions r where r.user_id=source_user_id and r.lifted_at is null)
     or exists(select 1 from auth.users u where u.id=source_user_id and u.banned_until > now()) then
    raise exception 'TELEGRAM_ACCOUNT_NOT_EMPTY: SOURCE_ACCOUNT_RESTRICTED';
  end if;

  -- Те же замки, что берут списания и выдачи (wallet_move — строкой счёта, остальные — advisory):
  -- пока идёт слияние, ни у одного из двух аккаунтов не пройдёт параллельное списание или выдача
  -- подписки. Порядок — как у соседних функций, иначе взаимная блокировка:
  --   1) строки заказов: wallet_pay_order, wallet_refund_order, complete_*_order берут заказ, потом
  --      счёт или app_subs:/app_addons:;
  --   2) advisory по пользователю (между собой — по тексту ключа, чтобы два слияния не зажали друг друга);
  --   3) брони генераций: reserve_sticker_generation берёт advisory → бронь → счёт,
  --      refund_sticker_generation — бронь → счёт;
  --   4) строки счетов.
  perform 1 from public.payment_orders
   where user_id in (source_user_id, p_target_user_id) order by id for update;
  for lock_key in
    select k from (
      select p || u::text as k
        from unnest(array['sticker-generation:', 'app_subs:', 'app_addons:', 'bot_review:']) p,
             unnest(array[source_user_id, p_target_user_id]) u
    ) keys order by k
  loop
    perform pg_advisory_xact_lock(hashtext(lock_key));
  end loop;
  perform 1 from public.sticker_generation_charges
   where user_id in (source_user_id, p_target_user_id) order by id for update;
  perform 1 from public.wallet_accounts
   where user_id in (source_user_id, p_target_user_id) order by user_id for update;

  -- Конфликты, которые без человека не решить, — до любых изменений.
  -- Бронь генерации стикера: у обоих одновременно быть не может (одна бронь на пользователя).
  if exists(select 1 from public.sticker_generation_charges
             where user_id=source_user_id and status in ('reserved','consumed'))
     and exists(select 1 from public.sticker_generation_charges
                 where user_id=p_target_user_id and status in ('reserved','consumed')) then
    raise exception 'MERGE_BUSY: GENERATION_IN_PROGRESS';
  end if;
  if exists(select 1 from public.sticker_generation_charges s
             join public.sticker_generation_charges t
               on t.user_id=p_target_user_id and t.request_key=s.request_key
            where s.user_id=source_user_id) then
    raise exception 'MERGE_BUSY: GENERATION_REQUEST_KEY';
  end if;
  -- Один и тот же пункт WB в обоих аккаунтах.
  if exists(select 1 from public.app_points s
             join public.app_points t
               on t.user_id=p_target_user_id and t.wb_point_id=s.wb_point_id and t.revoked_at is null
            where s.user_id=source_user_id and s.revoked_at is null) then
    raise exception 'MERGE_POINT_CONFLICT';
  end if;
  -- Облачные данные «Помощника» зашифрованы ключом исходного user_id — см. заголовок файла.
  if exists(select 1 from public.app_points where user_id=source_user_id and revoked_at is null)
     or exists(select 1 from public.app_docs where user_id=source_user_id) then
    raise exception 'MERGE_CLOUD_DATA';
  end if;
  -- Партнёр — один на аккаунт.
  if exists(select 1 from public.partners where user_id=source_user_id)
     and exists(select 1 from public.partners where user_id=p_target_user_id) then
    raise exception 'MERGE_PARTNER_CONFLICT';
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
  -- Старые коды, перевешенные на исходный аккаунт прошлыми слияниями, остаются за объединённым.
  update public.referral_code_aliases set user_id=p_target_user_id where user_id=source_user_id;

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
  update public.telegram_referral_captures set bound_user_id=p_target_user_id
   where bound_user_id=source_user_id;

  -- Профиль основного аккаунта имеет приоритет, но пустые поля и настройки
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
  update public.cell_print_activations set activated_by=p_target_user_id where activated_by=source_user_id;
  update public.cell_print_pauses set user_id=p_target_user_id where user_id=source_user_id;

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
  -- Сессия мастера этого Telegram держит user_id исходного аккаунта (и бот кеширует его): после удаления
  -- исходного запись сессии упала бы на внешнем ключе. Бот начнёт с чистой сессии.
  delete from public.telegram_generator_sessions where telegram_user_id=p_telegram_user_id;
  update public.telegram_generator_sessions set user_id=p_target_user_id where user_id=source_user_id;

  -- Кошелёк. Строки журнала перевешиваются (event_key уникален глобально и не меняется — повтор
  -- вебхука старого пополнения не зачислит деньги второй раз: заказ уже у основного аккаунта,
  -- а ключ topup:<заказ> уже в журнале), балансы складываются, исходный счёт удаляется.
  select coalesce(max(balance_kopecks),0) into moved_wallet
    from public.wallet_accounts where user_id=source_user_id;
  if exists(select 1 from public.wallet_accounts where user_id=source_user_id) then
    insert into public.wallet_accounts(user_id,balance_kopecks,updated_at)
    values(p_target_user_id,moved_wallet,now())
    on conflict(user_id) do update set
      balance_kopecks=public.wallet_accounts.balance_kopecks+excluded.balance_kopecks,
      updated_at=now();
    delete from public.wallet_accounts where user_id=source_user_id;
  end if;
  update public.wallet_ledger
     set user_id=p_target_user_id,
         details=coalesce(details,'{}'::jsonb) || jsonb_build_object('mergedFrom',source_user_id::text)
   where user_id=source_user_id;

  -- Генерации стикеров: брони и итоги списаний (возврат по брони найдёт её по id и вернёт деньги
  -- на основной счёт). Разовая скидка: у основного своя запись — она главнее.
  update public.sticker_generation_charges set user_id=p_target_user_id where user_id=source_user_id;
  if not exists(select 1 from public.sticker_generation_discounts where user_id=p_target_user_id) then
    update public.sticker_generation_discounts set user_id=p_target_user_id where user_id=source_user_id;
  end if;
  delete from public.sticker_generation_discounts where user_id=source_user_id;

  -- «Кто поставил оценку»: открытые авторы (без повторов) и старые пакеты раскрытий.
  delete from public.bot_review_reveals s where s.user_id=source_user_id
   and exists(select 1 from public.bot_review_reveals t
               where t.user_id=p_target_user_id and t.point_id=s.point_id and t.client_id=s.client_id);
  update public.bot_review_reveals set user_id=p_target_user_id where user_id=source_user_id;
  insert into public.bot_review_credits(user_id,balance,purchased,updated_at)
  select p_target_user_id,balance,purchased,now()
    from public.bot_review_credits where user_id=source_user_id
  on conflict(user_id) do update set
    balance=public.bot_review_credits.balance+excluded.balance,
    purchased=public.bot_review_credits.purchased+excluded.purchased,
    updated_at=now();
  delete from public.bot_review_credits where user_id=source_user_id;

  update public.individual_sticker_orders set user_id=p_target_user_id,updated_at=now()
   where user_id=source_user_id;
  update public.custom_sticker_jobs set user_id=p_target_user_id,updated_at=now()
   where user_id=source_user_id;
  update public.partners set user_id=p_target_user_id where user_id=source_user_id;
  update public.user_oauth_identities set user_id=p_target_user_id,updated_at=now()
   where user_id=source_user_id;

  -- Подписки «Помощника». Нет действующих у основного — отрезки переходят как есть. Есть — остаток
  -- каждого действующего отрезка бота ставится в очередь после последнего отрезка основного
  -- (идущий отрезок обрывается сейчас и продолжается новым в очереди, ещё не начавшийся сдвигается).
  -- Истёкшие и отменённые переходят как история.
  select max(ends_at) into cursor_at from public.app_subscriptions
   where user_id=p_target_user_id and not canceled and ends_at > now();
  if cursor_at is null then
    select count(*) into moved_subs from public.app_subscriptions
     where user_id=source_user_id and not canceled and ends_at > now();
  else
    for sub in select * from public.app_subscriptions
                where user_id=source_user_id and not canceled and ends_at > now()
                order by starts_at, ends_at loop
      if sub.starts_at < now() then
        remaining := sub.ends_at - now();
        update public.app_subscriptions set ends_at=now() where id=sub.id;
        insert into public.app_subscriptions(user_id,plan,starts_at,ends_at,monthly_price,codes_per_month,
          stickers_per_month,device_limit,source_order_id,source)
        values(p_target_user_id,sub.plan,cursor_at,cursor_at+remaining,sub.monthly_price,sub.codes_per_month,
          sub.stickers_per_month,sub.device_limit,sub.source_order_id,sub.source);
      else
        remaining := sub.ends_at - sub.starts_at;
        update public.app_subscriptions set starts_at=cursor_at,ends_at=cursor_at+remaining,reminded_at=null
         where id=sub.id;
      end if;
      cursor_at := cursor_at + remaining;
      moved_subs := moved_subs + 1;
    end loop;
  end if;
  update public.app_subscriptions set user_id=p_target_user_id where user_id=source_user_id;

  -- Допуслуги — так же, отдельно по каждой услуге.
  for addon_row in select * from public.app_addons
                    where user_id=source_user_id and not canceled and ends_at > now()
                    order by addon, starts_at, ends_at loop
    select max(ends_at) into cursor_at from public.app_addons
     where user_id=p_target_user_id and addon=addon_row.addon and not canceled and ends_at > now();
    if cursor_at is not null then
      if addon_row.starts_at < now() then
        remaining := addon_row.ends_at - now();
        update public.app_addons set ends_at=now() where id=addon_row.id;
        insert into public.app_addons(user_id,addon,starts_at,ends_at,price,source_order_id,source)
        values(p_target_user_id,addon_row.addon,cursor_at,cursor_at+remaining,addon_row.price,
          addon_row.source_order_id,addon_row.source);
      else
        remaining := addon_row.ends_at - addon_row.starts_at;
        -- сразу к основному: следующий отрезок той же услуги встанет уже после этого
        update public.app_addons set user_id=p_target_user_id,starts_at=cursor_at,ends_at=cursor_at+remaining,
               reminded_at=null
         where id=addon_row.id;
      end if;
    end if;
  end loop;
  update public.app_addons set user_id=p_target_user_id where user_id=source_user_id;

  -- ПК «Помощника». Тот же компьютер в обоих аккаунтах (device_hash) — остаётся строка основного,
  -- а всё, что ссылалось на строку бота, переводится на неё; остальные ПК переходят как есть.
  for dev in select s.id as source_id, t.id as target_id
               from public.app_devices s
               join public.app_devices t on t.user_id=p_target_user_id and t.device_hash=s.device_hash
              where s.user_id=source_user_id loop
    update public.app_usage set device_id=dev.target_id where device_id=dev.source_id;
    update public.app_points set last_device_id=dev.target_id where last_device_id=dev.source_id;
    update public.app_docs set device_id=dev.target_id where device_id=dev.source_id;
    update public.app_secret_access set device_id=dev.target_id where device_id=dev.source_id;
    update public.app_code_approvals set device_id=dev.target_id where device_id=dev.source_id;
    update public.app_device_messages set device_id=dev.target_id where device_id=dev.source_id;
    update public.app_telegram_link_tokens set device_id=dev.target_id where device_id=dev.source_id;
    delete from public.app_devices where id=dev.source_id;
  end loop;
  update public.app_devices set user_id=p_target_user_id where user_id=source_user_id;
  get diagnostics moved_devices=row_count;
  update public.app_usage set user_id=p_target_user_id where user_id=source_user_id;
  update public.app_secret_access set user_id=p_target_user_id where user_id=source_user_id;
  -- Без внешнего ключа на auth.users, но привязаны к ПК и аккаунту.
  update public.app_code_approvals set user_id=p_target_user_id where user_id=source_user_id;
  update public.app_device_messages set user_id=p_target_user_id where user_id=source_user_id;
  update public.app_telegram_link_tokens set user_id=p_target_user_id where user_id=source_user_id;
  -- Отключённые пункты бота (revoked_at) и история документов без документов уходят вместе
  -- с исходным аккаунтом, как и раньше: данные в них зашифрованы его ключом.

  -- Надбавка ПК старого образца — большая из двух.
  insert into public.app_device_bonuses(user_id,devices,note,created_at,updated_at)
  select p_target_user_id,devices,note,created_at,now()
    from public.app_device_bonuses where user_id=source_user_id
  on conflict(user_id) do update set
    devices=greatest(public.app_device_bonuses.devices,excluded.devices),
    note=coalesce(public.app_device_bonuses.note,excluded.note),
    updated_at=now();
  delete from public.app_device_bonuses where user_id=source_user_id;

  -- ПК «ПВЗ Принт»: при совпадении device_hash остаётся строка основного.
  delete from public.cell_print_devices s where s.user_id=source_user_id
   and exists(select 1 from public.cell_print_devices t
               where t.user_id=p_target_user_id and t.device_hash=s.device_hash);
  update public.cell_print_devices set user_id=p_target_user_id where user_id=source_user_id;
  -- Пробный период «ПВЗ Принт»: одна отметка на аккаунт (unique user_id) и одна на компьютер
  -- (device_hash). У основного своя — отметка компьютера бота остаётся без аккаунта (user_id=null),
  -- иначе она ушла бы каскадом и этот ПК получил бы пробный период ещё раз.
  if not exists(select 1 from public.cell_print_trial_claims where user_id=p_target_user_id) then
    update public.cell_print_trial_claims set user_id=p_target_user_id where user_id=source_user_id;
  else
    update public.cell_print_trial_claims set user_id=null where user_id=source_user_id;
  end if;

  -- Ручные лимиты из админки (user_overrides) не теряются вместе с техническим аккаунтом:
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
  -- История снятых ограничений остаётся в карточке основного аккаунта (действующих здесь нет — см. выше).
  update public.user_restrictions set user_id=p_target_user_id where user_id=source_user_id;

  update public.user_telegram_identities set user_id=p_target_user_id,updated_at=now()
   where telegram_user_id=p_telegram_user_id;

  -- После переноса атрибуции восстанавливаем пропущенные начисления идемпотентно.
  perform public.award_referral_order(o.id) from public.payment_orders o
   where o.user_id=p_target_user_id and o.status='succeeded';

  return jsonb_build_object('sourceUserId',source_user_id,'deleteSource',true,
    'movedOrders',moved_orders,'movedHistory',moved_history,'movedCodes',moved_codes,
    'movedWalletKopecks',moved_wallet,'movedSubscriptions',moved_subs,'movedDevices',moved_devices);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Перепривязка: Telegram уходит к аккаунту сайта, технический аккаунт удаляется (только пустой)
-- ---------------------------------------------------------------------------------------------
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
  source_summary jsonb;
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

  -- Ограничение из админки перепривязкой не сбрасывается: Telegram ушёл бы к аккаунту без ограничения,
  -- а технический аккаунт удалился бы вместе с записью (on delete cascade). Касается и аккаунта с почтой.
  if exists (
    select 1 from public.user_restrictions r
     where r.user_id = source_user_id and r.lifted_at is null
  ) or exists (
    select 1 from auth.users u
     where u.id = source_user_id and u.banned_until > now()
  ) then
    raise exception 'TELEGRAM_ACCOUNT_NOT_EMPTY: SOURCE_ACCOUNT_RESTRICTED';
  end if;

  -- Технический аккаунт после перепривязки удаляется (api/auth.js, deleteSource) — только если
  -- в нём ничего нет: баланс, журнал кошелька, подписки, ПК, ключи, коды, заказы, отзывы… (полная сводка).
  -- Иначе — объединение. Аккаунт с почтой не удаляется: у него переходит только связка с Telegram,
  -- его данные остаются при нём.
  if source_is_technical then
    source_summary := public.account_merge_summary(source_user_id);
    if not coalesce((source_summary->>'empty')::boolean, false) then
      raise exception 'TELEGRAM_ACCOUNT_NOT_EMPTY';
    end if;
  end if;

  if source_is_technical then
    update public.payment_orders
       set user_id = p_target_user_id,
           updated_at = now()
     where user_id = source_user_id
       and status in ('pending', 'canceled');
    -- Сессия мастера держит user_id удаляемого аккаунта — бот начнёт с чистой.
    delete from public.telegram_generator_sessions where telegram_user_id = p_telegram_user_id;
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

revoke all on function public.account_merge_summary(uuid) from public, anon, authenticated;
revoke all on function public.merge_telegram_account(bigint, uuid) from public, anon, authenticated;
revoke all on function public.relink_telegram_identity(bigint, uuid) from public, anon, authenticated;
grant execute on function public.account_merge_summary(uuid) to service_role;
grant execute on function public.merge_telegram_account(bigint, uuid) to service_role;
grant execute on function public.relink_telegram_identity(bigint, uuid) to service_role;

commit;
