import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// «Код клиента» в боте (этап E): экран с «что спишется», разбор «Код N», подпись и кнопки под QR, сбой отправки
// по факту возврата, поиск по ячейке / телефону / ID, запросы с компьютеров и «пополнить и выдать».

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  processUpdate: (update: Record<string, unknown>) => Promise<void>;
  afterWalletTopup: (order: Record<string, unknown>, noticeId?: number | null) => Promise<boolean>;
  findClientsByQuery: (goods: unknown[], digits: string) => Array<{ sid: string; name: string; cells: Set<string> }>;
};
const approvals = require('../../server/_code-approvals.js') as Record<string, any>;
const topupScreen = require('../../server/_topup-screen.js') as { topupBackData: (then: string) => string };
const wbPvz = require('../../server/_wb-pvz.js') as Record<string, any>;
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };

const USER = '9f9f9f9f-1111-2222-3333-444455556666';
const APPROVAL = '33333333-3333-4333-8333-333333333333';
const DEV_ID = '11111111-1111-4111-8111-111111111111';
const QUOTA_CHARGE = { qrText: '191607973_12345_654321_1', billing: { via: 'account', source: 'quota' }, replayed: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let tgSeq = 726000000;
let TG = 0;
let from = { id: 0, first_name: 'Аня', username: 'pvz_anna' };
let updateId = 9000;
const message = (text: string) => ({ update_id: ++updateId, message: { message_id: updateId, text, from, chat: { id: TG, type: 'private' } } });
const press = (data: string, messageId = 50) => ({
  update_id: ++updateId,
  callback_query: { id: `cb${updateId}`, from, data, message: { message_id: messageId, chat: { id: TG, type: 'private' } } },
});

type World = {
  session: Record<string, unknown> | null;
  wb: { state: string; session: Record<string, unknown> } | null;
  ent: Record<string, unknown>;
  balance: number;
  photoFails: boolean;
  refundFails: boolean;
  approval: Record<string, unknown> | null;
  pending: Array<Record<string, unknown>>;
  codeOnce: Record<string, unknown> | null;
};
let world: World;
let db: Array<{ method: string; path: string; body: any }>;
let sent: Array<{ method: string; body: Record<string, any> }>;

const pendingRow = (extra: Record<string, unknown> = {}) => ({
  id: APPROVAL, user_id: USER, device_id: DEV_ID, sid: '191607973', cell: '12', point_wb: '123', status: 'pending',
  qr_text: null, billing: null, error: null, telegram_chat_id: TG, telegram_message_id: 77,
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(), decided_at: null, ...extra,
});

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
  world = {
    session: null, wb: null, ent: { codes_limit: 0, codes_used: 0, packs_left: 0 }, balance: 12000,
    photoFails: false, refundFails: false, approval: null, pending: [],
    codeOnce: null,
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const address = String(url);
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null;
    if (!address.startsWith('https://db.test')) {
      const method = address.split('/').pop() || '';
      sent.push({ method, body: body || {} });
      if (method === 'sendPhoto' && world.photoFails) return json({ ok: false, description: 'Bad Request: wrong file identifier' }, 400);
      return json({ ok: true, result: { message_id: 88 } });
    }
    const path = decodeURIComponent(address.split('/rest/v1/')[1] || address);
    const method = String(init.method || 'GET').toUpperCase();
    db.push({ method, path, body });
    if (path.startsWith('user_telegram_identities')) return json([{ user_id: USER, telegram_user_id: TG }]);
    if (path.startsWith('telegram_generator_sessions') && method === 'GET') return json(world.session ? [world.session] : []);
    if (path.startsWith('telegram_generator_sessions') && method === 'POST') { world.session = { ...body }; return json([{ ...body }]); }
    if (path.startsWith('telegram_wb_connections') && method === 'GET') {
      return json(world.wb ? [{ telegram_user_id: TG, state: world.wb.state, encrypted_session: wbPvz.encryptSession(world.wb.session) }] : []);
    }
    if (path.startsWith('wallet_accounts')) return json([{ balance_kopecks: world.balance }]);
    if (path === 'rpc/app_entitlements') return json(world.ent);
    // нет кодов (по умолчанию) — как в базе: LIMIT_EXCEEDED, дальше списание с баланса
    if (path === 'rpc/app_code_once') return world.codeOnce ? json(world.codeOnce) : json({ message: 'LIMIT_EXCEEDED' }, 400);
    if (path === 'rpc/wallet_spend') return json({ ok: true, balance: world.balance - body.p_kopecks });
    if (path === 'rpc/admin_wallet_adjust') return world.refundFails ? json({ message: 'boom' }, 500) : json({ ok: true, balance: world.balance });
    if (path.startsWith('app_code_approvals?id=') && method === 'PATCH') {
      world.approval = { ...world.approval, ...body };
      return json([world.approval]);
    }
    if (path.startsWith('app_code_approvals?id=')) return json(world.approval ? [world.approval] : []);
    if (path.startsWith('app_code_approvals?user_id=') && path.includes('status=eq.pending')) return json(world.pending);
    if (path.startsWith('app_code_approvals?user_id=')) return json([]);
    if (path.startsWith('app_devices')) return json([{ id: DEV_ID, name: 'Ленина 5', point_wb: '123', role: 'work' }]);
    if (path.startsWith('telegram_generation_requests') && method === 'POST') return json([{ request_id: body.request_id }]);
    if (path === 'rpc/consume_api_rate_limit') return json(true);
    return json([]);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ['TELEGRAM_LOCAL_POLLING', 'TELEGRAM_BOT_TOKEN', 'STICKER_CLIENT_SECRET']) delete process.env[key];
});

const screens = () => sent.filter(call => call.method === 'sendMessage' || call.method === 'editMessageText');
const lastScreen = () => screens().at(-1)!;
const photos = () => sent.filter(call => call.method === 'sendPhoto');
const buttons = (call = lastScreen()) => (call.body.reply_markup?.inline_keyboard || []).flat() as Array<Record<string, any>>;
const rpc = (name: string) => db.filter(call => call.path === `rpc/${name}`);
const charged = () => rpc('wallet_spend').length + rpc('app_code_once').length;

describe('экран «Код клиента»', () => {
  it('поиск — первой кнопкой, без «Купить Стандарт», с «что спишется» и платным повтором', async () => {
    await bot.processUpdate(press('menu:code'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('Что спишется:</b> Спишется 50 ₽ с баланса, на балансе 120 ₽.');
    expect(text).toContain('Каждое получение QR — отдельное списание, даже для того же клиента.');
    expect(text).not.toContain('код тарифа');
    const data = buttons().map(button => button.callback_data);
    expect(data[0]).toBe('code:find');
    expect(data).not.toContain('shop:helper:standard');
    expect(data).not.toContain('menu:helper');
    expect(data).not.toContain('shop:wbpk');
  });

  it('есть пакет — «спишется 1 код из пакета» с остатком', async () => {
    world.ent = { codes_limit: 0, codes_used: 0, packs_left: 5 };
    await bot.processUpdate(press('menu:code'));
    expect(lastScreen().body.text).toContain('Спишется 1 код из пакета — останется 4.');
  });

  it('безлимит по правам — бесплатно, без строки о платном повторе', async () => {
    world.ent = { unlimited: true };
    await bot.processUpdate(press('menu:code'));
    expect(lastScreen().body.text).toContain('Сейчас бесплатно — ничего не спишется.');
    expect(lastScreen().body.text).not.toContain('отдельное списание');
  });
});

describe('«Код N» в чате', () => {
  it.each(['Код 191 607 973', 'код: 191607973', 'Код191607973', 'Код клиента 191607973'])('«%s» — QR клиента с подписью и кнопками', async text => {
    await bot.processUpdate(message(text));
    expect(rpc('wallet_spend')).toHaveLength(1);
    const photo = photos().at(-1)!;
    expect(photo.body.caption).toContain('QR клиента 191607973');
    expect(photo.body.caption).toContain('Действует сегодня');
    expect(photo.body.caption).toContain('Списано 50 ₽ · на балансе 70 ₽.');
    expect(buttons(photo).map(button => button.callback_data)).toEqual(['code:find', 'menu:home']);
  });

  it('«код» без цифр — экран «Код клиента» с подсказкой, ничего не списано', async () => {
    await bot.processUpdate(message('код'));
    expect(lastScreen().body.text).toContain('Не понял номер клиента');
    expect(lastScreen().body.text).toContain('🔑 Код клиента');
    expect(charged()).toBe(0);
  });

  it('«код 245» — не ID: подсказка с поиском, ничего не списано', async () => {
    await bot.processUpdate(message('код 245'));
    expect(lastScreen().body.text).toContain('Похоже, это не ID клиента');
    expect(buttons()[0].callback_data).toBe('code:find');
    expect(charged()).toBe(0);
  });

  it('во время входа в WB «код 4821» — это SMS-код, а не платная команда', async () => {
    world.wb = { state: 'await_code', session: { deviceId: 'd1', phone: '79991234567' } };
    const confirm = vi.spyOn(wbPvz, 'confirmCode').mockRejectedValue(new Error('bad code'));
    await bot.processUpdate(message('код 4821'));
    expect(confirm).toHaveBeenCalledWith(expect.anything(), '4821');
    expect(charged()).toBe(0);
  });

  it('при вводе кода доступа «код 123456» уходит в код доступа', async () => {
    world.session = { telegram_user_id: TG, state: 'await_access_code', draft: { userId: USER }, updated_at: new Date().toISOString() };
    await bot.processUpdate(message('код 123456'));
    expect(charged()).toBe(0);
    expect(photos()).toHaveLength(0);
  });
});

describe('QR не отправился', () => {
  it('с баланса — деньги вернулись, текст по факту возврата и кнопка повтора', async () => {
    world.photoFails = true;
    await bot.processUpdate(message('Код 191607973'));
    expect(rpc('admin_wallet_adjust')).toHaveLength(1);
    expect(lastScreen().body.text).toContain('50 ₽ вернулись на баланс');
    expect(buttons()[0]).toMatchObject({ callback_data: 'code:qr:191607973' });
  });

  it('возврат не прошёл — честно и с кодом для поддержки', async () => {
    world.photoFails = true; world.refundFails = true;
    await bot.processUpdate(message('Код 191607973'));
    expect(lastScreen().body.text).toContain('вернуть их автоматически не получилось');
    expect(lastScreen().body.text).toMatch(/<code>[0-9a-f]{6}<\/code>/);
    expect(lastScreen().body.text).not.toContain('вернулись');
  });

  it('кодом из тарифа — «Отправить ещё раз» по тому же id списания, второй раз не списывает', async () => {
    world.ent = { codes_limit: 10, codes_used: 3, packs_left: 0 };
    world.codeOnce = QUOTA_CHARGE;
    world.photoFails = true;
    await bot.processUpdate(message('Код 191607973'));
    expect(lastScreen().body.text).toContain('Код уже списан — повторная отправка бесплатна.');
    const resend = buttons().find(button => String(button.callback_data).startsWith('code:re:'))!;
    expect(Buffer.byteLength(resend.callback_data)).toBeLessThanOrEqual(64);
    const firstRequest = rpc('app_code_once')[0].body.p_request;
    expect(resend.callback_data).toBe(`code:re:191607973:${firstRequest}`);
    world.photoFails = false;
    world.codeOnce = { ...QUOTA_CHARGE, replayed: true };
    await bot.processUpdate(press(resend.callback_data, 60));
    expect(rpc('app_code_once').at(-1)!.body.p_request).toBe(firstRequest);
    expect(photos().at(-1)!.body.caption).toContain('Повторная отправка — ничего не списано.');
    expect(rpc('wallet_spend')).toHaveLength(0);
  });
});

describe('поиск клиента', () => {
  const goods = [
    { buyer_sid: 191607973, cell: '245', buyer: { mobile: '79120008898', name: 'Иван' }, name: 'Футболка' },
    { buyer_sid: 555000111, cell: '17', buyer: { mobile: '79990001234' }, name: 'Кружка' },
  ];
  beforeEach(() => {
    world.wb = { state: 'ready', session: { token: 't', desktopToken: 'd', pointId: 12345 } };
    world.session = { telegram_user_id: TG, state: 'await_client_query', draft: { userId: USER }, updated_at: new Date().toISOString() };
    vi.spyOn(wbPvz, 'loadGoodsInPickPoint').mockResolvedValue({ goods, cursor: null });
  });

  it('по ячейке: кнопка «QR · яч. · …хвост · имя», ожидание продлено, ничего не списано', async () => {
    await bot.processUpdate(message('245'));
    const button = buttons().find(b => String(b.callback_data).startsWith('code:qr:'))!;
    expect(button).toEqual({ text: 'QR · яч. 245 · …98 · Иван', callback_data: 'code:qr:191607973:245' });
    expect(lastScreen().body.text).toContain('Спишется 50 ₽ с баланса');
    expect(lastScreen().body.text).not.toContain('ID <code>');
    const saved = db.filter(call => call.method === 'POST' && call.path.startsWith('telegram_generator_sessions'));
    expect(saved.at(-1)!.body.state).toBe('await_client_query');
    expect(charged()).toBe(0);
  });

  it('имя — только покупателя: название товара именем не становится', () => {
    const [second] = bot.findClientsByQuery(goods, '17');
    expect(second.name).toBe('');
  });

  it('по ID клиента и по полному номеру телефона (берём последние 4 цифры)', async () => {
    await bot.processUpdate(message('191607973'));
    expect(buttons()[0].callback_data).toBe('code:qr:191607973:245');
    await bot.processUpdate(message('+7 912 345-88-98'));
    expect(lastScreen().body.text).toContain('Ищу по последним 4 цифрам телефона: 8898.');
    expect(buttons()[0].callback_data).toBe('code:qr:191607973:245');
  });

  it('не нашёл — коротко, без рекламы программы', async () => {
    await bot.processUpdate(message('999'));
    const text = String(lastScreen().body.text);
    expect(text).toContain('По «999» никого не нашёл на ПВЗ 12345.');
    expect(text).not.toContain('Помощник');
  });

  it('кнопка QR из поиска: подпись с ячейкой, двойное нажатие не списывает дважды', async () => {
    let claimed = false;
    const base = (globalThis.fetch as any).getMockImplementation();
    (globalThis.fetch as any).mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (String(url).includes('telegram_generation_requests') && init.method === 'POST') {
        const first = !claimed; claimed = true;
        db.push({ method: 'POST', path: 'telegram_generation_requests', body: null });
        return json(first ? [{ request_id: 'x' }] : []);
      }
      return base(url, init);
    });
    await bot.processUpdate(press('code:qr:191607973:245', 61));
    await bot.processUpdate(press('code:qr:191607973:245', 61));
    expect(rpc('wallet_spend')).toHaveLength(1);
    expect(photos()[0].body.caption).toContain('QR клиента 191607973 · ячейка 245');
    const alert = sent.filter(call => call.method === 'answerCallbackQuery').at(-1)!;
    expect(alert.body).toMatchObject({ show_alert: true });
    expect(alert.body.text).toContain('уже выдан');
  });
});

describe('запросы QR с компьютеров', () => {
  it('«Выдать» с экрана «Код клиента» — выдано, этот экран перерисован', async () => {
    world.ent = { codes_limit: 10, codes_used: 3, packs_left: 0 };
    world.codeOnce = QUOTA_CHARGE;
    world.approval = pendingRow();
    await bot.processUpdate(press(`cq:ok:${APPROVAL}`, 50));
    expect(world.approval).toMatchObject({ status: 'approved' });
    const redraw = sent.filter(call => call.method === 'editMessageText' && call.body.message_id === 50).at(-1)!;
    expect(redraw.body.text).toContain('🔑 Код клиента');
    const owner = sent.find(call => call.method === 'editMessageText' && call.body.message_id === 77)!;
    expect(owner.body.text).toContain('списан 1 код из тарифа');
  });

  it('просроченный запрос: сообщение владельца само становится «истекло время», всплывашка — окном', async () => {
    world.approval = pendingRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
    await bot.processUpdate(press(`cq:ok:${APPROVAL}`, 77));
    const owner = sent.find(call => call.method === 'editMessageText' && call.body.message_id === 77)!;
    expect(owner.body.text).toContain('Не выдан — истекло время');
    const alert = sent.filter(call => call.method === 'answerCallbackQuery').at(-1)!;
    expect(alert.body).toMatchObject({ show_alert: true });
    expect(alert.body.text).toContain('прошло больше 10 минут');
  });

  it('кодов нет — экран оплаты там, где нажали: «❌ Отклонить», «Пополнить на N ₽ и выдать», «⬅️ Назад»', async () => {
    world.approval = pendingRow();
    world.balance = 1000;
    await bot.processUpdate(press(`cq:ok:${APPROVAL}`, 50));
    const screen = sent.filter(call => call.method === 'editMessageText' && call.body.message_id === 50).at(-1)!;
    expect(screen.body.text).toContain('Бесплатных кодов не осталось.');
    expect(screen.body.text).toContain('не хватает 40 ₽');
    const all = buttons(screen);
    expect(all.find(b => String(b.callback_data).startsWith('tp:'))!.text).toBe('💳 Пополнить на 40 ₽ и выдать');
    expect(all.find(b => b.callback_data === `cq:no:${APPROVAL}`)!.text).toBe('❌ Отклонить');
    expect(all.some(b => b.callback_data === 'menu:code')).toBe(true);
  });

  it('«⬅️ Назад» с оплаты ведёт к запросу (cq:view) и к подтверждению QR (code:ask), а не в меню', () => {
    expect(topupScreen.topupBackData(`cqa:${APPROVAL}`)).toBe(`cq:view:${APPROVAL}`);
    expect(topupScreen.topupBackData('qr:191607973')).toBe('code:ask:191607973');
  });

  it('пополнить и выдать — итог одним сообщением, кнопки под фото QR', async () => {
    world.approval = pendingRow();
    const started = await bot.afterWalletTopup({ id: 'o1', user_id: USER, gross_amount: 100, wallet_topup_kopecks: 10000, pricing_snapshot: { wallet: { then: `cqa:${APPROVAL}`, message: 50 } } }, 99);
    expect(started).toBe(true);
    expect(world.approval).toMatchObject({ status: 'approved' });
    const notice = sent.filter(call => call.method === 'editMessageText' && call.body.message_id === 99).at(-1)!;
    expect(notice.body.text).toContain('Баланс пополнен ✅');
    expect(notice.body.text).toContain('QR по запросу с компьютера выдан');
    const photo = photos().at(-1)!;
    expect(photo.body.caption).toContain('QR клиента 191607973 · ячейка 12');
    expect(buttons(photo).map(button => button.callback_data)).toEqual(['menu:code', 'menu:home']);
    // экран оплаты (не сообщение запроса) — без живой ссылки на оплату
    expect(sent.some(call => call.method === 'editMessageText' && call.body.message_id === 50 && call.body.text === 'Баланс пополнен — итог ниже ⬇️')).toBe(true);
  });
});

describe('что спишется (nextCodeCharge / chargeLine)', () => {
  it('квота показывает остаток после выдачи, нехватка — сколько не хватает', () => {
    expect(approvals.chargeLine({ kind: 'quota', left: 7, limit: 10 })).toBe('Спишется 1 код из тарифа — останется 6 из 10 на этот месяц.');
    expect(approvals.chargeLine({ kind: 'wallet', price: 50, balance: 12, club: false })).toBe('Стоит 50 ₽ с баланса, на балансе 12 ₽ — не хватает 38 ₽.');
    expect(approvals.chargeLabel({ kind: 'pack', left: 3 })).toBe('1 код');
  });
});
