import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');

describe('реферальные начисления', () => {
  it('привязывает реферала до создания платёжного заказа', () => {
    const payments = readFileSync(resolve(root, 'api/payments.js'), 'utf8');
    const bind = payments.search(/await maybeBindReferral\(req,\s*user\)/);
    const create = payments.search(/const orderPayload\s*=/);
    expect(bind).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(bind);
  });

  it('страхует гонку на стороне базы и исправляет пропущенные начисления', () => {
    const migration = readFileSync(
      resolve(root, 'supabase/migrations/20260917_referral_reward_race_fix.sql'),
      'utf8',
    );
    expect(migration).toContain("'order-reward:'||order_row.id::text");
    expect(migration).toContain('after insert on public.referral_attributions');
    expect(migration).toContain('after update of status,user_id on public.payment_orders');
    expect(migration).toContain('not exists (');
    expect(migration).toContain('public.award_referral_order(item.id)');
  });

  it('возвращает и показывает статистику по каждому приглашённому', () => {
    const cabinet = readFileSync(resolve(root, 'api/cabinet.js'), 'utf8');
    const page = readFileSync(resolve(root, 'src/pages/cabinet/ReferralsPage.tsx'), 'utf8');
    expect(cabinet).toContain('purchasesKopecks');
    expect(cabinet).toMatch(/earnedKopecks:\s*earned/);
    expect(page).toContain('referrals.map');
    expect(page).toContain('Сумма покупок');
  });
});
