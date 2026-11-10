import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  channelStatusLabel,
  defaultPublicMessage,
  draftFromDetail,
  draftToRequest,
  formatUntilLong,
  formatUntilShort,
  hasOverrideSections,
  int,
  isValidMessageLink,
  liftPreview,
  limitUntil,
  limitsDraftError,
  limitsPreview,
  parseRubles,
  pcMessageText,
  pluralChannels,
  restrictEffects,
  restrictUntil,
  scopesLabel,
  walletPreview,
} from './admin-controls';
import { makeDetail, makeRestriction } from '../pages/admin/user/fixtures';

const require = createRequire(import.meta.url);

describe('сроки ограничения: 18:00 по Москве', () => {
  // 10.11.2026 13:40 МСК
  const now = new Date('2026-11-10T10:40:00Z');

  it('пресет N дней — сегодня по Москве + N, в 18:00 МСК', () => {
    expect(restrictUntil('7', '', now)).toBe('2026-11-17T18:00:00+03:00');
    expect(Date.parse(restrictUntil('7', '', now)!)).toBe(Date.parse('2026-11-17T15:00:00Z'));
    expect(restrictUntil('1', '', now)).toBe('2026-11-11T18:00:00+03:00');
    expect(restrictUntil('30', '', now)).toBe('2026-12-10T18:00:00+03:00');
  });

  it('«сегодня» считается по Москве, а не по UTC', () => {
    // 10.11 22:30 UTC — в Москве уже 11.11 01:30
    expect(restrictUntil('1', '', new Date('2026-11-10T22:30:00Z'))).toBe('2026-11-12T18:00:00+03:00');
  });

  it('своя дата, бессрочно и ошибки', () => {
    expect(restrictUntil('custom', '2026-11-24', now)).toBe('2026-11-24T18:00:00+03:00');
    expect(restrictUntil('forever', '', now)).toBeNull();
    expect(restrictUntil('custom', '', now)).toBeUndefined();
    expect(restrictUntil('custom', '2026-02-31', now)).toBeUndefined();
    expect(restrictUntil('custom', '2026-11-01', now)).toBeUndefined();
    expect(restrictUntil('abc', '', now)).toBeUndefined();
    // сегодня 18:00, а сейчас уже 19:00 по Москве — в прошлом
    expect(restrictUntil('custom', '2026-11-10', new Date('2026-11-10T16:00:00Z'))).toBeUndefined();
  });

  it('подписи срока и текст по умолчанию — как на сервере', () => {
    expect(formatUntilLong('2026-11-17T15:00:00.000Z')).toBe('17 ноября в 18:00');
    expect(formatUntilShort('2026-11-17T15:00:00.000Z')).toBe('17.11');
    expect(defaultPublicMessage('2026-11-17T15:00:00.000Z')).toBe('Доступ ограничен администратором. До 17.11');
    expect(defaultPublicMessage(null)).toBe('Доступ ограничен администратором.');
  });

  it('срок ручного лимита — до конца дня по Москве', () => {
    expect(limitUntil('date', '2026-12-10')).toBe('2026-12-10T23:59:59+03:00');
    expect(limitUntil('forever', '')).toBeNull();
    expect(limitUntil('date', '')).toBeUndefined();
  });
});

describe('области ограничения', () => {
  it('подписи', () => {
    expect(scopesLabel(['all'])).toBe('полностью');
    expect(scopesLabel(['withdrawals', 'purchases'])).toBe('покупки и выводы');
    expect(scopesLabel(['bot', 'app', 'purchases'])).toBe('Помощник ПВЗ, Telegram-бот и покупки');
  });

  it('что произойдёт: последствия, текст пользователю и срок', () => {
    const detail = makeDetail();
    const until = '2026-11-17T18:00:00+03:00';
    const partial = restrictEffects(detail, ['purchases'], until, '');
    expect(partial.map(e => e.text)).toEqual([
      `Нельзя оплатить и списать с кошелька, баланс ${walletRub(124000)} сохранится`,
      'При оплате и выводе покажем: «Доступ ограничен администратором. До 17.11»',
      'Автоматически снимется 17 ноября в 18:00',
    ]);
    expect(partial[2].strong).toBe(true);

    const app = restrictEffects(detail, ['app'], null, 'Свой текст');
    expect(app[0].text).toBe('Отключатся 1 ключ подборов и права на 2 ПК, ключ устройства сохранится');
    expect(app[1].text).toBe('Программа покажет: «Свой текст»');
    expect(app[2]).toEqual({ text: 'Само не снимется — только вручную', strong: true });

    const full = restrictEffects(detail, ['all'], undefined, '');
    expect(full[0].text).toMatch(/открытые сессии/);
    expect(full[1].text).toBe('Отключатся 1 код генератора, 1 ключ подборов и права на 2 ПК, ключ устройства сохранится');
    expect(full.at(-1)).toEqual({ text: 'Выберите дату, когда снять', strong: true });
    expect(restrictEffects(detail, [], null, '')).toEqual([]);
  });
});

function walletRub(kopecks: number) {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(kopecks / 100)} ₽`;
}

describe('снятие ограничения: что вернётся, что останется выключенным', () => {
  it('возвращает только выключенное ограничением, ручное выключение остаётся', () => {
    const base = makeDetail();
    // код 7 и ключ 3 выключило ограничение; код 8 выключен вручную ещё до него
    const detail = makeDetail({
      codes: base.codes.map(code => ({ ...code, active: false })),
      programKeys: base.programKeys.map(key => ({ ...key, active: false })),
    });
    const preview = liftPreview(
      detail,
      makeRestriction({ scopes: ['all'], full: true, disabledItems: { stickerCodes: [7], programKeys: [3], cellLicenses: [], legacy: false } }),
    );
    expect(preview.legacy).toBe(false);
    expect(preview.willReturn).toContain('1 код генератора · 1 ключ подборов · подборы и права на 2 ПК');
    expect(preview.staysOff).toEqual([
      { label: 'Код генератора STK-21BC-M04D', note: 'выключен вручную — снятие ограничения его не включит' },
    ]);
  });

  it('ограничение Помощника ПВЗ коды генератора не трогает: ни «вернётся», ни «останется выключенным»', () => {
    const base = makeDetail();
    const detail = makeDetail({
      codes: base.codes.map(code => ({ ...code, active: false })),
      programKeys: base.programKeys.map(key => ({ ...key, active: false })),
    });
    const preview = liftPreview(detail, makeRestriction());
    expect(preview.willReturn).toEqual(['1 ключ подборов · подборы и права на 2 ПК', `Покупки · кошелёк ${walletRub(124000)}`]);
    expect(preview.staysOff).toEqual([]);
  });

  it('код, который включили вручную во время ограничения, не считается «вернётся»', () => {
    const preview = liftPreview(makeDetail(), makeRestriction({ scopes: ['app'] }));
    // код 7 активен — снятие его не трогает; ключ 3 активен — тоже
    expect(preview.willReturn).toEqual(['подборы и права на 2 ПК']);
  });

  it('старая блокировка включает всё и ничего не оставляет выключенным', () => {
    const detail = makeDetail({ codes: makeDetail().codes.map(code => ({ ...code, active: false })) });
    const preview = liftPreview(
      detail,
      makeRestriction({ scopes: ['all'], full: true, disabledItems: { stickerCodes: [], programKeys: [], cellLicenses: [], legacy: true } }),
    );
    expect(preview.legacy).toBe(true);
    expect(preview.staysOff).toEqual([]);
    expect(preview.willReturn[0]).toBe('Вход на сайт и в программы');
    expect(preview.willReturn[1]).toMatch(/старая блокировка/);
  });
});

describe('ручные лимиты', () => {
  it('черновик из карточки: правки, срок мест по Москве, старая надбавка ПК', () => {
    const draft = draftFromDetail(makeDetail());
    expect(draft).toMatchObject({
      codesMode: 'add',
      codes: 200,
      codesTerm: 'forever',
      devices: 2,
      slotsTerm: 'date',
      slotsDate: '2026-12-10',
      unlimited: false,
      note: 'второй пункт, на месяц',
    });
    expect(draftFromDetail(makeDetail({ overrides: null, legacyDeviceBonus: 3 })).devices).toBe(3);
    expect(draftFromDetail(makeDetail({ overrides: null })).codesMode).toBe('tariff');
  });

  it('было → станет: тариф + правки, безлимит', () => {
    const detail = makeDetail();
    const draft = draftFromDetail(detail);
    const same = limitsPreview(detail, draft);
    expect(same.map(r => [r.label, r.from, r.to, r.changed])).toEqual([
      ['Подборы в месяц', '700', '700', false],
      ['ПК', '5', '5', false],
      ['Пункты', '2', '2', false],
      ['Зеркало', '1', '1', false],
      ['Безлимит', 'нет', 'нет', false],
    ]);

    const exact = limitsPreview(detail, { ...draft, codesMode: 'exact', codes: 1000, points: 1 });
    expect(exact[0]).toEqual({ label: 'Подборы в месяц', from: '700', to: int(1000), changed: true });
    expect(exact[2]).toMatchObject({ from: '2', to: '3', changed: true });

    const tariff = limitsPreview(detail, { ...draft, codesMode: 'tariff' });
    expect(tariff[0].to).toBe('500');

    const unlimited = limitsPreview(detail, { ...draft, unlimited: true });
    expect(unlimited.slice(0, 4).every(row => row.to === 'без лимита' && row.changed)).toBe(true);
    expect(unlimited[4]).toMatchObject({ from: 'нет', to: 'да', changed: true });
  });

  it("тело запроса: 'exact' → 'set', только изменённые секции", () => {
    const detail = makeDetail();
    const initial = draftFromDetail(detail);
    const all = draftToRequest({ ...initial, codesMode: 'exact', codes: 900 }, detail.userId, 'причина', 'key-12345678');
    expect(all).toEqual({
      userId: detail.userId,
      reason: 'причина',
      idempotencyKey: 'key-12345678',
      codes: { mode: 'set', monthly: 900, until: null },
      slots: { devices: 2, points: 0, mirror: 0, until: '2026-12-10T23:59:59+03:00' },
      unlimited: { enabled: false, until: null },
      note: 'второй пункт, на месяц',
    });

    const nothing = draftToRequest(initial, detail.userId, 'п', 'key-12345678', initial);
    expect(hasOverrideSections(nothing)).toBe(false);

    const onlySlots = draftToRequest({ ...initial, devices: 4 }, detail.userId, 'п', 'key-12345678', initial);
    expect(Object.keys(onlySlots).sort()).toEqual(['idempotencyKey', 'reason', 'slots', 'userId']);

    const tariff = draftToRequest({ ...initial, codesMode: 'tariff' }, detail.userId, 'п', 'k-12345678', initial);
    expect(tariff.codes).toEqual({ mode: 'tariff', monthly: 0, until: null });

    const unlim = draftToRequest({ ...initial, unlimited: true, unlimitedTerm: 'date', unlimitedDate: '2027-01-31' }, detail.userId, 'п', 'k-12345678', initial);
    expect(unlim.unlimited).toEqual({ enabled: true, until: '2027-01-31T23:59:59+03:00' });
  });

  it('ошибки черновика', () => {
    const draft = draftFromDetail(makeDetail());
    expect(limitsDraftError(draft)).toBeNull();
    expect(limitsDraftError({ ...draft, devices: 21 })).toMatch(/Места/);
    expect(limitsDraftError({ ...draft, slotsDate: '' })).toMatch(/дату/);
    expect(limitsDraftError({ ...draft, unlimited: true, unlimitedTerm: 'date', unlimitedDate: '' })).toMatch(/безлимит/);
  });
});

describe('кошелёк', () => {
  it('предпросмотр и уход в минус', () => {
    expect(walletPreview(32000, 'credit', 50000)).toEqual({ toKopecks: 82000, overdraft: false });
    expect(walletPreview(32000, 'debit', 50000)).toEqual({ toKopecks: -18000, overdraft: true });
    expect(walletPreview(32000, 'debit', 32000)).toEqual({ toKopecks: 0, overdraft: false });
  });

  it('рубли в копейки', () => {
    expect(parseRubles('500')).toBe(50000);
    expect(parseRubles('199,5')).toBe(19950);
    expect(parseRubles('1 240.75')).toBe(124075);
    expect(parseRubles('1,234')).toBeNull();
    expect(parseRubles('-5')).toBeNull();
    expect(parseRubles('')).toBeNull();
  });
});

describe('сообщения', () => {
  it('pcMessageText совпадает с серверной', () => {
    const server = require('../../server/_admin-messages.js') as { pcMessageText: (s: string, b: string) => string };
    const inputs: Array<[string, string]> = [
      ['Тема', 'Текст'],
      ['  Тема с пробелами', 'строка 1\r\nстрока 2  \r\n'],
      ['Обновите Помощник', 'а'.repeat(477)], // ровно 500 символов
      ['Обновите Помощник', 'а'.repeat(478)], // 501 → 499 + «…»
      ['Длинное', 'б'.repeat(4000)],
      ['', ''],
    ];
    for (const [subject, body] of inputs) expect(pcMessageText(subject, body)).toBe(server.pcMessageText(subject, body));
    expect(pcMessageText('Обновите Помощник', 'а'.repeat(477))).toHaveLength(500);
    const cut = pcMessageText('Обновите Помощник', 'а'.repeat(478));
    expect(cut).toHaveLength(500);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('ссылка: пусто, страница сайта или https', () => {
    expect(isValidMessageLink('')).toBe(true);
    expect(isValidMessageLink('/cabinet/subscription')).toBe(true);
    expect(isValidMessageLink('https://shk-wb.ru/dl/')).toBe(true);
    expect(isValidMessageLink('http://example.com')).toBe(false);
    expect(isValidMessageLink('cabinet')).toBe(false);
    expect(isValidMessageLink('/с пробелом')).toBe(false);
    expect(isValidMessageLink(`/${'a'.repeat(500)}`)).toBe(false);
  });

  it('подписи статусов и склонение каналов', () => {
    expect(channelStatusLabel('telegram', 'blocked')).toBe('бот заблокирован');
    expect(channelStatusLabel('email', 'not_configured')).toBe('почта не настроена');
    expect(channelStatusLabel('email', 'sent')).toBe('отправлено');
    expect(channelStatusLabel('cabinet', 'read')).toBe('прочитано');
    expect(channelStatusLabel('email', 'not_confirmed')).toBe('почта не подтверждена');
    expect([1, 2, 4, 5, 11, 21, 22].map(pluralChannels)).toEqual(['канал', 'канала', 'канала', 'каналов', 'каналов', 'канал', 'канала']);
  });
});
