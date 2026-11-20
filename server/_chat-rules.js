// Правила чата поддержки: что бот удаляет и почему. Только чистые функции без сети — их проверяют тесты
// (src/api/support-chat-rules.test.ts). Работа с Telegram и базой — server/_support-chat.js.

// Ссылки, которые можно: WB, Ozon и наш сайт (поддомены тоже). Дополнительно — SUPPORT_CHAT_ALLOWED_HOSTS через запятую.
const ALLOWED_HOSTS = [
  'wildberries.ru', 'wb.ru', 'wbbasket.ru', 'wbstatic.net', 'wbcontent.net',
  'wildberries.by', 'wildberries.kz', 'wildberries.am', 'wildberries.kg', 'wildberries.uz', 'wildberries.ge',
  'ozon.ru', 'ozon.by', 'ozon.kz', 'ozon.com',
  'shk-wb.ru',
];
const TELEGRAM_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);

function extraHosts() {
  return String(process.env.SUPPORT_CHAT_ALLOWED_HOSTS || '').split(',').map(value => value.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean);
}

function hostAllowed(host) {
  const clean = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!clean) return false;
  return [...ALLOWED_HOSTS, ...extraHosts()].some(allowed => clean === allowed || clean.endsWith(`.${allowed}`));
}

/** Внутренний id супергруппы для ссылок t.me/c/<id>/<сообщение>: -1001234567890 → 1234567890. */
function internalChatId(chatId) {
  const text = String(chatId || '');
  return text.startsWith('-100') ? text.slice(4) : '';
}

/**
 * Можно ли эту ссылку. ctx.allowedTelegram — свои имена в Telegram (бот, канал, VPN, сам чат) в нижнем регистре,
 * ctx.chatId — чат поддержки (ссылки на его же сообщения t.me/c/<id>/… можно).
 */
function isAllowedUrl(raw, ctx = {}) {
  let value = String(raw || '').trim();
  if (!value) return true;
  if (/^tg:/i.test(value)) {
    // tg://resolve?domain=<имя> — то же, что t.me/<имя>
    const domain = /[?&]domain=([\w]+)/i.exec(value)?.[1];
    return Boolean(domain && allowedTelegramName(domain, ctx));
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const sub = /^([\w-]+)\.t\.me$/.exec(host);
  if (sub) return allowedTelegramName(sub[1], ctx);
  if (TELEGRAM_HOSTS.has(host)) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return true; // голый t.me
    if (parts[0] === 'c') return Boolean(parts[1] && parts[1] === internalChatId(ctx.chatId));
    if (parts[0] === 's') return allowedTelegramName(parts[1], ctx);
    if (parts[0].startsWith('+') || parts[0] === 'joinchat' || parts[0] === 'addlist') return false;
    return allowedTelegramName(parts[0], ctx);
  }
  return hostAllowed(host);
}

function allowedTelegramName(name, ctx) {
  const clean = String(name || '').replace(/^@/, '').toLowerCase();
  return Boolean(clean) && (ctx.allowedTelegram || new Set()).has(clean);
}

function messageText(message) { return String(message?.text ?? message?.caption ?? ''); }
function messageEntities(message) { return message?.entities || message?.caption_entities || []; }

// Ссылки, которые Telegram не распознал: «site . ru», «site(точка)ru», «t . me/…», «site [.] com».
const OBFUSCATED_DOMAIN = /([a-z0-9-]{2,})\s*(?:\[\s*\.\s*\]|\(\s*\.\s*\)|\s\.\s*|\.\s+|\s*[([]?\s*(?:точка|dot)\s*[)\]]?\s*)(ru|com|net|org|me|io|su|рф|xyz|top|site|online|shop|store|info|pro|biz|cc|gg|ly|link|club|app)(?![a-zа-я])/gi;
const OBFUSCATED_TME = /(?:^|[^a-zа-я])[tт]\s*[.,]\s*(?:me|ме)\s*\/\s*([\w+]+)/gi;

/** Все ссылки сообщения: из разметки Telegram, кнопок и спрятанные в тексте. */
function findLinks(message) {
  const text = messageText(message);
  const links = [];
  for (const entity of messageEntities(message)) {
    if (entity.type === 'url') links.push(text.substr(entity.offset, entity.length));
    else if (entity.type === 'text_link' && entity.url) links.push(entity.url);
  }
  for (const row of message?.reply_markup?.inline_keyboard || []) {
    for (const button of row || []) {
      const url = button?.url || button?.login_url?.url || button?.web_app?.url;
      if (url) links.push(url);
    }
  }
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(OBFUSCATED_TME)) links.push(`https://t.me/${match[1]}`);
  for (const match of lower.matchAll(OBFUSCATED_DOMAIN)) {
    // «t . me» уже разобран выше; обычный «wb.ru» Telegram и так размечает ссылкой
    if (match[1] === 't' || match[1] === 'т') continue;
    links.push(`${match[1]}.${match[2]}`);
  }
  return [...new Set(links.map(link => link.trim()).filter(Boolean))];
}

/** Упоминания @имя из разметки (нижний регистр, без @). */
function findMentions(message) {
  const text = messageText(message);
  const names = [];
  for (const entity of messageEntities(message)) {
    if (entity.type === 'mention') names.push(text.substr(entity.offset, entity.length).replace(/^@/, '').toLowerCase());
  }
  return [...new Set(names.filter(Boolean))];
}

// --- Мат и оскорбления -------------------------------------------------------------------------------------

// Латиница и цифры, похожие на русские буквы, — только внутри слов, где есть кириллица («xуй», «6ля»).
const LOOKALIKE = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в', u: 'и', '0': 'о', '3': 'з', '6': 'б', '@': 'а' };

function normalizeWord(word) {
  let value = word.toLowerCase().replace(/ё/g, 'е');
  if (/[а-я]/.test(value) && /[a-z0-9@]/.test(value)) value = value.replace(/[a-z0-9@]/g, char => LOOKALIKE[char] || char);
  return value.replace(/(.)\1+/g, '$1'); // «хууууй», «бляяя»
}

/** Слова текста для проверки: обычные и собранные из разрядки («х у й», «х.у.й», «б-л-я»). */
function wordsOf(text) {
  const tokens = String(text || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9@]+/).filter(Boolean);
  const words = [];
  let run = [];
  const flush = () => { if (run.length >= 3) words.push(run.join('')); run = []; };
  for (const token of tokens) {
    if (token.length === 1) { run.push(token); continue; }
    flush();
    words.push(token);
  }
  flush();
  return words.map(normalizeWord).filter(Boolean);
}

// Обычные слова, в которых встречаются корни мата.
const SAFE_WORDS = /страх|псих|хулиган|херсон|херес|херувим|бляш|бляха|бляхи|сукно|мандарин|чихуа|скипидар|потреб|колеб|гребл|учеб|ребен|ребят|небес|себе|тебе|хлеб|веб/;

const PROFANITY = [
  /ху[йеяюи]/,
  /п[ие]зд/,
  /^(?:вы|на|за|от|отъ|оть|про|у|до|по|съ|сь|раз|разъ|разь|въ|недо|пере|при|подъ|подь|о|об|объ|обь|долбо|дол|ъ)?еб(?:а|у|л|н|т|ш|ись|ыв|ыр|ок|ет|и|ь|$)/,
  /долбоеб/,
  /^бл[яь](?![шх])/,
  /^муд(?:ак|ач|ил|озвон|ень|ня)/,
  /^п[ие]д[оа]?р/,
  /залуп/,
  /^г[ао]нд[оа]н/,
  /шлюх/,
  /^сук(?:а|и|е|у|ой|ам|ами|ах|ин|ина|ины|ино)$/,
  /^(?:на|по|ни)?хер/,
  /^г[оа]вн/,
  /^дерьм/,
  /^жоп/,
];

const INSULTS = [
  /^д[еи]бил/, /^идиот/, /^кретин/, /^придур/, /^ублюд/, /^мраз/, /^чмо(?:$|ш)/, /^лох(?:и|а|ов|ам|у)?$/, /^лошар/,
  /^урод/, /^имбецил/, /^даун(?:ы|а|у|ов)?$/, /^олигофрен/, /^тупиц/, /^тупорыл/, /^тупоголов/, /^сволоч/,
  /^твар(?:ь|и|ей)$/, /^скотин/, /^дура(?:к|ч|$)/, /^дуры$/,
];

/** Первое найденное слово мата / оскорбления или null. */
function findBadWord(text, patterns) {
  for (const word of wordsOf(text)) {
    if (SAFE_WORDS.test(word)) continue;
    if (patterns.some(pattern => pattern.test(word))) return word;
  }
  return null;
}

const findProfanity = text => findBadWord(text, PROFANITY);
const findInsult = text => findBadWord(text, INSULTS);

// --- Спам (только у новичков) и номера карт -----------------------------------------------------------------

const SPAM_PATTERNS = [
  /заработ(?:ок|ка|ать|ай|аешь|аете|ала|ал)/, /(?:пассивн|стабильн|дополнительн)\S* доход/, /без вложений/,
  /удал[её]нн\S* (?:работ|заработ|подработ)/, /подработ/, /(?:пиши|пишите|напиши|напишите)(?: мне)? в (?:лс|личк|личные)/,
  /(?:^|[^a-zа-я])в лс(?:$|[^a-zа-я])/, /(?:^|[^а-яa-z])крипт/, /инвестиц/, /арбитраж/, /\d+\s*(?:\$|usd|долл|руб|р\.|т\.р|тыс|к)\S*\s*(?:в|за)\s*(?:день|неделю|сутки)/,
  /(?:набира|ищ)\S* (?:людей|сотрудников|партн[её]р)/, /казино|ставк[аи] на спорт|букмекер/, /интим|эскорт/,
  /раскрутк|накрутк/, /подписыв[ае]йтесь|подпишись на/,
];

function findSpam(text) {
  const value = String(text || '').toLowerCase().replace(/ё/g, 'е');
  const hit = SPAM_PATTERNS.find(pattern => pattern.test(value));
  return hit ? (value.match(hit)?.[0] || '').trim() : null;
}

function luhn(digits) {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Номер банковской карты (16–19 цифр подряд или группами по 4, проверка Луна) или null. */
function findCardNumber(text) {
  const pattern = /(?:^|[^\d])((?:\d{4}[ -]?){3}\d{4}(?:[ -]?\d{1,3})?)(?!\d)/g;
  for (const match of String(text || '').matchAll(pattern)) {
    const digits = match[1].replace(/\D/g, '');
    if (digits.length >= 16 && digits.length <= 19 && luhn(digits)) return digits;
  }
  return null;
}

// --- Итог проверки -----------------------------------------------------------------------------------------

// Причина — в чате, человеку (после «сообщение удалено: »); подпись — владельцу в личку.
const RULES = {
  sender_chat: { label: 'Писал от имени канала', reason: 'писать от имени канала нельзя — пишите от своего аккаунта.' },
  via_bot: { label: 'Сообщение через стороннего бота', reason: 'сообщения через сторонних ботов запрещены — в целях безопасности.' },
  forward: { label: 'Пересылка из чужого канала', reason: 'пересылки из других каналов и групп запрещены — в целях безопасности.' },
  link: { label: 'Сторонняя ссылка', reason: 'ссылки на сторонние сайты и чаты запрещены — в целях безопасности участников. Можно: Wildberries, Ozon, shk-wb.ru.' },
  mention: { label: 'Реклама канала или бота', reason: 'реклама других каналов и ботов запрещена.' },
  card: { label: 'Номер карты', reason: 'номер карты в общем чате видят все. Сообщение удалено ради вашей безопасности — реквизиты передавайте только поддержке в личных сообщениях.' },
  profanity: { label: 'Мат', reason: 'нецензурная лексика в чате запрещена.' },
  insult: { label: 'Оскорбление', reason: 'оскорбления в чате запрещены.' },
  spam: { label: 'Похоже на спам', reason: 'похоже на рекламу или спам.' },
  flood: { label: 'Флуд — медленный режим на 10 мин', reason: 'слишком много сообщений подряд. Для вас включён медленный режим на 10 минут: одно сообщение раз в полминуты.' },
  manual: { label: 'Предупреждение от админа', reason: 'нарушение правил чата.' },
};

function verdict(rule, detail = '') {
  return { rule, label: RULES[rule].label, reason: RULES[rule].reason, detail: String(detail || '').slice(0, 200) };
}

function originChat(message) {
  const origin = message?.forward_origin;
  if (origin?.type === 'channel') return origin.chat || null;
  if (origin?.type === 'chat') return origin.sender_chat || null;
  return message?.forward_from_chat || null;
}

/**
 * Проверка сообщения. ctx: { chatId, botUsername, allowedTelegram:Set, mentionKinds:Map<имя, тип чата>, newcomer }.
 * Возвращает { rule, label, reason, detail } или null.
 */
function classify(message, ctx = {}) {
  const allowed = name => allowedTelegramName(name, ctx);
  const text = messageText(message);
  const sender = message?.sender_chat;
  if (sender && sender.id !== ctx.chatId && !message.is_automatic_forward && !allowed(sender.username)) return verdict('sender_chat', sender.title || sender.username);
  const via = message?.via_bot;
  if (via && String(via.username || '').toLowerCase() !== String(ctx.botUsername || '').toLowerCase()) return verdict('via_bot', `@${via.username || via.id}`);
  const origin = originChat(message);
  if (origin && origin.id !== ctx.chatId && !allowed(origin.username)) return verdict('forward', origin.title || origin.username || origin.id);
  const badLink = findLinks(message).find(link => !isAllowedUrl(link, ctx));
  if (badLink) return verdict('link', badLink);
  const mentionKinds = ctx.mentionKinds || new Map();
  const badMention = findMentions(message).find(name => !allowed(name)
    && (/bot$/.test(name) || ['channel', 'group', 'supergroup'].includes(mentionKinds.get(name))));
  if (badMention) return verdict('mention', `@${badMention}`);
  const card = findCardNumber(text);
  if (card) return verdict('card', `${card.slice(0, 4)} •••• ${card.slice(-4)}`);
  const profanity = findProfanity(text);
  if (profanity) return verdict('profanity', profanity);
  const insult = findInsult(text);
  if (insult) return verdict('insult', insult);
  if (ctx.newcomer) {
    const spam = findSpam(text);
    if (spam) return verdict('spam', spam);
  }
  return null;
}

module.exports = {
  ALLOWED_HOSTS, RULES, classify, findCardNumber, findInsult, findLinks, findMentions, findProfanity, findSpam,
  hostAllowed, internalChatId, isAllowedUrl, verdict, wordsOf,
};
