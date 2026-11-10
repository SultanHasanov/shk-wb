import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

type Call = { method: string; path: string; body: any; headers: Record<string, string> };
type Reply = { __reply: true; status: number; data: unknown };
type Res = { statusCode: number; body: any; status: (c: number) => Res; json: (b: unknown) => Res; setHeader: () => void; end: () => Res };

const USER = '0e1a5a6c-1111-2222-3333-444455556666';
const RID = '9d2b7c11-2222-4333-8444-555566667777';
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

/** Общие ответы: журнал (id 77), пользователь в GoTrue, бан. */
function common(call: Call) {
  if (call.method === 'POST' && call.path === 'admin_actions') return [{ id: 77 }];
  if (call.method === 'PATCH' && call.path.startsWith('admin_actions?id=eq.77')) return [];
  if (call.path === `auth:admin/users/${USER}` && call.method === 'GET') return { id: USER, email: 'user@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
  if (call.path === `auth:admin/users/${USER}` && call.method === 'PUT') return {};
  return undefined;
}

const deliver = vi.fn(async (_input: unknown) => [{ channel: 'telegram', status: 'sent' }]);
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

const restrictions = require('../../server/_admin-restrictions.js') as {
  SCOPE_TABLES: Record<string, string[]>;
  validateRestrictBody: (body: unknown, opts?: { partial?: boolean }) => { error?: string; scopes?: string[]; until?: string | null };
  restrictionDto: (row: unknown) => any;
  restrict: (req: unknown, res: Res, ctx: { userId: string }) => Promise<unknown>;
  updateRestriction: (req: unknown, res: Res, ctx: { userId: string }) => Promise<unknown>;
  liftRestrictionAction: (req: unknown, res: Res, ctx: { userId: string }) => Promise<unknown>;
  blockCompat: (req: unknown, res: Res, ctx: { userId: string }) => Promise<unknown>;
  unblockCompat: (req: unknown, res: Res, ctx: { userId: string }) => Promise<unknown>;
  liftRestriction: (row: unknown, reason: string, opts?: Record<string, unknown>) => Promise<{ restored: Record<string, number>; restriction: any }>;
};

const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

function activeRow(extra: Record<string, unknown> = {}) {
  return {
    id: RID, user_id: USER, scopes: ['app'], reason: 'спам', public_message: null, until: future(7),
    disabled_items: { sticker_access_codes: [1, 2], license_keys: [5] }, created_at: '2026-11-01T00:00:00Z',
    created_by: 'abc', updated_at: '2026-11-01T00:00:00Z', lifted_at: null, lifted_by: null, lifted_reason: null,
    ...extra,
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  delete process.env.APP_UNLIMITED_USER_IDS;
  deliver.mockClear();
  vi.spyOn(botRpc, 'callBot').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('проверка тела ограничения', () => {
  it('«Полностью» только одно, области из белого списка, без повторов', () => {
    expect(restrictions.validateRestrictBody({ reason: 'r', scopes: ['all', 'app'], until: null }).error).toMatch(/Полностью/);
    expect(restrictions.validateRestrictBody({ reason: 'r', scopes: ['app', 'app'], until: null }).error).toBeTruthy();
    expect(restrictions.validateRestrictBody({ reason: 'r', scopes: ['casino'], until: null }).error).toBeTruthy();
    expect(restrictions.validateRestrictBody({ reason: 'r', scopes: [], until: null }).error).toBeTruthy();
    expect(restrictions.validateRestrictBody({ reason: '', scopes: ['app'], until: null }).error).toMatch(/причин/i);
  });

  it('срок — не раньше чем через 5 минут и не дальше 5 лет', () => {
    expect(restrictions.validateRestrictBody({ reason: 'r', scopes: ['app'], until: new Date(Date.now() + 60_000).toISOString() }).error).toBeTruthy();
    expect(restrictions.validateRestrictBody({ reason: 'r', scopes: ['app'], until: future(6 * 366) }).error).toBeTruthy();
    expect(restrictions.validateRestrictBody({ reason: 'r', scopes: ['app'], until: future(1) })).toMatchObject({ scopes: ['app'] });
    expect(restrictions.validateRestrictBody({ reason: 'r', scopes: ['all'], until: null })).toMatchObject({ until: null });
  });

  it('частичное изменение: нечего менять — ошибка, отсутствующее — undefined', () => {
    expect(restrictions.validateRestrictBody({ reason: 'r' }, { partial: true }).error).toMatch(/Нечего менять/);
    const ok = restrictions.validateRestrictBody({ reason: 'r', publicMessage: 'Пишите в поддержку' }, { partial: true });
    expect(ok.error).toBeUndefined();
    expect(ok.scopes).toBeUndefined();
    expect(ok.until).toBeUndefined();
  });

  it('dto: full, expired и выключенные id', () => {
    const dto = restrictions.restrictionDto(activeRow({ scopes: ['all'], until: future(-1), disabled_items: { legacy: true } }));
    expect(dto).toMatchObject({ id: RID, userId: USER, full: true, expired: true, disabledItems: { stickerCodes: [], programKeys: [], cellLicenses: [], legacy: true } });
    expect(dto.message).toMatch(/^Доступ ограничен администратором\. До \d\d\.\d\d$/);
  });

  it('таблицы по областям совпадают с контрактом', () => {
    expect(restrictions.SCOPE_TABLES.all).toEqual(['sticker_access_codes', 'license_keys', 'cell_print_licenses']);
    // коды стикеров при «Помощнике ПВЗ» не выключаем: пакет работает на открытом сайте и в боте, без него
    // reserve_sticker_generation молча списала бы генерацию с кошелька
    expect(restrictions.SCOPE_TABLES.app).toEqual(['license_keys']);
    expect(restrictions.SCOPE_TABLES.cell_print).toEqual(['cell_print_licenses']);
    for (const scope of ['site', 'bot', 'purchases', 'withdrawals']) expect(restrictions.SCOPE_TABLES[scope]).toEqual([]);
  });
});

describe('restrict', () => {
  it('не ходит в базу при ошибке проверки', async () => {
    const calls = backend(() => []);
    const res = mockRes();
    await restrictions.restrict(req({ scopes: ['all', 'site'], until: null, reason: 'r', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const noKey = mockRes();
    await restrictions.restrict(req({ scopes: ['app'], until: null, reason: 'r' }), noKey, { userId: USER });
    expect(noKey.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('сначала строка ограничения, потом выключает только включённые и запоминает их id', async () => {
    const calls = backend(call => common(call)
      ?? (call.method === 'GET' && call.path.startsWith('user_restrictions?') ? []
        : call.method === 'GET' && call.path.startsWith('user_overrides?') ? []
          : call.method === 'POST' && call.path === 'user_restrictions' ? [activeRow({ disabled_items: {} })]
            : call.method === 'PATCH' && call.path.startsWith('sticker_access_codes?') ? [{ id: 1 }, { id: 2 }]
              : call.method === 'PATCH' && call.path.startsWith('license_keys?') ? [{ id: 5 }]
                : call.method === 'PATCH' && call.path.startsWith(`user_restrictions?id=eq.${RID}`) ? [activeRow({ disabled_items: { license_keys: [5] } })]
                  : []));
    const res = mockRes();
    await restrictions.restrict(req({ scopes: ['app'], until: future(7), reason: 'спам', notify: true, idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(201);
    expect(res.body.restriction).toMatchObject({ id: RID, scopes: ['app'], disabledItems: { stickerCodes: [], programKeys: [5], cellLicenses: [] } });
    expect(res.body).not.toHaveProperty('warning');

    const insertAt = calls.findIndex(c => c.method === 'POST' && c.path === 'user_restrictions');
    const firstCodesPatch = calls.findIndex(c => c.method === 'PATCH' && /^(sticker_access_codes|license_keys|cell_print_licenses)\?/.test(c.path));
    expect(insertAt).toBeGreaterThan(-1);
    expect(firstCodesPatch).toBeGreaterThan(insertAt);
    expect(calls[insertAt].body).toMatchObject({ user_id: USER, scopes: ['app'], reason: 'спам', disabled_items: {} });

    const codes = calls.filter(c => c.method === 'PATCH' && /^(sticker_access_codes|license_keys|cell_print_licenses)\?/.test(c.path));
    // только ключи WBPK: пакеты стикеров нужны открытому сайту и боту
    expect(codes.map(c => c.path)).toEqual([
      `license_keys?owner_user_id=eq.${USER}&active=eq.true&select=id`,
    ]);
    expect(codes.every(c => c.body.active === false && c.headers.Prefer === 'return=representation')).toBe(true);
    const saved = calls.find(c => c.method === 'PATCH' && c.path.startsWith(`user_restrictions?id=eq.${RID}`))!;
    expect(saved.body.disabled_items).toEqual({ license_keys: [5] });
    // не «Полностью» — бан в GoTrue не ставим
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
    // ограничение app не закрывает кабинет — пишем туда и в Telegram
    expect(deliver.mock.calls[0][0]).toMatchObject({ channels: ['cabinet', 'telegram'], subject: 'Доступ ограничен', dedupeBase: `restrict:${RID}` });
    expect(botRpc.callBot).toHaveBeenCalledWith('invalidateUserControls');
  });

  it('«Полностью» ставит бан в GoTrue; сбой бана — 201 с authBan:failed и partial в журнале', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = backend(call => (call.method === 'PUT' ? reply(500, {}) : common(call))
      ?? (call.method === 'GET' ? []
        : call.method === 'POST' && call.path === 'user_restrictions' ? [activeRow({ scopes: ['all'], until: null, disabled_items: {} })]
          : call.method === 'PATCH' && call.path.startsWith('cell_print_licenses?') ? [{ id: 9 }]
            : call.method === 'PATCH' && call.path.startsWith('user_restrictions?') ? [activeRow({ scopes: ['all'], until: null, disabled_items: { cell_print_licenses: [9] } })]
              : []));
    const res = mockRes();
    await restrictions.restrict(req({ scopes: ['all'], until: null, reason: 'мошенник', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(201);
    expect(res.body.authBan).toBe('failed');
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ ban_duration: '876000h' });
    const finish = calls.find(c => c.method === 'PATCH' && c.path.startsWith('admin_actions?id=eq.77'))!;
    expect(finish.body.result).toBe('partial');
  });

  it('PROTECTED_ACCOUNT без force, с force — проходит', async () => {
    process.env.APP_UNLIMITED_USER_IDS = USER;
    const route = (call: Call) => common(call)
      ?? (call.method === 'GET' ? []
        : call.method === 'POST' && call.path === 'user_restrictions' ? [activeRow({ scopes: ['bot'], disabled_items: {} })]
          : []);
    let calls = backend(route);
    const res = mockRes();
    await restrictions.restrict(req({ scopes: ['bot'], until: null, reason: 'r', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('PROTECTED_ACCOUNT');
    expect(calls.some(c => c.path === 'user_restrictions' && c.method === 'POST')).toBe(false);

    calls = backend(route);
    const forced = mockRes();
    await restrictions.restrict(req({ scopes: ['bot'], until: null, reason: 'r', force: true, idempotencyKey: KEY }), forced, { userId: USER });
    expect(forced.statusCode).toBe(201);
    // у области bot нет таблиц — коды не трогаем
    expect(calls.some(c => c.method === 'PATCH' && /^(sticker_access_codes|license_keys|cell_print_licenses)\?/.test(c.path))).toBe(false);
  });

  it('безлимит из user_overrides тоже защищает', async () => {
    backend(call => common(call)
      ?? (call.method === 'GET' && call.path.startsWith('user_overrides?') ? [{ unlimited: true, unlimited_until: null }] : []));
    const res = mockRes();
    await restrictions.restrict(req({ scopes: ['site'], until: null, reason: 'r', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.body.code).toBe('PROTECTED_ACCOUNT');
  });

  it('уже есть действующее — 409 ALREADY_RESTRICTED с id', async () => {
    backend(call => common(call) ?? (call.method === 'GET' && call.path.startsWith('user_restrictions?') ? [activeRow()] : []));
    const res = mockRes();
    await restrictions.restrict(req({ scopes: ['app'], until: null, reason: 'r', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'ALREADY_RESTRICTED', restrictionId: RID });
  });

  it('гонка на уникальном индексе — тоже ALREADY_RESTRICTED, коды не выключаются', async () => {
    const calls = backend(call => common(call)
      ?? (call.method === 'POST' && call.path === 'user_restrictions' ? reply(409, { code: '23505' }) : []));
    const res = mockRes();
    await restrictions.restrict(req({ scopes: ['app'], until: null, reason: 'r', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.body.code).toBe('ALREADY_RESTRICTED');
    expect(calls.some(c => c.method === 'PATCH' && c.path.startsWith('sticker_access_codes'))).toBe(false);
  });
});

describe('снятие ограничения', () => {
  it('возвращает только запомненные id, которые всё ещё выключены', async () => {
    const calls = backend(call => common(call)
      ?? (call.method === 'PATCH' && call.path.startsWith('sticker_access_codes?id=in.') ? [{ id: 1 }]
        : call.method === 'PATCH' && call.path.startsWith('license_keys?id=in.') ? [{ id: 5 }]
          : call.method === 'PATCH' && call.path.startsWith('user_restrictions?') ? [activeRow({ lifted_at: 'now' })]
            : []));
    const out = await restrictions.liftRestriction(activeRow(), 'разобрались', { req: req({}) });
    expect(out.restored).toEqual({ stickerCodes: 1, programKeys: 1, cellLicenses: 0 });
    const patches = calls.filter(c => c.method === 'PATCH' && /^(sticker_access_codes|license_keys|cell_print_licenses)\?/.test(c.path));
    expect(patches.map(c => c.path)).toEqual([
      'sticker_access_codes?id=in.(1,2)&active=is.false&select=id',
      'license_keys?id=in.(5)&active=is.false&select=id',
    ]);
    expect(patches.every(c => c.body.active === true)).toBe(true);
    const lifted = calls.find(c => c.method === 'PATCH' && c.path.startsWith('user_restrictions?'))!;
    expect(lifted.path).toBe(`user_restrictions?id=eq.${RID}&lifted_at=is.null`);
    expect(lifted.body).toMatchObject({ lifted_reason: 'разобрались' });
    expect(lifted.body.lifted_by).toHaveLength(24);
    // не «Полностью» — разбан не нужен; by:'admin' — своей строки журнала нет
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
    expect(calls.some(c => c.method === 'POST' && c.path === 'admin_actions')).toBe(false);
  });

  it('старая блокировка (legacy): включает всё выключенное владельца и снимает бан', async () => {
    const calls = backend(call => common(call)
      ?? (call.method === 'PATCH' && call.path.startsWith('user_restrictions?') ? [activeRow({ lifted_at: 'now' })] : []));
    await restrictions.liftRestriction(activeRow({ scopes: ['all'], disabled_items: { legacy: true } }), 'r', { req: req({}) });
    const legacy = calls.filter(c => c.method === 'PATCH' && c.path.includes('owner_user_id=eq.'));
    expect(legacy.map(c => c.path.split('?')[0])).toEqual(['sticker_access_codes', 'license_keys', 'cell_print_licenses']);
    expect(legacy.every(c => c.path.includes('active=is.false'))).toBe(true);
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ ban_duration: 'none' });
  });

  it('таймер (by:auto) пишет свою строку журнала от имени system', async () => {
    const calls = backend(call => common(call)
      ?? (call.method === 'PATCH' && call.path.startsWith('user_restrictions?') ? [activeRow({ lifted_at: 'now' })] : []));
    await restrictions.liftRestriction(activeRow(), 'Срок ограничения истёк', { by: 'auto' });
    const lifted = calls.find(c => c.method === 'PATCH' && c.path.startsWith('user_restrictions?'))!;
    expect(lifted.body.lifted_by).toBe('auto');
    const log = calls.filter(c => c.method === 'POST' && c.path === 'admin_actions');
    expect(log).toHaveLength(1);
    expect(log[0].body).toMatchObject({ action: 'liftRestriction', admin_fingerprint: 'system', payload: { restrictionId: RID, auto: true } });
  });

  it('liftRestrictionAction даёт ровно одну строку журнала', async () => {
    const calls = backend(call => common(call)
      ?? (call.method === 'GET' && call.path.startsWith('user_restrictions?') ? [activeRow()]
        : call.method === 'PATCH' && call.path.startsWith('user_restrictions?') ? [activeRow({ lifted_at: 'now' })]
          : []));
    const res = mockRes();
    await restrictions.liftRestrictionAction(req({ restrictionId: RID, reason: 'ошибка', notify: true, idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('restored');
    expect(res.body.restriction.id).toBe(RID);
    expect(calls.filter(c => c.method === 'POST' && c.path === 'admin_actions')).toHaveLength(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({ subject: 'Доступ восстановлен', dedupeBase: `lift:${RID}` });
  });

  it('нет действующего — 409 NOT_RESTRICTED', async () => {
    backend(call => common(call) ?? []);
    const res = mockRes();
    await restrictions.liftRestrictionAction(req({ restrictionId: RID, reason: 'r', notify: false, idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('NOT_RESTRICTED');
  });
});

describe('updateRestriction', () => {
  it('дельта областей: новые выключает, убранные возвращает по своим id', async () => {
    const calls = backend(call => common(call)
      ?? (call.method === 'GET' && call.path.startsWith('user_restrictions?') ? [activeRow()]
        : call.method === 'PATCH' && call.path.startsWith('cell_print_licenses?') ? [{ id: 9 }]
          : call.method === 'PATCH' && call.path.startsWith('user_restrictions?') ? [activeRow({ scopes: ['cell_print', 'purchases'], disabled_items: { cell_print_licenses: [9] } })]
            : []));
    const res = mockRes();
    await restrictions.updateRestriction(req({ restrictionId: RID, reason: 'смягчили', scopes: ['cell_print', 'purchases'], idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(200);
    const patches = calls.filter(c => c.method === 'PATCH' && /^(sticker_access_codes|license_keys|cell_print_licenses)\?/.test(c.path)).map(c => c.path);
    expect(patches).toEqual([
      `cell_print_licenses?owner_user_id=eq.${USER}&active=eq.true&select=id`,
      'sticker_access_codes?id=in.(1,2)&active=is.false&select=id',
      'license_keys?id=in.(5)&active=is.false&select=id',
    ]);
    const saved = calls.find(c => c.method === 'PATCH' && c.path.startsWith('user_restrictions?'))!;
    expect(saved.body).toMatchObject({ scopes: ['cell_print', 'purchases'], disabled_items: { cell_print_licenses: [9] } });
    expect(saved.path).toContain('lifted_at=is.null');
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('добавили «Полностью» — бан на новый срок; снятое — NOT_RESTRICTED; чужое — 404', async () => {
    const until = future(3);
    let calls = backend(call => common(call)
      ?? (call.method === 'GET' && call.path.startsWith('user_restrictions?') ? [activeRow({ disabled_items: {} })]
        : call.method === 'PATCH' && call.path.startsWith('user_restrictions?') ? [activeRow({ scopes: ['all'], until })]
          : []));
    const res = mockRes();
    await restrictions.updateRestriction(req({ restrictionId: RID, reason: 'r', scopes: ['all'], until, idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(200);
    expect(calls.find(c => c.method === 'PUT')!.body.ban_duration).toMatch(/^\d+h$/);

    backend(call => common(call) ?? (call.method === 'GET' && call.path.startsWith('user_restrictions?') ? [activeRow({ lifted_at: 'x' })] : []));
    const lifted = mockRes();
    await restrictions.updateRestriction(req({ restrictionId: RID, reason: 'r', until: null, idempotencyKey: KEY }), lifted, { userId: USER });
    expect(lifted.body.code).toBe('NOT_RESTRICTED');

    calls = backend(call => common(call) ?? []);
    const missing = mockRes();
    await restrictions.updateRestriction(req({ restrictionId: RID, reason: 'r', until: null, idempotencyKey: KEY }), missing, { userId: USER });
    expect(missing.statusCode).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });
});

describe('сбой посередине (наложение и снятие)', () => {
  const isCodes = (c: Call) => c.method === 'PATCH' && /^(sticker_access_codes|license_keys|cell_print_licenses)\?/.test(c.path);

  it('restrict: одна таблица не выключилась — остальные и бан доводятся, таблица в pending_tables, 201 с предупреждением', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = backend(call => common(call)
      ?? (call.method === 'GET' ? []
        : call.method === 'POST' && call.path === 'user_restrictions' ? [activeRow({ scopes: ['all'], until: null, disabled_items: {} })]
          : call.method === 'PATCH' && call.path.startsWith('sticker_access_codes?') ? [{ id: 1 }]
            : call.method === 'PATCH' && call.path.startsWith('license_keys?') ? reply(500, { message: 'boom' })
              : call.method === 'PATCH' && call.path.startsWith('cell_print_licenses?') ? [{ id: 9 }]
                : call.method === 'PATCH' && call.path.startsWith(`user_restrictions?id=eq.${RID}`)
                  ? [activeRow({ scopes: ['all'], until: null, disabled_items: call.body.disabled_items })]
                  : []));
    const res = mockRes();
    await restrictions.restrict(req({ scopes: ['all'], until: null, reason: 'мошенник', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(201);
    expect(res.body.pendingTables).toEqual(['programKeys']);
    expect(res.body.warning).toContain('ключи Помощника ПВЗ');
    expect(res.body.warning).toContain('Сохраните ограничение ещё раз');
    expect(calls.filter(isCodes).map(c => c.path.split('?')[0])).toEqual(['sticker_access_codes', 'license_keys', 'cell_print_licenses']);
    const saved = calls.find(c => c.method === 'PATCH' && c.path.startsWith(`user_restrictions?id=eq.${RID}`))!;
    expect(saved.body.disabled_items).toEqual({ sticker_access_codes: [1], cell_print_licenses: [9], pending_tables: ['license_keys'] });
    // бан ставится, хотя таблица не выключилась
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ ban_duration: '876000h' });
    const finish = calls.find(c => c.method === 'PATCH' && c.path.startsWith('admin_actions?id=eq.77'))!;
    expect(finish.body.result).toBe('partial');
    expect(botRpc.callBot).toHaveBeenCalledWith('invalidateUserControls');
  });

  it('restrict: список выключенного не записался — выключенное включается обратно, предупреждение «наложите заново»', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = backend(call => common(call)
      ?? (call.method === 'GET' ? []
        : call.method === 'POST' && call.path === 'user_restrictions' ? [activeRow({ scopes: ['cell_print'], disabled_items: {} })]
          : call.method === 'PATCH' && call.path.startsWith('cell_print_licenses?owner_user_id=') ? [{ id: 9 }]
            : call.method === 'PATCH' && call.path.startsWith('cell_print_licenses?id=in.') ? [{ id: 9 }]
              : call.method === 'PATCH' && call.path.startsWith(`user_restrictions?id=eq.${RID}`) ? reply(500, {})
                : []));
    const res = mockRes();
    await restrictions.restrict(req({ scopes: ['cell_print'], until: null, reason: 'r', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(201);
    // запись пробовали дважды, потом вернули лицензию 9
    expect(calls.filter(c => c.method === 'PATCH' && c.path.startsWith(`user_restrictions?id=eq.${RID}`))).toHaveLength(2);
    expect(calls.filter(isCodes).map(c => c.path)).toEqual([
      `cell_print_licenses?owner_user_id=eq.${USER}&active=eq.true&select=id`,
      'cell_print_licenses?id=in.(9)&active=is.false&select=id',
    ]);
    expect(res.body.pendingTables).toEqual(['cellLicenses']);
    expect(res.body.warning).toContain('Снимите ограничение и наложите заново');
  });

  it('updateRestriction повторяет pending_tables и заново ставит бан у «Полностью»', async () => {
    const until = future(3);
    const calls = backend(call => common(call)
      ?? (call.method === 'GET' && call.path.startsWith('user_restrictions?')
        ? [activeRow({ scopes: ['all'], until, disabled_items: { sticker_access_codes: [1], pending_tables: ['license_keys'] } })]
        : call.method === 'PATCH' && call.path.startsWith('license_keys?') ? [{ id: 5 }]
          : call.method === 'PATCH' && call.path.startsWith('user_restrictions?')
            ? [activeRow({ scopes: ['all'], until, public_message: 'текст', disabled_items: call.body.disabled_items })]
            : []));
    const res = mockRes();
    await restrictions.updateRestriction(req({ restrictionId: RID, reason: 'повтор', publicMessage: 'текст', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty('warning');
    // выключается только недоделанная таблица, остальные не трогаем
    expect(calls.filter(isCodes).map(c => c.path)).toEqual([`license_keys?owner_user_id=eq.${USER}&active=eq.true&select=id`]);
    const saved = calls.find(c => c.method === 'PATCH' && c.path.startsWith('user_restrictions?'))!;
    expect(saved.body.disabled_items).toEqual({ sticker_access_codes: [1], license_keys: [5] });
    expect(calls.find(c => c.method === 'PUT')!.body.ban_duration).toMatch(/^\d+h$/);
  });

  it('снятие: GoTrue не ответил — коды не включены, запись не снята', async () => {
    const calls = backend(call => (call.method === 'PUT' ? reply(500, {}) : common(call)) ?? []);
    await expect(restrictions.liftRestriction(activeRow({ scopes: ['all'] }), 'r', { req: req({}) })).rejects.toThrow();
    expect(calls.some(isCodes)).toBe(false);
    expect(calls.some(c => c.method === 'PATCH' && c.path.startsWith('user_restrictions?'))).toBe(false);
  });

  it('снятие: бан снят и запись отмечена раньше, чем включаются коды', async () => {
    const calls = backend(call => common(call)
      ?? (call.method === 'PATCH' && call.path.startsWith('user_restrictions?') ? [activeRow({ scopes: ['all'], lifted_at: 'now' })]
        : call.method === 'PATCH' && call.path.startsWith('sticker_access_codes?id=in.') ? [{ id: 1 }, { id: 2 }]
          : []));
    await restrictions.liftRestriction(activeRow({ scopes: ['all'] }), 'r', { req: req({}) });
    const unban = calls.findIndex(c => c.method === 'PUT');
    const mark = calls.findIndex(c => c.method === 'PATCH' && c.path.startsWith('user_restrictions?'));
    const firstCodes = calls.findIndex(isCodes);
    expect(calls[unban].body).toEqual({ ban_duration: 'none' });
    expect(unban).toBeLessThan(mark);
    expect(mark).toBeLessThan(firstCodes);
  });

  it('снятие: запись уже снял другой запрос — коды второй раз не включаем, окно получает NOT_RESTRICTED', async () => {
    let calls = backend(call => common(call) ?? []);
    const out = await restrictions.liftRestriction(activeRow(), 'r', { req: req({}) });
    expect(out.restored).toEqual({ stickerCodes: 0, programKeys: 0, cellLicenses: 0 });
    expect(calls.some(isCodes)).toBe(false);

    calls = backend(call => common(call) ?? (call.method === 'GET' && call.path.startsWith('user_restrictions?') ? [activeRow()] : []));
    const res = mockRes();
    await restrictions.liftRestrictionAction(req({ restrictionId: RID, reason: 'r', notify: true, idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('NOT_RESTRICTED');
    expect(calls.some(isCodes)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('совместимость старых кнопок', () => {
  it('block без ключа повтора — ограничение «Полностью» и {banned:true}', async () => {
    const calls = backend(call => common(call)
      ?? (call.method === 'POST' && call.path === 'user_restrictions' ? [activeRow({ scopes: ['all'], until: null, disabled_items: {} })] : []));
    const res = mockRes();
    await restrictions.blockCompat(req({}), res, { userId: USER });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ banned: true });
    const log = calls.find(c => c.method === 'POST' && c.path === 'admin_actions')!;
    expect(log.body.action).toBe('block');
    expect(log.body.idempotency_key).toMatch(/^block:compat-[0-9a-f-]{36}$/);
    expect(calls.find(c => c.method === 'POST' && c.path === 'user_restrictions')!.body).toMatchObject({ scopes: ['all'], until: null, reason: 'Блокировка из старой кнопки' });
  });

  it('unblock без записи — только снимает бан', async () => {
    const calls = backend(call => common(call) ?? []);
    const res = mockRes();
    await restrictions.unblockCompat(req({}), res, { userId: USER });
    expect(res.body).toEqual({ banned: false });
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ ban_duration: 'none' });
  });
});
