// «Помощник ПВЗ» 1.13: офлайн до конца тарифа (подписанное rights.until), раздел «Операции по дням»
// только на «Про», докупка кодов клиента к тарифу (5 за 200 ₽, 10 за 380 ₽).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Ent = Record<string, unknown>;
const account = require('../../server/_app-account.js') as {
  leaseRights: (req: unknown) => Promise<Record<string, unknown>>;
  rightsUntil: (a: { ent: Ent; free: boolean; unlimited: boolean; plan: string | null; freeUntil?: string | null; now?: number }) => number | null;
};
const plans = require('../../server/_app-plans.js') as {
  CODE_TOPUPS: Record<number, number>;
  codeTopupPrice: (count: number) => number | null;
  publicPlans: () => { codeTopups: { count: number; price: number }[]; features: Record<string, string>; plans: { id: string; features: string[] }[] };
  PLANS: Record<string, { features: string[] }>;
};
const payments = require('../../server/_payments.js') as { LICENSE_PRICES: Record<number, number> };

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const NOW = Date.parse('2026-11-14T10:00:00Z');

describe('офлайн: до какого момента права действуют без связи', () => {
  it('оплаченный тариф — до конца оплаченного срока', () => {
    const ent = { plan: 'pro', ends_at: '2026-12-01T00:00:00Z', paid_until: '2027-02-01T00:00:00Z', next_plan: 'pro' };
    expect(account.rightsUntil({ ent, free: false, unlimited: false, plan: 'pro', now: NOW })).toBe(unix('2027-02-01T00:00:00Z'));
  });

  it('дальше в очереди другой тариф — только до конца текущего отрезка', () => {
    const ent = { plan: 'pro', ends_at: '2026-12-01T00:00:00Z', paid_until: '2027-02-01T00:00:00Z', next_plan: 'standard' };
    expect(account.rightsUntil({ ent, free: false, unlimited: false, plan: 'pro', now: NOW })).toBe(unix('2026-12-01T00:00:00Z'));
  });

  it('бесплатный период: до его конца, без даты — 30 дней вперёд', () => {
    expect(account.rightsUntil({ ent: {}, free: true, unlimited: false, plan: null, freeUntil: '2026-11-30T20:59:59Z', now: NOW }))
      .toBe(unix('2026-11-30T20:59:59Z'));
    expect(account.rightsUntil({ ent: {}, free: true, unlimited: false, plan: null, freeUntil: null, now: NOW }))
      .toBe(Math.floor(NOW / 1000) + 30 * 86400);
  });

  it('безлимит: до своей даты или бессрочно', () => {
    expect(account.rightsUntil({ ent: { unlimited_until: '2027-01-01T00:00:00Z' }, free: false, unlimited: true, plan: 'pro', now: NOW }))
      .toBe(unix('2027-01-01T00:00:00Z'));
    expect(account.rightsUntil({ ent: {}, free: false, unlimited: true, plan: null, now: NOW })).toBeNull();
  });

  it('без тарифа закрывать нечего — null', () => {
    expect(account.rightsUntil({ ent: { packs_left: 5 }, free: false, unlimited: false, plan: null, now: NOW })).toBeNull();
  });
});

describe('офлайн: аренда', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
    process.env.SUPABASE_SECRET_KEY = 'secret';
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const DEVICE = 'a'.repeat(64);
  const request = () => ({
    method: 'POST', query: { action: 'lease' }, body: undefined,
    headers: { 'x-app-version': '1.13.0', 'x-device-id': DEVICE, authorization: 'Bearer t' }, socket: { remoteAddress: '127.0.0.1' },
  });
  function mock(ent: Ent, restriction: unknown[] = []) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = url.includes('consume_api_rate_limit') ? true
        : url.endsWith('/auth/v1/user') ? { id: 'u1', email: 'a@b.c' }
        : url.includes('rpc/app_entitlements') ? ent
        : url.includes('app_devices?user_id=') ? [{ id: 'd1', name: 'Касса', last_seen_at: new Date().toISOString(), denied: [], point_wb: '1' }]
        : url.includes('user_restrictions') || url.includes('restriction') ? restriction
        : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
  }

  it('в подписанных правах есть дата окончания тарифа и раздел «Операции по дням» у «Про»', async () => {
    const end = new Date(Date.now() + 20 * 86400000).toISOString();
    mock({ plan: 'pro', device_limit: 4, packs_left: 0, addons: {}, ends_at: end, paid_until: end });
    const rights = await account.leaseRights(request());
    expect(rights.until).toBe(unix(end));
    expect(rights.features).toContain('ops');
  });

  it('«Стандарт» раздел «Операции по дням» не получает', async () => {
    const end = new Date(Date.now() + 20 * 86400000).toISOString();
    mock({ plan: 'standard', device_limit: 2, packs_left: 0, addons: {}, ends_at: end, paid_until: end });
    const rights = await account.leaseRights(request());
    expect(rights.features).not.toContain('ops');
    expect(rights.features).toContain('boxes');
  });
});

describe('докупка кодов клиента к тарифу', () => {
  it('5 за 200 ₽ и 10 за 380 ₽ — дешевле обычного пакета', () => {
    expect(plans.codeTopupPrice(5)).toBe(200);
    expect(plans.codeTopupPrice(10)).toBe(380);
    expect(plans.codeTopupPrice(5)!).toBeLessThan(payments.LICENSE_PRICES[5]);
    expect(plans.codeTopupPrice(10)!).toBeLessThan(payments.LICENSE_PRICES[10]);
  });

  it('других количеств нет', () => {
    for (const n of [0, 1, 3, 7, 20, NaN]) expect(plans.codeTopupPrice(n)).toBeNull();
  });

  it('программа получает цены из /api/app/plans', () => {
    expect(plans.publicPlans().codeTopups).toEqual([{ count: 5, price: 200 }, { count: 10, price: 380 }]);
  });

  it('количества докупки — допустимые пакеты ключа (SQL принимает 1,3,5,10,20)', () => {
    for (const n of Object.keys(plans.CODE_TOPUPS)) expect(payments.LICENSE_PRICES).toHaveProperty(n);
  });

  it('цена подписчика даётся только аккаунту с тарифом, оплата по QR СБП разрешена', () => {
    const src = readFileSync('api/payments.js', 'utf8');
    // признак из запроса не открывает цену сам: рядом проверка входа и действующей подписки
    const block = src.slice(src.indexOf("req.body?.appCodeTopup === true"), src.indexOf('codeTopupTotal = price;'));
    expect(block).toContain('if (!user)');
    expect(block).toContain('app_subscriptions?user_id=');
    expect(block).toContain("code: 'PLAN_REQUIRED'");
    expect(src).toMatch(/SBP_QR_KINDS = \[[^\]]*'program_license'/);
    // из программы признак ставит только сервер (api/app.js), а не клиент напрямую
    expect(readFileSync('api/app.js', 'utf8')).toContain("b.kind === 'codes' ? { productKind: 'program_license'");
  });
});

describe('раздел «Операции по дням»', () => {
  it('только в «Про», с названием для страницы тарифов', () => {
    expect(plans.PLANS.pro.features).toContain('ops');
    expect(plans.PLANS.standard.features).not.toContain('ops');
    expect(plans.publicPlans().features.ops).toBeTruthy();
  });
});
