// Ключ устройства (ПК работает без сессии) и сообщения владельца на ПК — api/app.js,
// server/_app-account.js (issueDeviceKey/requireDeviceByKey/leaseRights), server/_app-messages.js.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/app.js') as Handler;
const relay = require('../../server/_app-relay.js') as { resetForTests: () => void; onlineIds: (u: string) => Set<string> };
const account = require('../../server/_app-account.js') as { leaseRights: (req: unknown) => Promise<{ features: string[]; via?: string; user: string | null }> };
const messages = require('../../server/_app-messages.js') as {
  EMPTY_TTL_MS: number;
  pull: (userId: string, deviceId: string) => Promise<{ id: string }[]>;
  send: (args: { userId: string; deviceId: string; text: string }) => Promise<unknown>;
  resetForTests: () => void;
};
const { enforceRateLimit } = require('../../server/_rate-limit.js') as {
  enforceRateLimit: (req: unknown, res: unknown, opts: { scope: string; limit: number; windowSeconds: number; key?: string }) => Promise<boolean>;
};

const USER = '11111111-1111-4111-8111-111111111111';
const WORK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HASH: Record<string, string> = { [HOME]: 'a'.repeat(64), [WORK]: 'b'.repeat(64) };
const future = { ends_at: '2099-01-01T00:00:00Z' };
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

type Res = { statusCode: number; body: unknown; headers: Record<string, string> } & Record<string, unknown>;
function response() {
  const res: Res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.end = () => res;
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  return res;
}

type Opts = { method?: string; body?: unknown; query?: Record<string, string>; headers?: Record<string, string>; device?: string; auth?: boolean };
function request(action: string, { method = 'GET', body, query = {}, headers = {}, device, auth = true }: Opts = {}) {
  const h: Record<string, string> = { 'x-app-version': '1.12.0', ...headers };
  if (device) h['x-device-id'] = HASH[device];
  if (auth) h.authorization = 'Bearer token';
  return { method, query: { action, ...query }, body, headers: h, socket: { remoteAddress: '127.0.0.1' } };
}
async function call(action: string, opts: Opts = {}) {
  const res = response();
  await handler(request(action, opts), res);
  return res;
}

// Состояние «базы» одного рабочего ПК: его строка app_devices и сообщения ему.
type State = { keyHash: string | null; revoked: boolean; alertSound: string | null; messages: Record<string, unknown>[]; lastSeen?: string };
let state: State;
let calls: { method: string; url: string; body: unknown }[];

function deviceRow() {
  return { id: WORK, user_id: USER, device_hash: HASH[WORK], name: 'Рабочий', last_seen_at: state.lastSeen || new Date().toISOString(), denied: [], point_wb: '900001', role: 'work', key_hash: state.keyHash, alert_sound: state.alertSound };
}

function mockSupabase() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method || 'GET';
    const parsed = init?.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body: parsed });
    let body: unknown = null;
    if (url.includes('consume_api_rate_limit')) body = true;
    else if (url.includes('/auth/v1/token')) body = { access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: USER } };
    else if (url.includes('/auth/v1/user')) body = { id: USER, email: 'owner@test.ru' };
    else if (url.includes('/auth/v1/logout')) body = {};
    else if (url.includes('rpc/app_register_device')) body = WORK;
    else if (url.includes('rpc/app_entitlements')) body = { plan: 'standard', device_limit: 2, addons: { mirror_1: future } };
    else if (url.includes('site_settings')) body = [];
    else if (url.includes('app_points?user_id')) body = [{ wb_point_id: 900001 }];
    else if (url.includes('user_telegram_identities')) body = [];
    else if (url.includes('license_keys') || url.includes('user_preferences')) body = [];
    else if (url.includes('in_app_notifications')) body = [{ id: 'n1' }];
    else if (url.includes('app_device_messages')) {
      if (method === 'POST') { const row = { id: MSG, user_id: USER, device_id: WORK, text: parsed.text, created_at: '2026-11-05T10:00:00Z', expires_at: '2099-01-01T00:00:00Z', delivered_at: null, read_at: null, answered_at: null, answer_kind: null, reply_text: null }; state.messages.push(row); body = [row]; }
      else if (method === 'PATCH') {
        const rows = state.messages.filter(m => (!/[?&]id=eq\./.test(url) || url.includes(`&id=eq.${m.id}`) || url.includes(`?id=eq.${m.id}`))
          && (!url.includes('delivered_at=is.null') || !m.delivered_at) && (!url.includes('read_at=is.null') || !m.read_at) && (!url.includes('answered_at=is.null') || !m.answered_at));
        for (const r of rows) Object.assign(r, parsed);
        body = rows;
      } else {
        body = state.messages.filter(m => (!url.includes('read_at=is.null') || !m.read_at) && (!url.includes('answered_at=is.null') || !m.answered_at));
      }
    } else if (url.includes('app_devices')) {
      if (method === 'PATCH') { Object.assign(state, { keyHash: parsed.key_hash ?? state.keyHash, revoked: parsed.revoked_at ? true : state.revoked, alertSound: 'alert_sound' in parsed ? parsed.alert_sound : state.alertSound }); body = [deviceRow()]; }
      else if (url.includes(HASH[HOME])) body = [{ id: HOME, user_id: USER, name: 'Домашний', last_seen_at: new Date().toISOString(), denied: [], role: 'owner', key_hash: null, alert_sound: null }];
      else if (url.includes('key_hash=not.is.null')) body = state.keyHash && !state.revoked ? [deviceRow()] : [];
      else body = state.revoked ? [] : [deviceRow()];
    } else if (method === 'GET') body = []; // сводка аккаунта (me) читает ещё с десяток таблиц — здесь они пустые
    else return new Response(JSON.stringify({ message: 'unexpected ' + url }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.PVZ_LEASE_PRIVATE_KEY = '';
  delete process.env.APP_UNLIMITED_USER_IDS;
  state = { keyHash: null, revoked: false, alertSound: null, messages: [] };
  relay.resetForTests();
  messages.resetForTests();
  mockSupabase();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function loginKey(): Promise<string> {
  const res = await call('login', { method: 'POST', device: WORK, auth: false, body: { email: 'owner@test.ru', password: 'x', deviceName: 'Рабочий' } });
  expect(res.statusCode).toBe(200);
  return (res.body as { deviceKey: string }).deviceKey;
}

describe('ключ устройства', () => {
  it('вход выдаёт ключ, в базе только его sha256', async () => {
    const key = await loginKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(state.keyHash).toBe(sha256(key));
  });

  it('inbox по ключу без сессии: ПК «в сети», выход из аккаунта ПК не отзывает', async () => {
    const key = await loginKey();
    const pending = call('relay-inbox', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': key }, body: { name: 'Рабочий', points: [] } });
    await vi.advanceTimersByTimeAsync(26_000);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ jobs: [], messages: [], alertSound: null });
    expect(relay.onlineIds(USER).has(WORK)).toBe(true);
    const me = await call('me');
    expect((me.body as { devices: { id: string; online: boolean }[] }).devices.find(d => d.id === WORK)?.online).toBe(true);

    const out = await call('logout', { method: 'POST', device: WORK });
    expect(out.statusCode).toBe(204);
    expect(calls.some(c => c.method === 'PATCH' && c.url.includes('app_devices') && c.body && (c.body as { revoked_at?: string }).revoked_at)).toBe(false);
  });

  it('чужой ключ — DEVICE_KEY_INVALID, отключённый ПК — DEVICE_REVOKED', async () => {
    await loginKey();
    const bad = await call('relay-inbox', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': 'x'.repeat(43) }, body: {} });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toMatchObject({ code: 'DEVICE_KEY_INVALID' });
    state.revoked = true;
    const gone = await call('relay-inbox', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': 'x'.repeat(43) }, body: {} });
    expect(gone.body).toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  it('права аренды по ключу — только mirror; без ключа и сессии — пусто', async () => {
    const key = await loginKey();
    const byKey = await account.leaseRights(request('lease', { device: WORK, auth: false, headers: { 'x-device-key': key } }));
    expect(byKey).toMatchObject({ user: USER, features: ['mirror'], via: 'key' });
    const anon = await account.leaseRights(request('lease', { device: WORK, auth: false }));
    expect(anon.features).toEqual([]);
    const bySession = await account.leaseRights(request('lease', { device: WORK }));
    expect(bySession.features.length).toBeGreaterThan(1);
  });

  it('device-key по сессии выдаёт новый ключ, старый перестаёт работать', async () => {
    const first = await loginKey();
    const res = await call('device-key', { method: 'POST', device: WORK });
    expect(res.statusCode).toBe(200);
    const second = (res.body as { deviceKey: string }).deviceKey;
    expect(second).not.toBe(first);
    expect(state.keyHash).toBe(sha256(second));
  });
});

describe('память о ПК и токенах', () => {
  const cache = require('../../server/_app-device-cache.js') as {
    TTL_MS: number; currentEpoch: () => number; clearDevices: () => void;
    getDevice: (k: string) => unknown; putDevice: (k: string, v: unknown, e: number) => void;
  };
  const jwt = (expSeconds: number) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSeconds })).toString('base64url')}.s`;
  const bearer = (token: string) => ({ auth: false, device: WORK, headers: { authorization: `Bearer ${token}` } });
  const authCalls = () => calls.filter(c => c.url.includes('/auth/v1/user')).length;
  const inboxByKey = async (key: string) => {
    const pending = call('relay-inbox', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': key }, body: { name: 'Рабочий', points: [] } });
    await vi.advanceTimersByTimeAsync(26_000);
    return pending;
  };
  const deviceReads = () => calls.filter(c => c.method === 'GET' && c.url.includes('key_hash=not.is.null')).length;

  it('поиск ПК по ключу: повторные запросы не читают базу, по истечении срока — читают', async () => {
    const key = await loginKey();
    await inboxByKey(key);
    await inboxByKey(key);
    expect(deviceReads()).toBe(1);
    await vi.advanceTimersByTimeAsync(cache.TTL_MS);
    await inboxByKey(key);
    expect(deviceReads()).toBe(2);
  });

  it('отключение ПК действует сразу, несмотря на память', async () => {
    const key = await loginKey();
    expect((await inboxByKey(key)).statusCode).toBe(200);
    const off = await call('device', { method: 'DELETE', query: { id: WORK } });
    expect(off.statusCode).toBe(204);
    const res = await call('relay-inbox', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': key }, body: {} });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  it('смена запретов доходит сразу и по сессии', async () => {
    await loginKey();
    const before = await call('docs', { device: WORK });
    expect(before.statusCode).toBe(200);
    const reads = () => calls.filter(c => c.method === 'GET' && c.url.includes(`device_hash=eq.${HASH[WORK]}`) && !c.url.includes('key_hash')).length;
    const seen = reads();
    await call('docs', { device: WORK });
    expect(reads()).toBe(seen);
    await call('device', { method: 'PATCH', query: { id: WORK }, body: { alertSound: 'bell' } });
    await call('docs', { device: WORK });
    expect(reads()).toBe(seen + 1);
  });

  it('отметка «был в сети» не очищает память и не повторяется на каждый запрос', async () => {
    state.lastSeen = '2026-01-01T00:00:00Z';
    const key = await loginKey();
    const touches = () => calls.filter(c => c.method === 'PATCH' && c.url.includes('app_devices') && (c.body as { last_seen_at?: string })?.last_seen_at && !c.url.includes('device_hash=eq')).length;
    await inboxByKey(key);
    await inboxByKey(key);
    expect(touches()).toBe(1);
    expect(deviceReads()).toBe(1);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await inboxByKey(key);
    expect(touches()).toBe(2);
  });

  it('чтение, начатое до записи, не сохраняется', () => {
    const epoch = cache.currentEpoch();
    cache.clearDevices();
    cache.putDevice('race', { old: true }, epoch);
    expect(cache.getDevice('race')).toBeNull();
  });

  it('токен помнится только для фоновых опросов и только его срок', async () => {
    const token = jwt(3600);
    await call('docs', bearer(token));
    await call('docs', bearer(token));
    expect(authCalls()).toBe(1);
    await call('me', bearer(token));
    await call('me', bearer(token));
    expect(authCalls()).toBe(3);
    await vi.advanceTimersByTimeAsync(cache.TTL_MS);
    await call('docs', bearer(token));
    expect(authCalls()).toBe(4);

    const short = jwt(5);
    await call('docs', bearer(short));
    await vi.advanceTimersByTimeAsync(6_000);
    await call('docs', bearer(short));
    expect(authCalls()).toBe(6);
  });

  it('выход забывает токен сразу; отказ Auth не запоминается', async () => {
    const token = jwt(3600);
    await call('docs', bearer(token));
    await call('logout', { method: 'POST', ...bearer(token) });
    const after = authCalls();
    await call('docs', bearer(token));
    expect(authCalls()).toBe(after + 1);

    const base = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => (url.includes('/auth/v1/user') ? new Response('{}', { status: 401 }) : base(url, init)));
    const bad = jwt(3000);
    expect((await call('docs', bearer(bad))).statusCode).toBe(401);
    vi.stubGlobal('fetch', base);
    expect((await call('docs', bearer(bad))).statusCode).toBe(200);
  });
});

describe('память о пунктах, документах и правах', () => {
  const cache = require('../../server/_app-device-cache.js') as {
    DATA_TTL_MS: number; currentDataEpoch: () => number; forgetUserData: (u: string | null) => void;
    getUserData: (u: string, p: string) => unknown; putUserData: (u: string, p: string, v: unknown, e: number) => void;
  };
  const { supabaseFetch } = require('../../server/_supabase.js') as { supabaseFetch: (p: string, o?: Record<string, unknown>) => Promise<unknown> };
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const count = (part: string) => calls.filter(c => c.url.includes(part)).length;
  const poll = (action: string) => call(action, { device: WORK });
  const seed = (u: string) => cache.putUserData(u, 'points', [{ id: 'x' }], cache.currentDataEpoch());

  it('points: строки и права читаются один раз за срок; права для me — всегда свежие', async () => {
    await poll('points');
    await poll('points');
    expect(count('select=id,wb_point_id,name,last_sync_at')).toBe(1);
    expect(count('rpc/app_entitlements')).toBe(1);
    await call('me', { device: WORK });
    expect(count('rpc/app_entitlements')).toBeGreaterThan(1);
    const after = count('select=id,wb_point_id,name,last_sync_at');
    await vi.advanceTimersByTimeAsync(cache.DATA_TTL_MS);
    await poll('points');
    expect(count('select=id,wb_point_id,name,last_sync_at')).toBe(after + 1);
  });

  it('docs читаются один раз за срок, секреты — каждый раз', async () => {
    await poll('docs');
    await poll('docs');
    expect(count('secret=eq.false')).toBe(1);
    await poll('secrets');
    await poll('secrets');
    expect(count('secret=eq.true')).toBe(2);
  });

  it('запись пункта или документа забывает только этого пользователя', async () => {
    for (const [path, options] of [
      ['app_points?id=eq.p1&user_id=eq.' + USER, { method: 'PATCH', body: '{}' }],
      ['rpc/app_doc_put', { method: 'POST', body: JSON.stringify({ p_user: USER }) }],
      ['rpc/app_register_point', { method: 'POST', body: JSON.stringify({ p_user: USER }) }],
    ] as [string, Record<string, unknown>][]) {
      seed(USER); seed(OTHER);
      await supabaseFetch(path, options).catch(() => {});
      expect(cache.getUserData(USER, 'points')).toBeNull();
      expect(cache.getUserData(OTHER, 'points')).not.toBeNull();
    }
  });

  it('оплата и выдача подписки сбрасывают права сразу, в том числе при сбое запроса', async () => {
    for (const path of ['rpc/complete_app_addon_order', 'rpc/complete_app_subscription_order', 'rpc/admin_grant_app_addon', 'rpc/admin_revoke_app_subscription', 'app_subscriptions?id=eq.1']) {
      seed(USER);
      await supabaseFetch(path, { method: path.startsWith('rpc') ? 'POST' : 'PATCH', body: '{}' }).catch(() => {});
      expect(cache.getUserData(USER, 'points')).toBeNull();
    }
  });

  it('служебная отметка и чтение память не сбрасывают; запись без пользователя сбрасывает всем', async () => {
    seed(USER);
    await supabaseFetch('app_points?id=eq.p1', { method: 'PATCH', keepCache: true, body: '{}' }).catch(() => {});
    await supabaseFetch('app_points?user_id=eq.' + USER, {}).catch(() => {});
    expect(cache.getUserData(USER, 'points')).not.toBeNull();
    await supabaseFetch('app_points?id=eq.p1', { method: 'PATCH', body: '{}' }).catch(() => {});
    expect(cache.getUserData(USER, 'points')).toBeNull();
  });

  it('чтение, начатое до записи, не сохраняется', () => {
    const epoch = cache.currentDataEpoch();
    cache.forgetUserData(USER);
    cache.putUserData(USER, 'points', [], epoch);
    expect(cache.getUserData(USER, 'points')).toBeNull();
  });
});

describe('лимиты частоты', () => {
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

  it('фоновые потолки считаются в памяти, без запроса к базе, и соблюдаются', async () => {
    const opts = { scope: 'app-relay', limit: 2, windowSeconds: 600, key: `memory-${Math.random()}` };
    expect(await enforceRateLimit(req, response(), opts)).toBe(true);
    expect(await enforceRateLimit(req, response(), opts)).toBe(true);
    const blocked = response();
    expect(await enforceRateLimit(req, blocked, opts)).toBe(false);
    expect(blocked.statusCode).toBe(429);
    expect(calls.some(c => c.url.includes('consume_api_rate_limit'))).toBe(false);
  });

  it('лимиты входа по-прежнему в базе', async () => {
    expect(await enforceRateLimit(req, response(), { scope: 'app-login', limit: 10, windowSeconds: 600 })).toBe(true);
    expect(calls.some(c => c.url.includes('consume_api_rate_limit'))).toBe(true);
  });
});

describe('сообщения владельца на ПК', () => {
  it('кабинет шлёт — спящий inbox ПК просыпается с сообщением, доставка отмечена', async () => {
    const key = await loginKey();
    const pending = call('relay-inbox', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': key }, body: { name: 'Рабочий', points: [] } });
    await vi.advanceTimersByTimeAsync(1_000);
    const sent = await call('messages', { method: 'POST', body: { deviceId: WORK, text: 'Пришла поставка, примите срочно' } });
    expect(sent.statusCode).toBe(201);
    expect(sent.body).toMatchObject({ id: MSG, status: 'pending' });
    await vi.advanceTimersByTimeAsync(100);
    const res = await pending;
    expect(res.body).toMatchObject({ messages: [{ id: MSG, text: 'Пришла поставка, примите срочно' }] });
    expect(state.messages[0].delivered_at).toBeTruthy();
    const list = await call('messages', { query: { device: WORK } });
    expect((list.body as { items: { status: string }[] }).items[0].status).toBe('delivered');
  });

  it('пустой inbox не спрашивает базу о сообщениях, пока не истёк срок отметки', async () => {
    const key = await loginKey();
    const inbox = async () => {
      const pending = call('relay-inbox', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': key }, body: { name: 'Рабочий', points: [] } });
      await vi.advanceTimersByTimeAsync(26_000);
      expect((await pending).statusCode).toBe(200);
    };
    const asked = () => calls.filter(c => c.url.includes('app_device_messages')).length;
    await inbox();
    expect(asked()).toBe(2); // один PATCH и один SELECT за весь цикл вместо двух пар
    await inbox();
    expect(asked()).toBe(2);
    await vi.advanceTimersByTimeAsync(messages.EMPTY_TTL_MS);
    await inbox();
    expect(asked()).toBe(4);
  });

  it('сообщение после отметки «пусто» доходит сразу', async () => {
    expect(await messages.pull(USER, WORK)).toEqual([]);
    await messages.send({ userId: USER, deviceId: WORK, text: 'Новое' });
    expect(await messages.pull(USER, WORK)).toMatchObject([{ id: MSG }]);
  });

  it('отправка во время чтения: устаревшее «пусто» не запоминается', async () => {
    const base = globalThis.fetch;
    let raced = false;
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
      const response = await base(url, init as RequestInit);
      if (!raced && url.includes('app_device_messages') && (init?.method || 'GET') === 'GET') {
        raced = true;
        await messages.send({ userId: USER, deviceId: WORK, text: 'В гонке' });
      }
      return response;
    });
    expect(await messages.pull(USER, WORK)).toEqual([]); // чтение прошло раньше вставки
    expect(await messages.pull(USER, WORK)).toMatchObject([{ id: MSG }]);
  });

  it('сбой записи сообщения снимает отметку: строка могла записаться', async () => {
    expect(await messages.pull(USER, WORK)).toEqual([]);
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes('app_device_messages') && init?.method === 'POST') throw new Error('response lost');
      return base(url, init as RequestInit);
    });
    await expect(messages.send({ userId: USER, deviceId: WORK, text: 'Потеря ответа' })).rejects.toThrow();
    vi.stubGlobal('fetch', base);
    const before = calls.length;
    await messages.pull(USER, WORK);
    expect(calls.length).toBeGreaterThan(before);
  });

  it('ack read → показано; ack done → ответ и уведомление владельцу', async () => {
    const key = await loginKey();
    await call('messages', { method: 'POST', body: { deviceId: WORK, text: 'Выключите свет' } });
    const read = await call('messages-ack', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': key }, body: { id: MSG, status: 'read' } });
    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({ status: 'read' });
    const done = await call('messages-ack', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': key }, body: { id: MSG, status: 'done' } });
    expect(done.body).toMatchObject({ status: 'answered', answer: 'done', answerLabel: 'Сделано' });
    const notice = calls.find(c => c.url.includes('in_app_notifications') && c.method === 'POST');
    expect(notice?.body).toMatchObject({ kind: 'pc_reply', link: `/cabinet/pc-messages?device=${WORK}` });
    // повторный ack того же сообщения — не ошибка
    const again = await call('messages-ack', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': key }, body: { id: MSG, status: 'ok' } });
    expect(again.statusCode).toBe(200);
    expect(again.body).toMatchObject({ answer: 'done' });
  });

  it('ответ текстом по сессии (Bearer) тоже принимается', async () => {
    await loginKey();
    await call('messages', { method: 'POST', body: { deviceId: WORK, text: 'Камеры работают?' } });
    const res = await call('messages-ack', { method: 'POST', device: WORK, body: { id: MSG, status: 'reply', reply: 'Да, всё в порядке' } });
    expect(res.body).toMatchObject({ status: 'answered', answer: 'reply', reply: 'Да, всё в порядке' });
  });

  it('проверки: пустой текст, 501 символ, неверный статус', async () => {
    const key = await loginKey();
    expect((await call('messages', { method: 'POST', body: { deviceId: WORK, text: '   ' } })).statusCode).toBe(400);
    expect((await call('messages', { method: 'POST', body: { deviceId: WORK, text: 'x'.repeat(501) } })).statusCode).toBe(400);
    expect((await call('messages', { method: 'POST', body: { deviceId: 'nope', text: 'x' } })).statusCode).toBe(400);
    expect((await call('messages-ack', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': key }, body: { id: MSG, status: 'maybe' } })).statusCode).toBe(400);
  });

  it('звук: кабинет ставит через PATCH устройства, ПК — через device-settings по ключу, inbox возвращает его', async () => {
    const key = await loginKey();
    const bad = await call('device', { method: 'PATCH', query: { id: WORK }, body: { alertSound: 'foo' } });
    expect(bad.statusCode).toBe(400);
    const ok = await call('device', { method: 'PATCH', query: { id: WORK }, body: { alertSound: 'bell' } });
    expect(ok.body).toEqual({ id: WORK, alertSound: 'bell' });
    const own = await call('device-settings', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': key }, body: { alertSound: 'knock' } });
    expect(own.body).toEqual({ id: WORK, alertSound: 'knock' });
    const pending = call('relay-inbox', { method: 'POST', device: WORK, auth: false, headers: { 'x-device-key': key }, body: { name: 'Рабочий', points: [] } });
    await vi.advanceTimersByTimeAsync(26_000);
    expect((await pending).body).toMatchObject({ alertSound: 'knock' });
  });
});
