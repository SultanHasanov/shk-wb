import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const payments = require('../../api/payments.js') as Handler;
const auth = require('../../api/auth.js') as Handler;

const MAIN_AUTH = `Basic ${Buffer.from('main-shop:main-secret').toString('base64')}`;
const SITE_AUTH = `Basic ${Buffer.from('site-shop:site-secret').toString('base64')}`;
const SITE_HOST = 'pvzprint.test';
const ENV = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_PUBLISHABLE_KEY: 'pub',
  SUPABASE_SECRET_KEY: 'secret',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  STICKER_CLIENT_SECRET: 'sticker-secret',
  PUBLIC_APP_URL: 'https://shk-wb.ru',
  YOOKASSA_SHOP_ID: 'main-shop',
  YOOKASSA_SECRET_KEY: 'main-secret',
  PVZPRINT_ORIGIN: `https://${SITE_HOST}`,
  YOOKASSA_PVZPRINT_SHOP_ID: 'site-shop',
  YOOKASSA_PVZPRINT_SECRET_KEY: 'site-secret',
  YANDEX_OAUTH_CLIENT_ID: 'ya-id',
  YANDEX_OAUTH_CLIENT_SECRET: 'ya-secret',
};

function response() {
  const res: { statusCode: number; body: any; headers: Record<string, string> } & Record<string, any> = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.setHeader = (key: string, value: string) => { res.headers[key] = value; };
  res.end = () => res;
  return res;
}

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[];
let pendingOrders: Array<Record<string, unknown>>;
let foundOrder: Record<string, unknown> | null;

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const call: Call = {
      url,
      method: String(init.method || 'GET'),
      headers: (init.headers || {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('api.yookassa.ru')) {
      if (url.endsWith('/payments') && call.method === 'POST') return reply({ id: 'pay-1', status: 'pending', confirmation: { confirmation_url: 'https://yookassa.test/checkout' } });
      return reply({ id: 'pay-1', status: 'pending', paid: false });
    }
    if (url.includes('/auth/v1/user')) return reply({ id: 'user-1', email: 'buyer@example.com' });
    if (url.includes('rate_limit')) return reply(true);
    if (url.includes('payment_settings')) return reply([{ enabled: true }]);
    if (url.includes('payment_orders?user_id=')) return reply(pendingOrders);
    if (url.includes('payment_orders?yookassa_payment_id=') || url.includes('payment_orders?public_token=')) return reply(foundOrder ? [foundOrder] : []);
    if (url.endsWith('/payment_orders') && call.method === 'POST') return reply([{ id: 'order-1', amount: call.body.amount, ...call.body }], 201);
    if (url.includes('payment_orders?id=')) return reply([]);
    return reply({ message: `unexpected ${url}` }, 404);
  }));
}

const create = (host: string, body: Record<string, unknown> = {}) => ({
  method: 'POST',
  query: { action: 'create' },
  headers: { 'x-forwarded-host': host, authorization: 'Bearer token' },
  socket: { remoteAddress: '127.0.0.1' },
  body: { productKind: 'cell_print_license', durationDays: 30, deviceLimit: 1, marketplaceScope: 'wb', accepted: true, ...body },
});

const yookassaCalls = () => calls.filter(call => call.url.includes('api.yookassa.ru'));

describe('отдельный магазин ЮKassa для сайта ПВЗ Принт', () => {
  beforeEach(() => {
    calls = [];
    pendingOrders = [];
    foundOrder = null;
    Object.assign(process.env, ENV);
    installFetch();
  });
  afterEach(() => {
    for (const key of Object.keys(ENV)) delete process.env[key];
    vi.unstubAllGlobals();
  });

  it('заказ с сайта идёт в его магазин и возвращает покупателя на его домен', async () => {
    const res = response();
    await payments(create(SITE_HOST), res);
    expect(res.statusCode).toBe(201);
    const [payment] = yookassaCalls();
    expect(payment.headers.Authorization).toBe(SITE_AUTH);
    expect(payment.body.confirmation.return_url.startsWith(`https://${SITE_HOST}/payment-result?token=`)).toBe(true);
    const inserted = calls.find(call => call.url.endsWith('/payment_orders'))!;
    expect(inserted.body.payment_shop).toBe('pvzprint');
    expect(inserted.body.amount).toBe(249);
  });

  it('заказ основного сайта остаётся в основном магазине и без отметки', async () => {
    const res = response();
    await payments(create('shk-wb.ru'), res);
    expect(res.statusCode).toBe(201);
    const [payment] = yookassaCalls();
    expect(payment.headers.Authorization).toBe(MAIN_AUTH);
    expect(payment.body.confirmation.return_url.startsWith('https://shk-wb.ru/payment-result?token=')).toBe(true);
    const inserted = calls.find(call => call.url.endsWith('/payment_orders'))!;
    expect('payment_shop' in inserted.body).toBe(false);
  });

  it('без реквизитов своего магазина оплата выключена, основной магазин не подставляется', async () => {
    delete process.env.YOOKASSA_PVZPRINT_SECRET_KEY;
    const res = response();
    await payments(create(SITE_HOST), res);
    expect(res.statusCode).toBe(503);
    expect(yookassaCalls()).toHaveLength(0);
  });

  it('сайт продаёт только ключи печати ячеек', async () => {
    const res = response();
    await payments(create(SITE_HOST, { productKind: 'wallet_topup', walletAmount: 100 }), res);
    expect(res.statusCode).toBe(400);
    expect(yookassaCalls()).toHaveLength(0);
  });

  it('неоплаченный счёт основного сайта не выдаётся на сайте ПВЗ Принт', async () => {
    pendingOrders = [{ public_token: 't', confirmation_url: 'https://yookassa.test/old', payment_shop: null }];
    const res = response();
    await payments(create(SITE_HOST), res);
    expect(res.body.reused).toBeUndefined();
    expect(res.body.confirmationUrl).toBe('https://yookassa.test/checkout');
  });

  it('свой неоплаченный счёт переиспользуется, но только для того же маркетплейса и тарифа', async () => {
    pendingOrders = [{ public_token: 't', confirmation_url: 'https://yookassa.test/old', payment_shop: 'pvzprint' }];
    const res = response();
    await payments(create(SITE_HOST, { marketplaceScope: 'ozon' }), res);
    expect(res.body.reused).toBe(true);
    const lookup = calls.find(call => call.url.includes('payment_orders?user_id='))!;
    expect(lookup.url).toContain('cell_print_marketplace_scope=eq.ozon');
    expect(lookup.url).toContain('cell_print_duration_days=eq.30');
    expect(lookup.url).toContain('cell_print_device_limit=eq.1');
  });

  it('статус заказа проверяется реквизитами его магазина на любом домене', async () => {
    foundOrder = { id: 'order-1', public_token: 'x'.repeat(43), yookassa_payment_id: 'pay-1', payment_shop: 'pvzprint', fulfillment_status: 'pending', status: 'pending', provider_status: 'pending', amount: 249 };
    const res = response();
    await payments({ method: 'GET', query: { action: 'status', token: 'x'.repeat(43) }, headers: { host: 'shk-wb.ru' } }, res);
    expect(res.statusCode).toBe(200);
    expect(yookassaCalls()[0].headers.Authorization).toBe(SITE_AUTH);
  });

  it('вебхук проверяет платёж в магазине своего домена и не трогает заказ другого магазина', async () => {
    foundOrder = { id: 'order-1', yookassa_payment_id: 'pay-1', payment_shop: null, fulfillment_status: 'pending' };
    const res = response();
    await payments({ method: 'POST', query: { action: 'webhook' }, headers: { host: SITE_HOST }, body: { event: 'payment.succeeded', object: { id: 'pay-1' } } }, res);
    expect(res.statusCode).toBe(200);
    expect(yookassaCalls()[0].headers.Authorization).toBe(SITE_AUTH);
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('вход через Яндекс возвращается на домен того сайта, где начат', async () => {
    const start = (host: string) => ({ method: 'GET', query: { action: 'oauth', step: 'start', provider: 'yandex' }, headers: { host } });
    const onSite = response();
    await auth(start(SITE_HOST), onSite);
    expect(new URL(onSite.headers.Location).searchParams.get('redirect_uri')).toBe(`https://${SITE_HOST}/api/auth/oauth/yandex/callback`);
    const onMain = response();
    await auth(start('shk-wb.ru'), onMain);
    expect(new URL(onMain.headers.Location).searchParams.get('redirect_uri')).toBe('https://shk-wb.ru/api/auth/oauth/yandex/callback');
  });

  it('бота для входа через Telegram сайт получает только на своём домене', async () => {
    process.env.PVZPRINT_TELEGRAM_BOT_USERNAME = 'pvzprint_login_bot';
    const providers = (host: string) => ({ method: 'GET', query: { action: 'oauth', step: 'providers' }, headers: { host } });
    const onSite = response();
    await auth(providers(SITE_HOST), onSite);
    expect(onSite.body.telegramBot).toBe('pvzprint_login_bot');
    const onMain = response();
    await auth(providers('shk-wb.ru'), onMain);
    expect(onMain.body.telegramBot).toBeUndefined();
    delete process.env.PVZPRINT_TELEGRAM_BOT_USERNAME;
  });
});
