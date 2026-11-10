import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

type Call = { method: string; path: string; body: any; headers: Record<string, string> };
type Reply = { __reply: true; status: number; data: unknown };
type Res = { statusCode: number; body: any; status: (c: number) => Res; json: (b: unknown) => Res; setHeader: () => void; end: () => Res };

const USER = '0e1a5a6c-1111-2222-3333-444455556666';
const KEY = '5b3c1f9e-aaaa-4bbb-8ccc-0123456789ab';

const reply = (status: number, data: unknown = {}): Reply => ({ __reply: true, status, data });

/** Подменяем fetch: и PostgREST, и GoTrue. Сами модули остаются настоящими. */
function backend(route: (call: Call) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const raw = String(url);
    const path = raw.includes('/rest/v1/') ? raw.split('/rest/v1/')[1] : raw.includes('/auth/v1/') ? `auth:${raw.split('/auth/v1/')[1]}` : raw;
    const call: Call = {
      method: String(init.method || 'GET').toUpperCase(),
      path: decodeURIComponent(path),
      body: init.body ? JSON.parse(String(init.body)) : null,
      headers: (init.headers || {}) as Record<string, string>,
    };
    calls.push(call);
    const out = route(call);
    const r = out && typeof out === 'object' && (out as Reply).__reply ? (out as Reply) : reply(200, out ?? []);
    return {
      ok: r.status < 400, status: r.status, headers: new Map(),
      text: async () => JSON.stringify(r.data), json: async () => r.data,
    } as unknown as Response;
  }));
  return calls;
}

function mockRes(): Res {
  const res = {
    statusCode: 200, body: undefined as any,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
    setHeader() {},
    end() { return res; },
  };
  return res;
}

function req(body: Record<string, unknown>) {
  return { method: 'POST', query: {}, body: { userId: USER, ...body }, headers: { 'user-agent': 'vitest', 'x-forwarded-for': '1.2.3.4' } };
}

/** Строка журнала: вставка pending → id 77, закрытие PATCH. */
function journal(call: Call) {
  if (call.method === 'POST' && call.path === 'admin_actions') return [{ id: 77 }];
  if (call.method === 'PATCH' && call.path.startsWith('admin_actions?id=eq.77')) return [];
  return undefined;
}

// Рассылку подменяем в кеше require (модуль зовёт её лениво), вызов бота — шпионом на настоящем модуле.
const deliver = vi.fn(async (_input: unknown) => [{ channel: 'cabinet', status: 'sent' }]);
const messagesPath = require.resolve('../../server/_admin-messages.js');
let savedMessages: unknown;
beforeAll(() => {
  savedMessages = require.cache[messagesPath];
  require.cache[messagesPath] = { id: messagesPath, filename: messagesPath, loaded: true, exports: { deliver } } as unknown as NodeJS.Module;
});
afterAll(() => {
  if (savedMessages) require.cache[messagesPath] = savedMessages as NodeJS.Module;
  else delete require.cache[messagesPath];
});
const botRpc = require('../../server/_bot-rpc.js') as { callBot: (...args: unknown[]) => Promise<unknown> };
let callBot: ReturnType<typeof vi.fn>;

const limits = require('../../server/_admin-limits.js') as {
  validateOverridesBody: (body: unknown) => { error?: string; patch?: Record<string, unknown>; sections?: string[] };
  validateWalletBody: (body: unknown) => { error?: string; kopecks?: number; comment?: string; notify?: boolean };
  overridesDto: (row: unknown) => any;
  setOverrides: (req: unknown, res: Res, ctx: { userId: string }) => Promise<unknown>;
  clearOverrides: (req: unknown, res: Res, ctx: { userId: string }) => Promise<unknown>;
  walletAdjust: (req: unknown, res: Res, ctx: { userId: string }) => Promise<unknown>;
};
const grants = require('../../server/_admin-grants.js') as {
  adminError: (status: number, code: string, message: string, extra?: Record<string, unknown>) => Error & { status: number; code: string };
  sendAdminError: (res: Res, error: unknown) => unknown;
  recordAdminAction: (req: unknown, action: string, userId: string | null, payload?: unknown, options?: Record<string, unknown>) => Promise<{ id: number } | null>;
  adminFingerprint: (req: unknown) => string;
};

const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  deliver.mockClear();
  callBot = vi.spyOn(botRpc, 'callBot').mockResolvedValue(undefined) as unknown as ReturnType<typeof vi.fn>;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('проверка тела ручных лимитов', () => {
  it('требует причину и хотя бы одну секцию', () => {
    expect(limits.validateOverridesBody({ codes: { mode: 'tariff' } }).error).toMatch(/причин/i);
    expect(limits.validateOverridesBody({ reason: 'просьба' }).error).toMatch(/Нечего менять/);
  });

  it('держит границы чисел и сроков', () => {
    expect(limits.validateOverridesBody({ reason: 'r', codes: { mode: 'add', monthly: 100001, until: null } }).error).toBeTruthy();
    expect(limits.validateOverridesBody({ reason: 'r', codes: { mode: 'add', monthly: 1.5, until: null } }).error).toBeTruthy();
    expect(limits.validateOverridesBody({ reason: 'r', slots: { devices: 21, points: 0, mirror: 0, until: null } }).error).toBeTruthy();
    expect(limits.validateOverridesBody({ reason: 'r', slots: { devices: 1, points: 0, mirror: 0, until: future(-1) } }).error).toMatch(/прошла/);
    expect(limits.validateOverridesBody({ reason: 'r', unlimited: { enabled: true, until: future(4 * 366) } }).error).toMatch(/трёх лет/);
    expect(limits.validateOverridesBody({ reason: 'r', codes: { mode: 'exact', monthly: 5 } }).error).toBeTruthy();
    expect(limits.validateOverridesBody({ reason: 'r', note: 'x'.repeat(301) }).error).toBeTruthy();
  });

  it('переводит секции в p_patch только для присланного', () => {
    const until = future(30);
    const ok = limits.validateOverridesBody({
      reason: 'договорились', codes: { mode: 'tariff' }, unlimited: { enabled: false, until },
    });
    expect(ok.error).toBeUndefined();
    expect(ok.sections).toEqual(['codes', 'unlimited']);
    expect(ok.patch).toEqual({ codes_mode: null, codes_monthly: 0, codes_until: null, unlimited: false, unlimited_until: null });

    const slots = limits.validateOverridesBody({ reason: 'r', slots: { devices: 2, points: 1, mirror: 0, until } });
    expect(slots.patch).toEqual({ devices_bonus: 2, points_bonus: 1, mirror_bonus: 0, slots_until: until });
    const set = limits.validateOverridesBody({ reason: 'r', codes: { mode: 'set', monthly: 300, until: null }, note: '  ' });
    expect(set.patch).toEqual({ codes_mode: 'set', codes_monthly: 300, codes_until: null, note: null });
  });

  it('отдаёт карточке формат AdminOverrides', () => {
    expect(limits.overridesDto(null)).toBeNull();
    const dto = limits.overridesDto({
      codes_mode: 'add', codes_monthly: 200, codes_until: null, devices_bonus: 0, points_bonus: 0, mirror_bonus: 0,
      slots_until: null, unlimited: true, unlimited_until: future(-1), note: 'n', updated_at: '2026-11-10T00:00:00Z', updated_by: 'abc',
    });
    expect(dto.codes).toEqual({ mode: 'add', monthly: 200, until: null, active: true });
    expect(dto.slots).toBeNull();
    expect(dto.unlimited).toMatchObject({ enabled: true, active: false });
  });
});

describe('действия лимитов', () => {
  it('не ходит в базу при ошибке проверки и без ключа повтора', async () => {
    const calls = backend(() => []);
    const res1 = mockRes();
    await limits.setOverrides(req({ reason: '', idempotencyKey: KEY, codes: { mode: 'tariff' } }), res1, { userId: USER });
    expect(res1.statusCode).toBe(400);
    expect(res1.body.code).toBe('VALIDATION_ERROR');
    const res2 = mockRes();
    await limits.setOverrides(req({ reason: 'r', codes: { mode: 'tariff' } }), res2, { userId: USER });
    expect(res2.statusCode).toBe(400);
    expect(res2.body.code).toBe('VALIDATION_ERROR');
    const res3 = mockRes();
    await limits.clearOverrides(req({ idempotencyKey: KEY }), res3, { userId: USER });
    expect(res3.statusCode).toBe(400);
    const res4 = mockRes();
    await limits.walletAdjust(req({ direction: 'credit', amountKopecks: 50000, comment: '', reason: 'r', idempotencyKey: KEY }), res4, { userId: USER });
    expect(res4.statusCode).toBe(400);
    const res5 = mockRes();
    await limits.walletAdjust(req({ direction: 'credit', amountKopecks: 0, comment: 'c', reason: 'r', idempotencyKey: KEY }), res5, { userId: USER });
    expect(res5.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('setOverrides со slots удаляет старую надбавку ПК и перечитывает права', async () => {
    const after = { user_id: USER, codes_mode: null, codes_monthly: 0, devices_bonus: 3, points_bonus: 1, mirror_bonus: 0, slots_until: null, unlimited: false, note: null, updated_at: 'now' };
    const calls = backend(call => journal(call)
      ?? (call.path === 'rpc/app_user_override' ? { before: null, after }
        : call.path === 'rpc/app_entitlements' ? { plan: 'basic', device_bonus: 3 }
          : []));
    const res = mockRes();
    await limits.setOverrides(req({ reason: 'компенсация', idempotencyKey: KEY, slots: { devices: 3, points: 1, mirror: 0, until: null } }), res, { userId: USER });
    expect(res.statusCode).toBe(200);
    expect(res.body.overrides.slots).toMatchObject({ devices: 3, points: 1 });
    expect(res.body.entitlements).toMatchObject({ device_bonus: 3 });
    const rpc = calls.find(c => c.path === 'rpc/app_user_override')!;
    expect(rpc.body).toMatchObject({ p_user: USER, p_patch: { devices_bonus: 3, points_bonus: 1, mirror_bonus: 0, slots_until: null } });
    expect(calls.some(c => c.method === 'DELETE' && c.path === `app_device_bonuses?user_id=eq.${USER}`)).toBe(true);
    const insert = calls.find(c => c.method === 'POST' && c.path === 'admin_actions')!;
    expect(insert.body).toMatchObject({ action: 'setOverrides', idempotency_key: `setOverrides:${KEY}`, result: 'pending', reason: 'компенсация', user_agent: 'vitest' });
    const finish = calls.find(c => c.method === 'PATCH' && c.path.startsWith('admin_actions?id=eq.77'))!;
    expect(finish.body).toMatchObject({ result: 'ok', before: null, after: { devices_bonus: 3 }, response: { __status: 200 } });
    // безлимит не трогали — узел бота не дёргаем
    expect(callBot).not.toHaveBeenCalled();
  });

  it('setOverrides без slots старую надбавку не трогает, безлимит сбрасывает снимок у бота', async () => {
    const calls = backend(call => journal(call)
      ?? (call.path === 'rpc/app_user_override' ? { before: null, after: { unlimited: true, unlimited_until: null } } : {}));
    const res = mockRes();
    await limits.setOverrides(req({ reason: 'r', idempotencyKey: KEY, unlimited: { enabled: true, until: null } }), res, { userId: USER });
    expect(res.statusCode).toBe(200);
    expect(calls.some(c => c.path.startsWith('app_device_bonuses'))).toBe(false);
    expect(callBot).toHaveBeenCalledWith('invalidateUserControls');
  });

  it('clearOverrides удаляет строку и надбавку ПК', async () => {
    const calls = backend(call => journal(call)
      ?? (call.path === 'rpc/app_user_override' ? { before: { devices_bonus: 2, unlimited: false }, after: null } : []));
    const res = mockRes();
    await limits.clearOverrides(req({ reason: 'вернуть как было', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ overrides: null });
    expect(calls.find(c => c.path === 'rpc/app_user_override')!.body.p_patch).toEqual({ clear: true });
    expect(calls.some(c => c.method === 'DELETE' && c.path === `app_device_bonuses?user_id=eq.${USER}`)).toBe(true);
  });

  it('walletAdjust: 409 INSUFFICIENT_BALANCE при ok:false', async () => {
    backend(call => journal(call)
      ?? (call.path.startsWith('wallet_accounts') ? [{ balance_kopecks: 10000 }]
        : call.path === 'rpc/admin_wallet_adjust' ? { ok: false, duplicate: false, balance: 10000 } : []));
    const res = mockRes();
    await limits.walletAdjust(req({ direction: 'debit', amountKopecks: 50000, comment: 'возврат', reason: 'ошибка', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'INSUFFICIENT_BALANCE', balanceKopecks: 10000 });
  });

  it('walletAdjust: списание со знаком, ключ события и уведомление с уникальным ключом доставки', async () => {
    const calls = backend(call => journal(call)
      ?? (call.path.startsWith('wallet_accounts') ? [{ balance_kopecks: 132000 }]
        : call.path === 'rpc/admin_wallet_adjust' ? { ok: true, duplicate: false, balance: 82000 } : []));
    const res = mockRes();
    await limits.walletAdjust(req({ direction: 'debit', amountKopecks: 50000, comment: 'возврат', reason: 'ошибка', notify: true, idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ beforeKopecks: 132000, balanceKopecks: 82000, duplicate: false });
    expect(calls.find(c => c.path === 'rpc/admin_wallet_adjust')!.body).toEqual({ p_user: USER, p_kopecks: -50000, p_note: 'возврат', p_event_key: KEY });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({ userId: USER, actionId: 77, dedupeBase: 'wallet:77', source: 'admin' });
    expect(String((deliver.mock.calls[0][0] as any).body)).toMatch(/С баланса списано 500 ₽: «возврат». Сейчас на балансе 820 ₽\./);
    const finish = calls.find(c => c.method === 'PATCH' && c.path.startsWith('admin_actions?id=eq.77'))!;
    expect(finish.body).toMatchObject({ before: { balanceKopecks: 132000 }, after: { balanceKopecks: 82000 } });
  });

  it('повтор с тем же ключом отдаёт сохранённый ответ без второго RPC', async () => {
    const stored = { beforeKopecks: 0, balanceKopecks: 50000, duplicate: false, __status: 200 };
    const calls = backend(call => {
      if (call.method === 'POST' && call.path === 'admin_actions') return reply(409, { code: '23505' });
      if (call.path.startsWith('admin_actions?idempotency_key=eq.')) return [{ id: 77, result: 'ok', response: stored, created_at: new Date().toISOString() }];
      return [];
    });
    const res = mockRes();
    await limits.walletAdjust(req({ direction: 'credit', amountKopecks: 50000, comment: 'бонус', reason: 'акция', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ beforeKopecks: 0, balanceKopecks: 50000, duplicate: false, replayed: true });
    expect(calls.some(c => c.path === 'rpc/admin_wallet_adjust')).toBe(false);
    expect(calls.find(c => c.path.startsWith('admin_actions?idempotency_key'))!.path).toContain(`walletAdjust:${KEY}`);
  });

  it('свежий pending с тем же ключом — 409 IN_PROGRESS', async () => {
    const calls = backend(call => {
      if (call.method === 'POST' && call.path === 'admin_actions') return reply(409, {});
      if (call.path.startsWith('admin_actions?idempotency_key=eq.')) return [{ id: 77, result: 'pending', response: null, created_at: new Date(Date.now() - 5000).toISOString() }];
      return [];
    });
    const res = mockRes();
    await limits.walletAdjust(req({ direction: 'credit', amountKopecks: 100, comment: 'c', reason: 'r', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Запрос уже выполняется', code: 'IN_PROGRESS' });
    expect(calls.some(c => c.path === 'rpc/admin_wallet_adjust')).toBe(false);
  });

  it('после ошибки тот же ключ перехватывает строку и выполняет работу заново', async () => {
    const calls = backend(call => {
      if (call.method === 'POST' && call.path === 'admin_actions') return reply(409, {});
      if (call.path.startsWith('admin_actions?idempotency_key=eq.')) return [{ id: 77, result: 'error', response: { error: 'x' }, created_at: new Date().toISOString() }];
      if (call.method === 'PATCH' && call.path.startsWith('admin_actions?id=eq.77&result=eq.error')) return [{ id: 77 }];
      if (call.path.startsWith('wallet_accounts')) return [];
      if (call.path === 'rpc/admin_wallet_adjust') return { ok: true, duplicate: false, balance: 100 };
      return [];
    });
    const res = mockRes();
    await limits.walletAdjust(req({ direction: 'credit', amountKopecks: 100, comment: 'c', reason: 'r', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(200);
    expect(calls.filter(c => c.path === 'rpc/admin_wallet_adjust')).toHaveLength(1);
  });
});

describe('общие помощники журнала', () => {
  it('adminError и sendAdminError отдают код и extra, ошибки базы — 502 без подробностей', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = mockRes();
    grants.sendAdminError(res, grants.adminError(409, 'ALREADY_RESTRICTED', 'уже', { restrictionId: 'r1' }));
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'уже', code: 'ALREADY_RESTRICTED', restrictionId: 'r1' });
    const db = mockRes();
    grants.sendAdminError(db, Object.assign(new Error('Supabase request failed (409)'), { status: 409 }));
    expect(db.statusCode).toBe(502);
    expect(db.body).toEqual({ error: 'Database request failed' });
  });

  it('recordAdminAction пишет user_agent, причину и было/стало; без запроса — отпечаток system', async () => {
    const calls = backend(call => (call.method === 'POST' ? [{ id: 5 }] : []));
    expect(grants.adminFingerprint(null)).toBe('system');
    const row = await grants.recordAdminAction(
      { headers: { 'user-agent': 'UA', 'x-forwarded-for': '1.1.1.1' } }, 'profile', USER, { a: 1 },
      { reason: ' r '.repeat(1) + 'x'.repeat(600), before: { a: 0 }, after: { a: 1 }, returnRow: true },
    );
    expect(row).toEqual({ id: 5 });
    expect(calls[0].headers.Prefer).toBe('return=representation');
    expect(calls[0].body).toMatchObject({ action: 'profile', user_agent: 'UA', before: { a: 0 }, after: { a: 1 } });
    expect(calls[0].body.reason).toHaveLength(500);
    await grants.recordAdminAction(null, 'liftRestriction', USER);
    expect(calls[1].body).toMatchObject({ admin_fingerprint: 'system', user_agent: null, payload: {} });
    expect(calls[1].body).not.toHaveProperty('reason');
  });

  it('recordAdminAction не бросает при сбое базы', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    backend(() => reply(500, {}));
    await expect(grants.recordAdminAction(null, 'x', null, {})).resolves.toBeNull();
  });
});
