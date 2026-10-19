// Бесплатный режим «Помощника ПВЗ»: включается в админке (site_settings.app_free_mode).
// Пока он включён, любой вошедший пользователь получает в программе тариф Про,
// подборы кода не списываются и лимит компьютеров не действует.
//
// Купленная подписка в бесплатный период не расходуется: момент включения пишем в
// site_settings.app_free_since, а при выключении сдвигаем отрезки подписок вперёд
// на длину бесплатного периода (купил месяц + две недели бесплатно = месяц и две недели).
// Значение кэшируется на 30 с, чтобы не ходить в базу на каждый запрос программы.
//
// Дата окончания (site_settings.app_free_until) необязательна: программа показывает по ней
// плашку «бесплатный период до …», а крон (/api/cron/notifications) в эту дату сам
// выключает режим через setAppFreeMode(false) — со сдвигом подписок и услуг.
const { supabaseFetch } = require('./_supabase');

const KEY = 'app_free_mode';
const SINCE_KEY = 'app_free_since';
const UNTIL_KEY = 'app_free_until';
const TTL_MS = 30 * 1000;
let cache = { at: 0, value: false, until: null };

async function readSetting(key) {
  const rows = await supabaseFetch(`site_settings?key=eq.${key}&select=value&limit=1`);
  return rows.length ? rows[0].value : null;
}

async function writeSetting(key, value) {
  await supabaseFetch('site_settings', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

async function refreshCache() {
  if (Date.now() - cache.at < TTL_MS) return cache;
  try {
    const [enabled, until] = await Promise.all([readSetting(KEY), readSetting(UNTIL_KEY)]);
    cache = { at: Date.now(), value: enabled === true, until: enabled === true ? validDate(until) : null };
  } catch {
    // База недоступна — оставляем прошлое значение и пробуем снова через TTL.
    cache = { ...cache, at: Date.now() };
  }
  return cache;
}

// Дата окончания прошла — для программы режим уже выключен; сдвиг подписок сделает крон.
async function appFreeMode() {
  const { value, until } = await refreshCache();
  return value && !(until && Date.parse(until) <= Date.now());
}

// Дата окончания бесплатного периода (ISO) или null — для плашки в программе и кабинете.
async function appFreeUntil() {
  return (await refreshCache()).until;
}

async function freeModeState() {
  const [enabled, since, until] = await Promise.all([readSetting(KEY), readSetting(SINCE_KEY), readSetting(UNTIL_KEY)]);
  const on = enabled === true;
  return { enabled: on, since: on && typeof since === 'string' ? since : null, until: on ? validDate(until) : null };
}

/**
 * Сдвиг подписок за бесплатный период [from, to).
 * Цепочка отрезков пользователя сдвигается целиком на D = to − max(from, начало цепочки):
 * отрезок, начавшийся до бесплатного периода, только удлиняется на D; купленный внутри
 * периода начинается в момент его окончания; следующие за ним отрезки едут следом.
 */
function planShift(rows, fromMs, toMs) {
  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row);
  }
  const patches = [];
  for (const list of byUser.values()) {
    list.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    const shift = toMs - Math.max(fromMs, Date.parse(list[0].starts_at));
    if (shift <= 0) continue;
    // С конца, чтобы отрезки не наезжали друг на друга посреди обновления.
    for (const row of [...list].reverse()) {
      const startMs = Date.parse(row.starts_at);
      const patch = { ends_at: new Date(Date.parse(row.ends_at) + shift).toISOString() };
      if (startMs >= fromMs) patch.starts_at = new Date(startMs + shift).toISOString();
      patches.push({ id: row.id, patch });
    }
  }
  return { users: byUser.size, patches };
}

async function shiftTable(table, groupBy, fromMs, toMs) {
  const rows = await supabaseFetch(
    `${table}?canceled=eq.false&ends_at=gt.${encodeURIComponent(new Date(fromMs).toISOString())}&select=id,${groupBy},starts_at,ends_at`,
  );
  // Цепочка = пользователь (у услуг — пользователь + услуга): planShift группирует по user_id.
  const keyed = rows.map(row => ({ ...row, user_id: groupBy === 'user_id' ? row.user_id : `${row.user_id}:${row.addon}` }));
  const { users, patches } = planShift(keyed, fromMs, toMs);
  for (const { id, patch } of patches) {
    await supabaseFetch(`${table}?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  return { users, segments: patches.length };
}

// Подписки и доп. услуги (архив) сдвигаются одинаково: бесплатный срок их не расходует.
async function extendSubscriptions(from, to) {
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !(toMs > fromMs)) return { users: 0, segments: 0, addons: 0 };
  const subs = await shiftTable('app_subscriptions', 'user_id', fromMs, toMs);
  const addons = await shiftTable('app_addons', 'user_id,addon', fromMs, toMs);
  return { users: subs.users, segments: subs.segments, addons: addons.segments };
}

/**
 * enabled — включить/выключить. until — дата окончания (ISO, null — без даты, undefined — не менять).
 */
async function setAppFreeMode(enabled, until) {
  const value = Boolean(enabled);
  const current = await freeModeState();
  let extended = null;
  if (value && !current.enabled) await writeSetting(SINCE_KEY, new Date().toISOString());
  if (!value && current.enabled) {
    // Сначала сдвиг, потом выключение: если сдвиг упал, режим остаётся включённым.
    // Конец периода — дата окончания, если она уже прошла (крон приходит позже), иначе сейчас.
    const endMs = current.until ? Math.min(Date.now(), Date.parse(current.until)) : Date.now();
    if (current.since) extended = await extendSubscriptions(current.since, new Date(endMs).toISOString());
    await writeSetting(SINCE_KEY, null);
    await writeSetting(UNTIL_KEY, null);
  }
  if (value && until !== undefined) {
    // Проверку «дата в будущем» делает обработчик админки; сюда приходит уже валидное.
    await writeSetting(UNTIL_KEY, until === null ? null : validDate(until));
  }
  if (value !== current.enabled) await writeSetting(KEY, value);
  cache = { at: 0, value, until: null };
  return { ...(await freeModeState()), extended };
}

// Для крона: если дата окончания прошла — выключить режим (со сдвигом подписок).
async function expireAppFreeMode() {
  const state = await freeModeState();
  if (!state.enabled || !state.until || Date.parse(state.until) > Date.now()) return null;
  return setAppFreeMode(false);
}

module.exports = { appFreeMode, appFreeUntil, freeModeState, setAppFreeMode, expireAppFreeMode, extendSubscriptions, planShift };
