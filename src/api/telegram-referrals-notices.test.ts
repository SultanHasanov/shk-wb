import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Приглашения и исходящие сообщения (этап G): экран «Пригласить коллегу», перевод на баланс с подтверждением,
// ограничение вывода, сообщение о вознаграждении, скидка клуба с датой и причиной, один текст начисления от поддержки.

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  processUpdate: (update: Record<string, unknown>) => Promise<void>;
  bonusNoticeText: (input: { kopecks: number; note?: string; balanceKopecks: number }) => string;
};
const club = require('../../server/_club.js') as {
  clubDiscountInfo: (telegramId: number, options?: { requireRef?: boolean }) => Promise<{ active: boolean; until: string | null; reason: string }>;
};
const payments = require('../../server/_payments.js') as { notifyReferralReward: (order: Record<string, unknown>) => Promise<void> };
const botTexts = require('../../server/_bot-texts.js') as {
  supportMoneyNotice: (input: { kopecks: number; note?: string; balanceKopecks: number }) => { subject: string; body: string };
  supportMoneyNoticeHtml: (input: { kopecks: number; note?: string; balanceKopecks: number }) => string;
};
const messages = require('../../server/_admin-messages.js') as { telegramText: (subject: string, body: string) => string };
const controls = require('../../server/_user-controls.js') as { __setSnapshotForTests: (json: unknown) => void };
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };

const USER = '9f9f9f9f-1111-2222-3333-444455556666';
const SUPPORT_URL = 'https://t.me/roma_denosov';
const DAY = 24 * 60 * 60 * 1000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Скидка клуба кешируется в памяти модуля по Telegram ID — у каждого теста свой человек.
let tgSeq = 726000000;
let TG = 0;
let from = { id: 0, first_name: 'Аня', username: 'pvz_anna' };
let updateId = 9000;
const message = (text: string) => ({ update_id: ++updateId, message: { message_id: updateId, text, from, chat: { id: TG, type: 'private' } } });
const press = (data: string) => ({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, from, data, message: { message_id: 50, chat: { id: TG, type: 'private' } } } });

type World = {
  referral: Record<string, unknown>;
  moved: number;
  clubRefAt: string | null;
  clubStatus: number;
  clubActive: boolean;
  referralAvailable: number | null;
  transferOk: boolean;
};
let world: World;
let db: Array<{ method: string; path: string; body: any }>;
let sent: Array<{ method: string; body: Record<string, any> }>;

beforeEach(() => {
  TG = ++tgSeq;
  from = { id: TG, first_name: 'Аня', username: 'pvz_anna' };
  db = []; sent = [];
  userCache.clearTelegramUserCache();
  controls.__setSnapshotForTests(null);
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
  process.env.TELEGRAM_LOCAL_POLLING = '1';
  process.env.STICKER_CLIENT_SECRET = 's'.repeat(32);
  process.env.WB_CONNECTION_STORE = 'memory';
  world = {
    referral: { referral_code: 'ABC123', available_kopecks: 45000, earned_kopecks: 90000 },
    moved: 45000, clubRefAt: null, clubStatus: 200, clubActive: false, referralAvailable: 64000, transferOk: true,
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const address = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (address.startsWith('https://zara.test')) return json({ active: world.clubActive }, world.clubStatus);
    if (!address.startsWith('https://db.test')) {
      sent.push({ method: address.split('/').pop() || '', body: body || {} });
      if (address.endsWith('/getMe')) return json({ ok: true, result: { username: 'shk_test_bot' } });
      return json({ ok: true, result: { message_id: 77 } });
    }
    const path = decodeURIComponent(address.split('/rest/v1/')[1] || '');
    const method = String(init.method || 'GET').toUpperCase();
    db.push({ method, path, body });
    if (path.startsWith('user_telegram_identities?telegram_user_id=eq.')) return json([{ user_id: USER, telegram_user_id: TG }]);
    if (path.startsWith('user_telegram_identities?user_id=eq.')) return json([{ telegram_user_id: TG }]);
    if (path === 'rpc/ensure_referral_account') return json(world.referral);
    if (path.startsWith('referral_attributions')) return json([{ invited_user_id: 'x' }, { invited_user_id: 'y' }]);
    if (path === 'rpc/referral_to_wallet') return json(world.transferOk ? { ok: true, moved: world.moved, wallet_balance: 57000 } : { ok: false });
    if (path.startsWith('referral_ledger')) return json([{ user_id: USER, amount_kopecks: 5000 }]);
    if (path.startsWith('referral_accounts?user_id')) return json(world.referralAvailable == null ? [] : [{ available_kopecks: world.referralAvailable }]);
    if (path.startsWith('telegram_bot_subscribers?telegram_user_id') && method === 'GET') return json([{ club_ref_at: world.clubRefAt }]);
    if (path.startsWith('telegram_bot_subscribers') && method === 'POST' && body?.club_ref_at) { world.clubRefAt = body.club_ref_at; return json(null); }
    if (path.startsWith('telegram_generator_sessions') && method === 'POST') return json([{ ...body }]);
    if (path.startsWith('wallet_accounts')) return json([{ balance_kopecks: 12000 }]);
    if (path === 'rpc/app_entitlements') return json({ codes_limit: 0, codes_used: 0, packs_left: 0 });
    if (path === 'rpc/consume_api_rate_limit') return json(true);
    return json([]);
  }));
});

afterEach(() => {
  controls.__setSnapshotForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ['TELEGRAM_LOCAL_POLLING', 'TELEGRAM_BOT_TOKEN', 'STICKER_CLIENT_SECRET', 'WB_CONNECTION_STORE', 'ZARA_CLUB_CHECK_URL', 'CLUB_CHECK_SECRET']) delete process.env[key];
});

const screens = () => sent.filter(call => call.method === 'sendMessage' || call.method === 'editMessageText');
const lastScreen = () => screens().at(-1)!;
const lastText = () => String(lastScreen().body.text || '');
const buttons = (call = lastScreen()) => (call.body.reply_markup?.inline_keyboard || []).flat() as Array<Record<string, any>>;
const transfers = () => db.filter(call => call.path === 'rpc/referral_to_wallet');
const enableClub = () => { process.env.ZARA_CLUB_CHECK_URL = 'https://zara.test/check'; process.env.CLUB_CHECK_SECRET = 'club-secret'; };

describe('экран «👥 Пригласить коллегу»', () => {
  it('одна фраза о механике (не только «пополнения»), три понятных числа, только новые, «⬅️ Профиль»', async () => {
    await bot.processUpdate(press('menu:ref'));
    const text = lastText();
    expect(text).toContain('<b>👥 Пригласить коллегу</b>');
    expect(text).toContain('вам 10% с каждой его оплаты картой');
    expect(text).toContain('Засчитываются только те, кто раньше не пользовался ботом.');
    expect(text).toContain('Приглашено: <b>2</b>');
    expect(text).toContain('Начислено всего: <b>900 ₽</b>');
    expect(text).toContain('Можно забрать: <b>450 ₽</b>');
    expect(text).not.toMatch(/Доступно|заработано|реферальн/);
    expect(buttons().map(button => button.callback_data)).toEqual(expect.arrayContaining(['ref:towallet', 'menu:profile', 'menu:home']));
    // Меньше 500 ₽ — вывода на карту кнопкой нет.
    expect(buttons().some(button => button.url === SUPPORT_URL)).toBe(false);
  });
});

describe('перевод вознаграждения на баланс', () => {
  it('ref:towallet — сначала вопрос с предупреждением, денег не трогаем', async () => {
    await bot.processUpdate(press('ref:towallet'));
    expect(transfers()).toHaveLength(0);
    expect(lastText()).toContain('Перевести 450 ₽ на баланс бота?');
    expect(lastText()).toContain('Вывести их на карту после перевода будет нельзя.');
    expect(buttons().map(button => button.callback_data)).toEqual(['ref:towallet:yes', 'menu:ref', 'menu:home']);
  });

  it('«✅ Перевести на баланс» — один перевод всей суммы и итог на экране приглашений', async () => {
    await bot.processUpdate(press('ref:towallet:yes'));
    expect(transfers()).toHaveLength(1);
    expect(transfers()[0].body).toEqual({ p_user: USER, p_kopecks: null });
    expect(lastText()).toContain('✅ Переведено 450 ₽ на баланс. На балансе: 570 ₽.');
  });

  it('нечего переводить — простые слова, без «реферальных»', async () => {
    world.referral = { referral_code: 'ABC123', available_kopecks: 0, earned_kopecks: 0 };
    await bot.processUpdate(press('ref:towallet'));
    expect(transfers()).toHaveLength(0);
    expect(lastText()).toContain('Переводить пока нечего — вознаграждение ещё не начислено.');
  });

  it('уже всё перевели (старая кнопка, второе нажатие) — не «ещё не начислено»', async () => {
    world.referral = { referral_code: 'ABC123', available_kopecks: 0, earned_kopecks: 90000 };
    await bot.processUpdate(press('ref:towallet'));
    expect(transfers()).toHaveLength(0);
    expect(lastText()).toContain('Переводить нечего — всё доступное уже переведено.');
    expect(lastText()).not.toContain('ещё не начислено');

    // Второе «✅ Перевести на баланс»: rpc уже нечего переводить (ok:false).
    world.transferOk = false;
    sent = [];
    await bot.processUpdate(press('ref:towallet:yes'));
    expect(transfers()).toHaveLength(1);
    expect(lastText()).toContain('Переводить нечего — всё доступное уже переведено.');
    expect(buttons().some(button => button.callback_data === 'ref:towallet')).toBe(false);
  });

  it('ограничение «Выводы» — что закрыто, кнопка-ссылка поддержки; ни вопроса, ни перевода', async () => {
    controls.__setSnapshotForTests({ unlimited: [], restrictions: [{ id: 'r1', user_id: USER, telegram_user_id: TG, scopes: ['withdrawals'], until: null, public_message: null }] });
    for (const data of ['ref:towallet', 'ref:towallet:yes']) {
      sent = [];
      await bot.processUpdate(press(data));
      expect(lastText()).toContain('⛔ Перевод и вывод вознаграждения сейчас недоступны.');
      expect(buttons().find(button => button.url === SUPPORT_URL)?.text).toBe('✉️ Написать в поддержку');
      // Ни «Перевести», ни «Вывести на карту» — они вели бы по кругу на этот же экран.
      expect(buttons().some(button => button.callback_data === 'ref:towallet')).toBe(false);
      expect(buttons().some(button => String(button.text).includes('Вывести на карту'))).toBe(false);
    }
    expect(transfers()).toHaveLength(0);
  });
});

describe('сообщение о вознаграждении (notifyReferralReward)', () => {
  it('за что начислено, сколько можно забрать, кнопка раздела новым сообщением', async () => {
    await payments.notifyReferralReward({ id: 'order-1', amount: 500 });
    const notice = sent.find(call => call.method === 'sendMessage')!;
    expect(notice.body.text).toBe([
      '<b>💸 +50 ₽ за приглашение</b>',
      'Коллега, которого вы пригласили, сделал оплату — вам 10%.',
      'Можно забрать: <b>640 ₽</b> — на баланс бота или на карту (от 500 ₽).',
    ].join('\n'));
    expect(notice.body.reply_markup.inline_keyboard).toEqual([[{ text: '👥 Пригласить коллегу', callback_data: 'n:menu:ref' }]]);
  });

  it('накопленное не прочиталось — без этой строки, но сообщение уходит', async () => {
    world.referralAvailable = null;
    await payments.notifyReferralReward({ id: 'order-1', amount: 500 });
    const text = String(sent.find(call => call.method === 'sendMessage')!.body.text);
    expect(text).toContain('+50 ₽ за приглашение');
    expect(text).not.toContain('Можно забрать');
  });

  it('покупка с баланса (amount 0) — вознаграждения нет, сообщения нет', async () => {
    await payments.notifyReferralReward({ id: 'order-1', amount: 0 });
    expect(sent.some(call => call.method === 'sendMessage')).toBe(false);
  });
});

describe('скидка клуба: дата и причина', () => {
  it('clubDiscountInfo различает «не настроено», «не из клуба», «действует», «закончилась», «неактивна», «закончилась и неактивна», «сбой»', async () => {
    expect((await club.clubDiscountInfo(TG)).reason).toBe('off');
    enableClub();
    expect((await club.clubDiscountInfo(TG)).reason).toBe('no_ref');

    TG = ++tgSeq; world.clubRefAt = new Date(Date.now() - 5 * DAY).toISOString(); world.clubActive = true;
    const active = await club.clubDiscountInfo(TG);
    expect(active).toMatchObject({ active: true, reason: 'active' });
    expect(Date.parse(active.until!)).toBe(Date.parse(world.clubRefAt) + 30 * DAY);

    TG = ++tgSeq; world.clubRefAt = new Date(Date.now() - 40 * DAY).toISOString(); world.clubActive = true;
    expect(await club.clubDiscountInfo(TG)).toEqual({ active: false, until: null, reason: 'expired' });

    TG = ++tgSeq; world.clubRefAt = new Date(Date.now() - 5 * DAY).toISOString(); world.clubActive = false;
    expect((await club.clubDiscountInfo(TG)).reason).toBe('inactive');

    TG = ++tgSeq; world.clubRefAt = new Date(Date.now() - 40 * DAY).toISOString(); world.clubActive = false;
    expect(await club.clubDiscountInfo(TG)).toEqual({ active: false, until: null, reason: 'lapsed' });

    TG = ++tgSeq; world.clubStatus = 502;
    expect((await club.clubDiscountInfo(TG)).reason).toBe('error');
  });

  it('«Код клиента»: действующая скидка — с датой окончания', async () => {
    enableClub();
    world.clubRefAt = new Date(Date.now() - 5 * DAY).toISOString(); world.clubActive = true;
    await bot.processUpdate(press('menu:code'));
    expect(lastText()).toMatch(/🎁 Скидка участника клуба 20% — до \d{2}\.\d{2}\./);
    expect(lastText()).toContain('40 ₽');
  });

  it('«Код клиента»: 30 дней прошли — как включить снова; цена без скидки', async () => {
    enableClub();
    world.clubRefAt = new Date(Date.now() - 40 * DAY).toISOString(); world.clubActive = true;
    await bot.processUpdate(press('menu:code'));
    expect(lastText()).toContain('Скидка клуба закончилась. Чтобы включить её снова на 30 дней, откройте бота по кнопке из группы клуба.');
    expect(lastText()).toContain('50 ₽');
  });

  it('«Код клиента»: 30 дней прошли и подписка неактивна — оба шага сразу', async () => {
    enableClub();
    world.clubRefAt = new Date(Date.now() - 40 * DAY).toISOString(); world.clubActive = false;
    await bot.processUpdate(press('menu:code'));
    expect(lastText()).toContain('продлите подписку на клуб и откройте бота по кнопке из группы клуба.');
    expect(lastText()).not.toContain('действует при активной подписке');
    expect(lastText()).toContain('50 ₽');
  });

  it('сбой проверки — не «подписка неактивна»: на экранах молчим, после перехода из группы — честная строка', async () => {
    enableClub();
    world.clubRefAt = new Date(Date.now() - 5 * DAY).toISOString(); world.clubStatus = 502;
    await bot.processUpdate(press('menu:code'));
    expect(lastText()).not.toMatch(/подписк/);
    await bot.processUpdate(message('/start club'));
    expect(lastText()).toContain('Не получилось проверить подписку на клуб');
    expect(lastText()).not.toContain('при активной подписке');
  });

  it('переход из группы без активной подписки — почему скидки нет', async () => {
    enableClub();
    world.clubActive = false;
    await bot.processUpdate(message('/start club'));
    expect(lastText()).toContain('Скидка 20% для участников клуба действует при активной подписке на клуб.');
  });
});

describe('начисление от поддержки: один текст', () => {
  it('/bonus в боте и «Кошелёк» в админке шлют в Telegram одно и то же', () => {
    const input = { kopecks: 10000, note: 'За помощь', balanceKopecks: 35050 };
    const { subject, body } = botTexts.supportMoneyNotice(input);
    expect(bot.bonusNoticeText(input)).toBe(messages.telegramText(subject, body));
    expect(bot.bonusNoticeText(input)).toBe('<b>🎁 Поддержка начислила вам 100 ₽</b>\n\nПричина: За помощь\n💰 На балансе: 350,50 ₽');
  });

  it('без комментария — без строки «Причина»; списание — с подсказкой про поддержку', () => {
    expect(botTexts.supportMoneyNoticeHtml({ kopecks: 500, balanceKopecks: 500 })).not.toContain('Причина');
    expect(botTexts.supportMoneyNotice({ kopecks: -5000, note: 'возврат', balanceKopecks: 0 })).toEqual({
      subject: 'С баланса списано 50 ₽',
      body: 'Причина: возврат\n💰 На балансе: 0 ₽\nЕсть вопросы — напишите в поддержку.',
    });
  });
});
