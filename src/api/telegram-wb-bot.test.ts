import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  escapeHtml: (value: unknown) => string;
  publicUrl: (path: string) => string;
  validWebhookSecret: (req: {headers: Record<string, string>}) => boolean;
  HOME_KEYBOARD: {keyboard: Array<Array<Record<string, any>>>};
};
const generation = require('../../server/_sticker-generation.js') as {
  normalizePrefix: (value: unknown) => string;
};

describe('Telegram sticker generator bot', () => {
  afterEach(() => {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.VERCEL_URL;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  it('проверяет секрет Telegram webhook', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-test-secret';
    expect(bot.validWebhookSecret({ headers: { 'x-telegram-bot-api-secret-token': 'telegram-test-secret' } })).toBe(true);
    expect(bot.validWebhookSecret({ headers: { 'x-telegram-bot-api-secret-token': 'telegram-wrong-value' } })).toBe(false);
  });

  it('строит абсолютные Mini App URL', () => {
    process.env.PUBLIC_APP_URL = 'https://example.test/';
    expect(bot.publicUrl('/login')).toBe('https://example.test/login');
    expect(bot.HOME_KEYBOARD.keyboard[3][0].web_app.url).toMatch(/^https:\/\//);
    expect(bot.HOME_KEYBOARD.keyboard.flat().some(button => button.text === '👤 Аккаунт')).toBe(true);
  });

  it('валидирует префикс коробки и экранирует HTML', () => {
    expect(generation.normalizePrefix(' trbx-1 ')).toBe('TRBX-1');
    expect(generation.normalizePrefix('плохой')).toBe('');
    expect(bot.escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });
});
