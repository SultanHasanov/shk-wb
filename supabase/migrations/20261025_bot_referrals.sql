begin;

-- Рефералка в Telegram-боте поверх существующей (referral_accounts/bind_referral, 10% от оплат).
--
-- 1) Ссылка t.me/<бот>?start=r_<КОД>: бот запоминает код за Telegram-пользователем (первый
--    переход побеждает). Кабинета у него ещё нет — привязка (bind_referral) делается, когда он
--    войдёт через Mini App и кабинет создастся (captured_at раньше регистрации — как с cookie сайта).
-- 2) Реферальные деньги можно перевести на баланс бота (wallet) — тратить на стикеры, оценки,
--    подписку. Вывод на карту остаётся в кабинете сайта.

create table if not exists public.telegram_referral_captures (
  telegram_user_id bigint primary key,
  referral_code text not null check (referral_code ~ '^[A-Z0-9]{6,16}$'),
  captured_at timestamptz not null default now(),
  bound_user_id uuid references auth.users(id) on delete set null,
  bound_at timestamptz
);
alter table public.telegram_referral_captures enable row level security;
revoke all on table public.telegram_referral_captures from public, anon, authenticated;
grant select, insert, update, delete on table public.telegram_referral_captures to service_role;

alter table public.referral_ledger drop constraint if exists referral_ledger_kind_check;
alter table public.referral_ledger add constraint referral_ledger_kind_check check (kind in
  ('reward','spend','spend_release','withdraw_hold','withdraw_release','withdraw_paid','forfeit','reversal','to_wallet'));

alter table public.wallet_ledger drop constraint if exists wallet_ledger_kind_check;
alter table public.wallet_ledger add constraint wallet_ledger_kind_check check (kind in
  ('topup','bonus','spend','refund','admin','referral'));

-- Перевод реферальных денег на баланс бота. p_kopecks=null — всё доступное.
-- Ответ: {ok, moved, referral_available, wallet_balance}.
create or replace function public.referral_to_wallet(p_user uuid, p_kopecks bigint default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  account public.referral_accounts;
  amount bigint;
  event text := 'ref-to-wallet:' || gen_random_uuid()::text;
  moved jsonb;
begin
  select * into account from public.referral_accounts where user_id = p_user for update;
  if not found then return jsonb_build_object('ok', false, 'moved', 0, 'referral_available', 0); end if;
  amount := coalesce(p_kopecks, account.available_kopecks);
  if amount <= 0 or amount > account.available_kopecks then
    return jsonb_build_object('ok', false, 'moved', 0, 'referral_available', account.available_kopecks);
  end if;
  update public.referral_accounts set available_kopecks = available_kopecks - amount, updated_at = now()
   where user_id = p_user returning * into account;
  insert into public.referral_ledger(user_id, kind, amount_kopecks, event_key, details)
    values (p_user, 'to_wallet', -amount, event, '{}'::jsonb);
  moved := public.wallet_move(p_user, amount, 'referral', event, null, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'moved', amount, 'referral_available', account.available_kopecks,
                            'wallet_balance', (moved->>'balance')::bigint);
end;
$$;

revoke all on function public.referral_to_wallet(uuid,bigint) from public, anon, authenticated;
grant execute on function public.referral_to_wallet(uuid,bigint) to service_role;

commit;
