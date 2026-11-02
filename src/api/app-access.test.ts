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
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
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
    mockSupabase(url => {
      if (url.includes('app_devices?user_id=')) return { body: [deviceRow([], { role: 'owner' })] };
    });
    const res = response();
    await handler(request('device', { method: 'PATCH', body: { denied: [] }, query: { id: DEV_ID } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('компьютер владельца меняет доступ другому ПК из программы', async () => {
    let patched: Record<string, unknown> | null = null;
    mockSupabase((url, init) => {
      if (url.includes('app_devices?user_id=')) return { body: [deviceRow([], { role: 'owner' })] };
      if (url.includes(`app_devices?id=eq.${OTHER_ID}`) && init.method === 'PATCH') { patched = JSON.parse(String(init.body)); return { body: [{ id: OTHER_ID, denied: patched!.denied }] }; }
    });
    const res = response();
    await handler(request('device', { method: 'PATCH', body: { denied: ['act.pay'] }, query: { id: OTHER_ID } }), res);
    expect(res.statusCode).toBe(200);
    expect(patched).toMatchObject({ denied: ['act.pay'] });
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

  it('ПК сотрудника получает ссылку в кабинет без автовхода', async () => {
    mockSupabase(url => {
      if (url.includes('app_devices?user_id=')) return { body: [deviceRow(['act.account'])] };
    });
    const res = response();
    await handler(request('site-link', { method: 'POST', body: { next: '/cabinet/access?device=' + DEV_ID } }), res);
    expect(res.statusCode).toBe(200);
    const url = (res.body as { url: string }).url;
    expect(url).toContain('/cabinet/access?device=' + DEV_ID);
    expect(url).not.toContain('th=');
  });

  it('ПК без права менять сотрудников не перезаписывает общий график, но и не получает ошибку', async () => {
    const calls: string[] = [];
    mockSupabase(url => {
      calls.push(url);
      if (url.includes('app_devices?user_id=')) return { body: [deviceRow(['act.staff_edit'])] };
    });
    const res = response();
    await handler(request('docs', { method: 'PUT', body: { key: 'schedule', point: '123', base: 7, data: { rates: 1 } } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ version: 7, ignored: true });
    expect(calls.some(u => u.includes('app_doc_put'))).toBe(false);
  });

  it('токен Ivideon не уходит на ПК, где закрыто «Видео по ШК»', async () => {
    mockSupabase(url => {
      if (url.includes('app_devices?user_id=')) return { body: [deviceRow(['video'])] };
    });
    const sync = require('../../server/_app-sync.js') as { docsGet: (...a: unknown[]) => Promise<Record<string, unknown>> };
    vi.spyOn(sync, 'docsGet').mockResolvedValue({ ivideon: { version: 1, data: 'tok' }, telegram: { version: 1, data: 'tg' } });
    const res = response();
    await handler(request('secrets'), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { docs: Record<string, unknown> }).docs).not.toHaveProperty('ivideon');
    expect((res.body as { docs: Record<string, unknown> }).docs).toHaveProperty('telegram');
  });
});

describe('роли компьютеров: владелец и сотрудник', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
    process.env.SUPABASE_SECRET_KEY = 'secret';
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const work = () => deviceRow([], { role: 'work' });

  it('аренда несёт роль ПК; роль не назначена — null', async () => {
    mockSupabase(url => { if (url.includes('app_devices?user_id=')) return { body: [work()] }; });
    expect((await account.leaseRights(request('lease', { method: 'POST' }))).role).toBe('work');
    vi.unstubAllGlobals();
    mockSupabase(url => { if (url.includes('app_devices?user_id=')) return { body: [deviceRow([])] }; });
    expect((await account.leaseRights(request('lease', { method: 'POST' }))).role).toBeNull();
  });

  it('компьютер сотрудника не видит других ПК и не загружает базы', async () => {
    mockSupabase(url => {
      if (url.includes('app_devices?user_id=') && url.includes('device_hash=eq.')) return { body: [work()] };
      if (url.includes('app_devices?user_id=')) return { body: [{ ...work(), device_hash: DEVICE }, { ...work(), id: OTHER_ID, device_hash: 'b'.repeat(64), role: 'owner' }] };
      if (url.includes('user_profiles') || url.includes('user_telegram') || url.includes('license_keys') || url.includes('sticker_access_codes') || url.includes('app_points')) return { body: [] };
    });
    const peers = response();
    await handler(request('relay-peers'), peers);
    expect(peers.statusCode).toBe(403);
    expect(peers.body).toMatchObject({ code: 'WORK_PC' });
    const ask = response();
    await handler(request('relay-ask', { method: 'POST', body: { wb: '123', source: OTHER_ID, kind: 'current' } }), ask);
    expect(ask.statusCode).toBe(403);
    const me = response();
    await handler(request('me'), me);
    expect(me.statusCode).toBe(200);
    const devices = (me.body as { devices: { id: string; current: boolean }[] }).devices;
    expect(devices).toHaveLength(1);
    expect(devices[0].current).toBe(true);
  });

  it('компьютер сотрудника раздаёт свою базу (inbox открыт)', async () => {
    mockSupabase(url => { if (url.includes('app_devices?user_id=')) return { body: [work()] }; });
    const relay = require('../../server/_app-relay.js') as { inbox: (...a: unknown[]) => Promise<unknown> };
    vi.spyOn(relay, 'inbox').mockResolvedValue({ jobs: [] });
    const res = response();
    await handler(request('relay-inbox', { method: 'POST', body: { points: [] } }), res);
    expect(res.statusCode).toBe(200);
  });

  it('с компьютера сотрудника нельзя отключать ПК, менять пароль, платить, отключать пункт и получать автовход', async () => {
    mockSupabase(url => { if (url.includes('app_devices?user_id=')) return { body: [work()] }; });
    const cases: [string, { method?: string; body?: unknown; query?: Record<string, string> }][] = [
      ['device', { method: 'DELETE', query: { id: OTHER_ID } }],
      ['password-change', { method: 'POST', body: { current: 'a', password: 'b' } }],
      ['logout-others', { method: 'POST' }],
      ['pay', { method: 'POST', body: { kind: 'wallet', amount: 500, accepted: true } }],
      ['point', { method: 'DELETE', query: { id: OTHER_ID } }],
    ];
    for (const [action, init] of cases) {
      const res = response();
      await handler(request(action, init), res);
      expect(res.statusCode, action).toBe(403);
      expect(res.body, action).toMatchObject({ code: 'WORK_PC' });
    }
    const link = response();
    await handler(request('site-link', { method: 'POST', body: { next: '/cabinet' } }), link);
    expect((link.body as { url: string }).url).not.toContain('th=');
  });

  it('компьютер сотрудника переименовывает только себя', async () => {
    mockSupabase((url, init) => {
      if (url.includes('app_devices?user_id=')) return { body: [work()] };
      if (url.includes(`app_devices?id=eq.${DEV_ID}`) && init.method === 'PATCH') return { body: [{ id: DEV_ID, name: 'Стойка' }] };
    });
    const other = response();
    await handler(request('device', { method: 'PATCH', body: { name: 'X' }, query: { id: OTHER_ID } }), other);
    expect(other.statusCode).toBe(403);
    const self = response();
    await handler(request('device', { method: 'PATCH', body: { name: 'Стойка' }, query: { id: DEV_ID } }), self);
    expect(self.statusCode).toBe(200);
  });

  it('«это компьютер владельца» с ПК сотрудника — только с паролем аккаунта', async () => {
    let patched: Record<string, unknown> | null = null;
    mockSupabase((url, init) => {
      if (url.includes('app_devices?user_id=')) return { body: [work()] };
      if (url.includes('token?grant_type=password')) {
        const b = JSON.parse(String(init.body)) as { password: string };
        return b.password === 'secret1' ? { body: { access_token: 't', user: { id: 'u1' } } } : { status: 400, body: { error: 'invalid' } };
      }
      if (url.includes(`app_devices?id=eq.${DEV_ID}`) && init.method === 'PATCH') { patched = JSON.parse(String(init.body)); return { body: [{ id: DEV_ID, role: 'owner', denied: [] }] }; }
    });
    const bad = response();
    await handler(request('device', { method: 'PATCH', body: { role: 'owner', password: 'wrong' }, query: { id: DEV_ID } }), bad);
    expect(bad.statusCode).toBe(401);
    expect(patched).toBeNull();
    const ok = response();
    await handler(request('device', { method: 'PATCH', body: { role: 'owner', password: 'secret1' }, query: { id: DEV_ID } }), ok);
    expect(ok.statusCode).toBe(200);
    expect(patched).toMatchObject({ role: 'owner', denied: [] });
  });

  it('компьютер владельца делает другой ПК компьютером сотрудника с шаблоном, но не себя', async () => {
    let patched: Record<string, unknown> | null = null;
    mockSupabase((url, init) => {
      if (url.includes('app_devices?user_id=')) return { body: [deviceRow([], { role: 'owner' })] };
      if (url.includes(`app_devices?id=eq.${OTHER_ID}`) && init.method === 'PATCH') { patched = JSON.parse(String(init.body)); return { body: [{ id: OTHER_ID, role: 'work', denied: patched!.denied }] }; }
    });
    const self = response();
    await handler(request('device', { method: 'PATCH', body: { role: 'work' }, query: { id: DEV_ID } }), self);
    expect(self.statusCode).toBe(400);
    const res = response();
    await handler(request('device', { method: 'PATCH', body: { role: 'work', denied: ['act.pay', 'hack'] }, query: { id: OTHER_ID } }), res);
    expect(res.statusCode).toBe(200);
    expect(patched).toMatchObject({ role: 'work', denied: ['act.pay'] });
    const none = response();
    await handler(request('device', { method: 'PATCH', body: { role: 'work' }, query: { id: OTHER_ID } }), none);
    expect(none.statusCode).toBe(200);
    const preset = (require('../../server/_app-permissions.js') as { WORK_DENIED: readonly string[] }).WORK_DENIED;
    expect([...((patched as unknown as Record<string, unknown>).denied as string[])].sort()).toEqual([...preset].sort());
    expect(permissionPresets(t).find(p => p.id === 'staff')!.denied.slice().sort()).toEqual([...preset].sort());
  });

  it('кабинет назначает роль без пароля', async () => {
    let patched: Record<string, unknown> | null = null;
    mockSupabase((url, init) => {
      if (url.includes(`app_devices?id=eq.${OTHER_ID}`) && init.method === 'PATCH') { patched = JSON.parse(String(init.body)); return { body: [{ id: OTHER_ID, role: 'owner', denied: [] }] }; }
    });
    const res = response();
    await handler(request('device', { method: 'PATCH', body: { role: 'owner' }, headers: { 'x-device-id': undefined }, query: { id: OTHER_ID } }), res);
    expect(res.statusCode).toBe(200);
    expect(patched).toMatchObject({ role: 'owner' });
  });
});
