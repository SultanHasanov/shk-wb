import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Мастер стикеров и QR коробок (этап C): цены на выборе режима, ввод номера, подтверждение, выдача с кнопками
// под PDF и итогом вместо «Генерирую…», повторная выдача без «Списано» и со свежими ссылками, ошибки без сырого
// текста и «Повторить» с новым nonce, возврат в мастер после покупки пакета, «Назад» на экране оплаты,
// голые цифры (QR коробки, QR клиента через подтверждение), отмена ввода кода доступа.

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  processUpdate: (update: Record<string, unknown>) => Promise<void>;
  afterWalletTopup: (order: Record<string, unknown>, noticeId?: number | null) => Promise<boolean>;
  wizardView: (state: string, draft: Record<string, unknown>) => { text: string; rows: Array<Array<Record<string, any>>> };
  parseWizardNumber: (text: string, category: string) => { code?: string; codes?: string[]; error?: string };
};
const generation = require('../../server/_sticker-generation.js') as {
  customStickerLinks: (code: string, options?: Record<string, unknown>) => { imageUrl: string; pdfUrl: string };
};
const checkout = require('../../server/_bot-checkout.js') as Record<string, (...args: any[]) => Promise<any>>;
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };

const USER = '9f9f9f9f-1111-2222-3333-444455556666';
const SECRET = 's'.repeat(32);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Сессии кешируются в памяти модуля по Telegram ID — у каждого теста свой человек.
let tgSeq = 718000000;
let TG = 0;
let from = { id: 0, first_name: 'Аня' };
let updateId = 9000;
const message = (text: string) => ({ update_id: ++updateId, message: { message_id: updateId, text, from, chat: { id: TG, type: 'private' } } });
const press = (data: string, messageId = 50) => ({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, from, data, message: { message_id: messageId, chat: { id: TG, type: 'private' } } } });

type World = {
  session: Record<string, any> | null;
  balance: number;
  codes: Array<Record<string, unknown>>;
  reserve: Record<string, unknown>;
  failAuthorize: boolean;
  refund: Record<string, unknown> | 'fail';
  failFinalize: boolean;
  failComplete: boolean;
  claims: string[];
  results: Record<string, unknown>;
};
let world: World;
let db: Array<{ method: string; path: string; body: any }>;
let sent: Array<{ method: string; body: Record<string, any> }>;

const confirmSession = (draft: Record<string, unknown> = {}) => ({
  telegram_user_id: TG, chat_id: TG, state: 'confirm', updated_at: new Date().toISOString(),
  draft: { userId: USER, category: 'product', mode: 'custom', code: '47671114039', nonce: '123456', msgId: 50, walletCost: 7.5, balanceKopecks: 12000, ...draft },
});

beforeEach(() => {
  TG = ++tgSeq;
  from = { id: TG, first_name: 'Аня' };
  db = []; sent = [];
  userCache.clearTelegramUserCache();
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
  process.env.STICKER_CLIENT_SECRET = SECRET;
  process.env.PUBLIC_APP_URL = 'https://shk-wb.ru';
  world = {
    session: null, balance: 12000, codes: [], failAuthorize: false, claims: [], results: {},
    refund: { ok: true, duplicate: false }, failFinalize: false, failComplete: false,
    reserve: { ok: true, chargeId: 'charge-1', paymentSource: 'wallet', priceKopecks: 750, balanceKopecks: 11250, discountApplied: false },
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const address = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (!address.startsWith('https://db.test')) {
      sent.push({ method: address.split('/').pop() || '', body: body || {} });
      return json({ ok: true, result: { message_id: 77 } });
    }
    const path = decodeURIComponent(address.split('/rest/v1/')[1] || '');
    const method = String(init.method || 'GET').toUpperCase();
    db.push({ method, path, body });
    if (path.startsWith('telegram_bot_updates')) return json([{ update_id: 1 }]);
    if (path.startsWith('user_telegram_identities?telegram_user_id=eq.')) return json([{ user_id: USER, telegram_user_id: TG }]);
    if (path.startsWith('user_telegram_identities?user_id=eq.')) return json([{ telegram_user_id: TG }]);
    if (path.startsWith('telegram_generator_sessions') && method === 'GET') return json(world.session ? [world.session] : []);
    if (path.startsWith('telegram_generator_sessions') && method === 'POST') { world.session = { ...body }; return json([{ ...body }]); }
    if (path.startsWith('telegram_generator_sessions') && method === 'DELETE') { world.session = null; return json(null); }
    if (path.startsWith('wallet_accounts')) return json([{ balance_kopecks: world.balance }]);
    if (path.startsWith('sticker_access_codes')) return json(world.codes);
    if (path === 'rpc/reserve_sticker_generation') return json(world.reserve);
    if (path === 'rpc/refund_sticker_generation') return world.refund === 'fail' ? json({ message: 'network' }, 500) : json(world.refund);
    if (path === 'rpc/finalize_sticker_generation') return world.failFinalize ? json({ message: 'relay timeout' }, 500) : json({ ok: true, duplicate: false });
    if (path.startsWith('telegram_generation_requests?request_id=eq.') && method === 'PATCH' && world.failComplete) return json({ message: 'relay timeout' }, 500);
    if (path === 'rpc/authorize_paid_custom_sticker') return world.failAuthorize ? json({ message: 'boom: secret detail' }, 500) : json(null);
    if (path === 'rpc/allocate_paid_return_stickers') return json(Array.from({ length: 50 }, (_, index) => ({ batch_id: 'bbbbbbbb-1111-4222-8333-444455556666', code: String(47600000000 + index) })));
    if (path.startsWith('telegram_generation_requests?on_conflict')) {
      if (world.claims.includes(body.request_id)) return json([]);
      world.claims.push(body.request_id);
      return json([body]);
    }
    if (path.startsWith('telegram_generation_requests?request_id=eq.') && method === 'GET') {
      const id = path.split('request_id=eq.')[1].split('&')[0];
      return json(world.results[id] ? [{ result: world.results[id] }] : []);
    }
    if (path === 'rpc/app_entitlements') return json({ codes_limit: 0, codes_used: 0, packs_left: 0 });
    if (path === 'rpc/consume_api_rate_limit') return json(true);
    return json([]);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ['TELEGRAM_BOT_TOKEN', 'STICKER_CLIENT_SECRET', 'PUBLIC_APP_URL']) delete process.env[key];
});

const screens = () => sent.filter(call => call.method === 'sendMessage' || call.method === 'editMessageText');
const lastScreen = () => screens().at(-1)!;
const buttons = (call: { body: Record<string, any> } = lastScreen()) => (call.body.reply_markup?.inline_keyboard || []).flat() as Array<Record<string, any>>;
const documents = () => sent.filter(call => call.method === 'sendDocument');
const editsOf = (messageId: number) => sent.filter(call => call.method === 'editMessageText' && call.body.message_id === messageId);
const rpcCalls = (name: string) => db.filter(call => call.path === `rpc/${name}`);

describe('шаги мастера: цены, ввод номера, подтверждение', () => {
  it('выбор режима: цены этого человека, пакет «в вашем пакете N шт.», отдельные слова для коробок', () => {
    const withPackage = bot.wizardView('choose_mode', { category: 'product', prices: { batch: 1600, custom: 600, discount: true, packageLeft: 12 } });
    expect(withPackage.text).toContain('50 стикеров с новыми номерами ШК одним PDF, 16 ₽ за всю пачку');
    expect(withPackage.text).toContain('В вашем пакете 12 шт.');
    expect(withPackage.text).toContain('разовой скидкой 20%');
    expect(withPackage.rows.flat().map(button => button.text)).toContain('Один по номеру — из пакета');
    const box = bot.wizardView('choose_mode', { category: 'box' });
    expect(box.text).toContain('Какие QR коробок нужны?');
    expect(box.text).toContain('Часто делаете по номеру? В пакете дешевле — от 3 ₽ за штуку.');
    expect(bot.wizardView('await_code', { category: 'box', mode: 'custom' }).text).toContain('10 цифр без букв TRBX');
  });

  it('номер: срезает TRBX и дефисы, несколько номеров — выбор, ошибка называет число цифр', () => {
    expect(bot.parseWizardNumber('TRBX-1234-567-890', 'box')).toEqual({ code: '1234567890' });
    expect(bot.parseWizardNumber('4767 1114 039', 'product')).toEqual({ code: '47671114039' });
    expect(bot.parseWizardNumber('47671114039\n58899100266', 'product')).toEqual({ codes: ['47671114039', '58899100266'] });
    expect(bot.parseWizardNumber('4767111403912', 'product').error).toContain('13 цифр, а в номере ШК их 11');
    expect(bot.parseWizardNumber('TRBX12345', 'box').error).toContain('5 цифр, а в номере коробки их 10 (без букв TRBX)');
    expect(bot.parseWizardNumber('привет', 'product').error).toContain('нет цифр');
    // Нужное число цифр одной серией и лишний знак рядом — это номер, а не «11 цифр, а нужно 11».
    expect(bot.parseWizardNumber('47671114039.', 'product')).toEqual({ code: '47671114039' });
    expect(bot.parseWizardNumber('№47671114039', 'product')).toEqual({ code: '47671114039' });
    expect(bot.parseWizardNumber('ШК:47671114039', 'product')).toEqual({ code: '47671114039' });
    const split = bot.parseWizardNumber('4767111/4039', 'product').error;
    expect(split).toContain('цифры разделены другими знаками');
    expect(split).not.toContain('их 11');
  });

  it('выбор режима: месячные стикеры «Про» покрывают и «Пачку 50» — без цены на ней', () => {
    const view = bot.wizardView('choose_mode', { category: 'product', prices: { batch: 2000, custom: 750, discount: false, packageLeft: 50, batchFromPackage: true } });
    const labels = view.rows.flat().map(button => button.text);
    expect(labels).toContain('Пачка 50 шт. — из пакета');
    expect(labels).toContain('Один по номеру — из пакета');
    expect(view.text).toContain('и «Пачка 50», и «Один по номеру» спишутся из него');
    expect(view.text).not.toContain('20 ₽');
  });

  it('цены мастера: месячный пакет «Про» создаётся до подсчёта, код без режима считается и для пачки', async () => {
    world.session = { telegram_user_id: TG, chat_id: TG, state: 'choose_kind', updated_at: new Date().toISOString(), draft: { userId: USER, nonce: '1', msgId: 50 } };
    world.codes = [{ generation_limit: 50, generation_used: 0, generation_mode: null }];
    await bot.processUpdate(press('gen:kind:product'));
    const quota = db.findIndex(call => call.path === 'rpc/app_sticker_quota_code');
    const codes = db.findIndex(call => call.path.startsWith('sticker_access_codes'));
    expect(quota).toBeGreaterThanOrEqual(0);
    expect(quota).toBeLessThan(codes);
    expect(buttons().map(button => button.text)).toContain('Пачка 50 шт. — из пакета');
    // Купленный пакет по номеру (custom) на пачку не действует.
    world.codes = [{ generation_limit: 50, generation_used: 0, generation_mode: 'custom' }];
    await bot.processUpdate(press('gen:back'));
    await bot.processUpdate(press('gen:kind:product'));
    expect(buttons().map(button => button.text)).toContain('Пачка 50 шт. — 20 ₽');
  });

  it('подтверждение: «Проверьте и нажмите», что получите, цена на кнопке; нехватка — минимум и «Отмена»', () => {
    const ok = bot.wizardView('confirm', { category: 'product', mode: 'custom', code: '47671114039', walletCost: 7.5, balanceKopecks: 10000 });
    expect(ok.text).toContain('Проверьте и нажмите «Создать»');
    expect(ok.text).toContain('Получите: 1 стикер товара с номером <code>47671114039</code>');
    expect(ok.text).toContain('Спишется с баланса: <b>7,50 ₽</b>, останется 92,50 ₽.');
    expect(ok.rows[0][0].text).toBe('✅ Создать за 7,50 ₽');
    const batch = bot.wizardView('confirm', { category: 'box', mode: 'range', quantity: 50, walletCost: 20, balanceKopecks: 10000 });
    expect(batch.text).toContain('Получите: 50 QR коробок с новыми номерами одним PDF.');
    const poor = bot.wizardView('confirm', { category: 'product', mode: 'custom', code: '47671114039', walletCost: 7.5, balanceKopecks: 0 });
    expect(poor.text).toContain('Минимальное пополнение — 25 ₽, после создания на балансе останется 17,50 ₽.');
    expect(poor.rows[0][0]).toMatchObject({ text: '💳 Пополнить на 25 ₽ и создать', callback_data: 'tp:25~750:gen' });
    expect(poor.rows.flat().map(button => button.callback_data)).toContain('gen:cancel');
  });

  it('номер текстом: экран — новым сообщением вниз, прежний экран мастера удаляется', async () => {
    world.session = { telegram_user_id: TG, chat_id: TG, state: 'await_code', updated_at: new Date().toISOString(), draft: { userId: USER, category: 'product', mode: 'custom', nonce: '1', msgId: 60 } };
    await bot.processUpdate(message('4767 1114 039'));
    expect(lastScreen().method).toBe('sendMessage');
    expect(lastScreen().body.text).toContain('Проверьте и нажмите «Создать»');
    expect(sent.some(call => call.method === 'deleteMessage' && call.body.message_id === 60)).toBe(true);
    expect(editsOf(60)).toEqual([]);
    expect(world.session?.draft.msgId).toBe(77);
  });

  it('на подтверждении «По номеру» новый номер заменяет прежний', async () => {
    world.session = confirmSession();
    await bot.processUpdate(message('58899100266'));
    expect(lastScreen().body.text).toContain('<code>58899100266</code>');
    expect(world.session?.draft.code).toBe('58899100266');
  });
});

describe('выдача', () => {
  it('стикер по номеру: кнопки на PDF, без «Предпросмотр 1 из 1», экран мастера — «Готово» после файла', async () => {
    world.session = confirmSession();
    await bot.processUpdate(press('gen:confirm'));
    const document = documents()[0];
    expect(document.body.caption).toContain('Готово: 1 стикер товара (47671114039). Списано 7,50 ₽, на балансе 112,50 ₽.');
    const callbacks = buttons(document).map(button => button.callback_data);
    expect(callbacks).toEqual([`gen:format:new:${TG}:50123456`, 'gen:again:product', 'menu:home']);
    expect(buttons(document)[0].text).toBe('🔁 Новый вид (QR по углам)');
    expect(screens().some(call => /Предпросмотр/.test(String(call.body.text)))).toBe(false);
    const done = editsOf(50).at(-1)!;
    expect(done.body.text).toContain('✅ Готово. Файл — ниже.');
    expect(sent.indexOf(done)).toBeGreaterThan(sent.indexOf(document));
    for (const call of [document, ...callbacks.map(data => ({ body: { data } }))]) expect(Buffer.byteLength(String(call.body.data || ''))).toBeLessThanOrEqual(64);
  });

  it('пачка 50: без картинок, PDF с кнопками вида и «Создать ещё»', async () => {
    world.session = confirmSession({ mode: 'range', quantity: 50, code: undefined, walletCost: 20 });
    world.reserve = { ...world.reserve, priceKopecks: 2000, balanceKopecks: 10000 };
    await bot.processUpdate(press('gen:confirm'));
    expect(sent.some(call => call.method === 'sendPhoto' || call.method === 'sendMediaGroup')).toBe(false);
    const document = documents()[0];
    expect(document.body.caption).toContain('Готово: 50 стикеров товаров одним файлом. Списано 20 ₽');
    expect(buttons(document).map(button => button.text)).toEqual(['🔁 Новый вид (QR по углам)', '➕ Создать ещё', '☰ Меню']);
    expect(editsOf(50).at(-1)!.body.text).toContain('✅ Готово');
  });

  it('«➕ Ещё один по номеру» — сразу ввод номера того же типа', async () => {
    await bot.processUpdate(press('gen:again:box', 90));
    expect(lastScreen().method).toBe('sendMessage');
    expect(lastScreen().body.text).toContain('Пришлите номер коробки');
    expect(world.session).toMatchObject({ state: 'await_code', draft: { category: 'box', mode: 'custom', prefix: 'TRBX' } });
  });

  it('другой вид: подпись без «Списано», ссылки подписаны заново', async () => {
    const rid = `${TG}:50123456`;
    world.results[rid] = {
      code: '47671114039', quantity: 1, variant: 'product',
      imageUrl: '/api/stickers/image?code=47671114039&token=old&expires=1', pdfUrl: '/api/stickers/pdf?code=47671114039&token=old&expires=1',
      botCaption: 'Готово: 1 стикер товара (47671114039). Списано 7,50 ₽, на балансе 112,50 ₽.',
    };
    await bot.processUpdate(press(`gen:format:new:${rid}`, 200));
    const document = documents()[0];
    expect(document.body.caption).toBe('Тот же стикер — новый вид, с QR по углам. Повторно ничего не списано.');
    expect(document.body.caption).not.toContain('Списано');
    const url = new URL(String(document.body.document));
    expect(url.searchParams.get('token')).not.toBe('old');
    expect(Number(url.searchParams.get('expires'))).toBeGreaterThan(Date.now() / 1000);
    expect(url.searchParams.get('style')).toBe('new');
    expect(buttons(document)[0]).toMatchObject({ text: '🔁 Обычный вид', callback_data: `gen:format:old:${rid}` });
  });

  it('QR коробки: кнопки вида нет', async () => {
    const rid = `${TG}:50123456`;
    world.results[rid] = { code: '1234567890', quantity: 1, variant: 'box', prefix: 'TRBX', imageUrl: '/x', pdfUrl: '/y' };
    await bot.processUpdate(press(`gen:format:old:${rid}`, 200));
    expect(documents()[0].body.caption).toBe('Тот же QR коробки ещё раз. Повторно ничего не списано.');
    expect(buttons(documents()[0]).map(button => button.callback_data)).toEqual(['gen:again:box', 'menu:home']);
  });

  it('общая подпись ссылок принимается api/stickers/image.js', async () => {
    const handler = require('../../api/stickers/image.js') as (req: any, res: any) => Promise<unknown>;
    for (const [code, options] of [['47671114039', {}], ['1234567890', { boxMode: true, prefix: 'TRBX' }]] as const) {
      const query = Object.fromEntries(new URL(`https://x${generation.customStickerLinks(code, options).imageUrl}`).searchParams);
      let status = 0;
      const res = { setHeader: () => {}, status(value: number) { status = value; return this; }, end() { return this; }, send() { return this; } };
      await handler({ method: 'GET', query, headers: {} }, res);
      expect(status, code).toBe(200);
    }
  });
});

describe('ошибки создания', () => {
  it('сбой: без сырого текста, «вернулись на баланс», «Повторить» — на подтверждение с новым nonce', async () => {
    world.session = confirmSession();
    world.failAuthorize = true;
    await bot.processUpdate(press('gen:confirm'));
    const screen = editsOf(50).at(-1)!;
    expect(screen.body.text).toContain('Не получилось создать стикер товара — ошибка на нашей стороне.');
    expect(screen.body.text).toContain('7,50 ₽ вернулись на баланс');
    expect(screen.body.text).not.toMatch(/boom|secret detail|Supabase/);
    expect(buttons(screen).map(button => button.callback_data || button.url)).toEqual(['gen:recheck', 'https://t.me/roma_denosov', 'menu:home']);
    expect(rpcCalls('refund_sticker_generation')).toHaveLength(1);
    expect(world.session).toMatchObject({ state: 'confirm', draft: { code: '47671114039', msgId: 50 } });
    expect(world.session?.draft.nonce).not.toBe('123456');

    world.failAuthorize = false;
    await bot.processUpdate(press('gen:recheck'));
    expect(lastScreen().body.text).toContain('Проверьте и нажмите «Создать»');
    await bot.processUpdate(press('gen:confirm'));
    // Второй запуск — под новым ключом: прежний занят записью failed и дал бы «Этот запрос уже обработан».
    expect(world.claims).toHaveLength(2);
    expect(new Set(world.claims).size).toBe(2);
    expect(documents()).toHaveLength(1);
  });

  it('оплата из пакета — «стикер вернулся в ваш пакет»', async () => {
    world.session = confirmSession({ accessCode: '123456', packageRemaining: 4 });
    world.reserve = { ok: true, chargeId: 'charge-2', paymentSource: 'package', priceKopecks: 0, packageRemaining: 4 };
    world.failAuthorize = true;
    await bot.processUpdate(press('gen:confirm'));
    expect(editsOf(50).at(-1)!.body.text).toContain('стикер вернулся в ваш пакет');
  });

  it('возврат не прошёл — не пишем «деньги вернулись», честно про 5 минут и код ошибки', async () => {
    world.session = confirmSession();
    world.failAuthorize = true;
    world.refund = 'fail';
    await bot.processUpdate(press('gen:confirm'));
    const text = editsOf(50).at(-1)!.body.text;
    expect(text).not.toContain('вернулись на баланс');
    expect(text).toContain('Вернуть деньги сразу не получилось');
    expect(text).toContain('не раньше чем через 5 минут');
    expect(text).toMatch(/Код ошибки: <code>[0-9a-f]{6}<\/code>/);
  });

  it('возврат ответил «не ok» (ALREADY_FINISHED без готового стикера) — тоже не «вернулись»', async () => {
    world.session = confirmSession();
    world.failAuthorize = true;
    world.refund = { ok: false, code: 'NOT_FOUND' };
    await bot.processUpdate(press('gen:confirm'));
    expect(editsOf(50).at(-1)!.body.text).toContain('Вернуть деньги сразу не получилось');
  });

  it('стикер создан и оплачен, а запись о выдаче не сохранилась — файл выдаётся, без возврата и «Повторить»', async () => {
    world.session = confirmSession();
    world.failComplete = true;
    await bot.processUpdate(press('gen:confirm'));
    expect(documents()).toHaveLength(1);
    expect(rpcCalls('refund_sticker_generation')).toEqual([]);
    expect(editsOf(50).at(-1)!.body.text).toContain('✅ Готово. Файл — ниже.');
    expect(sent.flatMap(call => (call.body.reply_markup?.inline_keyboard || []).flat()).map((button: any) => button.callback_data)).not.toContain('gen:recheck');
    expect(db.some(call => call.method === 'PATCH' && call.body?.status === 'failed')).toBe(false);
  });

  it('finalize прошёл, но ответ потерялся (возврат: ALREADY_FINISHED) — стикер выдаётся, деньги не «возвращаются»', async () => {
    world.session = confirmSession();
    world.failFinalize = true;
    world.refund = { ok: false, code: 'ALREADY_FINISHED' };
    await bot.processUpdate(press('gen:confirm'));
    expect(documents()).toHaveLength(1);
    expect(editsOf(50).at(-1)!.body.text).toContain('✅ Готово. Файл — ниже.');
    expect(db.some(call => call.method === 'PATCH' && call.body?.status === 'completed')).toBe(true);
    expect(db.some(call => call.method === 'PATCH' && call.body?.status === 'failed')).toBe(false);
  });

  it('предыдущий стикер ещё создаётся — понятный текст на подтверждении, деньги не списаны, запрос освобождён', async () => {
    world.session = confirmSession();
    world.reserve = { ok: false, code: 'BUSY' };
    await bot.processUpdate(press('gen:confirm'));
    expect(lastScreen().body.text).toContain('Предыдущий стикер ещё создаётся');
    expect(lastScreen().body.text).not.toContain('сбой на нашей стороне');
    expect(db.some(call => call.method === 'DELETE' && call.path.startsWith('telegram_generation_requests'))).toBe(true);
    expect(world.session?.state).toBe('confirm');
  });
});

describe('оплата посреди мастера', () => {
  it('«Назад» на экране оплаты: из мастера — к подтверждению, из магазина — к товару', async () => {
    vi.spyOn(checkout, 'createTopupPayment').mockResolvedValue({ confirmationUrl: 'https://pay.test/1', token: 't' });
    world.session = confirmSession({ balanceKopecks: 0 });
    world.balance = 0;
    await bot.processUpdate(press('tp:25~750:gen'));
    // Нижний ряд экрана оплаты: «⬅️ Назад» к покупке и «☰ Меню».
    expect(buttons().at(-2)).toMatchObject({ text: '⬅️ Назад', callback_data: 'gen:recheck' });
    expect(buttons().at(-1)).toMatchObject({ callback_data: 'menu:home' });
    await bot.processUpdate(press('gen:recheck'));
    // Выбор не стёрт: то же подтверждение с кнопкой «Пополнить и создать».
    expect(lastScreen().body.text).toContain('На балансе не хватает денег');
    expect(lastScreen().body.text).toContain('<code>47671114039</code>');
    expect(world.session?.state).toBe('confirm');
    await bot.processUpdate(press('tp:50:shop:gen:10', 51));
    expect(buttons().at(-2)).toMatchObject({ callback_data: 'shop:gen:10' });
  });

  it('«🏷 Создать стикер» после покупки пакета в новом сообщении — мастер переходит туда, а не «шаг устарел»', async () => {
    world.session = { telegram_user_id: TG, chat_id: TG, state: 'choose_mode', updated_at: new Date().toISOString(), draft: { userId: USER, category: 'product', nonce: '1', msgId: 60 } };
    world.codes = [{ generation_limit: 10, generation_used: 0 }];
    await bot.processUpdate(press('gen:return-mode', 51));
    const screen = editsOf(51).at(-1)!;
    expect(screen.body.text).toContain('В вашем пакете 10 шт.');
    expect(world.session?.draft.msgId).toBe(51);
    expect(sent.some(call => call.method === 'deleteMessage' && call.body.message_id === 60)).toBe(true);
  });

  it('«🏷 Создать стикер» без сессии — мастер заново в этом же сообщении', async () => {
    await bot.processUpdate(press('gen:return-mode', 51));
    expect(editsOf(51).at(-1)!.body.text).toContain('Что нужно создать?');
  });

  it('автосоздание после пополнения: итог — в сообщении «Баланс пополнен», прежний экран оплаты — «итог ниже»', async () => {
    world.session = confirmSession({ balanceKopecks: 0 });
    const started = await bot.afterWalletTopup({ id: 'o1', user_id: USER, pricing_snapshot: { wallet: { then: 'gen', message: 50 } } }, 99);
    expect(started).toBe(true);
    expect(editsOf(50)[0].body.text).toBe('Баланс пополнен — итог ниже ⬇️');
    expect(editsOf(99).at(-1)!.body.text).toContain('✅ Готово. Файл — ниже.');
    expect(documents()).toHaveLength(1);
    // Ключ запроса — по прежнему экрану: нажатие «Создать» там же не создаст стикер второй раз.
    expect(world.claims).toEqual([`${TG}:50123456`]);
  });

  it('автосоздание, а выбор уже сброшен — говорим прямо и ведём в мастер', async () => {
    const started = await bot.afterWalletTopup({ id: 'o1', user_id: USER, pricing_snapshot: { wallet: { then: 'gen', message: 50 } } }, 99);
    expect(started).toBe(true);
    const screen = editsOf(99).at(-1)!;
    expect(screen.body.text).toContain('выбор успел сброситься');
    expect(buttons(screen).map(button => button.callback_data)).toEqual(['menu:stickers', 'menu:home']);
  });
});

describe('голые цифры и код доступа', () => {
  it('10 цифр — «QR коробки» и QR клиента через подтверждение, ничего не списано', async () => {
    await bot.processUpdate(message('1234567890'));
    expect(lastScreen().body.text).toContain('📦 QR коробки — если это номер возвратной коробки (10 цифр)');
    expect(buttons().map(button => button.callback_data)).toEqual(['gen:box:1234567890', 'code:ask:1234567890', 'menu:home']);
    await bot.processUpdate(press('code:ask:1234567890', 77));
    expect(lastScreen().body.text).toContain('Спишется 50 ₽ с баланса, на балансе 120 ₽.');
    expect(lastScreen().body.text).toContain('отдельное списание');
    expect(buttons()[0]).toMatchObject({ text: '✅ Выдать QR — 50 ₽', callback_data: 'code:ok:1234567890' });
    expect(rpcCalls('wallet_spend')).toEqual([]);
  });

  it('«📦 QR коробки» — сразу подтверждение QR коробки с этим номером', async () => {
    await bot.processUpdate(press('gen:box:1234567890', 77));
    expect(lastScreen().body.text).toContain('Получите: 1 QR коробки с номером <code>1234567890</code>');
    expect(world.session).toMatchObject({ state: 'confirm', draft: { category: 'box', prefix: 'TRBX' } });
  });

  it('11 цифр — стикер товара и QR клиента', async () => {
    await bot.processUpdate(message('47671114039'));
    expect(buttons().map(button => button.callback_data)).toEqual(['gen:num:47671114039', 'code:ask:47671114039', 'menu:home']);
    expect(buttons()[0].text).toBe('🏷 Стикер товара — 7,50 ₽');
  });

  it('покупка пакета не докладывается на месячный код «Про» — он выключится в конце окна', async () => {
    await bot.processUpdate(press('shop:gen:10'));
    const lookup = db.find(call => call.path.startsWith('sticker_access_codes') && call.path.includes('order=created_at.desc'));
    expect(lookup?.path).toContain('app_subscription_id=is.null');
  });

  it('голые цифры: цена стикера — как в мастере (пакет — «из пакета»)', async () => {
    world.codes = [{ generation_limit: 30, generation_used: 0, generation_mode: 'custom' }];
    await bot.processUpdate(message('47671114039'));
    expect(buttons()[0].text).toBe('🏷 Стикер товара — из пакета');
    expect(lastScreen().body.text).toContain('если это ШК товара (11 цифр), из пакета');
  });

  it('отмена ввода кода доступа — профиль, а не «создание стикера отменено»', async () => {
    await bot.processUpdate(press('code:enter'));
    expect(lastScreen().body.text).toContain('пакет стикеров от партнёра или поддержки');
    expect(buttons().map(button => button.callback_data)).toEqual(['code:cancel']);
    await bot.processUpdate(press('code:cancel'));
    expect(lastScreen().body.text).toContain('Профиль');
    expect(world.session).toBeNull();
  });
});
