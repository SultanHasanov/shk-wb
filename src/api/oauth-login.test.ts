import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

type Res = {
  statusCode: number; body: unknown; headers: Record<string, string>; ended: boolean;
  status: (c: number) => Res; json: (b: unknown) => Res; setHeader: (k: string, v: string) => void; end: () => Res;
};
function response(): Res {
  const res = { statusCode: 200, body: undefined, headers: {}, ended: false } as unknown as Res;
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

const ENV = {
  SUPABASE_URL: 'https://db.example.supabase.co',
  SUPABASE_SECRET_KEY: 'service-key',
  SUPABASE_PUBLISHABLE_KEY: 'public-key',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  STICKER_CLIENT_SECRET: 'sticker-secret',
  PUBLIC_APP_URL: 'https://shk-wb.ru',
  YANDEX_OAUTH_CLIENT_ID: 'ya-id',
  YANDEX_OAUTH_CLIENT_SECRET: 'ya-secret',
};

type Call = { url: string; init: RequestInit & { headers?: Record<string, string> } };
let calls: Call[] = [];
let routes: Array<[RegExp, (call: Call) => { status?: number; body: unknown }]> = [];

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const call = { url, init: init as Call['init'] };
    calls.push(call);
    const route = routes.find(([re]) => re.test(url));
    if (!route) throw new Error(`Unexpected fetch ${url}`);
    const { status = 200, body } = route[1](call);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }));
}

function cookieOf(res: Res) {
  const match = /shk_oauth=([^;]*)/.exec(res.headers['Set-Cookie'] || '');
  return match ? decodeURIComponent(match[1]) : '';
}

describe('вход через Яндекс ID / Mail.ru (server/_oauth-login.js)', () => {
  type State = { p: string; n: string; t: number; r: string; u?: string };
  type OAuthModule = {
    readState: (value: string | null) => State | null;
    makeState: (input: { provider: string; next: string; nonce: string; linkUserId?: string | null }) => string;
    safeNext: (value: string) => string;
  };
  let oauth: OAuthModule;
  let handler: (req: unknown, res: Res) => Promise<unknown>;

  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    vi.stubEnv('MAILRU_OAUTH_CLIENT_ID', '');
    vi.stubEnv('MAILRU_OAUTH_CLIENT_SECRET', '');
    calls = [];
    routes = [];
    installFetch();
    vi.resetModules();
    oauth = require('../../server/_oauth-login.js') as OAuthModule;
    handler = require('../../api/auth.js') as typeof handler;
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('providers отдаёт только настроенных провайдеров', async () => {
    const res = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'providers' }, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ providers: [{ id: 'yandex', title: 'Яндекс ID' }] });
  });

  it('start ведёт на oauth.yandex.ru с подписанным state и кладёт nonce в cookie', async () => {
    const res = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'start', provider: 'yandex', next: '/cabinet/subscription' }, headers: {} }, res);
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.Location);
    expect(url.origin + url.pathname).toBe('https://oauth.yandex.ru/authorize');
    expect(url.searchParams.get('client_id')).toBe('ya-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://shk-wb.ru/api/auth/oauth/yandex/callback');
    const state = oauth.readState(url.searchParams.get('state'));
    expect(state).toMatchObject({ p: 'yandex', n: '/cabinet/subscription' });
    expect(cookieOf(res)).toBe(state!.r);
    expect(res.headers['Set-Cookie']).toContain('HttpOnly');
  });

  it('start для ненастроенного провайдера — 404, внешний next не пропускается', async () => {
    const res = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'start', provider: 'mailru' }, headers: {} }, res);
    expect(res.statusCode).toBe(404);
    expect(oauth.safeNext('https://evil.example/x')).toBe('/cabinet');
    expect(oauth.safeNext('//evil.example')).toBe('/cabinet');
    expect(oauth.safeNext('/cabinet/profile')).toBe('/cabinet/profile');
  });

  it('callback без совпадающего nonce в cookie — ошибка state, cookie стирается', async () => {
    const state = oauth.makeState({ provider: 'yandex', next: '/cabinet', nonce: 'n1' });
    const res = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'callback', provider: 'yandex', code: 'c', state }, headers: { cookie: 'shk_oauth=other' } }, res);
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/?auth=login&oauth=error&reason=state');
    expect(res.headers['Set-Cookie']).toContain('Max-Age=0');
    expect(calls).toHaveLength(0);
  });

  it('callback: новый пользователь создаётся с настоящей почтой, связка сохраняется, выдаётся token_hash', async () => {
    routes = [
      [/oauth\.yandex\.ru\/token/, call => {
        expect(String(call.init.body)).toContain('code=abc');
        expect(String(call.init.body)).toContain('grant_type=authorization_code');
        return { body: { access_token: 'ya-token' } };
      }],
      [/login\.yandex\.ru\/info/, call => {
        expect(call.init.headers?.Authorization).toBe('OAuth ya-token');
        return { body: { id: '777', default_email: 'Owner@Yandex.ru', real_name: 'Иван', is_avatar_empty: true } };
      }],
      [/user_oauth_identities\?provider=eq\.yandex/, () => ({ body: [] })],
      [/rpc\/auth_user_id_by_email/, () => ({ body: null })],
      [/auth\/v1\/admin\/users$/, call => {
        const body = JSON.parse(String(call.init.body));
        expect(body).toMatchObject({ email: 'owner@yandex.ru', email_confirm: true, user_metadata: { auth_source: 'yandex', full_name: 'Иван' } });
        return { body: { id: 'user-1', email: 'owner@yandex.ru' } };
      }],
      [/user_oauth_identities\?on_conflict/, call => {
        expect(JSON.parse(String(call.init.body))).toMatchObject({ provider: 'yandex', provider_user_id: '777', user_id: 'user-1', email: 'owner@yandex.ru' });
        return { body: null };
      }],
      [/auth\/v1\/admin\/generate_link/, () => ({ body: { properties: { hashed_token: 'hash-1' } } })],
    ];
    const state = oauth.makeState({ provider: 'yandex', next: '/cabinet/subscription', nonce: 'n1' });
    const res = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'callback', provider: 'yandex', code: 'abc', state }, headers: { cookie: 'shk_oauth=n1' } }, res);
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/auth/oauth?token_hash=hash-1&next=%2Fcabinet%2Fsubscription&provider=yandex&new=1');
    expect(calls.some(c => /on_conflict/.test(c.url))).toBe(true);
  });

  it('callback: аккаунт с такой почтой уже есть — входим в него без создания нового', async () => {
    routes = [
      [/oauth\.yandex\.ru\/token/, () => ({ body: { access_token: 't' } })],
      [/login\.yandex\.ru\/info/, () => ({ body: { id: '5', default_email: 'old@mail.ru' } })],
      [/user_oauth_identities\?provider=eq\.yandex/, () => ({ body: [] })],
      [/rpc\/auth_user_id_by_email/, () => ({ body: 'user-old' })],
      [/user_oauth_identities\?on_conflict/, () => ({ body: null })],
      [/auth\/v1\/admin\/users\/user-old$/, () => ({ body: { id: 'user-old', email: 'old@mail.ru' } })],
      [/auth\/v1\/admin\/generate_link/, call => {
        expect(JSON.parse(String(call.init.body))).toEqual({ type: 'magiclink', email: 'old@mail.ru' });
        return { body: { properties: { hashed_token: 'hash-old' } } };
      }],
    ];
    const state = oauth.makeState({ provider: 'yandex', next: '/cabinet', nonce: 'n2' });
    const res = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'callback', provider: 'yandex', code: 'x', state }, headers: { cookie: 'shk_oauth=n2' } }, res);
    expect(res.headers.Location).toBe('/auth/oauth?token_hash=hash-old&next=%2Fcabinet&provider=yandex');
    expect(calls.some(c => /admin\/users$/.test(c.url))).toBe(false);
  });

  it('callback: уже привязанный id провайдера входит в свой аккаунт, даже если почта сменилась', async () => {
    routes = [
      [/oauth\.yandex\.ru\/token/, () => ({ body: { access_token: 't' } })],
      [/login\.yandex\.ru\/info/, () => ({ body: { id: '5', default_email: 'new@yandex.ru' } })],
      [/user_oauth_identities\?provider=eq\.yandex/, () => ({ body: [{ user_id: 'user-linked' }] })],
      [/auth\/v1\/admin\/users\/user-linked$/, () => ({ body: { id: 'user-linked', email: 'linked@site.ru' } })],
      [/user_oauth_identities\?on_conflict/, () => ({ body: null })],
      [/auth\/v1\/admin\/generate_link/, call => {
        expect(JSON.parse(String(call.init.body)).email).toBe('linked@site.ru');
        return { body: { properties: { hashed_token: 'hash-linked' } } };
      }],
    ];
    const state = oauth.makeState({ provider: 'yandex', next: '/cabinet', nonce: 'n3' });
    const res = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'callback', provider: 'yandex', code: 'x', state }, headers: { cookie: 'shk_oauth=n3' } }, res);
    expect(res.headers.Location).toContain('token_hash=hash-linked');
    expect(calls.some(c => /rpc\/auth_user_id_by_email/.test(c.url))).toBe(false);
  });

  it('привязка: start?mode=link с Bearer отдаёт url и кладёт id кабинета в state; без Bearer — 401', async () => {
    routes = [[/auth\/v1\/user$/, () => ({ body: { id: 'user-me', email: 'me@site.ru' } })]];
    const res = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'start', provider: 'yandex', mode: 'link' }, headers: { authorization: 'Bearer tok' } }, res);
    expect(res.statusCode).toBe(200);
    const url = new URL((res.body as { url: string }).url);
    const state = oauth.readState(url.searchParams.get('state'));
    expect(state).toMatchObject({ p: 'yandex', u: 'user-me', n: '/cabinet/profile' });
    expect(cookieOf(res)).toBe(state!.r);

    const anon = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'start', provider: 'yandex', mode: 'link' }, headers: {} }, anon);
    expect(anon.statusCode).toBe(401);
  });

  it('привязка: callback сохраняет связку на кабинет из state без поиска по почте и возвращает в профиль', async () => {
    routes = [
      [/oauth\.yandex\.ru\/token/, () => ({ body: { access_token: 't' } })],
      [/login\.yandex\.ru\/info/, () => ({ body: { id: '42', default_email: 'other@yandex.ru' } })],
      [/user_oauth_identities\?provider=eq\.yandex/, () => ({ body: [] })],
      [/user_oauth_identities\?on_conflict/, call => {
        expect(JSON.parse(String(call.init.body))).toMatchObject({ provider: 'yandex', provider_user_id: '42', user_id: 'user-me' });
        return { body: null };
      }],
    ];
    const state = oauth.makeState({ provider: 'yandex', next: '/cabinet/profile', nonce: 'n5', linkUserId: 'user-me' });
    const res = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'callback', provider: 'yandex', code: 'x', state }, headers: { cookie: 'shk_oauth=n5' } }, res);
    expect(res.headers.Location).toBe('/cabinet/profile?oauth=linked&provider=yandex');
    expect(calls.some(c => /rpc\/auth_user_id_by_email|generate_link|admin\/users/.test(c.url))).toBe(false);
  });

  it('привязка: id провайдера уже у другого кабинета — reason=taken, связка не перезаписывается', async () => {
    routes = [
      [/oauth\.yandex\.ru\/token/, () => ({ body: { access_token: 't' } })],
      [/login\.yandex\.ru\/info/, () => ({ body: { id: '42', default_email: 'other@yandex.ru' } })],
      [/user_oauth_identities\?provider=eq\.yandex/, () => ({ body: [{ user_id: 'user-someone' }] })],
    ];
    const state = oauth.makeState({ provider: 'yandex', next: '/cabinet/profile', nonce: 'n6', linkUserId: 'user-me' });
    const res = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'callback', provider: 'yandex', code: 'x', state }, headers: { cookie: 'shk_oauth=n6' } }, res);
    expect(res.headers.Location).toBe('/cabinet/profile?oauth=error&reason=taken');
    expect(calls.some(c => /on_conflict/.test(c.url))).toBe(false);
  });

  it('callback: провайдер не отдал почту — reason=no_email; отказ пользователя — reason=denied', async () => {
    routes = [
      [/oauth\.yandex\.ru\/token/, () => ({ body: { access_token: 't' } })],
      [/login\.yandex\.ru\/info/, () => ({ body: { id: '9' } })],
      [/user_oauth_identities\?provider=eq\.yandex/, () => ({ body: [] })],
    ];
    const state = oauth.makeState({ provider: 'yandex', next: '/cabinet', nonce: 'n4' });
    const res = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'callback', provider: 'yandex', code: 'x', state }, headers: { cookie: 'shk_oauth=n4' } }, res);
    expect(res.headers.Location).toBe('/?auth=login&oauth=error&reason=no_email');

    const denied = response();
    await handler({ method: 'GET', query: { action: 'oauth', step: 'callback', provider: 'yandex', error: 'access_denied' }, headers: {} }, denied);
    expect(denied.headers.Location).toBe('/?auth=login&oauth=error&reason=denied');
  });
});
