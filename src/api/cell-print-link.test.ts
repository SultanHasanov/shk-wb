import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/cell-print.js') as Handler;

const DEVICE = 'a'.repeat(64);

function response() {
  const res: { statusCode: number; body: any } & Record<string, any> = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.end = () => res;
  res.setHeader = () => {};
  return res;
}

function linkReq(body: Record<string, unknown>, sub = 'link', method = 'POST') {
  return {
    method,
    query: { action: 'account', sub },
    body: { appVersion: '2.2.0', deviceHash: DEVICE, ...body },
    headers: { authorization: 'Bearer tkn' },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

// Мок Supabase: маршрутизация по пути. rpc-ответы задаёт каждый тест.
type Reply = { status?: number; body: unknown };
function mock(routes: Record<string, Reply | ((body: any) => Reply)>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1' }), { status: 200 });
    if (url.includes('consume_api_rate_limit')) return new Response('true', { status: 200 });
    const key = Object.keys(routes).find(k => url.includes(k));
    if (key) {
      const r = routes[key];
      const hit = typeof r === 'function' ? r(init.body ? JSON.parse(String(init.body)) : {}) : r;
      return new Response(JSON.stringify(hit.body), { status: hit.status || 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'unexpected ' + url }), { status: 404 });
  }));
}

const activated = { body: { active: true, expiresAt: '2027-01-01T00:00:00Z', deviceLimit: 2, devicesUsed: 1, marketplaceScope: 'wb', serverTime: 'now' } };

describe('привязка «Печати ячеек» к аккаунту', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
    process.env.SUPABASE_SECRET_KEY = 'secret';
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('отклоняет старые версии программы', async () => {
    mock({});
    const res = response();
    await handler(linkReq({ appVersion: '1.4.0' }), res);
    expect(res.statusCode).toBe(426);
    expect(res.body.code).toBe('UPDATE_REQUIRED');
  });

  it('переданный ключ активирует напрямую', async () => {
    const calls: any[] = [];
    mock({
      cell_print_register_device: { body: { revoked: false } },
      activate_cell_print_license: (b) => { calls.push(b); return activated; },
    });
    const res = response();
    await handler(linkReq({ key: 'cp-aaaa-bbbb-cccc' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('linked');
    expect(res.body.key).toBe('CP-AAAA-BBBB-CCCC');
    // ключ нормализован в верхний регистр и передан владельцем
    expect(calls[0]).toMatchObject({ p_key: 'CP-AAAA-BBBB-CCCC', p_user: 'u1' });
  });

  it('без ключа активирует единственную лицензию со свободным местом', async () => {
    mock({
      cell_print_register_device: { body: { revoked: false } },
      cell_print_link_candidates: { body: [{ key: 'CP-ONLY-ONE0-FREE', scope: 'wb', devicesUsed: 0, deviceLimit: 1, thisDevice: false }] },
      activate_cell_print_license: activated,
    });
    const res = response();
    await handler(linkReq({}), res);
    expect(res.body.status).toBe('linked');
    expect(res.body.key).toBe('CP-ONLY-ONE0-FREE');
  });

  it('предпочитает лицензию, уже активную на этом ПК', async () => {
    const calls: any[] = [];
    mock({
      cell_print_register_device: { body: { revoked: false } },
      cell_print_link_candidates: { body: [
        { key: 'CP-FREE-FREE-FREE', scope: 'wb', devicesUsed: 0, deviceLimit: 2, thisDevice: false },
        { key: 'CP-THIS-DEVI-CE00', scope: 'wb', devicesUsed: 1, deviceLimit: 2, thisDevice: true },
      ] },
      activate_cell_print_license: (b) => { calls.push(b); return activated; },
    });
    const res = response();
    await handler(linkReq({}), res);
    expect(res.body.status).toBe('linked');
    expect(calls[0].p_key).toBe('CP-THIS-DEVI-CE00');
  });

  it('при нескольких свободных просит выбрать (маскированный список)', async () => {
    mock({
      cell_print_register_device: { body: { revoked: false } },
      cell_print_link_candidates: { body: [
        { key: 'CP-AAAA-AAAA-ZZZZ', scope: 'wb', devicesUsed: 0, deviceLimit: 2, thisDevice: false },
        { key: 'CP-BBBB-BBBB-YYYY', scope: 'ozon', devicesUsed: 1, deviceLimit: 3, thisDevice: false },
      ] },
    });
    const res = response();
    await handler(linkReq({}), res);
    expect(res.body.status).toBe('choose');
    expect(res.body.options.map((o: any) => o.label)).toEqual(['CP-••••-••••-ZZZZ', 'CP-••••-••••-YYYY']);
  });

  it('все места заняты → full, ключей нет → none со ссылкой на покупку', async () => {
    mock({
      cell_print_register_device: { body: { revoked: false } },
      cell_print_link_candidates: { body: [{ key: 'CP-FULL-FULL-FULL', scope: 'wb', devicesUsed: 2, deviceLimit: 2, thisDevice: false }] },
    });
    let res = response();
    await handler(linkReq({}), res);
    expect(res.body.status).toBe('full');

    mock({ cell_print_register_device: { body: { revoked: false } }, cell_print_link_candidates: { body: [] } });
    res = response();
    await handler(linkReq({}), res);
    expect(res.body.status).toBe('none');
    expect(res.body.buyUrl).toContain('/cell-print#key');
  });

  it('чужой ключ → KEY_OWNED', async () => {
    mock({
      cell_print_register_device: { body: { revoked: false } },
      activate_cell_print_license: { status: 400, body: { message: 'Not owner' } },
    });
    const res = response();
    await handler(linkReq({ key: 'CP-SOME-ONEE-LSE0' }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('KEY_OWNED');
  });

  it('замок require_account для нового ПК → ACCOUNT_REQUIRED', async () => {
    mock({
      cell_print_register_device: { body: { revoked: false } },
      activate_cell_print_license: { status: 400, body: { message: 'Account required' } },
    });
    const res = response();
    await handler(linkReq({ key: 'CP-LOCK-LOCK-LOCK' }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_REQUIRED');
  });

  it('отозванный ПК → DEVICE_REVOKED', async () => {
    mock({ cell_print_register_device: { body: { revoked: true } } });
    const res = response();
    await handler(linkReq({}), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('DEVICE_REVOKED');
  });

  it('список и отзыв устройств', async () => {
    mock({
      cell_print_devices_list: { body: [{ deviceHash: DEVICE, name: 'ПК Стол', appVersion: '2.2.0', lastSeenAt: 'x', revokedAt: null }] },
      cell_print_revoke_device: { body: { ok: true, freed: 1 } },
    });
    let res = response();
    await handler(linkReq({}, 'devices', 'GET'), res);
    expect(res.body.devices).toHaveLength(1);

    res = response();
    await handler(linkReq({ deviceHash: DEVICE }, 'revoke', 'POST'), res);
    expect(res.body.ok).toBe(true);
  });

  it('анонимная активация (action=activate) по-прежнему без аккаунта', async () => {
    const calls: any[] = [];
    mock({ activate_cell_print_license: (b) => { calls.push(b); return activated; } });
    const res = response();
    await handler({
      method: 'POST', query: { action: 'activate' },
      body: { key: 'CP-AAAA-BBBB-CCCC', deviceHash: DEVICE, appVersion: '2.1.0' },
      headers: {}, socket: { remoteAddress: '127.0.0.1' },
    }, res);
    expect(res.statusCode).toBe(200);
    // старый путь не передаёт владельца — активация остаётся анонимной
    expect(calls[0]).not.toHaveProperty('p_user');
  });

  const session = { access_token: 'at', refresh_token: 'rt', expires_in: 3600, expires_at: 9999, user: { id: 'u1' } };

  it('вход по паролю с deviceHash регистрирует ПК в реестре аккаунта', async () => {
    const calls: any[] = [];
    mock({
      'token?grant_type=password': { body: session },
      cell_print_register_device: (b) => { calls.push(b); return { body: { revoked: false } }; },
    });
    const res = response();
    await handler({
      method: 'POST', query: { action: 'login' },
      body: { email: 'pvz@shk.ru', password: 'secret12', deviceHash: DEVICE, deviceName: 'ПК Стол', appVersion: '2.2.0' },
      headers: {}, socket: { remoteAddress: '127.0.0.1' },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.session.access_token).toBe('at');
    expect(calls[0]).toMatchObject({ p_user: 'u1', p_name: 'ПК Стол', p_version: '2.2.0' });
  });

  it('старый клиент без deviceHash входит как раньше, ПК не регистрируется', async () => {
    const calls: any[] = [];
    mock({
      'token?grant_type=password': { body: session },
      cell_print_register_device: (b) => { calls.push(b); return { body: { revoked: false } }; },
    });
    const res = response();
    await handler({
      method: 'POST', query: { action: 'login' },
      body: { email: 'pvz@shk.ru', password: 'secret12' },
      headers: {}, socket: { remoteAddress: '127.0.0.1' },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('refresh с deviceHash отозванного ПК → 401 DEVICE_REVOKED', async () => {
    mock({
      'token?grant_type=refresh_token': { body: session },
      cell_print_register_device: { body: { revoked: true } },
    });
    const res = response();
    await handler({
      method: 'POST', query: { action: 'refresh' },
      body: { refreshToken: 'rt', deviceHash: DEVICE },
      headers: {}, socket: { remoteAddress: '127.0.0.1' },
    }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('DEVICE_REVOKED');
  });
});
