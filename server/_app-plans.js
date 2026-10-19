// Тарифы программы «Помощник ПВЗ» — единственное место с ценами и лимитами.
// Отсюда их берут оплата, кабинет, страница программы и сама программа
// (через /api/app/plans), поэтому цифры нигде больше не дублируются.
//
// Лимиты месячные: при оплате на 3/6/12 месяцев квота всё равно обновляется
// каждый месяц от даты начала. Снимок лимитов сохраняется в подписке при покупке.

const PLAN_ORDER = Object.freeze(['basic', 'standard', 'pro']);

// Разделы программы по тарифам. Программа открывает раздел, только если его фича
// есть в списке (список приходит в подписанной аренде, см. _app-update.js).
const BASIC_FEATURES = Object.freeze(['code']);
const STANDARD_FEATURES = Object.freeze([
  ...BASIC_FEATURES, 'cells', 'expensive', 'way', 'boxes', 'goods', 'search', 'reviews', 'telegram', 'tryon', 'notes',
]);
const PRO_FEATURES = Object.freeze([...STANDARD_FEATURES, 'dossier', 'risky', 'staff', 'stickers']);

const PLANS = Object.freeze({
  basic: Object.freeze({
    id: 'basic',
    title: 'Базовый',
    monthlyPrice: 190,
    codes: 15,
    stickers: 0,
    devices: 1,
    summary: 'Подбор кода выдачи для клиента без кода',
    features: BASIC_FEATURES,
  }),
  standard: Object.freeze({
    id: 'standard',
    title: 'Стандарт',
    monthlyPrice: 390,
    codes: 30,
    stickers: 0,
    devices: 1,
    summary: 'Вся работа с ячейками, товарами и отзывами',
    features: STANDARD_FEATURES,
  }),
  pro: Object.freeze({
    id: 'pro',
    title: 'Про',
    monthlyPrice: 790,
    codes: 100,
    stickers: 300,
    devices: 2,
    summary: 'Досье клиентов, стикеры, сотрудники и зарплата',
    features: PRO_FEATURES,
  }),
});

// Скидка за срок, в процентах.
const TERMS = Object.freeze({ 1: 0, 3: 10, 6: 15, 12: 25 });

const FEATURE_TITLES = Object.freeze({
  code: 'Подбор кода, QR и копирование',
  cells: 'Ячейки и карточка клиента',
  way: 'Товары «В пути»',
  search: 'Поиск по SID и телефону',
  reviews: 'Отзывы WB',
  expensive: 'Дорогие товары',
  telegram: 'Уведомления в Telegram',
  boxes: 'Коробки возвратов на склад',
  goods: 'Товар по ШК: история статусов',
  tryon: 'Окно примерки поверх всех окон',
  notes: 'Заметки о клиентах',
  dossier: 'Досье клиента: отказы и возвраты',
  risky: 'Предупреждение о клиентах с частыми отказами',
  stickers: 'Печать стикеров товаров и коробок',
  staff: 'Сотрудники: график, зарплата, аванс, удержания WB',
  archive: 'Архив клиентов старше окна WB',
});

// Доп. услуги — покупаются отдельно от тарифа на свой срок. Цена за весь срок.
// Архив программа собирает на ПК всегда; услуга только открывает его чтение,
// поэтому после окончания ничего не теряется.
const ADDONS = Object.freeze({
  archive: Object.freeze({
    id: 'archive',
    title: 'Архив клиентов',
    summary: 'История клиента, телефоны и отказы старше того, что хранит база WB',
    minPlan: 'standard',
    prices: Object.freeze({ 6: 590, 12: 990 }),
    features: Object.freeze(['archive']),
  }),
});

function isPlan(value) {
  return Object.prototype.hasOwnProperty.call(PLANS, value);
}

function isTerm(value) {
  return Object.prototype.hasOwnProperty.call(TERMS, value);
}

function planRank(plan) {
  return PLAN_ORDER.indexOf(plan);
}

function isAddon(value) {
  return Object.prototype.hasOwnProperty.call(ADDONS, value);
}

function addonPrice(addon, months) {
  if (!isAddon(addon)) return null;
  const price = ADDONS[addon].prices[months];
  return price == null ? null : price;
}

// Услуга доступна только на тарифе не ниже minPlan (архиву нечего показывать без ячеек и поиска).
function addonAllowed(addon, plan) {
  return isAddon(addon) && isPlan(plan) && planRank(plan) >= planRank(ADDONS[addon].minPlan);
}

function addonSnapshot(addon, months) {
  const total = addonPrice(addon, months);
  if (total == null) return null;
  return { addon: { addon, months, price: total }, total };
}

/**
 * Итоговый список фич: тариф + активные услуги. Бесплатный режим = Про со всеми услугами.
 * addons — { archive: { ends_at } } из app_entitlements.
 */
function effectiveFeatures(plan, addons, free) {
  if (free) return [...new Set([...PRO_FEATURES, ...Object.values(ADDONS).flatMap(a => a.features)])];
  const base = isPlan(plan) ? [...PLANS[plan].features] : [];
  for (const [id, info] of Object.entries(addons || {})) {
    if (addonAllowed(id, plan) && info && Date.parse(info.ends_at) > Date.now()) base.push(...ADDONS[id].features);
  }
  return [...new Set(base)];
}

// Цена в рублях без копеек: людям проще 1710 ₽, чем 1710,00.
function planPrice(plan, months) {
  if (!isPlan(plan) || !isTerm(months)) return null;
  return Math.round((PLANS[plan].monthlyPrice * months * (100 - TERMS[months])) / 100);
}

// Снимок для заказа: SQL (complete_app_subscription_order) берёт лимиты отсюда.
function orderSnapshot(plan, months) {
  const total = planPrice(plan, months);
  if (total == null) return null;
  const p = PLANS[plan];
  return {
    app: {
      plan,
      term_months: months,
      discount_percent: TERMS[months],
      monthly_price: p.monthlyPrice,
      codes: p.codes,
      stickers: p.stickers,
      devices: p.devices,
    },
    total,
  };
}

function publicPlans() {
  return {
    order: PLAN_ORDER,
    terms: Object.keys(TERMS).map(months => ({ months: Number(months), discountPercent: TERMS[months] })),
    features: FEATURE_TITLES,
    plans: PLAN_ORDER.map(id => {
      const p = PLANS[id];
      return {
        id,
        title: p.title,
        summary: p.summary,
        monthlyPrice: p.monthlyPrice,
        codes: p.codes,
        stickers: p.stickers,
        devices: p.devices,
        features: p.features,
        prices: Object.fromEntries(Object.keys(TERMS).map(months => [months, planPrice(id, Number(months))])),
      };
    }),
    addons: Object.values(ADDONS).map(a => ({
      id: a.id,
      title: a.title,
      summary: a.summary,
      minPlan: a.minPlan,
      prices: { ...a.prices },
      features: [...a.features],
    })),
  };
}

module.exports = {
  ADDONS, FEATURE_TITLES, PLAN_ORDER, PLANS, TERMS,
  addonAllowed, addonPrice, addonSnapshot, effectiveFeatures, isAddon, isPlan, isTerm,
  orderSnapshot, planPrice, planRank, publicPlans,
};
