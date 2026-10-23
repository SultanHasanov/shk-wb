// Код клиента и QR-строка для Telegram-бота.
//
// Формула кода — порт из решения по криптографии (sdbm-хеш):
//   строка = DDMMYYYY + "_" + SID        (дата — текущая, по Москве)
//   h = sdbm(строка),   sdbm: h = (h*65599 + байт) mod 2^32
//   код = h mod 100000                   (всегда показываем 5 цифр, с ведущими нулями)
//
// QR-строка: "{SID}_{код5}_{random6}_1", например "191607973_57187_458975_1".
const crypto = require('crypto');

/** sdbm по UTF-8 байтам строки. Для ASCII (цифры и «_») байт == charCodeAt. */
function sdbm(text) {
  let h = 0;
  const bytes = Buffer.from(String(text), 'utf8');
  for (let index = 0; index < bytes.length; index += 1) {
    // h*65599 + byte < 2^32 * 65599 ≈ 2.8e14 < 2^53 — Number безопасен, BigInt не нужен.
    h = (h * 65599 + bytes[index]) % 0x100000000;
  }
  return h;
}

/** День/месяц/год в формате DDMMYYYY по Europe/Moscow (коды WB меняются в полночь МСК). */
function moscowDDMMYYYY(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('day')}${get('month')}${get('year')}`;
}

/** Код клиента на дату. sid — строка/число из цифр. */
function clientCode(sid, date = new Date()) {
  return sdbm(`${moscowDDMMYYYY(date)}_${sid}`) % 100000;
}

/** { code, qrText } для SID на текущий день. random6 — случайное 6-значное число. */
function buildClientQr(sid, date = new Date()) {
  const normalized = String(sid);
  const code = clientCode(normalized, date);
  const code5 = String(code).padStart(5, '0');
  const random6 = String(crypto.randomInt(100000, 1000000));
  return { code, qrText: `${normalized}_${code5}_${random6}_1` };
}

/** Строгая проверка формата QR-строки перед отрисовкой/подписью. */
function isClientQrText(text) {
  return /^\d{1,12}_\d{5}_\d{6}_\d$/.test(String(text || ''));
}

module.exports = { sdbm, moscowDDMMYYYY, clientCode, buildClientQr, isClientQrText };
