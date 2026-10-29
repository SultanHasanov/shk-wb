import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/stickers/generate.js') as Handler;

function guestReq(accessCode = 'ZZZZZZ') {
  return {
    method: 'POST',
    query: {},
    body: { mode: 'range', quantity: 50, accessCode },
    headers: { 'x-forwarded-for': '203.0.113.11' },
    socket: { remoteAddress: '203.0.113.11' },
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

describe('анти-перебор гостевых кодов генерации', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
    process.env.SUPABASE_SECRET_KEY = 'secret';
    process.env.STICKER_CLIENT_SECRET = 'test-secret';
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('неверный код даёт INVALID_ACCESS_CODE и расходует лимиты IP/подсети/кода', async () => {
    const consume: any[] = [];
    let allocated = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes('peek_api_rate_limit')) return new Response('true', { status: 200 });
      if (url.includes('consume_api_rate_limit')) { consume.push(JSON.parse(String(init.body)).p_scope); return new Response('true', { status: 200 }); }
      if (url.includes('sticker_access_codes')) return new Response('[]', { status: 200 });
      if (url.includes('/rpc/')) { allocated = true; return new Response(JSON.stringify({ message: 'Invalid sticker access code' }), { status: 400 }); }
      return new Response('null', { status: 404 });
    }));
    const res = response();
    await handler(guestReq(), res);
    expect(allocated).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('INVALID_ACCESS_CODE');
    expect(consume).toEqual(expect.arrayContaining(['guest-code-ip', 'guest-code-subnet', 'guest-code-value']));
  });

  it('при превышении лимита — 429 и запрос на выдачу кодов не идёт', async () => {
    let allocated = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      // enforceRateLimit (consume) пропускает, но peek неудачных попыток — превышен.
      if (url.includes('peek_api_rate_limit')) return new Response('false', { status: 200 });
      if (url.includes('consume_api_rate_limit')) return new Response('true', { status: 200 });
      if (url.includes('sticker_access_codes')) return new Response('[]', { status: 200 });
      if (url.includes('/rpc/')) { allocated = true; return new Response('[]', { status: 200 }); }
      return new Response('null', { status: 404 });
    }));
    const res = response();
    await handler(guestReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('TOO_MANY_ATTEMPTS');
    expect(allocated).toBe(false);
  });
});
