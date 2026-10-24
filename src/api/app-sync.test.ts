import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/app.js') as Handler;
const appCrypto = require('../../server/_app-crypto.js') as {
  seal: (user: string, text: string, purpose?: string) => string | null;
  open: (user: string, value: string | null, purpose?: string) => string | null;
};
const plans = require('../../server/_app-plans.js') as {
  accountLimits: (plan: string | null, addons: Record<string, { ends_at: string }>, sub: number, unlimited: boolean) => { devices: number; points: number };
};

const DEVICE = 'a'.repeat(64);
const USER = '11111111-1111-4111-8111-111111111111';
const POINT = '22222222-2222-4222-8222-222222222222';

function response() {
  const res: { statusCode: number; body: unknown } & Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.end = () => res;
  res.setHeader = () => undefined;
  return res;
}

function request(action: string, { method = 'GET', body, query = {} }: { method?: string; body?: unknown; query?: Record<string, string> } = {}) {
  return {
    method,
    query: { action, ...query },
    body,
    headers: { 'x-app-version': '1.5.0', 'x-device-id': DEVICE, authorization: 'Bearer token' },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

type Call = { url: string; init: RequestInit };
type Route = (url: string, init: RequestInit) => { status?: number; body: unknown } | undefined;
function mockSupabase(route: Route, ent: Record<string, unknown> = { plan: 'standard', device_limit: 2, addons: {} }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.includes('consume_api_rate_limit')) return new Response('true', { status: 200 });
    const hit = route(url, init)
      || (url.includes('/auth/v1/user') ? { body: { id: USER, email: 'owner@test.ru' } } : undefined)
      || (url.includes('app_devices?') && url.includes('revoked_at=is.null') ? { body: [{ id: 'dev-1', last_seen_at: new Date().toISOString() }] } : undefined)
      || (url.includes('rpc/app_entitlements') ? { body: ent } : undefined)
      || { status: 404, body: { message: 'unexpected ' + url } };
    return new Response(JSON.stringify(hit.body), { status: hit.status || 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.APP_DATA_KEY = 'd'.repeat(40);
  process.env.APP_SECRETS_KEY = 's'.repeat(40);
  delete process.env.APP_UNLIMITED_USER_IDS;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('шифрование облака', () => {
  it('расшифровывает своим ключом и не открывается чужим', () => {
    const sealed = appCrypto.seal(USER, '+7 900 123-45-67');
    expect(sealed).not.toContain('900');
    expect(appCrypto.open(USER, sealed)).toBe('+7 900 123-45-67');
    expect(appCrypto.open('33333333-3333-4333-8333-333333333333', sealed)).toBeNull();
    expect(appCrypto.open(USER, sealed, 'secret')).toBeNull();
  });
  it('одинаковые данные дают одинаковый шифротекст (без лишней синхронизации)', () => {
    expect(appCrypto.seal(USER, 'x')).toBe(appCrypto.seal(USER, 'x'));
    expect(appCrypto.seal(USER, 'x')).not.toBe(appCrypto.seal(USER, 'y'));
  });
  it('без ключа на сервере — понятная ошибка, а не запись открытым текстом', async () => {
    delete process.env.APP_DATA_KEY;
    mockSupabase(url => {
      if (url.includes('app_points?id=eq.')) return { body: [{ id: POINT, wb_point_id: 1 }] };
    });
    const res = response();
    await handler(request('archive-push', { method: 'POST', body: { point: POINT, goods: [{ uid: 'u', sid: 's', data: '{}' }] } }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: 'SYNC_NOT_CONFIGURED' });
  });
});

describe('лимиты пунктов и ПК', () => {
  it('тариф + пакеты', () => {
    const future = { ends_at: '2099-01-01T00:00:00Z' };
    const past = { ends_at: '2000-01-01T00:00:00Z' };
    expect(plans.accountLimits('basic', {}, 1, false)).toEqual({ devices: 1, points: 1 });
    expect(plans.accountLimits('standard', {}, 1, false)).toEqual({ devices: 2, points: 1 });
    expect(plans.accountLimits('pro', { devices_3: future, points_1: future }, 4, false)).toEqual({ devices: 9, points: 3 });
    expect(plans.accountLimits('pro', { points_1: past }, 4, false)).toEqual({ devices: 4, points: 2 });
    expect(plans.accountLimits(null, {}, 1, true)).toEqual({ devices: 99, points: 99 });
  });
  it('лишний пункт — POINT_LIMIT со списком', async () => {
    mockSupabase(url => {
      if (url.includes('rpc/app_register_point')) return { status: 400, body: { message: 'POINT_LIMIT' } };
      if (url.includes('app_points?user_id')) return { body: [{ id: POINT, wb_point_id: 7, name: 'Первый' }] };
    });
    const res = response();
    await handler(request('points', { method: 'POST', body: { wbPointId: 8, name: 'Второй' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'POINT_LIMIT', limit: 1, points: [{ id: POINT, name: 'Первый' }] });
  });
});

describe('архив пункта', () => {
  it('отправка шифрует данные и телефоны', async () => {
    let sent: Record<string, unknown> | null = null;
    mockSupabase((url, init) => {
      if (url.includes('app_points?id=eq.')) return { body: [{ id: POINT, wb_point_id: 7 }] };
      if (url.includes('rpc/app_archive_push')) { sent = JSON.parse(String(init.body)); return { body: 2 }; }
    });
    const res = response();
    await handler(request('archive-push', {
      method: 'POST',
      body: { point: POINT, goods: [{ uid: 'u1', sid: '42', status: 'GOODS_READY', updated: '2026-10-20', data: '{"name":"Тарелка"}', rank: 1 }], clients: [{ sid: '42', mobile: '+79001234567', last_seen: '2026-10-20' }] },
    }), res);
    expect(res.statusCode).toBe(200);
    const body = JSON.stringify(sent);
    expect(body).not.toContain('Тарелка');
    expect(body).not.toContain('9001234567');
    expect(sent).toMatchObject({ p_point: POINT, p_goods: [{ uid: 'u1', sid: '42', rank: 1 }] });
  });

  it('чужой пункт не найдётся', async () => {
    const calls = mockSupabase(url => {
      if (url.includes('app_points?id=eq.')) return { body: [] };
    });
    const res = response();
    await handler(request('archive-push', { method: 'POST', body: { point: POINT, goods: [] } }), res);
    expect(res.statusCode).toBe(404);
    const lookup = calls.find(c => c.url.includes('app_points?id=eq.'));
    expect(lookup?.url).toContain(`user_id=eq.${USER}`);
  });

  it('скачивание на другой ПК — только с услугой «Архив»', async () => {
    mockSupabase(url => {
      if (url.includes('app_points?id=eq.')) return { body: [{ id: POINT, wb_point_id: 7 }] };
    });
    const res = response();
    await handler(request('archive-pull', { method: 'POST', body: { point: POINT, since: {} } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'ARCHIVE_REQUIRED' });
  });

  it('с услугой — расшифрованные изменения и курсоры', async () => {
    const data = appCrypto.seal(USER, '{"name":"Тарелка"}');
    const mobile = appCrypto.seal(USER, '+79001234567');
    mockSupabase(url => {
      if (url.includes('app_points?id=eq.')) return { body: [{ id: POINT, wb_point_id: 7 }] };
      if (url.includes('app_archive_goods?')) return { body: [{ uid: 'u1', sid: '42', status: 'GOODS_RECIEVED', updated: '2026-10-21', rank: 1, data_enc: data, seq: 15 }] };
      if (url.includes('app_archive_clients?')) return { body: [{ sid: '42', mobile_enc: mobile, name_enc: null, first_seen: '2026-01-01', last_seen: '2026-10-21', seq: 16 }] };
      if (url.includes('app_archive_reviews?') || url.includes('app_archive_shk?')) return { body: [] };
    }, { plan: 'standard', device_limit: 2, addons: { archive: { ends_at: '2099-01-01T00:00:00Z' } } });
    const res = response();
    await handler(request('archive-pull', { method: 'POST', body: { point: POINT, since: { goods: 10, reviews: 3 } } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      goods: [{ uid: 'u1', data: '{"name":"Тарелка"}' }],
      clients: [{ sid: '42', mobile: '+79001234567' }],
      next: { goods: 15, clients: 16, reviews: 3, shk: 0 },
      more: false,
    });
  });
});

describe('документы и секреты', () => {
  it('конфликт версий — 409 с текущей версией', async () => {
    mockSupabase(url => {
      if (url.includes('rpc/app_doc_put')) return { status: 400, body: { message: 'VERSION_CONFLICT' } };
      if (url.includes('app_docs?')) return { body: [{ scope: 'account', key: 'notes', version: 5, data_enc: appCrypto.seal(USER, '{"a":1}'), updated_at: 'x' }] };
    });
    const res = response();
    await handler(request('docs', { method: 'PUT', body: { key: 'notes', base: 4, data: { a: 2 } } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'VERSION_CONFLICT', current: { version: 5, data: { a: 1 } } });
  });

  it('секреты шифруются отдельным ключом и попадают в журнал', async () => {
    let put: Record<string, string> | null = null;
    const calls = mockSupabase((url, init) => {
      if (url.includes('rpc/app_doc_put')) { put = JSON.parse(String(init.body)); return { body: 1 }; }
      if (url.includes('app_secret_access')) return { status: 201, body: null };
    });
    const res = response();
    await handler(request('secrets', { method: 'PUT', body: { key: 'telegram', base: 0, data: { token: '123:ABC' } } }), res);
    expect(res.statusCode).toBe(200);
    expect(put!.p_secret).toBe(true);
    expect(appCrypto.open(USER, put!.p_data, 'secret')).toBe('{"token":"123:ABC"}');
    expect(appCrypto.open(USER, put!.p_data)).toBeNull();
    expect(calls.some(c => c.url.includes('app_secret_access'))).toBe(true);
  });

  it('неизвестный документ не принимается', async () => {
    mockSupabase(() => undefined);
    const res = response();
    await handler(request('docs', { method: 'PUT', body: { key: 'anything', data: {} } }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('регистрация из программы', () => {
  it('слабый пароль не отправляется в Supabase', async () => {
    const calls = mockSupabase(() => undefined);
    const res = response();
    await handler({ ...request('signup', { method: 'POST', body: { email: 'new@test.ru', password: '12345678' } }), headers: { 'x-app-version': '1.5.0', 'x-device-id': DEVICE } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'WEAK_PASSWORD' });
    expect(calls.some(c => c.url.includes('/auth/v1/signup'))).toBe(false);
  });

  it('ждёт подтверждения почты и отдаёт секрет опроса', async () => {
    let stored: Record<string, string> | null = null;
    mockSupabase((url, init) => {
      if (url.includes('/auth/v1/signup')) return { body: { id: USER, email: 'new@test.ru' } };
      if (url.includes('/auth/v1/admin/users/')) return { body: { id: USER, email: 'new@test.ru', email_confirmed_at: null } };
      if (url.includes('app_signup_requests')) { stored = JSON.parse(String(init.body)); return { status: 201, body: [{ id: POINT }] }; }
    });
    const res = response();
    await handler({ ...request('signup', { method: 'POST', body: { email: 'New@Test.ru', password: 'secret123' } }), headers: { 'x-app-version': '1.5.0', 'x-device-id': DEVICE } }, res);
    expect(res.statusCode).toBe(201);
    const body = res.body as { id: string; secret: string; status: string };
    expect(body).toMatchObject({ status: 'pending', id: POINT, email: 'new@test.ru' });
    expect(stored!.poll_secret_hash).not.toBe(body.secret);
    expect(JSON.stringify(stored)).not.toContain('secret123');
  });
});

describe('безлимитный аккаунт', () => {
  it('всё открыто, подбор не списывается', async () => {
    process.env.APP_UNLIMITED_USER_IDS = `${USER}, 44444444-4444-4444-8444-444444444444`;
    const calls = mockSupabase(url => {
      if (url.includes('user_profiles') || url.includes('user_telegram') || url.includes('license_keys') || url.includes('sticker_access_codes') || url.includes('app_points?user_id')) return { body: [] };
      if (url.includes('app_devices?user_id') && url.includes('order=')) return { body: [] };
    }, { plan: null, device_limit: 1, addons: {} });
    const res = response();
    await handler(request('consume', { method: 'POST', body: { meta: { cell: '12' } } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, unlimited: true, account: { unlimited: true, effectivePlan: 'pro', deviceLimit: 99, pointLimit: 99 } });
    expect((res.body as { account: { features: string[] } }).account.features).toContain('archive');
    expect(calls.some(c => c.url.includes('rpc/app_consume'))).toBe(false);
  });
});

describe('зеркало — услуга «Пункт с любого ПК»', () => {
  const future = { ends_at: '2099-01-01T00:00:00Z' };
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const mirrorPlans = plans as unknown as {
    mirrorLimit: (plan: string | null, addons: Record<string, { ends_at: string }>, unlimited: boolean) => number;
    effectiveFeatures: (plan: string | null, addons: Record<string, { ends_at: string }>, free: boolean) => string[];
  };

  it('лимит: пакеты со Стандарта, бесплатный режим зеркала не даёт', () => {
    expect(mirrorPlans.mirrorLimit('standard', {}, false)).toBe(0);
    expect(mirrorPlans.mirrorLimit('standard', { mirror_1: future, mirror_3: future }, false)).toBe(4);
    expect(mirrorPlans.mirrorLimit('basic', { mirror_1: future }, false)).toBe(0);
    expect(mirrorPlans.mirrorLimit(null, {}, true)).toBe(99);
    expect(mirrorPlans.effectiveFeatures(null, {}, true)).not.toContain('mirror');
    expect(mirrorPlans.effectiveFeatures('standard', { mirror_1: future }, true)).toContain('mirror');
    expect(mirrorPlans.effectiveFeatures('standard', { mirror_1: future }, false)).toContain('mirror');
  });

  it('список пунктов: без услуги mirrorAt не пустой (программа не шлёт зеркало по кругу)', async () => {
    const created = '2026-10-20T10:00:00Z';
    const route = (url: string) => {
      if (url.includes('app_points?user_id=eq.')) return { body: [{ id: POINT, wb_point_id: 7, name: 'П', created_at: created }, { id: OTHER, wb_point_id: 8, name: 'В', created_at: created }] };
      if (url.includes('app_points?id=in.')) return { body: [] };
    };
    mockSupabase(route);
    let res = response();
    await handler(request('points'), res);
    expect((res.body as { points: { mirrorAt: string | null }[] }).points.map(p => p.mirrorAt)).toEqual([created, created]);

    mockSupabase(route, { plan: 'standard', device_limit: 2, addons: { mirror_1: future } });
    res = response();
    await handler(request('points'), res);
    // первый оплачен, зеркала ещё нет — null, программа отправит его целиком
    expect((res.body as { points: { mirrorAt: string | null }[] }).points.map(p => p.mirrorAt)).toEqual([null, created]);
  });

  it('без пакета отправку принимаем и не пишем', async () => {
    const calls = mockSupabase(url => {
      if (url.includes('app_points?id=eq.')) return { body: [{ id: POINT, wb_point_id: 7 }] };
    });
    const res = response();
    await handler(request('mirror-push', { method: 'POST', body: { point: POINT, rows: [{ t: 'cells', k: '1', d: '{}' }] } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ changed: 0, disabled: true });
    expect(calls.some(c => c.url.includes('rpc/app_mirror_push'))).toBe(false);
  });

  it('пакет на 1 пункт — пишется только первый по порядку подключения', async () => {
    const route = (url: string) => {
      if (url.includes('app_points?id=eq.')) return { body: [{ id: url.includes(OTHER) ? OTHER : POINT, wb_point_id: 7 }] };
      if (url.includes('app_points?user_id=eq.')) return { body: [{ id: POINT }] };
      if (url.includes('rpc/app_mirror_push')) return { body: 1 };
    };
    const ent = { plan: 'standard', device_limit: 2, addons: { mirror_1: future } };
    let calls = mockSupabase(route, ent);
    let res = response();
    await handler(request('mirror-push', { method: 'POST', body: { point: POINT, rows: [{ t: 'cells', k: '1', d: '{}' }] } }), res);
    expect(res.body).toMatchObject({ changed: 1 });
    expect(calls.some(c => c.url.includes('rpc/app_mirror_push'))).toBe(true);

    calls = mockSupabase(route, ent);
    res = response();
    await handler(request('mirror-push', { method: 'POST', body: { point: OTHER, rows: [{ t: 'cells', k: '1', d: '{}' }] } }), res);
    expect(res.body).toMatchObject({ changed: 0, disabled: true });
    expect(calls.some(c => c.url.includes('rpc/app_mirror_push'))).toBe(false);
  });
});
