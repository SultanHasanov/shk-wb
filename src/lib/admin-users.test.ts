import { describe, expect, it } from 'vitest';
import {
  fillDailySeries, isTelegramOnly, orderStatusLabel, payerLabel, productLabel, shortDate, userLabel,
} from './admin-users';

describe('помощники раздела «Пользователи»', () => {
  it('узнаёт технический адрес telegram-аккаунта', () => {
    expect(isTelegramOnly('telegram-123@users.invalid')).toBe(true);
    expect(isTelegramOnly('shop@example.com')).toBe(false);
    expect(isTelegramOnly(null)).toBe(false);
  });

  it('подписывает пользователя тем, что у него есть', () => {
    expect(userLabel({ email: 'shop@example.com', userId: 'abcdef12-0000' })).toBe('shop@example.com');
    expect(userLabel({ email: 'telegram-1@users.invalid', telegramUsername: 'ivan', userId: 'abcdef12-0000' })).toBe('@ivan');
    expect(userLabel({ email: null, displayName: 'Иван', userId: 'abcdef12-0000' })).toBe('Иван');
    expect(userLabel({ email: null, userId: 'abcdef12-0000' })).toBe('abcdef12');
  });

  // Сервер отдаёт только дни с регистрациями. Без досыпки пустых суток график
  // рисует ровную линию там, где на самом деле были пропуски.
  it('досыпает пустые дни в график регистраций', () => {
    const today = new Date('2026-09-10T12:00:00Z');
    const series = fillDailySeries([{ day: '2026-09-09', count: 3 }], 3, today);
    expect(series).toEqual([
      { day: '2026-09-08', count: 0 },
      { day: '2026-09-09', count: 3 },
      { day: '2026-09-10', count: 0 },
    ]);
  });

  it('переводит служебные значения на человеческий язык', () => {
    expect(productLabel('cell_print_license')).toBe('Ключи «Печати ячеек»');
    expect(productLabel('неизвестное')).toBe('неизвестное');
    expect(payerLabel('self_employed')).toBe('Самозанятый');
    expect(payerLabel(null)).toBe('—');
    expect(orderStatusLabel('succeeded')).toBe('Оплачен');
    expect(orderStatusLabel('pending')).toBe('Ожидает оплаты');
  });

  it('не падает на пустой и битой дате', () => {
    expect(shortDate(null)).toBe('—');
    expect(shortDate('не дата')).toBe('—');
    expect(shortDate('2026-09-09T10:00:00Z')).toContain('09');
  });
});
