import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Первый контакт с ботом (этап B): приветствие с ценами, новое меню, «Помощь», команды, подсказка на непонятный
// ввод, сброс начатого ввода командами, клуб, приглашённый, устаревшие кнопки, кнопки под уведомлениями, сбой.

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  BOT_COMMANDS: Array<{ command: string; description: string }>;
  processUpdate: (update: Record<string, unknown>) => Promise<void>;
  syncBotCommands: () => Promise<unknown>;
};
const club = require('../../server/_club.js') as {
  clubDiscount: (telegramId: number) => Promise<boolean>;
  markClubRef: (telegramId: number) => Promise<void>;
};
const notice = require('../../server/_bot-notice.js') as {
  noticeData: (data: string) => string;
  noticeMarkup: (markup: unknown) => any;
  keptRows: (markup: unknown) => any[];
};
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };

const USER = '9f9f9f9f-1111-2222-3333-444455556666';
const NEW_USER = '7a7a7a7a-1111-2222-3333-444455556666';
const REFERRER = '1b1b1b1b-1111-2222-3333-444455556666';
const REFERRER_TG = 990001;
const SUPPORT_URL = 'https://t.me/roma_denosov';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Сессии мастера и скидка клуба кешируются в памяти модуля по Telegram ID — у каждого теста свой человек.
let tgSeq = 716000000;
let TG = 0;
let from = { id: 0, first_name: 'Аня', username: 'pvz_anna' };
let updateId = 5000;
const message = (text: string, extra: Record<string, unknown> = {}) => ({ update_id: ++updateId, message: { message_id: updateId, text, from, chat: { id: TG, type: 'private' }, ...extra } });
const press = (data: string, messageId = 50, replyMarkup?: unknown) => ({
  update_id: ++updateId,
  callback_query: { id: `cb${updateId}`, from, data, message: { message_id: messageId, chat: { id: TG, type: 'private' }, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) } },
});

type World = {
  identity: string | null;
  session: Record<string, unknown> | null;
  referralOwner: boolean;
  captured: boolean;
  clubRefAt: string | null;
  clubActive: boolean;
  failPath: string | null;
};
let world: World;
let db: Array<{ method: string; path: string; body: any }>;
let sent: Array<{ method: string; body: Record<string, any> }>;

beforeEach(() => {
  TG = ++tgSeq;
  from = { id: TG, first_name: 'Аня', username: 'pvz_anna' };
  db = []; sent = [];
  userCache.clearTelegramUserCache();
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
  process.env.TELEGRAM_LOCAL_POLLING = '1';
  process.env.STICKER_CLIENT_SECRET = 's'.repeat(32);
  process.env.WB_CONNECTION_STORE = 'memory';
  world = { identity: USER, session: null, referralOwner: true, captured: false, clubRefAt: null, clubActive: false, failPath: null };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const address = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (address.startsWith('https://zara.test')) return json({ active: world.clubActive });
    if (!address.startsWith('https://db.test')) {
      sent.push({ method: address.split('/').pop() || '', body: body || {} });
      if (address.endsWith('/getMe')) return json({ ok: true, result: { username: 'shk_test_bot' } });
      return json({ ok: true, result: { message_id: 77 } });
    }
    const path = decodeURIComponent(address.includes('/rest/v1/') ? address.split('/rest/v1/')[1] : `auth:${address.split('/auth/v1/')[1]}`);
    const method = String(init.method || 'GET').toUpperCase();
    db.push({ method, path, body });
    if (world.failPath && path.startsWith(world.failPath)) return json({ message: 'boom' }, 500);
    if (path.startsWith('user_telegram_identities?telegram_user_id=eq.')) return json(world.identity ? [{ user_id: world.identity, telegram_user_id: TG }] : []);
    if (path.startsWith('user_telegram_identities?user_id=eq.' + REFERRER)) return json([{ telegram_user_id: REFERRER_TG }]);
    if (path.startsWith('user_telegram_identities') && method === 'POST') { world.identity = body.user_id; return json([body]); }
    if (path === 'auth:admin/users' && method === 'POST') return json({ id: NEW_USER });
    if (path.startsWith('referral_accounts?referral_code=')) return json(world.referralOwner ? [{ user_id: REFERRER }] : []);
    if (path.startsWith('telegram_referral_captures?on_conflict')) { world.captured = true; return json([{ telegram_user_id: TG }]); }
    if (path.startsWith('telegram_referral_captures?telegram_user_id') && method === 'GET') return json(world.captured ? [{ referral_code: 'ABC123', captured_at: new Date().toISOString() }] : []);
    if (path === 'rpc/bind_referral') return json(true);
    if (path.startsWith('referral_attributions?invited_user_id')) return json([{ referrer_user_id: REFERRER }]);
    if (path.startsWith('telegram_bot_subscribers?telegram_user_id') && method === 'GET') return json([{ club_ref_at: world.clubRefAt }]);
    if (path.startsWith('telegram_bot_subscribers') && method === 'POST' && body?.club_ref_at) { world.clubRefAt = body.club_ref_at; return json(null); }
    if (path.startsWith('telegram_generator_sessions') && method === 'GET') return json(world.session ? [world.session] : []);
    if (path.startsWith('telegram_generator_sessions') && method === 'POST') return json([{ ...body }]);
    if (path.startsWith('wallet_accounts')) return json([{ balance_kopecks: 12000 }]);
    if (path === 'rpc/consume_api_rate_limit') return json(true);
    return json([]);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ['TELEGRAM_LOCAL_POLLING', 'TELEGRAM_BOT_TOKEN', 'STICKER_CLIENT_SECRET', 'WB_CONNECTION_STORE', 'ZARA_CLUB_CHECK_URL', 'CLUB_CHECK_SECRET']) delete process.env[key];
});

const screens = () => sent.filter(call => call.method === 'sendMessage' || call.method === 'editMessageText');
const texts = () => screens().map(call => String(call.body.text || ''));
const lastScreen = () => screens().at(-1)!;
const buttons = (call = lastScreen()) => (call.body.reply_markup?.inline_keyboard || []).flat() as Array<Record<string, any>>;
const sessionDeleted = () => db.some(call => call.method === 'DELETE' && call.path.startsWith('telegram_generator_sessions'));
const enableClub = () => { process.env.ZARA_CLUB_CHECK_URL = 'https://zara.test/check'; process.env.CLUB_CHECK_SECRET = 'club-secret'; world.clubActive = true; };

describe('приветствие и главное меню', () => {
  it('/start — для кого бот, цены из констант, оплата с баланса, «выберите кнопкой»', async () => {
    await bot.processUpdate(message('/start'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('Здравствуйте, Аня!');
    expect(text).toContain('сотрудников ПВЗ Wildberries');
    expect(text).toContain('Стикер с ШК товара (номер из 11 цифр) — 7,50 ₽, пачка из 50 новых — 20 ₽');
    expect(text).toContain('QR-код клиента по его ID — 50 ₽ или 1 код из тарифа «Помощника ПВЗ»');
    expect(text).toContain('кто поставил оценку, — 25 ₽');
    expect(text).toContain('Оплата — с баланса бота, пополнение от 25 ₽.');
    expect(text).toContain('кнопкой ниже');
    expect(lastScreen().body.reply_markup.inline_keyboard.map((row: any[]) => row.map(button => button.text))).toEqual([
      ['🏷 Стикеры и QR коробок'],
      ['🔑 Код клиента', '⭐ Отзывы ПВЗ'],
      ['💻 Помощник ПВЗ', '🖨 ПВЗ Принт'],
      ['👤 Профиль и баланс', '🆘 Помощь'],
      ['👥 Пригласить коллегу'],
    ]);
  });

  it('«Помощь» — справка с ценами и поддержка на одном экране; канал и VPN — здесь', async () => {
    await bot.processUpdate(press('menu:help'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('Помощь и поддержка');
    expect(text).toContain('7,50 ₽');
    expect(text).toContain('<code>Код 191607973</code>');
    expect(text).toContain(`<code>${TG}</code>`);
    expect(text).not.toMatch(/[Кк]абинет/);
    expect(buttons().map(button => button.url || button.callback_data)).toEqual([SUPPORT_URL, 'https://t.me/wbtools_ru', 'https://t.me/wb_wpn_bot', 'menu:home']);
  });

  it('команды совпадают с меню: есть /balance и /cancel, /balance открывает пополнение; список ставится setMyCommands', async () => {
    const names = bot.BOT_COMMANDS.map(command => command.command);
    expect(names).toEqual(expect.arrayContaining(['menu', 'stickers', 'code', 'reviews', 'profile', 'balance', 'invite', 'help', 'cancel']));
    for (const command of bot.BOT_COMMANDS) {
      expect(command.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(command.description.length).toBeLessThanOrEqual(256);
    }
    await bot.processUpdate(message('/balance'));
    expect(String(lastScreen().body.text)).toContain('Пополнение');
    sent = [];
    await bot.syncBotCommands();
    expect(sent.find(call => call.method === 'setMyCommands')?.body.commands).toEqual(bot.BOT_COMMANDS);
  });
});

describe('непонятный ввод', () => {
  it('текст в свободной форме — подсказка, что бот умеет без кнопок, и меню', async () => {
    await bot.processUpdate(message('как пополнить баланс?'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('не отвечаю на сообщения в свободной форме');
    expect(text).toContain('номер ШК (11 цифр)');
    expect(text).toContain('50 ₽ или 1 код из тарифа');
    expect(text).toContain('«🆘 Помощь»');
    expect(buttons().some(button => button.callback_data === 'menu:help')).toBe(true);
  });

  it('неизвестная команда — «Такой команды нет»', async () => {
    await bot.processUpdate(message('/foo'));
    expect(String(lastScreen().body.text)).toMatch(/^Такой команды нет\./);
  });

  it('второе фото за 10 секунд — «подождите», а не молчание; на всю серию — одно предупреждение', async () => {
    const photo = { photo: [{ file_id: 'f1', file_size: 100 }] };
    await bot.processUpdate(message('', photo));
    sent = [];
    await bot.processUpdate(message('', photo));
    await bot.processUpdate(message('', photo));
    expect(texts()).toEqual(['Читаю по одному фото за раз. Дождитесь ответа по первому и пришлите следующее.']);
  });
});

describe('команды посреди ввода', () => {
  it('/code посреди поиска клиента закрывает поиск, /help — нет', async () => {
    world.session = { telegram_user_id: TG, chat_id: TG, state: 'await_client_query', draft: { userId: USER }, updated_at: new Date().toISOString() };
    await bot.processUpdate(message('/help'));
    expect(sessionDeleted()).toBe(false);
    await bot.processUpdate(message('/code'));
    expect(sessionDeleted()).toBe(true);
  });

  it('/start тоже сбрасывает начатый ввод', async () => {
    await bot.processUpdate(message('/start'));
    expect(sessionDeleted()).toBe(true);
  });
});

describe('клуб', () => {
  it('/start club — строка о скидке: на что и до какого числа; цены в приветствии со скидкой', async () => {
    enableClub();
    await bot.processUpdate(message('/start club'));
    expect(world.clubRefAt).not.toBeNull();
    const text = String(lastScreen().body.text);
    expect(text).toMatch(/скидка 20% на «Код клиента» и «Кто поставил оценку» до \d{2}\.\d{2}, пока активна подписка на клуб/);
    expect(text).toContain('по его ID — 40 ₽');
    expect(text).toContain('кто поставил оценку, — 20 ₽');
  });

  it('/start club_reviews — сначала польза и цена отзывов, потом вход', async () => {
    enableClub();
    await bot.processUpdate(message('/start club_reviews'));
    const [intro] = texts();
    expect(intro).toContain('Здравствуйте, Аня!');
    expect(intro).toContain('⭐ Отзывы ПВЗ');
    expect(intro).toContain('смотреть бесплатно');
    expect(intro).toContain('— 20 ₽ с баланса');
    expect(intro).toContain('вход в WB');
  });

  it('markClubRef сбрасывает закешированный ответ «скидки нет» (ключ ref:<id>)', async () => {
    enableClub();
    expect(await club.clubDiscount(TG)).toBe(false); // перехода из группы ещё не было — ответ ушёл в кеш
    await club.markClubRef(TG);
    expect(await club.clubDiscount(TG)).toBe(true);
  });
});

describe('приглашённый', () => {
  it('новичок по ссылке — аккаунт создаётся сразу, пригласивший получает сообщение; в приветствии без «откройте Профиль»', async () => {
    world.identity = null;
    await bot.processUpdate(message('/start r_abc123'));
    expect(db.some(call => call.path === 'auth:admin/users' && call.method === 'POST')).toBe(true);
    expect(db.some(call => call.path === 'rpc/bind_referral')).toBe(true);
    const toReferrer = sent.find(call => call.method === 'sendMessage' && call.body.chat_id === REFERRER_TG);
    expect(toReferrer?.body.text).toContain('По вашей ссылке пришёл новый пользователь');
    expect(toReferrer?.body.reply_markup.inline_keyboard.flat()[0].callback_data).toBe('n:menu:ref');
    const greeting = String(lastScreen().body.text);
    expect(greeting).toContain('Вы пришли по приглашению коллеги — добро пожаловать!');
    expect(greeting).not.toContain('Профиль');
  });

  it('уже пользовался ботом — одна строка, что приглашение только для новых; переход не записывается', async () => {
    await bot.processUpdate(message('/start r_abc123'));
    expect(String(lastScreen().body.text)).toContain('Приглашение засчитывается только новым пользователям');
    expect(db.some(call => call.path.startsWith('telegram_referral_captures?on_conflict'))).toBe(false);
  });

  it('неизвестный код — одна строка, бот работает как обычно', async () => {
    world.identity = null;
    world.referralOwner = false;
    await bot.processUpdate(message('/start r_zzz999'));
    expect(String(lastScreen().body.text)).toContain('Ссылку-приглашение не узнал');
    expect(db.some(call => call.path === 'auth:admin/users')).toBe(false);
  });
});

describe('устаревшие кнопки', () => {
  it('кнопка старого шага без сессии — понятный текст и меню вместо «Сессия истекла»', async () => {
    await bot.processUpdate(press('gen:kind:product'));
    const screen = lastScreen();
    expect(screen.method).toBe('editMessageText');
    expect(screen.body.text).toBe('Это действие уже завершено или отменено. Начните заново кнопкой ниже.');
    expect(buttons(screen).some(button => button.callback_data === 'menu:stickers')).toBe(true);
  });

  it('двойное нажатие на текущем экране — только всплывающая надпись, экран не трогаем', async () => {
    world.session = { telegram_user_id: TG, chat_id: TG, state: 'generating', draft: { userId: USER, msgId: 50 }, updated_at: new Date().toISOString() };
    await bot.processUpdate(press('gen:confirm', 50));
    expect(screens()).toEqual([]);
    expect(sent.find(call => call.method === 'answerCallbackQuery')?.body.text).toBe('Уже выполняю — подождите');
  });

  it('кнопка мастера со старого экрана — всплывающая подсказка и снятые кнопки со старого сообщения', async () => {
    world.session = { telegram_user_id: TG, chat_id: TG, state: 'choose_mode', draft: { userId: USER, msgId: 60 }, updated_at: new Date().toISOString() };
    await bot.processUpdate(press('gen:mode:custom', 50));
    expect(sent.find(call => call.method === 'editMessageReplyMarkup')?.body).toMatchObject({ message_id: 50, reply_markup: { inline_keyboard: [] } });
    expect(screens()).toEqual([]);
  });
});

describe('кнопки под уведомлениями (n:<callback>)', () => {
  it('открывают экран новым сообщением, снимают с уведомления переходы, но оставляют действия', async () => {
    const markup = {
      inline_keyboard: [
        [{ text: '🚫 Это не я', callback_data: 'dv:no:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }],
        [{ text: '👤 Профиль', callback_data: 'n:menu:profile' }, { text: '☰ Меню', callback_data: 'n:menu:home' }],
      ],
    };
    await bot.processUpdate(press('n:menu:profile', 50, markup));
    expect(sent.find(call => call.method === 'editMessageReplyMarkup')?.body).toEqual({
      chat_id: TG, message_id: 50, reply_markup: { inline_keyboard: [[markup.inline_keyboard[0][0]]] },
    });
    // Профиль — новым сообщением: само уведомление не редактируется.
    expect(sent.some(call => call.method === 'editMessageText')).toBe(false);
    expect(String(lastScreen().body.text)).toContain('Профиль');
    expect(lastScreen().method).toBe('sendMessage');
  });

  it('префикс ставится только на callback-кнопки и только если влезает в 64 байта', () => {
    expect(notice.noticeData('menu:home')).toBe('n:menu:home');
    expect(notice.noticeData('n:menu:home')).toBe('n:menu:home');
    const long = `shop:cp:r:${'a'.repeat(54)}`;
    expect(Buffer.byteLength(long)).toBe(64);
    expect(notice.noticeData(long)).toBe(long);
    expect(Buffer.byteLength(notice.noticeData('shop:cp:r:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'))).toBeLessThanOrEqual(64);
    const markup = notice.noticeMarkup({ inline_keyboard: [[{ text: 'Сайт', url: 'https://shk-wb.ru' }, { text: 'Меню', callback_data: 'menu:home' }]] });
    expect(markup.inline_keyboard[0]).toEqual([{ text: 'Сайт', url: 'https://shk-wb.ru' }, { text: 'Меню', callback_data: 'n:menu:home' }]);
    expect(notice.keptRows(markup)).toEqual([[{ text: 'Сайт', url: 'https://shk-wb.ru' }]]);
  });
});

describe('сбой на нашей стороне', () => {
  it('что с деньгами и куда писать: код для поддержки и кнопка-ссылка поддержки', async () => {
    world.failPath = 'sticker_access_codes';
    await bot.processUpdate(press('menu:profile'));
    const screen = lastScreen();
    expect(screen.body.text).toMatch(/сбой на нашей стороне[\s\S]*Если деньги списались, а результата нет[\s\S]*<code>[0-9a-f]{6}<\/code>/);
    expect(buttons(screen).map(button => button.url || button.callback_data)).toEqual([SUPPORT_URL, 'menu:home']);
  });
});
