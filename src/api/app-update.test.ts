import { createRequire } from 'node:module';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/app.js') as Handler;

const DEVICE = 'b'.repeat(64);

function response() {
  const res: { statusCode: number; body: unknown; headers: Record<string, string> } & Record<string, unknown> = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.end = () => res;
  res.setHeader = (name: string, value: string) => { res.headers[name] = value; };
  return res;
}

function request(action: string, { method = 'GET', query = {}, headers = {} }: { method?: string; query?: Record<string, string>; headers?: Record<string, string> } = {}) {
  return {
    method,
    query: { action, ...query },
    headers: { host: 'shk-wb.ru', 'x-app-name': 'pvz-helper', 'x-app-version': '1.4.0', 'x-device-id': DEVICE, ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

let dir = '';
function release(latest: Record<string, unknown>) {
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(latest));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pvz-upd-'));
  vi.stubEnv('PVZ_APP_UPDATES_DIR', dir);
  vi.stubEnv('PVZ_APP_MIN_VERSION', '');
  // лимит запросов — через Supabase RPC; в тесте всегда «можно»
  vi.stubGlobal('fetch', vi.fn(async () => new Response('true', { status: 200 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('обновление Помощника', () => {
  it('204, если новее нет', async () => {
    release({ version: '1.4.0', file: 'setup.exe', signature: 'sig' });
    const res = response();
    await handler(request('update', { query: { current: '1.4.0' } }), res);
    expect(res.statusCode).toBe(204);
  });

  it('желательное обновление', async () => {
    release({ version: '1.4.1', notes: 'исправления', file: 'setup.exe', signature: 'sig' });
    const res = response();
    await handler(request('update', { query: { current: '1.4.0' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ version: '1.4.1', signature: 'sig', mandatory: false, notes: 'исправления' });
    expect((res.body as { url: string }).url).toContain('/api/app/update/download');
  });

  it('обязательное по env без правки релиза', async () => {
    release({ version: '1.4.1', file: 'setup.exe', signature: 'sig' });
    vi.stubEnv('PVZ_APP_MIN_VERSION', '1.4.1');
    const res = response();
    await handler(request('update', { query: { current: '1.4.0' } }), res);
    expect(res.body).toMatchObject({ mandatory: true, min_version: '1.4.1' });
  });

  it('обязательное по флагу в latest.json', async () => {
    release({ version: '1.4.1', file: 'setup.exe', signature: 'sig', mandatory: true });
    const res = response();
    await handler(request('update', { query: { current: '1.4.0' } }), res);
    expect(res.body).toMatchObject({ mandatory: true });
  });

  it('проверка версии отвечает 426 с кодом UPDATE_REQUIRED только Помощнику', async () => {
    vi.stubEnv('PVZ_APP_MIN_VERSION', '1.4.1');
    const res = response();
    await handler(request('me'), res);
    expect(res.statusCode).toBe(426);
    expect(res.body).toMatchObject({ code: 'UPDATE_REQUIRED', minVersion: '1.4.1' });
  });
});

describe('аренда', () => {
  it('подписывает payload ключом Ed25519', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    vi.stubEnv('PVZ_LEASE_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    vi.stubEnv('PVZ_APP_MIN_VERSION', '1.4.1');
    const res = response();
    await handler(request('lease', { method: 'POST' }), res);
    expect(res.statusCode).toBe(200);
    const { payload, signature } = res.body as { payload: string; signature: string };
    expect(verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64'))).toBe(true);
    const data = JSON.parse(payload);
    expect(data).toMatchObject({ app: 'pvz-helper', device: DEVICE, version: '1.4.0', mandatory: true, min_version: '1.4.1' });
    expect(data.exp - data.iat).toBe(3600);
  });

  it('без ключа — 503, а не неподписанная аренда', async () => {
    vi.stubEnv('PVZ_LEASE_PRIVATE_KEY', '');
    const res = response();
    await handler(request('lease', { method: 'POST' }), res);
    expect(res.statusCode).toBe(503);
  });
});
