import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Магазин бота (этап D): подписка «Помощника» — лимиты тарифа, что станет с текущей подпиской, «что дальше»
// со входом через бота; ключ «ПВЗ Принт» — отдельным сообщением, строками на экране и в профиле, пробный не
// продлевается; пакет кодов клиента; подтверждение покупки с балансом словами и пополнением с запасом;
// ошибка покупки — по исходу денег (payWithWallet); напоминание за 2 дня.

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as { processUpdate: (update: Record<string, unknown>) => Promise<void> };
const wallet = require('../../server/_wallet.js') as Record<string, any>;
const cabinet = require('../../api/cabinet.js') as { notifyTelegramExpiry2d: () => Promise<number> };
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };

const USER = '9f9f9f9f-1111-2222-3333-444455556666';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let tgSeq = 720000000;
let TG = 0;
let from = { id: 0, first_name: 'Аня' };
let updateId = 40000;
const press = (data: string, messageId = 50) => ({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, from, data, message: { message_id: messageId, chat: { id: TG, type: 'private' } } } });

type World = {
  balance: number;
  ent: Record<string, unknown> | null;
  cellKeys: Array<Record<string, unknown>>;
  licenseKey: Record<string, unknown> | null;
  rpc: Record<string, (body: any) => Response>;
  orders: Array<Record<string, unknown>>;
};
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
  world = { balance: 12000, ent: null, cellKeys: [], licenseKey: null, rpc: {}, orders: [] };
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
    const rpc = path.startsWith('rpc/') ? world.rpc[path.slice(4)] : null;
    if (rpc) return rpc(body);
    if (path.startsWith('telegram_bot_updates')) return json([{ update_id: 1 }]);
    if (path.startsWith('user_telegram_identities?telegram_user_id=eq.')) return json([{ user_id: USER, telegram_user_id: TG }]);
    if (path.startsWith('user_telegram_identities?user_id=eq.')) return json([{ telegram_user_id: TG }]);
    if (path.startsWith('wallet_accounts')) return json([{ balance_kopecks: world.balance }]);
    if (path === 'rpc/app_entitlements') return json(world.ent || {});
    if (path.startsWith('cell_print_licenses?id=eq.')) {
      const id = Number(path.split('id=eq.')[1].split('&')[0]);
      return json(world.cellKeys.filter(key => key.id === id));
    }
    if (path.startsWith('cell_print_licenses')) return json(world.cellKeys);
    if (path.startsWith('license_keys')) return json(world.licenseKey ? [world.licenseKey] : []);
    if (path.startsWith('telegram_generation_requests?on_conflict')) return json([body]);
    if (path.startsWith('payment_orders') && method === 'POST') return json([{ id: 'order-1', ...body }]);
    if (path.startsWith('notifications') && method === 'POST') return json([{ id: 'n1' }]);
    if (path === 'rpc/consume_api_rate_limit') return json(true);
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
const datas = (call?: { body: Record<string, any> }) => buttons(call).map(button => button.callback_data || button.url);

describe('подписка «Помощника ПВЗ»', () => {
  it('экран тарифов: что входит в каждый — компьютеры, пункты, коды и стикеры «Про»', async () => {
    await bot.processUpdate(press('shop:helper'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('<b>Стандарт — 239 ₽/мес</b>: ячейки, товары, поиск клиента и заметки. 2 компьютера, 1 пункт.');
    expect(text).toContain('4 компьютера, 2 пункта; 10 кодов клиента и 50 стикеров в месяц');
    expect(datas().slice(-2)).toEqual(['shop:home', 'menu:home']);
  });

  it('экран срока говорит, что станет с текущей подпиской: нет / тот же / повышение / понижение', async () => {
    await bot.processUpdate(press('shop:helper:pro'));
    expect(lastScreen().body.text).toContain('Подписка начнётся сразу после оплаты.');
    expect(buttons().find(button => button.callback_data === 'shop:helper:pro:3')?.text).toBe('3 месяца — 934 ₽ (−22%, 311 ₽/мес)');

    world.ent = { plan: 'pro', ends_at: '2026-12-19T10:00:00Z', paid_until: '2026-12-19T10:00:00Z' };
    await bot.processUpdate(press('shop:helper:pro'));
    expect(lastScreen().body.text).toContain('Срок прибавится к текущему (сейчас до 19.12).');

    world.ent = { plan: 'standard', ends_at: '2026-12-19T10:00:00Z', paid_until: '2026-12-19T10:00:00Z' };
    await bot.processUpdate(press('shop:helper:pro'));
    expect(lastScreen().body.text).toContain('Остаток «Стандарт» пересчитаем в дни «Про» — ничего не сгорит.');

    world.ent = { plan: 'pro', ends_at: '2026-12-19T10:00:00Z', paid_until: '2026-12-19T10:00:00Z' };
    await bot.processUpdate(press('shop:helper:standard'));
    expect(lastScreen().body.text).toContain('«Стандарт» начнётся после окончания текущей подписки — с 19.12.');
  });

  it('после оплаты — до какого числа и «что дальше»: скачать и войти через бота', async () => {
    world.ent = { plan: 'standard', ends_at: '2026-12-19T10:00:00Z', paid_until: '2026-12-19T10:00:00Z' };
    vi.spyOn(wallet, 'payWithWallet').mockResolvedValue({ ok: true, order: { id: 'o1' }, balanceKopecks: 2100 });
    await bot.processUpdate(press('shop:pay:123456:helper:standard:1'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('Подписка «Помощник ПВЗ» оплачена: тариф «Стандарт». Действует до <b>19.12</b>.');
    expect(text).toContain('https://shk-wb.ru/program');
    expect(text).toContain('«Войти через сайт», на открывшейся странице — «Подтвердить в Telegram-боте»');
    expect(text).toContain('Уже входите в программу по почте и паролю? Напишите в поддержку');
    expect(text).toContain('💰 На балансе: 21 ₽');
    expect(text).not.toContain('Осталось');
  });

  it('понижение: «Готово» говорит, с какого числа начнётся купленный тариф', async () => {
    world.ent = { plan: 'pro', ends_at: '2026-12-19T10:00:00Z', paid_until: '2027-01-19T10:00:00Z' };
    vi.spyOn(wallet, 'payWithWallet').mockResolvedValue({ ok: true, order: { id: 'o1' }, balanceKopecks: 0 });
    await bot.processUpdate(press('shop:pay:123457:helper:standard:1'));
    expect(lastScreen().body.text).toContain('Начнётся 19.12, после текущей подписки, и будет действовать до <b>19.01</b>.');
  });
});

describe('подтверждение покупки', () => {
  it('денег хватает — цена и баланс отдельными строками, «Назад» и «Меню»', async () => {
    await bot.processUpdate(press('shop:helper:standard:1'));
    expect(lastScreen().body.text).toContain('Цена: <b>239 ₽</b>\n💰 На балансе: 120 ₽');
    expect(datas().slice(-2)).toEqual(['shop:helper:standard', 'menu:home']);
  });

  it('не хватает — сколько, и пополнение ровно на нехватку или с запасом с той же покупкой', async () => {
    await bot.processUpdate(press('shop:helper:standard:3'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('💰 На балансе: 120 ₽ — не хватает <b>439 ₽</b>');
    expect(text).toContain('После пополнения покупка пройдёт сама');
    expect(text).toContain('Или пополните с запасом кнопками ниже');
    expect(datas()).toEqual([
      'tp:439~43900:shop:helper:standard:3',
      'tp:500~43900:shop:helper:standard:3',
      'tp:1000~43900:shop:helper:standard:3',
      'shop:helper:standard', 'menu:home',
    ]);
    expect(buttons()[1].text).toBe('500 ₽ (+25 ₽)');
    for (const data of datas()) expect(Buffer.byteLength(String(data))).toBeLessThanOrEqual(64);
  });
});

describe('ошибка покупки — по исходу денег, без текста ошибки', () => {
  const fail = (outcome: string) => vi.spyOn(wallet, 'payWithWallet').mockRejectedValue(Object.assign(new Error('Renewal target is unavailable'), { walletOutcome: outcome, orderId: 'order-9' }));

  it('вернули — «деньги вернулись», баланс, код обращения и «Попробовать снова»', async () => {
    fail('refunded');
    await bot.processUpdate(press('shop:pay:111111:wbpk:10'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('Деньги за неё вернулись на баланс.');
    expect(text).toContain('💰 На балансе: 120 ₽');
    expect(text).toMatch(/код: <code>[0-9a-f]{6}<\/code>/);
    expect(text).not.toContain('Renewal target');
    expect(datas()[0]).toBe('shop:wbpk:10');
  });

  it('не списали — «не списаны»; возврат не удался — «вернём вручную», без повтора', async () => {
    fail('not_charged');
    await bot.processUpdate(press('shop:pay:222222:wbpk:10'));
    expect(lastScreen().body.text).toContain('Деньги за неё не списаны.');
    fail('refund_failed');
    await bot.processUpdate(press('shop:pay:333333:wbpk:10'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('деньги за неё пока не вернулись на баланс');
    expect(text).toContain('вернём 90 ₽ вручную');
    expect(datas().some(data => String(data).startsWith('shop:wbpk'))).toBe(false);
  });
});

describe('ключ «ПВЗ Принт»', () => {
  it('купленный ключ — отдельным сообщением без кнопок: что куплено и как включить', async () => {
    vi.spyOn(wallet, 'payWithWallet').mockResolvedValue({ ok: true, order: { id: 'o1', cell_print_license_key: 'CP-AAAA-BBBB' }, balanceKopecks: 0 });
    await bot.processUpdate(press('shop:pay:444444:cp:n:30:1:wb'));
    const keyMessage = sent.find(call => call.method === 'sendMessage' && String(call.body.text).includes('CP-AAAA-BBBB'))!;
    expect(keyMessage.body.reply_markup).toBeUndefined();
    expect(keyMessage.body.text).toContain('<code>CP-AAAA-BBBB</code>');
    expect(keyMessage.body.text).toContain('30 дней · 1 компьютер · Wildberries');
    expect(keyMessage.body.text).toContain('«Ключ без аккаунта» и нажмите «Активировать»');
    expect(keyMessage.body.text).toContain('https://shk-wb.ru/cell-print');
    const done = sent.find(call => call.method === 'editMessageText' && String(call.body.text).includes('Готово'))!;
    expect(done.body.text).toContain('он в сообщении ниже');
    expect(done.body.text).not.toContain('CP-AAAA-BBBB');
    expect(datas(done)).toContain('shop:cp');
  });

  it('экран ключей: ключи строками; пробный — без «Продлить», с советом купить ключ', async () => {
    world.cellKeys = [
      { id: 7, key: 'CP-TRIAL', source: 'trial', duration_days: 7, device_limit: 1, marketplace_scope: 'both', activated_at: '2026-11-10T00:00:00Z', expires_at: '2026-11-17T00:00:00Z' },
    ];
    await bot.processUpdate(press('shop:cp'));
    let text = String(lastScreen().body.text);
    expect(text).toContain('<b>🖨 Ключ «ПВЗ Принт» (печать ячеек)</b>');
    expect(text).toContain('<code>CP-TRIAL</code> — пробный, до 17.11.2026 · 1 компьютер · WB + Ozon');
    expect(text).toContain('Пробный период до 17.11. Чтобы печать не остановилась, купите ключ');
    expect(datas()).toEqual(['shop:cp:n', 'shop:home', 'menu:home']);
    // Старая кнопка продления пробного ключа (из чата или напоминания) — отказ, не продажа по цене «WB + Ozon».
    await bot.processUpdate(press('shop:cp:r:7:30'));
    text = String(lastScreen().body.text);
    expect(text).toContain('Пробный ключ не продлевается');
    expect(datas()[0]).toBe('shop:cp:n');
  });

  it('обычный ключ продлевается, на экране продления сказано, почему такая цена', async () => {
    world.cellKeys = [{ id: 8, key: 'CP-PAID', source: 'payment', duration_days: 30, device_limit: 2, marketplace_scope: 'wb', activated_at: '2026-11-01T00:00:00Z', expires_at: '2026-12-01T00:00:00Z' }];
    await bot.processUpdate(press('shop:cp'));
    expect(datas()[0]).toBe('shop:cp:r:8');
    await bot.processUpdate(press('shop:cp:r:8'));
    expect(lastScreen().body.text).toContain('Цена — для 2 компьютера и площадки Wildberries, как у ключа.');
  });

  it('профиль: «На балансе», программы отдельным блоком, ключ виден строкой', async () => {
    world.cellKeys = [{ id: 8, key: 'CP-PAID', source: 'payment', duration_days: 30, device_limit: 1, marketplace_scope: 'wb', activated_at: '2026-11-01T00:00:00Z', expires_at: '2026-12-01T00:00:00Z' }];
    world.ent = { packs_left: 3 };
    await bot.processUpdate(press('menu:profile'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('💰 На балансе: <b>120 ₽</b>');
    expect(text).toContain('🔑 Коды клиента в пакете: 3');
    expect(text).toContain('<b>Программы для компьютера</b>');
    expect(text).toContain('🖨 ПВЗ Принт (печать ячеек): до 01.12');
    expect(text).toContain('<code>CP-PAID</code> — до 01.12.2026 · 1 компьютер · Wildberries');
    expect(text).not.toContain('Печать ячеек');
  });

  it('экран программы: новое название и пробный период честно — «можно включить, один раз»', async () => {
    await bot.processUpdate(press('menu:cellprint'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('ПВЗ Принт — печать ячеек');
    expect(text).toContain('В программе можно включить 7 дней бесплатно — один раз, до покупки ключа.');
    expect(text).toContain('от 79 ₽ за 7 дней');
    expect(text).not.toContain('программа бесплатная');
  });
});

describe('пакет кодов клиента', () => {
  it('новое название, работает и в боте, и в программе; без «Ваш ключ»', async () => {
    world.licenseKey = { key: 'WB-KEY', usage_limit: 10, used: 7 };
    await bot.processUpdate(press('shop:wbpk'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('<b>🔑 Пакет кодов клиента</b>');
    expect(text).toContain('Работает и здесь в боте, и в программе «Помощник ПВЗ»');
    expect(text).toContain('В вашем пакете осталось: 3');
    expect(text).not.toMatch(/подбор|Ваш ключ/);
    // Цены не менялись.
    expect(buttons().find(button => button.callback_data === 'shop:wbpk:10')?.text).toBe('10 шт. — 90 ₽');
  });

  it('после покупки — где коды сработают', async () => {
    vi.spyOn(wallet, 'payWithWallet').mockResolvedValue({ ok: true, order: { id: 'o1' }, balanceKopecks: 3000 });
    await bot.processUpdate(press('shop:pay:555555:wbpk:10'));
    expect(lastScreen().body.text).toContain('+10 кодов клиента в пакете. Они спишутся сами — здесь в боте');
  });
});

describe('payWithWallet сообщает, что стало с деньгами', () => {
  const pay = () => wallet.payWithWallet({ userId: USER, productKind: 'program_license', fields: { license_iterations: 10 }, priceRub: 90, snapshot: {} });

  it('выдача упала, возврат прошёл — refunded', async () => {
    world.rpc.wallet_pay_order = () => json({ ok: true, balance: 3000 });
    world.rpc.complete_program_license_order = () => json({ message: 'boom' }, 500);
    world.rpc.wallet_refund_order = () => json({ ok: true, balance: 12000 });
    await expect(pay()).rejects.toMatchObject({ walletOutcome: 'refunded', orderId: 'order-1' });
  });

  it('выдача упала, возврат тоже — refund_failed', async () => {
    world.rpc.wallet_pay_order = () => json({ ok: true, balance: 3000 });
    world.rpc.complete_program_license_order = () => json({ message: 'boom' }, 500);
    world.rpc.wallet_refund_order = () => json({ message: 'timeout' }, 500);
    await expect(pay()).rejects.toMatchObject({ walletOutcome: 'refund_failed' });
  });

  it('ответ списания потерялся, а списания не было — not_charged, заказ отменён', async () => {
    world.rpc.wallet_pay_order = () => json({ message: 'relay timeout' }, 500);
    world.rpc.wallet_refund_order = () => json({ ok: false, reason: 'not_paid' });
    await expect(pay()).rejects.toMatchObject({ walletOutcome: 'not_charged' });
    expect(db.some(call => call.method === 'PATCH' && call.path.startsWith('payment_orders?id=eq.order-1') && call.body.status === 'canceled')).toBe(true);
  });
});

describe('напоминание за 2 дня (api/cabinet.js)', () => {
  it('ключ: цена продления и нехватка; пробный — «купить ключ»; подписка — тариф, цена за месяц', async () => {
    const soon = new Date(Date.now() + 1.5 * 86400000).toISOString();
    world.balance = 10000;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const address = String(url);
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (!address.startsWith('https://db.test')) { sent.push({ method: address.split('/').pop() || '', body: body || {} }); return json({ ok: true, result: { message_id: 1 } }); }
      const path = decodeURIComponent(address.split('/rest/v1/')[1] || '');
      if (path.startsWith('cell_print_licenses')) return json([
        { id: 1, key: 'CP-PAID', source: 'payment', device_limit: 1, marketplace_scope: 'both', owner_user_id: USER, expires_at: soon },
        { id: 2, key: 'CP-TRIAL', source: 'trial', device_limit: 1, marketplace_scope: 'both', owner_user_id: USER, expires_at: soon },
      ]);
      if (path.startsWith('app_settings') || path.startsWith('app_free')) return json([]);
      if (path.startsWith('app_subscriptions') && path.includes('ends_at=gte.')) return json([{ id: 's1', user_id: USER, plan: 'standard', ends_at: soon }]);
      if (path.startsWith('app_subscriptions')) return json([]);
      if (path.startsWith('user_telegram_identities')) return json([{ telegram_user_id: TG }]);
      if (path.startsWith('user_preferences')) return json([]);
      if (path.startsWith('wallet_accounts')) return json([{ balance_kopecks: world.balance }]);
      if (path.startsWith('in_app_notifications')) return json([{ id: `n${Math.random()}` }]);
      return json([]);
    }));
    await cabinet.notifyTelegramExpiry2d();
    const messages = sent.filter(call => call.method === 'sendMessage').map(call => call);
    const paid = messages.find(call => String(call.body.text).includes('CP-PAID'))!;
    expect(paid.body.text).toContain('Ключ «ПВЗ Принт» заканчивается');
    expect(paid.body.text).toContain('Продление на 30 дней — 448 ₽');
    expect(paid.body.text).toContain('💰 На балансе: 100 ₽ — не хватает 348 ₽');
    expect(datas(paid)).toEqual(['n:shop:cp:r:1', 'n:topup:home', 'n:menu:home']);
    const trial = messages.find(call => String(call.body.text).includes('Пробный период'))!;
    expect(trial.body.text).toContain('купите ключ');
    expect(datas(trial)[0]).toBe('n:shop:cp:n');
    const sub = messages.find(call => String(call.body.text).includes('Помощник ПВЗ'))!;
    expect(sub.body.text).toContain('Подписка «Помощник ПВЗ» заканчивается');
    expect(sub.body.text).toContain('Тариф «Стандарт». Продление на месяц — 239 ₽, новый срок прибавится к текущему.');
    expect(sub.body.text).toContain('не хватает 139 ₽');
    expect(datas(sub)[0]).toBe('n:shop:helper:standard');
    expect(messages.every(call => !String(call.body.text).includes('Печат'))).toBe(true);
  });
});
