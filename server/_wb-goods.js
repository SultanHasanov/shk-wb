// Список товаров пункта из WB (goods/list) и поиск клиента по нему — общее для Telegram-бота
// (server/_telegram-wb-bot.js) и веб-версии «Помощника ПВЗ» (server/_pvz-web.js).
// У каждой записи есть buyer_sid, номер ячейки (cell) и телефон клиента (buyer.mobile, середина замаскирована).
const wbPvz = require('./_wb-pvz');

const MAX_PAGES = 20;

function goodSid(item) {
  const value = item?.buyer_sid ?? item?.buyer?.user_sid ?? item?.user_sid ?? item?.buyer_id ?? item?.buyer?.user_id ?? item?.user_id;
  const sid = Number(value);
  return Number.isSafeInteger(sid) && sid > 0 ? String(sid) : null;
}
function goodPhone(item) { return String(item?.buyer?.mobile ?? item?.buyer?.phone ?? item?.mobile ?? item?.phone ?? ''); }
function goodCell(item) { return String(item?.cell ?? item?.cell_address ?? '').trim(); }
// Имя — только покупателя: item.name у товара бывает названием товара, а не клиента.
function goodName(item) { return String(item?.buyer?.name ?? '').trim(); }
// ШК товара: в базе программы это scanned_code / shk_code / sticker_code, в других запросах WB — shk / shk_id;
// точное имя в goods/list не зафиксировано, поэтому берём любое поле верхнего уровня с shk / scanned / sticker
// в названии. barcode не берём — это штрихкод товара (EAN), он одинаков у всех, кто заказал то же.
const GOOD_SHK_FIELD = /shk|scanned|sticker/i;
function goodShks(item) {
  const out = new Set();
  if (!item || typeof item !== 'object') return out;
  for (const [field, raw] of Object.entries(item)) {
    if (!GOOD_SHK_FIELD.test(field) || (typeof raw !== 'string' && typeof raw !== 'number')) continue;
    const value = String(raw).trim();
    if (/^\d{8,14}$/.test(value)) out.add(value);
  }
  return out;
}

/**
 * Совпадения по запросу: цифры могут быть номером ячейки, хвостом телефона, ШК товара или самим ID клиента (его
 * копируют из программы) — ищем всеми способами.
 */
function findClientsByQuery(goods, digits) {
  const out = new Map();
  for (const item of Array.isArray(goods) ? goods : []) {
    const sid = goodSid(item);
    if (!sid) continue;
    const cell = goodCell(item);
    const phoneDigits = goodPhone(item).replace(/\D/g, '');
    const cellMatch = cell && cell.replace(/\D/g, '') === digits;
    const phoneMatch = digits.length >= 3 && phoneDigits.length >= digits.length && phoneDigits.endsWith(digits);
    const sidMatch = sid === digits;
    const shkMatch = digits.length >= 8 && goodShks(item).has(digits);
    if (!cellMatch && !phoneMatch && !sidMatch && !shkMatch) continue;
    const entry = out.get(sid) || { sid, phone: '', cells: new Set(), name: '', shks: new Set() };
    if (shkMatch) entry.shks.add(digits);
    if (cell) entry.cells.add(cell);
    if (!entry.phone && goodPhone(item)) entry.phone = goodPhone(item);
    if (!entry.name && goodName(item)) entry.name = goodName(item);
    out.set(sid, entry);
  }
  return [...out.values()];
}

/** Похоже на полный номер телефона: у WB середина номера затёрта, совпасть может только хвост. */
function phoneLike(digits) { return /^(?:[78]\d{10}|9\d{9})$/.test(digits); }

/** Совпадения сразу по нескольким номерам (ШК с одного фото) — один клиент одной строкой. */
function mergeClientMatches(lists) {
  const out = new Map();
  for (const match of lists.flat()) {
    const entry = out.get(match.sid);
    if (!entry) { out.set(match.sid, { ...match, cells: new Set(match.cells), shks: new Set(match.shks) }); continue; }
    match.cells.forEach(cell => entry.cells.add(cell));
    match.shks.forEach(shk => entry.shks.add(shk));
    if (!entry.phone) entry.phone = match.phone;
    if (!entry.name) entry.name = match.name;
  }
  return [...out.values()];
}

/** Весь список товаров пункта: постранично по курсору, не больше MAX_PAGES страниц. */
async function fetchAllGoods(session) {
  const goods = [];
  let cursor = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await wbPvz.loadGoodsInPickPoint(session, cursor);
    goods.push(...result.goods);
    if (!result.goods.length || result.cursor == null || result.cursor <= cursor) break;
    cursor = result.cursor;
  }
  return goods;
}

module.exports = {
  fetchAllGoods, findClientsByQuery, goodCell, goodName, goodPhone, goodShks, goodSid, mergeClientMatches, phoneLike,
};
