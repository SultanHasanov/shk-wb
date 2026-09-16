import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const root = resolve(__dirname, '../..');
const grants = require('../../server/_admin-grants.js') as {
  checkCellLicensePatch: (id: number, body: Record<string, unknown>) => Promise<{ error?: string; status?: number; extra?: Record<string, unknown> }>;
  checkStickerAccessPatch: (id: number, body: Record<string, unknown>) => Promise<{ error?: string; status?: number }>;
  addStickerGenerations: (codeId: number, add: unknown) => Promise<{ error?: string; row?: unknown }>;
  createProgramKey: (input: Record<string, unknown>) => Promise<{ error?: string; row?: unknown }>;
  createCellLicense: (input: Record<string, unknown>) => Promise<{ error?: string; row?: { key: string } }>;
  isUuid: (value: unknown) => boolean;
};

/** Ответы PostgREST подменяем на уровне fetch: сам модуль остаётся настоящим. */
function stubSupabase(responder: (path: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).split('/rest/v1/')[1] ?? String(url);
    const data = responder(path, init);
    return { ok: true, status: 200, text: async () => JSON.stringify(data ?? []), headers: new Map() } as unknown as Response;
  }));
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('выдача активов из админки', () => {
  it('не даёт опустить лимит генераций ниже израсходованного', async () => {
    stubSupabase(() => [{ generation_used: 40 }]);
    expect(await grants.checkStickerAccessPatch(1, { limit: 30 })).toMatchObject({ error: expect.stringContaining('меньше') });
    expect(await grants.checkStickerAccessPatch(1, { limit: 50 })).toEqual({});
  });

  it('держит потолок суммарного срока ключа печати ячеек', async () => {
    stubSupabase(() => [{ duration_days: 3900, expires_at: null }]);
    expect(await grants.checkCellLicensePatch(1, { extendDays: 200 })).toMatchObject({ error: expect.stringContaining('4000') });
    expect(await grants.checkCellLicensePatch(1, { extendDays: 50 })).toMatchObject({ extra: { duration_days: 3950 } });
  });

  // Просроченный ключ продлевается от сегодняшнего дня, иначе продление уходит
  // в прошлое и человек остаётся без доступа сразу после оплаты.
  it('продлевает просроченный ключ от текущей даты', async () => {
    const past = new Date(Date.now() - 30 * 86400000).toISOString();
    stubSupabase(() => [{ duration_days: 30, expires_at: past }]);
    const result = await grants.checkCellLicensePatch(1, { extendDays: 10 });
    const expiresAt = Date.parse(String(result.extra?.expires_at));
    expect(expiresAt).toBeGreaterThan(Date.now() + 9 * 86400000);
  });

  it('не опускает лимит устройств ниже числа активаций', async () => {
    stubSupabase(path => (path.startsWith('cell_print_activations')
      ? [{ id: 1 }, { id: 2 }, { id: 3 }]
      : [{ duration_days: 30, expires_at: null }]));
    expect(await grants.checkCellLicensePatch(1, { deviceLimit: 2 })).toMatchObject({ error: expect.stringContaining('активирован') });
    expect(await grants.checkCellLicensePatch(1, { deviceLimit: 5 })).toMatchObject({ extra: {} });
  });

  it('выдаёт ключ печати ячеек в формате CP-XXXX-XXXX-XXXX', async () => {
    stubSupabase(() => [{ key: 'CP-AAAA-BBBB-CCCC', duration_days: 30, device_limit: 1 }]);
    const created = await grants.createCellLicense({ durationDays: 30, deviceLimit: 1 });
    expect(created.error).toBeUndefined();
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    expect(body.key).toMatch(/^CP-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(body.source).toBe('admin');
  });

  it('отклоняет недопустимые срок и число устройств', async () => {
    stubSupabase(() => []);
    expect(await grants.createCellLicense({ durationDays: 45, deviceLimit: 1 })).toMatchObject({ error: expect.any(String) });
    expect(await grants.createCellLicense({ durationDays: 30, deviceLimit: 4 })).toMatchObject({ error: expect.any(String) });
  });

  it('проверяет размер пополнения до обращения к базе', async () => {
    const spy = vi.fn();
    stubSupabase(spy);
    expect(await grants.addStickerGenerations(1, 0)).toMatchObject({ error: expect.any(String) });
    expect(await grants.addStickerGenerations(1, 999999)).toMatchObject({ error: expect.any(String) });
    expect(spy).not.toHaveBeenCalled();
  });

  it('проверяет формат ключа программы', async () => {
    stubSupabase(() => [{ key: 'WBPK-TEST', usage_limit: 10 }]);
    expect(await grants.createProgramKey({ key: 'no', limit: 10 })).toMatchObject({ error: expect.any(String) });
    expect(await grants.createProgramKey({ key: 'WBPK-TEST', limit: 0 })).toMatchObject({ error: expect.any(String) });
    expect(await grants.createProgramKey({ key: 'WBPK-TEST', limit: 10 })).toMatchObject({ row: expect.any(Object) });
  });

  it('узнаёт корректный идентификатор пользователя', () => {
    expect(grants.isUuid('0e1a5a6c-1111-2222-3333-444455556666')).toBe(true);
    expect(grants.isUuid('../../etc/passwd')).toBe(false);
    expect(grants.isUuid('')).toBe(false);
  });
});

describe('защита админского раздела пользователей', () => {
  const router = readFileSync(resolve(root, 'api/admin/data.js'), 'utf8');
  const users = readFileSync(resolve(root, 'server/_admin-users.js'), 'utf8');
  const migration = readFileSync(resolve(root, 'supabase/migrations/20260909_admin_user_directory.sql'), 'utf8');

  it('пускает в раздел пользователей только после requireAdmin', () => {
    const guard = router.indexOf('requireAdmin(req, res)');
    const branch = router.indexOf("resource === 'users'");
    expect(guard).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(guard);
  });

  // Функции читают auth.users. Без снятия прав они открывают почты всех
  // пользователей любому, у кого есть публичный ключ проекта.
  it('снимает права на функции директории со всех, кроме service_role', () => {
    for (const fn of ['admin_user_directory', 'admin_user_summary', 'admin_grant_generations']) {
      expect(migration).toMatch(new RegExp(`revoke all on function public\\.${fn}[^;]*from public, anon, authenticated`));
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${fn}[^;]*to service_role`));
    }
  });

  it('не собирает SQL сортировки строками', () => {
    expect(migration).toContain('security definer');
    expect(migration).toContain('set search_path=public,auth');
    expect(migration).not.toMatch(/execute\s+format\([^)]*p_sort/i);
    expect(migration).not.toMatch(/\|\|\s*p_sort/);
  });

  it('требует подтверждения почтой при удалении аккаунта', () => {
    expect(users).toContain("action === 'account'");
    expect(users).toMatch(/confirm !== String\(authUser\.email/);
  });

  it('зажимает размер страницы и не пробрасывает произвольную сортировку', () => {
    expect(users).toMatch(/Math\.min\(100,/);
    expect(users).toContain('SORTS.includes');
    expect(users).toContain('FILTERS.includes');
  });
});
