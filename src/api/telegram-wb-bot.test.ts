import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  escapeHtml: (value: unknown) => string;
  publicUrl: (path: string) => string;
  validWebhookSecret: (req: {headers: Record<string, string>}) => boolean;
  HOME_KEYBOARD: {keyboard: Array<Array<Record<string, any>>>};
  packageKeyboard: () => {inline_keyboard: Array<Array<Record<string, any>>>};
  balanceKeyboard: () => {inline_keyboard: Array<Array<Record<string, any>>>};
  claimErrorText: (error: unknown) => string | null;
  formatPhone: (value: unknown) => string;
  maskWbPhone: (value: unknown) => string;
  reviewStars: (value: string) => number[];
  reviewText: (review: Record<string, unknown>, position: number, total: number) => string;
  reviewAuthorIds: (review: Record<string, unknown>) => number[];
  findPickupEvents: (goods: Array<Record<string, unknown>>, userIds: number | number[]) => Array<Record<string, unknown>>;
};
const generation = require('../../server/_sticker-generation.js') as {
  normalizePrefix: (value: unknown) => string;
};
const telegramAccount = require('../../server/_telegram-account.js') as {
  hasValuableAccountRows: (rows: Record<string, Array<Record<string, unknown>>>) => boolean;
};

describe('Telegram sticker generator bot', () => {
  afterEach(() => {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.VERCEL_URL;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  it('предлагает ввести код при покупке и в остатке', () => {
    expect(bot.packageKeyboard().inline_keyboard.flat().some(button => button.callback_data === 'code:enter')).toBe(true);
    expect(bot.balanceKeyboard().inline_keyboard.flat().map(button => button.callback_data)).toEqual(['code:enter', 'code:buy']);
  });

  it('переводит ошибки привязки кода на понятный язык', () => {
    expect(bot.claimErrorText({ details: { message: 'Asset not found' } })).toMatch(/не найден/);
    expect(bot.claimErrorText({ details: { message: 'Asset belongs to another user' } })).toMatch(/другому аккаунту/);
    expect(bot.claimErrorText(new Error('Supabase request failed (500)'))).toBeNull();
  });

  it('проверяет секрет Telegram webhook', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-test-secret';
    expect(bot.validWebhookSecret({ headers: { 'x-telegram-bot-api-secret-token': 'telegram-test-secret' } })).toBe(true);
    expect(bot.validWebhookSecret({ headers: { 'x-telegram-bot-api-secret-token': 'telegram-wrong-value' } })).toBe(false);
  });

  it('строит абсолютные Mini App URL', () => {
    process.env.PUBLIC_APP_URL = 'https://example.test/';
    expect(bot.publicUrl('/login')).toBe('https://example.test/login');
    expect(bot.HOME_KEYBOARD.keyboard.flat().find(button => button.web_app)?.web_app.url).toMatch(/^https:\/\//);
    expect(bot.HOME_KEYBOARD.keyboard.flat().some(button => button.text === '👤 Аккаунт')).toBe(true);
  });

  it('валидирует префикс коробки и экранирует HTML', () => {
    expect(generation.normalizePrefix(' trbx-1 ')).toBe('TRBX-1');
    expect(generation.normalizePrefix('плохой')).toBe('');
    expect(bot.escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });

  it('формирует фильтры, страницы отзывов и кнопку раздела', () => {
    expect(bot.reviewStars('all')).toEqual([1, 2, 3, 4, 5]);
    expect(bot.reviewStars('3')).toEqual([3]);
    expect(bot.reviewStars('9')).toEqual([]);
    expect(bot.formatPhone(79991234567)).toBe('+7 999 123-45-67');
    expect(bot.maskWbPhone(79600003574)).toBe('+7 960 ***-35-74');
    expect(bot.maskWbPhone(79201112233)).toBe('+7 920 111-22-33');
    expect(bot.reviewText({ stars: 1, comment: '<плохо>', rate_dt: '2026-10-06T10:00:00+03:00' }, 1, 6)).toContain('&lt;плохо&gt;');
    expect(bot.HOME_KEYBOARD.keyboard.flat().some(button => button.text === '⭐ Отзывы ПВЗ')).toBe(true);
  });

  it('находит выдачи автора отзыва и сортирует новые первыми', () => {
    const result = bot.findPickupEvents([
      { buyer_id: 7, status: 'GOODS_READY', status_updated: '2026-10-06T10:00:00+03:00' },
      { buyer_id: 7, status: 'GOODS_RECIEVED', status_updated: '2026-10-05T10:00:00+03:00' },
      { buyer_sid: '7', status: 'GOODS_RECIEVED', status_updated: '2026-10-06T10:00:00+03:00' },
      { buyer: { user_sid: '70' }, status: 'GOODS_RECEIVED', status_updated: '2026-10-04T10:00:00+03:00' },
      { buyer_id: 8, status: 'GOODS_RECIEVED', status_updated: '2026-10-07T10:00:00+03:00' },
    ], [7, 70]);
    expect(result).toHaveLength(3);
    expect(result[0].status_updated).toBe('2026-10-06T10:00:00+03:00');
  });

  it('не принимает идентификатор оцениваемого сотрудника за автора отзыва', () => {
    expect(bot.reviewAuthorIds({ user_id: 7, user_sid: '7', employee_id: 90 })).toEqual([7]);
    expect(bot.reviewAuthorIds({ user_id: 0, user_sid: '0', employee_id: 90, employee_user_sid: '90' })).toEqual([]);
  });

  it('декодирует sid клиента из id обезличенного отзыва (первые 8 hex)', () => {
    expect(bot.reviewAuthorIds({ id: '0413cf90-1501-0000-bdda-b4b4ba877516', user_id: 0, user_sid: '0' })).toEqual([68407184]);
    expect(bot.reviewAuthorIds({ id: '126daddf-1501-0000-104c-ced0905057cd', user_id: 0, user_sid: '0' })).toEqual([309177823]);
    expect(bot.reviewAuthorIds({ id: 'not-a-uuid', user_id: 0, user_sid: '0' })).toEqual([]);
  });

  it('учитывает и выдачи, и отказы клиента', () => {
    const result = bot.findPickupEvents([
      { buyer: { user_sid: '5' }, status: 'GOODS_RECIEVED', status_updated: '2026-10-05T10:00:00+03:00' },
      { buyer: { user_sid: '5' }, status: 'GOODS_RETURNED', status_updated: '2026-10-06T10:00:00+03:00' },
      { buyer: { user_sid: '5' }, status: 'GOODS_READY', status_updated: '2026-10-07T10:00:00+03:00' },
    ], [5]);
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('GOODS_RETURNED');
  });

  it('отличает пустой Telegram-кабинет от кабинета с ценными данными', () => {
    const empty = { orders: [], stickers: [], licenses: [], cellLicenses: [], history: [], requests: [], ledger: [], withdrawals: [], invited: [], referrals: [{ available_kopecks: 0 }] };
    expect(telegramAccount.hasValuableAccountRows(empty)).toBe(false);
    expect(telegramAccount.hasValuableAccountRows({ ...empty, orders: [{ id: 'paid' }] })).toBe(true);
    expect(telegramAccount.hasValuableAccountRows({ ...empty, referrals: [{ earned_kopecks: 100 }] })).toBe(true);
  });
});
