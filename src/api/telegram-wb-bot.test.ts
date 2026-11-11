import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  escapeHtml: (value: unknown) => string;
  publicUrl: (path: string) => string;
  validWebhookSecret: (req: {headers: Record<string, string>}) => boolean;
  LEGACY_BUTTONS: Set<string>;
  mainMenuKeyboard: () => {inline_keyboard: Array<Array<Record<string, any>>>};
  profileKeyboard: (options?: Record<string, boolean>) => {inline_keyboard: Array<Array<Record<string, any>>>};
  topupRows: (missing?: number) => Array<Array<Record<string, any>>>;
  isBonusAdmin: (telegramId: number) => boolean;
  parseBonusCommand: (text: string) => Record<string, any> | null;
  bonusNoticeText: (input: { kopecks: number; note?: string; balanceKopecks: number }) => string;
  topupAndBuyRow: (missing: number, then: string) => Array<Record<string, any>>;
  topupPurchaseLines: (input: { amount: number; bonus?: number; balance: number; missing: number }) => string[];
  noPointsView: (phone?: string) => { text: string; reply_markup: { inline_keyboard: Array<Array<Record<string, any>>> } };
  freeUntilText: (enabled: boolean, until: string | null) => string;
  claimErrorText: (error: unknown) => string | null;
  clientCodeEventKey: (userId: string, qrText: string) => string;
  formatPhone: (value: unknown) => string;
  maskWbPhone: (value: unknown) => string;
  reviewStars: (value: string) => number[];
  reviewText: (review: Record<string, unknown>, position: number, total: number) => string;
  reviewAuthorIds: (review: Record<string, unknown>) => number[];
  findPickupEvents: (goods: Array<Record<string, unknown>>, userIds: number | number[]) => Array<Record<string, unknown>>;
  formatReviewGoodsTime: (value: string) => string;
  wizardView: (state: string, draft: Record<string, unknown>) => { text: string; rows: Array<Array<Record<string, any>>> };
  newUserSource: (text: string) => { source: string; referralCode?: string };
  isFreshSubscriber: (row: Record<string, unknown> | null, telegramId: number, now?: number) => boolean;
};
const generation = require('../../server/_sticker-generation.js') as {
  normalizePrefix: (value: unknown) => string;
};
const telegramAccount = require('../../server/_telegram-account.js') as {
  hasValuableAccountRows: (rows: Record<string, Array<Record<string, unknown>>>) => boolean;
};

describe('Telegram sticker generator bot', () => {
  afterEach(() => {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.VERCEL_URL;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  it('предлагает ввести код при покупке и в профиле', () => {
    const profile = bot.profileKeyboard().inline_keyboard.flat().map(button => button.callback_data);
    expect(profile).toEqual(expect.arrayContaining(['topup:home', 'shop:home', 'code:enter', 'menu:home']));
    // Подключать «основной кабинет» из профиля больше нельзя — только через поддержку.
    expect(bot.profileKeyboard().inline_keyboard.flat().some(button => button.web_app)).toBe(false);
    expect(profile).not.toContain('orders:list');
    expect(bot.profileKeyboard({ orders: true }).inline_keyboard.flat().map(button => button.callback_data)).toContain('orders:list');
  });

  it('показывает короткий выбор режима без цен и лишней отмены', () => {
    const view = bot.wizardView('choose_mode', { category: 'product' });
    expect(view.rows.flat().map(button => button.text)).toEqual([
      'Пачка 50',
      'По номеру',
      '💎 Купить пакет по номеру',
      '⬅️ Назад',
    ]);
  });

  it('в шаге «По номеру» предлагает фото, а несколько номеров с фото даёт выбрать кнопкой', () => {
    expect(bot.wizardView('await_code', { category: 'product', mode: 'custom' }).text).toContain('пришлите фото');
    expect(bot.wizardView('await_code', { category: 'box', mode: 'custom' }).text).not.toContain('фото');
    const pick = bot.wizardView('await_code', { category: 'product', mode: 'custom', photoCodes: ['47671114039', '58899100266'] });
    expect(pick.rows.flat().map(button => button.callback_data)).toEqual(['gen:pick:47671114039', 'gen:pick:58899100266', 'gen:back', 'gen:cancel']);
  });

  it('для уведомления о новичке понимает, откуда он пришёл, и не пересказывает его сообщение', () => {
    expect(bot.newUserSource('/start r_abc123')).toEqual({ source: 'по приглашению (код ABC123)', referralCode: 'ABC123' });
    expect(bot.newUserSource('/start club_code').source).toBe('из «Клуба вопросов»');
    expect(bot.newUserSource('/start').source).toBe('сам, через /start');
    expect(bot.newUserSource('/start promo_vk').source).toBe('по ссылке со start=promo_vk');
    expect(bot.newUserSource('мой телефон 79991234567').source).toBe('сразу написал сообщение');
    expect(bot.newUserSource('').source).toBe('нажал кнопку или прислал фото');
  });

  it('считает новичком только свежую запись подписчика и уведомляет один раз', () => {
    const now = Date.parse('2026-11-01T20:00:00Z');
    expect(bot.isFreshSubscriber({ activated_at: '2026-10-01T10:00:00Z' }, 111, now)).toBe(false);
    expect(bot.isFreshSubscriber({ activated_at: '2026-11-01T19:59:58Z' }, 222, now)).toBe(true);
    expect(bot.isFreshSubscriber({ activated_at: '2026-11-01T19:59:59Z' }, 222, now)).toBe(false);
    expect(bot.isFreshSubscriber(null, 333, now)).toBe(false);
  });

  it('на подтверждении показывает источник оплаты без цены на кнопке', () => {
    const packageView = bot.wizardView('confirm', {
      category: 'product', mode: 'custom', code: '12345678901', accessCode: '123456', packageRemaining: 9,
    });
    expect(packageView.text).toContain('останется: <b>9</b>');
    expect(packageView.rows[0][0].text).toBe('✅ Создать');
  });

  it('считает каждый новый QR того же SID отдельной платной операцией', () => {
    const first = bot.clientCodeEventKey('u1', '123456789_01234_111111_1');
    const second = bot.clientCodeEventKey('u1', '123456789_01234_222222_1');
    expect(first).not.toBe(second);
  });

  it('переводит ошибки привязки кода на понятный язык', () => {
    expect(bot.claimErrorText({ details: { message: 'Asset not found' } })).toMatch(/не найден/);
    expect(bot.claimErrorText({ details: { message: 'Asset belongs to another user' } })).toMatch(/другому аккаунту/);
    // Без сайта, Mini App и «кабинета»: дальше — только поддержка.
    const notConfirmed = bot.claimErrorText({ details: { message: 'User is not confirmed' } });
    expect(notConfirmed).toMatch(/поддержку/);
    expect(notConfirmed).not.toMatch(/Mini App|сайт|[Кк]абинет/);
    expect(bot.claimErrorText(new Error('Supabase request failed (500)'))).toBeNull();
  });

  it('проверяет секрет Telegram webhook', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-test-secret';
    expect(bot.validWebhookSecret({ headers: { 'x-telegram-bot-api-secret-token': 'telegram-test-secret' } })).toBe(true);
    expect(bot.validWebhookSecret({ headers: { 'x-telegram-bot-api-secret-token': 'telegram-wrong-value' } })).toBe(false);
  });

  it('строит абсолютные URL, а главное меню не уводит на сайт', () => {
    process.env.PUBLIC_APP_URL = 'https://example.test/';
    expect(bot.publicUrl('/login')).toBe('https://example.test/login');
    const menu = bot.mainMenuKeyboard().inline_keyboard.flat();
    // Бот работает сам по себе: ни Mini App сайта, ни кнопки «Войти» в меню нет.
    expect(menu.some(button => button.web_app)).toBe(false);
    expect(menu.some(button => /Сайт/.test(String(button.text)))).toBe(false);
    expect(menu.some(button => button.callback_data === 'menu:login')).toBe(false);
    expect(menu.some(button => button.callback_data === 'menu:profile')).toBe(true);
    expect(menu.some(button => button.callback_data === 'menu:ref')).toBe(true);
    // «Помощь» объединяет справку и поддержку; канал и VPN — на её экране, не в меню.
    expect(menu.some(button => button.callback_data === 'menu:help')).toBe(true);
    expect(menu.some(button => button.url)).toBe(false);
    // Постоянной клавиатуры больше нет; подписи старых reply-кнопок известны — по ним бот снимает её у человека.
    for (const label of ['☰ Меню', '🏷 Стикеры и QR', '🆘 Помощь', '🌐 Открыть сайт', '📦 QR для коробок']) expect(bot.LEGACY_BUTTONS.has(label)).toBe(true);
    expect(bot.LEGACY_BUTTONS.has('/menu')).toBe(false);
  });

  it('валидирует префикс коробки и экранирует HTML', () => {
    expect(generation.normalizePrefix(' trbx-1 ')).toBe('TRBX-1');
    expect(generation.normalizePrefix('плохой')).toBe('');
    expect(bot.escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });

  it('формирует фильтры, страницы отзывов и кнопку раздела', () => {
    expect(bot.reviewStars('all')).toEqual([1, 2, 3, 4, 5]);
    expect(bot.reviewStars('3')).toEqual([3]);
    expect(bot.reviewStars('9')).toEqual([]);
    expect(bot.formatPhone(79991234567)).toBe('+7 999 123-45-67');
    expect(bot.maskWbPhone(79600003574)).toBe('+7 960 ***-35-74');
    expect(bot.maskWbPhone(79201112233)).toBe('+7 920 111-22-33');
    expect(bot.reviewText({ stars: 1, comment: '<плохо>', rate_dt: '2026-10-06T10:00:00+03:00' }, 1, 6)).toContain('&lt;плохо&gt;');
    expect(bot.mainMenuKeyboard().inline_keyboard.flat().some(button => button.callback_data === 'menu:reviews')).toBe(true);
  });

  it('кнопки пополнения создают оплату в боте (без Mini App) и не предлагают суммы меньше нехватки', () => {
    const buttons = bot.topupRows(0).flat();
    expect(buttons).toHaveLength(4);
    expect(buttons[0].callback_data).toBe('tp:100');
    expect(buttons.every(button => !button.web_app)).toBe(true);
    // Не хватает 400 ₽: 100 и 300 не помогут, 500 (+25 бонус) и 1000 — да.
    expect(bot.topupRows(400).flat().map(button => button.callback_data)).toEqual(['tp:500', 'tp:1000']);
  });

  it('объясняет, почему пополнение больше недостающего', () => {
    const row = bot.topupAndBuyRow(5, 'rv:5:0:3:07d5a547');
    expect(row[0].text).toContain('25 ₽');
    expect(row[0].callback_data).toBe('tp:25~500:rv:5:0:3:07d5a547');
    const lines = bot.topupPurchaseLines({ amount: 25, balance: 20, missing: 5 }).join(' ').replace(/\s/g, ' ');
    expect(lines).toContain('Покупка стоит 25 ₽, на балансе 20 ₽, не хватает 5 ₽.');
    expect(lines).toContain('Минимальное пополнение — 25 ₽, поэтому после покупки на балансе останется 20 ₽.');
    // Не хватает ровно цены — объяснять нечего.
    expect(bot.topupPurchaseLines({ amount: 25, balance: 0, missing: 25 }).join(' ').replace(/\s/g, ' ')).toBe('Покупка стоит 25 ₽, на балансе 0 ₽.');
    expect(bot.topupPurchaseLines({ amount: 25, balance: NaN, missing: NaN })).toEqual([]);
  });

  it('длинное действие не ломает кнопку пополнения лимитом Telegram в 64 байта', () => {
    const then = 'cqa:01234567-89ab-cdef-0123-456789abcdef' + ':'.repeat(12);
    const data = bot.topupAndBuyRow(1234.5, then)[0].callback_data;
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(data).toBe(`tp:1235:${then}`);
  });

  it('бонус начисляет только админ по числовому ID', () => {
    expect(bot.isBonusAdmin(439335621)).toBe(true);
    expect(bot.isBonusAdmin(1751409240)).toBe(false);
    expect(bot.isBonusAdmin(123)).toBe(false);
  });

  it('разбирает команду бонуса', () => {
    expect(bot.parseBonusCommand('/menu')).toBeNull();
    expect(bot.parseBonusCommand('/bonusx @ivanov 100')).toBeNull();
    expect(bot.parseBonusCommand('/bonus')).toEqual({ ok: false, error: '' });
    expect(bot.parseBonusCommand('/bonus @Ivan_ov 100 За тест')).toEqual({ ok: true, username: 'Ivan_ov', kopecks: 10000, note: 'За тест' });
    expect(bot.parseBonusCommand('/bonus https://t.me/ivanov 99,50')).toEqual({ ok: true, username: 'ivanov', kopecks: 9950, note: '' });
    expect(bot.parseBonusCommand('/bonus 439335621 1')).toEqual({ ok: true, telegramId: 439335621, kopecks: 100, note: '' });
    for (const bad of ['/bonus @ivanov 0', '/bonus @ivanov 0.5', '/bonus @ivanov 10001', '/bonus @ivanov -5', '/bonus @ivanov сто', '/bonus @a! 100']) {
      expect(bot.parseBonusCommand(bad)?.ok, bad).toBe(false);
    }
  });

  it('уведомление о бонусе: сумма, баланс и экранированный комментарий', () => {
    const text = bot.bonusNoticeText({ kopecks: 10000, note: '<b>тест</b>', balanceKopecks: 35050 }).replace(/\s/g, ' ');
    expect(text).toContain('Вам начислен бонус');
    expect(text).toContain('+100 ₽ зачислено на ваш счёт');
    expect(text).toContain('350,50 ₽');
    expect(text).toContain('&lt;b&gt;тест');
  });

  it('нет ПВЗ — понятный экран с повтором и входом под другим номером', () => {
    const view = bot.noPointsView('79601234567');
    expect(view.text).toContain('Нет доступных ПВЗ');
    expect(view.text).not.toContain('ошибка');
    const actions = view.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
    expect(actions).toEqual(expect.arrayContaining(['rv:points', 'rv:relogin']));
  });

  it('пишет конец бесплатного периода как «до следующего дня»', () => {
    expect(bot.freeUntilText(true, '2026-10-31T20:59:59Z')).toBe('бесплатно до 1 ноября');
    expect(bot.freeUntilText(true, null)).toBe('сейчас бесплатно');
    expect(bot.freeUntilText(false, '2026-10-31T20:59:59Z')).toBe('');
  });

  it('находит выдачи автора отзыва и сортирует новые первыми', () => {
    const result = bot.findPickupEvents([
      { buyer_id: 7, status: 'GOODS_READY', status_updated: '2026-10-06T10:00:00+03:00' },
      { buyer_id: 7, status: 'GOODS_RECIEVED', status_updated: '2026-10-05T10:00:00+03:00' },
      { buyer_sid: '7', status: 'GOODS_RECIEVED', status_updated: '2026-10-06T10:00:00+03:00' },
      { buyer: { user_sid: '70' }, status: 'GOODS_RECEIVED', status_updated: '2026-10-04T10:00:00+03:00' },
      { buyer_id: 8, status: 'GOODS_RECIEVED', status_updated: '2026-10-07T10:00:00+03:00' },
    ], [7, 70]);
    expect(result).toHaveLength(3);
    expect(result[0].status_updated).toBe('2026-10-06T10:00:00+03:00');
  });

  it('не принимает идентификатор оцениваемого сотрудника за автора отзыва', () => {
    expect(bot.reviewAuthorIds({ user_id: 7, user_sid: '7', employee_id: 90 })).toEqual([7]);
    expect(bot.reviewAuthorIds({ user_id: 0, user_sid: '0', employee_id: 90, employee_user_sid: '90' })).toEqual([]);
  });

  it('декодирует sid клиента из id обезличенного отзыва (первые 8 hex)', () => {
    expect(bot.reviewAuthorIds({ id: '0413cf90-1501-0000-bdda-b4b4ba877516', user_id: 0, user_sid: '0' })).toEqual([68407184]);
    expect(bot.reviewAuthorIds({ id: '126daddf-1501-0000-104c-ced0905057cd', user_id: 0, user_sid: '0' })).toEqual([309177823]);
    expect(bot.reviewAuthorIds({ id: 'not-a-uuid', user_id: 0, user_sid: '0' })).toEqual([]);
  });

  it('время из goods отзыва — московское с ложной Z, пояс не переводим', () => {
    expect(bot.formatReviewGoodsTime('2026-11-01T13:07:56Z')).toMatch(/13:07/);
    expect(bot.formatReviewGoodsTime('2026-11-01T13:07:56+03:00')).toMatch(/13:07/);
    expect(bot.formatReviewGoodsTime('')).toBe('—');
  });

  it('учитывает и выдачи, и отказы клиента', () => {
    const result = bot.findPickupEvents([
      { buyer: { user_sid: '5' }, status: 'GOODS_RECIEVED', status_updated: '2026-10-05T10:00:00+03:00' },
      { buyer: { user_sid: '5' }, status: 'GOODS_RETURNED', status_updated: '2026-10-06T10:00:00+03:00' },
      { buyer: { user_sid: '5' }, status: 'GOODS_READY', status_updated: '2026-10-07T10:00:00+03:00' },
    ], [5]);
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('GOODS_RETURNED');
  });

  it('отличает пустой Telegram-кабинет от кабинета с ценными данными', () => {
    const empty = { orders: [], stickers: [], licenses: [], cellLicenses: [], history: [], requests: [], ledger: [], withdrawals: [], invited: [], referrals: [{ available_kopecks: 0 }] };
    expect(telegramAccount.hasValuableAccountRows(empty)).toBe(false);
    expect(telegramAccount.hasValuableAccountRows({ ...empty, orders: [{ id: 'paid' }] })).toBe(true);
    expect(telegramAccount.hasValuableAccountRows({ ...empty, referrals: [{ earned_kopecks: 100 }] })).toBe(true);
  });
});
