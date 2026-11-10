// Где действует ограничение аккаунта из админки (раздел 4 контракта): всегда 403 ACCOUNT_RESTRICTED
// или пустые права, никогда 401 / DEVICE_REVOKED. Плюс ручные лимиты в тарифных функциях.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const root = resolve(__dirname, '../..');

type Res = { statusCode: number; body: any; headers: Record<string, string> } & Record<string, any>;
const controls = require('../../server/_user-controls.js') as { __setSnapshotForTests: (json: unknown) => void; invalidate: () => void };
const auth = require('../../server/_user-auth.js') as { requireUser: (req: unknown, res: unknown, options?: Record<string, unknown>) => Promise<any> };
const account = require('../../server/_app-account.js') as Record<string, any>;
const plans = require('../../server/_app-plans.js') as {
  accountLimits: (plan: string | null, addons: object, subDeviceLimit: number, unlimited: boolean, deviceBonus?: number, pointsBonus?: number) => { devices: number; points: number };
  mirrorLimit: (plan: string | null, addons: object, unlimited: boolean, mirrorBonus?: number) => number;
  effectiveFeatures: (plan: string | null, addons: object, free: boolean, codesLimit?: number, manualCodes?: number) => string[];
};
const wallet = require('../../server/_wallet.js') as { payWithWallet: (input: Record<string, unknown>) => Promise<unknown> };
const billing = require('../../server/_generation-billing.js') as { reserveGeneration: (input: Record<string, unknown>) => Promise<any> };
const handler = require('../../api/app.js') as (req: unknown, res: unknown) => Promise<unknown>;

const U1 = '11111111-1111-4111-8111-111111111111';
const DEV_ID = '99999999-9999-4999-8999-999999999999';
const DEVICE = 'a'.repeat(64);
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const UNTIL = '2099-01-01T00:00:00.000Z';

function response(): Res {
  const res = { statusCode: 200, body: undefined, headers: {} } as Res;
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.end = () => res;
  res.send = () => res;
  res.setHeader = (name: string, value: string) => { res.headers[name] = value; };
  return res;
}

function request(action: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string | undefined>; body?: unknown } = {}) {
  const h: Record<string, string> = { 'x-app-version': '1.12.0', 'x-device-id': DEVICE, authorization: 'Bearer t' };
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete h[k];
    else h[k] = v;
  }
  return { method, query: { action }, body, headers: h, socket: { remoteAddress: '127.0.0.1' } };
}

function restrict(scopes: string[], extra: Record<string, unknown> = {}) {
  controls.__setSnapshotForTests({
    unlimited: [],
    restrictions: [{ id: 'r1', user_id: U1, telegram_user_id: 777001, scopes, until: UNTIL, public_message: null, ...extra }],
  });
}

type Route = (url: string, init: RequestInit) => { status?: number; body: unknown } | undefined;
function mockFetch(route: Route = () => undefined) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.includes('consume_api_rate_limit')) return new Response('true', { status: 200 });
    const hit = route(url, init)
      || (url.endsWith('/auth/v1/user') ? { body: { id: U1, email: 'owner@example.test' } } : undefined)
      || (url.includes('app_devices?user_id=') ? { body: [{ id: DEV_ID, name: 'Касса', last_seen_at: new Date().toISOString(), denied: [], point_wb: '1', role: 'owner' }] } : undefined)
      || (url.includes('rpc/app_entitlements') ? { body: { plan: 'pro', device_limit: 4, packs_left: 0, addons: {} } } : undefined)
      || (url.includes('site_settings') ? { body: [] } : undefined)
      || { status: 404, body: { message: 'unexpected ' + url } };
    return new Response(JSON.stringify(hit.body), { status: hit.status || 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  controls.__setSnapshotForTests(null);
});
afterEach(() => {
  controls.__setSnapshotForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('requireUser со scope', () => {
  it('ограничение области → 403 ACCOUNT_RESTRICTED с текстом и сроком, не 401', async () => {
    restrict(['site']);
    mockFetch();
    const res = response();
    expect(await auth.requireUser(request('x'), res, { scope: 'site' })).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Доступ ограничен администратором. До 01.01', code: 'ACCOUNT_RESTRICTED', until: UNTIL });
  });

  it('другая область и вызов без scope — как раньше', async () => {
    restrict(['site']);
    mockFetch();
    const res = response();
    expect((await auth.requireUser(request('x'), res, { scope: 'app' }))?.id).toBe(U1);
    expect((await auth.requireUser(request('x'), res))?.id).toBe(U1);
    expect(res.statusCode).toBe(200);
  });

  it('«Полностью» покрывает любую область; без входа по-прежнему 401', async () => {
    restrict(['all'], { public_message: 'Свяжитесь с поддержкой' });
    mockFetch(url => (url.endsWith('/auth/v1/user') ? { status: 401, body: {} } : undefined));
    const anon = response();
    expect(await auth.requireUser(request('x'), anon, { scope: 'cell_print' })).toBeNull();
    expect(anon.statusCode).toBe(401);

    mockFetch();
    const res = response();
    expect(await auth.requireUser(request('x'), res, { scope: 'cell_print' })).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Свяжитесь с поддержкой');
  });
});

describe('программа при ограничении «Программа»', () => {
  it('аренда: пустые права и причина, ПК не отзывается и тариф не читается', async () => {
    restrict(['app']);
    const fetchMock = mockFetch();
    const rights = await account.leaseRights(request('lease', { method: 'POST' }));
    expect(rights).toMatchObject({ user: U1, plan: null, features: [], archive_until: null, free: false, denied: [], via: 'session' });
    expect(rights.restricted).toEqual({ message: 'Доступ ограничен администратором. До 01.01', until: UNTIL });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('rpc/app_entitlements'))).toBe(false);
  });

  it('аренда без ограничения отдаёт тариф', async () => {
    restrict(['site']);
    mockFetch();
    const rights = await account.leaseRights(request('lease', { method: 'POST' }));
    expect(rights.features).toContain('cells');
    expect(rights.restricted).toBeUndefined();
  });

  it('billClientCode / billCode / chargeClientCode → 403 ACCOUNT_RESTRICTED, без списания', async () => {
    restrict(['app']);
    const fetchMock = mockFetch();
    const req = request('client-qr', { method: 'POST' });
    await expect(account.billClientCode(req, { requestId: REQUEST_ID, sid: '123', qrText: 'q' })).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_RESTRICTED', extra: { until: UNTIL } });
    await expect(account.billCode(req, { meta: {} })).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_RESTRICTED' });
    await expect(account.chargeClientCode(U1, null, { requestId: REQUEST_ID, sid: '123', qrText: 'q' })).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_RESTRICTED' });
    expect(fetchMock.mock.calls.some(([url]) => /rpc\/app_(consume|code_once)/.test(String(url)))).toBe(false);
  });

  it('HTTP: обычный запрос с ПК → 403, а фоновые и «me» — по исключениям', async () => {
    restrict(['app']);
    mockFetch(url => (url.includes('app_points?') ? { body: [] } : undefined));
    const res = response();
    await handler(request('points'), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_RESTRICTED');

    const site = response();
    await handler(request('points', { headers: { 'x-device-id': undefined } }), site);
    expect(site.statusCode).not.toBe(403); // область «Сайт» не ограничена
  });

  it('по исходникам api/app.js: исключения и scope у общего requireUser', () => {
    const source = readFileSync(resolve(root, 'api/app.js'), 'utf8');
    expect(source).toMatch(/const APP_RESTRICT_EXEMPT = new Set\(\['me', 'relay-inbox', 'relay-put', 'messages-ack', 'device-settings', 'device-key', 'logout'\]\)/);
    expect(source).toMatch(/scope: req\.headers\['x-device-id'\] \? \(APP_RESTRICT_EXEMPT\.has\(action\) \? undefined : 'app'\) : 'site'/);
  });

  describe('login-approve: область из запроса входа (Помощник — app, ПВЗ Принт — cell_print)', () => {
    const CODE = 'ABCDEFGH';
    function loginRoutes(appVersion: string) {
      return mockFetch((url, init) => {
        if (url.includes('app_login_requests?code=eq.')) {
          if ((init.method || 'GET') === 'PATCH') return { body: [] };
          return { body: [{ code: CODE, status: 'pending', device_name: 'Касса', app_version: appVersion, expires_at: '2099-01-01T00:00:00Z' }] };
        }
      });
    }
    const approveReq = () => request('login-approve', { method: 'POST', headers: { 'x-app-version': undefined, 'x-device-id': undefined }, body: { code: CODE } });
    const patched = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.some(([url, init]) => String(url).includes('app_login_requests') && (init as RequestInit)?.method === 'PATCH');

    it('ограничение «Программа» не мешает войти в ПВЗ Принт', async () => {
      restrict(['app']);
      const fetchMock = loginRoutes('cell-print/2.2.0');
      const res = response();
      await handler(approveReq(), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ deviceName: 'Касса' });
      expect(patched(fetchMock)).toBe(true);
    });

    it('ограничение «Программа» закрывает вход в Помощник — 403 без подтверждения', async () => {
      restrict(['app']);
      const fetchMock = loginRoutes('1.12.0');
      const res = response();
      await handler(approveReq(), res);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Доступ ограничен администратором. До 01.01', code: 'ACCOUNT_RESTRICTED', until: UNTIL });
      expect(patched(fetchMock)).toBe(false);
    });

    it('ограничение «ПВЗ Принт» закрывает вход в ПВЗ Принт, но не в Помощник', async () => {
      restrict(['cell_print']);
      let fetchMock = loginRoutes('cell-print/2.2.0');
      const blocked = response();
      await handler(approveReq(), blocked);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.body.code).toBe('ACCOUNT_RESTRICTED');
      expect(patched(fetchMock)).toBe(false);

      fetchMock = loginRoutes('1.12.0');
      const ok = response();
      await handler(approveReq(), ok);
      expect(ok.statusCode).toBe(200);
      expect(patched(fetchMock)).toBe(true);
    });
  });

  it('passwordLogin: GoTrue user_banned → 403 ACCOUNT_RESTRICTED, неверный пароль — по-прежнему 401', async () => {
    mockFetch(url => (url.includes('token?grant_type=password') ? { status: 400, body: { error_code: 'user_banned', msg: 'User is banned' } } : undefined));
    await expect(account.passwordLogin('a@b.c', 'x')).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_RESTRICTED', message: 'Доступ к аккаунту ограничен администратором' });
    mockFetch(url => (url.includes('token?grant_type=password') ? { status: 400, body: { error_code: 'invalid_credentials' } } : undefined));
    await expect(account.passwordLogin('a@b.c', 'x')).rejects.toMatchObject({ status: 401, code: 'BAD_CREDENTIALS' });
  });

  it('accountSummary: при «Программа» разделы пусты, тариф не показан, поле restricted', async () => {
    restrict(['app']);
    mockFetch(url => {
      if (url.includes('rpc/app_entitlements')) return { body: { plan: 'pro', device_limit: 4, packs_left: 0, addons: { archive: { ends_at: '2099-01-01T00:00:00Z' } }, codes_limit: 10, codes_used: 0 } };
      if (/license_keys|sticker_access_codes|app_points|user_profiles|user_telegram_identities|app_devices/.test(url)) return { body: [] };
    });
    const summary = await account.accountSummary({ id: U1, email: 'owner@example.test' }, null);
    expect(summary.features).toEqual([]);
    expect(summary.effectivePlan).toBeNull();
    expect(summary.plan).toBeUndefined();
    expect(summary.addons.every((a: { active: boolean }) => a.active === false)).toBe(true);
    expect(summary.restricted).toEqual({ scopes: ['app'], message: 'Доступ ограничен администратором. До 01.01', until: UNTIL });
  });
});

describe('покупки при ограничении «Покупки»', () => {
  it('payWithWallet бросает до вставки заказа', async () => {
    restrict(['purchases']);
    const fetchMock = mockFetch();
    await expect(wallet.payWithWallet({ userId: U1, productKind: 'app_subscription', priceRub: 239 })).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_RESTRICTED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('генерация с баланса: резерв возвращается и 403; пакетом и повтор готового — можно', async () => {
    restrict(['purchases']);
    let reserve: Record<string, unknown> = { ok: true, chargeId: 'c1', paymentSource: 'wallet' };
    const fetchMock = mockFetch(url => {
      if (url.includes('rpc/app_sticker_quota_code')) return { body: null };
      if (url.includes('rpc/reserve_sticker_generation')) return { body: reserve };
      if (url.includes('rpc/refund_sticker_generation')) return { body: { ok: true } };
    });
    const input = { userId: U1, requestKey: 'k1', mode: 'custom', category: 'product' };
    await expect(billing.reserveGeneration(input)).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_RESTRICTED', extra: { until: UNTIL } });
    const refunds = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('rpc/refund_sticker_generation'));
    expect(refunds()).toHaveLength(1);
    expect(JSON.parse(String((refunds()[0][1] as RequestInit).body))).toEqual({ p_charge: 'c1' });

    reserve = { ok: true, chargeId: 'c2', paymentSource: 'package' };
    await expect(billing.reserveGeneration(input)).resolves.toMatchObject({ chargeId: 'c2' });
    reserve = { ok: true, chargeId: 'c3', paymentSource: 'wallet', duplicate: true, status: 'completed', result: {} };
    await expect(billing.reserveGeneration(input)).resolves.toMatchObject({ chargeId: 'c3' });
    expect(refunds()).toHaveLength(1);
  });

  it('api/payments.js и api/cell-print.js проверяют «Покупки», cell-print — область cell_print', () => {
    const payments = readFileSync(resolve(root, 'api/payments.js'), 'utf8');
    expect(payments).toMatch(/if \(user\) await controls\.assertAllowed\(user\.id, 'purchases'\)/);
    expect(payments).toMatch(/error\.code === 'ACCOUNT_RESTRICTED'\) return res\.status\(403\)/);
    const cell = readFileSync(resolve(root, 'api/cell-print.js'), 'utf8');
    expect(cell).toMatch(/controls\.assertAllowed\(user\.id,'purchases'\)/);
    expect(cell.match(/scope:[^}]*'cell_print'/g)?.length).toBe(2);
    expect(cell).toMatch(/\.\.\.\(error\.extra\|\|\{\}\)/);
  });
});

describe('бот при ограничении «Бот»', () => {
  const env = { TELEGRAM_BOT_TOKEN: '1:' + 'a'.repeat(30), TELEGRAM_API_BASE: 'https://relay.test' };
  beforeEach(() => { Object.assign(process.env, env); });
  afterEach(() => { for (const key of Object.keys(env)) delete process.env[key]; });

  function telegramCalls(fetchMock: ReturnType<typeof vi.fn>, method: string) {
    return fetchMock.mock.calls.filter(([url]) => String(url).includes('relay.test') && String(url).endsWith(`/${method}`))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  }

  it('кнопка — всплывающее окно с причиной; сообщения — ответ не чаще раза в час', async () => {
    restrict(['bot'], { telegram_user_id: 777002 });
    const fetchMock = mockFetch(url => (url.includes('relay.test') ? { body: { ok: true, result: { message_id: 1 } } } : undefined));
    const bot = require('../../server/_telegram-wb-bot.js') as { processUpdate: (u: unknown) => Promise<void> };

    await bot.processUpdate({ update_id: 1, callback_query: { id: 'cq1', from: { id: 777002 }, data: 'menu:home', message: { chat: { id: 777002 }, message_id: 5 } } });
    expect(telegramCalls(fetchMock, 'answerCallbackQuery')).toEqual([
      { callback_query_id: 'cq1', text: 'Доступ ограничен администратором. До 01.01', show_alert: true },
    ]);

    const message = { from: { id: 777002 }, chat: { id: 777002, type: 'private' }, text: '/start' };
    await bot.processUpdate({ update_id: 2, message });
    await bot.processUpdate({ update_id: 3, message });
    const sent = telegramCalls(fetchMock, 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('⛔ Доступ ограничен администратором. До 01.01');
    // в базу бот за ограниченного не ходил
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('https://db.test'))).toBe(false);
  });

  it('invalidateUserControls доступен по RPC узла бота', () => {
    const rpc = require('../../server/_bot-rpc.js') as { ALLOWED: Set<string> };
    expect(rpc.ALLOWED.has('invalidateUserControls')).toBe(true);
    const bot = require('../../server/_telegram-wb-bot.js') as { invalidateUserControls: () => boolean };
    expect(bot.invalidateUserControls()).toBe(true);
  });
});

describe('раздел «Стикеры» Помощника: область «Программа», а не «Сайт»', () => {
  const PROGRAM = { 'x-app-version': '1.12.0', 'x-app-name': 'pvz-helper', authorization: 'Bearer t' };
  const SITE = { authorization: 'Bearer t' };
  const generate = require('../../api/stickers/generate.js') as (req: unknown, res: unknown) => Promise<unknown>;
  const image = require('../../api/stickers/image.js') as (req: unknown, res: unknown) => Promise<unknown>;
  const pdf = require('../../api/stickers/pdf.js') as (req: unknown, res: unknown) => Promise<unknown>;
  const cabinetHandler = require('../../api/cabinet.js') as (req: unknown, res: unknown) => Promise<unknown>;
  const raw = (method: string, query: Record<string, string>, headers: Record<string, string>, body?: unknown) =>
    ({ method, query, headers: { ...headers }, body, socket: { remoteAddress: '127.0.0.1' } });
  const routes = () => mockFetch(url => (url.includes('user_generation_history?') ? { body: [] } : undefined));

  async function run(fn: (req: unknown, res: unknown) => Promise<unknown>, req: unknown) {
    const res = response();
    await fn(req, res);
    return res;
  }
  const cases = [
    { name: 'generate', fn: () => generate, req: (h: Record<string, string>) => raw('POST', {}, h, {}), passed: 400 },
    { name: 'image', fn: () => image, req: (h: Record<string, string>) => raw('GET', { history: '5', code: '123' }, h), passed: 404 },
    { name: 'pdf', fn: () => pdf, req: (h: Record<string, string>) => raw('GET', { history: '5' }, h), passed: 404 },
    { name: 'cabinet history', fn: () => cabinetHandler, req: (h: Record<string, string>) => raw('GET', { action: 'history', kind: 'product' }, h), passed: 200 },
  ];

  for (const c of cases) {
    it(`${c.name}: «Сайт» не закрывает программу, «Программа» закрывает только её`, async () => {
      restrict(['site']);
      routes();
      expect((await run(c.fn(), c.req(PROGRAM))).statusCode).toBe(c.passed);
      const site = await run(c.fn(), c.req(SITE));
      expect(site.statusCode).toBe(403);
      expect(site.body).toEqual({ error: 'Доступ ограничен администратором. До 01.01', code: 'ACCOUNT_RESTRICTED', until: UNTIL });

      restrict(['app']);
      const program = await run(c.fn(), c.req(PROGRAM));
      expect(program.statusCode).toBe(403);
      expect(program.body.code).toBe('ACCOUNT_RESTRICTED');
      expect((await run(c.fn(), c.req(SITE))).statusCode).toBe(c.passed);
    });
  }

  it('cabinet: прочие разделы кабинета и с заголовками программы — по «Сайту»', async () => {
    restrict(['site']);
    routes();
    const res = await run(cabinetHandler, raw('GET', { action: 'assets' }, PROGRAM));
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_RESTRICTED');
  });
});

describe('ручные лимиты в тарифе', () => {
  it('accountLimits: надбавки ПК и пунктов, не больше 20, безлимит — 99', () => {
    expect(plans.accountLimits('standard', {}, 2, false, 3, 2)).toEqual({ devices: 5, points: 3 });
    expect(plans.accountLimits(null, {}, 0, false, 0, 1)).toEqual({ devices: 1, points: 2 });
    expect(plans.accountLimits('pro', {}, 4, false, 50, 50)).toEqual({ devices: 24, points: 22 });
    expect(plans.accountLimits('pro', {}, 4, false, -3, 1.7)).toEqual({ devices: 4, points: 3 });
    expect(plans.accountLimits('pro', {}, 4, true, 3, 3)).toEqual({ devices: 99, points: 99 });
  });

  it('mirrorLimit: надбавка без проверки тарифа', () => {
    expect(plans.mirrorLimit(null, {}, false, 2)).toBe(2);
    expect(plans.mirrorLimit('pro', {}, false, 1)).toBe(3);
    expect(plans.mirrorLimit('standard', {}, false)).toBe(0);
    expect(plans.mirrorLimit('standard', {}, true, 1)).toBe(99);
  });

  it('effectiveFeatures: ручная прибавка кодов не открывает разделы старого «Стандарта»', () => {
    expect(plans.effectiveFeatures('standard', {}, false, 0, 0)).not.toContain('expensive');
    expect(plans.effectiveFeatures('standard', {}, false, 30, 0)).toContain('expensive');
    expect(plans.effectiveFeatures(null, {}, false, 0, 0)).toEqual([]);
    expect(plans.effectiveFeatures(null, {}, false, 0, 200)).toEqual(['code']);
  });

  it('entitlementsFor: «Стандарт» с ручными +200 кодами (codes_base 0) без expensive; бонусы из app_entitlements', async () => {
    mockFetch(url => (url.includes('rpc/app_entitlements')
      ? { body: { plan: 'standard', device_limit: 2, packs_left: 0, addons: {}, codes_base: 0, codes_limit: 200, device_bonus: 1, points_bonus: 2, mirror_bonus: 1 } }
      : undefined));
    const ent = await account.entitlementsFor(U1);
    expect(ent.features).not.toContain('expensive');
    expect(ent.features).toContain('code');
    expect(ent.features).toContain('mirror');
    expect(ent.limits).toEqual({ devices: 3, points: 3 });
    expect(ent.mirror).toBe(1);
  });

  it('entitlementsFor: безлимит из app_entitlements и из снимка', async () => {
    mockFetch(url => (url.includes('rpc/app_entitlements') ? { body: { plan: null, device_limit: 1, packs_left: 0, addons: {}, unlimited: true } } : undefined));
    expect((await account.entitlementsFor(U1)).limits).toEqual({ devices: 99, points: 99 });
    controls.__setSnapshotForTests({ unlimited: [{ user_id: U1, until: null }], restrictions: [] });
    expect(account.isUnlimited(U1)).toBe(true);
    expect(account.isUnlimited('22222222-2222-4222-8222-222222222222')).toBe(false);
  });
});
