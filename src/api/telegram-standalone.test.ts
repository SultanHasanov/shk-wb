import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Бот без сайта (этап A3–A5): старая кнопка «Войти» → поддержка, профиль без «подключить кабинет»,
// индивидуальные заказы и их оплата в боте, вывод реферальных денег через поддержку, ошибки оплаты и кода доступа
// без «войдите заново», сообщение о входе через сайт — только при новой связке.

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  processUpdate: (update: Record<string, unknown>) => Promise<void>;
  notifyMiniAppAuthorized: (telegramId: number, reason?: string) => Promise<void>;
};
const checkout = require('../../server/_bot-checkout.js') as Record<string, (...args: any[]) => Promise<any>>;
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };

const TG = 716976911;
const USER = '9f9f9f9f-1111-2222-3333-444455556666';
const ORDER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SUPPORT_URL = 'https://t.me/roma_denosov';
const PAY_URL = 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=7';
const from = { id: TG, first_name: 'Аня', username: 'pvz_anna' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let updateId = 1000;
const message = (text: string) => ({ update_id: ++updateId, message: { message_id: updateId, text, from, chat: { id: TG, type: 'private' } } });
const press = (data: string) => ({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, from, data, message: { message_id: 50, chat: { id: TG, type: 'private' } } } });

type Call = { method: string; path: string; body: any };
type World = {
  orders: Array<Record<string, unknown>>;
  referral: Record<string, unknown>;
  claimError: string | null;
};
let world: World;
let db: Call[];
let sent: Array<{ method: string; body: Record<string, any> }>;

beforeEach(() => {
  db = []; sent = [];
  userCache.clearTelegramUserCache();
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
  process.env.TELEGRAM_LOCAL_POLLING = '1';
  process.env.STICKER_CLIENT_SECRET = 's'.repeat(32);
  world = {
    orders: [],
    referral: { referral_code: 'ABC123', available_kopecks: 0, earned_kopecks: 0 },
    claimError: null,
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const address = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (!address.startsWith('https://db.test')) {
      sent.push({ method: address.split('/').pop() || '', body: body || {} });
      if (address.endsWith('/getMe')) return json({ ok: true, result: { username: 'shk_test_bot' } });
      return json({ ok: true, result: { message_id: 77 } });
    }
    const path = decodeURIComponent(address.includes('/rest/v1/') ? address.split('/rest/v1/')[1] : `auth:${address.split('/auth/v1/')[1]}`);
    const method = String(init.method || 'GET').toUpperCase();
    db.push({ method, path, body });
    if (path.startsWith('user_telegram_identities?telegram_user_id=eq.')) return json([{ user_id: USER, telegram_user_id: TG }]);
    if (path.startsWith('individual_sticker_orders')) return json(world.orders);
    if (path === 'rpc/ensure_referral_account') return json(world.referral);
    if (path === 'rpc/consume_api_rate_limit') return json(true);
    if (path === 'rpc/claim_user_asset') return world.claimError ? json({ message: world.claimError }, 400) : json(null);
    if (path.startsWith('wallet_accounts')) return json([{ balance_kopecks: 12000 }]);
    if (path.startsWith('telegram_generator_sessions') && method === 'POST') return json([{ ...body }]);
    return json([]);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_LOCAL_POLLING;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.STICKER_CLIENT_SECRET;
});

const screens = () => sent.filter(call => call.method === 'sendMessage' || call.method === 'editMessageText');
const texts = () => screens().map(call => String(call.body.text || ''));
const lastScreen = () => screens().at(-1)!;
const buttons = (call = lastScreen()) => (call.body.reply_markup?.inline_keyboard || []).flat() as Array<Record<string, any>>;
const allButtons = () => screens().flatMap(call => buttons(call));

describe('старая кнопка «Войти» и экран поддержки', () => {
  it('menu:login — экран поддержки с Telegram ID и строкой про связку с сайтом, без входа на сайт', async () => {
    await bot.processUpdate(press('menu:login'));
    const text = texts().join('\n');
    expect(text).toContain('Поддержка');
    expect(text).toContain(`<code>${TG}</code>`);
    expect(text).toContain('Покупали на сайте shk-wb.ru? Напишите — свяжем сайт с ботом');
    expect(text).not.toMatch(/[Кк]абинет|У меня уже есть/);
    expect(allButtons().some(button => button.web_app)).toBe(false);
    expect(allButtons().some(button => button.url === SUPPORT_URL)).toBe(true);
    // Прежний экран входа ставил состояние мастера без экрана — следующее сообщение молча сбрасывалось.
    expect(db.some(call => call.method === 'POST' && call.path.startsWith('telegram_generator_sessions'))).toBe(false);
  });

  it('menu:support показывает тот же экран', async () => {
    await bot.processUpdate(press('menu:support'));
    expect(texts().join('\n')).toContain(`<code>${TG}</code>`);
  });
});

describe('профиль', () => {
  it('без кнопки «Подключить основной кабинет» и без запроса к Auth; «Мои заказы» — только при заказах', async () => {
    await bot.processUpdate(press('menu:profile'));
    expect(allButtons().some(button => button.web_app)).toBe(false);
    expect(allButtons().some(button => button.callback_data === 'orders:list')).toBe(false);
    // isTechnicalTelegramUser больше не вызывается: сбой Auth не должен ломать профиль.
    expect(db.some(call => call.path.startsWith('auth:'))).toBe(false);

    sent = [];
    world.orders = [{ id: ORDER }];
    await bot.processUpdate(press('menu:profile'));
    expect(allButtons().some(button => button.callback_data === 'orders:list')).toBe(true);
  });
});

describe('индивидуальные заказы в боте', () => {
  it('нет заказов — короткий ответ и поддержка, без «подключите кабинет»', async () => {
    await bot.processUpdate(message('/orders'));
    expect(texts().join('\n')).toContain('Индивидуальных заказов пока нет');
    expect(texts().join('\n')).not.toMatch(/кабинет/i);
    expect(allButtons().some(button => button.url === SUPPORT_URL)).toBe(true);
    expect(allButtons().some(button => button.web_app)).toBe(false);
  });

  it('неоплаченный — сумма по-человечески и кнопка оплаты в боте; оплаченный — PDF и необязательная ссылка на сайт', async () => {
    world.orders = [
      { id: ORDER, title: 'Склад', quantity: 300, amount_due: 450, status: 'pending_payment' },
      { id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', title: 'Март', quantity: 600, amount_due: 0, status: 'paid' },
    ];
    await bot.processUpdate(message('/orders'));
    const [unpaid, paid] = screens();
    expect(unpaid.body.text).toContain('300 стикеров · 450 ₽');
    expect(buttons(unpaid)).toEqual([{ text: '💳 Оплатить 450 ₽', callback_data: `ord:pay:${ORDER}` }]);
    expect(Buffer.byteLength(`ord:pay:${ORDER}`)).toBeLessThanOrEqual(64);
    expect(buttons(paid).filter(button => String(button.text).startsWith('📄 PDF')).length).toBe(2);
    expect(buttons(paid).find(button => button.web_app)?.text).toBe('🌐 Каждый стикер — на сайте');
    expect(buttons(paid).at(-1)).toEqual({ text: '☰ Меню', callback_data: 'menu:home' });
  });

  it('«Оплатить» — ссылка на ЮKassa прямо в боте', async () => {
    world.orders = [{ title: 'Склад', quantity: 300, amount_due: 450 }];
    const pay = vi.spyOn(checkout, 'createIndividualPayment').mockResolvedValue({ confirmationUrl: PAY_URL, token: 't' });
    await bot.processUpdate(press(`ord:pay:${ORDER}`));
    expect(pay).toHaveBeenCalledWith({ userId: USER, orderId: ORDER });
    const screen = lastScreen();
    expect(screen.method).toBe('editMessageText');
    expect(screen.body.text).toContain('Оплата заказа «Склад»');
    expect(buttons(screen)[0]).toEqual({ text: '💳 Перейти к оплате 450 ₽', url: PAY_URL });
  });

  it('устаревшая связка (аккаунт объединён) — сброс кеша и один повтор, а не «войдите заново»', async () => {
    world.orders = [{ title: 'Склад', quantity: 300, amount_due: 450 }];
    const pay = vi.spyOn(checkout, 'createIndividualPayment')
      .mockRejectedValueOnce(Object.assign(new Error('Account not found'), { code: 'ACCOUNT_NOT_FOUND', status: 404 }))
      .mockResolvedValueOnce({ confirmationUrl: PAY_URL, token: 't' });
    await bot.processUpdate(press(`ord:pay:${ORDER}`));
    expect(pay).toHaveBeenCalledTimes(2);
    expect(db.filter(call => call.path.startsWith('user_telegram_identities?telegram_user_id=eq.')).length).toBeGreaterThanOrEqual(2);
    expect(buttons()[0].url).toBe(PAY_URL);
  });

  it('к оплате 0 ₽ — «Получить PDF» вместо «Оплатить 0 ₽»; после нажатия PDF сразу, без кнопки с относительным адресом', async () => {
    world.orders = [{ id: ORDER, title: 'Склад', quantity: 300, amount_due: 0, status: 'pending_payment' }];
    await bot.processUpdate(message('/orders'));
    expect(lastScreen().body.text).toContain('доплата не нужна');
    expect(buttons()[0]).toEqual({ text: '📄 Получить PDF', callback_data: `ord:pay:${ORDER}` });

    sent = [];
    // Обработчик уже закрыл заказ (completeOrder) — в базе он paid.
    world.orders = [{ id: ORDER, title: 'Склад', quantity: 300, amount_due: 0, status: 'paid' }];
    vi.spyOn(checkout, 'createIndividualPayment').mockResolvedValue({ confirmationUrl: null, token: 't', paid: true });
    await bot.processUpdate(press(`ord:pay:${ORDER}`));
    const screen = lastScreen();
    expect(screen.body.text).toContain('Доплата не нужна, заказ закрыт');
    expect(buttons(screen).filter(button => String(button.text).startsWith('📄 PDF')).length).toBe(1);
    expect(buttons(screen).some(button => 'url' in button && !String(button.url).startsWith('https://'))).toBe(false);
    expect(buttons(screen).some(button => button.callback_data === 'orders:list')).toBe(true);
  });

  it('заказ уже оплачен — так и говорим, с кнопкой «Мои заказы»', async () => {
    vi.spyOn(checkout, 'createIndividualPayment').mockRejectedValue(Object.assign(new Error('Заказ не найден или уже оплачен'), { status: 404 }));
    await bot.processUpdate(press(`ord:pay:${ORDER}`));
    expect(lastScreen().body.text).toContain('уже оплачен или отменён');
    expect(buttons().some(button => button.callback_data === 'orders:list')).toBe(true);
  });
});

describe('ошибки пополнения без сырого текста', () => {
  it('сбой — общий текст, «Попробовать снова» и поддержка; исходная ошибка не видна', async () => {
    vi.spyOn(checkout, 'createTopupPayment').mockRejectedValue(Object.assign(new Error('Не удалось создать оплату (502)'), { status: 502 }));
    await bot.processUpdate(press('tp:500'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('Не получилось создать оплату. Деньги не списаны');
    expect(text).not.toContain('502');
    expect(buttons().map(button => button.callback_data || button.url)).toEqual(['topup:home', SUPPORT_URL, 'menu:home']);
  });

  it('лимит попыток — подождать 10 минут, без кнопки повтора; ограничение — его текст', async () => {
    vi.spyOn(checkout, 'createTopupPayment').mockRejectedValue(Object.assign(new Error('Слишком много запросов'), { status: 429 }));
    await bot.processUpdate(press('tp:500'));
    expect(lastScreen().body.text).toContain('Подождите 10 минут');
    expect(buttons().some(button => button.callback_data === 'topup:home')).toBe(false);

    vi.spyOn(checkout, 'createTopupPayment').mockRejectedValue(Object.assign(new Error('Покупки для аккаунта ограничены'), { status: 403, code: 'ACCOUNT_RESTRICTED' }));
    await bot.processUpdate(press('tp:500'));
    expect(lastScreen().body.text).toContain('Покупки для аккаунта ограничены');
  });

  it('устаревшая связка — повтор с новым аккаунтом, человек видит ссылку на оплату', async () => {
    const topup = vi.spyOn(checkout, 'createTopupPayment')
      .mockRejectedValueOnce(Object.assign(new Error('Account not found'), { code: 'ACCOUNT_NOT_FOUND', status: 404 }))
      .mockResolvedValueOnce({ confirmationUrl: PAY_URL, token: 't' });
    await bot.processUpdate(press('tp:500'));
    expect(topup).toHaveBeenCalledTimes(2);
    expect(texts().join('\n')).not.toMatch(/[Кк]абинет|войдите/);
    expect(buttons()[0].url).toBe(PAY_URL);
  });
});

describe('приглашения: вывод на карту через поддержку', () => {
  it('меньше 500 ₽ — только строка, от 500 ₽ — кнопка-ссылка в поддержку; Mini App кабинета нет', async () => {
    world.referral = { referral_code: 'ABC123', available_kopecks: 12000, earned_kopecks: 12000 };
    await bot.processUpdate(press('menu:ref'));
    expect(lastScreen().body.text).toContain('Вывод на карту — от 500 ₽, через поддержку.');
    expect(buttons().some(button => button.web_app)).toBe(false);
    expect(buttons().some(button => button.url === SUPPORT_URL)).toBe(false);

    world.referral = { referral_code: 'ABC123', available_kopecks: 60000, earned_kopecks: 60000 };
    await bot.processUpdate(press('menu:ref'));
    expect(buttons().find(button => button.url === SUPPORT_URL)?.text).toBe('🏦 Вывести на карту — через поддержку');
    expect(buttons().some(button => button.callback_data === 'ref:towallet')).toBe(true);
  });
});

describe('код доступа: ответы без сайта и с кнопками', () => {
  it('чужой код — про поддержку и перенос, кнопка поддержки; ввод закончен', async () => {
    world.claimError = 'Asset belongs to another user';
    await bot.processUpdate(press('code:enter'));
    sent = [];
    await bot.processUpdate(message('654321'));
    expect(texts().join('\n')).toMatch(/другому аккаунту.*напишите в поддержку/s);
    expect(allButtons().some(button => button.url === SUPPORT_URL)).toBe(true);
    expect(db.some(call => call.method === 'DELETE' && call.path.startsWith('telegram_generator_sessions'))).toBe(true);
  });

  it('опечатка — ждём код дальше, под ответом «Отмена» и поддержка', async () => {
    world.claimError = 'Asset not found';
    await bot.processUpdate(press('code:enter'));
    sent = [];
    await bot.processUpdate(message('654321'));
    expect(texts().join('\n')).toContain('Код не найден');
    expect(allButtons().map(button => button.callback_data || button.url)).toEqual(['gen:cancel', SUPPORT_URL]);
  });
});

describe('вход через сайт (notifyMiniAppAuthorized)', () => {
  it('обычный вход в Mini App — без сообщения в чат и без сброса черновика', async () => {
    await bot.notifyMiniAppAuthorized(TG);
    await bot.notifyMiniAppAuthorized(TG, 'login');
    await bot.notifyMiniAppAuthorized(TG, 'created');
    expect(screens()).toEqual([]);
    expect(db.some(call => call.method === 'DELETE' && call.path.startsWith('telegram_generator_sessions'))).toBe(false);
  });

  it('Telegram привязан к аккаунту сайта — черновик сброшен, сообщение без «кабинета»', async () => {
    await bot.notifyMiniAppAuthorized(TG, 'linked');
    expect(db.some(call => call.method === 'DELETE' && call.path.startsWith('telegram_generator_sessions'))).toBe(true);
    const text = texts().join('\n');
    expect(text).toContain('Telegram привязан к вашему аккаунту на сайте');
    expect(text).not.toMatch(/[Кк]абинет/);
  });
});
