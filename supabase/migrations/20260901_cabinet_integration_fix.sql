begin;

-- The initial function used pgcrypto.gen_random_bytes() with search_path=public.
-- Hosted Supabase installs extensions outside public, so use PostgreSQL's UUID
-- generator and keep the security-definer search path deliberately restricted.
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
  select * into result
  from public.referral_accounts
  where user_id=p_user_id;

  if found then
    return result;
  end if;

  loop
    candidate := upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
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
