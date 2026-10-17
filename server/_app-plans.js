// Тарифы программы «Помощник ПВЗ» — единственное место с ценами и лимитами.
// Отсюда их берут оплата, кабинет, страница программы и сама программа
// (через /api/app/plans), поэтому цифры нигде больше не дублируются.
//
// Лимиты месячные: при оплате на 3/6/12 месяцев квота всё равно обновляется
// каждый месяц от даты начала. Снимок лимитов сохраняется в подписке при покупке.

const PLAN_ORDER = Object.freeze(['basic', 'standard', 'pro']);

const PLANS = Object.freeze({
  basic: Object.freeze({
    id: 'basic',
    title: 'Базовый',
    monthlyPrice: 190,
    codes: 15,
    stickers: 0,
    devices: 1,
    summary: 'Подбор кода выдачи для клиента без кода',
    features: ['code'],
  }),
  standard: Object.freeze({
    id: 'standard',
    title: 'Стандарт',
    monthlyPrice: 390,
    codes: 30,
    stickers: 0,
    devices: 1,
    summary: 'Вся работа с ячейками, товарами и отзывами',
    features: ['code', 'cells', 'way', 'search', 'reviews', 'expensive', 'telegram'],
  }),
  pro: Object.freeze({
    id: 'pro',
    title: 'Про',
    monthlyPrice: 790,
    codes: 100,
    stickers: 300,
    devices: 2,
    summary: 'Досье клиентов, стикеры, сотрудники и зарплата',
    features: ['code', 'cells', 'way', 'search', 'reviews', 'expensive', 'telegram', 'dossier', 'stickers', 'staff', 'sync'],
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
  dossier: 'Досье клиента: отказы и возвраты',
  stickers: 'Печать стикеров товаров и коробок',
  staff: 'Сотрудники, смены и зарплата',
  sync: 'Настройки в облаке на всех ПК',
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
  };
}

module.exports = { FEATURE_TITLES, PLAN_ORDER, PLANS, TERMS, isPlan, isTerm, orderSnapshot, planPrice, planRank, publicPlans };
