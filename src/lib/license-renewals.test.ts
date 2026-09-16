import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('продление программных ключей', () => {
  const migration = read('supabase/migrations/20260904_cabinet_license_renewals.sql');
  const payments = read('api/payments.js');

  it('исполняет каждый заказ только один раз', () => {
    expect(migration).toContain('license_fulfilled_at is not null');
    expect(migration).toContain('license_fulfilled_at=now()');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('program_license_key is not null or cell_print_license_key is not null');
  });

  it('добавляет итерации к существующему ключу', () => {
    expect(migration).toContain('usage_limit=usage_limit+order_row.license_iterations');
    expect(migration).toContain('owner_user_id=order_row.user_id and active=true');
  });

  it('не теряет остаток срока и не позволяет занизить лимит устройств', () => {
    expect(migration).toContain('greatest(coalesce(expires_at,now()),now())');
    expect(migration).toContain('active_devices>order_row.cell_print_device_limit');
    expect(migration).toContain('when activated_at is null then null');
  });

  it('проверяет владельца до создания платежа', () => {
    expect(payments).toContain("if(!user)return res.status(401)");
    expect(payments).toContain('owner_user_id=eq.${encodeURIComponent(user.id)}');
    expect(payments).toContain('renewal_target_key=renewalTargetKey');
  });
});
