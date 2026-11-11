import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Админка «Связать с Telegram» (server/_admin-link.js): предпросмотр, все исходы, отказы, журнал, кеши бота.
// fetch подменён: PostgREST и GoTrue отвечают по маршрутам ниже, сами модули настоящие.

const require = createRequire(import.meta.url);

type Call = { method: string; path: string; body: any };
type Reply = { __reply: true; status: number; data: unknown };
type Res = { statusCode: number; body: any; status: (c: number) => Res; json: (b: unknown) => Res; setHeader: () => void; end: () => Res };

const SITE = '0e1a5a6c-1111-2222-3333-444455556666';
const BOT = '9f9f9f9f-1111-2222-3333-444455556666';
const OTHER = '7a7a7a7a-1111-2222-3333-444455556666';
const TG = 716976910;
const KEY = '5b3c1f9e-aaaa-4bbb-8ccc-0123456789ab';

const reply = (status: number, data: unknown = {}): Reply => ({ __reply: true, status, data });

const users: Record<string, Record<string, unknown>> = {
  [SITE]: { id: SITE, email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
  [BOT]: { id: BOT, email: `telegram-${TG}@users.invalid`, email_confirmed_at: '2026-02-01T00:00:00Z' },
  [OTHER]: { id: OTHER, email: 'other@example.com', email_confirmed_at: '2026-03-01T00:00:00Z' },
};

const EMPTY = { technical: true, restricted: false, empty: true, walletKopecks: 0, points: 0, docs: 0, partner: false, generationReserved: 0 };
const SITE_SUMMARY = { technical: false, restricted: false, empty: false, walletKopecks: 0, points: 1, docs: 0, partner: false, generationReserved: 0 };

type World = {
  sourceIdentity: Record<string, unknown> | null;
  targetIdentity: Record<string, unknown> | null;
  subscriber: Record<string, unknown> | null;
  summaries: Record<string, unknown>;
  rpc?: (call: Call) => unknown;
  nickRows?: Array<Record<string, unknown>>;
};

let world: World;
let calls: Call[];

function backend() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const raw = String(url);
    const path = raw.includes('/rest/v1/') ? raw.split('/rest/v1/')[1] : raw.includes('/auth/v1/') ? `auth:${raw.split('/auth/v1/')[1]}` : raw;
    const call: Call = { method: String(init.method || 'GET').toUpperCase(), path: decodeURIComponent(path), body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const out = route(call);
    const r = out && typeof out === 'object' && (out as Reply).__reply ? (out as Reply) : reply(200, out ?? []);
    return { ok: r.status < 400, status: r.status, headers: new Map(), text: async () => JSON.stringify(r.data), json: async () => r.data } as unknown as Response;
  }));
}

function route(call: Call): unknown {
  const { method, path, body } = call;
  if (path.startsWith('auth:admin/users/')) {
    const id = path.slice('auth:admin/users/'.length);
    if (method === 'DELETE') return {};
    return users[id] ? users[id] : reply(404, { msg: 'User not found' });
  }
  if (path === 'admin_actions' && method === 'POST') return [{ id: 77 }];
  if (path.startsWith('admin_actions?id=eq.77') && method === 'PATCH') return [];
  if (path === 'rpc/account_merge_summary') {
    // функции нет (миграция не применена) — PostgREST отвечает 404 PGRST202
    return body.p_user in world.summaries ? world.summaries[body.p_user] : reply(404, { code: 'PGRST202', message: 'not found' });
  }
  if (path === 'rpc/consume_auth_rate_limit') return false;
  if (path.startsWith('telegram_bot_subscribers?username=ilike.')) return world.nickRows ?? [];
  if (path === 'rpc/auth_user_id_by_email') return body.p_email === 'owner@example.com' ? SITE : null;
  if (path.startsWith('rpc/relink_telegram_identity') || path.startsWith('rpc/merge_telegram_account')) return world.rpc ? world.rpc(call) : {};
  if (path.startsWith('telegram_bot_subscribers')) return world.subscriber ? [world.subscriber] : [];
  if (path.startsWith('user_telegram_identities?on_conflict')) return [body];
  if (path.startsWith('user_telegram_identities?user_id=eq.')) {
    if (path.includes(BOT)) return world.sourceIdentity ? [world.sourceIdentity] : [];
    return world.targetIdentity ? [world.targetIdentity] : [];
  }
  if (path.startsWith('user_telegram_identities?telegram_user_id=eq.')) return world.sourceIdentity ? [world.sourceIdentity] : [];
  if (path.startsWith('user_telegram_identities?username=ilike.')) return [];
  return [];
}

function mockRes(): Res {
  const res = {
    statusCode: 200, body: undefined as any,
    status(code: number) { res.statusCode = code; return res; },
    json(b: unknown) { res.body = b; return res; },
    setHeader() {},
    end() { return res; },
  };
  return res;
}

const usersHandler = require('../../server/_admin-users.js') as (req: unknown, res: Res) => Promise<unknown>;
const link = require('../../server/_admin-link.js') as {
  rpcRefusal: (error: unknown) => (Error & { status: number; code: string }) | null;
};
const botRpc = require('../../server/_bot-rpc.js') as { callBot: (...args: unknown[]) => Promise<unknown>; ALLOWED: Set<string> };
let callBot: ReturnType<typeof vi.fn>;

function preview(cardUserId: string, query: string) {
  const res = mockRes();
  return usersHandler({ method: 'GET', query: { action: 'linkTelegramPreview', userId: cardUserId, query }, body: undefined, headers: {} }, res).then(() => res);
}

function post(body: Record<string, unknown>) {
  const res = mockRes();
  return usersHandler({
    method: 'POST', query: { action: 'linkTelegram' },
    body: { userId: SITE, telegramUserId: TG, reason: 'просьба в поддержку', idempotencyKey: KEY, ...body },
    headers: { 'user-agent': 'vitest', 'x-forwarded-for': '1.2.3.4' },
  }, res).then(() => res);
}

const journalFinish = () => calls.find(c => c.method === 'PATCH' && c.path.startsWith('admin_actions?id=eq.77'))?.body;

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  world = {
    sourceIdentity: { user_id: BOT, telegram_user_id: TG, username: 'pvz_anna', first_name: 'Аня' },
    targetIdentity: null,
    subscriber: { telegram_user_id: TG, username: 'pvz_anna', first_name: 'Аня', blocked_at: null },
    summaries: { [BOT]: EMPTY, [SITE]: SITE_SUMMARY },
  };
  backend();
  callBot = vi.spyOn(botRpc, 'callBot').mockImplementation(async (fn: unknown) => (fn === 'notifyAccountLinked' ? { delivered: true } : true)) as unknown as ReturnType<typeof vi.fn>;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('предпросмотр', () => {
  it('карточка сайта + Telegram ID: пустой технический аккаунт → перепривязка', async () => {
    const res = await preview(SITE, String(TG));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'relink', blockers: [], request: { userId: SITE, telegramUserId: TG } });
    expect(res.body.telegram).toMatchObject({ telegramUserId: TG, username: 'pvz_anna', botStarted: true });
    expect(res.body.target).toMatchObject({ userId: SITE, email: 'owner@example.com', technical: false });
    expect(res.body.source).toMatchObject({ userId: BOT, technical: true, email: null });
  });

  it('карточка технического аккаунта + почта: ищет аккаунт сайта, Telegram берёт из карточки', async () => {
    const res = await preview(BOT, 'Owner@Example.com');
    expect(res.statusCode).toBe(200);
    expect(res.body.request).toEqual({ userId: SITE, telegramUserId: TG });
    expect(calls.find(c => c.path === 'rpc/auth_user_id_by_email')!.body).toEqual({ p_email: 'owner@example.com' });
  });

  it('карточка технического аккаунта не принимает Telegram ID, карточка сайта — почту', async () => {
    expect((await preview(BOT, String(TG))).statusCode).toBe(400);
    expect((await preview(SITE, 'owner@example.com')).statusCode).toBe(400);
    expect((await preview(SITE, 'ник с пробелом')).statusCode).toBe(400);
  });

  it('@ник ищется среди запускавших бота точным совпадением', async () => {
    world.sourceIdentity = null;
    // ilike с _ находит и похожие — лишний отсекается
    world.nickRows = [{ telegram_user_id: 1, username: 'pvzXanna' }, { telegram_user_id: TG, username: 'PVZ_anna' }];
    const res = await preview(SITE, '@pvz_anna');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'new_identity', request: { telegramUserId: TG } });
  });

  it('неизвестный @ник — 404 с подсказкой спросить ID', async () => {
    const res = await preview(SITE, '@nobody_here');
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/Telegram ID/);
  });

  it('технический аккаунт с данными → объединение, в предупреждениях — что перейдёт', async () => {
    world.summaries[BOT] = { ...EMPTY, empty: false, walletKopecks: 51750, activeSubscriptions: 1, paidOrders: 2 };
    const res = await preview(SITE, String(TG));
    expect(res.body.outcome).toBe('merge');
    expect(res.body.blockers).toEqual([]);
    expect(res.body.warnings.join(' ')).toMatch(/баланс 517,5 ₽/);
    expect(res.body.warnings.join(' ')).toMatch(/подписка/);
  });

  it('облачные данные «Помощника» у аккаунта бота — отказ MERGE_CLOUD_DATA ещё в предпросмотре', async () => {
    world.summaries[BOT] = { ...EMPTY, empty: false, points: 1 };
    const res = await preview(SITE, String(TG));
    expect(res.body.outcome).toBe('merge');
    expect(res.body.blockers.map((b: { code: string }) => b.code)).toContain('MERGE_CLOUD_DATA');
  });

  it('Telegram у аккаунта с почтой → перенос только привязки, нужно отдельное подтверждение', async () => {
    world.sourceIdentity = { user_id: OTHER, telegram_user_id: TG, username: 'pvz_anna' };
    world.summaries[OTHER] = { ...SITE_SUMMARY, technical: false };
    const res = await preview(SITE, String(TG));
    expect(res.body).toMatchObject({ outcome: 'move_identity', needsMoveConfirm: true, blockers: [] });
    expect(res.body.warnings.join(' ')).toContain('other@example.com');
  });

  it('отказы: другой Telegram у аккаунта сайта, ограничение аккаунта бота, нет сводки, уже связаны', async () => {
    world.targetIdentity = { telegram_user_id: 111222333, username: 'old_tg' };
    world.summaries[BOT] = { ...EMPTY, restricted: true };
    let res = await preview(SITE, String(TG));
    expect(res.body.blockers.map((b: { code: string }) => b.code)).toEqual(['TARGET_HAS_TELEGRAM', 'SOURCE_RESTRICTED']);
    expect(res.body.blockers[0].message).toContain('@old_tg');

    world.targetIdentity = null;
    delete world.summaries[BOT];
    res = await preview(SITE, String(TG));
    expect(res.body.blockers.map((b: { code: string }) => b.code)).toEqual(['MIGRATION_MISSING']);

    world.sourceIdentity = { user_id: SITE, telegram_user_id: TG };
    res = await preview(SITE, String(TG));
    expect(res.body).toMatchObject({ outcome: 'already_linked' });
    expect(res.body.blockers[0].code).toBe('ALREADY_LINKED');
  });

  it('новый Telegram, который не запускал бота, — отказ (защита от опечатки в ID)', async () => {
    world.sourceIdentity = null;
    world.subscriber = null;
    const res = await preview(SITE, '123456789');
    expect(res.body).toMatchObject({ outcome: 'new_identity' });
    expect(res.body.blockers.map((b: { code: string }) => b.code)).toEqual(['NOT_STARTED']);
  });
});

describe('связка', () => {
  it('перепривязка: RPC, удаление пустого аккаунта, кеши бота, сообщение, журнал с предпросмотром', async () => {
    world.rpc = () => ({ sourceUserId: BOT, deleteSource: true });
    const res = await post({ expected: 'relink' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: 'relink', sourceUserId: BOT, sourceDeleted: true, delivered: true });
    expect(calls.find(c => c.path === 'rpc/relink_telegram_identity')!.body).toEqual({ p_telegram_user_id: TG, p_target_user_id: SITE });
    expect(calls.some(c => c.method === 'DELETE' && c.path === `auth:admin/users/${BOT}`)).toBe(true);
    const fns = callBot.mock.calls.map(args => args[0]);
    expect(fns).toEqual(['forgetTelegramUser', 'forgetSiteUser', 'forgetSiteUser', 'invalidateUserControls', 'notifyAccountLinked']);
    expect(callBot.mock.calls.filter(args => args[0] === 'forgetSiteUser').map(args => args[1])).toEqual([SITE, BOT]);
    expect(callBot).toHaveBeenLastCalledWith('notifyAccountLinked', TG);
    const begin = calls.find(c => c.method === 'POST' && c.path === 'admin_actions')!.body;
    expect(begin).toMatchObject({ action: 'linkTelegram', target_user_id: SITE, idempotency_key: `linkTelegram:${KEY}`, reason: 'просьба в поддержку' });
    const finish = journalFinish();
    expect(finish).toMatchObject({ result: 'ok' });
    expect(finish.before).toMatchObject({ outcome: 'relink', source: { userId: BOT } });
    expect(finish.after).toMatchObject({ telegramUserId: TG, linkedTo: SITE, rpc: { sourceUserId: BOT, deleteSource: true } });
  });

  it('объединение: суммы переноса в ответе', async () => {
    world.summaries[BOT] = { ...EMPTY, empty: false, walletKopecks: 51750 };
    world.rpc = () => ({ sourceUserId: BOT, deleteSource: true, movedWalletKopecks: 51750, movedSubscriptions: 1, movedDevices: 2 });
    // перед удалением исходного аккаунта свежая сводка — уже пустая
    let summaryCalls = 0;
    const base = world.summaries[BOT];
    Object.defineProperty(world.summaries, BOT, { configurable: true, enumerable: true, get: () => (++summaryCalls > 1 ? EMPTY : base) });
    const res = await post({ expected: 'merge' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'merge', moved: { walletKopecks: 51750, subscriptions: 1, devices: 2 }, sourceDeleted: true });
    expect(calls.some(c => c.path === 'rpc/merge_telegram_account')).toBe(true);
  });

  it('новая привязка: просто связка, без RPC', async () => {
    world.sourceIdentity = null;
    const res = await post({ expected: 'new_identity' });
    expect(res.statusCode).toBe(200);
    const save = calls.find(c => c.method === 'POST' && c.path.startsWith('user_telegram_identities?on_conflict'))!;
    expect(save.body).toMatchObject({ user_id: SITE, telegram_user_id: TG, username: 'pvz_anna' });
    expect(calls.some(c => c.path.startsWith('rpc/relink') || c.path.startsWith('rpc/merge'))).toBe(false);
  });

  it('перенос привязки с аккаунта с почтой — только с confirmMove', async () => {
    world.sourceIdentity = { user_id: OTHER, telegram_user_id: TG, username: 'pvz_anna' };
    world.summaries[OTHER] = { ...SITE_SUMMARY };
    world.rpc = () => ({ sourceUserId: OTHER, deleteSource: false });
    let res = await post({ expected: 'move_identity' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CONFIRM_REQUIRED');
    expect(calls.some(c => c.path.startsWith('rpc/relink'))).toBe(false);

    backend();
    res = await post({ expected: 'move_identity', confirmMove: true, idempotencyKey: `${KEY}-2` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'move_identity', sourceDeleted: false });
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it('исход изменился с предпросмотра — 409 OUTCOME_CHANGED, ничего не делаем', async () => {
    world.summaries[BOT] = { ...EMPTY, empty: false, walletKopecks: 100 };
    const res = await post({ expected: 'relink' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'OUTCOME_CHANGED', outcome: 'merge' });
    expect(calls.some(c => c.path.startsWith('rpc/relink') || c.path.startsWith('rpc/merge'))).toBe(false);
    expect(journalFinish()).toMatchObject({ result: 'error' });
    expect(callBot).not.toHaveBeenCalled();
  });

  it('отказ из предпросмотра повторяется на сервере', async () => {
    world.targetIdentity = { telegram_user_id: 111222333, username: 'old_tg' };
    const res = await post({ expected: 'relink' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TARGET_HAS_TELEGRAM');
  });

  it('отказ базы (MERGE_POINT_CONFLICT) — 409 с кодом, а не 502', async () => {
    world.summaries[BOT] = { ...EMPTY, empty: false, walletKopecks: 100 };
    world.rpc = () => reply(400, { code: 'P0001', message: 'MERGE_POINT_CONFLICT' });
    const res = await post({ expected: 'merge' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('MERGE_POINT_CONFLICT');
    expect(callBot).not.toHaveBeenCalled();
  });

  it('аккаунт бота не удалился (пришли деньги во время связки) — partial и предупреждение', async () => {
    world.rpc = () => ({ sourceUserId: BOT, deleteSource: true });
    let summaryCalls = 0;
    Object.defineProperty(world.summaries, BOT, { configurable: true, enumerable: true, get: () => (++summaryCalls > 1 ? { ...EMPTY, empty: false, walletKopecks: 500 } : EMPTY) });
    const res = await post({ expected: 'relink' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sourceKept: true, sourceDeleted: false });
    expect(res.body.warning).toMatch(/не удалён/);
    expect(journalFinish()).toMatchObject({ result: 'partial' });
  });

  it('сообщение не доставлено (бот заблокирован) — связано, delivered:false и предупреждение', async () => {
    world.rpc = () => ({ sourceUserId: BOT, deleteSource: true });
    callBot.mockImplementation(async (fn: unknown) => (fn === 'notifyAccountLinked' ? { delivered: false } : true));
    const res = await post({ expected: 'relink' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivered: false });
    expect(res.body.warning).toMatch(/не доставлено/);
  });

  it('проверка тела: Telegram ID, исход, причина, ключ повтора', async () => {
    expect((await post({ telegramUserId: 'abc', expected: 'relink' })).statusCode).toBe(400);
    expect((await post({ expected: 'whatever' })).statusCode).toBe(400);
    expect((await post({ expected: 'relink', reason: '  ' })).statusCode).toBe(400);
    expect((await post({ expected: 'relink', idempotencyKey: 'x' })).statusCode).toBe(400);
    expect(calls.some(c => c.path.startsWith('rpc/relink'))).toBe(false);
  });
});

describe('связанные части', () => {
  it('notifyAccountLinked разрешён в RPC узла бота', () => {
    expect(botRpc.ALLOWED.has('notifyAccountLinked')).toBe(true);
  });

  it('отказы RPC перепривязки переводятся в понятные коды', () => {
    expect(link.rpcRefusal(new Error('TELEGRAM_ACCOUNT_NOT_EMPTY: SOURCE_ACCOUNT_RESTRICTED'))!.code).toBe('SOURCE_RESTRICTED');
    expect(link.rpcRefusal(new Error('TELEGRAM_ACCOUNT_NOT_EMPTY'))!.code).toBe('OUTCOME_CHANGED');
    expect(link.rpcRefusal(new Error('TARGET_ACCOUNT_HAS_TELEGRAM'))!.code).toBe('TARGET_HAS_TELEGRAM');
    expect(link.rpcRefusal(new Error('TARGET_ACCOUNT_MUST_HAVE_EMAIL'))!.code).toBe('TARGET_NOT_CONFIRMED');
    expect(link.rpcRefusal(new Error('connection reset'))).toBeNull();
  });
});

describe('api/auth.js: связать аккаунт сайта с ботом — только через поддержку', () => {
  const auth = require('../../api/auth.js') as (req: unknown, res: Res) => Promise<unknown>;

  it.each(['merge', 'relink', 'prepare_merge'])('режим %s — 409 TELEGRAM_LINK_VIA_SUPPORT', async mode => {
    process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
    const res = mockRes();
    await auth({ method: 'POST', query: {}, headers: {}, socket: {}, body: { mode, webAppData: 'x' } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Связать аккаунт сайта с ботом может поддержка — напишите нам', code: 'TELEGRAM_LINK_VIA_SUPPORT' });
    expect(calls.some(c => c.path.startsWith('rpc/relink') || c.path.startsWith('rpc/merge'))).toBe(false);
    delete process.env.TELEGRAM_BOT_TOKEN;
  });
});
