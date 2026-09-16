begin;

-- Код был 10-символьным (/r/5E400590A9): такую ссылку неудобно диктовать и
-- она занимает лишнее место в сообщении. Новые коды — 6 символов.
-- Ранее выданные 10-символьные коды должны продолжать работать, поэтому
-- нижнюю границу проверки опускаем, а не сдвигаем окно целиком.
--
-- Имя check-ограничения задавалось Postgres автоматически, поэтому снимаем
-- его поиском по определению, а не по предполагаемому имени.
do $$
declare cname text;
begin
  for cname in
    select conname
      from pg_constraint
     where conrelid = 'public.referral_accounts'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%referral_code%'
  loop
    execute format('alter table public.referral_accounts drop constraint %I', cname);
  end loop;
end$$;

alter table public.referral_accounts
  add constraint referral_accounts_referral_code_check
  check (referral_code ~ '^[A-Z0-9]{6,16}$');

create or replace function public.ensure_referral_account(p_user_id uuid)
returns public.referral_accounts
language plpgsql
security definer
set search_path=public
as $$
declare
  result public.referral_accounts;
  candidate text;
begin
  select * into result from public.referral_accounts where user_id=p_user_id;

  if found then
    return result;
  end if;

  loop
    -- Источник случайности прежний: gen_random_uuid() доступен без pgcrypto,
    -- а хостинговый Supabase держит расширения вне схемы public.
    -- 6 символов из [A-Z0-9] — это 36^6 ≈ 2.2 млрд вариантов; редкие
    -- совпадения ловит unique_violation и цикл берёт следующий кандидат.
    candidate := upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
    begin
      insert into public.referral_accounts(user_id,referral_code)
      values(p_user_id,candidate)
      returning * into result;
      return result;
    exception when unique_violation then
      null;
    end;
  end loop;
end;
$$;

revoke all on function public.ensure_referral_account(uuid) from public, anon, authenticated;
grant execute on function public.ensure_referral_account(uuid) to service_role;

commit;
