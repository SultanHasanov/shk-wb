import { describe, expect, it } from 'vitest';
import type { AdminUserRow } from '../api/admin';
import {
  USER_FILTERS, accountsLabel, customOrderStatusLabel, fillDailySeries, filterLabel, initials, isTelegramOnly,
  lastActivity, marketplaceLabel, orderStatusLabel, parseUsersParams, payerLabel, pluralAccounts, productLabel,
  rangeLabel, relativeSeen, revenueCell, shortDate, slotsLabel, tariffCell, userBadges, userLabel, userNameAndContact,
  usersParamsToSearch, usersToCsv, withdrawalStatusLabel,
} from './admin-users';

const row: AdminUserRow = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'shop@example.com',
  emailConfirmed: true,
  telegramOnly: false,
  banned: false,
  createdAt: '2026-08-01T10:00:00Z',
  lastSignInAt: '2026-11-09T18:15:00Z',
  displayName: 'Анна Смирнова',
  phone: '+79990000000',
  payerStatus: null,
  telegramUsername: 'anna',
  codes: 0,
  generationLimit: 0,
  generationUsed: 0,
  programKeys: 0,
  cellLicenses: 0,
  cellActive: 0,
  ordersPaid: 14,
  revenueKopecks: 683000,
  refundedKopecks: 0,
  lastOrderAt: null,
  referralCode: null,
  referralEarnedKopecks: 0,
  referralAvailableKopecks: 0,
  invited: 0,
  walletKopecks: 125000,
  app: { plan: 'pro', endsAt: '2027-01-03T10:00:00Z', paidUntil: '2027-01-03T10:00:00Z', expiresInDays: 54 },
  devices: { used: 3, limit: null },
  points: { used: 2, limit: null },
  lastSeenAt: '2026-11-10T11:02:00Z',
  restricted: false,
  restriction: null,
  unlimited: true,
  unlimitedUntil: null,
};

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

describe('список пользователей: адрес и подписи', () => {
  it('читает состояние из адреса и отбрасывает мусор', () => {
    expect(parseUsersParams(new URLSearchParams('q=ivan&filter=restricted&sort=balance&page=3&size=50'))).toEqual({
      q: 'ivan', filter: 'restricted', sort: 'balance', page: 2, pageSize: 50,
    });
    expect(parseUsersParams(new URLSearchParams('filter=hack&sort=drop&page=-1&size=7'))).toEqual({
      q: '', filter: 'all', sort: 'created_at', page: 0, pageSize: 25,
    });
    // Старые фильтры из закладок сервер понимает — не теряем их.
    expect(parseUsersParams(new URLSearchParams('filter=banned')).filter).toBe('banned');
  });

  it('пишет в адрес только то, что отличается от умолчаний', () => {
    expect(usersParamsToSearch({ q: '', filter: 'all', sort: 'created_at', page: 0, pageSize: 25 }).toString()).toBe('');
    const params = usersParamsToSearch({ q: 'иван', filter: 'expiring', sort: 'expiring', page: 1, pageSize: 100 });
    expect(parseUsersParams(params)).toEqual({ q: 'иван', filter: 'expiring', sort: 'expiring', page: 1, pageSize: 100 });
    expect(params.get('page')).toBe('2');
  });

  it('чипы — восемь фильтров макета', () => {
    expect(USER_FILTERS.map(item => item.value)).toEqual([
      'all', 'paying', 'subscribed', 'expiring', 'unlimited', 'restricted', 'telegram', 'inactive',
    ]);
    expect(filterLabel('expiring')).toBe('Истекает ≤ 7 дней');
  });

  it('склоняет «аккаунт» и считает диапазон страницы', () => {
    expect(pluralAccounts(1)).toBe('аккаунт');
    expect(pluralAccounts(4)).toBe('аккаунта');
    expect(pluralAccounts(11)).toBe('аккаунтов');
    expect(pluralAccounts(87)).toBe('аккаунтов');
    // Intl ставит неразрывный пробел между разрядами — сравниваем по обычному.
    const plain = (text: string) => text.replace(/\s/g, ' ');
    expect(plain(accountsLabel(1284))).toBe('1 284 аккаунта');
    expect(plain(rangeLabel(0, 25, 25, 1284))).toBe('1–25 из 1 284');
    expect(rangeLabel(2, 25, 9, 59)).toBe('51–59 из 59');
    expect(rangeLabel(0, 25, 0, 0)).toBe('');
  });

  it('колонка тарифа: до даты, бессрочный безлимит, скоро истекает', () => {
    expect(tariffCell(row)).toEqual({ text: 'Про · до 03.01', expiring: null, empty: false });
    expect(tariffCell({ ...row, app: { plan: 'standard', endsAt: '2026-11-13T10:00:00Z', paidUntil: null, expiresInDays: 3 } }))
      .toEqual({ text: 'Стандарт · до 13.11', expiring: 'через 3 дн', empty: false });
    expect(tariffCell({ ...row, app: { plan: 'basic', endsAt: '2026-11-10T20:00:00Z', paidUntil: null, expiresInDays: 0 } }).expiring)
      .toBe('сегодня');
    expect(tariffCell({ ...row, app: { plan: null, endsAt: null, paidUntil: null, expiresInDays: null } }).text).toBe('Про · бессрочно');
    expect(tariffCell({ ...row, unlimited: false, app: { plan: null, endsAt: null, paidUntil: null, expiresInDays: null } }))
      .toEqual({ text: '—', expiring: null, empty: true });
  });

  it('ПК и пункты: ∞ у безлимита, «—» если сервер ещё старый', () => {
    expect(slotsLabel(row)).toBe('3/∞ · 2/∞');
    expect(slotsLabel({ devices: { used: 1, limit: 1 }, points: { used: 0, limit: 1 } })).toBe('1/1 · 0/1');
    expect(slotsLabel({})).toBe('—');
  });

  it('последний вход — позднее из сайта и программы, «сегодня/вчера/N дней назад» по Москве', () => {
    expect(lastActivity(row)).toBe('2026-11-10T11:02:00Z');
    expect(lastActivity({ lastSignInAt: null, lastSeenAt: null })).toBeNull();
    const now = new Date('2026-11-10T12:00:00Z');
    expect(relativeSeen('2026-11-10T11:02:00Z', now)).toBe('сегодня 14:02');
    expect(relativeSeen('2026-11-09T18:15:00Z', now)).toBe('вчера 21:15');
    expect(relativeSeen('2026-11-07T10:00:00Z', now)).toBe('3 дня назад');
    expect(relativeSeen('2026-10-29T10:00:00Z', now)).toBe('12 дней назад');
    // 21:30 UTC — это уже 00:30 по Москве следующего дня
    expect(relativeSeen('2026-11-09T21:30:00Z', now)).toBe('сегодня 00:30');
    expect(relativeSeen(null, now)).toBe('—');
  });

  it('бейджи, имя, контакт и инициалы', () => {
    expect(userBadges(row).map(b => b.label)).toEqual(['Безлимит', 'Telegram']);
    expect(userBadges({ ...row, restricted: true, unlimited: false, telegramUsername: null, emailConfirmed: false }).map(b => b.label))
      .toEqual(['Ограничен', 'Не подтверждён']);
    // Старый GoTrue-бан без строки ограничения — тоже «Ограничен».
    expect(userBadges({ ...row, banned: true, restricted: undefined }).map(b => b.label)).toContain('Ограничен');
    expect(userNameAndContact(row)).toEqual({ name: 'Анна Смирнова', contact: 'shop@example.com' });
    expect(userNameAndContact({ ...row, displayName: null })).toEqual({ name: 'shop@example.com', contact: '+79990000000' });
    expect(userNameAndContact({ ...row, displayName: null, email: 'telegram-1@users.invalid', phone: null }))
      .toEqual({ name: '@anna', contact: null });
    expect(initials('Анна Смирнова')).toBe('АС');
    expect(initials('shop@example.com')).toBe('S');
    expect(initials('@anna')).toBe('A');
    expect(initials('  ')).toBe('?');
  });

  it('выручка: сумма и число заказов', () => {
    const revenue = revenueCell(row);
    expect(revenue.main.replace(/\s/g, ' ')).toBe('6 830 ₽');
    expect(revenue.sub).toBe(' · 14 зак.');
    expect(revenueCell({ revenueKopecks: 0, ordersPaid: 0 }).sub).toBe('');
  });

  it('CSV: BOM, «;», рубли с запятой, без технической почты и с защитой от формул', () => {
    const csv = usersToCsv([
      row,
      { ...row, userId: 'x', email: 'telegram-9@users.invalid', displayName: '=HYPERLINK("x")', walletKopecks: 0, unlimited: false },
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0].split(';')[0]).toBe('ID');
    expect(lines[1]).toContain(';shop@example.com;Анна Смирнова;');
    expect(lines[1]).toContain(';1250,00;');
    expect(lines[1]).toContain(';3/∞;2/∞;');
    expect(lines[1]).toContain(';Про;');
    expect(lines[2]).not.toContain('users.invalid');
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('подписи статусов выплат, заказов и маркетплейса', () => {
    expect(withdrawalStatusLabel('pending')).toBe('Ждёт решения');
    expect(withdrawalStatusLabel('paid')).toBe('Выплачено');
    expect(withdrawalStatusLabel('странный')).toBe('странный');
    // В базе статус с одной «l»: 'canceled'. Раньше сравнение с 'cancelled' не срабатывало.
    expect(customOrderStatusLabel('canceled')).toBe('Отменён');
    expect(customOrderStatusLabel('pending_payment')).toBe('Ожидает оплаты');
    expect(marketplaceLabel('both')).toBe('Wildberries и Ozon');
  });
});
