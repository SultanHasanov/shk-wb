import { describe, expect, it } from 'vitest';
import { forgetPendingOrder, readPendingOrders, rememberPendingOrder } from './pending-orders';

/** Токен заказа — 32 случайных байта в base64url, то есть 43 символа. */
const token = (seed: string) => seed.padEnd(43, 'x');

function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('заказы, ожидающие привязки к аккаунту', () => {
  it('запоминает токен и отдаёт его обратно', () => {
    const s = storage();
    rememberPendingOrder(s, token('a'));
    expect(readPendingOrders(s)).toEqual([token('a')]);
  });

  it('не дублирует один и тот же заказ', () => {
    const s = storage();
    rememberPendingOrder(s, token('a'));
    rememberPendingOrder(s, token('a'));
    rememberPendingOrder(s, token('b'));
    expect(readPendingOrders(s)).toEqual([token('a'), token('b')]);
  });

  it('забывает забранный заказ и чистит ключ, когда их не осталось', () => {
    const s = storage();
    rememberPendingOrder(s, token('a'));
    forgetPendingOrder(s, token('a'));
    expect(readPendingOrders(s)).toEqual([]);
    expect(s.data.has('pending_order_tokens_v1')).toBe(false);
  });

  // Значение приходит из localStorage, куда мог записать кто угодно, поэтому
  // мусор не должен ни падать, ни уезжать в запрос привязки.
  it('игнорирует мусор вместо токена', () => {
    expect(readPendingOrders(storage({ pending_order_tokens_v1: 'не json' }))).toEqual([]);
    expect(readPendingOrders(storage({ pending_order_tokens_v1: '{"a":1}' }))).toEqual([]);
    expect(readPendingOrders(storage({ pending_order_tokens_v1: '["короткий","../../etc"]' }))).toEqual([]);
    const s = storage();
    rememberPendingOrder(s, 'короткий');
    expect(readPendingOrders(s)).toEqual([]);
  });

  it('переживает запрет на запись в хранилище', () => {
    const blocked = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => rememberPendingOrder(blocked, token('a'))).not.toThrow();
    expect(readPendingOrders(blocked)).toEqual([]);
  });
});
