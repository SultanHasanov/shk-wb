// Шифрование данных «Помощника ПВЗ» в облаке: архив клиентов (телефоны, товары),
// зеркало базы пункта, документы (заметки, сотрудники, график) и секреты (токены).
//
// AES-256-GCM, ключ на каждого пользователя: HKDF(APP_DATA_KEY, user_id) — утечка строк
// одного аккаунта или подмена user_id не открывает чужие данные. Секреты — отдельным
// мастер-ключом APP_SECRETS_KEY.
//
// IV детерминированный (HMAC от открытого текста, как в AES-SIV): одинаковые данные дают
// одинаковый шифротекст. Так база видит «ничего не поменялось» и не гоняет одну и ту же
// запись между ПК. Цена — видно, что две записи равны; содержимое по-прежнему закрыто.
const crypto = require('crypto');

const cache = new Map();

function master(name) {
  const value = String(process.env[name] || '');
  if (value.length < 32) {
    const error = new Error(`${name} must contain at least 32 characters`);
    error.status = 503;
    error.code = 'SYNC_NOT_CONFIGURED';
    error.publicMessage = 'Облачная синхронизация на сервере ещё не настроена';
    throw error;
  }
  return value;
}

function keys(userId, purpose) {
  const secret = master(purpose === 'secret' ? 'APP_SECRETS_KEY' : 'APP_DATA_KEY');
  const id = `${purpose}:${secret.length}:${secret.slice(-6)}:${userId}`;
  let found = cache.get(id);
  if (found) return found;
  const derive = info => Buffer.from(crypto.hkdfSync('sha256', secret, String(userId), `pvz-${purpose}-${info}`, 32));
  found = { enc: derive('enc'), mac: derive('iv') };
  if (cache.size > 500) cache.clear();
  cache.set(id, found);
  return found;
}

/** Зашифровать строку (или null/пусто → null). */
function seal(userId, text, purpose = 'data') {
  if (text == null || text === '') return null;
  const plain = Buffer.from(String(text), 'utf8');
  const k = keys(userId, purpose);
  const iv = crypto.createHmac('sha256', k.mac).update(plain).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k.enc, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** Расшифровать; чужой ключ или испорченные данные → null (а не исключение посреди пачки). */
function open(userId, value, purpose = 'data') {
  if (!value) return null;
  const [version, iv, tag, body] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !body) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keys(userId, purpose).enc, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error.code === 'SYNC_NOT_CONFIGURED') throw error;
    return null;
  }
}

module.exports = { open, seal };
