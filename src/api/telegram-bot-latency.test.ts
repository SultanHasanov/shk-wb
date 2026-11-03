import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { fetchWithRetry, isNetworkError } = require('../../server/_fetch-retry.js') as {
  fetchWithRetry: (url: string, options?: RequestInit, settings?: { timeoutMs?: number; retries?: number }) => Promise<Response>;
  isNetworkError: (error: unknown) => boolean;
};
const { retriesFor } = require('../../server/_supabase.js') as {
  retriesFor: (path: string, options: { method?: string; headers?: Record<string, string> }) => number;
};
const userCache = require('../../server/_telegram-user-cache.js') as {
  cachedUser: (id: number) => { userId: string | null } | undefined;
  clearTelegramUserCache: () => void;
  forgetSiteUser: (userId: string) => void;
  forgetTelegramUser: (id: number) => void;
  remember: (id: number, userId: string | null) => string | null;
};
const bot = require('../../server/_telegram-wb-bot.js') as {
  claimUpdate: (id: number) => Promise<boolean>;
  clearSession: (id: number) => Promise<void>;
  findUser: (id: number) => Promise<string | null>;
  getSession: (id: number) => Promise<Record<string, any> | null>;
  handleTelegramUpdate: (req: Record<string, any>, res: Record<string, any>) => Promise<unknown>;
  saveSession: (from: { id: number }, chatId: number, state: string, draft?: Record<string, unknown>) => Promise<Record<string, any>>;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function networkError() {
  const error = new TypeError('fetch failed');
  (error as any).cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
  return error;
}

describe('fetch с таймаутом и повтором', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('повторяет один раз после сетевой ошибки и отдаёт ответ второй попытки', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await fetchWithRetry('https://example.test/x', {}, { retries: 1 });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    warn.mockRestore();
  });

  it('без повторов отдаёт ошибку сразу, а HTTP-ответ никогда не повторяет', async () => {
    const failing = vi.fn().mockRejectedValue(networkError());
    vi.stubGlobal('fetch', failing);
    await expect(fetchWithRetry('https://example.test/x', {}, { retries: 0 })).rejects.toThrow('fetch failed');
    expect(failing).toHaveBeenCalledTimes(1);

    const http500 = vi.fn().mockResolvedValue(jsonResponse({ error: 'x' }, 500));
    vi.stubGlobal('fetch', http500);
    const response = await fetchWithRetry('https://example.test/x', {}, { retries: 1 });
    expect(response.status).toBe(500);
    expect(http500).toHaveBeenCalledTimes(1);
  });

  it('отличает сетевые ошибки от остальных', () => {
    expect(isNetworkError(networkError())).toBe(true);
    expect(isNetworkError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(isNetworkError(new Error('Supabase request failed (400)'))).toBe(false);
  });

  it('в Supabase повторяет только чтение, удаление и upsert', () => {
    expect(retriesFor('telegram_bot_subscribers?select=*', {})).toBe(1);
    expect(retriesFor('telegram_generator_sessions?telegram_user_id=eq.1', { method: 'DELETE' })).toBe(1);
    expect(retriesFor('telegram_bot_subscribers?on_conflict=telegram_user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' } })).toBe(1);
    expect(retriesFor('user_generation_history', { method: 'POST' })).toBe(0);
    expect(retriesFor('rpc/reserve_sticker_generation', { method: 'POST' })).toBe(0);
  });
});

describe('картинки стикеров через релей', () => {
  const { telegramRequest } = require('../../server/_telegram-api.js') as {
    telegramRequest: (method: string, body: Record<string, unknown>) => Promise<unknown>;
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_API_BASE;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('подменяет URL картинки на путь /media/<путь> у релея, чужие URL не трогает', async () => {
    process.env.TELEGRAM_API_BASE = 'https://tg.shk-wb.ru:88';
    process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true, result: {} })));
    vi.stubGlobal('fetch', fetchMock);
    await telegramRequest('sendPhoto', { chat_id: 1, photo: 'https://shk-wb.ru/api/stickers/image?code=1&sig=abc' });
    await telegramRequest('sendPhoto', { chat_id: 1, photo: 'https://example.com/pic.png' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://tg.shk-wb.ru:88/api/sendPhoto');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).photo).toBe('https://tg.shk-wb.ru:88/media/api/stickers/image?code=1&sig=abc');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).photo).toBe('https://example.com/pic.png');
  });
});

describe('кеш связки telegram → user', () => {
  beforeEach(() => userCache.clearTelegramUserCache());

  it('помнит результат, забывает по привязке и отвязке', () => {
    userCache.remember(1, 'u-1');
    userCache.remember(2, null);
    expect(userCache.cachedUser(1)).toEqual({ userId: 'u-1' });
    expect(userCache.cachedUser(2)).toEqual({ userId: null });
    expect(userCache.cachedUser(3)).toBeUndefined();
    userCache.forgetTelegramUser(2);
    expect(userCache.cachedUser(2)).toBeUndefined();
    userCache.forgetSiteUser('u-1');
    expect(userCache.cachedUser(1)).toBeUndefined();
  });
});

describe('горячий путь бота', () => {
  const env = { SUPABASE_URL: 'https://sb.test', SUPABASE_SECRET_KEY: 'k', TELEGRAM_WEBHOOK_SECRET: 's'.repeat(32), TELEGRAM_BOT_TOKEN: '1:' + 'a'.repeat(30), TELEGRAM_API_BASE: 'https://relay.test' };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Object.assign(process.env, env);
    userCache.clearTelegramUserCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(env)) delete process.env[key];
  });

  it('сессия: после сохранения читается без запроса, после очистки — тоже, из базы только при промахе', async () => {
    const telegramId = 777001;
    fetchMock.mockResolvedValueOnce(jsonResponse([{ telegram_user_id: telegramId, state: 'choose_kind', draft: { a: 1 }, updated_at: new Date().toISOString() }]));
    const saved = await bot.saveSession({ id: telegramId }, telegramId, 'choose_kind', { a: 1 });
    expect(saved.state).toBe('choose_kind');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const session = await bot.getSession(telegramId);
    expect(session?.draft).toEqual({ a: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Копия: правка черновика на месте не меняет кеш.
    session!.draft.a = 2;
    expect((await bot.getSession(telegramId))?.draft).toEqual({ a: 1 });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await bot.clearSession(telegramId);
    expect(await bot.getSession(telegramId)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    expect(await bot.getSession(777002)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('связка telegram → user читается из базы один раз', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ user_id: 'u-9' }]));
    expect(await bot.findUser(777003)).toBe('u-9');
    expect(await bot.findUser(777003)).toBe('u-9');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('повтор апдейта отсекается памятью без запроса, а при недоступной базе апдейт не считается своим', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ update_id: 5001 }]));
    expect(await bot.claimUpdate(5001)).toBe(true);
    expect(await bot.claimUpdate(5001)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValueOnce(new Error('Supabase request failed (503)'));
    await expect(bot.claimUpdate(5002)).rejects.toThrow('503');
    fetchMock.mockResolvedValueOnce(jsonResponse([{ update_id: 5002 }]));
    expect(await bot.claimUpdate(5002)).toBe(true);
  });

  it('вебхук отвечает 200 сразу после закрепления апдейта, обработка идёт в фоне', async () => {
    let releaseHandler: (value: Response) => void = () => {};
    const handlerCall = new Promise<Response>(resolve => { releaseHandler = resolve; });
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ update_id: 6001 }])) // claimUpdate
      .mockImplementation(() => handlerCall); // всё остальное ждёт, пока тест не отпустит
    const res = { code: 0, body: null as unknown, status(value: number) { this.code = value; return this; }, json(value: unknown) { this.body = value; return this; } };
    const req = { headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET }, body: { update_id: 6001, message: { from: { id: 777004 }, chat: { id: 777004, type: 'private' }, text: '/help' } } };
    await bot.handleTelegramUpdate(req, res);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ ok: true });
    releaseHandler(jsonResponse({ ok: true, result: { message_id: 1 } }));
  });

  it('дубликат и недоступная база: 200 с пометкой и 502 соответственно', async () => {
    const res = () => ({ code: 0, body: null as unknown, status(value: number) { this.code = value; return this; }, json(value: unknown) { this.body = value; return this; } });
    const headers = { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET };
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const duplicate = res();
    await bot.handleTelegramUpdate({ headers, body: { update_id: 6002 } }, duplicate);
    expect(duplicate.body).toEqual({ ok: true, duplicate: true });

    fetchMock.mockRejectedValueOnce(new Error('Supabase request failed (503)'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = res();
    await bot.handleTelegramUpdate({ headers, body: { update_id: 6003 } }, failed);
    expect(failed.code).toBe(502);
    errorSpy.mockRestore();
  });
});
