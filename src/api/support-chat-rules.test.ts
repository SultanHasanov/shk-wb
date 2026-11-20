import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Правила чата поддержки (server/_chat-rules.js): что бот удаляет, а что пропускает.

const require = createRequire(import.meta.url);
const rules = require('../../server/_chat-rules.js') as {
  classify: (message: Record<string, unknown>, ctx?: Record<string, unknown>) => { rule: string; detail: string } | null;
  findCardNumber: (text: string) => string | null;
  findInsult: (text: string) => string | null;
  findLinks: (message: Record<string, unknown>) => string[];
  findProfanity: (text: string) => string | null;
  findSpam: (text: string) => string | null;
  isAllowedUrl: (url: string, ctx?: Record<string, unknown>) => boolean;
};

const CHAT_ID = -1001234567890;
const ctx = { chatId: CHAT_ID, botUsername: 'shkwb_bot', allowedTelegram: new Set(['shkwb_bot', 'wbtools_ru', 'wb_wpn_bot', 'shk_wb_chat']), mentionKinds: new Map() };

/** Сообщение со ссылками-сущностями, как их размечает Telegram. */
function withUrls(text: string, urls: string[]) {
  const entities = urls.map(url => ({ type: 'url', offset: text.indexOf(url), length: url.length }));
  return { text, entities };
}

describe('ссылки', () => {
  it('WB, Ozon, shk-wb.ru и свои Telegram — можно', () => {
    for (const url of [
      'https://www.wildberries.ru/catalog/123/detail.aspx', 'wb.ru', 'https://point.wb.ru/login', 'https://seller.wildberries.ru',
      'https://www.ozon.ru/product/1', 'ozon.kz', 'https://shk-wb.ru/program', 'shk-wb.ru/dl/',
      'https://t.me/shkwb_bot?start=r_ABC', 't.me/wbtools_ru/15', 'https://t.me/shk_wb_chat/100', 'https://t.me/c/1234567890/55',
    ]) expect(rules.isAllowedUrl(url, ctx), url).toBe(true);
  });

  it('чужие сайты, чужие Telegram, приглашения и похожие домены — нельзя', () => {
    for (const url of [
      'https://example.com', 'wildberries-ru.com', 'https://wildberries.ru.evil.com', 'http://wb-ru.top', 'https://t.me/some_channel',
      'https://t.me/+AbCdEf', 'https://t.me/joinchat/xyz', 'https://t.me/c/999/1', 'https://scam.t.me', 'https://bit.ly/abc', 'tg://resolve?domain=spam',
    ]) expect(rules.isAllowedUrl(url, ctx), url).toBe(false);
  });

  it('ссылку находит в тексте, в скрытой ссылке, в кнопках и разбитую пробелами', () => {
    expect(rules.findLinks(withUrls('смотри example.com', ['example.com']))).toEqual(['example.com']);
    expect(rules.findLinks({ text: 'тут', entities: [{ type: 'text_link', offset: 0, length: 3, url: 'https://evil.ru' }] })).toEqual(['https://evil.ru']);
    expect(rules.findLinks({ text: 'x', reply_markup: { inline_keyboard: [[{ text: 'go', url: 'https://evil.ru' }]] } })).toEqual(['https://evil.ru']);
    expect(rules.findLinks({ text: 'заходи t . me/spam_channel' })).toContain('https://t.me/spam_channel');
    expect(rules.findLinks({ text: 'сайт evilsite точка ru' })).toContain('evilsite.ru');
    expect(rules.findLinks({ text: 'сайт evilsite . com' })).toContain('evilsite.com');
    expect(rules.findLinks({ text: 'Обычное предложение. Без ссылок.' })).toEqual([]);
  });

  it('classify: чужая ссылка удаляется, ссылка WB — нет', () => {
    expect(rules.classify(withUrls('купи тут https://example.com', ['https://example.com']), ctx)?.rule).toBe('link');
    expect(rules.classify(withUrls('товар https://www.wildberries.ru/catalog/1/detail.aspx', ['https://www.wildberries.ru/catalog/1/detail.aspx']), ctx)).toBeNull();
    expect(rules.classify({ caption: 'фото', caption_entities: [{ type: 'text_link', offset: 0, length: 4, url: 'https://evil.ru' }], photo: [{}] }, ctx)?.rule).toBe('link');
  });
});

describe('упоминания, пересылки, каналы', () => {
  it('чужой бот и канал — нельзя, участник и свои — можно', () => {
    const mention = (name: string, kinds = new Map()) => rules.classify({ text: `пиши @${name}`, entities: [{ type: 'mention', offset: 5, length: name.length + 1 }] }, { ...ctx, mentionKinds: kinds });
    expect(mention('cheap_codes_bot')?.rule).toBe('mention');
    expect(mention('spam_channel', new Map([['spam_channel', 'channel']]))?.rule).toBe('mention');
    expect(mention('vasya_pvz', new Map([['vasya_pvz', 'user']]))).toBeNull();
    expect(mention('shkwb_bot')).toBeNull();
    expect(mention('wbtools_ru', new Map([['wbtools_ru', 'channel']]))).toBeNull();
  });

  it('пересылка из чужого канала — нельзя, из своего канала и от человека — можно', () => {
    expect(rules.classify({ text: 'x', forward_origin: { type: 'channel', chat: { id: -100555, username: 'other' } } }, ctx)?.rule).toBe('forward');
    expect(rules.classify({ text: 'x', forward_origin: { type: 'channel', chat: { id: -100777, username: 'wbtools_ru' } } }, ctx)).toBeNull();
    expect(rules.classify({ text: 'x', forward_origin: { type: 'user', sender_user: { id: 1 } } }, ctx)).toBeNull();
  });

  it('от имени чужого канала и через стороннего бота — нельзя', () => {
    expect(rules.classify({ text: 'x', sender_chat: { id: -100999, type: 'channel', title: 'Канал' } }, ctx)?.rule).toBe('sender_chat');
    expect(rules.classify({ text: 'x', via_bot: { id: 5, username: 'gif' } }, ctx)?.rule).toBe('via_bot');
    expect(rules.classify({ text: 'x', via_bot: { id: 6, username: 'shkwb_bot' } }, ctx)).toBeNull();
  });
});

describe('мат и оскорбления', () => {
  it('ловит мат, в том числе замаскированный', () => {
    for (const text of ['да пошёл ты нахуй', 'Бля, опять не работает', 'это пиздец', 'заебали уже', 'ёбаный принтер', 'долбоёб', 'х у й', 'хууууй', 'xуй', '6ля', 'сука', 'нихера не печатает', 'ебать'])
      expect(rules.findProfanity(text), text).not.toBeNull();
  });

  it('не трогает обычные слова', () => {
    for (const text of [
      'застрахуйте посылку', 'не психуй', 'потребляет много бумаги', 'небо', 'себе и тебе', 'хлеб', 'ребёнок', 'учебник', 'вебинар',
      'бляха от ремня', 'Херсон', 'мандарин', 'команда', 'рубля', 'колебание', 'сукно', 'скрипт печати', 'хулиган', 'оскорбление', 'Помощник ПВЗ не обновляется',
    ]) expect(rules.findProfanity(text), text).toBeNull();
  });

  it('оскорбления: ловит обидные слова, но не похожие', () => {
    for (const text of ['ты дебил', 'идиот', 'урод', 'вы лохи', 'тварь', 'дурак']) expect(rules.findInsult(text), text).not.toBeNull();
    for (const text of ['даунгрейд версии', 'процедура', 'чмоки', 'дурацкий принтер', 'лохматый']) expect(rules.findInsult(text), text).toBeNull();
  });

  it('classify возвращает profanity / insult', () => {
    expect(rules.classify({ text: 'бля' }, ctx)?.rule).toBe('profanity');
    expect(rules.classify({ text: 'ты идиот' }, ctx)?.rule).toBe('insult');
    expect(rules.classify({ text: 'Подскажите, как продлить подписку?' }, ctx)).toBeNull();
  });
});

describe('карты и спам', () => {
  it('номер карты (Луна) ловится, ШК, телефоны и баркоды — нет', () => {
    expect(rules.findCardNumber('переведите на 4111 1111 1111 1111')).toBe('4111111111111111');
    expect(rules.findCardNumber('карта 4111111111111111')).toBe('4111111111111111');
    expect(rules.findCardNumber('ШК 12345678901 и 23456789012')).toBeNull();
    expect(rules.findCardNumber('телефон 89991234567, баркод 4601234567893')).toBeNull();
    expect(rules.findCardNumber('1234 5678 9012 3456')).toBeNull(); // не проходит Луна
    expect(rules.classify({ text: 'моя карта 4111 1111 1111 1111' }, ctx)?.rule).toBe('card');
  });

  it('спам-фразы — только у новичков', () => {
    const text = 'Удалённая работа, заработок от 5000 руб в день, пишите в лс';
    expect(rules.findSpam(text)).not.toBeNull();
    expect(rules.classify({ text }, ctx)).toBeNull();
    expect(rules.classify({ text }, { ...ctx, newcomer: true })?.rule).toBe('spam');
    expect(rules.findSpam('Как настроить скрипт печати?')).toBeNull();
  });
});
