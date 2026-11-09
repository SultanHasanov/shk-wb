import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Код клиента с подтверждением владельца в Telegram-боте (server/_code-approvals.js, api/app.js).
const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/app.js') as Handler;
const approvals = require('../../server/_code-approvals.js') as Record<string, any>;
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };
const flags = require('../../server/_app-flags.js') as Record<string, any>;

const DEVICE = 'a'.repeat(64);
const DEV_ID = '11111111-1111-4111-8111-111111111111';
const USER = 'u1';
const OWNER_TG = 439;
const APPROVAL = '33333333-3333-4333-8333-333333333333';

const env = {
  SUPABASE_URL: 'https://sb.test', SUPABASE_SECRET_KEY: 'k', SUPABASE_PUBLISHABLE_KEY: 'p',
  TELEGRAM_BOT_TOKEN: '1:' + 'a'.repeat(30), TELEGRAM_API_BASE: 'https://relay.test', STICKER_CLIENT_SECRET: 's'.repeat(32),
  PUBLIC_APP_URL: 'https://shk-wb.ru',
};

function response() {
  const res: { statusCode: number; body: unknown } & Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.end = () => res;
  res.setHeader = () => {};
  return res;
}

function request(action: string, { method = 'GET', body, headers = {}, query = {} }: { method?: string; body?: unknown; headers?: Record<string, string | undefined>; query?: Record<string, string> } = {}) {
  const h: Record<string, string> = { 'x-app-version': '1.11.0', 'x-device-id': DEVICE, authorization: 'Bearer t' };
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete h[k];
    else h[k] = v;
  }
  return { method, query: { action, ...query }, body, headers: h, socket: { remoteAddress: '127.0.0.1' } };
}

type Hit = { status?: number; body: unknown } | undefined;
type Route = (url: string, init: RequestInit & { method?: string }) => Hit;

const pendingRow = (extra: Record<string, unknown> = {}) => ({
  id: APPROVAL, user_id: USER, device_id: DEV_ID, sid: '191607973', cell: '12', point_wb: '123', status: 'pending',
  qr_text: null, billing: null, error: null, telegram_chat_id: OWNER_TG, telegram_message_id: 77,
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(), decided_at: null, ...extra,
});

/** Заглушка сети: Supabase (по URL), Telegram-релей, авторизация. calls — все вызовы для проверок. */
function mockNetwork(route: Route) {
  const calls: { url: string; method: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit & { method?: string } = {}) => {
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: String(init.method || 'GET'), body });
    if (url.includes('consume_api_rate_limit')) return new Response('true', { status: 200 });
    const hit = route(url, init)
      || (url.endsWith('/auth/v1/user') ? { body: { id: USER, email: 'a@b.c' } } : undefined)
      || (url.includes('app_devices?user_id=') ? { body: [{ id: DEV_ID, name: 'Ленина 5', last_seen_at: new Date().toISOString(), denied: [], point_wb: '123', role: 'work' }] } : undefined)
      || (url.includes('app_devices?id=') ? { body: [{ id: DEV_ID, name: 'Ленина 5', point_wb: '123', role: 'work' }] } : undefined)
      || (url.includes('site_settings?key=eq.app_code_via_bot') ? { body: [{ value: true }] } : undefined)
      || (url.includes('site_settings') ? { body: [] } : undefined)
      || (url.includes('rpc/app_entitlements') ? { body: { plan: 'pro', codes_limit: 10, codes_used: 3, packs_left: 0, device_limit: 4, addons: {} } } : undefined)
      || (url.includes('telegram_bot_subscribers') ? { body: [] } : undefined)
      || (url.includes('wallet_accounts') ? { body: [{ balance_kopecks: 1000 }] } : undefined)
      || (url.startsWith('https://relay.test/api/') ? { body: { ok: true, result: { message_id: 77 } } } : undefined)
      || { status: 404, body: { message: 'unexpected ' + url } };
    return new Response(JSON.stringify(hit.body), { status: hit.status || 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

beforeEach(() => {
  Object.assign(process.env, env);
  userCache.clearTelegramUserCache();
  flags.clearFlagCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('запрос QR с компьютера (createApproval)', () => {
  it('без Telegram у аккаунта — TELEGRAM_NOT_LINKED', async () => {
    mockNetwork(url => (url.includes('user_telegram_identities') ? { body: [] } : undefined));
    await expect(approvals.createApproval({ userId: USER, device: { id: DEV_ID }, sid: '1', cell: null })).rejects.toMatchObject({ code: 'TELEGRAM_NOT_LINKED' });
  });

  it('повторное нажатие возвращает уже открытый запрос, а не плодит сообщения', async () => {
    const calls = mockNetwork(url =>
      url.includes('user_telegram_identities') ? { body: [{ telegram_user_id: OWNER_TG, username: 'owner' }] }
      : url.includes('app_code_approvals?device_id=') ? { body: [pendingRow()] }
      : undefined);
    const out = await approvals.createApproval({ userId: USER, device: { id: DEV_ID }, sid: '191607973', cell: '12' });
    expect(out.reused).toBe(true);
    expect(out.row.id).toBe(APPROVAL);
    expect(out.owner).toEqual({ id: OWNER_TG, label: '@owner' });
    expect(calls.some(c => c.method === 'POST' && c.url.includes('app_code_approvals?select='))).toBe(false);
  });

  it('больше FLOOD_LIMIT запросов за окно — REQUEST_FLOOD', async () => {
    const many = Array.from({ length: approvals.FLOOD_LIMIT }, (_, i) => pendingRow({ id: `${i}`.padStart(8, '0') + APPROVAL.slice(8), status: 'declined' }));
    mockNetwork(url =>
      url.includes('user_telegram_identities') ? { body: [{ telegram_user_id: OWNER_TG }] }
      : url.includes('app_code_approvals?device_id=') ? { body: many }
      : undefined);
    await expect(approvals.createApproval({ userId: USER, device: { id: DEV_ID }, sid: '1', cell: null })).rejects.toMatchObject({ code: 'REQUEST_FLOOD' });
  });

  it('создаёт pending на 10 минут и шлёт владельцу сообщение с кнопками cq:ok / cq:no', async () => {
    const calls = mockNetwork((url, init) =>
      url.includes('user_telegram_identities') ? { body: [{ telegram_user_id: OWNER_TG, username: 'owner' }] }
      : url.includes('app_code_approvals?device_id=') ? { body: [] }
      : url.includes('app_code_approvals?user_id=') ? { body: [] }
      : url.includes('app_code_approvals?select=') && init.method === 'POST' ? { body: [pendingRow({ telegram_chat_id: null, telegram_message_id: null })] }
      : url.includes('app_code_approvals?id=') && init.method === 'PATCH' ? { body: [pendingRow()] }
      : undefined);
    const { row, owner } = await approvals.createApproval({ userId: USER, device: { id: DEV_ID, point_wb: '123' }, sid: '191607973', cell: '12' });
    const inserted = calls.find(c => c.method === 'POST' && c.url.includes('app_code_approvals?select='))!;
    expect(inserted.body.status).toBe('pending');
    expect(Date.parse(inserted.body.expires_at) - Date.now()).toBeGreaterThan(9 * 60_000);
    const sent = await approvals.notifyOwner(row, owner);
    const tg = calls.find(c => c.url === 'https://relay.test/api/sendMessage')!;
    expect(tg.body.chat_id).toBe(OWNER_TG);
    expect(tg.body.text).toContain('Ленина 5');
    expect(tg.body.text).toContain('ячейка 12');
    expect(tg.body.text).toContain('3 из 10');
    expect(tg.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual([`cq:ok:${APPROVAL}`, `cq:no:${APPROVAL}`]);
    expect(sent.telegram_message_id).toBe(77);
  });

  it('бот заблокирован владельцем — запрос становится undeliverable', async () => {
    mockNetwork((url, init) =>
      url === 'https://relay.test/api/sendMessage' ? { status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } }
      : url.includes('app_code_approvals?user_id=') ? { body: [] }
      : url.includes('app_code_approvals?id=') && init.method === 'PATCH' ? { body: [pendingRow({ status: 'undeliverable', error: 'blocked' })] }
      : undefined);
    const out = await approvals.notifyOwner(pendingRow(), { id: OWNER_TG, label: '@owner' });
    expect(out.status).toBe('undeliverable');
  });
});

describe('решение владельца (approve / decline)', () => {
  const ownerIdentity = (url: string) => (url.includes('user_telegram_identities?telegram_user_id=eq.' + OWNER_TG) ? { body: [{ user_id: USER }] }
    : url.includes('user_telegram_identities?telegram_user_id=') ? { body: [] } : undefined);

  it('чужой Telegram не может выдать', async () => {
    mockNetwork(url => ownerIdentity(url) || (url.includes('app_code_approvals?id=') ? { body: [pendingRow()] } : undefined));
    const out = await approvals.approve(APPROVAL, { telegramUserId: 999 });
    expect(out.outcome).toBe('not_owner');
  });

  it('просроченный запрос помечается expired и не выдаётся', async () => {
    const calls = mockNetwork((url, init) => ownerIdentity(url)
      || (url.includes('app_code_approvals?id=') && init.method === 'PATCH' ? { body: [pendingRow({ status: 'expired' })] } : undefined)
      || (url.includes('app_code_approvals?id=') ? { body: [pendingRow({ expires_at: new Date(Date.now() - 1000).toISOString() })] } : undefined));
    const out = await approvals.approve(APPROVAL, { telegramUserId: OWNER_TG });
    expect(out.outcome).toBe('stale');
    const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('status=eq.pending'))!;
    expect(patch.body.status).toBe('expired');
  });

  it('«Выдать»: списание app_code_once с p_request = id запроса, строка approved, сообщение владельцу обновлено', async () => {
    const calls = mockNetwork((url, init) => ownerIdentity(url)
      || (url.includes('app_code_approvals?user_id=') ? { body: [] } : undefined)
      || (url.includes('rpc/app_code_once') ? { body: { qrText: '191607973_12345_654321_1', billing: { via: 'account', source: 'quota' }, replayed: false } } : undefined)
      || (url.includes('app_code_approvals?id=') && init.method === 'PATCH' ? { body: [pendingRow({ status: 'approved', qr_text: '191607973_12345_654321_1', billing: { via: 'account', source: 'quota' } })] } : undefined)
      || (url.includes('app_code_approvals?id=') ? { body: [pendingRow()] } : undefined));
    const out = await approvals.approve(APPROVAL, { telegramUserId: OWNER_TG });
    expect(out.outcome).toBe('approved');
    const charge = calls.find(c => c.url.includes('rpc/app_code_once'))!;
    expect(charge.body).toMatchObject({ p_request: APPROVAL, p_user: USER, p_device: DEV_ID, p_sid: '191607973', p_meta: { via: 'approval', cell: '12' } });
    expect(charge.body.p_qr_text).toMatch(/^191607973_\d{5}_\d{6}_1$/);
    const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('app_code_approvals?id='))!;
    expect(patch.body).toMatchObject({ status: 'approved', qr_text: '191607973_12345_654321_1' });
    const edit = calls.find(c => c.url === 'https://relay.test/api/editMessageText')!;
    expect(edit.body.message_id).toBe(77);
    expect(edit.body.text).toContain('Выдано');
    expect(edit.body.text).toContain('код тарифа');
    expect(approvals.statusPayload(out.row)).toMatchObject({ status: 'approved', code: 12345, qrText: '191607973_12345_654321_1' });
  });

  it('тот же клиент уже выдан сегодня — повтор без списания', async () => {
    const earlier = pendingRow({ id: '44444444-4444-4444-8444-444444444444', status: 'approved', qr_text: '191607973_55555_111111_1', decided_at: new Date().toISOString() });
    const calls = mockNetwork((url, init) => ownerIdentity(url)
      || (url.includes('app_code_approvals?user_id=') ? { body: [earlier] } : undefined)
      || (url.includes('app_code_approvals?id=') && init.method === 'PATCH' ? { body: [pendingRow({ status: 'approved', qr_text: earlier.qr_text, billing: { via: 'reuse' } })] } : undefined)
      || (url.includes('app_code_approvals?id=') ? { body: [pendingRow()] } : undefined));
    const out = await approvals.approve(APPROVAL, { telegramUserId: OWNER_TG });
    expect(out.outcome).toBe('approved');
    expect(calls.some(c => c.url.includes('rpc/app_code_once'))).toBe(false);
    const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('app_code_approvals?id='))!;
    expect(patch.body).toMatchObject({ qr_text: earlier.qr_text, billing: { via: 'reuse', of: earlier.id } });
  });

  it('квота и пакеты пусты — outcome limit с ценой и балансом, строка остаётся pending', async () => {
    const calls = mockNetwork((url, init) => ownerIdentity(url)
      || (url.includes('app_code_approvals?user_id=') ? { body: [] } : undefined)
      || (url.includes('rpc/app_code_once') ? { status: 400, body: { message: 'LIMIT_EXCEEDED' } } : undefined)
      || (url.includes('app_code_approvals?id=') ? { body: [pendingRow()] } : undefined));
    const out = await approvals.approve(APPROVAL, { telegramUserId: OWNER_TG });
    expect(out.outcome).toBe('limit');
    expect(out.price).toBe(50);
    expect(out.balance).toBe(10);
    expect(calls.some(c => c.method === 'PATCH' && c.url.includes('app_code_approvals?id='))).toBe(false);
  });

  it('выдать с баланса: wallet_spend с ключом по QR, нехватка — wallet_short', async () => {
    const calls = mockNetwork((url, init) => ownerIdentity(url)
      || (url.includes('app_code_approvals?user_id=') ? { body: [] } : undefined)
      || (url.includes('rpc/wallet_spend') ? { body: { ok: true, balance: 500 } } : undefined)
      || (url.includes('app_code_approvals?id=') && init.method === 'PATCH' ? { body: [pendingRow({ status: 'approved', billing: { via: 'wallet', rub: 50 } })] } : undefined)
      || (url.includes('app_code_approvals?id=') ? { body: [pendingRow()] } : undefined));
    const out = await approvals.approve(APPROVAL, { telegramUserId: OWNER_TG, payWithWallet: true });
    expect(out.outcome).toBe('approved');
    const spend = calls.find(c => c.url.includes('rpc/wallet_spend'))!;
    expect(spend.body.p_kopecks).toBe(5000);
    expect(spend.body.p_event_key).toMatch(new RegExp(`^qr:${USER}:191607973_\\d{5}_\\d{6}_1$`));
    expect(calls.some(c => c.url.includes('rpc/app_code_once'))).toBe(false);

    vi.unstubAllGlobals();
    mockNetwork(url => ownerIdentity(url)
      || (url.includes('app_code_approvals?user_id=') ? { body: [] } : undefined)
      || (url.includes('rpc/wallet_spend') ? { body: { ok: false, balance: 1000 } } : undefined)
      || (url.includes('app_code_approvals?id=') ? { body: [pendingRow()] } : undefined));
    const short = await approvals.approve(APPROVAL, { telegramUserId: OWNER_TG, payWithWallet: true });
    expect(short).toMatchObject({ outcome: 'wallet_short', price: 50, balance: 10 });
  });

  it('«Отклонить» и «Отменить с ПК» закрывают только свой pending', async () => {
    const calls = mockNetwork((url, init) => ownerIdentity(url)
      || (url.includes('app_code_approvals?id=') && init.method === 'PATCH' ? { body: [pendingRow({ status: String(JSON.parse(String(init.body)).status) })] } : undefined)
      || (url.includes('app_code_approvals?id=') ? { body: [pendingRow()] } : undefined));
    expect((await approvals.decline(APPROVAL, { telegramUserId: OWNER_TG })).outcome).toBe('declined');
    expect(await approvals.cancel(APPROVAL, { userId: 'someone-else', deviceId: DEV_ID })).toBeNull();
    expect((await approvals.cancel(APPROVAL, { userId: USER, deviceId: DEV_ID })).status).toBe('cancelled');
    const edits = calls.filter(c => c.url === 'https://relay.test/api/editMessageText');
    expect(edits.map(e => e.body.text)).toEqual([expect.stringContaining('Отклонено'), expect.stringContaining('Отменено с компьютера')]);
  });
});

describe('api/app.js: прямой путь закрыт, запрос и привязка Telegram', () => {
  it('client-qr вошедшему аккаунту при включённом флаге — 403 APPROVAL_REQUIRED, по ключу WBPK — как раньше', async () => {
    mockNetwork(url => (url.includes('rpc/consume_license') ? { body: [{ id: 1, usage_limit: 10, used: 1 }] } : undefined));
    const res = response();
    await handler(request('client-qr', { method: 'POST', body: { sid: '1' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'APPROVAL_REQUIRED' });

    const byKey = response();
    await handler(request('client-qr', { method: 'POST', body: { sid: '1', key: 'WBPK-1' }, headers: { authorization: undefined } }), byKey);
    expect(byKey.statusCode).toBe(200);
  });

  it('флаг выключен — client-qr работает по-старому', async () => {
    mockNetwork(url =>
      url.includes('site_settings?key=eq.app_code_via_bot') ? { body: [{ value: false }] }
      : url.includes('rpc/app_code_once') ? { body: { qrText: '1_12345_123456_1', billing: { via: 'account' }, replayed: false } }
      : undefined);
    const res = response();
    await handler(request('client-qr', { method: 'POST', body: { sid: '1', requestId: APPROVAL } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ code: 12345 });
  });

  it('code-request создаёт запрос и возвращает pending с Telegram владельца', async () => {
    mockNetwork((url, init) =>
      url.includes('user_telegram_identities?user_id=') ? { body: [{ telegram_user_id: OWNER_TG, username: 'owner' }] }
      : url.includes('app_code_approvals?device_id=') ? { body: [] }
      : url.includes('app_code_approvals?user_id=') ? { body: [] }
      : url.includes('app_code_approvals?select=') && init.method === 'POST' ? { body: [pendingRow({ telegram_chat_id: null, telegram_message_id: null })] }
      : url.includes('app_code_approvals?id=') && init.method === 'PATCH' ? { body: [pendingRow()] }
      : undefined);
    const res = response();
    await handler(request('code-request', { method: 'POST', body: { sid: '191607973', cell: '12' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: APPROVAL, status: 'pending', reused: false, ownerTelegram: '@owner' });
  });

  it('code-request при закрытом act.client_qr — DENIED_BY_OWNER', async () => {
    mockNetwork(url => (url.includes('app_devices?user_id=') ? { body: [{ id: DEV_ID, name: 'Касса', last_seen_at: new Date().toISOString(), denied: ['act.client_qr'], point_wb: null, role: 'work' }] } : undefined));
    const res = response();
    await handler(request('code-request', { method: 'POST', body: { sid: '1' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'DENIED_BY_OWNER', key: 'act.client_qr' });
  });

  it('code-request-status отдаёт QR только своему ПК, approved — с картинкой', async () => {
    mockNetwork(url => (url.includes('app_code_approvals?id=') ? { body: [pendingRow({ status: 'approved', qr_text: '191607973_12345_654321_1' })] } : undefined));
    const res = response();
    await handler(request('code-request-status', { query: { id: APPROVAL } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', code: 12345 });
    expect(String((res.body as any).qrImage)).toMatch(/^data:image\/png;base64,/);

    vi.unstubAllGlobals();
    mockNetwork(url => (url.includes('app_code_approvals?id=') ? { body: [pendingRow({ device_id: '99999999-9999-4999-8999-999999999999' })] } : undefined));
    const other = response();
    await handler(request('code-request-status', { query: { id: APPROVAL } }), other);
    expect(other.statusCode).toBe(404);
  });

  it('telegram-link: с ПК сотрудника — WORK_PC, с ПК владельца — ссылка t.me с токеном на 10 минут', async () => {
    mockNetwork(() => undefined);
    const work = response();
    await handler(request('telegram-link', { method: 'POST' }), work);
    expect(work.statusCode).toBe(403);
    expect(work.body).toMatchObject({ code: 'WORK_PC' });

    vi.unstubAllGlobals(); (require('../../server/_app-device-cache.js') as { resetForTests: () => void }).resetForTests(); // «база» подменена мимо сервера
    const calls = mockNetwork(url =>
      url.includes('app_devices?user_id=') ? { body: [{ id: DEV_ID, name: 'Дом', last_seen_at: new Date().toISOString(), denied: [], point_wb: null, role: 'owner' }] }
      : url === 'https://relay.test/api/getMe' ? { body: { ok: true, result: { username: 'shkwb_bot' } } }
      : url.includes('app_telegram_link_tokens') ? { body: [] }
      : undefined);
    const owner = response();
    await handler(request('telegram-link', { method: 'POST' }), owner);
    expect(owner.statusCode).toBe(200);
    const url = String((owner.body as any).url);
    expect(url).toMatch(/^https:\/\/t\.me\/shkwb_bot\?start=link_[A-Za-z0-9_-]{24}$/);
    const inserted = calls.find(c => c.url.includes('app_telegram_link_tokens') && c.method === 'POST')!;
    expect(inserted.body).toMatchObject({ user_id: USER, device_id: DEV_ID, token: url.split('link_')[1] });
    expect(Date.parse(inserted.body.expires_at) - Date.now()).toBeGreaterThan(9 * 60_000);
  });
});

describe('флаг app_code_via_bot', () => {
  it('читается из site_settings и отдаётся в /me как flags.codeViaBot', async () => {
    mockNetwork(url =>
      url.includes('user_telegram_identities?user_id=') ? { body: [{ username: 'owner', first_name: 'O', telegram_user_id: OWNER_TG }] }
      : url.includes('license_keys') || url.includes('sticker_access_codes') || url.includes('app_points') || url.includes('user_profiles') ? { body: [] }
      : undefined);
    expect(await flags.codeViaBotEnabled()).toBe(true);
    const res = response();
    await handler(request('me'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ telegramLinked: true, flags: { codeViaBot: true }, user: { telegram: { username: 'owner' } } });
  });
});

describe('индивидуальное исключение user_profiles.app_code_via_bot_off', () => {
  const offProfile = (url: string) =>
    url.includes('user_profiles?user_id=') ? { body: [{ display_name: 'O', phone: '', app_code_via_bot_off: true }] } : undefined;

  it('client-qr при включённом флаге выдаёт напрямую, code-request — 409 CODE_VIA_BOT_OFF', async () => {
    mockNetwork(url =>
      offProfile(url)
      || (url.includes('rpc/app_code_once') ? { body: { qrText: '1_12345_123456_1', billing: { via: 'account' }, replayed: false } } : undefined));
    const direct = response();
    await handler(request('client-qr', { method: 'POST', body: { sid: '1', requestId: APPROVAL } }), direct);
    expect(direct.statusCode).toBe(200);
    expect(direct.body).toMatchObject({ code: 12345 });

    const req = response();
    await handler(request('code-request', { method: 'POST', body: { sid: '191607973', cell: '12' } }), req);
    expect(req.statusCode).toBe(409);
    expect(req.body).toMatchObject({ code: 'CODE_VIA_BOT_OFF' });
  });

  it('/me отдаёт flags.codeViaBot=false, хотя глобальный флаг включён', async () => {
    mockNetwork(url =>
      offProfile(url)
      || (url.includes('user_telegram_identities?user_id=') || url.includes('license_keys') || url.includes('sticker_access_codes') || url.includes('app_points') ? { body: [] } : undefined));
    expect(await flags.codeViaBotEnabled()).toBe(true);
    const res = response();
    await handler(request('me'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ flags: { codeViaBot: false } });
  });
});

describe('client-error (аварийный экран программы)', () => {
  it('принимает отчёт без входа и пишет в журнал без ПДн', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = response();
    await handler(request('client-error', { method: 'POST', headers: { authorization: undefined, 'x-app-name': 'pvz-helper' }, body: { screen: 'cells/cell', message: 'Minified React error #185', stack: 'x'.repeat(5000) } }), res);
    expect(res.statusCode).toBe(204);
    const line = warn.mock.calls.find(([head]) => head === '[app] client error');
    expect(line).toBeTruthy();
    const logged = JSON.parse(String(line![1]));
    expect(logged).toMatchObject({ app: 'pvz-helper', version: '1.11.0', screen: 'cells/cell', message: 'Minified React error #185' });
    expect(logged.stack.length).toBe(1500);
    expect(logged.device).not.toContain(DEVICE.slice(10));
    warn.mockRestore();
  });
});
