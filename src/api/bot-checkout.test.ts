import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Deps = { handler?: (req: any, res: any) => Promise<unknown>; loadUser?: (id: string) => Promise<any> };
const { createIndividualPayment, createTopupPayment } = require('../../server/_bot-checkout.js') as {
  createTopupPayment: (
    input: { userId: string; amount: number; then?: string; messageId?: number | null },
    deps?: Deps,
  ) => Promise<{ confirmationUrl: string; token: string | null }>;
  createIndividualPayment: (input: { userId: string; orderId: string }, deps?: Deps) => Promise<{ confirmationUrl: string; token: string | null }>;
};

describe('оплата из бота без Mini App', () => {
  it('создаёт пополнение через общий обработчик платежей от имени пользователя', async () => {
    const seen: any[] = [];
    const handler = vi.fn(async (req: any, res: any) => {
      seen.push(req);
      res.status(200).json({ confirmationUrl: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=1', token: 'tok' });
    });
    const loadUser = vi.fn(async () => ({ id: 'u-1', email: 'telegram-1@users.invalid' }));
    const result = await createTopupPayment({ userId: 'u-1', amount: 500, then: 'gen', messageId: 42 }, { handler, loadUser });
    expect(result).toEqual({ confirmationUrl: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=1', token: 'tok' });
    const req = seen[0];
    expect(req.method).toBe('POST');
    expect(req.query).toEqual({ action: 'create' });
    expect(req.internalUser).toEqual({ id: 'u-1', email: 'telegram-1@users.invalid' });
    expect(req.body).toEqual({ productKind: 'wallet_topup', walletAmount: 500, walletThen: 'gen', walletMessage: 42, accepted: true, returnTo: 'telegram' });
    expect(req.headers['x-forwarded-for']).toBe('telegram-bot:u-1');
  });

  it('без then не передаёт экран, а отказ обработчика превращает в понятную ошибку', async () => {
    const handler = vi.fn(async (req: any, res: any) => {
      expect(req.body.walletThen).toBeUndefined();
      expect(req.body.walletMessage).toBeUndefined();
      res.status(400).json({ error: 'Сумма пополнения — от 20 до 50 000 ₽' });
    });
    const loadUser = vi.fn(async () => ({ id: 'u-2', email: null }));
    await expect(createTopupPayment({ userId: 'u-2', amount: 5 }, { handler, loadUser })).rejects.toThrow('Сумма пополнения');
    // Нет аккаунта — не «войдите заново», а код: бот сбросит кеш связки и повторит сам.
    await expect(createTopupPayment({ userId: 'u-3', amount: 100 }, { handler, loadUser: async () => null })).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('передаёт боту код и статус отказа (ограничение аккаунта, лимит попыток)', async () => {
    const loadUser = vi.fn(async () => ({ id: 'u-4', email: null }));
    const restricted = vi.fn(async (_req: any, res: any) => { res.status(403).json({ error: 'Покупки ограничены', code: 'ACCOUNT_RESTRICTED' }); });
    await expect(createTopupPayment({ userId: 'u-4', amount: 500 }, { handler: restricted, loadUser })).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED', status: 403, message: 'Покупки ограничены' });
    const limited = vi.fn(async (_req: any, res: any) => { res.status(429).json({ error: 'Слишком много запросов' }); });
    await expect(createTopupPayment({ userId: 'u-4', amount: 500 }, { handler: limited, loadUser })).rejects.toMatchObject({ status: 429 });
  });

  it('оплата индивидуального заказа — тот же обработчик, что у кабинета, с возвратом в бот', async () => {
    const seen: any[] = [];
    const handler = vi.fn(async (req: any, res: any) => {
      seen.push(req);
      res.status(200).json({ confirmationUrl: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=2', token: 't2' });
    });
    const loadUser = vi.fn(async () => ({ id: 'u-5', email: 'telegram-5@users.invalid' }));
    const orderId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(await createIndividualPayment({ userId: 'u-5', orderId }, { handler, loadUser })).toEqual({ confirmationUrl: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=2', token: 't2' });
    expect(seen[0].body).toEqual({ productKind: 'individual_stickers', individualOrderId: orderId, accepted: true, returnTo: 'telegram' });
    expect(seen[0].internalUser).toEqual({ id: 'u-5', email: 'telegram-5@users.invalid' });
    expect(seen[0].headers['x-forwarded-for']).toBe('telegram-bot:u-5');
  });

  it('к оплате 0 ₽ — обработчик закрыл заказ и вернул относительный путь: боту «оплачен», а не ссылка', async () => {
    const loadUser = vi.fn(async () => ({ id: 'u-6', email: null }));
    const orderId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const relative = vi.fn(async (_req: any, res: any) => { res.status(201).json({ confirmationUrl: '/payment-result?token=t6', token: 't6' }); });
    expect(await createIndividualPayment({ userId: 'u-6', orderId }, { handler: relative, loadUser })).toEqual({ confirmationUrl: null, token: 't6', paid: true });
    const paidFlag = vi.fn(async (_req: any, res: any) => { res.status(201).json({ token: 't7', paid: true, amount: 0 }); });
    expect(await createIndividualPayment({ userId: 'u-6', orderId }, { handler: paidFlag, loadUser })).toEqual({ confirmationUrl: null, token: 't7', paid: true });
  });
});
