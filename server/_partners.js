const { supabaseFetch } = require('./_supabase');
const { CELL_DEVICE_LIMITS, CELL_DURATIONS } = require('./_admin-grants');

/**
 * Партнёры: аккаунт сайта, которому владелец выдал пул на выпуск кодов и ключей.
 *
 * Здесь общее для двух входов — кабинета партнёра (api/cabinet.js, action=partner)
 * и админки владельца (server/_admin-partners.js). Списание пула и выпуск идут
 * одним RPC (20261015_partners.sql): проверка остатка и вставка под одной
 * блокировкой, иначе два параллельных выпуска уводят пул в минус.
 */

const RESOURCES = ['sticker', 'program', 'cell'];
const SCOPES = ['wb', 'ozon', 'both'];

/** Тексты ошибок RPC. Коды отдаём клиенту как есть — по ним он покажет перевод. */
const RPC_ERRORS = {
  PARTNER_POOL_EXHAUSTED: 'Недостаточно остатка в пуле. Попросите владельца пополнить его.',
  PARTNER_INACTIVE: 'Партнёрский доступ отключён.',
  PARTNER_NOT_FOUND: 'Партнёр не найден.',
  PARTNER_ITEM_NOT_FOUND: 'Код или ключ не найден.',
  PARTNER_BAD_AMOUNT: 'Некорректное количество.',
  PARTNER_BAD_RESOURCE: 'Неизвестный вид пула.',
  PARTNER_BELOW_USED: 'Нельзя списать больше, чем осталось неизрасходованным.',
};

function rpcErrorCode(error) {
  const message = String(error?.details?.message || '');
  return Object.keys(RPC_ERRORS).find(code => message.includes(code)) || null;
}

/** Ошибку RPC превращает в ответ 400/409; чужие ошибки пробрасывает дальше. */
function sendPartnerError(res, error) {
  const code = rpcErrorCode(error);
  if (!code) return false;
  const status = code === 'PARTNER_POOL_EXHAUSTED' || code === 'PARTNER_BELOW_USED' ? 409 : 400;
  res.status(status).json({ error: RPC_ERRORS[code], code });
  return true;
}

async function rpc(name, body) {
  return supabaseFetch(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
}

function mapPartner(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    country: row.country,
    currency: row.currency,
    active: row.active,
    note: row.note,
    createdAt: row.created_at,
    prices: {
      sticker: Number(row.price_sticker_rub),
      program: Number(row.price_program_rub),
      cell: Number(row.price_cell_rub),
    },
    markupPercent: Number(row.markup_percent),
    pool: {
      sticker: { granted: row.sticker_granted, used: row.sticker_used },
      program: { granted: row.program_granted, used: row.program_used },
      cell: { granted: row.cell_granted, used: row.cell_used },
    },
  };
}

function mapLedger(row) {
  return {
    id: row.id, resource: row.resource, delta: row.delta, kind: row.kind,
    refId: row.ref_id, refLabel: row.ref_label, actor: row.actor, note: row.note,
    costRub: row.cost_rub == null ? null : Number(row.cost_rub),
    kztPerRub: row.kzt_per_rub == null ? null : Number(row.kzt_per_rub),
    priceKzt: row.price_kzt == null ? null : Number(row.price_kzt),
    createdAt: row.created_at,
  };
}

async function getPartnerByUser(userId) {
  const rows = await supabaseFetch(`partners?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  return rows[0] || null;
}

async function getPartner(partnerId) {
  const rows = await supabaseFetch(`partners?id=eq.${encodeURIComponent(partnerId)}&select=*&limit=1`);
  return rows[0] || null;
}

/** Всё, что выпустил партнёр, одним списком: код, ключ программы, ключ ячеек. */
async function listPartnerItems(partnerId) {
  const id = encodeURIComponent(partnerId);
  const [codes, keys, cells] = await Promise.all([
    supabaseFetch(`sticker_access_codes?partner_id=eq.${id}&select=id,code,name,active,generation_limit,generation_used,created_at&order=id.desc`),
    supabaseFetch(`license_keys?partner_id=eq.${id}&select=id,key,note,active,usage_limit,used,created_at&order=id.desc`),
    supabaseFetch(`cell_print_licenses?partner_id=eq.${id}&select=id,key,note,active,duration_days,device_limit,marketplace_scope,activated_at,expires_at,created_at&order=id.desc`),
  ]);
  return [
    ...codes.map(r => ({ kind: 'sticker', id: r.id, value: r.code, note: r.name, active: r.active, limit: r.generation_limit, used: r.generation_used, createdAt: r.created_at })),
    ...keys.map(r => ({ kind: 'program', id: r.id, value: r.key, note: r.note, active: r.active, limit: r.usage_limit, used: r.used, createdAt: r.created_at })),
    ...cells.map(r => ({ kind: 'cell', id: r.id, value: r.key, note: r.note, active: r.active, durationDays: r.duration_days, deviceLimit: r.device_limit, marketplaceScope: r.marketplace_scope, activatedAt: r.activated_at, expiresAt: r.expires_at, createdAt: r.created_at })),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function listPartnerLedger(partnerId, limit = 200) {
  const rows = await supabaseFetch(`partner_ledger?partner_id=eq.${encodeURIComponent(partnerId)}&select=*&order=id.desc&limit=${limit}`);
  return rows.map(mapLedger);
}

function intIn(value, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

/** Своя цена клиенту в тенге; пусто — посчитается по наценке партнёра. */
function priceKzt(body) {
  if (body?.priceKzt === null || body?.priceKzt === undefined || body?.priceKzt === '') return { value: null };
  const value = Number(body.priceKzt);
  if (!Number.isFinite(value) || value < 0 || value > 1e9) return { error: 'Цена в тенге: число от 0' };
  return { value: Math.round(value * 100) / 100 };
}

/** Последняя запись журнала по выпуску — в ней зафиксированы ₽ и ₸ этой операции. */
async function lastLedgerFor(partnerId, refId, resource) {
  const rows = await supabaseFetch(`partner_ledger?partner_id=eq.${encodeURIComponent(partnerId)}&ref_id=eq.${refId}&resource=eq.${resource}&select=*&order=id.desc&limit=1`);
  return rows[0] ? mapLedger(rows[0]) : null;
}

/** Выпуск от имени партнёра. Возвращает { item, entry } или { error }. */
async function issue(partnerId, body) {
  const price = priceKzt(body);
  if (price.error) return { error: price.error };
  const money = { p_rate: await getKztRate(), p_price_kzt: price.value };
  const note = String(body?.note || '').trim().slice(0, 120);
  if (body?.kind === 'sticker') {
    const limit = intIn(body.amount, 1, 100000);
    if (!limit) return { error: 'Генераций в коде: от 1 до 100000' };
    const row = await rpc('partner_issue_sticker_code', { p_partner: partnerId, p_name: note || 'Код партнёра', p_limit: limit, ...money });
    return withEntry(partnerId, 'sticker', { kind: 'sticker', id: row.id, value: row.code, note: row.name, limit: row.generation_limit, used: row.generation_used, active: row.active, createdAt: row.created_at });
  }
  if (body?.kind === 'program') {
    const iterations = intIn(body.amount, 1, 100000);
    if (!iterations) return { error: 'Итераций в ключе: от 1 до 100000' };
    const row = await rpc('partner_issue_program_key', { p_partner: partnerId, p_iterations: iterations, p_note: note, ...money });
    return withEntry(partnerId, 'program', { kind: 'program', id: row.id, value: row.key, note: row.note, limit: row.usage_limit, used: row.used, active: row.active, createdAt: row.created_at });
  }
  if (body?.kind === 'cell') {
    const days = Number(body.durationDays);
    const devices = Number(body.deviceLimit);
    const scope = String(body.marketplaceScope || 'wb');
    if (!CELL_DURATIONS.includes(days) || !CELL_DEVICE_LIMITS.includes(devices) || !SCOPES.includes(scope)) {
      return { error: 'Выберите срок, число ПК и маркетплейс' };
    }
    const row = await rpc('partner_issue_cell_license', { p_partner: partnerId, p_days: days, p_devices: devices, p_scope: scope, p_note: note, ...money });
    return withEntry(partnerId, 'cell', { kind: 'cell', id: row.id, value: row.key, note: row.note, active: row.active, durationDays: row.duration_days, deviceLimit: row.device_limit, marketplaceScope: row.marketplace_scope, createdAt: row.created_at });
  }
  return { error: 'Неизвестный вид выпуска' };
}

/** Пополнение своего кода или ключа программы из пула. */
async function topup(partnerId, body) {
  const id = intIn(body?.id, 1, Number.MAX_SAFE_INTEGER);
  const add = intIn(body?.amount, 1, 100000);
  if (!id || !add) return { error: 'Укажите, сколько добавить: от 1 до 100000' };
  const price = priceKzt(body);
  if (price.error) return { error: price.error };
  const money = { p_rate: await getKztRate(), p_price_kzt: price.value };
  if (body.kind === 'sticker') {
    const row = await rpc('partner_topup_sticker_code', { p_partner: partnerId, p_code_id: id, p_add: add, ...money });
    return withEntry(partnerId, 'sticker', { kind: 'sticker', id: row.id, value: row.code, limit: row.generation_limit, used: row.generation_used });
  }
  if (body.kind === 'program') {
    const row = await rpc('partner_topup_program_key', { p_partner: partnerId, p_key_id: id, p_add: add, ...money });
    return withEntry(partnerId, 'program', { kind: 'program', id: row.id, value: row.key, limit: row.usage_limit, used: row.used });
  }
  return { error: 'Пополнять можно коды стикеров и ключи программы' };
}

async function withEntry(partnerId, resource, item) {
  return { item, entry: await lastLedgerFor(partnerId, item.id, resource) };
}

/** Расчёты: долг в рублях владельцу и выручка в тенге. */
async function getBalance(partnerId) {
  const balance = await rpc('partner_balance', { p_partner: partnerId });
  const issuedRub = Number(balance.issuedRub), paidRub = Number(balance.paidRub);
  return { issuedRub, paidRub, dueRub: Math.round((issuedRub - paidRub) * 100) / 100, revenueKzt: Number(balance.revenueKzt) };
}

async function listPayments(partnerId) {
  const rows = await supabaseFetch(`partner_payments?partner_id=eq.${encodeURIComponent(partnerId)}&select=*&order=id.desc&limit=200`);
  return rows.map(r => ({ id: r.id, amountRub: Number(r.amount_rub), note: r.note, createdAt: r.created_at }));
}

/** Наценку партнёр задаёт сам: это его цена клиенту, на долг владельцу не влияет. */
async function setMarkup(partnerId, body) {
  const value = Number(body?.markupPercent);
  if (!Number.isFinite(value) || value < 0 || value > 10000) return { error: 'Наценка: от 0 до 10000 %' };
  const rows = await supabaseFetch(`partners?id=eq.${encodeURIComponent(partnerId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ markup_percent: Math.round(value * 100) / 100 }),
  });
  return { partner: mapPartner(rows[0]) };
}

const ITEM_TABLES = { sticker: 'sticker_access_codes', program: 'license_keys', cell: 'cell_print_licenses' };

/**
 * Включить или выключить свой код/ключ. Пул при выключении не возвращается:
 * код мог быть уже частично израсходован клиентом, и возврат открыл бы
 * лазейку «выпустил, раздал, выключил, выпустил снова».
 */
async function toggle(partnerId, body) {
  const table = ITEM_TABLES[body?.kind];
  const id = intIn(body?.id, 1, Number.MAX_SAFE_INTEGER);
  if (!table || !id || typeof body.active !== 'boolean') return { error: 'Некорректный запрос' };
  const rows = await supabaseFetch(`${table}?id=eq.${id}&partner_id=eq.${encodeURIComponent(partnerId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ active: body.active }),
  });
  if (!rows.length) return { error: 'Код или ключ не найден', status: 404 };
  return { ok: true };
}

/** Курс тенге к рублю, который владелец задаёт в админке. */
async function getKztRate() {
  const rows = await supabaseFetch('site_settings?key=eq.kzt_per_rub&select=value&limit=1').catch(() => []);
  const rate = Number(rows[0]?.value);
  return Number.isFinite(rate) && rate > 0 ? rate : 5.5;
}

module.exports = {
  ITEM_TABLES, RESOURCES, RPC_ERRORS, getBalance, getKztRate, getPartner, getPartnerByUser, issue,
  listPartnerItems, listPartnerLedger, listPayments, mapPartner, rpc, rpcErrorCode, sendPartnerError,
  setMarkup, toggle, topup,
};
