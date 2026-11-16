import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/cabinet.js') as Handler;
const appCrypto = require('../../server/_app-crypto.js') as { seal: (u: string, t: string, p?: string) => string };
const staffServer = require('../../server/_staff.js') as { _test: { forgetPublic: () => void } };
const deviceCache = require('../../server/_app-device-cache.js') as { resetForTests: () => void };

const OWNER = '22222222-2222-4222-8222-222222222222';
const POINT = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'AbCdEfGh2345Jkmn';

const staffDoc = {
  staff_list: [
    { id: 's1', name: 'Анна Соколова', last4: '', sid: '123456', phone: '+7 900 000-00-01', rates: [{ from: '2026-01-01', rate: 2500 }] },
    { id: 's2', name: 'Марина Ким', last4: '', sid: '', phone: '', rates: [{ from: '2026-01-01', rate: 2000 }] },
  ],
  staff: {},
};
const scheduleDoc = {
  v: 1,
  dayHours: { from: '09:00', to: '21:00' },
  shifts: { '2026-11-17': [{ staffId: 's1', kind: 'full' }], '2026-11-18': [{ staffId: 's2', kind: 'half', replaces: 's1' }] },
  payments: [{ id: 'p1', staffId: 's1', date: '2026-11-15', type: 'advance', amount: 10000, method: 'cash', note: '' }],
  adjustments: [],
  ownerDays: ['2026-11-19'],
};

function response() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string>, headersSent: false };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; res.headersSent = true; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.end = () => { res.headersSent = true; return res; };
  return res;
}

function req(action: string, { method = 'GET', query = {}, body, auth = true }: { method?: string; query?: Record<string, string>; body?: unknown; auth?: boolean } = {}) {
  return {
    method,
    query: { action, ...query },
    body,
    headers: { 'x-forwarded-for': '203.0.113.9', ...(auth ? { authorization: 'Bearer tkn' } : {}) },
    socket: { remoteAddress: '203.0.113.9' },
  };
}

type Call = { url: string; method: string; body: any };

function mockServer({ plan = 'pro', version = 4, putStatus = 200, link = true }: { plan?: string | null; version?: number; putStatus?: number; link?: boolean } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = String(init.method || 'GET');
    let body: any = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* текст */ } }
    calls.push({ url, method, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/auth/v1/user')) return json({ id: OWNER, email: 'owner@example.ru' });
    if (url.includes('rpc/app_entitlements')) return json({ plan, device_limit: 4, addons: {} });
    if (url.includes('/rest/v1/app_points?id=eq.')) return json([{ id: POINT, wb_point_id: 317162, name: 'Ленина, 14' }]);
    if (url.includes('/rest/v1/app_points?user_id=eq.')) return json([{ id: POINT, wb_point_id: 317162, name: 'Ленина, 14', created_at: '2026-10-01T00:00:00Z' }]);
    if (url.includes('/rest/v1/app_docs_history?')) {
      // в истории лежит одна старая версия графика: одна смена, выплат нет
      if (!url.includes('version=eq.3')) return json([]);
      return json([{ data_enc: appCrypto.seal(OWNER, JSON.stringify({ ...scheduleDoc, shifts: { '2026-11-17': [{ staffId: 's1', kind: 'full' }] }, payments: [] })) }]);
    }
    if (url.includes('/rest/v1/app_docs?')) {
      const rows = [
        { key: 'staff', version: 2, data_enc: appCrypto.seal(OWNER, JSON.stringify(staffDoc)), updated_at: '2026-11-15T10:00:00Z', device_id: 'dev-1' },
        { key: 'schedule', version, data_enc: appCrypto.seal(OWNER, JSON.stringify(scheduleDoc)), updated_at: '2026-11-16T09:00:00Z', device_id: null },
      ];
      // как настоящая база: запрос одного документа отдаёт только его
      const only = /[?&]key=eq\.(\w+)/.exec(url)?.[1];
      return json(only ? rows.filter(r => r.key === only) : rows);
    }
    if (url.includes('rpc/app_doc_put')) {
      if (putStatus === 409) return json({ message: 'VERSION_CONFLICT' }, 400);
      return json(version + 1);
    }
    if (url.includes('/rest/v1/staff_share_links')) {
      if (method === 'PATCH') return json([{ token: 'OLDTOKEN12345' }]);
      if (method === 'POST') return json([{ token: body.token, short_names: body.short_names, show_subs: body.show_subs, created_at: '2026-11-16T10:00:00Z' }], 201);
      return json(link ? [{ user_id: OWNER, point_id: POINT, short_names: true, show_subs: true }] : []);
    }
    return json([]);
  }));
  return calls;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.APP_DATA_KEY = 'd'.repeat(40);
  process.env.APP_SECRETS_KEY = 's'.repeat(40);
  deviceCache.resetForTests();
  staffServer._test.forgetPublic();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('сотрудники на сайте: чтение', () => {
  it('без пункта — список пунктов и доступ к разделу', async () => {
    mockServer();
    const res = response();
    await handler(req('staff'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ allowed: true, points: [{ id: POINT, name: 'Ленина, 14', wbPointId: '317162' }] });
  });

  it('документы пункта расшифровываются как у программы', async () => {
    mockServer();
    const res = response();
    await handler(req('staff', { query: { point: POINT } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.staff).toMatchObject({ version: 2, data: staffDoc, fromSite: false });
    expect(res.body.schedule).toMatchObject({ version: 4, data: scheduleDoc, fromSite: true });
  });

  it('без «Про» график не отдаётся', async () => {
    mockServer({ plan: 'basic' });
    const list = response();
    await handler(req('staff'), list);
    expect(list.body.allowed).toBe(false);
    const res = response();
    await handler(req('staff', { query: { point: POINT } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('STAFF_REQUIRED');
  });
});

describe('сотрудники на сайте: запись', () => {
  it('пишет через app_doc_put со сверкой версии, без ПК', async () => {
    const calls = mockServer();
    const res = response();
    await handler(req('staff', { method: 'PUT', body: { key: 'schedule', point: POINT, base: 4, data: scheduleDoc } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ version: 5 });
    const put = calls.find(c => c.url.includes('rpc/app_doc_put'))!;
    expect(put.body).toMatchObject({ p_user: OWNER, p_scope: POINT, p_key: 'schedule', p_base: 4, p_device: null, p_secret: false });
    expect(put.body.p_data).toMatch(/^v1\./);
  });

  it('версия устарела — 409 с текущим документом для слияния', async () => {
    mockServer({ putStatus: 409, version: 6 });
    const res = response();
    await handler(req('staff', { method: 'PUT', body: { key: 'schedule', point: POINT, base: 4, data: scheduleDoc } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(res.body.current).toMatchObject({ version: 6, data: scheduleDoc });
  });

  it('не стирает всех сотрудников без подтверждения', async () => {
    const calls = mockServer();
    const res = response();
    await handler(req('staff', { method: 'PUT', body: { key: 'staff', point: POINT, base: 2, data: { staff_list: [], staff: {} } } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('EMPTY_GUARD');
    expect(calls.some(c => c.url.includes('rpc/app_doc_put'))).toBe(false);
    const ok = response();
    await handler(req('staff', { method: 'PUT', body: { key: 'staff', point: POINT, base: 2, data: { staff_list: [], staff: {} }, confirmEmpty: true } }), ok);
    expect(ok.statusCode).toBe(200);
  });

  it('отклоняет записи, которые программа не смогла бы слить', async () => {
    mockServer();
    for (const data of [
      { ...scheduleDoc, shifts: { '2026-11-17': [{ kind: 'full' }] } },
      { ...scheduleDoc, payments: [{ staffId: 's1', amount: 1 }] },
      { ...scheduleDoc, shifts: { '2026-11-17': [{ staffId: 's1', kind: 'full' }, { staffId: 's1', kind: 'half' }] } },
    ]) {
      const res = response();
      await handler(req('staff', { method: 'PUT', body: { key: 'schedule', point: POINT, base: 4, data } }), res);
      expect(res.statusCode).toBe(400);
    }
    const res = response();
    await handler(req('staff', { method: 'PUT', body: { key: 'notes', point: POINT, base: 1, data: {} } }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('ссылка для сотрудников', () => {
  it('новая ссылка отзывает старую', async () => {
    const calls = mockServer();
    const res = response();
    await handler(req('staff-link', { method: 'POST', body: { point: POINT, shortNames: true } }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.link.url).toMatch(/\/grafik\/[A-Za-z0-9]{16}$/);
    const revoke = calls.find(c => c.url.includes('staff_share_links') && c.method === 'PATCH')!;
    expect(revoke.url).toContain('revoked_at=is.null');
    expect(revoke.body).toHaveProperty('revoked_at');
  });

  it('сотрудник видит смены и часы, но не ставки, выплаты, телефоны и номера WB', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'));
    try {
      mockServer();
      const res = response();
      await handler(req('staff-public', { query: { token: TOKEN }, auth: false }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['X-Robots-Tag']).toContain('noindex');
      const text = JSON.stringify(res.body);
      for (const secret of ['2500', '10000', '900', '123456', 'Соколова', 'rates', 'payments', 's1']) expect(text).not.toContain(secret);
      expect(res.body).toMatchObject({ point: 'Ленина, 14', months: ['2026-10', '2026-11', '2026-12'], owner: ['2026-11-19'] });
      expect(res.body.people).toEqual([{ k: 'p1', name: 'Анна' }, { k: 'p2', name: 'Марина' }]);
      expect(res.body.days['2026-11-18']).toEqual([{ k: 'p2', h: '9:00–15:00', sub: 'Анна' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('отозванная или чужая ссылка — 404 без подробностей', async () => {
    mockServer({ link: false });
    const res = response();
    await handler(req('staff-public', { query: { token: TOKEN }, auth: false }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('LINK_INACTIVE');
    const bad = response();
    await handler(req('staff-public', { query: { token: '../etc' }, auth: false }), bad);
    expect(bad.statusCode).toBe(404);
  });
});

describe('история изменений: возврат версии', () => {
  it('перед возвратом показывает, что лежит в версии и что сейчас', async () => {
    mockServer();
    const res = response();
    await handler(req('staff-history', { query: { point: POINT, key: 'schedule', version: '3' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      version: 3,
      was: { days: 1, lastDay: '2026-11-17', payments: 0, paid: 0 },
      now: { days: 2, lastDay: '2026-11-18', payments: 1, paid: 10000 },
    });
  });

  it('возврат записывает старую версию как новую — прежняя остаётся в истории', async () => {
    const calls = mockServer();
    const res = response();
    await handler(req('staff-history', { method: 'POST', body: { point: POINT, key: 'schedule', version: 3 } }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as any).version).toBe(5);
    expect(Object.keys((res.body as any).data.shifts)).toEqual(['2026-11-17']);
    const put = calls.find(c => c.url.includes('rpc/app_doc_put'))!;
    expect(put.body).toMatchObject({ p_user: OWNER, p_scope: POINT, p_key: 'schedule', p_base: 4, p_device: null });
  });

  it('версии, которой уже нет в истории, не возвращает и ничего не пишет', async () => {
    const calls = mockServer();
    const res = response();
    await handler(req('staff-history', { method: 'POST', body: { point: POINT, key: 'schedule', version: 1 } }), res);
    expect(res.statusCode).toBe(404);
    expect(calls.some(c => c.url.includes('rpc/app_doc_put'))).toBe(false);
  });
});
