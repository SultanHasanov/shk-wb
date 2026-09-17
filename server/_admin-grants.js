const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { createAccessCode } = require('./_access-code');

/**
 * Выдача и правка активов из админки.
 *
 * Раньше эта логика лежала прямо в маршрутизаторе api/admin/data.js. Раздел
 * «Пользователи» делает ровно то же самое, но для конкретного владельца, и
 * копировать проверки во второе место нельзя: разъедутся именно они, а не
 * запросы к базе. Поэтому здесь чистые функции, а роутер только маршрутизирует.
 */

const CELL_DURATIONS = [3, 7, 30, 90, 180, 365];
const CELL_DEVICE_LIMITS = [1, 2, 3, 5, 10, 20];
/** Потолок срока ключа печати ячеек — и разового, и накопленного продлениями. */
const CELL_MAX_DAYS = 4000;
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

const RESOURCES = {
  key: {
    table: 'license_keys',
    toDb(body) {
      const out = {};
      if ('key' in body) out.key = body.key;
      if ('limit' in body) out.usage_limit = body.limit;
      if ('used' in body) out.used = body.used;
      if ('active' in body) out.active = body.active;
      if ('note' in body) out.note = body.note;
      if ('createdAt' in body) out.created_at = body.createdAt;
      return out;
    },
    fromDb(row) {
      return {
        id: row.id, key: row.key, limit: row.usage_limit, used: row.used,
        active: row.active, note: row.note, createdAt: row.created_at,
      };
    },
  },
  message: {
    table: 'announcements',
    toDb(body) {
      const out = {};
      for (const field of ['text', 'url', 'button', 'active']) {
        if (field in body) out[field] = body[field];
      }
      if ('createdAt' in body) out.created_at = body.createdAt;
      return out;
    },
    fromDb(row) {
      return {
        id: row.id, text: row.text, url: row.url, button: row.button,
        active: row.active, createdAt: row.created_at,
      };
    },
  },
  stickerAccess: {
    table: 'sticker_access_codes',
    toDb(body) {
      const out = {};
      if ('name' in body) out.name = String(body.name || '').trim();
      if ('active' in body) out.active = Boolean(body.active);
      // Счётчик один на все виды генерации, см. 20260905_unified_generation_pool.sql.
      if ('limit' in body) out.generation_limit = Number(body.limit);
      return out;
    },
    fromDb(row) {
      return {
        id: row.id, code: row.code, name: row.name, active: row.active,
        limit: row.generation_limit, used: row.generation_used,
        ownerUserId: row.owner_user_id ?? null,
        createdAt: row.created_at,
      };
    },
  },
  programPromo: {
    table: 'program_promocodes',
    toDb(body) {
      const out = {};
      if ('code' in body) out.code = String(body.code || '').trim().toUpperCase();
      if ('limit' in body) out.usage_limit = Number(body.limit);
      if ('active' in body) out.active = Boolean(body.active);
      if ('note' in body) out.note = String(body.note || '').trim();
      return out;
    },
    fromDb(row) { return {id:row.id,code:row.code,limit:row.usage_limit,used:row.used,active:row.active,note:row.note,createdAt:row.created_at}; },
  },
  cellLicense:{table:'cell_print_licenses',toDb(body){const out={};if('durationDays'in body)out.duration_days=Number(body.durationDays);if('deviceLimit'in body)out.device_limit=Number(body.deviceLimit);if('marketplaceScope'in body)out.marketplace_scope=body.marketplaceScope;if('active'in body)out.active=Boolean(body.active);if('note'in body)out.note=String(body.note||'').trim();if('source'in body)out.source=body.source;return out;},fromDb(r){return{id:r.id,key:r.key,durationDays:r.duration_days,deviceLimit:r.device_limit,marketplaceScope:r.marketplace_scope||'legacy_unassigned',active:r.active,activatedAt:r.activated_at,expiresAt:r.expires_at,note:r.note,ownerUserId:r.owner_user_id??null,createdAt:r.created_at};}},
  cellActivation:{table:'cell_print_activations',toDb(){return{};},fromDb(r){return{id:r.id,licenseId:r.license_id,deviceHash:r.device_hash,firstSeenAt:r.first_seen_at,lastSeenAt:r.last_seen_at};}},
  cellPromo:{table:'cell_print_promocodes',toDb(body){const out={};if('code'in body)out.code=String(body.code||'').trim().toUpperCase();if('discount'in body)out.discount_percent=Number(body.discount);if('scope'in body)out.scope=body.scope;if('limit'in body)out.usage_limit=Number(body.limit);if('expiresAt'in body)out.expires_at=body.expiresAt||null;if('active'in body)out.active=Boolean(body.active);if('note'in body)out.note=String(body.note||'').trim();return out;},fromDb(r){return{id:r.id,code:r.code,discount:r.discount_percent,scope:r.scope,limit:r.usage_limit,used:r.used,expiresAt:r.expires_at,active:r.active,note:r.note};}},
  cellAnnouncement:{table:'cell_print_announcements',toDb(body){const out={};for(const f of ['text','url','button','level','active'])if(f in body)out[f]=body[f];if('startsAt'in body)out.starts_at=body.startsAt||null;if('endsAt'in body)out.ends_at=body.endsAt||null;return out;},fromDb(r){return{id:r.id,text:r.text,url:r.url,button:r.button,level:r.level,startsAt:r.starts_at,endsAt:r.ends_at,active:r.active};}},
  cellRelease:{table:'cell_print_releases',toDb(body){const out={};if('version'in body)out.version=body.version;if('minimumVersion'in body)out.minimum_version=body.minimumVersion;if('downloadUrl'in body)out.download_url=body.downloadUrl;if('notes'in body)out.notes=body.notes;if('mandatory'in body)out.mandatory=Boolean(body.mandatory);out.updated_at=new Date().toISOString();return out;},fromDb(r){return{id:r.id,version:r.version,minimumVersion:r.minimum_version,downloadUrl:r.download_url,notes:r.notes,mandatory:r.mandatory};}},
};

function validateStickerAccess(body, creating) {
  if (creating || 'name' in body) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 120) return 'Введите имя';
  }
  if (creating || 'limit' in body) {
    const value = Number(body.limit);
    if (!Number.isInteger(value) || value < 0 || value > 100000) return 'Лимит должен быть целым числом от 0 до 100000';
  }
  return '';
}

function validateProgramPromo(body, creating) {
  if (creating || 'code' in body) if(!/^[A-Z0-9_-]{3,32}$/.test(String(body.code||'').trim().toUpperCase())) return 'Код: 3–32 латинские буквы, цифры, _ или -';
  if (creating || 'limit' in body) { const limit=Number(body.limit); if(!Number.isInteger(limit)||limit<1||limit>100000)return 'Лимит должен быть от 1 до 100000'; }
  if ('note' in body && String(body.note||'').trim().length>200)return 'Пометка слишком длинная';
  return '';
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || ''));
}

/**
 * Код выдаёт сервер, а не клиент: шестизначных кодов мало, и коллизию ловим
 * ответом 409 на уникальный индекс, а не проверкой перед вставкой.
 */
async function createStickerAccessCode({ name, limit, ownerUserId = null }) {
  const validationError = validateStickerAccess({ name, limit }, true);
  if (validationError) return { error: validationError };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = createAccessCode(crypto);
    try {
      const rows = await supabaseFetch(RESOURCES.stickerAccess.table, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          code,
          ...RESOURCES.stickerAccess.toDb({ name, limit }),
          ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
        }),
      });
      return { row: rows[0] };
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  throw new Error('Could not generate a unique access code');
}

/** Проверки перед PATCH кода доступа: лимит нельзя опустить ниже израсходованного. */
async function checkStickerAccessPatch(id, body) {
  const validationError = validateStickerAccess(body || {}, false);
  if (validationError) return { error: validationError };
  const current = await supabaseFetch(`${RESOURCES.stickerAccess.table}?id=eq.${id}&select=generation_used`);
  if (!current.length) return { error: 'Not found', status: 404 };
  if ('limit' in body && Number(body.limit) < current[0].generation_used) {
    return { error: 'Лимит не может быть меньше уже использованного количества' };
  }
  return {};
}

/** Пополнение через RPC: прибавка атомарна и не спорит с параллельной генерацией. */
async function addStickerGenerations(codeId, add) {
  const amount = Number(add);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) {
    return { error: 'Добавить можно от 1 до 100000 генераций' };
  }
  const row = await supabaseFetch('rpc/admin_grant_generations', {
    method: 'POST',
    body: JSON.stringify({ p_code_id: Number(codeId), p_add: amount }),
  });
  return { row };
}

async function createProgramKey({ key, limit, note = '', ownerUserId = null }) {
  const value = String(key || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,64}$/.test(value)) return { error: 'Ключ: 6–64 латинские буквы, цифры или дефис' };
  const usageLimit = Number(limit);
  if (!Number.isInteger(usageLimit) || usageLimit < 1 || usageLimit > 1000000) {
    return { error: 'Лимит итераций должен быть от 1 до 1000000' };
  }
  const rows = await supabaseFetch(RESOURCES.key.table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      key: value, usage_limit: usageLimit, used: 0, active: true, note: String(note || '').trim(),
      created_at: new Date().toISOString(),
      ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
    }),
  });
  return { row: rows[0] };
}

/** Ключ печати ячеек делает сервер: CP-XXXX-XXXX-XXXX из случайных байтов. */
async function createCellLicense({ durationDays, deviceLimit, marketplaceScope = 'wb', note = '', ownerUserId = null }) {
  const days = Number(durationDays);
  const devices = Number(deviceLimit);
  if (!CELL_DURATIONS.includes(days) || !CELL_DEVICE_LIMITS.includes(devices) || !['wb','ozon','both'].includes(marketplaceScope)) {
    return { error: 'Выберите срок и число устройств' };
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const part = () => crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase();
    const key = `CP-${part()}-${part()}-${part()}`;
    try {
      const rows = await supabaseFetch(RESOURCES.cellLicense.table, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          key, source: 'admin',
          ...RESOURCES.cellLicense.toDb({ durationDays: days, deviceLimit: devices, marketplaceScope, note }),
          ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
        }),
      });
      return { row: rows[0] };
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  throw new Error('Could not generate a unique cell print key');
}

/**
 * Проверки и довесок к PATCH лицензии печати ячеек.
 * Возвращает { extra } с полями, которые надо дописать к обычному toDb.
 */
async function checkCellLicensePatch(id, body) {
  const current = await supabaseFetch(`${RESOURCES.cellLicense.table}?id=eq.${id}&select=duration_days,expires_at&limit=1`);
  if (!current.length) return { error: 'Ключ не найден', status: 404 };
  const extra = {};
  if ('deviceLimit' in body) {
    const limit = Number(body.deviceLimit);
    if (!CELL_DEVICE_LIMITS.includes(limit)) return { error: 'Число устройств: 1, 2, 3, 5, 10 или 20' };
    const used = await supabaseFetch(`cell_print_activations?license_id=eq.${id}&select=id`);
    if (limit < used.length) return { error: `Ключ уже активирован на ${used.length} устр. — лимит меньше сделать нельзя` };
  }
  if ('extendDays' in body) {
    const days = Number(body.extendDays);
    if (!Number.isInteger(days) || days < 1 || days > CELL_MAX_DAYS) return { error: `Продление: от 1 до ${CELL_MAX_DAYS} дней` };
    const total = Number(current[0].duration_days) + days;
    if (total > CELL_MAX_DAYS) return { error: `Суммарный срок ключа не может быть больше ${CELL_MAX_DAYS} дней` };
    extra.duration_days = total;
    // Неактивированному ключу двигать нечего: expires_at посчитается при первой активации.
    // Активированный продлеваем от даты окончания, а уже просроченный — от сегодня.
    if (current[0].expires_at) {
      extra.expires_at = new Date(Math.max(Date.parse(current[0].expires_at), Date.now()) + days * 86400000).toISOString();
    }
  }
  return { extra };
}

async function checkProgramPromoPatch(id, body) {
  const validationError = validateProgramPromo(body || {}, false);
  if (validationError) return { error: validationError };
  if ('limit' in body) {
    const current = await supabaseFetch(`${RESOURCES.programPromo.table}?id=eq.${id}&select=used&limit=1`);
    if (!current.length) return { error: 'Промокод не найден', status: 404 };
    if (Number(body.limit) < Number(current[0].used)) return { error: 'Лимит не может быть меньше числа использований' };
  }
  return {};
}

/** Отпечаток админа для журнала: тот же приём, что в _admin-cabinet.js. */
function adminFingerprint(req) {
  return crypto.createHash('sha256')
    .update(String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'admin'))
    .digest('hex').slice(0, 24);
}

/** Журнал ручных операций. Сбой записи не должен отменять уже выданный ключ. */
async function recordAdminAction(req, action, targetUserId, payload = {}) {
  try {
    await supabaseFetch('admin_actions', {
      method: 'POST',
      body: JSON.stringify({
        action,
        target_user_id: isUuid(targetUserId) ? targetUserId : null,
        payload,
        admin_fingerprint: adminFingerprint(req),
      }),
    });
  } catch (error) {
    console.error('admin_actions write failed', error.message);
  }
}

module.exports = {
  CELL_DEVICE_LIMITS, CELL_DURATIONS, CELL_MAX_DAYS, RESOURCES,
  addStickerGenerations, adminFingerprint, checkCellLicensePatch, checkProgramPromoPatch,
  checkStickerAccessPatch, createCellLicense, createProgramKey, createStickerAccessCode,
  isUuid, recordAdminAction, validateProgramPromo, validateStickerAccess,
};
