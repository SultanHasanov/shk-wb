import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/app.js') as Handler;
const relay = require('../../server/_app-relay.js') as {
  resetForTests: () => void;
  sweep: (now?: number) => void;
  JOB_TTL_MS: number;
};

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '33333333-3333-4333-8333-333333333333';
const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HASH: Record<string, string> = { [HOME]: 'a'.repeat(64), [WORK]: 'b'.repeat(64) };
const future = { ends_at: '2099-01-01T00:00:00Z' };

type Res = { statusCode: number; body: unknown; headers: Record<string, string>; ended?: Buffer } & Record<string, unknown>;
function response() {
  const res: Res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.end = (buf?: Buffer) => { res.ended = buf; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  return res;
}

function request(action: string, device: string, { method = 'GET', body, query = {} }: { method?: string; body?: unknown; query?: Record<string, string> } = {}) {
  return {
    method,
    query: { action, ...query },
    body,
    headers: { 'x-app-version': '1.6.0', 'x-device-id': HASH[device], authorization: `Bearer ${device}` },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

// Supabase: пользователь по токену, ПК по хешу, права аккаунта, пункты аккаунта.
function mockSupabase({ ent = { plan: 'standard', device_limit: 2, addons: { mirror_1: future } } as Record<string, unknown>, user = USER } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    let body: unknown = null;
    if (url.includes('consume_api_rate_limit')) body = true;
    else if (url.includes('/auth/v1/user')) body = { id: user, email: 'owner@test.ru' };
    else if (url.includes('app_devices?')) {
      const id = Object.keys(HASH).find(k => url.includes(HASH[k]));
      body = id ? [{ id, name: id === WORK ? 'Рабочий' : 'Домашний', last_seen_at: new Date().toISOString() }] : [];
    } else if (url.includes('rpc/app_entitlements')) body = ent;
    else if (url.includes('site_settings')) body = [];
    else if (url.includes('app_points?user_id')) body = [{ wb_point_id: 900001 }];
    else return new Response(JSON.stringify({ message: 'unexpected ' + url }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

async function call(action: string, device: string, opts: Parameters<typeof request>[2] = {}) {
  const res = response();
  await handler(request(action, device, opts), res);
  return res;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  delete process.env.APP_UNLIMITED_USER_IDS;
  relay.resetForTests();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Рабочий ПК отметился и ждёт заданий (долгий запрос возвращаем сразу — время ненастоящее).
async function workOnline(points = [{ wb: '900001', name: 'ПВЗ', live: true, rows: 10, history: 500 }]) {
  const pending = call('relay-inbox', WORK, { method: 'POST', body: { name: 'Рабочий', points } });
  await vi.advanceTimersByTimeAsync(26_000);
  return pending;
}

describe('загрузка с другого ПК', () => {
  it('видно рабочий ПК и его пункты, себя в списке нет', async () => {
    mockSupabase();
    await workOnline();
    const res = await call('relay-peers', HOME);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ devices: [{ id: WORK, name: 'Рабочий', online: true, points: [{ wb: '900001', history: 500 }] }] });
    const self = await call('relay-peers', WORK);
    expect((self.body as { devices: unknown[] }).devices).toEqual([]);
  });

  it('без услуги — 403, ничего не создаётся', async () => {
    mockSupabase({ ent: { plan: 'standard', device_limit: 2, addons: {} } });
    await workOnline();
    const res = await call('relay-ask', HOME, { method: 'POST', body: { wb: '900001', source: WORK, kind: 'history' } });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'MIRROR_REQUIRED' });
  });

  it('рабочий ПК не в сети — offline, а не ошибка', async () => {
    mockSupabase();
    const res = await call('relay-ask', HOME, { method: 'POST', body: { wb: '900001', source: WORK, kind: 'current' } });
    expect(res.body).toMatchObject({ offline: true, seenAt: null });
  });

  it('пункта нет на том ПК — 404', async () => {
    mockSupabase();
    await workOnline([{ wb: '900002', name: 'Другой', live: true, rows: 1, history: 1 }]);
    const res = await call('relay-ask', HOME, { method: 'POST', body: { wb: '900001', source: WORK, kind: 'current' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ code: 'POINT_NOT_ON_SOURCE' });
  });

  it('полный путь: ask → задание источнику → куски → получатель забирает → ack удаляет', async () => {
    mockSupabase();
    await workOnline();
    const asked = await call('relay-ask', HOME, { method: 'POST', body: { wb: '900001', source: WORK, kind: 'history', since: { goods: 5 } } });
    const job = (asked.body as { job: string }).job;
    expect(job).toMatch(/^[0-9a-f-]{36}$/);

    // источник получает задание сразу
    const inbox = await call('relay-inbox', WORK, { method: 'POST', body: { points: [{ wb: '900001' }] } });
    expect(inbox.body).toMatchObject({ jobs: [{ id: job, wb: '900001', kind: 'history', since: { goods: 5 } }] });

    // получатель ждёт первый кусок, источник его кладёт
    const waiting = call('relay-get', HOME, { query: { job, idx: '0' } });
    const put0 = await call('relay-put', WORK, { method: 'POST', query: { job, idx: '0', last: '0' }, body: Buffer.from('часть-1') });
    expect(put0.statusCode).toBe(200);
    const got0 = await waiting;
    expect(got0.ended?.toString()).toBe('часть-1');
    expect(got0.headers['X-Relay-Last']).toBe('0');

    await call('relay-put', WORK, { method: 'POST', query: { job, idx: '1', last: '1' }, body: Buffer.from('часть-2') });
    const got1 = await call('relay-get', HOME, { query: { job, idx: '1' } });
    expect(got1.ended?.toString()).toBe('часть-2');
    expect(got1.headers['X-Relay-Last']).toBe('1');

    // рабочий ПК не может читать чужие задания, домашний — класть в них
    expect((await call('relay-get', WORK, { query: { job, idx: '0' } })).statusCode).toBe(404);
    expect((await call('relay-put', HOME, { method: 'POST', query: { job, idx: '2' }, body: Buffer.from('x') })).statusCode).toBe(404);

    await call('relay-ack', HOME, { method: 'POST', query: { job } });
    const gone = await call('relay-get', HOME, { query: { job, idx: '0' } });
    expect(gone.statusCode).toBe(404);
    expect(gone.body).toMatchObject({ code: 'JOB_GONE' });
  });

  it('ошибка источника доходит до получателя', async () => {
    mockSupabase();
    await workOnline();
    const job = ((await call('relay-ask', HOME, { method: 'POST', body: { wb: '900001', source: WORK, kind: 'current' } })).body as { job: string }).job;
    await call('relay-put', WORK, { method: 'POST', query: { job, error: 'Нет базы WB' } });
    const got = await call('relay-get', HOME, { query: { job, idx: '0' } });
    expect(got.body).toEqual({ error: 'Нет базы WB' });
  });

  it('незабранное удаляется через 30 минут', async () => {
    mockSupabase();
    await workOnline();
    const job = ((await call('relay-ask', HOME, { method: 'POST', body: { wb: '900001', source: WORK, kind: 'current' } })).body as { job: string }).job;
    await call('relay-put', WORK, { method: 'POST', query: { job, idx: '0', last: '1' }, body: Buffer.from('x') });
    relay.sweep(Date.now() + relay.JOB_TTL_MS + 1000);
    expect((await call('relay-get', HOME, { query: { job, idx: '0' } })).statusCode).toBe(404);
  });

  it('ПК другого аккаунта не видит чужих ПК', async () => {
    mockSupabase();
    await workOnline();
    mockSupabase({ user: OTHER_USER });
    const res = await call('relay-peers', HOME);
    expect((res.body as { devices: unknown[] }).devices).toEqual([]);
  });
});
