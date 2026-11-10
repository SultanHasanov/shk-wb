// Журнал админки: маршруты в api/admin/data.js, записи журнала во всех изменяющих ветках, ленты audit/deliveries/attention.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const root = resolve(__dirname, '../..');
const audit = require('../../server/_admin-audit.js') as {
  ACTION_CATEGORY: Record<string, string>;
  DANGER_ACTIONS: Set<string>;
  categoryOf: (action: string) => string;
  auditEntryDto: (row: Record<string, unknown>, labels?: Map<string, Record<string, unknown>>) => Record<string, unknown>;
  handleAudit: (req: unknown, res: unknown) => Promise<unknown>;
  handleDeliveries: (req: unknown, res: unknown) => Promise<unknown>;
  handleAttention: (req: unknown, res: unknown) => Promise<unknown>;
  runMaintenance: () => Promise<unknown>;
  endOfMoscowDay: (now?: number) => Date;
  resetForTests: () => void;
};
const adminAuth = require('../../server/_admin-auth.js') as { createSessionCookie: () => string };
const dataHandler = require('../../api/admin/data.js') as (req: unknown, res: unknown) => Promise<unknown>;

const USER = '11111111-1111-4111-8111-111111111111';

/** Таблица 5.6 контракта: action → [категория, опасное]. */
const TABLE: Record<string, [string, boolean]> = {
  grantSticker: ['keys', false], topupSticker: ['keys', false], patchCode: ['keys', false],
  createIndividualStickerOrder: ['money', false], grantProgramKey: ['keys', false], patchProgramKey: ['keys', false],
  grantCellLicense: ['keys', false], patchCellLicense: ['keys', false], grantAppSubscription: ['keys', false],
  revokeAppSubscription: ['keys', true], grantAppAddon: ['keys', false], revokeAppAddon: ['keys', false],
  revokeAppPoint: ['keys', false], revokeAppDevice: ['keys', false], setDeviceRole: ['keys', false], attach: ['keys', false],
  profile: ['settings', false], appCodeViaBot: ['settings', false], setOverrides: ['limits', false], clearOverrides: ['limits', false],
  walletAdjust: ['money', true], restrict: ['restrict', true], updateRestriction: ['restrict', true], liftRestriction: ['restrict', false],
  block: ['restrict', true], unblock: ['restrict', false], message: ['messages', false], notify: ['messages', false],
  retryDelivery: ['messages', false], sendNews: ['messages', true], sendTelegramBroadcast: ['messages', true],
  logoutAll: ['settings', true], unlinkTelegram: ['settings', true], unlinkOAuth: ['settings', true],
  deleteAccount: ['deletions', true], deleteResource: ['deletions', true], createResource: ['settings', false],
  updateResource: ['settings', false], setAppFreeMode: ['settings', true], setAppCrackFallback: ['settings', false],
  setAppCodeViaBot: ['settings', true], setPaymentsEnabled: ['settings', true], upsertPriceTier: ['money', false],
  deletePriceTier: ['money', false], syncPaymentOrder: ['money', false], setStickerPoolRange: ['settings', true],
  setBoxPoolRange: ['settings', true], processWithdrawal: ['money', true], setKztRate: ['settings', false],
  createPartner: ['keys', false], grantPartnerPool: ['keys', false], updatePartner: ['keys', false],
  partnerPayment: ['money', false], togglePartnerItem: ['keys', false],
};

type Call = { url: string; method: string; body: any; headers: Record<string, string> };
let calls: Call[] = [];

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function stub(responder: (path: string, method: string, body: any) => Response | unknown) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const full = String(url);
    const path = full.includes('/rest/v1/') ? decodeURIComponent(full.split('/rest/v1/')[1]) : full;
    const method = String(init.method || 'GET').toUpperCase();
    let body: any = null;
    try { body = init.body ? JSON.parse(String(init.body)) : null; } catch { body = init.body; }
    calls.push({ url: path, method, body, headers: (init.headers || {}) as Record<string, string> });
    const out = responder(path, method, body);
    return out instanceof Response ? out : json(out ?? []);
  }));
}

function response() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.end = () => res;
  return res;
}

function get(query: Record<string, string | undefined>) {
  return { method: 'GET', query, headers: {}, body: undefined };
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  audit.resetForTests();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('таблица действий', () => {
  it('ACTION_CATEGORY и DANGER_ACTIONS совпадают с таблицей 5.6', () => {
    for (const [action, [category, danger]] of Object.entries(TABLE)) {
      expect(audit.ACTION_CATEGORY[action], action).toBe(category);
      expect(audit.DANGER_ACTIONS.has(action), action).toBe(danger);
    }
    expect(Object.keys(audit.ACTION_CATEGORY).sort()).toEqual(Object.keys(TABLE).sort());
    expect(audit.categoryOf('somethingNew')).toBe('other');
  });

  it('каждое имя из recordAdminAction / runIdempotent в server/ и api/ есть в ACTION_CATEGORY', () => {
    const files = [
      ...readdirSync(join(root, 'server')).filter(name => name.endsWith('.js')).map(name => join(root, 'server', name)),
      ...readdirSync(join(root, 'api')).filter(name => name.endsWith('.js')).map(name => join(root, 'api', name)),
      ...readdirSync(join(root, 'api', 'admin')).filter(name => name.endsWith('.js')).map(name => join(root, 'api', 'admin', name)),
    ];
    const names = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/recordAdminAction\(\s*(?:req|null)\s*,\s*'([A-Za-z]+)'/g)) names.add(match[1]);
      for (const match of source.matchAll(/(?:runIdempotent|journaled)\(\s*req\s*,\s*res\s*,\s*\{\s*action\s*:\s*'([A-Za-z]+)'/g)) names.add(match[1]);
    }
    expect(names.size).toBeGreaterThan(10);
    const missing = [...names].filter(name => !(name in audit.ACTION_CATEGORY));
    expect(missing).toEqual([]);
  });
});

describe('api/admin/data.js по исходникам', () => {
  const source = readFileSync(join(root, 'api/admin/data.js'), 'utf8');
  const slice = (from: string, to: string) => {
    const start = source.indexOf(from);
    expect(start, from).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(to, start + from.length);
    return source.slice(start, end < 0 ? undefined : end);
  };

  it('новые resource стоят после requireAdmin', () => {
    const guard = source.indexOf('if (!requireAdmin(req, res)) return;');
    expect(guard).toBeGreaterThan(0);
    for (const resource of ['audit', 'deliveries', 'attention', 'system']) {
      const at = source.indexOf(`req.query.resource === '${resource}'`);
      expect(at, resource).toBeGreaterThan(guard);
    }
  });

  it('recordAdminAction в каждой ветке общего CRUD', () => {
    const handler = slice('module.exports = async function handler', 'async function handleLogin');
    const post = handler.slice(handler.indexOf("if (req.method === 'POST')"), handler.indexOf("if (req.method === 'PATCH' && id)"));
    const patch = handler.slice(handler.indexOf("if (req.method === 'PATCH' && id)"), handler.indexOf("if (req.method === 'DELETE' && id)"));
    const del = handler.slice(handler.indexOf("if (req.method === 'DELETE' && id)"), handler.indexOf("res.setHeader('Allow', 'GET, POST, PATCH, DELETE')"));
    // три вида создания (лицензия ПВЗ Принт, код генератора, остальные) — у каждого своя запись
    expect(post.match(/recordAdminAction\(req, 'createResource'/g)).toHaveLength(3);
    expect(patch).toMatch(/recordAdminAction\(req, 'updateResource'/);
    expect(patch).toMatch(/before:/);
    expect(del).toMatch(/recordAdminAction\(req, 'deleteResource'/);
    expect(del.indexOf('currentRow()')).toBeLessThan(del.indexOf("method: 'DELETE'"));
  });

  it('recordAdminAction в оплате (settings, tier, tier DELETE, sync) и обоих пулах', () => {
    const payment = slice('async function handlePaymentAdmin', 'async function handleBoxPool');
    for (const action of ['setPaymentsEnabled', 'upsertPriceTier', 'deletePriceTier', 'syncPaymentOrder']) {
      expect(payment, action).toContain(`recordAdminAction(req, '${action}'`);
    }
    expect(slice('async function handleBoxPool', 'async function handleStickerPool')).toContain("recordAdminAction(req, 'setBoxPoolRange'");
    expect(slice('async function handleStickerPool', '\n}\n')).toContain("recordAdminAction(req, 'setStickerPoolRange'");
  });

  it('DELETE записи: строка «до» читается, журнал получает before', async () => {
    process.env.ADMIN_SESSION_SECRET = 'admin-session-secret-for-tests-0123456789';
    const cookie = adminAuth.createSessionCookie().split(';')[0];
    stub((path, method) => {
      if (path.startsWith('announcements?id=eq.5') && method === 'GET') return [{ id: 5, text: 'Старое', url: null, button: null, active: true, created_at: '2026-11-01T00:00:00Z' }];
      return [];
    });
    const res = response();
    await dataHandler({ method: 'DELETE', query: { resource: 'message', id: '5' }, headers: { cookie }, body: { reason: 'устарело' } }, res);
    expect(res.statusCode).toBe(204);
    const journal = calls.find(c => c.url === 'admin_actions' && c.method === 'POST')!;
    expect(journal.body).toMatchObject({ action: 'deleteResource', payload: { resource: 'message', id: '5' }, reason: 'устарело', before: { id: 5, text: 'Старое' } });
  });

  it('флаги программы: причина из окна подтверждения и было/стало попадают в журнал', async () => {
    process.env.ADMIN_SESSION_SECRET = 'admin-session-secret-for-tests-0123456789';
    const cookie = adminAuth.createSessionCookie().split(';')[0];
    const settings = new Map<string, unknown>();
    stub((path, method, body) => {
      if (path.startsWith('site_settings?key=eq.') && method === 'GET') {
        const key = path.slice('site_settings?key=eq.'.length).split('&')[0];
        return settings.has(key) ? [{ value: settings.get(key) }] : [];
      }
      if (path === 'site_settings' && method === 'POST') settings.set(body.key, body.value);
      return [];
    });
    for (const [resource, action] of [['appCodeViaBot', 'setAppCodeViaBot'], ['appCrackFallback', 'setAppCrackFallback'], ['appFreeMode', 'setAppFreeMode']]) {
      calls = [];
      const res = response();
      await dataHandler({ method: 'POST', query: { resource }, headers: { cookie }, body: { enabled: true, reason: `причина ${resource}` } }, res);
      expect(res.statusCode, resource).toBe(200);
      const journal = calls.find(c => c.url === 'admin_actions' && c.method === 'POST');
      expect(journal?.body, resource).toMatchObject({
        action, reason: `причина ${resource}`, before: { enabled: false }, after: { enabled: true },
      });
    }
  });

  it('без сессии новые разделы отвечают 401, а не 404', async () => {
    stub(() => []);
    for (const resource of ['audit', 'deliveries', 'attention', 'system']) {
      const res = response();
      await dataHandler({ method: 'GET', query: { resource }, headers: {} }, res);
      expect(res.statusCode, resource).toBe(401);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('resource=audit', () => {
  it('плохие параметры — 400 без запроса к базе', async () => {
    stub(() => []);
    for (const query of [{ limit: '0' }, { limit: '101' }, { cursor: 'abc' }, { category: 'nope' }, { userId: 'x' }, { from: 'вчера' }, { action: 'a;b' }]) {
      const res = response();
      await audit.handleAudit(get(query), res);
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('категория + опасные → action=in.(пересечение), курсор, без колонки response, подписи одним RPC', async () => {
    stub(path => {
      if (path.startsWith('rpc/admin_user_labels')) return [{ user_id: USER, email: 'u@test.ru', display_name: 'Иван', telegram_username: 'ivan', telegram_only: false }];
      if (path.startsWith('admin_actions')) return [
        { id: 30, created_at: '2026-11-10T10:00:00Z', action: 'walletAdjust', target_user_id: USER, payload: { amountKopecks: 50000 }, reason: 'компенсация', before: { balanceKopecks: 0 }, after: { balanceKopecks: 50000 }, result: 'ok', admin_fingerprint: 'abc', user_agent: 'UA' },
        { id: 29, created_at: '2026-11-10T09:00:00Z', action: 'processWithdrawal', target_user_id: null, payload: {}, result: null },
        { id: 28, created_at: '2026-11-10T08:00:00Z', action: 'processWithdrawal', target_user_id: null, payload: {}, result: null },
      ];
      return [];
    });
    const res = response();
    await audit.handleAudit(get({ category: 'money', danger: '1', limit: '2', cursor: '31' }), res);
    expect(res.statusCode).toBe(200);
    const query = calls.find(c => c.url.startsWith('admin_actions'))!.url;
    expect(query).toContain('id=lt.31');
    expect(query).toContain('action=in.(walletAdjust,processWithdrawal)');
    expect(query).toContain('limit=3');
    expect(query).not.toContain('response');
    expect(query).toContain('order=id.desc');
    expect(res.body.nextCursor).toBe(29);
    expect(res.body.total).toBeNull();
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toEqual({
      id: 30, createdAt: '2026-11-10T10:00:00Z', action: 'walletAdjust', category: 'money', danger: true, targetUserId: USER,
      target: { userId: USER, email: 'u@test.ru', displayName: 'Иван', telegramUsername: 'ivan' },
      reason: 'компенсация', payload: { amountKopecks: 50000 }, before: { balanceKopecks: 0 }, after: { balanceKopecks: 50000 },
      result: 'ok', adminFingerprint: 'abc', userAgent: 'UA',
    });
    expect(calls.filter(c => c.url.startsWith('rpc/admin_user_labels'))).toHaveLength(1);
  });

  it('поиск очищается от служебных символов PostgREST; uuid — по пользователю; без курсора total', async () => {
    stub(path => (path.startsWith('admin_actions') ? json([], 200, { 'content-range': '*/0' }) : []));
    let res = response();
    await audit.handleAudit(get({ q: 'кош(ел),ёк*:' }), res);
    expect(calls[0].url).toContain('or=(action.ilike.*кош ел ёк*,reason.ilike.*кош ел ёк*)');
    expect(res.body).toEqual({ items: [], nextCursor: null, total: 0 });
    res = response();
    await audit.handleAudit(get({ q: USER }), res);
    expect(calls[calls.length - 1].url).toContain(`target_user_id=eq.${USER}`);
  });

  it('«прочее» — действия вне таблицы', async () => {
    stub(() => json([], 200, { 'content-range': '*/0' }));
    await audit.handleAudit(get({ category: 'other' }), response());
    expect(calls[0].url).toContain('action=not.in.(grantSticker,');
  });
});

describe('resource=deliveries', () => {
  it('status=error → failed+blocked, canRetry только у неудачных писем от «Написать», stats24h', async () => {
    stub(path => {
      if (path.startsWith('notification_deliveries?select=*')) return [
        { id: 'd1', created_at: '2026-11-10T10:00:00Z', channel: 'email', status: 'failed', recipient: 'u@test.ru', source: 'admin', admin_action_id: 5, attempts: 1, user_id: USER, subject: 'Тема' },
        { id: 'd2', created_at: '2026-11-10T09:00:00Z', channel: 'telegram', status: 'blocked', recipient: '55', channel_ref: '@ivan', source: 'admin', admin_action_id: 6, attempts: 1, user_id: USER },
        { id: 'd3', created_at: '2026-11-10T08:00:00Z', channel: 'email', status: 'failed', recipient: 'u@test.ru', source: 'admin', admin_action_id: 6, attempts: 1, user_id: USER },
      ];
      if (path.startsWith('admin_actions?id=in.')) return [{ id: 5, action: 'message' }, { id: 6, action: 'walletAdjust' }];
      if (path.startsWith('rpc/admin_user_labels')) return [{ user_id: USER, email: 'u@test.ru', display_name: null }];
      if (path.includes('select=id&')) return json([], 200, { 'content-range': '0-0/3' });
      return [];
    });
    const res = response();
    await audit.handleDeliveries(get({ status: 'error', limit: '2' }), res);
    expect(res.statusCode).toBe(200);
    expect(calls.find(c => c.url.startsWith('notification_deliveries?select=*'))!.url).toContain('status=in.(failed,blocked)');
    expect(res.body.items.map((item: { id: string; canRetry: boolean }) => [item.id, item.canRetry])).toEqual([['d1', true], ['d2', false]]);
    expect(res.body.items[0].user).toEqual({ email: 'u@test.ru', displayName: null });
    expect(res.body.nextCursor).toBe('2026-11-10T09:00:00Z');
    expect(res.body.stats24h).toEqual({ sent: 3, failed: 3, notConfigured: 3, waitingPc: 3 });
  });

  it('повтор доставки, которую повторить нельзя — 409 NOT_RETRYABLE', async () => {
    stub((path, method) => {
      if (path.startsWith('notification_deliveries?id=eq.') && method === 'GET') return [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', channel: 'email', status: 'sent', source: 'admin', admin_action_id: 5, user_id: USER, attempts: 1 }];
      if (path.startsWith('admin_actions') && method === 'POST') return [{ id: 90 }];
      if (path.startsWith('admin_actions?id=eq.5')) return [{ id: 5, action: 'message', payload: { subject: 'Т', body: 'Т' } }];
      return [];
    });
    const res = response();
    await audit.handleDeliveries({ method: 'POST', query: { action: 'retry' }, headers: {}, body: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', idempotencyKey: 'retry-key-123' } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'NOT_RETRYABLE' });
  });

  it('повтор доставки забирает строку атомарно: второй повтор с другим ключом не шлёт письмо второй раз', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'noreply@shk-wb.ru';
    const ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    let status = 'failed';
    stub((path, method, body) => {
      if (path.startsWith('https://api.resend.com')) return { id: 're_1' };
      if (path.startsWith(`notification_deliveries?id=eq.${ID}&status=in.(failed,not_configured)`) && method === 'PATCH') {
        if (status !== 'failed' && status !== 'not_configured') return [];
        status = body.status;
        return [{ id: ID, status }];
      }
      if (path.startsWith(`notification_deliveries?id=eq.${ID}`) && method === 'PATCH') { status = body.status; return [{ id: ID, channel: 'email', status, source: 'admin', admin_action_id: 5, attempts: body.attempts }]; }
      if (path.startsWith(`notification_deliveries?id=eq.${ID}`) && method === 'GET') return [{ id: ID, channel: 'email', status: path.includes('select=status') ? status : 'failed', recipient: 'u@test.ru', source: 'admin', admin_action_id: 5, user_id: USER, attempts: 1 }];
      if (path.startsWith('admin_actions') && method === 'POST') return [{ id: 90 }];
      if (path.startsWith('admin_actions?id=eq.5')) return [{ id: 5, action: 'message', payload: { subject: 'Тема', body: 'Текст' } }];
      if (path.startsWith('admin_actions?id=in.')) return [{ id: 5, action: 'message' }];
      return [];
    });
    try {
      // Первый повтор забрал строку (pending) и ещё шлёт; второй (другой ключ) видит её уже не в ошибке.
      status = 'pending';
      const busy = response();
      await audit.handleDeliveries({ method: 'POST', query: { action: 'retry' }, headers: {}, body: { id: ID, idempotencyKey: 'retry-key-222' } }, busy);
      expect(busy.statusCode).toBe(409);
      expect(busy.body).toMatchObject({ code: 'IN_PROGRESS' });
      expect(calls.some(c => c.url.startsWith('https://api.resend.com'))).toBe(false);

      status = 'failed';
      const ok = response();
      await audit.handleDeliveries({ method: 'POST', query: { action: 'retry' }, headers: {}, body: { id: ID, idempotencyKey: 'retry-key-333' } }, ok);
      expect(ok.statusCode).toBe(200);
      const claim = calls.findIndex(c => c.url.includes('status=in.(failed,not_configured)') && c.method === 'PATCH');
      const send = calls.findIndex(c => c.url.startsWith('https://api.resend.com'));
      expect(claim).toBeGreaterThanOrEqual(0);
      expect(claim).toBeLessThan(send);
      expect(calls[claim].body).toEqual({ status: 'pending' });
      expect(ok.body.delivery).toMatchObject({ status: 'sent' });
    } finally {
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_FROM_EMAIL;
    }
  });

  it('плохие фильтры — 400 без запроса', async () => {
    stub(() => []);
    for (const query of [{ channel: 'sms' }, { status: 'lost' }, { before: 'x' }, { userId: '1' }]) {
      const res = response();
      await audit.handleDeliveries(get(query), res);
      expect(res.statusCode).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('resource=attention', () => {
  it('собирает счётчики и держит кеш 60 с', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T10:00:00Z'));
    stub(path => {
      if (path.startsWith('referral_withdrawals')) return [{ amount_kopecks: 60000, created_at: '2026-11-09T10:00:00Z' }, { amount_kopecks: 40000, created_at: '2026-11-10T08:00:00Z' }];
      if (path.startsWith('payment_orders')) return json([{ created_at: '2026-11-10T09:00:00Z' }], 200, { 'content-range': '0-0/2' });
      if (path.startsWith('return_sticker_codes')) return json([], 200, { 'content-range': '0-0/120' });
      if (path.startsWith('return_box_codes')) return json([], 200, { 'content-range': '0-0/9000' });
      if (path.startsWith('notification_deliveries')) return [{ channel: 'email' }, { channel: 'pc' }, { channel: 'email' }];
      if (path.startsWith('user_restrictions')) return json([{ user_id: USER, until: '2026-11-10T15:00:00Z' }], 200, { 'content-range': '0-0/1' });
      if (path.startsWith('rpc/admin_user_labels')) return [{ user_id: USER, email: 'u@test.ru', display_name: 'Иван' }];
      if (path.startsWith('rpc/admin_user_counts')) return { all: 500, subscribed: 40, expiring: 3, restricted: 2 };
      return [];
    });
    const res = response();
    await audit.handleAttention(get({}), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      withdrawals: { count: 2, amountKopecks: 100000, oldestAt: '2026-11-09T10:00:00Z' },
      stuckOrders: { count: 2, oldestAt: '2026-11-10T09:00:00Z' },
      stickerPool: { available: 120, threshold: 500, low: true },
      boxPool: { available: 9000, low: false },
      failedDeliveries24h: { count: 3, byChannel: { email: 2, telegram: 0, pc: 1 } },
      restrictionsExpiringToday: { count: 1, items: [{ userId: USER, label: 'Иван', until: '2026-11-10T15:00:00Z' }] },
      restrictedTotal: 2, subscriptions: { active: 40, expiring7: 3 }, usersTotal: 500, onlinePcs: 0,
      total: 5,
    });
    const restrictionQuery = calls.find(c => c.url.startsWith('user_restrictions'))!.url;
    expect(restrictionQuery).toContain('until=lte.2026-11-10T21:00:00.000Z');
    const count = calls.length;
    await audit.handleAttention(get({}), response());
    expect(calls.length).toBe(count);
    vi.setSystemTime(new Date('2026-11-10T10:01:01Z'));
    await audit.handleAttention(get({}), response());
    expect(calls.length).toBeGreaterThan(count);
  });

  it('конец суток по Москве', () => {
    expect(audit.endOfMoscowDay(Date.parse('2026-11-10T22:30:00Z')).toISOString()).toBe('2026-11-11T21:00:00.000Z');
    expect(audit.endOfMoscowDay(Date.parse('2026-11-10T20:59:00Z')).toISOString()).toBe('2026-11-10T21:00:00.000Z');
  });
});

describe('обслуживание', () => {
  it('runMaintenance зовёт rpc/admin_maintenance, крон кабинета — его', async () => {
    stub(() => ({ deliveries_deleted: 1, actions_deleted: 0 }));
    expect(await audit.runMaintenance()).toEqual({ deliveries_deleted: 1, actions_deleted: 0 });
    expect(calls[0]).toMatchObject({ url: 'rpc/admin_maintenance', method: 'POST' });
    const cabinet = readFileSync(join(root, 'api/cabinet.js'), 'utf8');
    expect(cabinet).toMatch(/_admin-audit'\)\.runMaintenance\(\)\.catch/);
  });
});
