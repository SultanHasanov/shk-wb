import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createTopupPayment } = require('../../server/_bot-checkout.js') as {
  createTopupPayment: (
    input: { userId: string; amount: number; then?: string; messageId?: number | null },
    deps?: { handler?: (req: any, res: any) => Promise<unknown>; loadUser?: (id: string) => Promise<any> },
  ) => Promise<{ confirmationUrl: string; token: string | null }>;
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
    await expect(createTopupPayment({ userId: 'u-3', amount: 100 }, { handler, loadUser: async () => null })).rejects.toThrow('Кабинет не найден');
  });
});
