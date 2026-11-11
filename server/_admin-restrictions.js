const crypto = require('crypto');
const { supabaseFetch } = require('./_supabase');
const { getAuthUser } = require('./_user-auth');
const { adminError, adminFingerprint, isUuid, recordAdminAction, runIdempotent } = require('./_admin-grants');
const controls = require('./_user-controls');

/**
 * Ограничения аккаунта из админки: полное («all») и по областям (сайт, Помощник ПВЗ, ПВЗ Принт, бот,
 * покупки, выводы), с причиной и сроком.
 *
 * Проверку ограничений в горячих путях делает снимок в памяти (server/_user-controls.js) — здесь только
 * запись и побочные действия. Коды доступа работают без входа в аккаунт, поэтому их приходится выключать:
 * выключаем ровно те, что были включены, и запоминаем их id в disabled_items. Снятие включает обратно
 * только их и только если они всё ещё выключены — выключенное вручную до ограничения так и остаётся.
 * У «Полностью» ещё и бан в GoTrue (как у старой кнопки «Заблокировать»).
 *
 * Вызывается из server/_admin-users.js (таблица DELEGATED) после requireAdmin. liftRestriction зовёт и
 * таймер снятия по сроку (_user-controls.startExpiryWatch) — без запроса, by: 'auto'.
 */

const SCOPES = Object.freeze(['all', 'site', 'app', 'cell_print', 'bot', 'purchases', 'withdrawals']);
// Коды стикеров у «Помощника ПВЗ» не выключаем: пакет генераций работает и на сайте, и в боте, и без
// пакета reserve_sticker_generation молча списала бы генерацию с кошелька (сайт при ограничении app открыт).
// Ключи WBPK — только программа. У «Полностью» выключаем всё: там закрыты и сайт, и покупки.
const SCOPE_TABLES = Object.freeze({
  all: ['sticker_access_codes', 'license_keys', 'cell_print_licenses'],
  app: ['license_keys'],
  cell_print: ['cell_print_licenses'],
  site: [], bot: [], purchases: [], withdrawals: [],
});
const TABLES = Object.freeze(['sticker_access_codes', 'license_keys', 'cell_print_licenses']);
/** Имя таблицы → ключ в restored / disabledItems ответа. */
const TABLE_KEYS = Object.freeze({
  sticker_access_codes: 'stickerCodes',
  license_keys: 'programKeys',
  cell_print_licenses: 'cellLicenses',
});
/** Подписи для предупреждения админке, если часть кодов не выключилась или не включилась. */
const TABLE_LABELS = Object.freeze({
  sticker_access_codes: 'коды стикеров',
  license_keys: 'ключи Помощника ПВЗ',
  cell_print_licenses: 'лицензии ПВЗ Принт',
});
/** Ключ в disabled_items: таблицы, которые при ограничении выключить не удалось (повторит следующее сохранение). */
const PENDING_KEY = 'pending_tables';
const MIN_AHEAD_MS = 5 * 60_000;
const MAX_AHEAD_MS = 5 * 366 * 86400000;
/** Бан длиной в сто лет: GoTrue умеет только срок, «навсегда» у него нет. */
const BAN_FOREVER = '876000h';

function fail(error) {
  return { error };
}

function cleanReason(value, label = 'Укажите причину для журнала') {
  const reason = String(value ?? '').trim();
  if (!reason) return fail(label);
  if (reason.length > 500) return fail('Причина длиннее 500 символов');
  return { value: reason };
}

function parseScopes(value) {
  if (!Array.isArray(value) || !value.length) return fail('Выберите, что ограничить');
  const scopes = value.map(String);
  if (scopes.some(scope => !SCOPES.includes(scope))) return fail('Неизвестная область ограничения');
  if (new Set(scopes).size !== scopes.length) return fail('Области ограничения повторяются');
  if (scopes.includes('all') && scopes.length > 1) return fail('«Полностью» выбирается без других областей');
  return { value: scopes };
}

function parseUntil(value) {
  if (value === null || value === '') return { value: null };
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return fail('Некорректная дата окончания');
  const now = Date.now();
  if (ms <= now + MIN_AHEAD_MS) return fail('Срок должен быть хотя бы на 5 минут вперёд');
  if (ms > now + MAX_AHEAD_MS) return fail('Срок — не дальше пяти лет; для бессрочного выберите «Бессрочно»');
  return { value: new Date(ms).toISOString() };
}

function parsePublicMessage(value) {
  if (value === null) return { value: null };
  if (typeof value !== 'string') return fail('Текст для пользователя: некорректные данные');
  const text = value.trim();
  if (text.length > 300) return fail('Текст для пользователя длиннее 300 символов');
  return { value: text || null };
}

/**
 * Проверка тела restrict (partial=false) или updateRestriction (partial=true). Чистая.
 * В partial-режиме отсутствующее поле — undefined («не менять»).
 */
function validateRestrictBody(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const reason = cleanReason(b.reason);
  if (reason.error) return reason;
  let scopes;
  if (!partial || b.scopes !== undefined) {
    const parsed = parseScopes(b.scopes);
    if (parsed.error) return parsed;
    scopes = parsed.value;
  }
  let until;
  if (!partial || b.until !== undefined) {
    const parsed = parseUntil(b.until === undefined ? null : b.until);
    if (parsed.error) return parsed;
    until = parsed.value;
  }
  let publicMessage;
  if (b.publicMessage !== undefined) {
    const parsed = parsePublicMessage(b.publicMessage);
    if (parsed.error) return parsed;
    publicMessage = parsed.value;
  } else if (!partial) {
    publicMessage = null;
  }
  if (partial && scopes === undefined && until === undefined && publicMessage === undefined) {
    return fail('Нечего менять: укажите области, срок или текст для пользователя');
  }
  return { scopes, until, reason: reason.value, publicMessage, notify: b.notify === true, force: b.force === true };
}

function idList(value) {
  return Array.isArray(value) ? value.map(Number).filter(n => Number.isSafeInteger(n) && n > 0) : [];
}

function restrictionDto(row) {
  if (!row) return null;
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  const until = row.until || null;
  const publicMessage = row.public_message || null;
  const items = row.disabled_items && typeof row.disabled_items === 'object' ? row.disabled_items : {};
  return {
    id: row.id,
    userId: row.user_id,
    scopes,
    full: scopes.includes('all'),
    until,
    expired: Boolean(until) && Date.parse(until) <= Date.now(),
    reason: row.reason || '',
    publicMessage,
    message: controls.restrictionMessage({ publicMessage, until }),
    createdAt: row.created_at || null,
    createdBy: row.created_by || null,
    updatedAt: row.updated_at || row.created_at || null,
    liftedAt: row.lifted_at || null,
    liftedBy: row.lifted_by || null,
    liftedReason: row.lifted_reason || null,
    disabledItems: {
      stickerCodes: idList(items.sticker_access_codes),
      programKeys: idList(items.license_keys),
      cellLicenses: idList(items.cell_print_licenses),
      legacy: items.legacy === true,
    },
  };
}

function tablesFor(scopes) {
  return [...new Set((scopes || []).flatMap(scope => SCOPE_TABLES[scope] || []))];
}

function q(value) {
  return encodeURIComponent(value);
}

/** Действующая запись (lifted_at is null), в том числе просроченная, но ещё не снятая таймером. */
async function loadActiveRestriction(userId) {
  const rows = await supabaseFetch(`user_restrictions?user_id=eq.${q(userId)}&lifted_at=is.null&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

function authConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !serviceKey) throw new Error('Supabase auth environment variables are not configured');
  return { url, serviceKey };
}

/** Бан и разбан в GoTrue — PUT с ban_duration. until: ISO — до даты, null — «навсегда», 'none' — снять. */
async function setAuthBan(userId, until) {
  let duration;
  if (until === 'none') duration = 'none';
  else if (until == null) duration = BAN_FOREVER;
  else {
    const hours = Math.ceil((Date.parse(until) - Date.now()) / 3_600_000);
    duration = Number.isFinite(hours) ? `${Math.max(1, hours)}h` : BAN_FOREVER;
  }
  const { url, serviceKey } = authConfig();
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ban_duration: duration }),
  });
  if (!response.ok) throw new Error(`Unable to update ban state (${response.status})`);
}

/** Сбросить снимок на сайте сразу, на узле бота — через RPC (иначе до 60 с). */
function refreshControls() {
  try {
    controls.invalidate();
  } catch (error) {
    console.error('user controls invalidate failed', error.message);
  }
  Promise.resolve()
    .then(() => require('./_bot-rpc').callBot('invalidateUserControls'))
    .catch(error => console.warn('bot user controls invalidate failed', error.message));
}

/** Защищённый аккаунт: владелец (env-безлимит или снимок) или действующий безлимит из user_overrides. */
async function isProtected(userId) {
  try {
    if (require('./_app-account').isUnlimited(userId)) return true;
  } catch (error) {
    console.error('isUnlimited check failed', error.message);
  }
  const rows = await supabaseFetch(`user_overrides?user_id=eq.${q(userId)}&select=unlimited,unlimited_until&limit=1`).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  return Boolean(row?.unlimited) && (!row.unlimited_until || Date.parse(row.unlimited_until) > Date.now());
}

/** Выключить включённые активы владельца в таблице; вернуть id, которые выключили именно мы. */
async function disableActive(table, userId) {
  const rows = await supabaseFetch(`${table}?owner_user_id=eq.${q(userId)}&active=eq.true&select=id`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ active: false }),
  });
  return idList((rows || []).map(row => row.id));
}

/** Включить обратно только перечисленные id и только если они всё ещё выключены. */
async function enableIds(table, ids) {
  const list = idList(ids);
  if (!list.length) return [];
  const rows = await supabaseFetch(`${table}?id=in.(${list.join(',')})&active=is.false&select=id`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ active: true }),
  });
  return idList((rows || []).map(row => row.id));
}

async function patchRestriction(id, fields, { onlyActive = false } = {}) {
  const rows = await supabaseFetch(`user_restrictions?id=eq.${q(id)}${onlyActive ? '&lifted_at=is.null' : ''}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

/**
 * Записать в строку ограничения, что именно выключили (один повтор). null — не записалось (или строку уже
 * сняли): тогда вызывающий возвращает выключенное обратно, иначе при снятии его нечем было бы включить.
 */
async function saveDisabledItems(row, items) {
  const save = () => patchRestriction(row.id, { disabled_items: items }, { onlyActive: true });
  try {
    return await save().catch(() => save());
  } catch (error) {
    console.error(`restriction ${row.id}: save disabled_items failed`, error.message);
    return null;
  }
}

function pendingTables(items) {
  const list = Array.isArray(items?.[PENDING_KEY]) ? items[PENDING_KEY] : [];
  return list.filter(table => TABLES.includes(table));
}

/** Вернуть выключенное этим запросом, если записать его в ограничение не удалось. Ошибки — в лог. */
async function rollbackDisabled(disabled, label) {
  for (const [table, ids] of Object.entries(disabled)) {
    try {
      await enableIds(table, ids);
    } catch (error) {
      console.error(`${label}: rollback ${table} ids ${idList(ids).join(',')} failed`, error.message);
    }
  }
}

function countItems(items) {
  const out = { stickerCodes: 0, programKeys: 0, cellLicenses: 0 };
  for (const table of TABLES) out[TABLE_KEYS[table]] = idList(items?.[table]).length;
  return out;
}

// Что закрыто — словами для человека (сообщение об ограничении: Telegram, кабинет, почта). Порядок — как в админке.
const SCOPE_WORDS = Object.freeze({
  site: 'сайт shk-wb.ru',
  app: 'программа «Помощник ПВЗ»',
  cell_print: 'программа «ПВЗ Принт»',
  bot: 'Telegram-бот',
  purchases: 'покупки и оплата с баланса',
  withdrawals: 'перевод и вывод вознаграждения за приглашения',
});
const SCOPE_ORDER = Object.freeze(['site', 'app', 'cell_print', 'bot', 'purchases', 'withdrawals']);
const noticeDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * Сообщение «Доступ ограничен»: что закрыто, срок, текст админа для пользователя (если задан) и куда писать.
 * В Telegram — кнопка-ссылка на поддержку: callback при ограничении «бот» упёрся бы в само ограничение.
 */
function restrictionNotice({ scopes, until, publicMessage } = {}) {
  const list = Array.isArray(scopes) ? scopes : [];
  const closed = list.includes('all')
    ? 'всё — сайт, Telegram-бот и программы'
    : SCOPE_ORDER.filter(scope => list.includes(scope)).map(scope => SCOPE_WORDS[scope]).join(', ');
  const ms = until ? Date.parse(until) : NaN;
  const custom = String(publicMessage || '').trim();
  return {
    subject: 'Доступ ограничен',
    body: [
      `Закрыто: ${closed || 'часть возможностей'}.`,
      `Срок: ${Number.isFinite(ms) ? `до ${noticeDate.format(new Date(ms))}` : 'бессрочно'}.`,
      ...(custom ? [custom] : []),
      'Если считаете это ошибкой — напишите в поддержку.',
    ].join('\n'),
    telegram: { keyboard: [[{ text: '✉️ Написать в поддержку', url: require('./_bot-texts').SUPPORT_URL }]] },
  };
}

/** «Доступ восстановлен»: без повтора заголовка в тексте; в Telegram — сразу в меню бота. */
function liftNotice() {
  return {
    subject: 'Доступ восстановлен',
    body: 'Ограничение снято, всё снова работает.',
    telegram: { keyboard: [[{ text: '☰ Меню', callback_data: 'menu:home' }]] },
  };
}

/** Уведомление пользователю. Ошибка доставки ответ админке не портит. */
async function notifyUser(payload) {
  try {
    return await require('./_admin-messages').deliver({ source: 'admin', ...payload });
  } catch (error) {
    console.error('restriction notify failed', error.message);
    return null;
  }
}

/**
 * Снять ограничение: вернуть выключенное, снять бан, отметить запись. Зовут liftRestrictionAction,
 * unblockCompat и таймер снятия по сроку (by: 'auto', req = null).
 */
/** Старая блокировка не помнила, что выключала: как прежний unblock — включить всё выключенное владельца. */
async function enableAllInactive(table, userId) {
  const rows = await supabaseFetch(`${table}?owner_user_id=eq.${q(userId)}&active=is.false&select=id`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ active: true }),
  });
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Включить выключенное ограничением. Каждая таблица отдельно, один повтор: сбой одной не мешает остальным.
 * Возвращает { restored, failed: [таблица…] }.
 */
async function restoreItems(userId, items, { legacy = false } = {}) {
  const restored = { stickerCodes: 0, programKeys: 0, cellLicenses: 0 };
  const failed = [];
  for (const table of TABLES) {
    const run = async () => {
      let n = (await enableIds(table, items[table])).length;
      if (legacy) n += await enableAllInactive(table, userId);
      return n;
    };
    try {
      restored[TABLE_KEYS[table]] += await run().catch(() => run());
    } catch (error) {
      console.error(`restriction restore ${table} for ${userId} failed`, error.message);
      failed.push(table);
    }
  }
  return { restored, failed };
}

function tablesWarning(prefix, tables, suffix) {
  return `${prefix}: ${tables.map(t => TABLE_LABELS[t] || t).join(', ')}. ${suffix}`;
}

async function liftRestriction(row, reason, { req = null, by = 'admin', notify = false, actionId = null } = {}) {
  const userId = row.user_id;
  const items = row.disabled_items && typeof row.disabled_items === 'object' ? row.disabled_items : {};
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  // Порядок важен: коды работают без входа, поэтому включаем их последними — когда бан уже снят и запись
  // отмечена снятой. Не ответил GoTrue или база — ничего не включено, запись действует, таймер/админ повторит.
  if (scopes.includes('all') || items.legacy === true) await setAuthBan(userId, 'none');
  const now = new Date().toISOString();
  const lifted = await patchRestriction(row.id, {
    lifted_at: now,
    lifted_by: by === 'auto' ? 'auto' : adminFingerprint(req),
    lifted_reason: String(reason || '').trim().slice(0, 500) || null,
  }, { onlyActive: true });
  refreshControls();
  if (!lifted) {
    // строку уже снял другой запрос (таймер или второе окно) — он и включил выключенное; второй раз не трогаем,
    // иначе включили бы то, что админ успел выключить вручную после снятия
    return { restored: countItems({}), restriction: restrictionDto({ ...row, lifted_at: row.lifted_at || now }), alreadyLifted: true };
  }
  const { restored, failed } = await restoreItems(userId, items, { legacy: items.legacy === true });
  const restoreFailed = failed.map(table => TABLE_KEYS[table]);
  if (by === 'auto') {
    await recordAdminAction(null, 'liftRestriction', userId, {
      restrictionId: row.id, auto: true, restored, ...(restoreFailed.length ? { restoreFailed } : {}),
    }, {
      reason, before: { scopes, until: row.until || null }, after: { lifted: true }, result: restoreFailed.length ? 'partial' : 'ok',
    });
  }
  let notifications;
  if (notify) {
    notifications = await notifyUser({
      userId, channels: ['cabinet', 'telegram'], ...liftNotice(),
      actionId, dedupeBase: `lift:${row.id}`,
    });
  }
  const result = { restored, restriction: restrictionDto(lifted || { ...row, lifted_at: now }) };
  if (restoreFailed.length) {
    result.restoreFailed = restoreFailed;
    result.warning = tablesWarning('Ограничение снято, но не удалось включить', failed, 'Включите их вручную в карточке пользователя');
  }
  if (notifications) result.notifications = notifications;
  return result;
}

/** Предупреждение админке о недоделанном (ограничение при этом действует по снимку). */
function restrictWarning({ pending = [], itemsLost = false, authBanFailed = false, restoreFailed = [] }) {
  const parts = [];
  if (pending.length) {
    parts.push(tablesWarning('Ограничение действует, но не удалось выключить', pending, itemsLost
      ? 'Снимите ограничение и наложите заново'
      : 'Сохраните ограничение ещё раз — выключение повторится'));
  }
  if (restoreFailed.length) {
    parts.push(tablesWarning('Не удалось включить обратно', restoreFailed, 'Они включатся при снятии ограничения'));
  }
  if (authBanFailed) parts.push('Вход в аккаунт не закрылся (ошибка сервиса входа). Сохраните ограничение ещё раз.');
  return parts.length ? parts.join(' ') : null;
}

/** Общая часть restrict и blockCompat (внутри runIdempotent). */
async function applyRestriction(req, userId, input, { actionId = null } = {}) {
  const authUser = await getAuthUser(userId);
  if (!authUser) throw adminError(404, 'NOT_FOUND', 'Пользователь не найден');
  let existing = await loadActiveRestriction(userId);
  if (existing && existing.until && Date.parse(existing.until) <= Date.now()) {
    // Срок прошлого ограничения истёк, а таймер его ещё не снял — снимаем сейчас, как снял бы таймер.
    await liftRestriction(existing, 'Срок ограничения истёк', { by: 'auto' });
    existing = null;
  }
  if (existing) {
    throw adminError(409, 'ALREADY_RESTRICTED', 'У пользователя уже есть ограничение — измените его или снимите', { restrictionId: existing.id });
  }
  if (!input.force && await isProtected(userId)) {
    throw adminError(409, 'PROTECTED_ACCOUNT', 'Это защищённый аккаунт (владелец или безлимит). Подтвердите ограничение ещё раз');
  }
  // Сначала строка (уникальный индекс ловит гонку двух запросов), потом выключение кодов.
  let created;
  try {
    const rows = await supabaseFetch('user_restrictions', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: userId,
        scopes: input.scopes,
        reason: input.reason,
        public_message: input.publicMessage || null,
        until: input.until,
        disabled_items: {},
        created_by: adminFingerprint(req),
      }),
    });
    created = Array.isArray(rows) ? rows[0] : rows;
  } catch (error) {
    if (error.status === 409) {
      const other = await loadActiveRestriction(userId).catch(() => null);
      throw adminError(409, 'ALREADY_RESTRICTED', 'У пользователя уже есть ограничение — измените его или снимите', { restrictionId: other?.id || null });
    }
    throw error;
  }
  // Строка уже есть — ограничение действует (снимок). Дальше доводим до конца всё, что получится: сбой одной
  // таблицы не останавливает остальные и бан, а повтор с тем же ключом упёрся бы в ALREADY_RESTRICTED.
  // Невыключенные таблицы запоминаем в pending_tables — их повторит следующее сохранение ограничения.
  let disabled = {};
  let pending = [];
  let itemsLost = false;
  let authBanFailed = false;
  try {
    for (const table of tablesFor(input.scopes)) {
      try {
        const ids = await disableActive(table, userId);
        if (ids.length) disabled[table] = ids;
      } catch (error) {
        console.error(`restriction ${created.id}: disable ${table} failed`, error.message);
        pending.push(table);
      }
    }
    const items = pending.length ? { ...disabled, [PENDING_KEY]: pending } : disabled;
    if (Object.keys(items).length) {
      const saved = await saveDisabledItems(created, items);
      if (saved) created = saved;
      else {
        // не записали, что выключили, — при снятии нечем было бы включить: возвращаем как было
        await rollbackDisabled(disabled, `restriction ${created.id}`);
        disabled = {};
        pending = tablesFor(input.scopes);
        itemsLost = true;
      }
    }
    if (input.scopes.includes('all')) {
      try {
        await setAuthBan(userId, input.until);
      } catch (error) {
        console.error('auth ban failed', error.message);
        authBanFailed = true;
      }
    }
  } finally {
    // и при сбое: строка ограничения уже вставлена (или снята откатом) — снимки должны это увидеть
    refreshControls();
  }
  const restriction = restrictionDto(created);
  let notifications;
  if (input.notify) {
    const blocksSite = controls.covers({ scopes: input.scopes }, 'site');
    notifications = await notifyUser({
      userId,
      // кабинет при ограничении сайта пользователь не откроет — туда не пишем
      channels: blocksSite ? ['telegram', 'email'] : ['cabinet', 'telegram'],
      ...restrictionNotice(restriction),
      actionId,
      dedupeBase: `restrict:${created.id}`,
    });
  }
  return {
    restriction,
    authBanFailed,
    pending,
    warning: restrictWarning({ pending, itemsLost, authBanFailed }),
    notifications,
    after: {
      scopes: input.scopes, until: input.until, publicMessage: input.publicMessage || null,
      ...countItems(disabled),
    },
  };
}

function badRequest(res, error) {
  return res.status(400).json({ error, code: 'VALIDATION_ERROR' });
}

async function restrict(req, res, { userId }) {
  const body = req.body || {};
  const input = validateRestrictBody(body);
  if (input.error) return badRequest(res, input.error);
  return runIdempotent(req, res, {
    action: 'restrict', key: body.idempotencyKey, userId,
    payload: { scopes: input.scopes, until: input.until, publicMessage: input.publicMessage, notify: input.notify, force: input.force },
    reason: input.reason,
  }, async ({ actionId }) => {
    const done = await applyRestriction(req, userId, input, { actionId });
    return {
      status: 201,
      body: {
        restriction: done.restriction,
        ...(done.authBanFailed ? { authBan: 'failed' } : {}),
        ...(done.pending.length ? { pendingTables: done.pending.map(table => TABLE_KEYS[table]) } : {}),
        ...(done.warning ? { warning: done.warning } : {}),
        ...(done.notifications ? { notifications: done.notifications } : {}),
      },
      result: done.authBanFailed || done.pending.length ? 'partial' : 'ok',
      before: { restricted: false },
      after: done.after,
      reason: input.reason,
    };
  });
}

async function updateRestriction(req, res, { userId }) {
  const body = req.body || {};
  const restrictionId = String(body.restrictionId || '');
  if (!isUuid(restrictionId)) return badRequest(res, 'Некорректное ограничение');
  const input = validateRestrictBody(body, { partial: true });
  if (input.error) return badRequest(res, input.error);
  return runIdempotent(req, res, {
    action: 'updateRestriction', key: body.idempotencyKey, userId,
    payload: { restrictionId, scopes: input.scopes, until: input.until, publicMessage: input.publicMessage },
    reason: input.reason,
  }, async () => {
    const rows = await supabaseFetch(`user_restrictions?id=eq.${q(restrictionId)}&user_id=eq.${q(userId)}&select=*&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) throw adminError(404, 'NOT_FOUND', 'Ограничение не найдено');
    if (row.lifted_at) throw adminError(409, 'NOT_RESTRICTED', 'Ограничение уже снято');

    const oldScopes = Array.isArray(row.scopes) ? row.scopes : [];
    const newScopes = input.scopes ?? oldScopes;
    const newUntil = input.until !== undefined ? input.until : row.until || null;
    const oldTables = tablesFor(oldScopes);
    const newTables = tablesFor(newScopes);
    const items = { ...(row.disabled_items && typeof row.disabled_items === 'object' ? row.disabled_items : {}) };
    // убранные: и по старым областям, и всё, что записано в disabled_items, но новым областям уже не нужно
    const removed = TABLES.filter(table => !newTables.includes(table) && (oldTables.includes(table) || idList(items[table]).length));
    // Таблицы, которые прошлый раз выключить не удалось (pending_tables), повторяем при любом сохранении —
    // так сбой при наложении чинится повторным сохранением, а не только снятием и новым ограничением.
    const oldPending = pendingTables(items);
    delete items[PENDING_KEY];
    const toDisable = newTables.filter(table => !oldTables.includes(table) || oldPending.includes(table));

    // Каждая таблица отдельно: сбой одной не останавливает остальные и запись, недоделанное — в предупреждение.
    const newlyDisabled = {};
    const pending = [];
    for (const table of toDisable) {
      try {
        const ids = await disableActive(table, userId);
        if (ids.length) {
          newlyDisabled[table] = ids;
          items[table] = [...new Set([...idList(items[table]), ...ids])];
        }
      } catch (error) {
        console.error(`restriction ${row.id}: disable ${table} failed`, error.message);
        pending.push(table);
      }
    }
    const restoreFailed = [];
    for (const table of removed) {
      try {
        await enableIds(table, items[table]);
        if (items.legacy === true) {
          // старая блокировка: по убранной области включаем всё выключенное владельца, как прежний unblock
          await enableAllInactive(table, userId);
        }
        delete items[table];
      } catch (error) {
        // id остаются в disabled_items — их включит снятие ограничения
        console.error(`restriction ${row.id}: restore ${table} failed`, error.message);
        restoreFailed.push(table);
      }
    }
    if (pending.length) items[PENDING_KEY] = pending;

    const fields = { disabled_items: items };
    if (input.scopes !== undefined) fields.scopes = newScopes;
    if (input.until !== undefined) fields.until = newUntil;
    if (input.publicMessage !== undefined) fields.public_message = input.publicMessage;
    let updated;
    try {
      updated = await patchRestriction(row.id, fields, { onlyActive: true });
    } catch (error) {
      // не записали — выключенное этим запросом вернуть, иначе при снятии его нечем было бы включить
      await rollbackDisabled(newlyDisabled, `restriction ${row.id}`);
      throw error;
    } finally {
      refreshControls();
    }
    if (!updated) {
      await rollbackDisabled(newlyDisabled, `restriction ${row.id}`);
      throw adminError(409, 'NOT_RESTRICTED', 'Ограничение уже снято');
    }

    // Бан у «Полностью» ставим при каждом сохранении (PUT идемпотентен): так повторное сохранение чинит
    // бан, который не поставился при наложении. Истёкший срок бан не продлевает — запись снимет таймер.
    let authBanFailed = false;
    const wasAll = oldScopes.includes('all') || items.legacy === true;
    const isAll = newScopes.includes('all');
    const untilAhead = !newUntil || Date.parse(newUntil) > Date.now();
    try {
      if (isAll && untilAhead) await setAuthBan(userId, newUntil);
      else if (wasAll && !isAll) await setAuthBan(userId, 'none');
    } catch (error) {
      console.error('auth ban update failed', error.message);
      authBanFailed = true;
    }
    const warning = restrictWarning({ pending, authBanFailed, restoreFailed });
    return {
      status: 200,
      body: {
        restriction: restrictionDto(updated),
        ...(authBanFailed ? { authBan: 'failed' } : {}),
        ...(pending.length ? { pendingTables: pending.map(table => TABLE_KEYS[table]) } : {}),
        ...(restoreFailed.length ? { restoreFailed: restoreFailed.map(table => TABLE_KEYS[table]) } : {}),
        ...(warning ? { warning } : {}),
      },
      result: warning ? 'partial' : 'ok',
      before: { scopes: oldScopes, until: row.until || null, publicMessage: row.public_message || null },
      after: { scopes: newScopes, until: newUntil, publicMessage: updated.public_message || null },
      reason: input.reason,
    };
  });
}

async function liftRestrictionAction(req, res, { userId }) {
  const body = req.body || {};
  const reason = cleanReason(body.reason);
  if (reason.error) return badRequest(res, reason.error);
  const restrictionId = body.restrictionId == null || body.restrictionId === '' ? null : String(body.restrictionId);
  if (restrictionId && !isUuid(restrictionId)) return badRequest(res, 'Некорректное ограничение');
  const notify = body.notify === true;
  return runIdempotent(req, res, {
    action: 'liftRestriction', key: body.idempotencyKey, userId, payload: { restrictionId, notify }, reason: reason.value,
  }, async ({ actionId }) => {
    const row = await loadActiveRestriction(userId);
    if (!row || (restrictionId && row.id !== restrictionId)) throw adminError(409, 'NOT_RESTRICTED', 'Ограничение уже снято');
    // журнал этой строкой пишет runIdempotent — liftRestriction с by:'admin' второй строки не добавляет
    const lifted = await liftRestriction(row, reason.value, { req, by: 'admin', notify, actionId });
    if (lifted.alreadyLifted) throw adminError(409, 'NOT_RESTRICTED', 'Ограничение уже снято');
    return {
      status: 200,
      body: lifted,
      payload: { restrictionId: row.id, notify, restored: lifted.restored },
      before: { scopes: row.scopes || [], until: row.until || null },
      after: { lifted: true, ...lifted.restored },
      reason: reason.value,
    };
  });
}

/** Старые окна ключ повтора не шлют — сервер делает свой, чтобы журнал и повтор шли тем же путём. */
function compatKey(body) {
  return body?.idempotencyKey || `compat-${crypto.randomUUID()}`;
}

/** Старая кнопка «Заблокировать» = ограничение «Полностью», бессрочно. */
async function blockCompat(req, res, { userId }) {
  const body = req.body || {};
  const reason = String(body.reason || '').trim().slice(0, 500) || 'Блокировка из старой кнопки';
  const input = { scopes: ['all'], until: null, reason, publicMessage: null, notify: false, force: false };
  return runIdempotent(req, res, {
    action: 'block', key: compatKey(body), userId, payload: { scopes: ['all'] }, reason,
  }, async ({ actionId }) => {
    const done = await applyRestriction(req, userId, input, { actionId });
    return {
      status: 200,
      body: { banned: true, ...(done.authBanFailed ? { authBan: 'failed' } : {}), ...(done.warning ? { warning: done.warning } : {}) },
      result: done.authBanFailed || done.pending.length ? 'partial' : 'ok',
      before: { restricted: false },
      after: done.after,
      reason,
    };
  });
}

/** Старая кнопка «Разблокировать»: есть ограничение — снять его; нет — только снять бан GoTrue. */
async function unblockCompat(req, res, { userId }) {
  const body = req.body || {};
  const reason = String(body.reason || '').trim().slice(0, 500) || 'Разблокировка из старой кнопки';
  return runIdempotent(req, res, {
    action: 'unblock', key: compatKey(body), userId, payload: {}, reason,
  }, async ({ actionId }) => {
    const row = await loadActiveRestriction(userId);
    if (row) {
      const lifted = await liftRestriction(row, reason, { req, by: 'admin', actionId });
      return {
        status: 200,
        body: { banned: false },
        payload: { restrictionId: row.id, restored: lifted.restored },
        before: { scopes: row.scopes || [], until: row.until || null },
        after: { lifted: true, ...lifted.restored },
        reason,
      };
    }
    await setAuthBan(userId, 'none');
    return { status: 200, body: { banned: false }, before: null, after: { banned: false }, reason };
  });
}

module.exports = {
  SCOPES, SCOPE_TABLES, validateRestrictBody, restrictionDto, loadActiveRestriction, setAuthBan, restrict, updateRestriction,
  liftRestrictionAction, blockCompat, unblockCompat, liftRestriction, restrictionNotice, liftNotice,
};
