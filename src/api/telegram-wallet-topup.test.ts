import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Пополнение баланса в боте (этап D): экран оплаты (что будет дальше, «🔄 Проверить оплату», id экрана в заказе
// всегда), зачисление и отмена правят этот экран, «Своя сумма» принимает только число и не держит ожидание,
// «⬅️ Назад» с пополнения — туда, откуда пришли.

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  processUpdate: (update: Record<string, unknown>) => Promise<void>;
  afterWalletTopup: (order: Record<string, unknown>, noticeId?: number | null) => Promise<boolean>;
};
const checkout = require('../../server/_bot-checkout.js') as Record<string, (...args: any[]) => Promise<any>>;
const payments = require('../../server/_payments.js') as {
  completeOrder: (order: Record<string, unknown>, payment: Record<string, unknown>) => Promise<Record<string, unknown>>;
  notifyTopupCanceled: (order: Record<string, unknown>, payment: Record<string, unknown>) => Promise<boolean>;
};
const screen = require('../../server/_topup-screen.js') as Record<string, (...args: any[]) => any>;
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };

const USER = '9f9f9f9f-1111-2222-3333-444455556666';
const TOKEN = 'T'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let tgSeq = 719000000;
let TG = 0;
let from = { id: 0, first_name: 'Аня' };
let updateId = 30000;
const message = (text: string) => ({ update_id: ++updateId, message: { message_id: updateId, text, from, chat: { id: TG, type: 'private' } } });
const press = (data: string, messageId = 50) => ({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, from, data, message: { message_id: messageId, chat: { id: TG, type: 'private' } } } });

type World = { session: Record<string, any> | null; orders: Array<Record<string, any>>; newer: Array<Record<string, any>>; claimed: Set<string> };
let world: World;
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
  process.env.STICKER_CLIENT_SECRET = 's'.repeat(32);
  world = { session: null, orders: [], newer: [], claimed: new Set() };
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
    if (path.startsWith('wallet_accounts')) return json([{ balance_kopecks: 12000 }]);
    if (path.startsWith('payment_orders?public_token=eq.')) return json(world.orders);
    if (path.startsWith('payment_orders?user_id=eq.') && path.includes('created_at=gt.')) return json(world.newer);
    if (path.startsWith('telegram_generation_requests?on_conflict') && method === 'POST') {
      if (world.claimed.has(body.request_id)) return json([]);
      world.claimed.add(body.request_id);
      return json([body]);
    }
    if (path === 'rpc/complete_wallet_topup_order') return json(52500);
    if (path === 'rpc/consume_api_rate_limit') return json(true);
    if (path === 'rpc/app_entitlements') return json({});
    return json([]);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ['TELEGRAM_BOT_TOKEN', 'STICKER_CLIENT_SECRET']) delete process.env[key];
});

const screens = () => sent.filter(call => call.method === 'sendMessage' || call.method === 'editMessageText');
const lastScreen = () => screens().at(-1)!;
const buttons = (call: { body: Record<string, any> } = lastScreen()) => (call.body.reply_markup?.inline_keyboard || []).flat() as Array<Record<string, any>>;
const alerts = () => sent.filter(call => call.method === 'answerCallbackQuery').map(call => String(call.body.text || ''));

describe('экран оплаты пополнения', () => {
  it('объясняет, что будет дальше, сохраняет экран в заказе и даёт «Проверить оплату»', async () => {
    const create = vi.spyOn(checkout, 'createTopupPayment').mockResolvedValue({ confirmationUrl: 'https://pay.test/1', token: TOKEN });
    await bot.processUpdate(press('tp:500'));
    // Экран — в заказ всегда, а не только при «пополнить и купить»: после оплаты сайт поправит его.
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: 500, then: '', messageId: 50 }));
    const text = String(lastScreen().body.text);
    expect(text).toContain('Зачислим 525 ₽: 500 ₽ + бонус 25 ₽.');
    expect(text).toContain('Откроется страница оплаты ЮKassa. После оплаты вернитесь сюда — я напишу, что деньги на балансе.');
    expect(buttons().map(button => button.callback_data || button.url)).toEqual(['https://pay.test/1', `tpc:${TOKEN}`, 'topup:home', 'menu:home']);
  });

  it('кнопка из уведомления (новое сообщение) — сначала экран, его id уходит в заказ', async () => {
    const create = vi.spyOn(checkout, 'createTopupPayment').mockResolvedValue({ confirmationUrl: 'https://pay.test/1', token: TOKEN });
    await bot.processUpdate(press('n:tp:300'));
    expect(sent.find(call => call.method === 'sendMessage')?.body.text).toBe('⏳ Готовлю оплату…');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ messageId: 77 }));
  });

  it('«Проверить оплату»: чужой токен — не найдено; не оплачено — подождать; оплачено — экран «Оплачено»', async () => {
    await bot.processUpdate(press(`tpc:${TOKEN}`));
    expect(alerts().at(-1)).toContain('не найдена');
    expect(db.find(call => call.path.startsWith('payment_orders?public_token='))?.path).toContain(`user_id=eq.${USER}`);

    world.orders = [{ id: 'o1', status: 'pending', fulfillment_status: 'pending', gross_amount: 500, pricing_snapshot: { wallet: { amount: 500, message: 50 } } }];
    const check = vi.spyOn(checkout, 'checkTopupPayment').mockResolvedValue({ status: 'pending' });
    await bot.processUpdate(press(`tpc:${TOKEN}`));
    expect(check).toHaveBeenCalledWith({ token: TOKEN });
    expect(alerts().at(-1)).toContain('ещё не поступила');

    check.mockResolvedValue({ status: 'succeeded' });
    await bot.processUpdate(press(`tpc:${TOKEN}`));
    expect(alerts().at(-1)).toContain('Оплата прошла');
    expect(lastScreen().body.text).toContain('✅ Оплачено — деньги на балансе');
    expect(buttons().some(button => button.url)).toBe(false);
  });

  it('«Проверить оплату» по давно отменённой — экран «не прошла» с повтором той же покупки', async () => {
    world.orders = [{ id: 'o1', status: 'canceled', fulfillment_status: 'pending', gross_amount: 50, pricing_snapshot: { wallet: { amount: 50, then: 'shop:gen:10', message: 50 } } }];
    const check = vi.spyOn(checkout, 'checkTopupPayment');
    await bot.processUpdate(press(`tpc:${TOKEN}`));
    expect(check).not.toHaveBeenCalled();
    expect(lastScreen().body.text).toContain('Оплата не прошла');
    expect(buttons().map(button => button.callback_data)).toEqual(['tp:50:shop:gen:10', 'shop:gen:10', 'menu:home']);
  });

  it('запрос статуса — через общий обработчик платежей (action=status)', async () => {
    const handler = vi.fn(async (req: any, res: any) => { res.status(200).json({ status: 'canceled' }); });
    expect(await (checkout.checkTopupPayment as any)({ token: TOKEN }, { handler })).toEqual({ status: 'canceled' });
    expect(handler.mock.calls[0][0]).toMatchObject({ method: 'GET', query: { action: 'status', token: TOKEN } });
    const broken = vi.fn(async (_req: any, res: any) => { res.status(404).json({ error: 'Заказ не найден' }); });
    await expect((checkout.checkTopupPayment as any)({ token: TOKEN }, { handler: broken })).rejects.toMatchObject({ status: 404 });
  });
});

describe('«Своя сумма»', () => {
  it('только число: «100р 50к» — ошибка с примером, «1 000» — оплата на 1000 ₽', async () => {
    const create = vi.spyOn(checkout, 'createTopupPayment').mockResolvedValue({ confirmationUrl: 'https://pay.test/1', token: TOKEN });
    await bot.processUpdate(press('topup:custom'));
    expect(world.session?.state).toBe('await_topup_amount');
    expect(lastScreen().body.text).toContain('например <code>350</code>');
    await bot.processUpdate(message('100р 50к'));
    expect(lastScreen().body.text).toContain('Не понял сумму «100р 50к»');
    expect(create).not.toHaveBeenCalled();
    await bot.processUpdate(message('20'));
    expect(lastScreen().body.text).toContain('пополнить можно от 25 ₽ до 50');
    await bot.processUpdate(message('1 000'));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: 1000 }));
    expect(world.session).toBeNull();
  });

  it('ID клиента вместо суммы — не оплата, а выбор действия с номером; ожидание суммы снято', async () => {
    const create = vi.spyOn(checkout, 'createTopupPayment');
    await bot.processUpdate(press('topup:custom'));
    await bot.processUpdate(message('191607973'));
    expect(create).not.toHaveBeenCalled();
    expect(world.session).toBeNull();
    expect(buttons().some(button => String(button.callback_data).startsWith('code:ask:191607973'))).toBe(true);
  });

  it('ушли с экрана кнопкой суммы или «Назад» — сумму больше не ждём; черновик мастера не трогаем', async () => {
    vi.spyOn(checkout, 'createTopupPayment').mockResolvedValue({ confirmationUrl: 'https://pay.test/1', token: TOKEN });
    await bot.processUpdate(press('topup:custom'));
    await bot.processUpdate(press('topup:home'));
    expect(world.session).toBeNull();
    await bot.processUpdate(press('topup:custom'));
    await bot.processUpdate(press('tp:100'));
    expect(world.session).toBeNull();

    world.session = { telegram_user_id: TG, chat_id: TG, state: 'confirm', updated_at: new Date().toISOString(), draft: { userId: USER, category: 'product', mode: 'custom', code: '47671114039', nonce: '1', msgId: 50 } };
    await bot.processUpdate(press('tp:25~750:gen'));
    expect(world.session?.state).toBe('confirm');
  });
});

describe('«⬅️ Назад» с пополнения', () => {
  it('из профиля — в профиль, из магазина — в магазин; на экране есть «☰ Меню»', async () => {
    await bot.processUpdate(press('menu:profile', 61));
    await bot.processUpdate(press('topup:home', 61));
    expect(buttons().slice(-2).map(button => button.callback_data)).toEqual(['menu:profile', 'menu:home']);
    await bot.processUpdate(press('shop:home', 62));
    await bot.processUpdate(press('topup:home', 62));
    expect(buttons().slice(-2)).toEqual([{ text: '⬅️ Магазин', callback_data: 'shop:home' }, { text: '☰ Меню', callback_data: 'menu:home' }]);
    // «Своя сумма» → «Назад» → снова тот же источник.
    await bot.processUpdate(press('topup:custom', 62));
    await bot.processUpdate(press('topup:home', 62));
    expect(buttons().at(-2)?.callback_data).toBe('shop:home');
  });

  it('текст экрана: что такое баланс и бонус — из констант', async () => {
    await bot.processUpdate(press('topup:home'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('С баланса оплачивается всё в боте');
    expect(text).toContain('💰 На балансе: <b>120 ₽</b>');
    expect(text).toContain('🎁 Пополните от 500 ₽ — добавим 5%, от 1 000 ₽ — 10%.');
  });
});

describe('после оплаты и при отмене (сайт правит экран бота)', () => {
  const topupOrder = (extra: Record<string, unknown> = {}) => ({
    id: 'aaaaaaaa-0000-4000-8000-000000000001', user_id: USER, product_kind: 'wallet_topup', status: 'pending',
    fulfillment_status: 'pending', gross_amount: 500, wallet_topup_kopecks: 52500, created_at: '2026-11-11T10:00:00Z',
    pricing_snapshot: { wallet: { amount: 500, bonus: 25, message: 50 } }, ...extra,
  });

  it('зачислено: экран оплаты — «Оплачено» без ссылки, ниже — «Оплачено 500 ₽ + бонус 25 ₽ = +525 ₽» и «☰ Меню»', async () => {
    await payments.completeOrder(topupOrder(), { status: 'succeeded', paid: true });
    const edit = sent.find(call => call.method === 'editMessageText' && call.body.message_id === 50)!;
    expect(edit.body.text).toContain('✅ Оплачено — деньги на балансе');
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });
    const notice = sent.filter(call => call.method === 'sendMessage' && call.body.chat_id === TG).at(-1)!;
    expect(notice.body.text).toBe('<b>Баланс пополнен ✅</b>\nОплачено 500 ₽ + бонус 25 ₽ = <b>+525 ₽</b>\n💰 На балансе: <b>525 ₽</b>');
    expect(buttons(notice).map(button => button.callback_data)).toContain('n:menu:home');
  });

  it('в том же сообщении уже открыта более новая оплата — старый заказ экран не трогает', async () => {
    world.newer = [{ id: 'newer' }];
    await payments.completeOrder(topupOrder(), { status: 'succeeded', paid: true });
    expect(sent.some(call => call.method === 'editMessageText')).toBe(false);
    expect(sent.some(call => call.method === 'sendMessage' && String(call.body.text).includes('Баланс пополнен'))).toBe(true);
  });

  it('отмена: отказ банка — «Оплата не прошла», брошенная — «ссылка устарела»; без нового сообщения', async () => {
    expect(await payments.notifyTopupCanceled(topupOrder({ pricing_snapshot: { wallet: { amount: 25, then: 'gen', message: 50 } } }), { status: 'canceled', cancellation_details: { reason: 'card_expired' } })).toBe(true);
    let edit = sent.filter(call => call.method === 'editMessageText').at(-1)!;
    expect(edit.body.text).toContain('Оплата не прошла');
    expect(edit.body.text).toContain('Деньги не списаны');
    expect(buttons(edit).map(button => button.callback_data)).toEqual(['tp:25:gen', 'gen:recheck', 'menu:home']);
    await payments.notifyTopupCanceled(topupOrder(), { status: 'canceled', cancellation_details: { reason: 'expired_on_confirmation' } });
    edit = sent.filter(call => call.method === 'editMessageText').at(-1)!;
    expect(edit.body.text).toContain('Ссылка на оплату устарела');
    expect(edit.body.text).not.toContain('не прошла');
    expect(sent.some(call => call.method === 'sendMessage')).toBe(false);
    // Не пополнение, нет экрана — ничего не правим.
    expect(await payments.notifyTopupCanceled(topupOrder({ product_kind: 'stickers' }), { status: 'canceled' })).toBe(false);
    expect(await payments.notifyTopupCanceled(topupOrder({ pricing_snapshot: { wallet: { amount: 500 } } }), { status: 'canceled' })).toBe(false);
  });

  it('покупка после пополнения сама не прошла — уведомление без «Оплачиваю…», прямая кнопка к покупке и баланс', async () => {
    const rpc = require('../../server/_bot-rpc.js') as { callBot: (...args: any[]) => Promise<unknown> };
    vi.spyOn(rpc, 'callBot').mockResolvedValue(false);
    await payments.completeOrder(topupOrder({ pricing_snapshot: { wallet: { amount: 500, then: 'qr:191607973', message: 50 } } }), { status: 'succeeded', paid: true });
    const edit = sent.find(call => call.method === 'editMessageText')!;
    expect(edit.body.text).toBe('<b>Баланс пополнен ✅</b>\nОплачено 500 ₽ + бонус 25 ₽ = <b>+525 ₽</b>');
    const notice = sent.filter(call => call.method === 'sendMessage').at(-1)!;
    expect(notice.body.text).toContain('QR-код клиента не выдан автоматически');
    expect(notice.body.text).toContain('Проверьте, пришёл ли результат выше');
    expect(notice.body.text).toContain('💰 На балансе: <b>525 ₽</b>');
    // На подтверждение с ценой, а не сразу списание: при таймауте покупка могла и пройти.
    expect(buttons(notice).map(button => button.callback_data)).toEqual(['n:code:ask:191607973', 'n:menu:home']);
  });

  it('вебхук и «Проверить оплату» завершили заказ одновременно — итог и покупка после пополнения один раз', async () => {
    const rpc = require('../../server/_bot-rpc.js') as { callBot: (...args: any[]) => Promise<unknown> };
    const after = vi.spyOn(rpc, 'callBot').mockResolvedValue(true);
    const order = topupOrder({ pricing_snapshot: { wallet: { amount: 50, then: 'qr:191607973', message: 50 } } });
    await Promise.all([
      payments.completeOrder({ ...order }, { status: 'succeeded', paid: true }),
      payments.completeOrder({ ...order }, { status: 'succeeded', paid: true }),
    ]);
    expect(after).toHaveBeenCalledTimes(1);
    expect(sent.filter(call => call.method === 'sendMessage' && String(call.body.text).includes('Баланс пополнен'))).toHaveLength(1);
    // Простое пополнение — тоже одно сообщение на заказ.
    await payments.completeOrder(topupOrder({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }), { status: 'succeeded', paid: true });
    await payments.completeOrder(topupOrder({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }), { status: 'succeeded', paid: true });
    expect(sent.filter(call => call.method === 'sendMessage' && String(call.body.text).includes('Баланс пополнен'))).toHaveLength(2);
  });

  it('после пополнения «и получить QR»: уведомление и старый экран оплаты — «итог ниже»', async () => {
    await bot.afterWalletTopup({ id: 'o2', user_id: USER, gross_amount: 50, wallet_topup_kopecks: 5000, pricing_snapshot: { wallet: { then: 'rv:5:0:3', message: 50 } } }, 99).catch(() => {});
    const edits = sent.filter(call => call.method === 'editMessageText');
    expect(edits.find(call => call.body.message_id === 99)?.body.text).toContain('Оплачено <b>50 ₽</b> — итог ниже ⬇️');
    expect(edits.find(call => call.body.message_id === 50)?.body.text).toBe('Баланс пополнен — итог ниже ⬇️');
  });
});

describe('server/_topup-screen.js', () => {
  it('повтор и проверка оплаты укладываются в 64 байта', () => {
    expect(screen.topupRetryData(500, 'shop:cp:n:365:20:both')).toBe('tp:500:shop:cp:n:365:20:both');
    expect(screen.topupRetryData(500, `shop:${'a'.repeat(60)}`)).toBe('tp:500');
    // tp: разбирает только целые рубли — сумма с копейками ведёт на «Своя сумма», а не на «кнопка устарела».
    expect(screen.topupRetryData(350.5, 'gen')).toBe('topup:custom');
    expect(screen.topupRetryData(350.5)).toBe('topup:custom');
    expect(Buffer.byteLength(screen.topupCheckData(TOKEN))).toBeLessThanOrEqual(64);
    expect(screen.topupCheckData('short')).toBeNull();
    expect(screen.topupCheckData(null)).toBeNull();
  });

  it('сумма зачисления расписана; без бонуса — просто «Оплачено»', () => {
    expect(screen.creditedLine(screen.topupAmounts({ gross_amount: 1000, wallet_topup_kopecks: 110000 }))).toBe('Оплачено 1 000 ₽ + бонус 100 ₽ = <b>+1 100 ₽</b>');
    expect(screen.creditedLine(screen.topupAmounts({ gross_amount: 300, wallet_topup_kopecks: 30000 }))).toBe('Оплачено <b>300 ₽</b>');
  });

  it('прямая кнопка к несостоявшейся покупке — по then', () => {
    expect(screen.purchaseRetry('gen').button.callback_data).toBe('menu:stickers');
    expect(screen.purchaseRetry('gen').note).toContain('Номер придётся ввести заново');
    expect(screen.purchaseRetry('rv:5:0:3').button.callback_data).toBe('rv:filters');
    expect(screen.purchaseRetry('qr:123').button.callback_data).toBe('menu:code');
    expect(screen.purchaseRetry('cqa:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee').button.callback_data).toBe('menu:code');
    expect(screen.purchaseRetry('shop:helper:pro:3').button.callback_data).toBe('shop:helper:pro:3');
  });
});
