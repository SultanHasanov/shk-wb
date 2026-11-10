import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  buyGenerationsWithWallet: (draft: Record<string, any>) => Promise<{ ok: boolean; charge?: Record<string, any> }>;
};

const USER = '11111111-1111-4111-8111-111111111111';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('мастер генерации: «Подтвердить» после снятия ограничения «Покупки»', () => {
  let reserves: Array<Record<string, any>>;

  beforeEach(() => {
    reserves = [];
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SECRET_KEY = 'secret';
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('прошлый резерв с тем же ключом возвращён (refunded) — новый резерв под новым ключом, а не мёртвый мастер', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const address = String(url);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (address.includes('rpc/reserve_sticker_generation')) {
        reserves.push(body);
        // Первый резерв — тот, что вернули при ограничении: повтор ключа отдаёт duplicate + refunded.
        if (reserves.length === 1) return json({ ok: true, duplicate: true, chargeId: 'old-charge', status: 'refunded', paymentSource: 'wallet', priceKopecks: 750, balanceKopecks: 5000 });
        return json({ ok: true, duplicate: false, chargeId: 'new-charge', status: 'reserved', paymentSource: 'wallet', priceKopecks: 750, balanceKopecks: 4250 });
      }
      return json([]);
    }));
    const draft: Record<string, any> = { userId: USER, mode: 'custom', category: 'product', billingRequestKey: 'telegram:1:50abc' };
    const bought = await bot.buyGenerationsWithWallet(draft);
    expect(bought.ok).toBe(true);
    expect(bought.charge).toMatchObject({ chargeId: 'new-charge', status: 'reserved', duplicate: false });
    expect(reserves).toHaveLength(2);
    expect(reserves[0].p_request_key).toBe('telegram:1:50abc');
    expect(reserves[1].p_request_key).toMatch(/^telegram:1:50abc:r[0-9a-f]{8}$/);
    // Ключ сохраняется в черновике: дальше списание и итог идут по новому резерву.
    expect(draft.billingRequestKey).toBe(reserves[1].p_request_key);
  });

  it('повтор уже оплаченного запроса (duplicate, не refunded) — тот же резерв, второго не делаем', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const address = String(url);
      if (address.includes('rpc/reserve_sticker_generation')) {
        reserves.push(init.body ? JSON.parse(String(init.body)) : {});
        return json({ ok: true, duplicate: true, chargeId: 'paid-charge', status: 'completed', paymentSource: 'wallet', priceKopecks: 750, balanceKopecks: 4250 });
      }
      return json([]);
    }));
    const draft: Record<string, any> = { userId: USER, mode: 'custom', category: 'product', billingRequestKey: 'telegram:1:50abc' };
    const bought = await bot.buyGenerationsWithWallet(draft);
    expect(bought.charge).toMatchObject({ chargeId: 'paid-charge', status: 'completed' });
    expect(reserves).toHaveLength(1);
    expect(draft.billingRequestKey).toBe('telegram:1:50abc');
  });
});
