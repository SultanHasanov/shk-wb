// Сайты, которые обслуживает этот сервер. База, аккаунты и ключи у них общие,
// отличаются адрес сайта и магазин ЮKassa, в который идёт оплата.
//
// Сайт определяется по домену запроса. Заголовок X-Forwarded-Host выставляет сам nginx,
// а незнакомый домен всегда считается основным сайтом.
const MAIN = 'main';
const PVZPRINT = 'pvzprint';

const pvzprintOrigin = () => String(process.env.PVZPRINT_ORIGIN || '').trim().replace(/\/$/, '');

function hostOf(origin) {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return '';
  }
}

/** { id, origin }. У основного сайта origin пустой: его адрес считает publicOrigin(). */
function siteForRequest(req) {
  const origin = pvzprintOrigin();
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim().toLowerCase();
  if (origin && host && host === hostOf(origin)) return { id: PVZPRINT, origin };
  return { id: MAIN, origin: '' };
}

/** Магазин заказа. Пустое значение у всех заказов основного сайта. */
const normalizeShop = shop => (shop === PVZPRINT ? PVZPRINT : MAIN);

/** Реквизиты магазина ЮKassa. Подмены магазина нет: без своих реквизитов оплата на сайте выключена. */
function shopCredentials(shop) {
  const prefix = normalizeShop(shop) === PVZPRINT ? 'YOOKASSA_PVZPRINT' : 'YOOKASSA';
  const shopId = process.env[`${prefix}_SHOP_ID`];
  const secretKey = process.env[`${prefix}_SECRET_KEY`];
  return shopId && secretKey ? { shopId, secretKey } : null;
}

module.exports = { MAIN, PVZPRINT, normalizeShop, shopCredentials, siteForRequest };
