const { supabaseFetch } = require('./_supabase');
const { adminFingerprint, adminError, runIdempotent } = require('./_admin-grants');

/**
 * Ручные лимиты и кошелёк из карточки пользователя админки.
 *
 * Лимиты — одна строка user_overrides на пользователя (RPC app_user_override меняет только присланные
 * поля и отдаёт строку «до» и «после» для журнала). Итог считает сама база в app_entitlements, поэтому
 * после записи перечитываем его и отдаём карточке. Кошелёк — перегрузка admin_wallet_adjust с ключом
 * события: повтор с тем же ключом повтора не спишет и не зачислит второй раз.
 *
 * Вызывается из server/_admin-users.js (таблица DELEGATED) после requireAdmin — прав здесь не проверяем.
 */

const LIMITS = Object.freeze({ codes: 100000, slots: 20, comment: 200, reason: 500, note: 300, wallet: 10_000_000 });
const UNTIL_MAX_MS = 3 * 366 * 86400000;           // ручной лимит — не дальше трёх лет
const OVERRIDE_FIELDS = Object.freeze([
  'codes_mode', 'codes_monthly', 'codes_until', 'devices_bonus', 'points_bonus', 'mirror_bonus',
  'slots_until', 'unlimited', 'unlimited_until', 'note',
]);

function fail(error) {
  return { error };
}

function intIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** until: null (бессрочно) или ISO в будущем, не дальше трёх лет. undefined → null. */
function parseUntil(value, label) {
  if (value === undefined || value === null || value === '') return { value: null };
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return fail(`${label}: некорректная дата`);
  const now = Date.now();
  if (ms <= now) return fail(`${label}: дата уже прошла`);
  if (ms > now + UNTIL_MAX_MS) return fail(`${label}: не дальше трёх лет`);
  return { value: new Date(ms).toISOString() };
}

function cleanReason(value) {
  const reason = String(value ?? '').trim();
  if (!reason) return fail('Укажите причину для журнала');
  if (reason.length > LIMITS.reason) return fail('Причина длиннее 500 символов');
  return { value: reason };
}

/** Тело setOverrides → p_patch для app_user_override (только присланные секции). Чистая функция. */
function validateOverridesBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const reason = cleanReason(b.reason);
  if (reason.error) return reason;
  const patch = {};
  const sections = [];

  if (b.codes !== undefined) {
    const c = b.codes;
    if (!c || typeof c !== 'object') return fail('Подборы: некорректные данные');
    if (c.mode === 'tariff') {
      Object.assign(patch, { codes_mode: null, codes_monthly: 0, codes_until: null });
    } else if (c.mode === 'add' || c.mode === 'set') {
      const monthly = Number(c.monthly);
      if (!intIn(monthly, 0, LIMITS.codes)) return fail('Подборы в месяц: целое число от 0 до 100000');
      const until = parseUntil(c.until, 'Срок подборов');
      if (until.error) return until;
      Object.assign(patch, { codes_mode: c.mode, codes_monthly: monthly, codes_until: until.value });
    } else {
      return fail('Подборы: выберите «по тарифу», «прибавить» или «точное число»');
    }
    sections.push('codes');
  }

  if (b.slots !== undefined) {
    const s = b.slots;
    if (!s || typeof s !== 'object') return fail('ПК и пункты: некорректные данные');
    const devices = Number(s.devices ?? 0), points = Number(s.points ?? 0), mirror = Number(s.mirror ?? 0);
    for (const [value, label] of [[devices, 'ПК'], [points, 'Пункты'], [mirror, 'Зеркало']]) {
      if (!intIn(value, 0, LIMITS.slots)) return fail(`${label}: целое число от 0 до 20`);
    }
    const until = parseUntil(s.until, 'Срок мест');
    if (until.error) return until;
    Object.assign(patch, { devices_bonus: devices, points_bonus: points, mirror_bonus: mirror, slots_until: until.value });
    sections.push('slots');
  }

  if (b.unlimited !== undefined) {
    const u = b.unlimited;
    if (!u || typeof u !== 'object' || typeof u.enabled !== 'boolean') return fail('Безлимит: укажите, включён ли он');
    let until = { value: null };
    if (u.enabled) {
      until = parseUntil(u.until, 'Срок безлимита');
      if (until.error) return until;
    }
    Object.assign(patch, { unlimited: u.enabled, unlimited_until: u.enabled ? until.value : null });
    sections.push('unlimited');
  }

  if (b.note !== undefined) {
    if (b.note !== null && typeof b.note !== 'string') return fail('Заметка: некорректные данные');
    const note = String(b.note ?? '').trim();
    if (note.length > LIMITS.note) return fail('Заметка длиннее 300 символов');
    patch.note = note || null;
    sections.push('note');
  }

  if (!sections.length) return fail('Нечего менять: выберите подборы, места, безлимит или заметку');
  return { patch, sections, reason: reason.value };
}

/** Тело walletAdjust. kopecks — со знаком: списание отрицательное. Чистая функция. */
function validateWalletBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.direction !== 'credit' && b.direction !== 'debit') return fail('Выберите: пополнить или списать');
  const amount = Number(b.amountKopecks);
  if (!intIn(amount, 1, LIMITS.wallet)) return fail('Сумма: от 0,01 до 100 000 ₽');
  const comment = String(b.comment ?? '').trim();
  if (!comment) return fail('Напишите комментарий — его увидит пользователь');
  if (comment.length > LIMITS.comment) return fail('Комментарий длиннее 200 символов');
  const reason = cleanReason(b.reason);
  if (reason.error) return reason;
  return { kopecks: b.direction === 'debit' ? -amount : amount, comment, notify: b.notify === true, reason: reason.value };
}

function liveUntil(until, now = Date.now()) {
  return !until || Date.parse(until) > now;
}

/** Строка user_overrides → AdminOverrides (формат 3.4 контракта). */
function overridesDto(row) {
  if (!row || typeof row !== 'object') return null;
  const now = Date.now();
  const devices = Number(row.devices_bonus || 0), points = Number(row.points_bonus || 0), mirror = Number(row.mirror_bonus || 0);
  return {
    codes: row.codes_mode === 'add' || row.codes_mode === 'set'
      ? { mode: row.codes_mode, monthly: Number(row.codes_monthly || 0), until: row.codes_until || null, active: liveUntil(row.codes_until, now) }
      : null,
    slots: devices || points || mirror
      ? { devices, points, mirror, until: row.slots_until || null, active: liveUntil(row.slots_until, now) }
      : null,
    unlimited: row.unlimited
      ? { enabled: true, until: row.unlimited_until || null, active: liveUntil(row.unlimited_until, now) }
      : null,
    note: row.note || null,
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null,
  };
}

/** Плоская строка для журнала (было → стало): только поля лимитов. */
function flatOverrides(row) {
  if (!row || typeof row !== 'object') return null;
  const out = {};
  for (const field of OVERRIDE_FIELDS) out[field] = row[field] ?? null;
  return out;
}

function unlimitedOn(row) {
  return Boolean(row?.unlimited) && liveUntil(row?.unlimited_until);
}

async function loadOverrides(userId) {
  const rows = await supabaseFetch(`user_overrides?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

/** Снимок ограничений и безлимита: на сайте — сразу, на узле бота — через RPC (иначе до 60 с). */
function refreshControls(touchBot) {
  try {
    require('./_user-controls').invalidate();
  } catch (error) {
    console.error('user controls invalidate failed', error.message);
  }
  if (touchBot) {
    Promise.resolve()
      .then(() => require('./_bot-rpc').callBot('invalidateUserControls'))
      .catch(error => console.warn('bot user controls invalidate failed', error.message));
  }
}

async function freshEntitlements(userId) {
  return supabaseFetch('rpc/app_entitlements', { method: 'POST', body: JSON.stringify({ p_user: userId }) }).catch(() => null);
}

// Надбавка ПК старого вида (app_device_bonuses) учитывается в SQL через greatest(...): без удаления строки
// новое (меньшее) значение из user_overrides не подействовало бы, а снятие лимитов оставило бы надбавку.
async function dropLegacyDeviceBonus(userId) {
  await supabaseFetch(`app_device_bonuses?user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

function badRequest(res, error) {
  return res.status(400).json({ error, code: 'VALIDATION_ERROR' });
}

async function setOverrides(req, res, { userId }) {
  const body = req.body || {};
  const checked = validateOverridesBody(body);
  if (checked.error) return badRequest(res, checked.error);
  const { patch, sections, reason } = checked;
  return runIdempotent(req, res, {
    action: 'setOverrides', key: body.idempotencyKey, userId, payload: { sections, patch }, reason,
  }, async () => {
    const result = await supabaseFetch('rpc/app_user_override', {
      method: 'POST',
      body: JSON.stringify({ p_user: userId, p_patch: patch, p_by: adminFingerprint(req) }),
    });
    if (sections.includes('slots')) await dropLegacyDeviceBonus(userId);
    const touchedUnlimited = sections.includes('unlimited') || unlimitedOn(result?.before) !== unlimitedOn(result?.after);
    refreshControls(touchedUnlimited);
    const entitlements = await freshEntitlements(userId);
    return {
      status: 200,
      body: { overrides: overridesDto(result?.after), entitlements },
      before: flatOverrides(result?.before),
      after: flatOverrides(result?.after),
      reason,
    };
  });
}

async function clearOverrides(req, res, { userId }) {
  const body = req.body || {};
  const reason = cleanReason(body.reason);
  if (reason.error) return badRequest(res, reason.error);
  return runIdempotent(req, res, {
    action: 'clearOverrides', key: body.idempotencyKey, userId, payload: {}, reason: reason.value,
  }, async () => {
    const result = await supabaseFetch('rpc/app_user_override', {
      method: 'POST',
      body: JSON.stringify({ p_user: userId, p_patch: { clear: true }, p_by: adminFingerprint(req) }),
    });
    await dropLegacyDeviceBonus(userId);
    refreshControls(unlimitedOn(result?.before));
    return {
      status: 200,
      body: { overrides: null },
      before: flatOverrides(result?.before),
      after: null,
      reason: reason.value,
    };
  });
}

function rub(kopecks) {
  const value = Math.abs(Number(kopecks) || 0) / 100;
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ₽`;
}

function walletMessage(kopecks, comment, balanceKopecks) {
  const credit = kopecks > 0;
  return {
    subject: credit ? 'Баланс пополнен' : 'Списание с баланса',
    body: credit
      ? `Баланс пополнен на ${rub(kopecks)}: «${comment}». Сейчас на балансе ${rub(balanceKopecks)}.`
      : `С баланса списано ${rub(kopecks)}: «${comment}». Сейчас на балансе ${rub(balanceKopecks)}.`,
  };
}

async function walletAdjust(req, res, { userId }) {
  const body = req.body || {};
  const checked = validateWalletBody(body);
  if (checked.error) return badRequest(res, checked.error);
  const { kopecks, comment, notify, reason } = checked;
  const key = body.idempotencyKey;
  return runIdempotent(req, res, {
    action: 'walletAdjust', key, userId,
    payload: { direction: kopecks > 0 ? 'credit' : 'debit', amountKopecks: Math.abs(kopecks), comment, notify },
    reason,
  }, async ({ actionId }) => {
    const accounts = await supabaseFetch(`wallet_accounts?user_id=eq.${encodeURIComponent(userId)}&select=balance_kopecks&limit=1`);
    const beforeKopecks = Number(accounts?.[0]?.balance_kopecks || 0);
    const result = await supabaseFetch('rpc/admin_wallet_adjust', {
      method: 'POST',
      body: JSON.stringify({ p_user: userId, p_kopecks: kopecks, p_note: comment, p_event_key: String(key) }),
    });
    if (!result || result.ok !== true) {
      const balanceKopecks = Number(result?.balance ?? beforeKopecks);
      throw adminError(409, 'INSUFFICIENT_BALANCE', `Недостаточно средств: на балансе ${rub(balanceKopecks)}`, { balanceKopecks });
    }
    const balanceKopecks = Number(result.balance || 0);
    const duplicate = result.duplicate === true;
    let notified;
    if (notify && !duplicate) {
      try {
        const text = walletMessage(kopecks, comment, balanceKopecks);
        notified = await require('./_admin-messages').deliver({
          userId, channels: ['cabinet', 'telegram', 'email'], subject: text.subject, body: text.body, link: '/cabinet',
          source: 'admin', actionId, dedupeBase: `wallet:${actionId}`,
        });
      } catch (error) {
        console.error('wallet adjust notify failed', error.message);
      }
    }
    return {
      status: 200,
      body: { beforeKopecks, balanceKopecks, duplicate, ...(notified ? { notifications: notified } : {}) },
      before: { balanceKopecks: beforeKopecks },
      after: { balanceKopecks },
      reason,
    };
  });
}

module.exports = {
  LIMITS, validateOverridesBody, validateWalletBody, overridesDto, flatOverrides, loadOverrides,
  setOverrides, clearOverrides, walletAdjust,
};
