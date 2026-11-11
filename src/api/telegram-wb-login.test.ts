import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Вход в WB и отзывы в боте (этап F): один текст входа, шаг кода без полного номера, «Выслать код заново»,
// «Другой номер», срок ожидания 15 минут, смена ПВЗ без выхода, «Выйти из WB» с подтверждением, ошибки WB
// без сырого текста (401 / 403 / сбой), цена на кнопке «Кто поставил», без списания при сбое выдач.

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  processUpdate: (update: Record<string, unknown>) => Promise<void>;
  afterWalletTopup: (order: Record<string, unknown>, noticeId?: number | null) => Promise<boolean>;
};
const wbPvz = require('../../server/_wb-pvz.js') as Record<string, any>;
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };

const USER = '9f9f9f9f-1111-2222-3333-444455556666';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const wbError = (status: number, message = `Ошибка WB HTTP ${status}`) => new wbPvz.WbPvzError(message, status);

let tgSeq = 727000000;
let TG = 0;
let from = { id: 0, first_name: 'Аня' };
let updateId = 19000;
const message = (text: string) => ({ update_id: ++updateId, message: { message_id: updateId, text, from, chat: { id: TG, type: 'private' } } });
const press = (data: string, messageId = 50) => ({
  update_id: ++updateId,
  callback_query: { id: `cb${updateId}`, from, data, message: { message_id: messageId, chat: { id: TG, type: 'private' } } },
});

type Wb = { state: string; session: Record<string, any>; updated_at?: string };
let world: { wb: Wb | null; session: Record<string, unknown> | null; balance: number };
let db: Array<{ method: string; path: string; body: any }>;
let sent: Array<{ method: string; body: Record<string, any> }>;

beforeEach(() => {
  TG = ++tgSeq;
  from = { id: TG, first_name: 'Аня' };
  db = []; sent = [];
  userCache.clearTelegramUserCache();
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
  process.env.TELEGRAM_LOCAL_POLLING = '1';
  process.env.STICKER_CLIENT_SECRET = 's'.repeat(32);
  world = { wb: null, session: null, balance: 10000 };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const address = String(url);
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null;
    if (!address.startsWith('https://db.test')) {
      sent.push({ method: address.split('/').pop() || '', body: body || {} });
      return json({ ok: true, result: { message_id: 88 } });
    }
    const path = decodeURIComponent(address.split('/rest/v1/')[1] || address);
    const method = String(init.method || 'GET').toUpperCase();
    db.push({ method, path, body });
    if (path.startsWith('user_telegram_identities')) return json([{ user_id: USER, telegram_user_id: TG }]);
    if (path.startsWith('telegram_generator_sessions') && method === 'GET') return json(world.session ? [world.session] : []);
    if (path.startsWith('telegram_generator_sessions') && method === 'POST') { world.session = { ...body }; return json([{ ...body }]); }
    if (path.startsWith('telegram_generator_sessions') && method === 'DELETE') { world.session = null; return json([]); }
    if (path.startsWith('telegram_wb_connections') && method === 'GET') {
      return json(world.wb ? [{ telegram_user_id: TG, state: world.wb.state, updated_at: world.wb.updated_at, encrypted_session: wbPvz.encryptSession(world.wb.session) }] : []);
    }
    if (path.startsWith('telegram_wb_connections') && method === 'POST') {
      world.wb = { state: body.state, session: body.encrypted_session ? wbPvz.decryptSession(body.encrypted_session) : {}, updated_at: body.updated_at };
      return json([body]);
    }
    if (path.startsWith('telegram_wb_connections') && method === 'DELETE') { world.wb = null; return json([]); }
    if (path.startsWith('wallet_accounts')) return json([{ balance_kopecks: world.balance }]);
    if (path === 'rpc/bot_review_spend') return json({ ok: true, free: false, balance: world.balance - body.p_kopecks });
    return json([]);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ['TELEGRAM_LOCAL_POLLING', 'TELEGRAM_BOT_TOKEN', 'STICKER_CLIENT_SECRET']) delete process.env[key];
});

const screens = () => sent.filter(call => call.method === 'sendMessage' || call.method === 'editMessageText');
const lastScreen = () => screens().at(-1)!;
const allText = () => screens().map(call => String(call.body.text)).join('\n');
const buttons = (call = lastScreen()) => (call.body.reply_markup?.inline_keyboard || []).flat() as Array<Record<string, any>>;
const actions = (call = lastScreen()) => buttons(call).map(button => button.callback_data);
const wbWrites = () => db.filter(call => call.path.startsWith('telegram_wb_connections') && call.method !== 'GET');
const toasts = () => sent.filter(call => call.method === 'answerCallbackQuery').map(call => call.body.text).filter(Boolean);
const READY: Wb = {
  state: 'ready',
  session: { token: 't', desktopToken: 'd', authKind: 'desktop', pointId: 12345, phone: '79991234567', points: [{ id: 12345, officeId: 1 }, { id: 67890, officeId: 2 }] },
};

describe('первый шаг входа', () => {
  it('отзывы: зачем вход, чей номер, что хранится, цена — и без «кабинета» и «сотрудника»', async () => {
    await bot.processUpdate(press('menu:reviews'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('Отзывы ПВЗ — вход в WB');
    expect(text).toContain('с которым вы входите в программу WB на пункте');
    expect(text).toContain('зашифрованном виде');
    expect(text).toContain('«Кто поставил оценку» — 25 ₽ за клиента');
    expect(text).not.toMatch(/кабинет|сотрудника|SMS/i);
    expect(world.wb?.state).toBe('await_phone');
  });

  it('поиск клиента: тот же текст со своей целью и без цены отзывов', async () => {
    await bot.processUpdate(press('code:find'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('Поиск клиента — вход в WB');
    expect(text).toContain('зашифрованном виде');
    expect(text).not.toContain('Кто поставил');
    expect(actions()).toContain('menu:code');
  });
});

describe('телефон и код', () => {
  beforeEach(() => { world.wb = { state: 'await_phone', session: { deviceId: 'dev' }, updated_at: new Date().toISOString() }; });

  it('10 цифр с девятки дополняются семёркой; в ответе только последние 4 цифры и кнопки нового кода', async () => {
    const request = vi.spyOn(wbPvz, 'requestCode').mockImplementation(async (session: any, phone: any) => ({ session: { ...session, phone, desktopLoginToken: 'lt' }, ttl: 60 }));
    await bot.processUpdate(message('999 123-45-67'));
    expect(request).toHaveBeenCalledWith(expect.anything(), '79991234567', { resend: false });
    const text = String(lastScreen().body.text);
    expect(text).toContain('<b>4567</b>');
    expect(text).not.toContain('9991234567');
    expect(text).not.toMatch(/SMS|уведомлен/);
    expect(actions()).toEqual(expect.arrayContaining(['rv:resend', 'rv:phone', 'rv:cancel']));
    expect(sent.some(call => call.method === 'deleteMessage')).toBe(true);
  });

  it('номер другой страны — прямо и с поддержкой, код не запрашивается', async () => {
    const request = vi.spyOn(wbPvz, 'requestCode');
    await bot.processUpdate(message('+375 29 123-45-67'));
    expect(request).not.toHaveBeenCalled();
    expect(lastScreen().body.text).toContain('только по российским номерам +7');
    expect(buttons().some(button => button.url)).toBe(true);
  });

  it('12 цифр не с семёрки без «+» — тоже номер другой страны', async () => {
    const request = vi.spyOn(wbPvz, 'requestCode');
    await bot.processUpdate(message('375291234567'));
    expect(request).not.toHaveBeenCalled();
    expect(lastScreen().body.text).toContain('только по российским номерам +7');
  });

  it('11 цифр не с 7/8 (ШК, опечатка) — обычная подсказка про ШК, без «другой страны» и поддержки', async () => {
    const request = vi.spyOn(wbPvz, 'requestCode');
    await bot.processUpdate(message('12345678901'));
    expect(request).not.toHaveBeenCalled();
    const text = String(lastScreen().body.text);
    expect(text).toContain('Это не похоже на номер телефона');
    expect(text).toContain('Прислали ШК');
    expect(text).not.toContain('российским номерам');
    expect(buttons().some(button => button.url)).toBe(false);
    expect(actions()).toContain('rv:cancel');
  });

  it('вопрос словами вместо номера не удаляется молча: подсказка и «Отменить вход»', async () => {
    await bot.processUpdate(message('а зачем вам мой номер?'));
    expect(sent.some(call => call.method === 'deleteMessage')).toBe(false);
    expect(lastScreen().body.text).toContain('Это не похоже на номер телефона');
    expect(actions()).toContain('rv:cancel');
  });

  it('сбой WB при запросе кода — без технического текста', async () => {
    vi.spyOn(wbPvz, 'requestCode').mockRejectedValue(wbError(500, 'Не удалось пройти проверку WB X-Pow'));
    await bot.processUpdate(message('79991234567'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('WB сейчас не отвечает');
    expect(text).not.toContain('X-Pow');
    expect(world.wb?.state).toBe('await_phone');
  });

  it('свой русский текст WB (4xx) показываем; 429 — «подождите»', async () => {
    vi.spyOn(wbPvz, 'requestCode').mockRejectedValueOnce(Object.assign(wbError(400, 'Пользователь не найден'), { wbMessage: 'Пользователь не найден' }));
    await bot.processUpdate(message('79991234567'));
    expect(lastScreen().body.text).toContain('«Пользователь не найден»');
    vi.spyOn(wbPvz, 'requestCode').mockRejectedValueOnce(wbError(429));
    await bot.processUpdate(message('79991234567'));
    expect(lastScreen().body.text).toContain('слишком много попыток');
  });

  it('WB ответил 200 без токена, но со своим текстом — показываем текст WB, а не «WB не отвечает»', async () => {
    world.wb = { state: 'await_code', session: { deviceId: 'dev', phone: '79991234567', desktopLoginToken: 'lt' }, updated_at: new Date().toISOString() };
    const base = (globalThis.fetch as any).getMockImplementation();
    (globalThis.fetch as any).mockImplementation(async (url: string, init: RequestInit) => (
      String(url).includes('/api/v1/validate') ? json({ message: 'Неверный код' }) : base(url, init)));
    await bot.processUpdate(message('1234'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('WB ответил: «Неверный код»');
    expect(text).not.toContain('не отвечает');
  });

  it('неверный код — понятный текст и те же кнопки, без сырого ответа', async () => {
    world.wb = { state: 'await_code', session: { deviceId: 'dev', phone: '79991234567', desktopLoginToken: 'lt' }, updated_at: new Date().toISOString() };
    vi.spyOn(wbPvz, 'confirmCode').mockRejectedValue(wbError(400, 'invalid code'));
    await bot.processUpdate(message('1234'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('Код не подошёл или его срок истёк');
    expect(text).not.toContain('invalid code');
    expect(actions()).toContain('rv:resend');
  });

  it('после входа список ПВЗ не загрузился — «Проверить снова», без /reviews и сырого текста', async () => {
    world.wb = { state: 'await_code', session: { deviceId: 'dev', phone: '79991234567', desktopLoginToken: 'lt', authKind: 'desktop' }, updated_at: new Date().toISOString() };
    vi.spyOn(wbPvz, 'confirmCode').mockImplementation(async (session: any) => ({ ...session, token: 't', points: [] }));
    vi.spyOn(wbPvz, 'loadPoints').mockRejectedValue(wbError(400, 'Не указан shard WB Desktop. Для теста задайте WB_DESKTOP_SHARD.'));
    await bot.processUpdate(message('123456'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('список ваших ПВЗ пока не загрузился');
    expect(text).not.toMatch(/shard|\/reviews/);
    expect(actions()).toContain('rv:points');
    expect(world.wb?.state).toBe('await_point');
  });
});

describe('«Выслать код заново» и «Другой номер»', () => {
  beforeEach(() => {
    world.wb = { state: 'await_code', session: { deviceId: 'dev', phone: '79991234567', desktopLoginToken: 'lt' }, updated_at: new Date().toISOString() };
  });

  it('новый код — по номеру из сессии, второй раз подряд не чаще 30 секунд', async () => {
    const request = vi.spyOn(wbPvz, 'requestCode').mockImplementation(async (session: any, phone: any) => ({ session: { ...session, phone, desktopLoginToken: 'lt2' }, ttl: 60 }));
    await bot.processUpdate(press('rv:resend', 70));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.anything(), '79991234567', { resend: true });
    expect(lastScreen().method).toBe('editMessageText');
    expect(lastScreen().body.text).toContain('Новый код от WB');
    await bot.processUpdate(press('rv:resend', 70));
    expect(request).toHaveBeenCalledTimes(1);
    expect(toasts().at(-1)).toMatch(/через \d+ сек/);
  });

  it('«Другой номер» — снова шаг телефона', async () => {
    await bot.processUpdate(press('rv:phone'));
    expect(world.wb?.state).toBe('await_phone');
    expect(world.wb?.session.deviceId).toBe('dev');
    expect(lastScreen().body.text).toContain('Отправьте номер телефона');
  });

  it('повторное «Отзывы ПВЗ» во время ожидания кода не сбрасывает вход', async () => {
    await bot.processUpdate(press('menu:reviews'));
    expect(lastScreen().body.text).toContain('Жду код от WB');
    expect(lastScreen().body.text).toContain('<b>4567</b>');
    expect(wbWrites().filter(call => call.body?.state === 'await_phone')).toHaveLength(0);
  });

  it('через 15 минут ожидание кончается: 11 цифр — уже не телефон и не код', async () => {
    world.wb = { state: 'await_phone', session: { deviceId: 'dev' }, updated_at: new Date(Date.now() - 20 * 60_000).toISOString() };
    const request = vi.spyOn(wbPvz, 'requestCode');
    await bot.processUpdate(message('79991234567'));
    expect(request).not.toHaveBeenCalled();
    expect(allText()).not.toContain('Это не похоже на номер телефона');
  });
});

describe('смена ПВЗ и выход', () => {
  beforeEach(() => { world.wb = structuredClone(READY); });

  it('«Сменить ПВЗ» не меняет состояние; текущий с галочкой; «Оставить текущий» — вход на месте', async () => {
    await bot.processUpdate(press('rv:points', 60));
    expect(world.wb?.state).toBe('ready');
    expect(lastScreen().body.text).toContain('Сейчас открыт ПВЗ 12345');
    expect(buttons().map(button => button.text)).toEqual(expect.arrayContaining(['✅ ПВЗ 12345', 'ПВЗ 67890', '⬅️ Оставить текущий ПВЗ']));
    await bot.processUpdate(press('rv:cancel', 60));
    expect(world.wb?.state).toBe('ready');
    expect(world.wb?.session.token).toBe('t');
    expect(toasts().at(-1)).toContain('Пункт не менялся');
    expect(lastScreen().body.text).toContain('Отзывы ПВЗ 12345');
  });

  it('один пункт — объяснение вместо того же экрана', async () => {
    world.wb!.session.points = [{ id: 12345, officeId: 1 }];
    await bot.processUpdate(press('rv:points'));
    expect(lastScreen().body.text).toContain('только один пункт — ПВЗ 12345');
    expect(actions()).toContain('rv:relogin');
  });

  it('из поиска клиента «Оставить текущий» возвращает в поиск', async () => {
    await bot.processUpdate(press('cs:points', 61));
    await bot.processUpdate(press('rv:cancel', 61));
    expect(world.wb?.state).toBe('ready');
    expect(lastScreen().body.text).toContain('Поиск клиента');
  });

  it('«Выйти из WB» — сначала вопрос, вход удаляется только после «Да»', async () => {
    await bot.processUpdate(press('rv:logout'));
    expect(lastScreen().body.text).toContain('Выйти из WB?');
    expect(world.wb).not.toBeNull();
    await bot.processUpdate(press('rv:logout:ok'));
    expect(world.wb).toBeNull();
    expect(lastScreen().body.text).toContain('Вы вышли из WB');
    expect(actions()).toContain('rv:filters');
  });

  it('старая кнопка «Отключить WB» тоже спрашивает; «Войти другим номером» — с подтверждением', async () => {
    await bot.processUpdate(press('rv:disconnect'));
    expect(world.wb).not.toBeNull();
    await bot.processUpdate(press('rv:relogin'));
    expect(world.wb).not.toBeNull();
    expect(lastScreen().body.text).toContain('Войти другим номером?');
    await bot.processUpdate(press('rv:relogin:ok'));
    expect(world.wb?.state).toBe('await_phone');
  });

  it('/cancel не выкидывает из готового входа', async () => {
    await bot.processUpdate(message('/cancel'));
    expect(world.wb?.state).toBe('ready');
  });
});

describe('ошибки WB', () => {
  beforeEach(() => { world.wb = structuredClone(READY); });

  it('401 — вход удаляется и сразу просим номер; не «сбой на нашей стороне»', async () => {
    vi.spyOn(wbPvz, 'loadReviews').mockRejectedValue(wbError(401));
    await bot.processUpdate(press('rv:filter:5'));
    expect(allText()).toContain('Вход в WB устарел');
    expect(allText()).not.toContain('сбой на нашей стороне');
    expect(world.wb?.state).toBe('await_phone');
  });

  it('401 на «Кто поставил» — к входу заново и прямо «Деньги не списаны»', async () => {
    vi.spyOn(wbPvz, 'loadReviews').mockRejectedValue(wbError(401));
    await bot.processUpdate(press('rv:who2:5:0:0:07d5a547', 333));
    expect(allText()).toContain('Вход в WB устарел');
    expect(allText()).toContain('Деньги не списаны');
    expect(db.some(call => call.path === 'rpc/bot_review_spend')).toBe(false);
    expect(world.wb?.state).toBe('await_phone');
  });

  it('сбой WB — «WB сейчас не отвечает» и «Повторить» той же кнопкой', async () => {
    vi.spyOn(wbPvz, 'loadReviews').mockRejectedValue(wbError(502));
    await bot.processUpdate(press('rv:page:all:2'));
    expect(lastScreen().body.text).toContain('WB сейчас не отвечает');
    expect(lastScreen().body.text).not.toContain('HTTP');
    expect(actions()).toContain('rv:page:all:2');
    expect(world.wb?.state).toBe('ready');
  });

  it('сеть до WB недоступна — та же понятная ошибка', async () => {
    const base = (globalThis.fetch as any).getMockImplementation();
    (globalThis.fetch as any).mockImplementation(async (url: string, init: RequestInit) => {
      if (String(url).includes('point-rating.wb.ru')) throw new TypeError('fetch failed');
      return base(url, init);
    });
    await bot.processUpdate(press('rv:filter:all'));
    expect(lastScreen().body.text).toContain('WB сейчас не отвечает');
  });

  it('403 — вход не удаляется, есть повтор и вход заново', async () => {
    vi.spyOn(wbPvz, 'loadReviews').mockRejectedValue(wbError(403));
    await bot.processUpdate(press('rv:filter:1'));
    expect(world.wb?.state).toBe('ready');
    expect(lastScreen().body.text).toContain('WB не дал доступ');
    expect(actions()).toEqual(expect.arrayContaining(['rv:filter:1', 'rv:relogin:ok']));
  });

  it('после пополнения (afterWalletTopup) сбой WB — понятное сообщение с повтором автора', async () => {
    vi.spyOn(wbPvz, 'loadReviews').mockRejectedValue(wbError(500));
    const started = await bot.afterWalletTopup({ id: 'o1', user_id: USER, pricing_snapshot: { wallet: { then: 'rv:5:0:3:07d5a547' } } }, null);
    expect(started).toBe(true);
    expect(lastScreen().body.text).toContain('деньги на балансе');
    expect(lastScreen().body.text).toContain('WB сейчас не отвечает');
    expect(actions()).toContain('rv:who2:5:0:3:07d5a547');
  });
});

describe('«Кто поставил оценку»', () => {
  const review = { id: '07d5a547-0000-0000-0000-000000000000', stars: 5, comment: 'ок', rate_dt: '2026-11-01T10:00:00Z' };
  beforeEach(() => {
    world.wb = structuredClone(READY);
    vi.spyOn(wbPvz, 'loadReviews').mockResolvedValue({ data: [review], total: 1 });
    vi.spyOn(wbPvz, 'loadUsers').mockResolvedValue([]);
  });

  it('цена на кнопке под отзывом и условия под страницей; «Выбрать другую оценку»', async () => {
    await bot.processUpdate(press('rv:filter:5'));
    const reviewMessage = screens().find(call => String(call.body.text).includes('Отзыв 1 из 1'))!;
    expect(buttons(reviewMessage)[0].text).toBe('👤 Кто поставил — 25 ₽');
    expect(lastScreen().body.text).toContain('Того же клиента повторно — бесплатно');
    expect(buttons().map(button => button.text)).toContain('⭐ Выбрать другую оценку');
    expect(toasts()).toContain('Загружаю отзывы…');
  });

  it('безлимиту цену на кнопке не пишем', async () => {
    TG = 439335621; from = { id: TG, first_name: 'Султан' };
    await bot.processUpdate(press('rv:filter:5'));
    const reviewMessage = screens().find(call => String(call.body.text).includes('Отзыв 1 из 1'))!;
    expect(buttons(reviewMessage)[0].text).toBe('👤 Кто поставил');
  });

  it('выдачи не загрузились — не списываем; карточка ответом на отзыв, с «К отзывам» и меню', async () => {
    vi.spyOn(wbPvz, 'loadGoodsInPickPoint').mockRejectedValue(wbError(500));
    await bot.processUpdate(press('rv:who2:5:0:0:07d5a547', 333));
    expect(db.some(call => call.path === 'rpc/bot_review_spend')).toBe(false);
    const card = lastScreen();
    expect(card.body.text).toContain('Кто поставил оценку');
    expect(card.body.text).toContain('WB не ответил');
    expect(card.body.text).toContain('Деньги не списаны');
    expect(card.body.text).not.toContain('HTTP');
    expect(card.body.reply_parameters).toEqual({ message_id: 333, allow_sending_without_reply: true });
    expect(actions(card)).toEqual(expect.arrayContaining(['rv:back', 'menu:home']));
    expect(toasts()).toContain('Ищу клиента в WB…');
  });

  it('не хватило денег — пэйвол под отзывом; после пополнения карточка тоже ответом на этот отзыв', async () => {
    vi.spyOn(wbPvz, 'loadGoodsInPickPoint').mockResolvedValue({ goods: [
      { buyer_sid: 0x07d5a547, buyer: { user_sid: 0x07d5a547, name: 'Анна', mobile: '79990000067' }, status: 'GOODS_RECIEVED', status_updated: '2026-11-01T10:00:00+03:00', cell: '12' },
    ], cursor: null });
    world.balance = 0;
    await bot.processUpdate(press('rv:who2:5:0:0:07d5a547', 335));
    const paywall = lastScreen();
    expect(paywall.body.text).toContain('не хватает');
    expect(paywall.body.reply_parameters).toEqual({ message_id: 335, allow_sending_without_reply: true });
    expect(db.some(call => call.path === 'rpc/bot_review_spend')).toBe(false);
    world.balance = 10000;
    const started = await bot.afterWalletTopup({ id: 'o2', user_id: USER, pricing_snapshot: { wallet: { then: 'rv:5:0:0:07d5a547' } } }, null);
    expect(started).toBe(true);
    const card = screens().find(call => String(call.body.text).startsWith('<b>👤 Кто поставил оценку</b>'))!;
    expect(card.body.text).toContain('Списано 25 ₽');
    expect(card.body.reply_parameters).toEqual({ message_id: 335, allow_sending_without_reply: true });
  });

  it('«⬅️ Назад» с экрана оплаты автора — к отзывам, а не в главное меню', () => {
    const topupScreen = require('../../server/_topup-screen.js') as { topupBackData: (then: string) => string };
    expect(topupScreen.topupBackData('rv:5:0:3:07d5a547')).toBe('rv:filters');
  });

  it('«💰 Пополнить баланс» с экрана отзывов — «⬅️ К отзывам» на пополнении', async () => {
    await bot.processUpdate(press('rv:filters', 90));
    expect(lastScreen().body.text).toContain('Смотреть отзывы — бесплатно.');
    expect(lastScreen().body.text).toContain('💰 На балансе: 100 ₽');
    await bot.processUpdate(press('topup:home', 90));
    expect(buttons()).toEqual(expect.arrayContaining([{ text: '⬅️ К отзывам', callback_data: 'rv:filters' }]));
  });

  it('выдачи нашлись — списание один раз, имя клиента в карточке', async () => {
    vi.spyOn(wbPvz, 'loadGoodsInPickPoint').mockResolvedValue({ goods: [
      { buyer_sid: 0x07d5a547, buyer: { user_sid: 0x07d5a547, name: 'Анна', mobile: '79990000067' }, status: 'GOODS_RECIEVED', status_updated: '2026-11-01T10:00:00+03:00', cell: '12' },
    ], cursor: null });
    await bot.processUpdate(press('rv:who2:5:0:0:07d5a547', 334));
    expect(db.filter(call => call.path === 'rpc/bot_review_spend')).toHaveLength(1);
    // последним уходит уведомление админу о списании — карточку ищем по заголовку
    const card = screens().find(call => String(call.body.text).startsWith('<b>👤 Кто поставил оценку</b>'))!;
    expect(card.body.text).toContain('Имя: Анна');
    expect(card.body.text).toContain('Телефон: <code>+7 999 ***-**-67</code>');
    expect(card.body.text).toContain('Списано 25 ₽');
  });
});

describe('wbPvz: повтор кода и ответ без токена', () => {
  const calls: Array<{ url: string; body: any }> = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).includes('/api/v1/login')) return json(body?.phone === '70000000000' ? { message: 'Неверный номер телефона' } : { data: { token: 'lt', ttl: 60 } });
      return json({});
    }));
  });

  it('«Выслать код заново» уходит в WB с resend: true, первый запрос — с resend: false', async () => {
    await wbPvz.requestCode({ deviceId: 'dev' }, '79991234567');
    await wbPvz.requestCode({ deviceId: 'dev' }, '79991234567', { resend: true });
    expect(calls.map(call => call.body.resend)).toEqual([false, true]);
  });

  it('200 без токена — текст WB в wbMessage', async () => {
    const error = await wbPvz.requestCode({ deviceId: 'dev' }, '70000000000').catch((caught: any) => caught);
    expect(error).toBeInstanceOf(wbPvz.WbPvzError);
    expect(error.wbMessage).toBe('Неверный номер телефона');
  });
});
