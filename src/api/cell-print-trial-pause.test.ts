import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/cell-print.js') as Handler;

const DEVICE = 'b'.repeat(64);

function response() {
  const res: { statusCode: number; body: any } & Record<string, any> = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.end = () => res;
  res.setHeader = () => {};
  return res;
}

function req(action: string, body: Record<string, unknown> = {}, method = 'POST', query: Record<string, string> = {}) {
  return {
    method,
    query: { action, ...query },
    body,
    headers: { authorization: 'Bearer tkn', host: 'shk-wb.ru' },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

type Reply = { status?: number; body: unknown };
function mock(routes: Record<string, Reply | ((body: any, url: string) => Reply)>) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1', email: 'a@b.ru' }), { status: 200 });
    if (url.includes('consume_api_rate_limit')) return new Response('true', { status: 200 });
    const key = Object.keys(routes).find(k => url.includes(k));
    if (key) {
      const r = routes[key];
      const hit = typeof r === 'function' ? r(body, url) : r;
      return new Response(JSON.stringify(hit.body), { status: hit.status || 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'unexpected ' + url }), { status: 404 });
  }));
  return calls;
}

const pgError = (message: string) => ({ status: 400, body: { code: 'P0001', message } });

describe('«ПВЗ Принт»: пробный период, пауза, цены', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
    process.env.SUPABASE_SECRET_KEY = 'secret';
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('цены отдаются без входа', async () => {
    mock({});
    const res = response();
    await handler({ ...req('prices', {}, 'GET'), headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.prices[30][1]).toBe(249);
    expect(res.body.bothFactor).toBe(1.8);
  });

  it('пробный период выдаёт ключ этому ПК', async () => {
    const calls = mock({ cell_print_start_trial: { body: { key: 'CP-TTTT-1111-2222', expiresAt: '2026-11-15T00:00:00Z' } } });
    const res = response();
    await handler(req('trial', { deviceHash: DEVICE, deviceName: 'ПК' }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.key).toBe('CP-TTTT-1111-2222');
    expect(calls.find(c => c.url.includes('cell_print_start_trial'))?.body).toMatchObject({ p_user: 'u1', p_device_hash: DEVICE });
  });

  it('повторный пробный период — 409 TRIAL_USED', async () => {
    mock({ cell_print_start_trial: pgError('Trial used') });
    const res = response();
    await handler(req('trial', { deviceHash: DEVICE }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TRIAL_USED');
  });

  it('пробный период без отпечатка ПК — 400', async () => {
    mock({});
    const res = response();
    await handler(req('trial', {}), res);
    expect(res.statusCode).toBe(400);
  });

  it('пауза: третья в месяце — 409 PAUSE_LIMIT', async () => {
    mock({ cell_print_pause: pgError('Pause limit') });
    const res = response();
    await handler(req('pause', { key: 'cp-aaaa-bbbb-cccc' }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('PAUSE_LIMIT');
  });

  it('пауза пробного ключа запрещена', async () => {
    mock({ cell_print_pause: pgError('Not pausable: trial') });
    const res = response();
    await handler(req('pause', { key: 'CP-AAAA-BBBB-CCCC' }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('NOT_PAUSABLE');
  });

  it('пауза и возобновление передают ключ и пользователя', async () => {
    const calls = mock({
      cell_print_pause: { body: { pauseUntil: '2026-11-22T00:00:00Z', pausesLeft: 1, expiresAt: '2026-12-01T00:00:00Z' } },
      cell_print_resume: { body: { pausesLeft: 1, expiresAt: '2026-12-03T00:00:00Z' } },
    });
    const res = response();
    await handler(req('pause', { key: 'CP-AAAA-BBBB-CCCC' }), res);
    expect(res.body.pausesLeft).toBe(1);
    const res2 = response();
    await handler(req('resume', { key: 'CP-AAAA-BBBB-CCCC' }), res2);
    expect(res2.body.expiresAt).toBe('2026-12-03T00:00:00Z');
    expect(calls.find(c => c.url.includes('cell_print_resume'))?.body).toEqual({ p_user: 'u1', p_key: 'CP-AAAA-BBBB-CCCC' });
  });

  it('активация на паузе — 403 PAUSED с датой', async () => {
    mock({ activate_cell_print_license: pgError('License paused until 2026-11-22T10:00:00Z') });
    const res = response();
    await handler(req('activate', { key: 'CP-AAAA-BBBB-CCCC', deviceHash: DEVICE, appVersion: '2.2.0' }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('PAUSED');
    expect(res.body.pausedUntil).toBe('2026-11-22T10:00:00Z');
    expect(res.body.error).toContain('22.11');
  });

  it('список ключей: отозванные ПК не занимают место, видны пробный и пауза', async () => {
    const thisMonth = new Date().toISOString();
    mock({
      cell_print_licenses: { body: [{
        id: 7, key: 'CP-AAAA-BBBB-CCCC', marketplace_scope: 'both', expires_at: '2027-01-01T00:00:00Z', duration_days: 30,
        device_limit: 2, active: true, source: 'payment', paused_at: thisMonth, pause_until: '2099-01-01T00:00:00Z',
        cell_print_activations: [{ device_hash: DEVICE, revoked_at: null }, { device_hash: 'c'.repeat(64), revoked_at: thisMonth }],
        cell_print_pauses: [{ started_at: thisMonth }],
      }] },
    });
    const res = response();
    await handler(req('keys', {}, 'GET', { device: DEVICE }), res);
    const item = res.body.items[0];
    expect(item).toMatchObject({ devicesUsed: 1, thisDevice: true, trial: false, pausesLeft: 1 });
    expect(item.pauseUntil).toBe('2099-01-01T00:00:00Z');
  });

  it('оплата из программы идёт в общий заказ и требует согласия с офертой', async () => {
    mock({});
    const res = response();
    await handler(req('pay', { days: 30, devices: 1, scope: 'wb', accepted: false }), res);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/оферт|услови/i);
  });

  describe('письмо об окончании пробного периода', () => {
    const cabinet = require('../../api/cabinet.js') as Handler;
    const trial = { id: 42, key: 'CP-TTTT-1111-2222', owner_user_id: 'u1', created_at: '2026-11-01T00:00:00Z', expires_at: '2026-11-08T00:00:00Z' };

    function cronMock(paidKeys: unknown[], orders: unknown[]) {
      process.env.CRON_SECRET = 'cron';
      process.env.RESEND_API_KEY = 'resend';
      process.env.RESEND_FROM_EMAIL = 'a@shk-wb.ru';
      const seen: { url: string; body: any }[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        seen.push({ url, body });
        const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.includes('source=eq.trial')) return json([trial]);
        if (url.includes('source=neq.trial')) return json(paidKeys);
        if (url.includes('payment_orders')) return json(orders);
        if (url.includes('/auth/v1/admin/users')) return json({ id: 'u1', email: 'a@b.ru' });
        if (url.includes('api.resend.com')) return json({ id: 'mail' });
        if (url.includes('in_app_notifications') || url.includes('notification_deliveries')) return json([{ id: 1 }]);
        if (url.includes('/rest/v1/rpc/')) return json(0);
        return json([]);
      }));
      return seen;
    }
    const cronReq = () => ({ method: 'GET', query: { action: 'cron' }, headers: { authorization: 'Bearer cron' }, socket: { remoteAddress: '127.0.0.1' } });

    it('шлёт письмо, если ключ не куплен, с dedupe по id пробного ключа', async () => {
      const seen = cronMock([], []);
      const res = response();
      await cabinet(cronReq(), res);
      expect(res.statusCode).toBe(200);
      const note = seen.find(c => c.url.includes('in_app_notifications') && JSON.stringify(c.body).includes('cell-trial-ended'));
      expect(JSON.stringify(note?.body)).toContain('cell-trial-ended:42');
      expect(seen.some(c => c.url.includes('api.resend.com'))).toBe(true);
    });

    it('не шлёт письмо, если у владельца есть купленный ключ', async () => {
      const seen = cronMock([{ id: 7 }], []);
      await cabinet(cronReq(), response());
      expect(seen.some(c => JSON.stringify(c.body).includes('cell-trial-ended'))).toBe(false);
    });

    it('не шлёт письмо, если есть оплаченный заказ после пробного', async () => {
      const seen = cronMock([], [{ id: 'o1' }]);
      await cabinet(cronReq(), response());
      expect(seen.some(c => JSON.stringify(c.body).includes('cell-trial-ended'))).toBe(false);
    });
  });

  it('регистрация в программе требует отпечаток ПК и почту', async () => {
    mock({});
    const res = response();
    await handler(req('signup', { email: 'a@b.ru', password: 'abc12345' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('DEVICE_REQUIRED');
    const res2 = response();
    await handler(req('signup', { email: 'плохо', password: 'abc12345', deviceHash: DEVICE }), res2);
    expect(res2.statusCode).toBe(400);
  });
});
