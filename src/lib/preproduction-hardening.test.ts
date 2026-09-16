import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('предрелизная защита', () => {
  it('не публикует платный установщик и source maps', () => {
    expect(read('build-static.mjs')).not.toContain("'downloads',");
    expect(read('.vercelignore')).not.toContain('setup 1.3.2.exe');
    expect(read('vite.config.ts')).toContain('sourcemap: false');
  });

  it('создаёт шестизначные коды и сохраняет уже выданные STK-коды', () => {
    const migration = read('supabase/migrations/20260908_six_digit_access_codes.sql');
    expect(migration).toContain("lpad(floor(random() * 1000000)::integer::text, 6, '0')");
    const access = read('server/_access-code.js');
    expect(access).toContain('\\d{6}');
    expect(access).toContain('STK-[A-F0-9]{32}');
    expect(access).toContain('randomInt(0, 1_000_000)');
  });

  it('разделяет оплату и исполнение заказа', () => {
    const payments = read('server/_payments.js');
    expect(payments).toContain("fulfillment_status:'processing'");
    expect(payments).toContain("fulfillment_status:'failed'");
    expect(payments).toContain("fulfillment_status:'fulfilled'");
    expect(payments.indexOf("rpc/complete_payment_order")).toBeLessThan(payments.indexOf("fulfillment_status:'fulfilled'"));
  });

  it('миграция содержит лимиты, поддержку, проморезервы и возвраты', () => {
    const sql = read('supabase/migrations/20260906_preproduction_hardening.sql');
    for (const fragment of ['consume_api_rate_limit','support_requests','reserve_cell_print_promo','release_stale_payment_reservations','process_order_refund','merge_printed_history_codes']) {
      expect(sql).toContain(fragment);
    }
  });

  it('сброс пароля разрешён только recovery-сессии', () => {
    const page = read('src/pages/ResetPasswordPage.tsx');
    expect(page).toContain('!auth.recoveryMode');
    expect(page).toContain("auth.status !== 'authenticated' || !auth.recoveryMode");
  });
});
