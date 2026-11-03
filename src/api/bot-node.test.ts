import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const botRole = require('../../selfhost/bot-role.cjs') as {
  allowsApi: (relative: string, query?: Record<string, string>) => boolean;
  role: () => 'site' | 'bot';
};
const rpc = require('../../server/_bot-rpc.js') as {
  callBot: (fn: string, ...args: unknown[]) => Promise<unknown>;
  validRpcSecret: (header: unknown) => boolean;
};
const internalBot = require('../../api/internal/bot.js') as (req: Record<string, any>, res: Record<string, any>) => Promise<unknown>;
const { telegramRequest } = require('../../server/_telegram-api.js') as {
  telegramRequest: (method: string, body: Record<string, unknown>) => Promise<unknown>;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function res() {
  return { code: 0, body: null as unknown, status(value: number) { this.code = value; return this; }, json(value: unknown) { this.body = value; return this; }, type() { return this; }, send(value: unknown) { this.body = value; return this; } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ['BOT_ROLE', 'BOT_RPC_URL', 'BOT_RPC_SECRET', 'STICKER_MEDIA_BASE', 'TELEGRAM_API_BASE', 'TELEGRAM_BOT_TOKEN']) delete process.env[key];
});

describe('роль процесса', () => {
  it('сайт отдаёт всё, узел бота — только вебхук, стикеры и RPC', () => {
    expect(botRole.role()).toBe('site');
    expect(botRole.allowsApi('cabinet')).toBe(true);
    process.env.BOT_ROLE = 'bot';
    expect(botRole.role()).toBe('bot');
    expect(botRole.allowsApi('cabinet')).toBe(false);
    expect(botRole.allowsApi('payments')).toBe(false);
    expect(botRole.allowsApi('telegram/webhook')).toBe(true);
    expect(botRole.allowsApi('auth', { action: 'bot' })).toBe(true);
    expect(botRole.allowsApi('auth', { action: 'login' })).toBe(false);
    expect(botRole.allowsApi('stickers/image')).toBe(true);
    expect(botRole.allowsApi('stickers/pdf')).toBe(true);
    expect(botRole.allowsApi('internal/bot')).toBe(true);
  });
});

describe('RPC сайта к узлу бота', () => {
  it('с BOT_RPC_URL шлёт POST с секретом и возвращает результат узла', async () => {
    process.env.BOT_RPC_URL = 'https://tg.shk-wb.ru:88/rpc';
    process.env.BOT_RPC_SECRET = 's'.repeat(32);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await rpc.callBot('notifyMiniAppAuthorized', 777)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://tg.shk-wb.ru:88/rpc');
    expect(init.headers['X-Bot-Rpc-Secret']).toBe('s'.repeat(32));
    expect(JSON.parse(init.body)).toEqual({ fn: 'notifyMiniAppAuthorized', args: [777] });
  });

  it('неизвестную функцию не зовёт', async () => {
    await expect(rpc.callBot('handleTelegramUpdate')).rejects.toThrow('Unknown bot function');
  });

  it('узел проверяет секрет и имя функции', async () => {
    process.env.BOT_ROLE = 'bot';
    process.env.BOT_RPC_SECRET = 'k'.repeat(32);
    expect(rpc.validRpcSecret('k'.repeat(32))).toBe(true);
    expect(rpc.validRpcSecret('k'.repeat(31) + 'x')).toBe(false);
    expect(rpc.validRpcSecret('')).toBe(false);

    const bad = res();
    await internalBot({ method: 'POST', headers: { 'x-bot-rpc-secret': 'wrong' }, body: { fn: 'notifyMiniAppAuthorized', args: [1] } }, bad);
    expect(bad.code).toBe(401);
    const unknown = res();
    await internalBot({ method: 'POST', headers: { 'x-bot-rpc-secret': 'k'.repeat(32) }, body: { fn: 'handleTelegramUpdate', args: [] } }, unknown);
    expect(unknown.code).toBe(400);

    delete process.env.BOT_ROLE;
    const site = res();
    await internalBot({ method: 'POST', headers: { 'x-bot-rpc-secret': 'k'.repeat(32) }, body: { fn: 'notifyMiniAppAuthorized', args: [1] } }, site);
    expect(site.code).toBe(404);
  });
});

describe('картинки стикеров с узла бота', () => {
  it('STICKER_MEDIA_BASE важнее релея, без обоих URL не меняется', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true, result: {} })));
    vi.stubGlobal('fetch', fetchMock);
    const photo = 'https://shk-wb.ru/api/stickers/image?qr=1&token=t';

    process.env.STICKER_MEDIA_BASE = 'https://tg.shk-wb.ru:88/media/';
    await telegramRequest('sendPhoto', { chat_id: 1, photo });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).photo).toBe('https://tg.shk-wb.ru:88/media/api/stickers/image?qr=1&token=t');
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`);

    delete process.env.STICKER_MEDIA_BASE;
    await telegramRequest('sendPhoto', { chat_id: 1, photo });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).photo).toBe(photo);
  });
});
