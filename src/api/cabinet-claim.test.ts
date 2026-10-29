import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/cabinet.js') as Handler & Record<string, unknown>;

function claimReq(body: Record<string, unknown>) {
  return {
    method: 'POST',
    query: { action: 'claim' },
    body,
    headers: { authorization: 'Bearer tkn', 'x-forwarded-for': '203.0.113.9' },
    socket: { remoteAddress: '203.0.113.9' },
  };
}
function response() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.end = () => res;
  return res;
}

// claim: null → успех; { message } → исключение rpc (status 400).
function mock(peek: boolean, claim: { message: string } | null, consume: any[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1' }), { status: 200 });
    if (url.includes('peek_api_rate_limit')) return new Response(JSON.stringify(peek), { status: 200 });
    if (url.includes('consume_api_rate_limit')) { consume.push(init.body ? JSON.parse(String(init.body)) : {}); return new Response('true', { status: 200 }); }
    if (url.includes('claim_user_asset')) {
      if (claim) return new Response(JSON.stringify(claim), { status: 400 });
      return new Response(JSON.stringify({ claimed: true, kind: 'cell_print' }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: 'unexpected ' + url }), { status: 404 });
  }));
}

describe('анти-перебор при добавлении ключа (claim)', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
    process.env.SUPABASE_SECRET_KEY = 'secret';
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('успешная привязка не расходует лимит (consume не вызывается)', async () => {
    const consume: any[] = [];
    mock(true, null, consume);
    const res = response();
    await handler(claimReq({ kind: 'cell_print', value: 'CP-AAAA-BBBB-CCCC' }), res);
    expect(res.statusCode).toBe(201);
    expect(consume).toHaveLength(0);
  });

  it('чужой ключ → ASSET_UNAVAILABLE (не раскрываем существование) и расход лимита', async () => {
    const consume: any[] = [];
    mock(true, { message: 'Asset belongs to another user' }, consume);
    const res = response();
    await handler(claimReq({ kind: 'cell_print', value: 'CP-SOME-ONEE-LSE0' }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('ASSET_UNAVAILABLE');
    expect(consume.map(c => c.p_scope).sort()).toEqual(['claim-ip', 'claim-user']);
  });

  it('6-значный код: «не найден» тоже ASSET_UNAVAILABLE и отдельный лимит claim-code', async () => {
    const consume: any[] = [];
    mock(true, { message: 'Asset not found' }, consume);
    const res = response();
    await handler(claimReq({ kind: 'sticker', value: '123456' }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('ASSET_UNAVAILABLE');
    expect(consume.map(c => c.p_scope).sort()).toEqual(['claim-code', 'claim-ip', 'claim-user']);
  });

  it('заказ: коды остаются различимыми (привязка гостевых заказов в CabinetShell)', async () => {
    const owned: any[] = [];
    mock(true, { message: 'Asset belongs to another user' }, owned);
    let res = response();
    await handler(claimReq({ kind: 'order', value: 'tok-foreign' }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ASSET_OWNED');

    mock(true, { message: 'Asset not found' }, []);
    res = response();
    await handler(claimReq({ kind: 'order', value: 'tok-missing' }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('ASSET_NOT_FOUND');
  });

  it('превышение лимита → 429 TOO_MANY_ATTEMPTS, запрос к claim не идёт', async () => {
    const consume: any[] = [];
    let claimCalled = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1' }), { status: 200 });
      if (url.includes('peek_api_rate_limit')) return new Response('false', { status: 200 });
      if (url.includes('claim_user_asset')) { claimCalled = true; return new Response('{}', { status: 200 }); }
      return new Response('null', { status: 404 });
    }));
    const res = response();
    await handler(claimReq({ kind: 'cell_print', value: 'CP-AAAA-BBBB-CCCC' }), res);
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('TOO_MANY_ATTEMPTS');
    expect(claimCalled).toBe(false);
  });
});
