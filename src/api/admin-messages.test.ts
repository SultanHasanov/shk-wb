// Сообщения администрации: server/_admin-messages.js, sendEmail (_notifications.js), ответ ПК (_app-messages.js).
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

type ChannelResult = { channel: string; status: string; [key: string]: unknown };
const messages = require('../../server/_admin-messages.js') as {
  MESSAGE_LIMITS: Record<string, number>;
  validateMessageBody: (body: unknown) => { error?: string; channels?: string[]; subject?: string; text?: string; link?: string | null; deviceIds?: string[]; idempotencyKey?: string };
  pcMessageText: (subject: string, body: string) => string;
  absoluteLink: (link: string) => string | null;
  telegramText: (subject: string, body: string) => string;
  deliver: (input: Record<string, unknown>) => Promise<ChannelResult[]>;
  message: (req: unknown, res: unknown, ctx: { userId: string }) => Promise<unknown>;
  notifyCompat: (req: unknown, res: unknown, ctx: { userId: string }) => Promise<unknown>;
  messageTargets: (req: unknown, res: unknown, ctx: { userId: string }) => Promise<unknown>;
};
const notifications = require('../../server/_notifications.js') as {
  sendEmail: (input: Record<string, unknown>) => Promise<{ status: string; deliveryId: string | null; providerId: string | null; error: string | null }>;
};
const appMessages = require('../../server/_app-messages.js') as {
  ack: (userId: string, device: { id: string; name?: string }, body: Record<string, unknown>) => Promise<unknown>;
  resetForTests: () => void;
};

const USER = '11111111-1111-4111-8111-111111111111';
const PC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const KEY = '0b7c1f2e-5d3a-4c1b-9e8f-112233445566';

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

/** fetch подменяем целиком: responder получает путь PostgREST (или полный адрес) и метод. */
function stub(responder: (path: string, method: string, body: any) => Response | unknown) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const full = String(url);
    const path = full.includes('/rest/v1/') ? full.split('/rest/v1/')[1] : full;
    const method = String(init.method || 'GET').toUpperCase();
    let body: any = null;
    try { body = init.body ? JSON.parse(String(init.body)) : null; } catch { body = init.body; }
    calls.push({ url: path, method, body });
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

function req(body: Record<string, unknown>) {
  return { method: 'POST', query: {}, body, headers: { 'user-agent': 'vitest', 'x-forwarded-for': '203.0.113.5' }, socket: {} };
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  appMessages.resetForTests();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('проверка тела сообщения', () => {
  const valid = { channels: ['cabinet'], subject: 'Тема', body: 'Текст', idempotencyKey: KEY };

  it('принимает корректное тело и нормализует ссылку', () => {
    expect(messages.validateMessageBody({ ...valid, link: '' })).toMatchObject({ channels: ['cabinet'], subject: 'Тема', text: 'Текст', link: null, deviceIds: [], idempotencyKey: KEY });
    expect(messages.validateMessageBody({ ...valid, link: '/cabinet/packages' }).link).toBe('/cabinet/packages');
    expect(messages.validateMessageBody({ ...valid, link: 'https://shk-wb.ru/x' }).link).toBe('https://shk-wb.ru/x');
  });

  it('ПК без выбранных компьютеров, плохая ссылка, длины и каналы — ошибка', () => {
    expect(messages.validateMessageBody({ ...valid, channels: ['pc'] }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, channels: ['pc'], deviceIds: ['nope'] }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, channels: ['pc'], deviceIds: Array.from({ length: 11 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`) }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, channels: ['pc'], deviceIds: [PC] }).deviceIds).toEqual([PC]);
    expect(messages.validateMessageBody({ ...valid, link: 'http://evil.example' }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, link: 'javascript:alert(1)' }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, link: '/a b' }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, link: `/${'a'.repeat(500)}` }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, subject: 'а'.repeat(161) }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, subject: '  ' }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, body: 'а'.repeat(4001) }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, body: 'а'.repeat(4000) }).error).toBeUndefined();
    expect(messages.validateMessageBody({ ...valid, channels: [] }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, channels: ['sms'] }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, channels: ['email', 'email'] }).error).toBeTruthy();
    expect(messages.validateMessageBody({ ...valid, idempotencyKey: '' }).error).toBeTruthy();
  });

  it('message с ошибкой в теле — 400 без единого запроса к базе', async () => {
    stub(() => []);
    const res = response();
    await messages.message(req({ channels: ['pc'], subject: 'Т', body: 'Т', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('тексты каналов', () => {
  it('pcMessageText: подпись администрации, \\r\\n → \\n, обрезка до 500 с «…»', () => {
    expect(messages.pcMessageText('Проверка', 'строка 1\r\nстрока 2')).toBe('Администрация ШК ВБ: Проверка\nстрока 1\nстрока 2');
    const long = messages.pcMessageText('Т', 'я'.repeat(600));
    expect(long).toHaveLength(500);
    expect(long.endsWith('…')).toBe(true);
    expect(messages.pcMessageText('Т', '  текст  ')).toBe('Администрация ШК ВБ: Т\n  текст');
    const exact = messages.pcMessageText('Т', 'я'.repeat(500 - 'Администрация ШК ВБ: Т\n'.length));
    expect(exact).toHaveLength(500);
    expect(exact.endsWith('я')).toBe(true);
  });

  it('absoluteLink и Telegram не длиннее 4096 без разорванной сущности', () => {
    delete process.env.PUBLIC_APP_URL;
    expect(messages.absoluteLink('/cabinet')).toBe('https://shk-wb.ru/cabinet');
    expect(messages.absoluteLink('https://a.example/b')).toBe('https://a.example/b');
    expect(messages.absoluteLink('')).toBeNull();
    const text = messages.telegramText('<Тема>', '&'.repeat(4000));
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.startsWith('<b>&lt;Тема&gt;</b>\n\n')).toBe(true);
    expect(text).toMatch(/(&amp;)+…$/);
  });
});

describe('deliver', () => {
  it('без dedupeBase бросает — постоянный ключ проглотил бы все следующие письма', async () => {
    stub(() => []);
    await expect(messages.deliver({ userId: USER, channels: ['cabinet'], subject: 'Т', body: 'Т' })).rejects.toThrow(/dedupeBase/);
    await expect(messages.deliver({ userId: USER, channels: ['cabinet'], subject: 'Т', body: 'Т', dedupeBase: '' })).rejects.toThrow(/dedupeBase/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('кабинет: тело 4000 символов уходит ровно 2000 (check body ≤ 2000), ключ admin-msg:<база>', async () => {
    stub(path => (path.startsWith('in_app_notifications') ? [{ id: 'n1' }] : []));
    const results = await messages.deliver({ userId: USER, channels: ['cabinet'], subject: 'Т', body: 'я'.repeat(4000), dedupeBase: '42' });
    expect(results).toEqual([{ channel: 'cabinet', status: 'sent', notificationId: 'n1' }]);
    const insert = calls.find(c => c.url.startsWith('in_app_notifications'))!;
    expect(insert.body.body).toHaveLength(2000);
    expect(insert.body.body.endsWith('…')).toBe(true);
    expect(insert.body.dedupe_key).toBe('admin-msg:42');
    expect(insert.body.kind).toBe('system');
  });

  it('почта без Resend: строка доставки not_configured, итог not_configured — не «отправлено»', async () => {
    stub((path, method) => {
      if (path.includes('/auth/v1/admin/users/')) return { id: USER, email: 'u@test.ru', email_confirmed_at: '2026-01-01T00:00:00Z' };
      if (path.startsWith('notification_deliveries') && method === 'POST') return [{ id: 'd1' }];
      return [];
    });
    const results = await messages.deliver({ userId: USER, channels: ['email'], subject: 'Тема', body: 'Текст', actionId: 7, dedupeBase: '7' });
    expect(results).toEqual([expect.objectContaining({ channel: 'email', status: 'not_configured', recipient: 'u@test.ru', deliveryId: 'd1' })]);
    const insert = calls.find(c => c.url.startsWith('notification_deliveries'))!;
    expect(insert.body).toMatchObject({ status: 'not_configured', channel: 'email', source: 'admin', admin_action_id: 7, dedupe_key: 'email:admin-msg:7', subject: 'Тема' });
    expect(insert.body.last_error).toMatch(/RESEND_API_KEY/);
    expect(calls.some(c => c.url.includes('api.resend.com'))).toBe(false);
  });

  it('почта без адреса и неподтверждённая — no_address / not_confirmed, без письма', async () => {
    stub(path => (path.includes('/auth/v1/admin/users/') ? { id: USER, email: `${USER}@users.invalid` } : []));
    expect(await messages.deliver({ userId: USER, channels: ['email'], subject: 'Т', body: 'Т', dedupeBase: '1' }))
      .toEqual([{ channel: 'email', status: 'no_address', recipient: null }]);
    stub(path => (path.includes('/auth/v1/admin/users/') ? { id: USER, email: 'u@test.ru', email_confirmed_at: null } : []));
    expect(await messages.deliver({ userId: USER, channels: ['email'], subject: 'Т', body: 'Т', dedupeBase: '2' }))
      .toEqual([{ channel: 'email', status: 'not_confirmed', recipient: 'u@test.ru' }]);
    expect(calls.some(c => c.url.startsWith('notification_deliveries'))).toBe(false);
  });

  it('ПК: строка доставки вставляется до отправки, сообщение — с created_by admin', async () => {
    stub((path, method) => {
      if (path.startsWith('app_devices')) return [{ id: PC, name: 'Касса', revoked_at: null }];
      if (path.startsWith('notification_deliveries') && method === 'POST') return [{ id: 'd-pc' }];
      if (path.startsWith('app_device_messages') && method === 'POST') return [{ id: MSG, device_id: PC, text: 'x', created_at: '2026-11-10T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', created_by: 'admin' }];
      return [];
    });
    const results = await messages.deliver({ userId: USER, channels: ['pc'], subject: 'Т', body: 'Привет', deviceIds: [PC], actionId: 9, dedupeBase: '9' });
    expect(results).toEqual([{ channel: 'pc', deviceId: PC, deviceName: 'Касса', online: false, status: 'queued', messageId: MSG }]);
    const deliveryIdx = calls.findIndex(c => c.url.startsWith('notification_deliveries') && c.method === 'POST');
    const messageIdx = calls.findIndex(c => c.url.startsWith('app_device_messages') && c.method === 'POST');
    expect(deliveryIdx).toBeGreaterThanOrEqual(0);
    expect(messageIdx).toBeGreaterThan(deliveryIdx);
    expect(calls[deliveryIdx].body).toMatchObject({ channel: 'pc', status: 'pending', recipient: 'Касса', dedupe_key: `pc:admin-msg:9:${PC}`, admin_action_id: 9 });
    expect(calls[messageIdx].body).toMatchObject({ created_by: 'admin', device_id: PC, text: 'Администрация ШК ВБ: Т\nПривет' });
    const patch = calls.find(c => c.url.startsWith('notification_deliveries?id=eq.d-pc') && c.method === 'PATCH')!;
    expect(patch.body).toEqual({ channel_ref: MSG });
  });

  it('ПК: повтор (409 на строке доставки) — duplicate, второго сообщения нет', async () => {
    stub((path, method) => {
      if (path.startsWith('app_devices')) return [{ id: PC, name: 'Касса' }];
      if (path.startsWith('notification_deliveries') && method === 'POST') return json({ code: '23505' }, 409);
      if (path.startsWith('notification_deliveries?dedupe_key=eq.') && method === 'GET') return [{ id: 'd-pc', status: 'pending', last_error: null }];
      return [];
    });
    const results = await messages.deliver({ userId: USER, channels: ['pc'], subject: 'Т', body: 'Т', deviceIds: [PC], dedupeBase: '9' });
    expect(results).toEqual([expect.objectContaining({ channel: 'pc', status: 'duplicate', deviceId: PC })]);
    expect(calls.some(c => c.url.startsWith('app_device_messages') && c.method === 'POST')).toBe(false);
    expect(calls.find(c => c.url.startsWith('notification_deliveries?dedupe_key=eq.'))!.url).toContain(encodeURIComponent(`pc:admin-msg:9:${PC}`));
  });

  it('повтор после неудачи: существующая строка failed/not_configured — её итог, а не «доставлено»', async () => {
    stub((path, method) => {
      if (path.startsWith('app_devices')) return [{ id: PC, name: 'Касса' }];
      if (path.includes('/auth/v1/admin/users/')) return { id: USER, email: 'u@test.ru', email_confirmed_at: '2026-01-01T00:00:00Z' };
      if (path.startsWith('user_telegram_identities')) return [{ telegram_user_id: 55, username: 'ivan' }];
      if (path.startsWith('telegram_bot_subscribers') && method === 'GET') return [{ telegram_user_id: 55, chat_id: 55, blocked_at: null }];
      if (path.startsWith('notification_deliveries') && method === 'POST') return json({ code: '23505' }, 409);
      if (path.startsWith('notification_deliveries?dedupe_key=eq.')) {
        if (path.includes(encodeURIComponent('email:admin-msg:9'))) return [{ id: 'd-mail', status: 'not_configured', last_error: 'Почта не настроена' }];
        if (path.includes(encodeURIComponent('tg:admin-msg:9'))) return [{ id: 'd-tg', status: 'failed', last_error: 'Bad Gateway' }];
        return [{ id: 'd-pc', status: 'failed', last_error: 'Слишком много сообщений' }];
      }
      return [];
    });
    const results = await messages.deliver({ userId: USER, channels: ['email', 'telegram', 'pc'], subject: 'Т', body: 'Т', deviceIds: [PC], dedupeBase: '9' });
    expect(results).toEqual([
      expect.objectContaining({ channel: 'email', status: 'not_configured', deliveryId: 'd-mail' }),
      expect.objectContaining({ channel: 'telegram', status: 'failed', deliveryId: 'd-tg', error: 'Bad Gateway' }),
      expect.objectContaining({ channel: 'pc', status: 'failed', deliveryId: 'd-pc' }),
    ]);
    expect(calls.some(c => c.url.includes('api.telegram.org') || c.url.startsWith('app_device_messages'))).toBe(false);
  });

  it('Telegram: не привязан / бот не запущен / заблокирован — без отправки', async () => {
    stub(() => []);
    expect(await messages.deliver({ userId: USER, channels: ['telegram'], subject: 'Т', body: 'Т', dedupeBase: '3' })).toEqual([{ channel: 'telegram', status: 'not_linked', recipient: null }]);
    stub(path => (path.startsWith('user_telegram_identities') ? [{ telegram_user_id: 55, username: 'ivan' }] : []));
    expect(await messages.deliver({ userId: USER, channels: ['telegram'], subject: 'Т', body: 'Т', dedupeBase: '3' })).toEqual([{ channel: 'telegram', status: 'not_started', recipient: '@ivan' }]);
    stub(path => (path.startsWith('user_telegram_identities') ? [{ telegram_user_id: 55, username: null }]
      : path.startsWith('telegram_bot_subscribers') ? [{ telegram_user_id: 55, chat_id: 55, blocked_at: '2026-11-01T00:00:00Z' }] : []));
    expect(await messages.deliver({ userId: USER, channels: ['telegram'], subject: 'Т', body: 'Т', dedupeBase: '3' })).toEqual([{ channel: 'telegram', status: 'blocked', recipient: 'tg:55' }]);
    expect(calls.some(c => c.url.startsWith('notification_deliveries'))).toBe(false);
  });

  it('Telegram: строка доставки до отправки, бот заблокирован → blocked и отметка подписчика', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'token';
    delete process.env.TELEGRAM_API_BASE;
    try {
      stub((path, method) => {
        if (path.startsWith('user_telegram_identities')) return [{ telegram_user_id: 55, username: 'ivan' }];
        if (path.startsWith('telegram_bot_subscribers') && method === 'GET') return [{ telegram_user_id: 55, chat_id: 55, blocked_at: null }];
        if (path.startsWith('notification_deliveries') && method === 'POST') return [{ id: 'd-tg' }];
        if (path.includes('api.telegram.org')) return json({ ok: false, description: 'Forbidden: bot was blocked by the user' }, 403);
        return [];
      });
      const results = await messages.deliver({ userId: USER, channels: ['telegram'], subject: 'Т', body: 'Т', link: '/cabinet', dedupeBase: '5' });
      expect(results[0]).toMatchObject({ channel: 'telegram', status: 'blocked', recipient: '@ivan', deliveryId: 'd-tg' });
      const insertIdx = calls.findIndex(c => c.url.startsWith('notification_deliveries') && c.method === 'POST');
      const sendIdx = calls.findIndex(c => c.url.includes('api.telegram.org'));
      expect(sendIdx).toBeGreaterThan(insertIdx);
      expect(calls[insertIdx].body).toMatchObject({ channel: 'telegram', status: 'pending', recipient: '55', channel_ref: '@ivan', dedupe_key: 'tg:admin-msg:5' });
      expect(calls[sendIdx].body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Открыть', url: 'https://shk-wb.ru/cabinet' }]] });
      expect(calls.some(c => c.url.startsWith('telegram_bot_subscribers?telegram_user_id=eq.55') && c.method === 'PATCH' && c.body.blocked_at)).toBe(true);
      expect(calls.some(c => c.url.startsWith('notification_deliveries?id=eq.d-tg') && c.body?.status === 'blocked')).toBe(true);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it('Telegram: свой текст и кнопки бота вместо ссылки в кабинет, кабинет получает прежний текст', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'token';
    delete process.env.TELEGRAM_API_BASE;
    try {
      stub((path, method) => {
        if (path.startsWith('user_telegram_identities')) return [{ telegram_user_id: 55, username: 'ivan' }];
        if (path.startsWith('telegram_bot_subscribers') && method === 'GET') return [{ telegram_user_id: 55, chat_id: 55, blocked_at: null }];
        if (path.startsWith('notification_deliveries') && method === 'POST') return [{ id: 'd-tg' }];
        if (path.startsWith('user_notifications') && method === 'POST') return [{ id: 'n-1' }];
        if (path.includes('api.telegram.org')) return { ok: true, result: { message_id: 9 } };
        return [];
      });
      const keyboard = [[{ text: '👤 Профиль', callback_data: 'menu:profile' }]];
      const results = await messages.deliver({
        userId: USER, channels: ['cabinet', 'telegram'], subject: 'Баланс пополнен', body: 'Для кабинета', link: '/cabinet', dedupeBase: '6',
        telegram: { subject: '🎁 Поддержка начислила вам 100 ₽', body: 'Причина: тест', keyboard },
      });
      expect(results.find(r => r.channel === 'telegram')).toMatchObject({ status: 'sent' });
      const send = calls.find(c => c.url.includes('api.telegram.org'))!;
      expect(send.body.text).toBe('<b>🎁 Поддержка начислила вам 100 ₽</b>\n\nПричина: тест');
      expect(send.body.reply_markup).toEqual({ inline_keyboard: keyboard });
      expect(JSON.stringify(send.body)).not.toContain('/cabinet');
      const cabinet = calls.find(c => c.url.startsWith('user_notifications') && c.method === 'POST');
      if (cabinet) expect(JSON.stringify(cabinet.body)).toContain('Для кабинета');
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });
});

describe('sendEmail', () => {
  it('без Resend и без recordUnconfigured — строку не пишет (старые вызовы как раньше)', async () => {
    stub(() => []);
    const result = await notifications.sendEmail({ userId: USER, notificationId: null, to: 'u@test.ru', subject: 'Т', text: 'Т', dedupeKey: 'email:x' });
    expect(result.status).toBe('not_configured');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('повтор dedupeKey без Resend — duplicate', async () => {
    stub(() => json({ code: '23505' }, 409));
    const result = await notifications.sendEmail({ userId: USER, to: 'u@test.ru', subject: 'Т', text: 'Т', dedupeKey: 'email:x', recordUnconfigured: true });
    expect(result.status).toBe('duplicate');
  });

  it('с Resend: sent с providerId, строка доставки с source и admin_action_id', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'no-reply@shk-wb.ru';
    stub((path, method) => {
      if (path.includes('api.resend.com')) return { id: 'resend-1' };
      if (path.startsWith('notification_deliveries') && method === 'POST') return [{ id: 'd1' }];
      return [];
    });
    const result = await notifications.sendEmail({ userId: USER, to: 'u@test.ru', subject: 'Т', text: 'Т', dedupeKey: 'email:y', source: 'admin', adminActionId: 3 });
    expect(result).toEqual({ status: 'sent', providerId: 'resend-1', deliveryId: 'd1', error: null });
    expect(calls[0].body).toMatchObject({ source: 'admin', admin_action_id: 3, subject: 'Т' });
  });
});

describe('message: ключ повтора', () => {
  it('первая отправка: журнал → кабинет с ключом admin-msg:<id> → 201 с итогом', async () => {
    stub((path, method) => {
      if (path.startsWith('rpc/consume_api_rate_limit')) return true;
      if (path.startsWith('admin_actions') && method === 'POST') return [{ id: 42 }];
      if (path.startsWith('in_app_notifications')) return [{ id: 'n42' }];
      return [];
    });
    const res = response();
    await messages.message(req({ channels: ['cabinet'], subject: 'Тема', body: 'Текст', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ actionId: 42, messageRef: 'msg_42', subject: 'Тема', summary: { ok: 1, total: 1 }, results: [{ channel: 'cabinet', status: 'sent' }] });
    const begin = calls.find(c => c.url.startsWith('admin_actions') && c.method === 'POST')!;
    expect(begin.body).toMatchObject({ action: 'message', idempotency_key: `message:${KEY}`, result: 'pending', payload: { channels: ['cabinet'], subject: 'Тема', body: 'Текст' } });
    expect(calls.find(c => c.url.startsWith('in_app_notifications'))!.body.dedupe_key).toBe('admin-msg:42');
    const finish = calls.find(c => c.url.startsWith('admin_actions?id=eq.42') && c.method === 'PATCH')!;
    expect(finish.body).toMatchObject({ result: 'ok', after: { channels: ['cabinet'], delivered: '1 из 1' } });
  });

  it('повтор с тем же ключом — тот же ответ, replayed:true, ничего не отправляется', async () => {
    const stored = { actionId: 42, messageRef: 'msg_42', sentAt: '2026-11-10T10:00:00.000Z', subject: 'Тема', results: [{ channel: 'cabinet', status: 'sent' }], summary: { ok: 1, total: 1 }, __status: 201 };
    stub((path, method) => {
      if (path.startsWith('rpc/consume_api_rate_limit')) return true;
      if (path.startsWith('admin_actions') && method === 'POST') return json({ code: '23505' }, 409);
      if (path.startsWith('admin_actions') && method === 'GET') return [{ id: 42, result: 'ok', response: stored, created_at: '2026-11-10T10:00:00.000Z' }];
      return [];
    });
    const res = response();
    await messages.message(req({ channels: ['cabinet'], subject: 'Тема', body: 'Текст', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(201);
    const { __status, ...expected } = stored;
    expect(res.body).toEqual({ ...expected, replayed: true });
    expect(calls.some(c => c.url.startsWith('in_app_notifications') || c.url.startsWith('notification_deliveries'))).toBe(false);
  });

  it('повтор после итога error (строку журнала забрали заново) — снова error, а не «1 из 1»', async () => {
    stub((path, method) => {
      if (path.startsWith('rpc/consume_api_rate_limit')) return true;
      if (path.startsWith('admin_actions') && method === 'POST') return json({ code: '23505' }, 409);
      if (path.startsWith('admin_actions?idempotency_key=') && method === 'GET') return [{ id: 42, result: 'error', response: { __status: 201 }, created_at: '2026-11-10T10:00:00.000Z' }];
      if (path.startsWith('admin_actions?id=eq.42') && method === 'PATCH' && path.includes('result=eq.error')) return [{ id: 42 }];
      if (path.includes('/auth/v1/admin/users/')) return { id: USER, email: 'u@test.ru', email_confirmed_at: '2026-01-01T00:00:00Z' };
      if (path.startsWith('notification_deliveries') && method === 'POST') return json({ code: '23505' }, 409);
      if (path.startsWith('notification_deliveries?dedupe_key=eq.')) return [{ id: 'd-mail', status: 'not_configured', last_error: 'Почта не настроена' }];
      return [];
    });
    const res = response();
    await messages.message(req({ channels: ['email'], subject: 'Тема', body: 'Текст', idempotencyKey: KEY }), res, { userId: USER });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ summary: { ok: 0, total: 1 }, results: [{ channel: 'email', status: 'not_configured' }] });
    const finish = calls.find(c => c.url.startsWith('admin_actions?id=eq.42') && c.method === 'PATCH' && c.body?.result !== 'pending')!;
    expect(finish.body).toMatchObject({ result: 'error', after: { delivered: '0 из 1' } });
  });

  it('старое окно notify без ключа — кабинет + почта, ответ {sent, results}', async () => {
    stub((path, method) => {
      if (path.startsWith('admin_actions') && method === 'POST') return [{ id: 77 }];
      if (path.startsWith('in_app_notifications')) return [{ id: 'n77' }];
      if (path.includes('/auth/v1/admin/users/')) return { id: USER, email: 'u@test.ru', email_confirmed_at: '2026-01-01T00:00:00Z' };
      if (path.startsWith('notification_deliveries')) return [{ id: 'd77' }];
      return [];
    });
    const res = response();
    await messages.notifyCompat(req({ title: 'Заголовок', body: 'Текст' }), res, { userId: USER });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ sent: true, results: [{ channel: 'cabinet', status: 'sent' }, { channel: 'email', status: 'not_configured' }] });
    const begin = calls.find(c => c.url.startsWith('admin_actions') && c.method === 'POST')!;
    expect(begin.body.action).toBe('notify');
    expect(begin.body.idempotency_key).toMatch(/^notify:compat-/);
  });
});

describe('рассылки (_admin-cabinet.js)', () => {
  const cabinet = require('../../server/_admin-cabinet.js') as (req: unknown, res: unknown) => Promise<unknown>;
  const adminAuth = require('../../server/_admin-auth.js') as { createSessionCookie: () => string };
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const cabinetReq = (action: string, body: Record<string, unknown>) => {
    process.env.ADMIN_SESSION_SECRET = 'admin-session-secret-for-tests-0123456789';
    const cookie = adminAuth.createSessionCookie().split(';')[0];
    return { method: 'POST', query: { cabinet: action }, body, headers: { cookie, 'user-agent': 'vitest' }, socket: {} };
  };

  it('новость: письмо каждому подписчику со своим ключом email:news:<кампания>:<user_id>', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'no-reply@shk-wb.ru';
    try {
      stub((path, method) => {
        if (path.startsWith('user_preferences')) return [{ user_id: USER }, { user_id: OTHER }];
        if (path.includes('/auth/v1/admin/users/')) return { id: path.includes(OTHER) ? OTHER : USER, email: path.includes(OTHER) ? 'b@test.ru' : 'a@test.ru' };
        if (path.startsWith('admin_actions') && method === 'POST') return [{ id: 61 }];
        if (path.startsWith('in_app_notifications')) return [{ id: `n-${calls.length}` }];
        if (path.includes('api.resend.com')) return { id: 'resend-x' };
        if (path.startsWith('notification_deliveries') && method === 'POST') return [{ id: `d-${calls.length}` }];
        return [];
      });
      const res = response();
      await cabinet(cabinetReq('news', { title: 'Новое', body: 'Текст', idempotencyKey: KEY }), res);
      expect(res.statusCode).toBe(201);
      expect(res.body).toMatchObject({ sent: 2, emails: 2, campaign: KEY });
      const inserts = calls.filter(c => c.url.startsWith('notification_deliveries') && c.method === 'POST').map(c => c.body.dedupe_key).sort();
      expect(inserts).toEqual([`email:news:${KEY}:${USER}`, `email:news:${KEY}:${OTHER}`].sort());
      expect(calls.filter(c => c.url.includes('api.resend.com'))).toHaveLength(2);
      expect(calls.filter(c => c.url.startsWith('in_app_notifications')).every(c => c.body.dedupe_key === `news:${KEY}`)).toBe(true);
    } finally {
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_FROM_EMAIL;
    }
  });

  it('рассылка в Telegram: строки доставки до отправки, повтор с тем же ключом шлёт только тем, до кого не дошло', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'token';
    delete process.env.TELEGRAM_API_BASE;
    try {
      const subscribers = [1, 2, 3].map(id => ({ telegram_user_id: id, chat_id: id * 10, username: `u${id}`, first_name: null, last_name: null }));
      // Прошлый круг с этим ключом: до 1 дошло (sent), у 2 — сбой (failed), до 3 не добрались.
      const existing = new Map<string, string>([[`bc:${KEY}:1`, 'sent'], [`bc:${KEY}:2`, 'failed']]);
      stub((path, method, body) => {
        if (path.startsWith('admin_actions') && method === 'POST') return json({ code: '23505' }, 409);
        if (path.startsWith('admin_actions?idempotency_key=')) return [{ id: 70, result: 'error', response: {}, created_at: '2026-11-10T10:00:00.000Z' }];
        if (path.startsWith('admin_actions?id=eq.70') && method === 'PATCH') return [{ id: 70 }];
        if (path.startsWith('telegram_bot_subscribers?blocked_at=is.null') && method === 'GET') return path.includes('telegram_user_id=gt.') ? [] : subscribers;
        if (path.startsWith('notification_deliveries?on_conflict=dedupe_key') && method === 'POST') {
          return (body as Array<{ dedupe_key: string }>).filter(row => !existing.has(row.dedupe_key)).map(row => ({ id: `new-${row.dedupe_key}`, dedupe_key: row.dedupe_key }));
        }
        if (path.startsWith('notification_deliveries?dedupe_key=in.') && method === 'PATCH') {
          return [...existing].filter(([key, status]) => status === 'failed' && decodeURIComponent(path).includes(`"${key}"`)).map(([key]) => ({ id: `old-${key}`, dedupe_key: key }));
        }
        if (path.includes('api.telegram.org')) return { ok: true, result: { message_id: 1 } };
        return [];
      });
      const res = response();
      await cabinet(cabinetReq('telegram-broadcast', { text: 'Привет, {name}', idempotencyKey: KEY }), res);
      expect(res.statusCode).toBe(201);
      expect(res.body).toMatchObject({ sent: 2, failed: 0, blocked: 0, total: 3, alreadySent: 1 });
      const sentTo = calls.filter(c => c.url.includes('api.telegram.org')).map(c => c.body.chat_id).sort();
      expect(sentTo).toEqual([20, 30]);
      const claim = calls.find(c => c.url.startsWith('notification_deliveries?on_conflict=dedupe_key'))!;
      expect(claim.body[0]).toMatchObject({ channel: 'telegram', source: 'broadcast', status: 'pending', admin_action_id: 70, recipient: '10', channel_ref: '@u1' });
      const firstSend = calls.findIndex(c => c.url.includes('api.telegram.org'));
      expect(calls.indexOf(claim)).toBeLessThan(firstSend);
      const settled = calls.find(c => c.url.startsWith('notification_deliveries?id=in.') && c.method === 'PATCH')!;
      expect(settled.body).toMatchObject({ status: 'sent' });
      expect(decodeURIComponent(settled.url)).toContain(`old-bc:${KEY}:2`);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });
});

describe('messageTargets', () => {
  it('почта не подтверждена, бот не запущен, ПК есть — доступность с причинами', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'no-reply@shk-wb.ru';
    stub(path => {
      if (path.includes('/auth/v1/admin/users/')) return { id: USER, email: 'u@test.ru', email_confirmed_at: null };
      if (path.startsWith('user_telegram_identities')) return [{ telegram_user_id: 55, username: 'ivan' }];
      if (path.startsWith('app_devices')) return [{ id: PC, name: 'Касса', last_seen_at: '2026-11-10T09:00:00Z', role: 'work' }];
      if (path.startsWith('app_device_messages')) return [{ device_id: PC }, { device_id: PC }];
      return [];
    });
    const res = response();
    await messages.messageTargets({ method: 'GET', query: { userId: USER }, headers: {} }, res, { userId: USER });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      cabinet: { available: true },
      email: { available: false, address: 'u@test.ru', confirmed: false, configured: true, reason: 'not_confirmed' },
      telegram: { available: false, username: 'ivan', reason: 'not_started', blockedAt: null },
      pc: { available: true, reason: null, devices: [{ id: PC, name: 'Касса', online: false, lastSeenAt: '2026-11-10T09:00:00Z', role: 'work', openMessages: 2 }] },
    });
  });

  it('нет пользователя — 404', async () => {
    stub(path => (path.includes('/auth/v1/admin/users/') ? json({ message: 'not found' }, 404) : []));
    const res = response();
    await messages.messageTargets({ method: 'GET', query: {}, headers: {} }, res, { userId: USER });
    expect(res.statusCode).toBe(404);
  });
});

describe('ответ ПК на сообщение администрации', () => {
  it('уходит админам в Telegram, уведомления в кабинет владельцу нет', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'token';
    process.env.ADMIN_PAYMENT_TELEGRAM_IDS = '111';
    delete process.env.TELEGRAM_API_BASE;
    try {
      stub((path, method) => {
        if (path.startsWith('app_device_messages') && method === 'PATCH') return [{
          id: MSG, user_id: USER, device_id: PC, text: 'Проверьте кассу', created_at: '2026-11-10T09:00:00Z', expires_at: '2099-01-01T00:00:00Z',
          delivered_at: '2026-11-10T09:00:00Z', read_at: '2026-11-10T09:01:00Z', answered_at: '2026-11-10T09:02:00Z',
          answer_kind: 'reply', reply_text: 'Проверил', created_by: 'admin',
        }];
        if (path.includes('api.telegram.org')) return { ok: true, result: { message_id: 1 } };
        return [];
      });
      const result = await appMessages.ack(USER, { id: PC, name: 'Касса' }, { id: MSG, status: 'reply', reply: 'Проверил' }) as { createdBy: string };
      expect(result.createdBy).toBe('admin');
      const sent = calls.filter(c => c.url.includes('api.telegram.org'));
      expect(sent).toHaveLength(1);
      expect(sent[0].body.chat_id).toBe('111');
      expect(sent[0].body.text).toContain('на сообщение администрации');
      expect(sent[0].body.text).toContain(USER);
      expect(sent[0].body.text).toContain('Проверил');
      expect(calls.some(c => c.url.startsWith('in_app_notifications'))).toBe(false);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.ADMIN_PAYMENT_TELEGRAM_IDS;
    }
  });
});
