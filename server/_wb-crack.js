// Резервный подбор кода клиента по MD5-хешам из базы WB (не формула sdbm).
// Включается админ-флагом app_crack_fallback (server/_app-flags.js). Нужен на случай,
// когда формула не совпала: программа присылает сегодняшние MD5-хеши клиента из локальной
// базы, сервер перебирает 5-значные коды и возвращает первый совпавший.
//
// Преобразование — порт cracker::find_code_md5 (Rust): WB хранит md5(sid_байты ++ код5),
// код — 5 цифр с ведущими нулями, 0..99999. argon2 на сервере НЕ перебираем (дорого на
// serverless) — это осознанный компромисс: argon2-«Найти код» выведен из программы в архив.
const crypto = require('crypto');
const { qrFromCode } = require('./_wb-code');

const HEX32 = /^[a-f0-9]{32}$/;

/**
 * Подобрать 5-значный код по набору MD5-хешей (hex, 32 символа).
 * Возвращает число кода или null, если ни один не совпал.
 */
function crackMd5(sid, hashes) {
  const normalized = String(sid);
  const targets = new Set(
    (Array.isArray(hashes) ? hashes : [])
      .map(h => String(h || '').trim().toLowerCase())
      .filter(h => HEX32.test(h)),
  );
  if (!targets.size) return null;
  const sidBuf = Buffer.from(normalized, 'utf8');
  for (let i = 0; i < 100000; i += 1) {
    const code5 = String(i).padStart(5, '0');
    const digest = crypto.createHash('md5').update(sidBuf).update(code5, 'utf8').digest('hex');
    if (targets.has(digest)) return i;
  }
  return null;
}

/** { code, qrText } по подбору из MD5-хешей или null. */
function crackClientQr(sid, hashes) {
  const code = crackMd5(sid, hashes);
  return code === null ? null : qrFromCode(sid, code);
}

module.exports = { crackMd5, crackClientQr };
