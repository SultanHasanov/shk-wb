import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260916200000_allow_pending_orders_telegram_relink.sql'),
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
