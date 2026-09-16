import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260916200000_allow_pending_orders_telegram_relink.sql'),
  'utf8',
);
const mergeMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260916220000_merge_telegram_accounts.sql'),
  'utf8',
);
const referralMergeMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260916230000_merge_telegram_referrals.sql'),
  'utf8',
);

describe('Telegram account relink migration', () => {
  it('не удаляет технический аккаунт с покупками или пользовательскими данными', () => {
    for (const table of [
      'payment_orders',
      'sticker_access_codes',
      'license_keys',
      'cell_print_licenses',
      'user_generation_history',
      'telegram_generation_requests',
      'referral_ledger',
      'referral_withdrawals',
    ]) {
      expect(migration).toContain(`public.${table}`);
    }
    expect(migration).toContain('TELEGRAM_ACCOUNT_NOT_EMPTY');
    expect(migration).toContain("status in ('waiting_for_capture', 'succeeded')");
    expect(migration).toContain("status in ('processing', 'completed')");
  });

  it('переносит незавершённые заказы вместо блокировки входа', () => {
    expect(migration).toContain("status in ('pending', 'canceled')");
    expect(migration).toContain('set user_id = p_target_user_id');
  });

  it('оставляет RPC доступной только серверной роли', () => {
    expect(migration).toMatch(/revoke all on function[\s\S]+from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function[\s\S]+to service_role/);
  });
});

describe('Telegram account merge migration', () => {
  it('переносит основные пользовательские данные одной транзакцией', () => {
    for (const table of [
      'payment_orders',
      'sticker_access_codes',
      'license_keys',
      'cell_print_licenses',
      'user_generation_history',
      'in_app_notifications',
      'notification_deliveries',
      'telegram_generation_requests',
    ]) {
      expect(mergeMigration).toContain(`public.${table}`);
    }
    expect(mergeMigration).toContain('update public.user_telegram_identities');
  });

  it('останавливается при финансовом реферальном конфликте', () => {
    expect(mergeMigration).toContain('TELEGRAM_ACCOUNT_FINANCIAL_CONFLICT');
    expect(mergeMigration).toContain('public.referral_ledger');
    expect(mergeMigration).toContain('public.referral_withdrawals');
  });

  it('доступна только серверной роли', () => {
    expect(mergeMigration).toMatch(/revoke all on function[\s\S]+from public, anon, authenticated/);
    expect(mergeMigration).toMatch(/grant execute on function[\s\S]+to service_role/);
  });
});

describe('Telegram referral merge migration', () => {
  it('переносит реферальные деньги, выплаты и приглашённых в основной кабинет', () => {
    expect(referralMergeMigration).toContain('update public.referral_ledger set user_id=p_target_user_id');
    expect(referralMergeMigration).toContain('update public.referral_withdrawals set user_id=p_target_user_id');
    expect(referralMergeMigration).toContain('update public.referral_attributions set referrer_user_id=p_target_user_id');
    for (const field of ['available_kopecks', 'reserved_kopecks', 'earned_kopecks', 'paid_kopecks', 'debt_kopecks']) {
      expect(referralMergeMigration).toContain(`${field}=${field}+source_ref.${field}`);
    }
  });

  it('не теряет профиль и настройки технического кабинета при его удалении', () => {
    expect(referralMergeMigration).toContain('insert into public.user_profiles');
    expect(referralMergeMigration).toContain('delete from public.user_profiles where user_id=source_user_id');
    expect(referralMergeMigration).toContain('insert into public.user_preferences');
    expect(referralMergeMigration).toContain('delete from public.user_preferences where user_id=source_user_id');
  });

  it('сохраняет старый реферальный код как алиас и учитывает его при регистрации', () => {
    expect(referralMergeMigration).toContain('create table if not exists public.referral_code_aliases');
    expect(referralMergeMigration).toContain('from public.referral_code_aliases where referral_code=normalized');
    expect(referralMergeMigration).toContain('values(source_ref.referral_code,p_target_user_id)');
    expect(referralMergeMigration).toContain('REFERRAL_CODE_ALIAS_CONFLICT');
  });

  it('оставляет функции объединения и рефералов доступными только серверной роли', () => {
    expect(referralMergeMigration).toMatch(/revoke all on function[\s\S]+from public,anon,authenticated/);
    expect(referralMergeMigration).toMatch(/grant execute on function[\s\S]+to service_role/);
  });
});
