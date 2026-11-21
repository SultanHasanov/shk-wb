import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Приглашение в общий чат после покупки или генерации (server/_chat-invite.js): без срока,
// каждому один раз, кто уже в чате — не получает.

const require = createRequire(import.meta.url);
const invite = require('../../server/_chat-invite.js') as {
  inviteActive: (now?: number) => boolean;
  sendInvite: (telegramId: number) => Promise<string>;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let sent: Array<{ method: string; body: Record<string, any> }>;
let claimed: Set<string>;
let memberStatus: string;

beforeEach(() => {
  sent = []; claimed = new Set(); memberStatus = 'left';
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
  process.env.SUPPORT_CHAT_URL = 'https://t.me/wbtools_chat';
  process.env.SUPPORT_CHAT_ID = '-1004465478259';
  process.env.SUPPORT_CHAT_INVITE_UNTIL = new Date(Date.now() + 60_000).toISOString();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const address = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (address.startsWith('https://db.test')) {
      // api_rate_limits с ignore-duplicates: новая строка — вернётся, повтор — пусто
      const key = `${body.scope}:${body.key_hash}`;
      if (claimed.has(key)) return json([], 201);
      claimed.add(key);
      return json([body], 201);
    }
    const method = address.split('/').pop() || '';
    sent.push({ method, body });
    if (method === 'getChatMember') return json({ ok: true, result: { status: memberStatus, user: { id: body.user_id } } });
    return json({ ok: true, result: { message_id: 1 } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPPORT_CHAT_URL;
  delete process.env.SUPPORT_CHAT_ID;
  delete process.env.SUPPORT_CHAT_INVITE_UNTIL;
});

describe('приглашение в чат', () => {
  it('первый раз — сообщение с кнопкой чата, второй раз — уже нет', async () => {
    expect(await invite.sendInvite(5001)).toBe('sent');
    const message = sent.find(call => call.method === 'sendMessage');
    expect(message?.body.chat_id).toBe(5001);
    expect(message?.body.text).toContain('Чат · WB Инструменты');
    expect(message?.body.reply_markup.inline_keyboard[0][0]).toEqual({ text: '💬 Перейти в чат', url: 'https://t.me/wbtools_chat' });
    sent = [];
    expect(await invite.sendInvite(5001)).toBe('already');
    expect(sent.some(call => call.method === 'sendMessage')).toBe(false);
  });

  it('кто уже в чате — не приглашаем', async () => {
    memberStatus = 'member';
    expect(await invite.sendInvite(5002)).toBe('member');
    expect(sent.some(call => call.method === 'sendMessage')).toBe(false);
  });

  it('после срока акции и без адреса чата — ничего', async () => {
    process.env.SUPPORT_CHAT_INVITE_UNTIL = new Date(Date.now() - 1000).toISOString();
    expect(await invite.sendInvite(5003)).toBe('inactive');
    process.env.SUPPORT_CHAT_INVITE_UNTIL = new Date(Date.now() + 60_000).toISOString();
    delete process.env.SUPPORT_CHAT_URL;
    expect(await invite.sendInvite(5003)).toBe('inactive');
    expect(sent).toHaveLength(0);
  });

  it('по умолчанию — без срока', () => {
    delete process.env.SUPPORT_CHAT_INVITE_UNTIL;
    expect(invite.inviteActive(Date.parse('2026-11-23T00:01:00+03:00'))).toBe(true);
    expect(invite.inviteActive(Date.parse('2030-01-01T00:00:00+03:00'))).toBe(true);
  });
});
