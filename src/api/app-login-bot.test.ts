import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Вход в «Помощник ПВЗ» и «ПВЗ Принт» подтверждением в боте (/start login_<КОД>, кнопки lg:ok / lg:no)
// и «🚫 Это не я» под сообщением о новом компьютере (dv:no:<id ПК>).

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  processUpdate: (update: Record<string, unknown>) => Promise<void>;
  newUserSource: (text: string) => { source: string };
};
const account = require('../../server/_app-account.js') as {
  notifyNewDevice: (userId: string, name: string, deviceId: string) => Promise<void>;
  registerDevice: (userId: string, deviceHash: string, name: string, version: string) => Promise<string>;
};
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };
const controls = require('../../server/_user-controls.js') as { __setSnapshotForTests: (json: unknown) => void };

const TG = 716976910;
const USER = '9f9f9f9f-1111-4222-8333-444455556666';
const DEVICE_ID = '12345678-aaaa-4bbb-8ccc-1234567890ab';
const CODE = 'ABCD2345';
const HASH = 'c'.repeat(64);
const from = { id: TG, first_name: 'Аня', username: 'pvz_anna' };
const chat = { id: TG, type: 'private' };
const start = (text: string, id = 1) => ({ update_id: id, message: { message_id: id, text, from, chat } });
const press = (data: string, id = 10) => ({ update_id: id, callback_query: { id: String(id), data, from, message: { message_id: 50, chat } } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Call = { method: string; path: string; body: any };
type World = {
  login: Record<string, unknown> | null;
  approvePatch: unknown[];
  rateAllowed: boolean;
  devices: Array<Record<string, unknown>>;
  /** Строка ПК по device_hash для registerDevice: null — ПК в профиле нет. */
  byHash: Record<string, unknown> | null;
};

let world: World;
let db: Call[];
let sent: Array<{ method: string; body: Record<string, any> }>;

beforeEach(() => {
  db = []; sent = [];
  userCache.clearTelegramUserCache();
  controls.__setSnapshotForTests(null);
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
  process.env.TELEGRAM_LOCAL_POLLING = '1';
  world = {
    login: { code: CODE, status: 'pending', device_name: 'Касса <1>', app_version: '1.12.0', created_at: new Date(Date.now() - 3 * 60_000).toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() },
    approvePatch: [{ code: CODE, status: 'approved' }],
    rateAllowed: true,
    devices: [{ id: DEVICE_ID, name: 'Чужой ноутбук', revoked_at: null }],
    byHash: null,
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const address = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (!address.startsWith('https://db.test')) {
      sent.push({ method: address.split('/').pop() || '', body: body || {} });
      return json({ ok: true, result: { message_id: 77 } });
    }
    const path = decodeURIComponent(address.includes('/rest/v1/') ? address.split('/rest/v1/')[1] : `auth:${address.split('/auth/v1/')[1]}`);
    const method = String(init.method || 'GET').toUpperCase();
    db.push({ method, path, body });
    if (path === 'rpc/consume_api_rate_limit') return json(world.rateAllowed);
    if (path.startsWith('user_telegram_identities?telegram_user_id=eq.')) return json([{ user_id: USER, telegram_user_id: TG }]);
    if (path.startsWith('user_telegram_identities?user_id=eq.')) return json([{ telegram_user_id: TG, username: 'pvz_anna' }]);
    if (path.startsWith('app_login_requests?code=eq.')) {
      if (method === 'PATCH') return json(world.approvePatch);
      return json(world.login ? [world.login] : []);
    }
    if (path.startsWith('app_devices?user_id=eq.') && path.includes('device_hash=eq.') && method === 'GET') return json(world.byHash ? [world.byHash] : []);
    if (path === 'rpc/app_register_device') return json(DEVICE_ID);
    if (path.startsWith('app_devices?id=eq.') && method === 'GET') return json(world.devices);
    if (path.startsWith('app_devices?id=eq.') && method === 'PATCH') return json(world.devices.map(row => ({ ...row, revoked_at: body.revoked_at })));
    if (path.startsWith('auth:admin/users/')) return json({ id: USER, email: `telegram-${TG}@users.invalid`, email_confirmed_at: '2026-01-01T00:00:00Z' });
    if (path === 'auth:admin/generate_link') return json({ properties: { hashed_token: 'hash' } });
    if (path === 'auth:verify') return json({ access_token: 'user-access' });
    if (path.startsWith('auth:logout')) return new Response(null, { status: 204 });
    return json([]);
  }));
});

afterEach(() => {
  controls.__setSnapshotForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_LOCAL_POLLING;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

const texts = () => sent.filter(call => call.method === 'sendMessage' || call.method === 'editMessageText').map(call => String(call.body.text || ''));
const buttons = () => sent.flatMap(call => (call.body.reply_markup?.inline_keyboard || []).flat()) as Array<{ text: string; callback_data?: string; url?: string }>;
const approved = () => db.filter(call => call.method === 'PATCH' && call.path.startsWith('app_login_requests'));

describe('/start login_<КОД>', () => {
  it('показывает экран подтверждения и сам ничего не подтверждает', async () => {
    await bot.processUpdate(start(`/start login_${CODE}`));
    const screen = texts().join('\n');
    expect(screen).toContain('Вход в «Помощник ПВЗ»');
    expect(screen).toContain('Компьютер: «Касса &lt;1&gt;» · запрошен 3 мин назад');
    expect(screen).toContain('<code>ABCD-2345</code>');
    expect(screen).toContain('Подтверждайте, только если вы сами сейчас нажали «Войти» в программе');
    expect(buttons().map(b => b.callback_data)).toEqual([`lg:ok:${CODE}`, `lg:no:${CODE}`]);
    expect(approved()).toHaveLength(0);
  });

  it('ПВЗ Принт — своё название и что потеряется', async () => {
    world.login = { ...world.login, app_version: 'cell-print/2.2.0' };
    await bot.processUpdate(start(`/start login_${CODE}`));
    const screen = texts().join('\n');
    expect(screen).toContain('Вход в «ПВЗ Принт»');
    expect(screen).toContain('ваш профиль, баланс и ключи');
  });

  it('просроченный или неизвестный код — «код устарел», без кнопок подтверждения', async () => {
    world.login = { ...world.login, expires_at: new Date(Date.now() - 1000).toISOString() };
    await bot.processUpdate(start(`/start login_${CODE}`));
    expect(texts().join('\n')).toContain('Код входа устарел. Начните вход в программе ещё раз.');
    expect(buttons().some(b => String(b.callback_data).startsWith('lg:'))).toBe(false);

    sent = []; world.login = null;
    await bot.processUpdate(start(`/start login_${CODE}`, 2));
    expect(texts().join('\n')).toContain('Код входа устарел');
  });

  it('уже подтверждённый код — «уже использован» и кнопка поддержки', async () => {
    world.login = { ...world.login, status: 'approved' };
    await bot.processUpdate(start(`/start login_${CODE}`));
    expect(texts().join('\n')).toContain('Этот код входа уже использован');
    expect(buttons().some(b => b.url === 'https://t.me/roma_denosov')).toBe(true);
  });

  it('лимит 10 попыток в час на Telegram ID', async () => {
    world.rateAllowed = false;
    await bot.processUpdate(start(`/start login_${CODE}`));
    expect(texts().join('\n')).toContain('Слишком много попыток входа. Попробуйте через час.');
    const limit = db.find(call => call.path === 'rpc/consume_api_rate_limit')!;
    expect(limit.body).toMatchObject({ p_scope: 'bot-app-login', p_limit: 10, p_window_seconds: 3600 });
    // запрос входа даже не читаем
    expect(db.some(call => call.path.startsWith('app_login_requests'))).toBe(false);
  });

  it('ограничение «Программа» закрывает вход в Помощник уже на экране, но не в ПВЗ Принт', async () => {
    controls.__setSnapshotForTests({ unlimited: [], restrictions: [{ id: 'r1', user_id: USER, telegram_user_id: TG, scopes: ['app'], until: '2099-01-01T00:00:00.000Z', public_message: null }] });
    await bot.processUpdate(start(`/start login_${CODE}`));
    expect(texts().join('\n')).toContain('Вход в «Помощник ПВЗ» для вашего профиля закрыт');
    expect(buttons().some(b => String(b.callback_data).startsWith('lg:'))).toBe(false);

    sent = [];
    world.login = { ...world.login, app_version: 'cell-print/2.2.0' };
    await bot.processUpdate(start(`/start login_${CODE}`, 2));
    expect(buttons().map(b => b.callback_data)).toContain(`lg:ok:${CODE}`);
  });
});

describe('кнопки lg:ok / lg:no', () => {
  it('lg:ok записывает user_id этого Telegram и говорит вернуться в программу', async () => {
    await bot.processUpdate(press(`lg:ok:${CODE}`));
    expect(approved()).toHaveLength(1);
    expect(approved()[0].body).toEqual({ user_id: USER, status: 'approved' });
    expect(approved()[0].path).toContain('status=eq.pending');
    expect(texts().join('\n')).toContain('✅ Вход подтверждён. Вернитесь в программу — она войдёт сама.');
  });

  it('повторное подтверждение (строку уже забрали) — ALREADY_USED, без ложного успеха', async () => {
    world.approvePatch = [];
    await bot.processUpdate(press(`lg:ok:${CODE}`));
    const all = texts().join('\n');
    expect(all).toContain('Этот код входа уже использован');
    expect(all).not.toContain('Вход подтверждён');
  });

  it('просроченный код на кнопке — «код устарел»', async () => {
    world.login = { ...world.login, expires_at: new Date(Date.now() - 1000).toISOString() };
    await bot.processUpdate(press(`lg:ok:${CODE}`));
    expect(approved()).toHaveLength(0);
    expect(texts().join('\n')).toContain('Код входа устарел');
  });

  it('ограничение проверяется и на кнопке: «Программа» против Помощника — отказ, ПВЗ Принт — проходит', async () => {
    controls.__setSnapshotForTests({ unlimited: [], restrictions: [{ id: 'r1', user_id: USER, telegram_user_id: TG, scopes: ['app'], until: '2099-01-01T00:00:00.000Z', public_message: null }] });
    await bot.processUpdate(press(`lg:ok:${CODE}`));
    expect(approved()).toHaveLength(0);
    expect(texts().join('\n')).toContain('для вашего профиля закрыт');

    sent = [];
    world.login = { ...world.login, app_version: 'cell-print/2.2.0' };
    await bot.processUpdate(press(`lg:ok:${CODE}`, 11));
    expect(approved()).toHaveLength(1);
    expect(texts().join('\n')).toContain('Вход подтверждён');
  });

  it('lg:no — ничего не пишет в базу', async () => {
    await bot.processUpdate(press(`lg:no:${CODE}`));
    expect(db.some(call => call.method !== 'GET' && call.path.startsWith('app_login_requests'))).toBe(false);
    expect(texts().join('\n')).toContain('Вход отменён');
  });

  it('кнопки укладываются в 64 байта callback_data', () => {
    expect(Buffer.byteLength(`lg:ok:${CODE}`)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(`dv:no:${DEVICE_ID}`)).toBeLessThanOrEqual(64);
  });
});

describe('«🚫 Это не я» под сообщением о новом компьютере', () => {
  it('сообщение о новом ПК уходит в Telegram с кнопкой dv:no:<id>', async () => {
    await account.notifyNewDevice(USER, 'Чужой ноутбук', DEVICE_ID);
    const message = sent.find(call => call.method === 'sendMessage')!;
    expect(message.body.chat_id).toBe(TG);
    expect(String(message.body.text)).toContain('Компьютер «Чужой ноутбук» вошёл в ваш профиль');
    expect(buttons().map(b => b.callback_data)).toContain(`dv:no:${DEVICE_ID}`);
  });

  it('отключает ПК своего профиля и завершает все сеансы', async () => {
    await bot.processUpdate(press(`dv:no:${DEVICE_ID}`));
    const lookup = db.find(call => call.method === 'GET' && call.path.startsWith('app_devices?id=eq.'))!;
    expect(lookup.path).toContain(`user_id=eq.${USER}`);
    const revoke = db.find(call => call.method === 'PATCH' && call.path.startsWith('app_devices?id=eq.'))!;
    expect(revoke.path).toContain(`user_id=eq.${USER}`);
    expect(revoke.body).toHaveProperty('revoked_at');
    expect(db.some(call => call.path === 'auth:logout?scope=global')).toBe(true);
    const all = texts().join('\n');
    expect(all).toContain('Компьютер «Чужой ноутбук» отключён');
    expect(all).toContain('Все входы в ваш профиль завершены');
  });

  it('отключённый ПК вернулся — снова сообщение с «Это не я», название прежнее', async () => {
    world.byHash = { id: DEVICE_ID, name: 'Чужой ноутбук', revoked_at: '2026-11-10T10:00:00Z' };
    await account.registerDevice(USER, HASH, 'DESKTOP-NEW', '1.12.0');
    const register = db.find(call => call.path === 'rpc/app_register_device')!;
    expect(register.body).toMatchObject({ p_name: '' });
    const message = sent.find(call => call.method === 'sendMessage')!;
    expect(String(message.body.text)).toContain('Компьютер «Чужой ноутбук» вошёл в ваш профиль');
    expect(buttons().map(b => b.callback_data)).toContain(`dv:no:${DEVICE_ID}`);
  });

  it('активный ПК при повторном входе — без сообщения', async () => {
    world.byHash = { id: DEVICE_ID, name: 'Касса', revoked_at: null };
    await account.registerDevice(USER, HASH, 'DESKTOP-NEW', '1.12.0');
    expect(db.some(call => call.path === 'rpc/app_register_device')).toBe(true);
    expect(sent.some(call => call.method === 'sendMessage')).toBe(false);
  });

  it('новый ПК — сообщение с его названием', async () => {
    await account.registerDevice(USER, HASH, 'DESKTOP-NEW', '1.12.0');
    expect(db.find(call => call.path === 'rpc/app_register_device')!.body).toMatchObject({ p_name: 'DESKTOP-NEW' });
    expect(texts().join('\n')).toContain('Компьютер «DESKTOP-NEW» вошёл в ваш профиль');
  });

  it('чужой или несуществующий ПК — ничего не отключаем', async () => {
    world.devices = [];
    await bot.processUpdate(press(`dv:no:${DEVICE_ID}`));
    expect(db.some(call => call.method === 'PATCH' && call.path.startsWith('app_devices'))).toBe(false);
    expect(db.some(call => call.path.startsWith('auth:logout'))).toBe(false);
    expect(texts().join('\n')).toContain('Этого компьютера нет в вашем профиле');
  });
});

describe('уведомление админу о новичке', () => {
  it('не раскрывает одноразовые токены входа и привязки', () => {
    expect(bot.newUserSource(`/start login_${CODE}`).source).not.toContain(CODE);
    expect(bot.newUserSource('/start link_AbCdEfGhIjKlMnOpQrStUv12').source).not.toContain('AbCdEfGh');
  });
});
