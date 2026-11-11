import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const root = resolve(__dirname, '../..');
const grants = require('../../server/_admin-grants.js') as {
  checkCellLicensePatch: (id: number, body: Record<string, unknown>) => Promise<{ error?: string; status?: number; extra?: Record<string, unknown> }>;
  checkStickerAccessPatch: (id: number, body: Record<string, unknown>) => Promise<{ error?: string; status?: number }>;
  addStickerGenerations: (codeId: number, add: unknown) => Promise<{ error?: string; row?: unknown }>;
  createProgramKey: (input: Record<string, unknown>) => Promise<{ error?: string; row?: unknown }>;
  createCellLicense: (input: Record<string, unknown>) => Promise<{ error?: string; row?: { key: string } }>;
  isUuid: (value: unknown) => boolean;
};

/** Ответы PostgREST подменяем на уровне fetch: сам модуль остаётся настоящим. */
function stubSupabase(responder: (path: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).split('/rest/v1/')[1] ?? String(url);
    const data = responder(path, init);
    return { ok: true, status: 200, text: async () => JSON.stringify(data ?? []), headers: new Map() } as unknown as Response;
  }));
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('выдача активов из админки', () => {
  it('не даёт опустить лимит генераций ниже израсходованного', async () => {
    stubSupabase(() => [{ generation_used: 40 }]);
    expect(await grants.checkStickerAccessPatch(1, { limit: 30 })).toMatchObject({ error: expect.stringContaining('меньше') });
    expect(await grants.checkStickerAccessPatch(1, { limit: 50 })).toEqual({});
  });

  it('держит потолок суммарного срока ключа печати ячеек', async () => {
    stubSupabase(() => [{ duration_days: 3900, expires_at: null }]);
    expect(await grants.checkCellLicensePatch(1, { extendDays: 200 })).toMatchObject({ error: expect.stringContaining('4000') });
    expect(await grants.checkCellLicensePatch(1, { extendDays: 50 })).toMatchObject({ extra: { duration_days: 3950 } });
  });

  // Просроченный ключ продлевается от сегодняшнего дня, иначе продление уходит
  // в прошлое и человек остаётся без доступа сразу после оплаты.
  it('продлевает просроченный ключ от текущей даты', async () => {
    const past = new Date(Date.now() - 30 * 86400000).toISOString();
    stubSupabase(() => [{ duration_days: 30, expires_at: past }]);
    const result = await grants.checkCellLicensePatch(1, { extendDays: 10 });
    const expiresAt = Date.parse(String(result.extra?.expires_at));
    expect(expiresAt).toBeGreaterThan(Date.now() + 9 * 86400000);
  });

  it('не опускает лимит устройств ниже числа активаций', async () => {
    stubSupabase(path => (path.startsWith('cell_print_activations')
      ? [{ id: 1 }, { id: 2 }, { id: 3 }]
      : [{ duration_days: 30, expires_at: null }]));
    expect(await grants.checkCellLicensePatch(1, { deviceLimit: 2 })).toMatchObject({ error: expect.stringContaining('активирован') });
    expect(await grants.checkCellLicensePatch(1, { deviceLimit: 5 })).toMatchObject({ extra: {} });
  });

  it('выдаёт ключ печати ячеек в формате CP-XXXX-XXXX-XXXX', async () => {
    stubSupabase(() => [{ key: 'CP-AAAA-BBBB-CCCC', duration_days: 30, device_limit: 1 }]);
    const created = await grants.createCellLicense({ durationDays: 30, deviceLimit: 1 });
    expect(created.error).toBeUndefined();
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    expect(body.key).toMatch(/^CP-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(body.source).toBe('admin');
  });

  it('отклоняет недопустимые срок и число устройств', async () => {
    stubSupabase(() => []);
    expect(await grants.createCellLicense({ durationDays: 45, deviceLimit: 1 })).toMatchObject({ error: expect.any(String) });
    expect(await grants.createCellLicense({ durationDays: 30, deviceLimit: 4 })).toMatchObject({ error: expect.any(String) });
  });

  it('проверяет размер пополнения до обращения к базе', async () => {
    const spy = vi.fn();
    stubSupabase(spy);
    expect(await grants.addStickerGenerations(1, 0)).toMatchObject({ error: expect.any(String) });
    expect(await grants.addStickerGenerations(1, 999999)).toMatchObject({ error: expect.any(String) });
    expect(spy).not.toHaveBeenCalled();
  });

  it('проверяет формат ключа программы', async () => {
    stubSupabase(() => [{ key: 'WBPK-TEST', usage_limit: 10 }]);
    expect(await grants.createProgramKey({ key: 'no', limit: 10 })).toMatchObject({ error: expect.any(String) });
    expect(await grants.createProgramKey({ key: 'WBPK-TEST', limit: 0 })).toMatchObject({ error: expect.any(String) });
    expect(await grants.createProgramKey({ key: 'WBPK-TEST', limit: 10 })).toMatchObject({ row: expect.any(Object) });
  });

  it('узнаёт корректный идентификатор пользователя', () => {
    expect(grants.isUuid('0e1a5a6c-1111-2222-3333-444455556666')).toBe(true);
    expect(grants.isUuid('../../etc/passwd')).toBe(false);
    expect(grants.isUuid('')).toBe(false);
  });
});

describe('защита админского раздела пользователей', () => {
  const router = readFileSync(resolve(root, 'api/admin/data.js'), 'utf8');
  const users = readFileSync(resolve(root, 'server/_admin-users.js'), 'utf8');
  const migration = readFileSync(resolve(root, 'supabase/migrations/20260909_admin_user_directory.sql'), 'utf8');

  it('пускает в раздел пользователей только после requireAdmin', () => {
    const guard = router.indexOf('requireAdmin(req, res)');
    const branch = router.indexOf("resource === 'users'");
    expect(guard).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(guard);
  });

  // Функции читают auth.users. Без снятия прав они открывают почты всех
  // пользователей любому, у кого есть публичный ключ проекта.
  it('снимает права на функции директории со всех, кроме service_role', () => {
    for (const fn of ['admin_user_directory', 'admin_user_summary', 'admin_grant_generations']) {
      expect(migration).toMatch(new RegExp(`revoke all on function public\\.${fn}[^;]*from public, anon, authenticated`));
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${fn}[^;]*to service_role`));
    }
  });

  it('не собирает SQL сортировки строками', () => {
    expect(migration).toContain('security definer');
    expect(migration).toContain('set search_path=public,auth');
    expect(migration).not.toMatch(/execute\s+format\([^)]*p_sort/i);
    expect(migration).not.toMatch(/\|\|\s*p_sort/);
  });

  it('требует подтверждения почтой при удалении аккаунта', () => {
    expect(users).toContain("action === 'account'");
    expect(users).toMatch(/confirm !== String\(authUser\.email/);
  });

  it('зажимает размер страницы и не пробрасывает произвольную сортировку', () => {
    expect(users).toMatch(/Math\.min\(100,/);
    expect(users).toContain('SORTS.includes');
    expect(users).toContain('FILTERS.includes');
  });

  // Старые ветки заменены делегатами: второй реализации блокировки и уведомления в модуле нет.
  it('не держит старые ветки notify/block/unblock и бан GoTrue', () => {
    expect(users).not.toMatch(/action === 'notify'/);
    expect(users).not.toMatch(/action === 'block'/);
    expect(users).not.toContain('ban_duration');
  });
});

const USER = '0e1a5a6c-1111-2222-3333-444455556666';

type Res = { statusCode: number; body: any; status: (c: number) => Res; json: (b: unknown) => Res; setHeader: () => void; end: () => Res };
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

type Handler = ((req: unknown, res: Res) => Promise<unknown>) & {
  FILTERS: string[]; SORTS: string[]; DELEGATED: Record<string, () => unknown>;
};
const handler = require('../../server/_admin-users.js') as Handler;

/** fetch для PostgREST и GoTrue: ответ по пути. */
function stubBackend(responder: (path: string, init?: RequestInit) => unknown) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const raw = String(url);
    const path = raw.includes('/rest/v1/') ? raw.split('/rest/v1/')[1] : `auth:${raw.split('/auth/v1/')[1]}`;
    const data = responder(decodeURIComponent(path), init);
    return { ok: true, status: 200, text: async () => JSON.stringify(data ?? []), json: async () => data, headers: new Map() } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('раздел пользователей: новые фильтры, делегаты и карточка', () => {
  it('белые списки фильтров и сортировок расширены', () => {
    expect(handler.FILTERS).toEqual(['all', 'paying', 'free', 'telegram', 'banned', 'inactive', 'subscribed', 'expiring', 'unlimited', 'restricted']);
    expect(handler.SORTS).toEqual(['created_at', 'last_sign_in_at', 'revenue', 'generation_used', 'balance', 'expiring']);
  });

  it('новые действия идут через таблицу DELEGATED', () => {
    expect(Object.keys(handler.DELEGATED).sort()).toEqual([
      'GET linkTelegramPreview', 'GET messageTargets', 'POST block', 'POST clearOverrides', 'POST liftRestriction',
      'POST linkTelegram', 'POST message', 'POST notify',
      'POST restrict', 'POST setOverrides', 'POST unblock', 'POST updateRestriction', 'POST walletAdjust',
    ]);
    expect(typeof handler.DELEGATED['POST linkTelegram']()).toBe('function');
    expect(typeof handler.DELEGATED['GET linkTelegramPreview']()).toBe('function');
    expect(typeof handler.DELEGATED['POST restrict']()).toBe('function');
    expect(typeof handler.DELEGATED['POST setOverrides']()).toBe('function');
  });

  it('делегат без корректного userId — 400 до базы', async () => {
    const fetchMock = stubBackend(() => []);
    const res = mockRes();
    await handler({ method: 'POST', query: { action: 'restrict' }, body: { userId: '../x' }, headers: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('неизвестный раздел карточки — 400', async () => {
    const fetchMock = stubBackend(() => []);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'detailSection', userId: USER, section: 'secrets' }, body: {}, headers: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('счётчики фильтров кешируются на 60 секунд', async () => {
    const fetchMock = stubBackend(() => ({ all: 10, paying: 2, restricted: 1 }));
    const first = mockRes();
    await handler({ method: 'GET', query: { action: 'counts' }, body: {}, headers: {} }, first);
    const second = mockRes();
    await handler({ method: 'GET', query: { action: 'counts' }, body: {}, headers: {} }, second);
    expect(first.body).toMatchObject({ all: 10, paying: 2, restricted: 1, subscribed: 0, new30: 0 });
    expect(second.body).toEqual(first.body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('список отдаёт тариф, баланс, ПК/пункты и безлимит (∞ = null)', async () => {
    process.env.APP_UNLIMITED_USER_IDS = '';
    stubBackend(path => (path === 'rpc/admin_user_directory' ? [
      {
        user_id: USER, email: 'a@b.ru', wallet_kopecks: 82000, app_plan: 'basic', app_ends_at: '2099-01-01T00:00:00Z',
        app_paid_until: '2099-02-01T00:00:00Z', app_device_limit: 1, app_addons: {}, device_bonus: 2, points_bonus: 1, mirror_bonus: 0,
        devices_count: 2, points_count: 1, last_seen_at: '2026-11-10T10:00:00Z', restricted: true, restriction_scopes: ['app'],
        restriction_until: null, unlimited: false, unlimited_until: null, total_count: 1,
      },
      { user_id: '1e1a5a6c-1111-2222-3333-444455556666', unlimited: true, unlimited_until: null, restricted: false, total_count: 1 },
    ] : []));
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'list', sort: 'balance', filter: 'restricted' }, body: {}, headers: {} }, res);
    expect(res.body).toMatchObject({ sort: 'balance', filter: 'restricted', total: 1 });
    const [row, unl] = res.body.items;
    expect(row).toMatchObject({
      userId: USER, email: 'a@b.ru', walletKopecks: 82000, app: { plan: 'basic', paidUntil: '2099-02-01T00:00:00Z' },
      devices: { used: 2 }, points: { used: 1 }, restricted: true, restriction: { scopes: ['app'], until: null }, unlimited: false,
    });
    expect(row.devices.limit).toBeGreaterThanOrEqual(3);
    expect(row.points.limit).toBeGreaterThanOrEqual(2);
    expect(unl).toMatchObject({ unlimited: true, devices: { limit: null }, points: { limit: null }, restriction: null });
  });

  it('карточка: ограничение, ручные лимиты, кошелёк, способы входа, ПК в сети', async () => {
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    stubBackend(path => {
      if (path.startsWith('auth:admin/users/')) return { id: USER, email: 'a@b.ru', email_confirmed_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' };
      if (path === 'rpc/app_entitlements') return { plan: 'basic', addons: {}, device_limit: 1, device_bonus: 2, points_bonus: 0, mirror_bonus: 1, codes_limit: 250, codes_base: 50, codes_used: 3 };
      if (path.startsWith('user_overrides?')) return [{ codes_mode: 'add', codes_monthly: 200, devices_bonus: 2, mirror_bonus: 1, unlimited: false, updated_at: 'now' }];
      if (path.startsWith('user_restrictions?')) return [{ id: 'r1', user_id: USER, scopes: ['purchases'], reason: 'x', until: null, disabled_items: {} }];
      if (path.startsWith('wallet_accounts?')) return [{ balance_kopecks: 5000, updated_at: 'w' }];
      if (path.startsWith('user_oauth_identities?')) return [{ provider: 'yandex', email: 'y@ya.ru', display_name: 'Y', created_at: 'c' }];
      if (path.startsWith('app_device_bonuses?')) return [{ devices: 1 }];
      if (path.startsWith('partners?')) return [{ id: 'p1', name: 'Партнёр', active: true }];
      if (path.startsWith('user_telegram_identities?')) return [{ telegram_user_id: 42, username: 'nick', created_at: 't' }];
      if (path.startsWith('telegram_bot_subscribers?')) return [{ blocked_at: null, activated_at: 'a' }];
      if (path.startsWith('app_devices?')) return [{ id: 'd1', name: 'ПК', role: 'owner', point_wb: '123', last_seen_at: 'l' }];
      if (path.startsWith('referral_accounts?')) return [];
      return [];
    });
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'detail', userId: USER }, body: {}, headers: {} }, res);
    const d = res.body;
    expect(d.restriction).toMatchObject({ id: 'r1', scopes: ['purchases'], full: false });
    expect(d.overrides.codes).toMatchObject({ mode: 'add', monthly: 200 });
    expect(d.legacyDeviceBonus).toBe(1);
    expect(d.wallet).toEqual({ balanceKopecks: 5000, updatedAt: 'w' });
    expect(d.partner).toEqual({ id: 'p1', name: 'Партнёр', active: true });
    expect(d.unlimited).toEqual({ active: false, source: null, until: null });
    expect(d.protected).toBe(false);
    expect(d.loginMethods).toMatchObject({
      email: { address: 'a@b.ru', confirmed: true, technical: false },
      telegram: { username: 'nick', telegramUserId: 42, bot: { started: true, blockedAt: null } },
      oauth: [{ provider: 'yandex', email: 'y@ya.ru' }],
    });
    expect(d.app.devices[0]).toMatchObject({ role: 'owner', online: false, pointWb: '123' });
    expect(d.app.limits).toMatchObject({ codesLimit: 250, codesUsed: 3, base: { codes: 50 } });
    expect(d.app.limits.devices).toBe(d.app.limits.base.devices + 2);
  });
});

describe('logoutAll: завершить все сеансы', () => {
  const body = { userId: USER, reason: 'утечка пароля' };
  beforeEach(() => { process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test'; });

  it('неподтверждённая почта — 409 LOGOUT_UNAVAILABLE без magiclink (его проверка подтвердила бы почту)', async () => {
    const fetchMock = stubBackend(path => (path.startsWith(`auth:admin/users/${USER}`) ? { id: USER, email: 'victim@x.ru', email_confirmed_at: null } : []));
    const res = mockRes();
    await handler({ method: 'POST', query: { action: 'logoutAll' }, body, headers: {} }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'LOGOUT_UNAVAILABLE' });
    const urls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(urls.some(url => url.includes('generate_link') || url.includes('/verify') || url.includes('logout'))).toBe(false);
    expect(urls.some(url => url.includes('admin_actions'))).toBe(false);
  });

  it('подтверждённая почта — сеанс от имени пользователя, logout?scope=global, журнал с пометкой', async () => {
    const fetchMock = stubBackend(path => {
      if (path.startsWith(`auth:admin/users/${USER}`)) return { id: USER, email: 'u@x.ru', email_confirmed_at: '2026-01-01T00:00:00Z' };
      if (path.startsWith('auth:admin/generate_link')) return { properties: { hashed_token: 'hash' } };
      if (path.startsWith('auth:verify')) return { access_token: 'user-token' };
      return [];
    });
    const res = mockRes();
    await handler({ method: 'POST', query: { action: 'logoutAll' }, body, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, devicesRevoked: 0 });
    const logout = fetchMock.mock.calls.find(call => String(call[0]).includes('logout?scope=global'))!;
    expect((logout[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer user-token' });
    const journal = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/rest/v1/admin_actions'))!;
    expect(JSON.parse(String((journal[1] as RequestInit).body))).toMatchObject({ action: 'logoutAll', payload: { via: 'session_on_behalf' }, reason: 'утечка пароля' });
  });
});
