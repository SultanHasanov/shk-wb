import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Чат поддержки (server/_support-chat.js) через processUpdate бота: удаление, причина в чате, сообщение владельцу,
// кнопки владельца, команды, чужие группы и личный чат.

const require = createRequire(import.meta.url);
const bot = require('../../server/_telegram-wb-bot.js') as {
  processUpdate: (update: Record<string, unknown>) => Promise<void>;
  syncBotCommands: () => Promise<unknown>;
  SUPPORT_CHAT_COMMANDS: unknown[];
};
const supportChat = require('../../server/_support-chat.js') as { resetSupportChatState: () => void };

const CHAT = { id: -1001234567890, type: 'supergroup', title: 'Поддержка', username: 'shk_wb_chat' };
const OWNER = 111;
const GROUP_ADMIN = 222;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

let sent: Array<{ method: string; body: Record<string, any> }>;
let db: Array<{ method: string; path: string; body: any }>;
let updateId = 90000;
let userSeq = 500000;
let user = { id: 0, first_name: 'Иван', username: 'ivan_pvz' };

const say = (text: string, extra: Record<string, unknown> = {}, from: Record<string, unknown> = user, chat: Record<string, unknown> = CHAT) =>
  ({ update_id: ++updateId, message: { message_id: updateId, date: 1, chat, from, text, ...extra } });
const calls = (method: string) => sent.filter(call => call.method === method);

beforeEach(() => {
  sent = []; db = [];
  user = { id: ++userSeq, first_name: 'Иван', username: 'ivan_pvz' };
  supportChat.resetSupportChatState();
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SECRET_KEY = 'secret';
  process.env.TELEGRAM_BOT_TOKEN = '1:' + 'a'.repeat(30);
  process.env.TELEGRAM_LOCAL_POLLING = '1';
  process.env.SUPPORT_CHAT_ID = String(CHAT.id);
  process.env.ADMIN_PAYMENT_TELEGRAM_IDS = String(OWNER);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const address = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (!address.startsWith('https://db.test')) {
      const method = address.split('/').pop() || '';
      sent.push({ method, body: body || {} });
      if (method === 'getMe') return json({ ok: true, result: { username: 'shkwb_bot' } });
      if (method === 'getChatAdministrators') return json({ ok: true, result: [{ status: 'administrator', user: { id: GROUP_ADMIN } }] });
      if (method === 'getChat') return body?.chat_id === '@spam_channel'
        ? json({ ok: true, result: { id: -100777, type: 'channel' } })
        : json({ ok: false, description: 'Bad Request: chat not found' }, 400);
      return json({ ok: true, result: { message_id: 7 } });
    }
    const path = decodeURIComponent(address.split('/rest/v1/')[1] || '');
    db.push({ method: String(init.method || 'GET'), path, body });
    if (path.startsWith('support_chat_warnings') && init.method === 'POST') return json([{ id: 42 }], 201);
    if (path.startsWith('support_chat_warnings')) return json([], 200, { 'content-range': '0-0/2' });
    if (path.startsWith('telegram_bot_subscribers')) return json([]);
    return json([]);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.SUPPORT_CHAT_ID;
  delete process.env.ADMIN_PAYMENT_TELEGRAM_IDS;
});

describe('модерация чата поддержки', () => {
  it('чужая ссылка: удалить, причина в чате, предупреждение в базу, владельцу — кто, за что, кнопки', async () => {
    const url = 'https://example.com/promo';
    await bot.processUpdate(say(`вот тут дешевле ${url}`, { entities: [{ type: 'url', offset: 17, length: url.length }] }));
    expect(calls('deleteMessage')[0].body).toEqual({ chat_id: CHAT.id, message_id: updateId });
    const notices = calls('sendMessage');
    const inChat = notices.find(call => call.body.chat_id === CHAT.id);
    expect(inChat?.body.text).toContain('сообщение удалено');
    expect(inChat?.body.text).toContain('в целях безопасности');
    const toOwner = notices.find(call => call.body.chat_id === String(OWNER));
    expect(toOwner?.body.text).toContain('Предупреждение в чате поддержки');
    expect(toOwner?.body.text).toContain(String(user.id));
    expect(toOwner?.body.text).toContain('Сторонняя ссылка');
    expect(toOwner?.body.text).toContain('Предупреждений за 30 дней: <b>2</b>');
    expect(toOwner?.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual([`md:mute:${user.id}`, `md:ban:${user.id}`, 'md:ok:42']);
    const saved = db.find(call => call.path === 'support_chat_warnings' && call.method === 'POST');
    expect(saved?.body).toMatchObject({ chat_id: CHAT.id, telegram_user_id: user.id, rule: 'link' });
    // бот сам не мутит и не банит
    expect(calls('restrictChatMember')).toHaveLength(0);
    expect(calls('banChatMember')).toHaveLength(0);
  });

  it('ссылка на WB и обычный вопрос — не трогает', async () => {
    const url = 'https://www.wildberries.ru/catalog/1/detail.aspx';
    await bot.processUpdate(say(`товар ${url}`, { entities: [{ type: 'url', offset: 6, length: url.length }] }));
    await bot.processUpdate(say('Подскажите, как продлить Помощник?'));
    expect(calls('deleteMessage')).toHaveLength(0);
    expect(calls('sendMessage')).toHaveLength(0);
  });

  it('мат удаляется; правка сообщения проверяется заново', async () => {
    await bot.processUpdate(say('бля, принтер не печатает'));
    expect(calls('deleteMessage')).toHaveLength(1);
    sent = [];
    await bot.processUpdate({ update_id: ++updateId, edited_message: { message_id: 5, date: 1, edit_date: 2, chat: CHAT, from: user, text: 'теперь тут пиздец' } });
    expect(calls('deleteMessage')[0]?.body.message_id).toBe(5);
  });

  it('упоминание чужого канала удаляется, участника — нет', async () => {
    await bot.processUpdate(say('подпишитесь @spam_channel', { entities: [{ type: 'mention', offset: 12, length: 13 }] }));
    expect(calls('deleteMessage')).toHaveLength(1);
    sent = [];
    await bot.processUpdate(say('спроси у @vasya_pvz', { entities: [{ type: 'mention', offset: 9, length: 10 }] }));
    expect(calls('deleteMessage')).toHaveLength(0);
  });

  it('админов чата и владельца не модерирует', async () => {
    const url = 'https://example.com';
    const entities = [{ type: 'url', offset: 0, length: url.length }];
    await bot.processUpdate(say(url, { entities }, { id: GROUP_ADMIN, first_name: 'Админ' }));
    await bot.processUpdate(say(url, { entities }, { id: OWNER, first_name: 'Владелец' }));
    expect(calls('deleteMessage')).toHaveLength(0);
  });

  it('чужая группа — тишина, без ответа «используйте личный чат»', async () => {
    await bot.processUpdate(say('бля https://example.com', {}, user, { id: -100999, type: 'supergroup', title: 'Другая' }));
    expect(sent.filter(call => call.method !== 'getMe')).toHaveLength(0);
  });

  it('спам-фразы новичка удаляются', async () => {
    await bot.processUpdate(say('Удалённая работа, заработок от 5000 руб в день, пишите в лс'));
    expect(calls('deleteMessage')).toHaveLength(1);
  });

  it('флуд: больше 5 сообщений за 10 секунд', async () => {
    for (let index = 0; index < 6; index += 1) await bot.processUpdate(say(`вопрос ${index}`));
    expect(calls('deleteMessage')).toHaveLength(1);
  });

  it('служебное «вошёл в чат» удаляется', async () => {
    await bot.processUpdate({ update_id: ++updateId, message: { message_id: 9, date: 1, chat: CHAT, from: user, new_chat_members: [user] } });
    expect(calls('deleteMessage')[0]?.body.message_id).toBe(9);
  });
});

describe('команды и кнопки', () => {
  it('/report ответом: владельцу жалоба с кнопками, команда удалена', async () => {
    const victim = { id: 777001, first_name: 'Спамер' };
    await bot.processUpdate(say('/report', { reply_to_message: { message_id: 321, chat: CHAT, from: victim, text: 'странное сообщение' } }));
    expect(calls('deleteMessage')[0].body.message_id).toBe(updateId);
    const toOwner = calls('sendMessage').find(call => call.body.chat_id === String(OWNER));
    expect(toOwner?.body.text).toContain('Жалоба');
    expect(toOwner?.body.text).toContain('https://t.me/shk_wb_chat/321');
    expect(toOwner?.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual(['md:del:321', `md:mute:${victim.id}`, `md:ban:${victim.id}`]);
  });

  it('/mute от обычного участника — молча удаляется, мута нет', async () => {
    await bot.processUpdate(say('/mute', { reply_to_message: { message_id: 1, chat: CHAT, from: { id: 9, first_name: 'X' }, text: 'x' } }));
    expect(calls('deleteMessage')).toHaveLength(1);
    expect(calls('restrictChatMember')).toHaveLength(0);
  });

  it('/mute 2 от админа чата — запрет писать на 2 часа', async () => {
    await bot.processUpdate(say('/mute 2', { reply_to_message: { message_id: 1, chat: CHAT, from: user, text: 'x' } }, { id: GROUP_ADMIN, first_name: 'Админ' }));
    const call = calls('restrictChatMember')[0];
    expect(call.body).toMatchObject({ chat_id: CHAT.id, user_id: user.id });
    expect(call.body.permissions.can_send_messages).toBe(false);
    expect(call.body.until_date - Math.floor(Date.now() / 1000)).toBeGreaterThan(7000);
  });

  it('кнопка владельца «Мут» — мут на 24 ч; не владельцу — нет доступа', async () => {
    const press = (fromId: number, data: string) => ({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, from: { id: fromId, first_name: 'A' }, data, message: { message_id: 3, chat: { id: fromId, type: 'private' } } } });
    await bot.processUpdate(press(OWNER, `md:mute:${user.id}`));
    expect(calls('restrictChatMember')[0]?.body.user_id).toBe(user.id);
    expect(calls('editMessageReplyMarkup')[0]?.body.reply_markup.inline_keyboard.flat()[0].callback_data).toBe(`md:unmute:${user.id}`);
    sent = [];
    await bot.processUpdate(press(GROUP_ADMIN, `md:ban:${user.id}`));
    expect(calls('banChatMember')).toHaveLength(0);
    expect(calls('answerCallbackQuery')[0]?.body.text).toBe('Нет доступа');
  });

  it('«Ошибка бота» снимает предупреждение', async () => {
    await bot.processUpdate({ update_id: ++updateId, callback_query: { id: 'cbx', from: { id: OWNER, first_name: 'A' }, data: 'md:ok:42', message: { message_id: 3, chat: { id: OWNER, type: 'private' }, reply_markup: { inline_keyboard: [[{ text: 'Мут', callback_data: 'md:mute:1' }], [{ text: 'ok', callback_data: 'md:ok:42' }]] } } } });
    expect(db.find(call => call.method === 'PATCH')?.path).toBe('support_chat_warnings?id=eq.42');
    expect(calls('editMessageReplyMarkup')[0]?.body.reply_markup.inline_keyboard).toEqual([[{ text: 'Мут', callback_data: 'md:mute:1' }]]);
  });

  it('бота добавили в группу — владельцу id группы', async () => {
    delete process.env.SUPPORT_CHAT_ID;
    await bot.processUpdate({ update_id: ++updateId, my_chat_member: { chat: { id: -100555, type: 'supergroup', title: 'Новая' }, from: { id: OWNER }, date: 1, old_chat_member: { status: 'left', user: { id: 1 } }, new_chat_member: { status: 'member', user: { id: 1 } } } });
    const toOwner = calls('sendMessage').find(call => call.body.chat_id === String(OWNER));
    expect(toOwner?.body.text).toContain('SUPPORT_CHAT_ID=-100555');
    expect(toOwner?.body.text).toContain('администратором');
  });

  it('команды чата ставятся отдельным списком', async () => {
    await bot.syncBotCommands();
    const scoped = calls('setMyCommands').filter(call => call.body.scope);
    expect(scoped.map(call => call.body.scope.type).sort()).toEqual(['chat', 'chat_administrators']);
    expect(scoped.find(call => call.body.scope.type === 'chat')?.body.commands).toEqual(bot.SUPPORT_CHAT_COMMANDS);
  });

  it('личный чат работает как раньше', async () => {
    await bot.processUpdate(say('/help', {}, user, { id: user.id, type: 'private' }));
    expect(calls('deleteMessage')).toHaveLength(0);
    expect(calls('sendMessage').some(call => String(call.body.text).includes('Помощь'))).toBe(true);
  });
});
