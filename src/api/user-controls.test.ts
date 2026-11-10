// Снимок ограничений и безлимита в памяти: server/_user-controls.js.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

type Restriction = { id: string; userId: string; telegramUserId: number | null; scopes: string[]; until: string | null; publicMessage: string | null; message: string };
type Controls = {
  SCOPES: readonly string[];
  TTL_MS: number;
  covers: (r: Restriction | null, scope: string) => boolean;
  restrictionMessage: (r: { publicMessage?: string | null; until?: string | null }) => string;
  loadSnapshot: (o?: { force?: boolean }) => Promise<unknown>;
  restrictionFor: (userId: string | null | undefined) => Promise<Restriction | null>;
  restrictionForCached: (userId: string) => Restriction | null;
  restrictionForTelegram: (id: number | string | null | undefined) => Promise<Restriction | null>;
  isRestricted: (userId: string, scope: string) => Promise<boolean>;
  assertAllowed: (userId: string, scope: string) => Promise<void>;
  restrictedBody: (r: Restriction) => { error: string; code: string; until: string | null };
  isUnlimitedCached: (userId: string) => boolean;
  invalidate: () => void;
  startExpiryWatch: () => void;
  __setSnapshotForTests: (json: unknown) => void;
};
const controls = require('../../server/_user-controls.js') as Controls;

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

function snapshot(extra: Record<string, unknown> = {}) {
  return {
    generated_at: new Date().toISOString(),
    unlimited: [{ user_id: U3, until: null }],
    restrictions: [
      { id: 'r1', user_id: U1, telegram_user_id: 555001, scopes: ['app'], until: null, public_message: null },
      { id: 'r2', user_id: U2, telegram_user_id: null, scopes: ['all'], until: '2099-01-01T00:00:00.000Z', public_message: '  Свяжитесь с поддержкой  ' },
    ],
    ...extra,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function snapshotCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('rpc/user_controls_snapshot')).length;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  controls.__setSnapshotForTests(null);
});
afterEach(() => {
  delete process.env.USER_CONTROLS_IN_TESTS;
  controls.__setSnapshotForTests(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('текст и области ограничения', () => {
  it('restrictionMessage: свой текст обрезается, без него — общий текст и дата по МСК', () => {
    expect(controls.restrictionMessage({ publicMessage: '  Нарушение правил  ', until: null })).toBe('Нарушение правил');
    expect(controls.restrictionMessage({ publicMessage: null, until: null })).toBe('Доступ ограничен администратором.');
    // 15:00 UTC = 18:00 МСК 17.11; 22:00 UTC 30.11 = 01:00 МСК 01.12
    expect(controls.restrictionMessage({ publicMessage: '', until: '2026-11-17T15:00:00.000Z' })).toBe('Доступ ограничен администратором. До 17.11');
    expect(controls.restrictionMessage({ until: '2026-11-30T22:00:00.000Z' })).toBe('Доступ ограничен администратором. До 01.12');
  });

  it('all покрывает любую область, остальные — только свою', () => {
    const all = { scopes: ['all'] } as Restriction;
    for (const scope of controls.SCOPES) expect(controls.covers(all, scope)).toBe(true);
    const app = { scopes: ['app'] } as Restriction;
    expect(controls.covers(app, 'app')).toBe(true);
    expect(controls.covers(app, 'site')).toBe(false);
    expect(controls.covers(null, 'app')).toBe(false);
  });
});

describe('снимок в памяти', () => {
  it('в тестах без флага снимок пустой и fetch не зовётся', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(snapshot()));
    vi.stubGlobal('fetch', fetchMock);
    expect(await controls.restrictionFor(U1)).toBeNull();
    expect(controls.isUnlimitedCached(U3)).toBe(false);
    expect(await controls.restrictionForTelegram(555001)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('одна загрузка на 60 с (общая для параллельных вызовов), вторая — после истечения', async () => {
    process.env.USER_CONTROLS_IN_TESTS = '1';
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-10T10:00:00.000Z'));
    const fetchMock = vi.fn(async () => jsonResponse(snapshot()));
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([controls.restrictionFor(U1), controls.restrictionFor(U2)]);
    expect(a?.scopes).toEqual(['app']);
    expect(b?.message).toBe('Свяжитесь с поддержкой');
    expect(await controls.isRestricted(U1, 'app')).toBe(true);
    expect(snapshotCalls(fetchMock)).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://db.test/rest/v1/rpc/user_controls_snapshot');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');

    vi.setSystemTime(new Date('2026-11-10T10:00:59.000Z'));
    await controls.restrictionFor(U1);
    expect(snapshotCalls(fetchMock)).toBe(1);

    // устарел — отдаётся прошлый снимок, новая загрузка идёт в фоне
    vi.setSystemTime(new Date('2026-11-10T10:01:01.000Z'));
    expect((await controls.restrictionFor(U1))?.id).toBe('r1');
    await vi.waitFor(() => expect(snapshotCalls(fetchMock)).toBe(2));
  });

  it('ошибка базы — прошлый снимок, повтор не раньше чем через 10 с', async () => {
    process.env.USER_CONTROLS_IN_TESTS = '1';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T10:00:00.000Z'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = false;
    const fetchMock = vi.fn(async () => (fail ? jsonResponse({ message: 'down' }, 500) : jsonResponse(snapshot())));
    vi.stubGlobal('fetch', fetchMock);

    expect((await controls.restrictionFor(U1))?.id).toBe('r1');
    fail = true;
    vi.setSystemTime(new Date('2026-11-10T10:01:05.000Z'));
    expect((await controls.restrictionFor(U1))?.id).toBe('r1');
    await vi.waitFor(() => expect(snapshotCalls(fetchMock)).toBe(2));
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled()); // фоновая загрузка упала
    // в окне повтора базу не спрашиваем
    vi.setSystemTime(new Date('2026-11-10T10:01:10.000Z'));
    expect((await controls.restrictionFor(U1))?.id).toBe('r1');
    expect(controls.restrictionForCached(U1)?.id).toBe('r1');
    await new Promise(r => setTimeout(r, 0));
    expect(snapshotCalls(fetchMock)).toBe(2);
    vi.setSystemTime(new Date('2026-11-10T10:01:16.000Z'));
    fail = false;
    await controls.restrictionFor(U1);
    await vi.waitFor(() => expect(snapshotCalls(fetchMock)).toBe(3));
  });

  it('устаревший снимок не задерживает запрос: медленная база — ответ сразу из прошлого снимка', async () => {
    process.env.USER_CONTROLS_IN_TESTS = '1';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T10:00:00.000Z'));
    let release: (() => void) | null = null;
    let slow = false;
    const fetchMock = vi.fn(async () => {
      if (slow) await new Promise<void>(r => { release = r; });
      return jsonResponse(snapshot({ restrictions: slow ? [] : snapshot().restrictions }));
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await controls.restrictionFor(U1))?.id).toBe('r1');

    slow = true;
    vi.setSystemTime(new Date('2026-11-10T10:01:05.000Z'));
    let settled = false;
    const pending = controls.assertAllowed(U2, 'site').then(() => { settled = true; }, () => { settled = true; });
    // ответ не ждёт висящую загрузку
    await new Promise(r => setTimeout(r, 0));
    expect(settled).toBe(true);
    await pending;
    await vi.waitFor(() => expect(release).not.toBeNull());
    // параллельные запросы не плодят загрузки
    await controls.restrictionFor(U1);
    expect(snapshotCalls(fetchMock)).toBe(2);
    release!();
    await vi.waitFor(async () => expect(await controls.restrictionFor(U1)).toBeNull());
  });

  it('после invalidate запрос ждёт свежий снимок один раз; при ошибке дальше — в фоне', async () => {
    process.env.USER_CONTROLS_IN_TESTS = '1';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T10:00:00.000Z'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let mode: 'ok' | 'lifted' | 'down' = 'ok';
    const fetchMock = vi.fn(async () => {
      if (mode === 'down') return jsonResponse({ message: 'down' }, 500);
      return jsonResponse(snapshot(mode === 'lifted' ? { restrictions: [] } : {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await controls.restrictionFor(U1))?.id).toBe('r1');
    mode = 'lifted';
    controls.invalidate();
    // изменение из админки действует сразу, а не через фоновую загрузку
    expect(await controls.restrictionFor(U1)).toBeNull();
    expect(snapshotCalls(fetchMock)).toBe(2);

    mode = 'down';
    controls.invalidate();
    expect(await controls.restrictionFor(U1)).toBeNull(); // ждали и не дождались — прошлый снимок
    expect(snapshotCalls(fetchMock)).toBe(3);
    vi.setSystemTime(new Date('2026-11-10T10:01:30.000Z'));
    // окно повтора прошло, снимок устарел, но ждать больше не нужно — загрузка уходит в фон
    let release: (() => void) | null = null;
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>(r => { release = r; });
      return jsonResponse({ message: 'down' }, 500);
    });
    let settled = false;
    void controls.restrictionFor(U1).then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 0));
    expect(settled).toBe(true);
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledTimes(2));
  });

  it('первая загрузка не удалась — без ограничений (fail-open)', async () => {
    process.env.USER_CONTROLS_IN_TESTS = '1';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('boom'); }));
    expect(await controls.restrictionFor(U1)).toBeNull();
    await expect(controls.assertAllowed(U1, 'app')).resolves.toBeUndefined();
  });

  it('invalidate — следующий вызов загружает заново', async () => {
    process.env.USER_CONTROLS_IN_TESTS = '1';
    const fetchMock = vi.fn(async () => jsonResponse(snapshot()));
    vi.stubGlobal('fetch', fetchMock);
    await controls.restrictionFor(U1);
    controls.invalidate();
    await controls.restrictionFor(U1);
    expect(snapshotCalls(fetchMock)).toBe(2);
  });

  it('isUnlimitedCached и restrictionForCached сами запускают загрузку в фоне', async () => {
    process.env.USER_CONTROLS_IN_TESTS = '1';
    const fetchMock = vi.fn(async () => jsonResponse(snapshot()));
    vi.stubGlobal('fetch', fetchMock);
    expect(controls.isUnlimitedCached(U3)).toBe(false); // снимка ещё нет
    await vi.waitFor(() => expect(controls.isUnlimitedCached(U3)).toBe(true));
    expect(controls.restrictionForCached(U1)?.id).toBe('r1');
    expect(controls.isUnlimitedCached(U1)).toBe(false);
    expect(snapshotCalls(fetchMock)).toBe(1);
  });

  it('restrictionForTelegram ищет по telegram_user_id', async () => {
    controls.__setSnapshotForTests(snapshot());
    expect((await controls.restrictionForTelegram(555001))?.userId).toBe(U1);
    expect((await controls.restrictionForTelegram('555001'))?.userId).toBe(U1);
    expect(await controls.restrictionForTelegram(999)).toBeNull();
    expect(await controls.restrictionForTelegram(null)).toBeNull();
  });

  it('истёкший срок в памяти не действует, не дожидаясь новой загрузки', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    controls.__setSnapshotForTests({
      unlimited: [{ user_id: U3, until: past }],
      restrictions: [{ id: 'r9', user_id: U1, telegram_user_id: 555001, scopes: ['all'], until: past, public_message: null }],
    });
    expect(await controls.restrictionFor(U1)).toBeNull();
    expect(await controls.restrictionForTelegram(555001)).toBeNull();
    expect(controls.isUnlimitedCached(U3)).toBe(false);
  });

  it('неизвестный или пустой userId — не ограничен', async () => {
    controls.__setSnapshotForTests(snapshot());
    expect(await controls.restrictionFor('')).toBeNull();
    expect(await controls.restrictionFor(undefined)).toBeNull();
    expect(await controls.restrictionFor('44444444-4444-4444-8444-444444444444')).toBeNull();
    expect(controls.isUnlimitedCached('')).toBe(false);
  });

  it('assertAllowed бросает 403 ACCOUNT_RESTRICTED с until, restrictedBody — тело 0.2', async () => {
    controls.__setSnapshotForTests(snapshot());
    await expect(controls.assertAllowed(U1, 'site')).resolves.toBeUndefined();
    const error = await controls.assertAllowed(U2, 'purchases').catch(e => e);
    expect(error).toMatchObject({ status: 403, code: 'ACCOUNT_RESTRICTED', message: 'Свяжитесь с поддержкой', extra: { until: '2099-01-01T00:00:00.000Z' } });
    const r = await controls.restrictionFor(U1);
    expect(controls.restrictedBody(r as Restriction)).toEqual({ error: 'Доступ ограничен администратором.', code: 'ACCOUNT_RESTRICTED', until: null });
  });
});

describe('снятие по сроку', () => {
  const restrictionsPath = resolve(__dirname, '../../server/_admin-restrictions.js');
  let saved: unknown;
  beforeEach(() => { saved = require.cache[restrictionsPath]; });
  afterEach(() => {
    if (saved) require.cache[restrictionsPath] = saved as NodeJS.Module;
    else delete require.cache[restrictionsPath];
  });

  it('через 60 с, затем раз в 5 мин снимает просроченные через _admin-restrictions.liftRestriction', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const liftRestriction = vi.fn(async () => ({}));
    require.cache[restrictionsPath] = { id: restrictionsPath, filename: restrictionsPath, loaded: true, exports: { liftRestriction } } as unknown as NodeJS.Module;
    const rows = [{ id: 'r1', user_id: U1, scopes: ['app'], until: '2026-11-01T00:00:00Z', disabled_items: {} }];
    const fetchMock = vi.fn(async () => jsonResponse(rows));
    vi.stubGlobal('fetch', fetchMock);

    controls.startExpiryWatch();
    controls.startExpiryWatch(); // повторный запуск не плодит таймеры
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://db.test/rest/v1/rpc/user_restrictions_due');
    expect(JSON.parse(String(init.body))).toEqual({ p_limit: 50 });
    expect(liftRestriction).toHaveBeenCalledWith(rows[0], 'Срок ограничения истёк', { by: 'auto' });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ошибка снятия одной строки не останавливает остальные', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const liftRestriction = vi.fn().mockRejectedValueOnce(new Error('db')).mockResolvedValueOnce({});
    require.cache[restrictionsPath] = { id: restrictionsPath, filename: restrictionsPath, loaded: true, exports: { liftRestriction } } as unknown as NodeJS.Module;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{ id: 'a', user_id: U1 }, { id: 'b', user_id: U2 }])));
    controls.startExpiryWatch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(liftRestriction).toHaveBeenCalledTimes(2);
  });
});
