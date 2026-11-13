import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
let handler: (req: unknown, res: unknown) => Promise<unknown>;
const req = { method: 'GET', query: { action: 'stickerStats' } };
function response() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.setHeader = vi.fn();
  return res;
}
const statsResponse = () => new Response(JSON.stringify([{ return_stickers: 10, custom_stickers: 20 }]));
describe('cached public sticker counts', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SECRET_KEY = 'secret';
    delete require.cache[require.resolve('../../api/visits.js')];
    handler = require('../../api/visits.js');
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('coalesces simultaneous reads and reuses counts for 30 seconds', async () => {
    const fetch = vi.fn(async () => statsResponse());
    vi.stubGlobal('fetch', fetch);
    const a = response(), b = response();
    await Promise.all([handler(req, a), handler(req, b)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.body).toEqual({ returnStickers: 10, customStickers: 20 });
    expect(b.body).toEqual(a.body);
    await handler(req, response());
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await handler(req, response());
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('uses recent counts after a timeout, but never fabricates zero counts or serves expired data', async () => {
    const fetch = vi.fn(async () => statsResponse());
    vi.stubGlobal('fetch', fetch);
    await handler(req, response());
    fetch.mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    vi.advanceTimersByTime(31_000);
    const stale = response();
    await handler(req, stale);
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toEqual({ returnStickers: 10, customStickers: 20 });
    vi.advanceTimersByTime(300_000);
    const expired = response();
    await handler(req, expired);
    expect(expired.statusCode).toBe(502);
    fetch.mockResolvedValue(statsResponse());
    const recovered = response();
    await handler(req, recovered);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.body).toEqual({ returnStickers: 10, customStickers: 20 });
  });
  it('does not hide database errors behind stale counts', async () => {
    const fetch = vi.fn(async () => statsResponse());
    vi.stubGlobal('fetch', fetch);
    await handler(req, response());
    vi.advanceTimersByTime(31_000);
    fetch.mockResolvedValue(new Response('{"message":"bad query"}', { status: 500 }));
    const res = response();
    await handler(req, res);
    expect(res.statusCode).toBe(502);
  });
});
