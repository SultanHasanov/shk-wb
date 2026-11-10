// Экран «Система»: server/_admin-system.js — запрос не падает без файлов и сервисов, кеш 30 с, секреты не утекают.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const fs = require('fs') as typeof import('fs');
const system = require('../../server/_admin-system.js') as {
  handleSystem: (req: unknown, res: unknown) => Promise<unknown>;
  collectSystem: (options?: { force?: boolean }) => Promise<Record<string, any>>;
  publicUrl: (value: string) => string | null;
  resetForTests: () => void;
};

let dir: string;
const missing = () => join(dir, 'missing');

function response() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.end = () => res;
  return res;
}

function stubFetch(responder: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => responder(String(url))));
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'admin-system-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.ADMIN_BACKUPS_DIR = missing();
  process.env.SHK_CURRENT_LINK = missing();
  process.env.PVZ_APP_UPDATES_DIR = missing();
  process.env.CELL_PRINT_UPDATES_DIR = missing();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.BOT_NODE_URL;
  delete process.env.PVZ_APP_MIN_VERSION;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.APP_UNLIMITED_USER_IDS;
  system.resetForTests();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('экран «Система»', () => {
  it('нет файлов, папок и сервисов — поля null, запрос не падает', async () => {
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(new Error('ENOSYS'));
    stubFetch(() => new Response(JSON.stringify({ message: 'down' }), { status: 500 }));
    const res = response();
    await system.handleSystem({ method: 'GET', query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.disk).toBeNull();
    expect(body.database).toBeNull();
    expect(body.backups).toBeNull();
    expect(body.webhook).toBeNull();
    expect(body.relay).toMatchObject({ status: 'unknown' });
    expect(body.botNode).toMatchObject({ status: 'unknown', url: null, release: null });
    expect(body.site).toMatchObject({ status: 'ok', release: null, role: expect.any(String) });
    expect(body.programs).toEqual({
      pvzHelper: { latest: null, minVersion: null, mandatory: false, devicesBelowMin: 0 },
      cellPrint: { latest: null, signed: false },
    });
    expect(body.bot).toMatchObject({ status: expect.any(String), alerts: { updates: { active: false }, relay: { active: false }, webhook: { active: false }, 'bot-node': { active: false } } });
    expect(body.egress.status).toBe('unknown');
    expect(body.cached).toBe(false);
  });

  it('бэкапы: 14 новейших *.dump, свежий — ok; диск и база — с порогами', async () => {
    const backups = join(dir, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    const now = Date.now();
    for (let i = 0; i < 16; i += 1) {
      const file = join(backups, `db-${String(i).padStart(2, '0')}.dump`);
      writeFileSync(file, 'x'.repeat(i + 1));
      const at = new Date(now - (15 - i) * 3600_000);
      utimesSync(file, at, at);
    }
    writeFileSync(join(backups, 'notes.txt'), 'не бэкап');
    process.env.ADMIN_BACKUPS_DIR = backups;
    vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ blocks: 100, bsize: 1024 ** 3, bavail: 50 } as never);
    stubFetch(url => (url.includes('rpc/app_db_size') ? new Response('450000000', { status: 200 }) : new Response('[]', { status: 200 })));
    const value = await system.collectSystem();
    expect(value.backups.status).toBe('ok');
    expect(value.backups.items).toHaveLength(14);
    expect(value.backups.items[0].name).toBe('db-15.dump');
    expect(value.backups.items.every((item: { name: string }) => item.name.endsWith('.dump'))).toBe(true);
    expect(value.disk).toMatchObject({ status: 'ok', totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3, usedPercent: 50 });
    expect(value.database).toMatchObject({ status: 'warning', sizeBytes: 450000000, limitBytes: 524288000 });
  });

  it('кеш 30 с; force — не чаще раза в 10 с', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T10:00:00Z'));
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(new Error('no'));
    stubFetch(() => new Response('100', { status: 200 }));
    const first = await system.collectSystem();
    const calls = vi.mocked(fetch).mock.calls.length;
    expect(first.cached).toBe(false);
    vi.setSystemTime(new Date('2026-11-10T10:00:05Z'));
    expect((await system.collectSystem()).cached).toBe(true);
    expect((await system.collectSystem({ force: true })).cached).toBe(true);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
    vi.setSystemTime(new Date('2026-11-10T10:00:11Z'));
    expect((await system.collectSystem({ force: true })).cached).toBe(false);
    vi.setSystemTime(new Date('2026-11-10T10:00:30Z'));
    expect((await system.collectSystem()).cached).toBe(true);
    vi.setSystemTime(new Date('2026-11-10T10:00:42Z'));
    expect((await system.collectSystem()).cached).toBe(false);
  });

  it('env — только признаки, значения секретов наружу не попадают', async () => {
    process.env.RESEND_API_KEY = 're_super_secret_value';
    process.env.RESEND_FROM_EMAIL = 'no-reply@shk-wb.ru';
    process.env.BOT_NODE_URL = 'https://tg.example:88/webhook/AAAAAAAAAAAAAAAAAAAAAAAAAAAA?token=secret-query';
    process.env.APP_UNLIMITED_USER_IDS = '11111111-1111-4111-8111-111111111111, 22222222-2222-4222-8222-222222222222';
    process.env.PVZ_APP_MIN_VERSION = '1.10.0';
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(new Error('no'));
    stubFetch(url => (url.startsWith('https://tg.example') ? new Response('ok', { status: 200 }) : new Response('[]', { status: 200 })));
    const value = await system.collectSystem();
    const text = JSON.stringify(value);
    expect(text).not.toContain('re_super_secret_value');
    expect(text).not.toContain('secret-query');
    expect(text).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(text).not.toContain('11111111-1111');
    const env = Object.fromEntries(value.env.map((row: { name: string; value: string }) => [row.name, row.value]));
    expect(env).toMatchObject({ RESEND: 'задан', BOT_NODE_URL: 'задан', APP_UNLIMITED_USER_IDS: '2 аккаунта', PVZ_APP_MIN_VERSION: '1.10.0', APP_MIRROR_DISABLED: 'нет' });
    expect(value.botNode).toMatchObject({ status: expect.stringMatching(/ok|warning/), url: 'https://tg.example:88/webhook/…' });
  });

  it('publicUrl отбрасывает запрос и прячет длинные токены пути', () => {
    expect(system.publicUrl('https://shk-wb.ru/api/telegram/1234567890:ABCdefGhIJKlmnoPQRstu?secret=1')).toBe('https://shk-wb.ru/api/telegram/…');
    expect(system.publicUrl('')).toBeNull();
    expect(system.publicUrl('не адрес')).toBeNull();
  });

  it('не GET — 405', async () => {
    const res = response();
    await system.handleSystem({ method: 'POST', query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });
});
