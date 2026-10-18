// Бесплатный режим «Помощника ПВЗ»: включается в админке (site_settings.app_free_mode).
// Пока он включён, любой вошедший пользователь получает в программе тариф Про,
// подборы кода не списываются и лимит компьютеров не действует.
//
// Купленная подписка в бесплатный период не расходуется: момент включения пишем в
// site_settings.app_free_since, а при выключении сдвигаем отрезки подписок вперёд
// на длину бесплатного периода (купил месяц + две недели бесплатно = месяц и две недели).
// Значение кэшируется на 30 с, чтобы не ходить в базу на каждый запрос программы.
const { supabaseFetch } = require('./_supabase');

const KEY = 'app_free_mode';
const SINCE_KEY = 'app_free_since';
const TTL_MS = 30 * 1000;
let cache = { at: 0, value: false };

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

async function appFreeMode() {
  if (Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    cache = { at: Date.now(), value: (await readSetting(KEY)) === true };
  } catch {
    // База недоступна — оставляем прошлое значение и пробуем снова через TTL.
    cache = { at: Date.now(), value: cache.value };
  }
  return cache.value;
}

async function freeModeState() {
  const [enabled, since] = await Promise.all([readSetting(KEY), readSetting(SINCE_KEY)]);
  return { enabled: enabled === true, since: enabled === true && typeof since === 'string' ? since : null };
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

async function extendSubscriptions(from, to) {
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !(toMs > fromMs)) return { users: 0, segments: 0 };
  const rows = await supabaseFetch(
    `app_subscriptions?canceled=eq.false&ends_at=gt.${encodeURIComponent(new Date(fromMs).toISOString())}&select=id,user_id,starts_at,ends_at`,
  );
  const { users, patches } = planShift(rows, fromMs, toMs);
  for (const { id, patch } of patches) {
    await supabaseFetch(`app_subscriptions?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  return { users, segments: patches.length };
}

async function setAppFreeMode(enabled) {
  const value = Boolean(enabled);
  const current = await freeModeState();
  let extended = null;
  if (value && !current.enabled) await writeSetting(SINCE_KEY, new Date().toISOString());
  if (!value && current.enabled) {
    // Сначала сдвиг, потом выключение: если сдвиг упал, режим остаётся включённым.
    if (current.since) extended = await extendSubscriptions(current.since, new Date().toISOString());
    await writeSetting(SINCE_KEY, null);
  }
  if (value !== current.enabled) await writeSetting(KEY, value);
  cache = { at: Date.now(), value };
  return { ...(await freeModeState()), extended };
}

module.exports = { appFreeMode, freeModeState, setAppFreeMode, extendSubscriptions, planShift };
