import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionActions, permissionPresets, permissionSections } from '../lib/app-permissions';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/app.js') as Handler;
const account = require('../../server/_app-account.js') as { leaseRights: (req: unknown) => Promise<Record<string, unknown>> };
const permissions = require('../../server/_app-permissions.js') as { KEYS: Set<string>; cleanDenied: (l: unknown) => string[] };

const DEVICE = 'a'.repeat(64);
const DEV_ID = '11111111-1111-4111-8111-111111111111';
const t = (ru: string) => ru;

function response() {
  const res: { statusCode: number; body: unknown } & Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.end = () => res;
  res.setHeader = () => {};
  return res;
}

function request(action: string, { method = 'GET', body, headers = {}, query = {} }: { method?: string; body?: unknown; headers?: Record<string, string | undefined>; query?: Record<string, string> } = {}) {
  const h: Record<string, string> = { 'x-app-version': '1.8.0', 'x-device-id': DEVICE, authorization: 'Bearer t' };
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete h[k];
    else h[k] = v;
  }
  return { method, query: { action, ...query }, body, headers: h, socket: { remoteAddress: '127.0.0.1' } };
}

type Route = (url: string, init: RequestInit) => { status?: number; body: unknown } | undefined;
function mockSupabase(route: Route) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.includes('consume_api_rate_limit')) return new Response('true', { status: 200 });
    const hit = route(url, init)
      || (url.endsWith('/auth/v1/user') ? { body: { id: 'u1', email: 'a@b.c' } } : undefined)
      || (url.includes('rpc/app_entitlements') ? { body: { plan: 'pro', device_limit: 4, packs_left: 0, addons: {} } } : undefined)
      || (url.includes('site_settings') ? { body: [] } : undefined)
      || { status: 404, body: { message: 'unexpected ' + url } };
    return new Response(JSON.stringify(hit.body), { status: hit.status || 200, headers: { 'content-type': 'application/json' } });
  }));
}

const deviceRow = (denied: string[], extra: Record<string, unknown> = {}) => ({
  id: DEV_ID, name: 'Касса', last_seen_at: new Date().toISOString(), denied, point_wb: '123', ...extra,
});

describe('доступ сотрудников: справочник', () => {
  it('ключи кабинета совпадают с серверными', () => {
    const site = [...permissionSections(t), ...permissionActions(t)].map(p => p.key).sort();
    expect(site).toEqual([...permissions.KEYS].sort());
  });
  it('шаблоны состоят только из известных ключей', () => {
    for (const p of permissionPresets(t)) expect(permissions.cleanDenied(p.denied)).toHaveLength(p.denied.length);
  });
  it('неизвестные ключи и повторы отбрасываются', () => {
    expect(permissions.cleanDenied(['act.pay', 'x', 'act.pay', 'staff'])).toEqual(['staff', 'act.pay']);
  });
});

describe('доступ сотрудников: сервер', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
    process.env.SUPABASE_SECRET_KEY = 'secret';
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('аренда: закрытые разделы вычитаются из тарифа, весь список уходит программе', async () => {
    mockSupabase(url => {
      if (url.includes('app_devices?user_id=')) return { body: [deviceRow(['staff', 'act.payroll'])] };
    });
    const rights = await account.leaseRights(request('lease', { method: 'POST' }));
    expect(rights.features).not.toContain('staff');
    expect(rights.features).toContain('cells');
    expect(rights.denied).toEqual(['staff', 'act.payroll']);
  });

  it('аренда запоминает пункт ПК из X-Point-Wb', async () => {
    let patched: Record<string, unknown> | null = null;
    mockSupabase((url, init) => {
      if (url.includes('app_devices?user_id=')) return { body: [deviceRow([], { point_wb: null })] };
      if (url.includes(`app_devices?id=eq.${DEV_ID}`) && init.method === 'PATCH') { patched = JSON.parse(String(init.body)); return { body: [] }; }
    });
    await account.leaseRights(request('lease', { method: 'POST', headers: { 'x-point-wb': '98765' } }));
    expect(patched).toEqual({ point_wb: '98765' });
  });

  it('кабинет сохраняет доступ (без X-Device-Id), лишние ключи отбрасываются', async () => {
    let patched: Record<string, unknown> | null = null;
    mockSupabase((url, init) => {
      if (url.includes(`app_devices?id=eq.${DEV_ID}`) && init.method === 'PATCH') {
        expect(url).toContain('user_id=eq.u1');
        patched = JSON.parse(String(init.body));
        return { body: [{ id: DEV_ID, denied: patched!.denied }] };
      }
    });
    const res = response();
    await handler(request('device', { method: 'PATCH', body: { denied: ['act.pay', 'hack'] }, headers: { 'x-device-id': undefined }, query: { id: DEV_ID } }), res);
    expect(res.statusCode).toBe(200);
    expect(patched).toMatchObject({ denied: ['act.pay'] });
  });

  it('программа не может сама поменять себе доступ', async () => {
    mockSupabase(() => undefined);
    const res = response();
    await handler(request('device', { method: 'PATCH', body: { denied: [] }, query: { id: DEV_ID } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('QR-код клиента закрыт владельцем — 403 DENIED_BY_OWNER', async () => {
    mockSupabase(url => {
      if (url.includes('app_devices?user_id=')) return { body: [deviceRow(['act.client_qr'])] };
    });
    const res = response();
    await handler(request('client-qr', { method: 'POST', body: { sid: '123' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'DENIED_BY_OWNER', key: 'act.client_qr' });
  });

  it('оплата закрыта владельцем — 403', async () => {
    mockSupabase(url => {
      if (url.includes('app_devices?user_id=')) return { body: [deviceRow(['act.pay'])] };
    });
    const res = response();
    await handler(request('pay', { method: 'POST', body: { kind: 'wallet', amount: 500, accepted: true } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('отключение ПК из программы закрыто без act.account', async () => {
    mockSupabase(url => {
      if (url.includes('app_devices?user_id=')) return { body: [deviceRow(['act.account'])] };
    });
    const res = response();
    await handler(request('device', { method: 'DELETE', query: { id: DEV_ID } }), res);
    expect(res.statusCode).toBe(403);
  });
});
