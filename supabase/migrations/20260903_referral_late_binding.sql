begin;

-- 1. Приглашение больше не «протухает» через 30 минут после регистрации.
--
-- Почту подтверждают письмом, и человек нередко открывает его через час или на
-- следующий день. До сих пор bind_referral в этом случае возвращала false и
-- реферал терялся молча. Срок жизни приглашения и так ограничен cookie shk_ref
-- (30 дней), а «только один раз и не самому себе» держат первичный ключ
-- referral_attributions.invited_user_id и проверка referrer <> p_user_id.
-- Обращения к auth.users больше нет, поэтому search_path сужаем до public.
create or replace function public.bind_referral(p_user_id uuid, p_code text)
returns boolean language plpgsql security definer set search_path=public as $$
declare referrer uuid;
begin
  select user_id into referrer
    from public.referral_accounts
   where referral_code = upper(btrim(p_code));

  if referrer is null or referrer = p_user_id then
    return false;
  end if;

  insert into public.referral_attributions(invited_user_id, referrer_user_id, referral_code)
    values (p_user_id, referrer, upper(btrim(p_code)))
    on conflict (invited_user_id) do nothing;

  return found;
end;$$;

-- 2. Покупка без регистрации тоже приносит рефереру 10%.
--
-- Приглашённый вправе купить пакет анонимно и завести аккаунт позже:
-- claim_user_asset проставляет такому заказу user_id, но начисление
-- срабатывало только на переходе заказа в succeeded, поэтому вознаграждение
-- терялось навсегда. Добавляем второй повод — появление владельца у уже
-- оплаченного заказа. Повторную выплату не пускает уникальный event_key
-- в referral_ledger, а разовое снятие резерва по применённому балансу
-- дополнительно ограничено переходом статуса.
create or replace function public.on_payment_order_accounting()
returns trigger language plpgsql security definer set search_path=public as $$
declare referrer uuid; reward bigint;
begin
  if new.status='succeeded' and new.user_id is not null then
    update public.sticker_access_codes set owner_user_id=new.user_id where code=new.access_code and owner_user_id is null;
    update public.license_keys set owner_user_id=new.user_id where key=new.program_license_key and owner_user_id is null;
    update public.cell_print_licenses set owner_user_id=new.user_id where key=new.cell_print_license_key and owner_user_id is null;
  end if;

  if new.status='succeeded'
     and (old.status is distinct from 'succeeded'
          or (old.user_id is null and new.user_id is not null)) then
    if new.user_id is not null then
      update public.sticker_access_codes set owner_user_id=new.user_id where code=new.access_code and owner_user_id is null;
      update public.license_keys set owner_user_id=new.user_id where key=new.program_license_key and owner_user_id is null;
      update public.cell_print_licenses set owner_user_id=new.user_id where key=new.cell_print_license_key and owner_user_id is null;

      -- Резерв снимается только в момент оплаты: иначе повторный заход этой
      -- ветки по появлению владельца списал бы reserved_kopecks второй раз.
      if new.referral_credit_kopecks>0 and old.status is distinct from 'succeeded' then
        update public.referral_accounts set reserved_kopecks=greatest(0,reserved_kopecks-new.referral_credit_kopecks),updated_at=now() where user_id=new.user_id;
      end if;

      select referrer_user_id into referrer from public.referral_attributions where invited_user_id=new.user_id;
      reward:=floor(new.amount*100*0.10)::bigint;
      if referrer is not null and reward>0 then
        perform public.ensure_referral_account(referrer);
        insert into public.referral_ledger(user_id,kind,amount_kopecks,order_id,event_key,details)
          values(referrer,'reward',reward,new.id,'order-reward:'||new.id::text,jsonb_build_object('invitedUserId',new.user_id))
          on conflict(event_key) do nothing;
        if found then update public.referral_accounts set available_kopecks=available_kopecks+greatest(reward-debt_kopecks,0),debt_kopecks=greatest(debt_kopecks-reward,0),earned_kopecks=earned_kopecks+reward,updated_at=now() where user_id=referrer; end if;
      end if;
    end if;
  elsif new.status='canceled' and old.status is distinct from 'canceled' and new.user_id is not null and new.referral_credit_kopecks>0 then
    insert into public.referral_ledger(user_id,kind,amount_kopecks,order_id,event_key)
      values(new.user_id,'spend_release',new.referral_credit_kopecks,new.id,'order-release:'||new.id::text)
      on conflict(event_key) do nothing;
    if found then
      update public.referral_accounts set available_kopecks=available_kopecks+new.referral_credit_kopecks,reserved_kopecks=greatest(0,reserved_kopecks-new.referral_credit_kopecks),updated_at=now() where user_id=new.user_id;
    end if;
  end if;

  return new;
end;$$;

commit;
