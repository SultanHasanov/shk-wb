import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as { processUpdate: (update: Record<string, unknown>) => Promise<void> };
const userCache = require('../../server/_telegram-user-cache.js') as { clearTelegramUserCache: () => void };

const ADMIN = 439335621;
const RECIPIENT = 716976910;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const adminFrom = { id: ADMIN, first_name: 'admin' };
const command = (text: string, id = 1) => ({ update_id: id, message: { message_id: id, text, from: adminFrom, chat: { id: ADMIN, type: 'private' } } });
const press = (data: string, from: Record<string, unknown> = adminFrom, id = 2) => ({ update_id: id, callback_query: { id: String(id), data, from, message: { message_id: 50, chat: { id: from.id, type: 'private' } } } });

describe('команда /bonus целиком', () => {
  let sent: Array<{ method: string; body: Record<string, any> }>;
  let moves: Array<Record<string, any>>;
  let sessionWrites: number;

  beforeEach(() => {
    sent = []; moves = []; sessionWrites = 0;
    userCache.clearTelegramUserCache();
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SECRET_KEY = 'secret';
    process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
    process.env.TELEGRAM_LOCAL_POLLING = '1';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const address = String(url);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (!address.startsWith('https://db.test')) {
        sent.push({ method: address.split('/').pop() || '', body });
        return json({ ok: true, result: { message_id: 77 } });
      }
      if (address.includes('telegram_generator_sessions') && init.method === 'POST') { sessionWrites += 1; return json({ code: '23514' }, 400); }
      if (address.includes('telegram_bot_subscribers')) return json([{ telegram_user_id: RECIPIENT, chat_id: RECIPIENT, username: 'vavilovaaag', first_name: 'Аня' }]);
      if (address.includes('user_telegram_identities')) return json([{ user_id: 'user-1' }]);
      if (address.includes('wallet_accounts')) return json([{ balance_kopecks: 1000 }]);
      if (address.includes('rpc/wallet_move')) { moves.push(body); return json({ ok: true, duplicate: false, balance: 51000 }); }
      return json([]);
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_LOCAL_POLLING;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  const nonceFrom = () => {
    const confirm = sent.find(call => call.method === 'sendMessage' && JSON.stringify(call.body).includes('bn:ok:'));
    return /bn:ok:([0-9a-f]{12})/.exec(JSON.stringify(confirm?.body))?.[1] || '';
  };
  const textOf = (chatId: number) => sent.filter(call => call.body.chat_id === chatId).map(call => String(call.body.text || '').replace(/\s/g, ' '));

  it('спрашивает, начисляет один раз и уведомляет получателя', async () => {
    await bot.processUpdate(command('/bonus @vavilovaaag 500 За тест'));
    expect(sessionWrites).toBe(0);
    expect(moves).toHaveLength(0);
    expect(textOf(ADMIN).join(' ')).not.toContain('внутренняя ошибка');
    expect(textOf(ADMIN).join(' ')).toContain('+500 ₽');
    const nonce = nonceFrom();
    expect(nonce).not.toBe('');

    await bot.processUpdate(press(`bn:ok:${nonce}`));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ p_user: 'user-1', p_kopecks: 50000, p_kind: 'bonus', p_event_key: `admin_bonus:${nonce}`, p_details: { note: 'За тест', by: ADMIN } });
    const notice = textOf(RECIPIENT).join(' ');
    expect(notice).toContain('Вам начислен бонус');
    expect(notice).toContain('+500 ₽');
    expect(notice).toContain('510 ₽');

    // Повторное нажатие денег не добавляет.
    await bot.processUpdate(press(`bn:ok:${nonce}`, adminFrom, 3));
    expect(moves).toHaveLength(1);
  });

  it('«Отмена» и чужое нажатие не начисляют', async () => {
    await bot.processUpdate(command('/bonus @vavilovaaag 500'));
    const nonce = nonceFrom();
    await bot.processUpdate(press(`bn:ok:${nonce}`, { id: 123456, first_name: 'чужой' }));
    expect(moves).toHaveLength(0);
    await bot.processUpdate(press(`bn:no:${nonce}`, adminFrom, 3));
    await bot.processUpdate(press(`bn:ok:${nonce}`, adminFrom, 4));
    expect(moves).toHaveLength(0);
  });
});
