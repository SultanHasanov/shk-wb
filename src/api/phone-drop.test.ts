import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/app.js') as Handler;
const drop = require('../../server/_phone-drop.js') as {
  resetForTests: () => void;
  sweep: (now?: number) => void;
  cleanName: (v: string) => string;
  LIMITS: { chunkBytes: number; fileBytes: number };
  OPEN_TTL_MS: number;
};

const USER = '11111111-1111-4111-8111-111111111111';
const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HASH: Record<string, string> = { [HOME]: 'a'.repeat(64), [WORK]: 'b'.repeat(64) };
let denied: string[] = [];

type Res = { statusCode: number; body: any; headers: Record<string, string>; ended?: Buffer } & Record<string, unknown>;
function response() {
  const res: Res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.end = (buf?: Buffer) => { res.ended = buf; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  return res;
}

function mockSupabase() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    let body: unknown = null;
    if (url.includes('consume_api_rate_limit')) body = true;
    else if (url.includes('/auth/v1/user')) body = { id: USER, email: 'owner@test.ru' };
    else if (url.includes('app_devices?')) {
      const id = Object.keys(HASH).find(k => url.includes(HASH[k]));
      body = id ? [{ id, name: id === WORK ? 'Рабочий' : 'Домашний', last_seen_at: new Date().toISOString(), denied }] : [];
    } else if (url.includes('site_settings')) body = [];
    else return new Response(JSON.stringify({ message: 'unexpected ' + url }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

async function pc(action: string, device: string, { method = 'GET', query = {} as Record<string, string> } = {}) {
  const res = response();
  await handler({
    method, query: { action, ...query }, body: {},
    headers: { 'x-app-version': '1.16.0', 'x-device-id': HASH[device], authorization: `Bearer ${device}`, host: 'shk-wb.ru' },
    socket: { remoteAddress: '127.0.0.1' },
  }, res);
  return res;
}

async function phone(token: string, op: string, { method = 'POST', body, secret = '', query = {} as Record<string, string>, ip = '10.0.0.1' }: { method?: string; body?: unknown; secret?: string; query?: Record<string, string>; ip?: string } = {}) {
  const res = response();
  await handler({
    method, query: { action: 'phone-public', token, op, ...query }, body,
    headers: { 'x-phone-secret': secret },
    socket: { remoteAddress: ip },
  }, res);
  return res;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.PHONE_DROP_DIR = path.join(os.tmpdir(), `shk-phone-test-${process.pid}`);
  denied = [];
  drop.resetForTests();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function started() {
  mockSupabase();
  const res = await pc('phone-start', HOME, { method: 'POST' });
  expect(res.statusCode).toBe(200);
  return res.body as { token: string; url: string };
}

describe('файлы с телефона', () => {
  it('ПК получает одноразовую ссылку, телефон привязывается, второй телефон — отказ', async () => {
    const { token, url } = await started();
    expect(url).toMatch(/\/t\/[A-Za-z0-9_-]{43}$/);
    const first = await phone(token, 'open', { body: {} });
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ pcName: 'Домашний' });
    const secret = first.body.secret as string;
    expect(secret).toBeTruthy();

    // тот же телефон обновил страницу — пускаем
    const again = await phone(token, 'open', { body: { secret } });
    expect(again.statusCode).toBe(200);
    expect(again.body.secret).toBeUndefined();
    // другой телефон по тому же QR
    const other = await phone(token, 'open', { body: {}, ip: '10.0.0.2' });
    expect(other.statusCode).toBe(409);
    expect(other.body.code).toBe('LINK_USED');
  });

  it('файл идёт кусками, ПК забирает по порядку, после подтверждения куски удаляются', async () => {
    const { token } = await started();
    const { secret } = (await phone(token, 'open', { body: {} })).body;
    const size = drop.LIMITS.chunkBytes + 10;
    const f = await phone(token, 'file', { secret, body: { name: '../отчёт?.pdf', size, mime: 'application/pdf' } });
    expect(f.statusCode).toBe(200);
    const file = f.body.file as string;

    // второй кусок раньше первого — ПК всё равно получит первый первым
    const tail = Buffer.alloc(10, 2);
    expect((await phone(token, 'chunk', { secret, query: { file, idx: '1' }, body: tail })).statusCode).toBe(200);
    const head = Buffer.alloc(drop.LIMITS.chunkBytes, 1);
    expect((await phone(token, 'chunk', { secret, query: { file, idx: '0' }, body: head })).statusCode).toBe(200);
    // повтор после обрыва
    expect((await phone(token, 'chunk', { secret, query: { file, idx: '0' }, body: head })).body).toMatchObject({ repeated: true });

    const c0 = await pc('phone-pull', HOME, { query: { token } });
    expect(c0.headers['X-Phone-Idx']).toBe('0');
    expect(decodeURIComponent(c0.headers['X-Phone-Name'])).toBe('_отчёт_.pdf');
    expect(c0.ended?.length).toBe(drop.LIMITS.chunkBytes);
    const c1 = await pc('phone-pull', HOME, { query: { token, ack: `${file}:0` } });
    expect(c1.headers['X-Phone-Idx']).toBe('1');
    expect(c1.headers['X-Phone-Last']).toBe('1');
    const done = await pc('phone-pull', HOME, { query: { token, ack: `${file}:1` } });
    expect(done.body.state.files[0]).toMatchObject({ delivered: 2, done: true });

    const st = await phone(token, 'state', { method: 'GET', secret });
    expect(st.body.files[0]).toMatchObject({ done: true });
  });

  it('кусок неверного размера, файл больше предела и чужой ПК — отказ', async () => {
    const { token } = await started();
    const { secret } = (await phone(token, 'open', { body: {} })).body;
    const big = await phone(token, 'file', { secret, body: { name: 'video.mp4', size: drop.LIMITS.fileBytes + 1 } });
    expect(big.statusCode).toBe(413);
    const { file } = (await phone(token, 'file', { secret, body: { name: 'a.jpg', size: 100 } })).body;
    const wrong = await phone(token, 'chunk', { secret, query: { file, idx: '0' }, body: Buffer.alloc(50) });
    expect(wrong.statusCode).toBe(400);
    const foreign = await pc('phone-pull', WORK, { query: { token } });
    expect(foreign.statusCode).toBe(404);
    const noSecret = await phone(token, 'file', { body: { name: 'b.jpg', size: 10 } });
    expect(noSecret.statusCode).toBe(409);
  });

  it('несканированный QR истекает; новый QR закрывает прошлый', async () => {
    const { token } = await started();
    const second = (await pc('phone-start', HOME, { method: 'POST' })).body.token as string;
    expect((await phone(token, 'open', { body: {} })).statusCode).toBe(404);
    vi.setSystemTime(Date.now() + drop.OPEN_TTL_MS + 1000);
    drop.sweep();
    const gone = await phone(second, 'open', { body: {} });
    expect(gone.statusCode).toBe(404);
    expect(gone.body.code).toBe('LINK_GONE');
  });

  it('телефон видит, что компьютер перестал забирать файлы (pcOnline)', async () => {
    const { token } = await started();
    const { secret } = (await phone(token, 'open', { body: {} })).body;
    expect((await phone(token, 'state', { method: 'GET', secret })).body.pcOnline).toBe(true);
    vi.setSystemTime(Date.now() + 60_000);
    expect((await phone(token, 'state', { method: 'GET', secret })).body.pcOnline).toBe(false);
    await pc('phone-pull', HOME, { query: { token } });
    expect((await phone(token, 'state', { method: 'GET', secret })).body.pcOnline).toBe(true);
  });

  it('владелец закрыл приём на ПК — 403', async () => {
    denied = ['act.phone_files'];
    mockSupabase();
    const res = await pc('phone-start', HOME, { method: 'POST' });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('DENIED_BY_OWNER');
  });

  it('имя файла очищается от путей и запрещённых символов', () => {
    expect(drop.cleanName('C:\\Users\\x\\photo.jpg')).toBe('C_Users_x_photo.jpg');
    expect(drop.cleanName('  ..  ')).toBe('файл');
    expect(drop.cleanName('a<b>.txt')).toBe('a_b_.txt');
  });
});
