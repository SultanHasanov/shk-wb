import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const root = resolve(__dirname, '../..');
type Plans = {
  planPrice: (plan: string, months: number) => number | null;
  orderSnapshot: (plan: string, months: number) => { app: Record<string, number | string>; total: number } | null;
  publicPlans: () => { plans: Array<{ id: string; prices: Record<string, number> }> };
};
const plans = require('../../server/_app-plans.js') as Plans;
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/app.js') as Handler;

const DEVICE = 'a'.repeat(64);

function response() {
  const res: { statusCode: number; body: unknown; headers: Record<string, string> } & Record<string, unknown> = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.end = () => res;
  res.setHeader = (name: string, value: string) => { res.headers[name] = value; };
  return res;
}

function request(action: string, { method = 'GET', body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return { method, query: { action }, body, headers: { 'x-app-version': '1.4.0', 'x-device-id': DEVICE, ...headers }, socket: { remoteAddress: '127.0.0.1' } };
}

// Подменный Supabase: отвечает по пути запроса.
type Route = (url: string, init: RequestInit) => { status?: number; body: unknown } | undefined;
function mockSupabase(route: Route) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.includes('consume_api_rate_limit')) return new Response('true', { status: 200 });
    const hit = route(url, init)
      || (url.includes('rpc/app_entitlements') ? { body: { plan: null, device_limit: 1, packs_left: 0, addons: {} } } : undefined)
      || { status: 404, body: { message: 'unexpected ' + url } };
    return new Response(JSON.stringify(hit.body), { status: hit.status || 200, headers: { 'content-type': 'application/json' } });
  }));
}

describe('тарифы программы', () => {
  it('считает цену со скидкой за срок', () => {
    expect(plans.planPrice('standard', 1)).toBe(390);
    expect(plans.planPrice('pro', 12)).toBe(Math.round(790 * 12 * 0.75));
    expect(plans.planPrice('pro', 2)).toBeNull();
    expect(plans.planPrice('vip', 1)).toBeNull();
  });
  it('кладёт лимиты в снимок заказа', () => {
    expect(plans.orderSnapshot('pro', 3)).toMatchObject({ app: { plan: 'pro', codes: 100, stickers: 300, devices: 4, monthly_price: 790 }, total: 2133 });
  });
  it('отдаёт тарифы публично', async () => {
    const res = response();
    await handler({ method: 'GET', query: { action: 'plans' }, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect((res.body as ReturnType<Plans['publicPlans']>).plans.map(p => p.id)).toEqual(['basic', 'standard', 'pro']);
  });
});

describe('вход и списание в программе', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
    process.env.SUPABASE_SECRET_KEY = 'secret';
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const session = { access_token: 'acc', refresh_token: 'ref', expires_in: 3600, expires_at: 1, user: { id: 'u1', email: 'a@b.c' } };

  it('входит по паролю и регистрирует ПК', async () => {
    mockSupabase(url => {
      if (url.includes('grant_type=password')) return { body: session };
      if (url.includes('rpc/app_register_device')) return { body: 'dev-1' };
    });
    const res = response();
    await handler(request('login', { method: 'POST', body: { email: 'A@b.c', password: 'x', deviceName: 'Касса' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ session: { access_token: 'acc', refresh_token: 'ref', expires_in: 3600, expires_at: 1 } });
  });

  it('при лимите ПК отдаёт список компьютеров и сессию', async () => {
    mockSupabase(url => {
      if (url.includes('grant_type=password')) return { body: session };
      if (url.includes('rpc/app_register_device')) return { status: 400, body: { message: 'DEVICE_LIMIT' } };
      if (url.includes('app_devices?')) return { body: [{ id: 'd1', device_hash: 'b'.repeat(64), name: 'Старый', app_version: '1.4.0', last_seen_at: '2026-10-01', created_at: '2026-09-01' }] };
    });
    const res = response();
    await handler(request('login', { method: 'POST', body: { email: 'a@b.c', password: 'x' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'DEVICE_LIMIT', devices: [{ id: 'd1', name: 'Старый', current: false }], session: { access_token: 'acc' } });
  });

  it('неверный пароль — понятная ошибка', async () => {
    mockSupabase(url => { if (url.includes('grant_type=password')) return { status: 400, body: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } }; });
    const res = response();
    await handler(request('login', { method: 'POST', body: { email: 'a@b.c', password: 'x' } }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'BAD_CREDENTIALS' });
  });

  it('отключённый ПК не может списывать подборы', async () => {
    mockSupabase(url => {
      if (url.endsWith('/auth/v1/user')) return { body: { id: 'u1', email: 'a@b.c' } };
      if (url.includes('app_devices?')) return { body: [] };
    });
    const res = response();
    await handler(request('consume', { method: 'POST', body: {}, headers: { authorization: 'Bearer acc' } }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  it('пустой лимит и нет пакетов — LIMIT_EXCEEDED', async () => {
    mockSupabase(url => {
      if (url.endsWith('/auth/v1/user')) return { body: { id: 'u1', email: 'a@b.c' } };
      if (url.includes('app_devices?')) return { body: [{ id: 'dev-1', last_seen_at: new Date().toISOString() }] };
      if (url.includes('rpc/app_consume')) return { status: 400, body: { message: 'LIMIT_EXCEEDED' } };
    });
    const res = response();
    await handler(request('consume', { method: 'POST', body: { meta: { cell: '123' } }, headers: { authorization: 'Bearer acc' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('старая сборка без версии не попадает в API программы', async () => {
    process.env.PROGRAM_MIN_VERSION = '1.3.15';
    const res = response();
    await handler({ method: 'POST', query: { action: 'login' }, body: {}, headers: {} }, res);
    expect(res.statusCode).toBe(426);
    delete process.env.PROGRAM_MIN_VERSION;
  });
});

describe('подписка в базе и оплате', () => {
  const migration = readFileSync(resolve(root, 'supabase/migrations/20261018_app_subscriptions.sql'), 'utf8');
  const payments = readFileSync(resolve(root, 'api/payments.js'), 'utf8');
  it('исполняет заказ подписки один раз и под блокировкой', () => {
    expect(migration).toContain('if order_row.app_fulfilled_at is not null then');
    expect(migration).toContain('pg_advisory_xact_lock(hashtext(p_order_id::text))');
  });
  it('списывает сначала квоту, потом пакеты', () => {
    expect(migration.indexOf("'quota'")).toBeLessThan(migration.indexOf("'pack', pack.id"));
  });
  it('подписка требует аккаунт и берёт цену с сервера', () => {
    expect(payments).toContain("Войдите в аккаунт, чтобы оформить подписку");
    expect(payments).toContain("orderSnapshot(appPlan, appTerm)");
  });
  it('старый адрес пробного периода ведёт в новый обработчик', () => {
    const vercel = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
    expect(vercel.rewrites).toContainEqual({ source: '/api/trial', destination: '/api/app?action=trial' });
  });
});

describe('разделы по тарифам и услуга «Архив»', () => {
  type Full = {
    effectiveFeatures: (plan: string | null, addons: Record<string, { ends_at: string }>, free: boolean) => string[];
    addonAllowed: (addon: string, plan: string | null) => boolean;
    addonSnapshot: (addon: string, months: number) => { addon: { price: number }; total: number } | null;
    publicPlans: () => { addons: Array<{ id: string; prices: Record<string, number> }>; features: Record<string, string> };
  };
  const p = require('../../server/_app-plans.js') as Full;
  const future = { archive: { ends_at: new Date(Date.now() + 86400000).toISOString() } };
  const past = { archive: { ends_at: new Date(Date.now() - 1000).toISOString() } };

  it('без подписки — ни одного раздела, с пакетами подбор проверяет сервер', () => {
    expect(p.effectiveFeatures(null, {}, false)).toEqual([]);
  });
  it('Базовый — только подбор кода, архив к нему не подключается', () => {
    expect(p.effectiveFeatures('basic', future, false)).toEqual(['code']);
    expect(p.addonAllowed('archive', 'basic')).toBe(false);
  });
  it('Стандарт открывает ячейки, коробки, ШК и примерку, но не досье и сотрудников', () => {
    const f = p.effectiveFeatures('standard', {}, false);
    expect(f).toEqual(expect.arrayContaining(['cells', 'boxes', 'goods', 'tryon', 'notes', 'reviews']));
    expect(f).not.toContain('dossier');
    expect(f).not.toContain('staff');
    expect(f).not.toContain('archive');
  });
  it('архив открыт только пока услуга не истекла', () => {
    expect(p.effectiveFeatures('standard', future, false)).toContain('archive');
    expect(p.effectiveFeatures('pro', past, false)).not.toContain('archive');
  });
  it('бесплатный режим — Про со всеми услугами', () => {
    expect(p.effectiveFeatures(null, {}, true)).toEqual(expect.arrayContaining(['dossier', 'staff', 'stickers', 'archive']));
  });
  it('цена архива берётся с сервера, «синхронизации» в тарифах нет', () => {
    expect(p.addonSnapshot('archive', 6)?.total).toBe(590);
    expect(p.addonSnapshot('archive', 12)?.total).toBe(990);
    expect(p.addonSnapshot('archive', 1)).toBeNull();
    expect(p.publicPlans().addons.map(a => a.id)).toEqual(['archive', 'devices_1', 'devices_3', 'points_1', 'points_3']);
    expect(p.publicPlans().features).not.toHaveProperty('sync');
  });
  it('оплата услуги проверяет тариф, заказ исполняется один раз', () => {
    const payments = readFileSync(resolve(root, 'api/payments.js'), 'utf8');
    const migration = readFileSync(resolve(root, 'supabase/migrations/20261020_app_addons.sql'), 'utf8');
    expect(payments).toContain("addonSnapshot(appAddon, appAddonMonths)");
    expect(payments).toContain("code: 'PLAN_REQUIRED'");
    expect(migration).toContain('if order_row.app_fulfilled_at is not null then');
    expect(migration).toContain("'addons', addons");
  });
});

describe('сдвиг подписок и услуг за бесплатный период', () => {
  type Free = { planShift: (rows: Array<{ id: number; user_id: string; starts_at: string; ends_at: string }>, from: number, to: number) => { patches: Array<{ id: number; patch: Record<string, string> }> } };
  const free = require('../../server/_app-free.js') as Free;
  it('купленное внутри периода начинается после него', () => {
    const from = Date.parse('2026-10-01T00:00:00Z'), to = Date.parse('2026-11-01T00:00:00Z');
    const { patches } = free.planShift([{ id: 1, user_id: 'u:archive', starts_at: '2026-10-10T00:00:00Z', ends_at: '2027-04-10T00:00:00Z' }], from, to);
    expect(patches[0].patch.starts_at).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('оплата из программы по QR-коду СБП', () => {
  const app = readFileSync(resolve(root, 'api/app.js'), 'utf8');
  const payments = readFileSync(resolve(root, 'api/payments.js'), 'utf8');
  it('программа создаёт тот же заказ подписки, но со способом sbp_qr', () => {
    expect(app).toContain("paymentMethod: 'sbp_qr'");
    expect(app).toContain("req.query.action = 'create'");
    expect(app).toContain("req.query.action = 'status'");
  });
  it('QR берётся из confirmation_data ЮKassa и только для подписки программы', () => {
    expect(payments).toContain("payment_method_data: { type: 'sbp' }, confirmation: { type: 'qr' }");
    expect(payments).toContain('qr: payment.confirmation?.confirmation_data');
    expect(payments).toContain('Оплата по QR доступна только для подписки программы');
  });
});
