import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Привязка из программы (/start link_<token>) без тупика, сообщение о связке от поддержки и Telegram ID в профиле.

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  processUpdate: (update: Record<string, unknown>) => Promise<void>;
  notifyAccountLinked: (telegramId: number) => Promise<{ delivered: boolean }>;
};
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };

const TG = 716976910;
const SITE = '0e1a5a6c-1111-2222-3333-444455556666';
const BOT = '9f9f9f9f-1111-2222-3333-444455556666';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv12';
const SUPPORT_URL = 'https://t.me/roma_denosov';
const from = { id: TG, first_name: 'Аня', username: 'pvz_anna' };
const start = (text: string, id = 1) => ({ update_id: id, message: { message_id: id, text, from, chat: { id: TG, type: 'private' } } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Call = { method: string; path: string; body: any };
type World = {
  existing: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  target: Record<string, unknown>;
  telegramFails?: boolean;
  rpcError?: { status: number; body: Record<string, unknown> };
};

let world: World;
let db: Call[];
let sent: Array<{ method: string; body: Record<string, any> }>;

beforeEach(() => {
  db = []; sent = [];
  userCache.clearTelegramUserCache();
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
  process.env.TELEGRAM_LOCAL_POLLING = '1';
  world = {
    existing: { user_id: BOT, username: 'pvz_anna', first_name: 'Аня' },
    current: null,
    summary: { technical: true, restricted: false, empty: true },
    target: { id: SITE, email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const address = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (!address.startsWith('https://db.test')) {
      sent.push({ method: address.split('/').pop() || '', body: body || {} });
      if (world.telegramFails) return json({ ok: false, description: 'Forbidden: bot was blocked by the user' }, 403);
      return json({ ok: true, result: { message_id: 77 } });
    }
    const path = decodeURIComponent(address.includes('/rest/v1/') ? address.split('/rest/v1/')[1] : `auth:${address.split('/auth/v1/')[1]}`);
    const method = String(init.method || 'GET').toUpperCase();
    db.push({ method, path, body });
    if (path.startsWith('auth:admin/users/')) {
      if (method === 'DELETE') return json({});
      return json(path.endsWith(SITE) ? world.target : { id: BOT, email: `telegram-${TG}@users.invalid` });
    }
    if (path.startsWith('app_telegram_link_tokens?token=eq.') && method === 'GET') {
      return json([{ token: TOKEN, user_id: SITE, expires_at: new Date(Date.now() + 600_000).toISOString(), used_at: null }]);
    }
    if (path === 'rpc/account_merge_summary') return world.summary ? json(world.summary) : json({ code: 'PGRST202', message: 'nope' }, 404);
    if (path === 'rpc/relink_telegram_identity') {
      return world.rpcError ? json(world.rpcError.body, world.rpcError.status) : json({ sourceUserId: BOT, deleteSource: true });
    }
    if (path.startsWith('user_telegram_identities?on_conflict')) return json([body]);
    if (path.startsWith('user_telegram_identities?telegram_user_id=eq.') && method === 'GET') {
      return json(world.existing ? [{ ...world.existing, telegram_user_id: TG }] : []);
    }
    if (path.startsWith(`user_telegram_identities?user_id=eq.${SITE}`) && method === 'GET') return json(world.current ? [world.current] : []);
    if (path.startsWith('wallet_accounts')) return json([{ balance_kopecks: 12000 }]);
    return json([]);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_LOCAL_POLLING;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

const texts = () => sent.filter(call => call.method === 'sendMessage' || call.method === 'editMessageText').map(call => String(call.body.text || ''));
const supportButton = () => sent.some(call => JSON.stringify(call.body.reply_markup || {}).includes(SUPPORT_URL));
const rpcCalled = () => db.some(call => call.path.startsWith('rpc/relink_telegram_identity'));

describe('/start link_ из программы', () => {
  it('пустой профиль бота — перепривязка через RPC, пустой аккаунт удаляется, без слов про сайт', async () => {
    await bot.processUpdate(start(`/start link_${TOKEN}`));
    expect(db.find(call => call.path === 'rpc/relink_telegram_identity')!.body).toEqual({ p_telegram_user_id: TG, p_target_user_id: SITE });
    expect(db.some(call => call.method === 'DELETE' && call.path === `auth:admin/users/${BOT}`)).toBe(true);
    const all = texts().join('\n');
    expect(all).toContain('Telegram подключён к аккаунту «Помощника ПВЗ»');
    expect(all).toContain('Баланс и покупки в боте и в программе теперь общие');
    expect(all).not.toMatch(/входить на сайт|кабинет/);
    // токен погашен
    expect(db.some(call => call.method === 'PATCH' && call.path.startsWith('app_telegram_link_tokens'))).toBe(true);
  });

  it('у профиля бота баланс или покупки — в поддержку, ничего не меняем', async () => {
    world.summary = { technical: true, restricted: false, empty: false, walletKopecks: 5000 };
    await bot.processUpdate(start(`/start link_${TOKEN}`));
    expect(rpcCalled()).toBe(false);
    expect(db.some(call => call.method === 'POST' && call.path.startsWith('user_telegram_identities?on_conflict'))).toBe(false);
    const all = texts().join('\n');
    expect(all).toContain('У этого Telegram уже есть профиль с балансом или покупками. Напишите в поддержку — объединим, ничего не потеряется.');
    expect(all).toContain(`<code>${TG}</code>`);
    expect(all).not.toMatch(/кабинет|на сайте/);
    expect(supportButton()).toBe(true);
  });

  it('Telegram привязан к аккаунту с почтой — в поддержку', async () => {
    world.summary = { technical: false, restricted: false, empty: false };
    await bot.processUpdate(start(`/start link_${TOKEN}`));
    expect(rpcCalled()).toBe(false);
    expect(texts().join('\n')).toContain('Этот Telegram уже привязан к другому аккаунту. Напишите в поддержку');
    expect(supportButton()).toBe(true);
  });

  it('сводки нет (миграция не применена) или аккаунт ограничен — не удаляем, в поддержку', async () => {
    world.summary = null;
    await bot.processUpdate(start(`/start link_${TOKEN}`));
    expect(rpcCalled()).toBe(false);
    expect(db.some(call => call.method === 'DELETE' && call.path.startsWith('auth:'))).toBe(false);
    expect(texts().join('\n')).toContain('Подключить этот Telegram автоматически не получилось');

    sent = []; db = [];
    world.summary = { technical: true, restricted: true, empty: true };
    await bot.processUpdate(start(`/start link_${TOKEN}`, 2));
    expect(rpcCalled()).toBe(false);
    expect(supportButton()).toBe(true);
  });

  it('у аккаунта программы нет подтверждённой почты — не трогаем его прежний Telegram', async () => {
    world.target = { id: SITE, email: 'telegram-1@users.invalid', email_confirmed_at: '2026-01-01T00:00:00Z' };
    await bot.processUpdate(start(`/start link_${TOKEN}`));
    expect(rpcCalled()).toBe(false);
    expect(db.some(call => call.method === 'DELETE' && call.path.startsWith('user_telegram_identities'))).toBe(false);
    expect(supportButton()).toBe(true);
  });

  it('новый Telegram без профиля — просто привязка', async () => {
    world.existing = null;
    await bot.processUpdate(start(`/start link_${TOKEN}`));
    expect(rpcCalled()).toBe(false);
    const save = db.find(call => call.method === 'POST' && call.path.startsWith('user_telegram_identities?on_conflict'))!;
    expect(save.body).toMatchObject({ user_id: SITE, telegram_user_id: TG });
  });

  it('вопрос о замене говорит, что прежний Telegram перестанет видеть баланс и покупки', async () => {
    world.current = { telegram_user_id: 111222333, username: 'old_tg' };
    await bot.processUpdate(start(`/start link_${TOKEN}`));
    const question = texts().join('\n');
    expect(question).toContain('@old_tg');
    expect(question).toContain('Прежний Telegram перестанет видеть баланс и покупки этого аккаунта');
    expect(question).not.toMatch(/вход на сайт/);
    expect(rpcCalled()).toBe(false);
  });
});

describe('переключение с прежнего Telegram', () => {
  const OLD = { user_id: SITE, telegram_user_id: 111222333, username: 'old_tg', first_name: 'Старый' };
  const confirm = () => ({
    update_id: 9, callback_query: { id: '9', data: `cq:link:yes:${TOKEN}`, from, message: { message_id: 90, chat: { id: TG, type: 'private' } } },
  });
  const restored = () => db.filter(call => call.method === 'POST' && call.path === 'user_telegram_identities');

  it('успех — прежний Telegram снят и не возвращается', async () => {
    world.current = OLD;
    await bot.processUpdate(confirm());
    expect(db.some(call => call.method === 'DELETE' && call.path.startsWith(`user_telegram_identities?user_id=eq.${SITE}&telegram_user_id=neq.${TG}`))).toBe(true);
    expect(rpcCalled()).toBe(true);
    expect(restored()).toHaveLength(0);
    expect(texts().join('\n')).toContain('Telegram подключён к аккаунту «Помощника ПВЗ»');
  });

  it('RPC отказал (на профиль пришли деньги) — прежний Telegram возвращается, человек идёт в поддержку', async () => {
    world.current = OLD;
    world.rpcError = { status: 400, body: { code: 'P0001', message: 'TELEGRAM_ACCOUNT_NOT_EMPTY' } };
    await bot.processUpdate(confirm());
    expect(restored()).toHaveLength(1);
    expect(restored()[0].body).toMatchObject({ user_id: SITE, telegram_user_id: 111222333, username: 'old_tg' });
    expect(supportButton()).toBe(true);
    expect(texts().join('\n')).not.toContain('Telegram подключён');
  });

  it('сбой сети на RPC — прежний Telegram тоже возвращается', async () => {
    world.current = OLD;
    world.rpcError = { status: 503, body: {} };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await bot.processUpdate(confirm());
    expect(restored()).toHaveLength(1);
    expect(texts().join('\n')).not.toContain('Telegram подключён');
  });
});

describe('notifyAccountLinked', () => {
  it('сбрасывает черновик и пишет человеку, что баланс и покупки общие', async () => {
    await expect(bot.notifyAccountLinked(TG)).resolves.toEqual({ delivered: true });
    expect(db.some(call => call.method === 'DELETE' && call.path.startsWith(`telegram_generator_sessions?telegram_user_id=eq.${TG}`))).toBe(true);
    expect(texts().join('\n')).toContain('бот связан с вашим аккаунтом на сайте. Баланс, покупки и подписки теперь общие');
  });

  it('бот заблокирован — delivered:false, не бросает', async () => {
    world.telegramFails = true;
    await expect(bot.notifyAccountLinked(TG)).resolves.toEqual({ delivered: false });
  });
});

describe('профиль', () => {
  it('показывает Telegram ID для поддержки', async () => {
    await bot.processUpdate({ update_id: 5, callback_query: { id: '5', data: 'menu:profile', from, message: { message_id: 50, chat: { id: TG, type: 'private' } } } });
    expect(texts().join('\n')).toContain(`Ваш ID: <code>${TG}</code> — назовите его поддержке.`);
  });
});
