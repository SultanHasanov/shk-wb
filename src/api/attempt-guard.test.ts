import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const guard = require('../../server/_attempt-guard.js') as typeof import('../../server/_attempt-guard');

function req(ip = '203.0.113.7') {
  return { headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } } as any;
}
function response() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  return res;
}
// Мок Supabase: peek и consume отдают заданный ответ; consume пишет вызовы.
function mock(peek: boolean, onConsume?: (body: any) => void) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url.includes('peek_api_rate_limit')) return new Response(JSON.stringify(peek), { status: 200 });
    if (url.includes('consume_api_rate_limit')) { onConsume?.(body); return new Response('true', { status: 200 }); }
    return new Response('null', { status: 404 });
  }));
}

describe('attempt-guard — лимит только неудачных попыток', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
    process.env.SUPABASE_SECRET_KEY = 'secret';
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const dims = [
    { scope: 'test-ip', limit: 5, windowSeconds: 3600 },
    { scope: 'test-code', limit: 3, windowSeconds: 3600, key: '123456' },
  ];

  it('пропускает, пока лимит не превышен', async () => {
    mock(true);
    const res = response();
    expect(await guard.guardAttempts(req(), res, dims)).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('блокирует 429 TOO_MANY_ATTEMPTS при превышении измерения', async () => {
    mock(false);
    const res = response();
    expect(await guard.guardAttempts(req(), res, dims)).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('TOO_MANY_ATTEMPTS');
    expect(res.headers['Retry-After']).toBe('3600');
  });

  it('recordFailures инкрементит каждое измерение, успех — ничего', async () => {
    const calls: any[] = [];
    mock(true, b => calls.push(b));
    await guard.recordFailures(req(), dims);
    expect(calls.map(c => c.p_scope)).toEqual(['test-ip', 'test-code']);
    // Успешный путь (только guardAttempts) не зовёт consume.
    calls.length = 0;
    await guard.guardAttempts(req(), response(), dims);
    expect(calls).toHaveLength(0);
  });

  it('память-резерв: без Supabase блокирует после N неудач', async () => {
    // Supabase недоступен → peek/consume падают, работает счётчик в памяти.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const dim = { scope: 'fb-' + Math.random().toString(36).slice(2), limit: 2, windowSeconds: 3600, key: 'ABCD' };
    expect(await guard.allowAttempt(req(), dim)).toBe(true);
    await guard.recordFailure(req(), dim);
    await guard.recordFailure(req(), dim);
    expect(await guard.allowAttempt(req(), dim)).toBe(false);
  });

  it('subnetOf сводит IPv4 к /24', () => {
    expect(guard.subnetOf(req('198.51.100.42'))).toBe('198.51.100.0/24');
  });
});
