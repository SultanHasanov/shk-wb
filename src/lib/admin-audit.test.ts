import { describe, expect, it } from 'vitest';
import type { AdminAuditEntry } from '../api/admin';
import {
  ACTION_META,
  AUDIT_CATEGORIES,
  actionMeta,
  adminLabel,
  auditToCsv,
  describeAction,
  diffValues,
  formatAuditValue,
  groupByDay,
  userAgentLabel,
} from './admin-audit';

/** Таблица 5.6 контракта: имя → категория, опасное. Сервер (_admin-audit.js) обязан совпасть. */
const TABLE: Array<[string, string, boolean]> = [
  ['grantSticker', 'keys', false],
  ['topupSticker', 'keys', false],
  ['patchCode', 'keys', false],
  ['createIndividualStickerOrder', 'money', false],
  ['grantProgramKey', 'keys', false],
  ['patchProgramKey', 'keys', false],
  ['grantCellLicense', 'keys', false],
  ['patchCellLicense', 'keys', false],
  ['grantAppSubscription', 'keys', false],
  ['revokeAppSubscription', 'keys', true],
  ['grantAppAddon', 'keys', false],
  ['revokeAppAddon', 'keys', false],
  ['revokeAppPoint', 'keys', false],
  ['revokeAppDevice', 'keys', false],
  ['setDeviceRole', 'keys', false],
  ['attach', 'keys', false],
  ['profile', 'settings', false],
  ['appCodeViaBot', 'settings', false],
  ['setOverrides', 'limits', false],
  ['clearOverrides', 'limits', false],
  ['walletAdjust', 'money', true],
  ['restrict', 'restrict', true],
  ['updateRestriction', 'restrict', true],
  ['liftRestriction', 'restrict', false],
  ['block', 'restrict', true],
  ['unblock', 'restrict', false],
  ['message', 'messages', false],
  ['notify', 'messages', false],
  ['retryDelivery', 'messages', false],
  ['sendNews', 'messages', true],
  ['sendTelegramBroadcast', 'messages', true],
  ['logoutAll', 'settings', true],
  ['unlinkTelegram', 'settings', true],
  ['unlinkOAuth', 'settings', true],
  ['deleteAccount', 'deletions', true],
  ['deleteResource', 'deletions', true],
  ['createResource', 'settings', false],
  ['updateResource', 'settings', false],
  ['setAppFreeMode', 'settings', true],
  ['setAppCrackFallback', 'settings', false],
  ['setAppCodeViaBot', 'settings', true],
  ['setPaymentsEnabled', 'settings', true],
  ['upsertPriceTier', 'money', false],
  ['deletePriceTier', 'money', false],
  ['syncPaymentOrder', 'money', false],
  ['setStickerPoolRange', 'settings', true],
  ['setBoxPoolRange', 'settings', true],
  ['processWithdrawal', 'money', true],
  ['setKztRate', 'settings', false],
  ['createPartner', 'keys', false],
  ['grantPartnerPool', 'keys', false],
  ['updatePartner', 'keys', false],
  ['partnerPayment', 'money', false],
  ['togglePartnerItem', 'keys', false],
];

/** Неразрывные и узкие пробелы Intl → обычные, чтобы сравнивать строки глазами. */
const plain = (text: string) => text.replace(/[  ]/g, ' ');

function entry(patch: Partial<AdminAuditEntry>): AdminAuditEntry {
  return {
    id: 1,
    createdAt: '2026-11-10T11:12:08.000Z',
    action: 'setOverrides',
    category: 'limits',
    danger: false,
    targetUserId: '11111111-1111-4111-8111-111111111111',
    target: {
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'anna.s@example.ru',
      displayName: 'Анна Смирнова',
      telegramUsername: null,
    },
    reason: 'второй пункт, на месяц',
    payload: {},
    before: null,
    after: null,
    result: 'ok',
    adminFingerprint: 'abcdefabcdefabcdefa1f3',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    ...patch,
  };
}

describe('таблица действий журнала', () => {
  it('у каждого имени из таблицы 5.6 есть подпись, категория и признак опасности', () => {
    for (const [action, category, danger] of TABLE) {
      const meta = actionMeta(action);
      expect(meta.label, action).not.toBe(action);
      expect(meta.label.length, action).toBeGreaterThan(2);
      expect(meta.category, action).toBe(category);
      expect(meta.danger, action).toBe(danger);
      expect(AUDIT_CATEGORIES[meta.category].label).toBeTruthy();
    }
  });

  it('в ACTION_META нет лишних имён сверх таблицы', () => {
    expect(Object.keys(ACTION_META).sort()).toEqual(TABLE.map(([name]) => name).sort());
  });

  it('неизвестное действие — «прочее» с сырым именем', () => {
    expect(actionMeta('somethingNew')).toEqual({ label: 'somethingNew', category: 'other', danger: false });
    expect(actionMeta('toString').category).toBe('other');
  });
});

describe('diffValues', () => {
  it('отдаёт только изменившиеся поля и пропускает служебные', () => {
    const rows = diffValues(
      { devices_bonus: 0, codes_monthly: 500, note: 'x', updated_at: '2026-11-01T00:00:00Z' },
      { devices_bonus: 2, codes_monthly: 500, note: 'x', updated_at: '2026-11-10T00:00:00Z', slots_until: '2026-12-10T20:59:59Z' },
    );
    expect(rows.map(row => row.field)).toEqual(['devices_bonus', 'slots_until']);
    expect(rows[0]).toMatchObject({ label: 'ПК бонус', before: '0', after: '2' });
    expect(rows[1]).toMatchObject({ before: '—', after: '10.12.2026 23:59' });
  });

  it('null с обеих сторон — нет изменений', () => {
    expect(diffValues(null, null)).toEqual([]);
    expect(diffValues({ a: null }, { a: undefined })).toEqual([]);
    expect(diffValues({ scopes: ['app'] }, { scopes: ['app'] })).toEqual([]);
  });
});

describe('formatAuditValue', () => {
  it('рубли из копеек', () => {
    expect(plain(formatAuditValue('balanceKopecks', 124000))).toBe('1 240 ₽');
    expect(plain(formatAuditValue('amount_kopecks', 50050))).toBe('500,5 ₽');
    expect(plain(formatAuditValue('balance', -5000))).toBe('−50 ₽');
  });

  it('даты по Москве', () => {
    expect(formatAuditValue('until', '2026-11-17T15:00:00.000Z')).toBe('17.11.2026 18:00');
    expect(formatAuditValue('date', '2026-11-17')).toBe('17.11.2026');
  });

  it('булевы, пустые, списки областей и каналов', () => {
    expect(formatAuditValue('unlimited', true)).toBe('да');
    expect(formatAuditValue('unlimited', false)).toBe('нет');
    expect(formatAuditValue('note', null)).toBe('—');
    expect(formatAuditValue('note', undefined)).toBe('—');
    expect(formatAuditValue('scopes', ['purchases', 'withdrawals'])).toBe('покупки, выводы');
    expect(formatAuditValue('scopes', ['all'])).toBe('полностью');
    expect(formatAuditValue('channels', ['email', 'telegram', 'pc'])).toBe('почта, Telegram, ПК');
    expect(formatAuditValue('codes_mode', 'add')).toBe('прибавка к тарифу');
    expect(plain(formatAuditValue('codes_monthly', 1200))).toBe('1 200');
  });
});

describe('describeAction', () => {
  it('кошелёк: сумма со знаком', () => {
    const credit = describeAction(entry({ action: 'walletAdjust', category: 'money', danger: true, payload: { direction: 'credit', amountKopecks: 50000 } }));
    expect(plain(credit.title)).toBe('Кошелёк: +500 ₽');
    expect(credit.danger).toBe(true);
    const debit = describeAction(entry({ action: 'walletAdjust', category: 'money', payload: { direction: 'debit', amountKopecks: 12000 } }));
    expect(plain(debit.title)).toBe('Кошелёк: −120 ₽');
    // Без payload — по разнице баланса «было → стало»
    const byBalance = describeAction(entry({ action: 'walletAdjust', category: 'money', before: { balanceKopecks: 12000 }, after: { balanceKopecks: 62000 } }));
    expect(plain(byBalance.title)).toBe('Кошелёк: +500 ₽');
    expect(byBalance.diff).toHaveLength(1);
  });

  it('ограничение и сообщение: подробности из payload', () => {
    expect(describeAction(entry({ action: 'restrict', category: 'restrict', payload: { scopes: ['purchases', 'withdrawals'] } })).title).toBe(
      'Ограничение: покупки, выводы',
    );
    expect(describeAction(entry({ action: 'message', category: 'messages', payload: { channels: ['email', 'telegram', 'pc'] } })).title).toBe(
      'Сообщение: почта, Telegram, ПК',
    );
    expect(describeAction(entry({ action: 'updateResource', category: 'settings', payload: { resource: 'cellPromo', id: 4 } })).title).toBe(
      'Изменена запись: промокод ПВЗ Принт',
    );
    const plainEntry = describeAction(entry({ action: 'setOverrides' }));
    expect(plainEntry).toMatchObject({ title: 'Выданы ручные лимиты', categoryLabel: 'Лимиты', danger: false });
  });
});

describe('кто сделал', () => {
  it('подпись админа: IP и браузер', () => {
    expect(adminLabel(entry({}))).toBe('Админ · IP ··a1f3 · Chrome, Windows');
    expect(adminLabel({ adminFingerprint: 'system', userAgent: null })).toBe('Система');
    expect(adminLabel({ adminFingerprint: 'migration', userAgent: null })).toBe('Перенос данных');
    expect(adminLabel({ adminFingerprint: null, userAgent: null })).toBe('Админ');
  });

  it('браузеры и системы', () => {
    expect(userAgentLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15')).toBe('Safari, macOS');
    expect(userAgentLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36')).toBe('Chrome, Android');
    expect(userAgentLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari, iOS');
    expect(userAgentLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/131 YaBrowser/24.10 Safari/537.36')).toBe('Яндекс Браузер, Windows');
    expect(userAgentLabel(null)).toBe('');
  });
});

describe('groupByDay', () => {
  it('сегодня, вчера и дальше — по московским суткам', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    const groups = groupByDay(
      [
        { createdAt: '2026-11-10T11:00:00Z' },
        // 22:30 UTC 9 ноября — это уже 10 ноября по Москве
        { createdAt: '2026-11-09T22:30:00Z' },
        { createdAt: '2026-11-09T10:00:00Z' },
        { createdAt: '2026-11-08T10:00:00Z' },
        { createdAt: '2025-12-31T10:00:00Z' },
      ],
      now,
    );
    expect(groups.map(group => group.label)).toEqual([
      'Сегодня, 10 ноября',
      'Вчера, 9 ноября',
      '8 ноября',
      '31 декабря 2025',
    ]);
    expect(groups[0].items).toHaveLength(2);
  });
});

describe('auditToCsv', () => {
  it('BOM, «;», кавычки и защита от формул', () => {
    const csv = auditToCsv([
      entry({
        action: 'setOverrides',
        reason: 'клиент; «важный»',
        before: { devices_bonus: 0 },
        after: { devices_bonus: 2 },
      }),
      entry({
        id: 2,
        action: 'profile',
        category: 'settings',
        target: { userId: '22222222-2222-4222-8222-222222222222', email: null, displayName: '=HYPERLINK("x")', telegramUsername: null },
        reason: null,
      }),
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('Дата;Действие;Пользователь;Причина;Было;Стало;Админ');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('10.11.2026 14:12;Выданы ручные лимиты;');
    expect(lines[1]).toContain('"клиент; «важный»"');
    expect(lines[1]).toContain(';ПК бонус: 0;ПК бонус: 2;');
    expect(lines[2]).toContain(`'=HYPERLINK(""x"")`);
  });
});
