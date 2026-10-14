import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { costRub, suggestedKzt } from '../lib/partner';

const require = createRequire(import.meta.url);
const root = resolve(__dirname, '../..');
const partners = require('../../server/_partners.js') as {
  issue: (partnerId: string, body: Record<string, unknown>) => Promise<{ error?: string; item?: { value: string }; entry?: unknown }>;
  topup: (partnerId: string, body: Record<string, unknown>) => Promise<{ error?: string }>;
  toggle: (partnerId: string, body: Record<string, unknown>) => Promise<{ error?: string; status?: number; ok?: boolean }>;
  sendPartnerError: (res: unknown, error: unknown) => boolean;
};

type Call = { path: string; body: Record<string, unknown> | null; method: string };
let calls: Call[];

/** Ответы PostgREST подменяем на уровне fetch, как в admin-users.test.ts. */
function stubSupabase(responder: (path: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).split('/rest/v1/')[1] ?? String(url);
    calls.push({ path, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    const data = responder(path, init);
    return { ok: true, status: 200, text: async () => JSON.stringify(data ?? []), headers: new Map() } as unknown as Response;
  }));
}

beforeEach(() => {
  calls = [];
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PARTNER = '11111111-2222-3333-4444-555555555555';

describe('выпуск кодов партнёром', () => {
  it('выпускает код через RPC с курсом и своей ценой в тенге', async () => {
    stubSupabase(path => {
      if (path.startsWith('site_settings')) return [{ value: 5.2 }];
      if (path.startsWith('rpc/partner_issue_sticker_code')) return { id: 7, code: '123456', name: 'Айдар', generation_limit: 100, generation_used: 0, active: true, created_at: '2026-10-15T00:00:00Z' };
      if (path.startsWith('partner_ledger')) return [{ id: 1, resource: 'sticker', delta: -100, kind: 'issue', cost_rub: '27', kzt_per_rub: '5.2', price_kzt: '200', created_at: '2026-10-15T00:00:00Z' }];
      return [];
    });
    const result = await partners.issue(PARTNER, { kind: 'sticker', amount: 100, note: 'Айдар', priceKzt: 200 });
    expect(result.item?.value).toBe('123456');
    expect(result.entry).toMatchObject({ costRub: 27, priceKzt: 200 });
    const rpc = calls.find(c => c.path.startsWith('rpc/partner_issue_sticker_code'));
    expect(rpc?.body).toMatchObject({ p_partner: PARTNER, p_limit: 100, p_rate: 5.2, p_price_kzt: 200 });
  });

  it('без своей цены отдаёт null — сервер посчитает по наценке', async () => {
    stubSupabase(path => (path.startsWith('rpc/') ? { id: 1, key: 'WBPK-AAAA-BBBB-CCCC', usage_limit: 5, used: 0 } : []));
    await partners.issue(PARTNER, { kind: 'program', amount: 5, note: '' });
    expect(calls.find(c => c.path.startsWith('rpc/partner_issue_program_key'))?.body).toMatchObject({ p_price_kzt: null });
  });

  it('проверяет размер и параметры до обращения к базе', async () => {
    stubSupabase(() => []);
    expect((await partners.issue(PARTNER, { kind: 'sticker', amount: 0 })).error).toBeTruthy();
    expect((await partners.issue(PARTNER, { kind: 'cell', durationDays: 31, deviceLimit: 1 })).error).toBeTruthy();
    expect((await partners.issue(PARTNER, { kind: 'sticker', amount: 10, priceKzt: -5 })).error).toBeTruthy();
    expect(calls.some(c => c.path.startsWith('rpc/'))).toBe(false);
  });

  it('ключ печати ячеек не пополняется — только выпуск нового', async () => {
    stubSupabase(() => []);
    expect((await partners.topup(PARTNER, { kind: 'cell', id: 1, amount: 10 })).error).toBeTruthy();
  });

  it('чужой код выключить нельзя: фильтр по partner_id', async () => {
    stubSupabase(() => []);
    const result = await partners.toggle(PARTNER, { kind: 'sticker', id: 5, active: false });
    expect(result).toMatchObject({ status: 404 });
    expect(calls[0].path).toContain(`partner_id=eq.${PARTNER}`);
  });

  it('нехватку пула отдаёт как 409 с кодом', () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const handled = partners.sendPartnerError(res, { details: { message: 'PARTNER_POOL_EXHAUSTED' } });
    expect(handled).toBe(true);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PARTNER_POOL_EXHAUSTED' }));
    expect(partners.sendPartnerError(res, new Error('other'))).toBe(false);
  });
});

describe('деньги партнёра', () => {
  it('считает долг в рублях и цену клиенту по наценке', () => {
    expect(costRub(500, 0.27)).toBe(135);
    // 135 ₽ × 5.5 ₸ × 1.2 = 891 ₸
    expect(suggestedKzt(135, 5.5, 20)).toBe(891);
  });

  it('миграция считает цену клиенту той же формулой', () => {
    const sql = readFileSync(resolve(root, 'supabase/migrations/20261015_partners.sql'), 'utf8');
    expect(sql).toContain('round(p_cost * p_rate * (1 + p.markup_percent / 100))');
    expect(sql).toContain("raise exception 'PARTNER_POOL_EXHAUSTED'");
  });
});
