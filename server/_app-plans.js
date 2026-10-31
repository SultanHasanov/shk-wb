// Тарифы программы «Помощник ПВЗ» — единственное место с ценами и лимитами.
// Отсюда их берут оплата, кабинет, страница программы и сама программа
// (через /api/app/plans), поэтому цифры нигде больше не дублируются.
//
// Лимиты месячные: при оплате на 3/6/12 месяцев квота всё равно обновляется
// каждый месяц от даты начала. Снимок лимитов сохраняется в подписке при покупке.

const PLAN_ORDER = Object.freeze(['basic', 'standard', 'pro']);
// В продаже только два тарифа. «Базовый» остаётся для действующих подписок и пакетов кодов.
const SALE_PLANS = Object.freeze(['standard', 'pro']);

// Разделы программы по тарифам. Программа открывает раздел, только если его фича
// есть в списке (список приходит в подписанной аренде, см. _app-update.js).
const BASIC_FEATURES = Object.freeze(['code']);
// Код клиента в Стандарт не входит (кодов в месяц 0), поэтому в списке разделов его нет.
// Раздел при этом открыт на любом тарифе — коды берутся из пакетов, см. effectiveFeatures.
const STANDARD_FEATURES = Object.freeze(['cells', 'way', 'boxes', 'goods', 'search', 'tryon', 'notes']);
const PRO_FEATURES = Object.freeze([
  ...BASIC_FEATURES, ...STANDARD_FEATURES, 'expensive', 'reviews', 'telegram', 'dossier', 'risky', 'staff', 'stickers',
]);
// Стандарт до 31.10.2026 включал эти разделы — купившие его их не теряют. Старую подписку
// узнаём по снимку лимита кодов: в новом Стандарте кодов нет.
const LEGACY_STANDARD_EXTRA = Object.freeze(['expensive', 'reviews', 'telegram']);

const PLANS = Object.freeze({
  basic: Object.freeze({
    id: 'basic',
    title: 'Базовый',
    monthlyPrice: 190,
    codes: 15,
    stickers: 0,
    devices: 1,
    points: 1,
    summary: 'Подбор кода выдачи для клиента без кода',
    features: BASIC_FEATURES,
  }),
  standard: Object.freeze({
    id: 'standard',
    title: 'Стандарт',
    monthlyPrice: 239,
    // Цена аналога за тот же срок — сайт и программа показывают её зачёркнутой рядом с нашей.
    compare: Object.freeze({ 1: 299, 3: 699, 6: 1290 }),
    codes: 0,
    stickers: 0,
    devices: 2,
    points: 1,
    summary: 'Ячейки, товары, поиск клиента и заметки',
    features: STANDARD_FEATURES,
  }),
  pro: Object.freeze({
    id: 'pro',
    title: 'Про',
    monthlyPrice: 399,
    compare: Object.freeze({ 1: 499, 3: 1199, 6: 2290 }),
    codes: 10,
    stickers: 50, // месячный пакет генераций (app_sticker_quota_code), сверх — с баланса
    devices: 4,
    points: 2,
    summary: 'Всё из Стандарта, коды клиента, стикеры, досье, отзывы и сотрудники',
    features: PRO_FEATURES,
  }),
});

// Скидка за срок, в процентах.
const TERMS = Object.freeze({ 1: 0, 3: 22, 6: 28, 12: 35 });

const FEATURE_TITLES = Object.freeze({
  code: 'Код клиента: QR и копирование',
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
  archive: 'Архив клиентов в облаке: на любом ПК и по всем пунктам',
});

// Доп. услуги — покупаются отдельно от тарифа на свой срок. Цена за весь срок.
// Архив программа собирает всегда (на ПК и в облаке аккаунта); услуга открывает его чтение,
// загрузку на другие ПК и просмотр других пунктов, поэтому после окончания ничего не теряется.
//
// Пакеты (kind: 'pack') добавляют ПК и пункты сверх тарифа: цена за месяц, срок — как у
// тарифа (1/3/6/12, та же скидка). Пункт дороже ПК и сам добавляет ещё 2 ПК.
function packPrices(monthly) {
  return Object.freeze(Object.fromEntries(Object.keys(TERMS).map(m => [m, Math.round((monthly * m * (100 - TERMS[m])) / 100)])));
}
const ADDONS = Object.freeze({
  archive: Object.freeze({
    id: 'archive',
    title: 'Архив клиентов',
    summary: 'История клиентов, телефоны и отказы старше того, что хранит база WB, — на любом ПК и по всем вашим пунктам',
    minPlan: 'standard',
    prices: Object.freeze({ 6: 590, 12: 990 }),
    features: Object.freeze(['archive']),
  }),
  devices_1: Object.freeze({
    id: 'devices_1', kind: 'pack', title: '+1 компьютер', summary: 'Ещё один ПК в аккаунте',
    minPlan: 'basic', monthlyPrice: 99, devices: 1, points: 0, prices: packPrices(99), features: Object.freeze([]),
  }),
  devices_3: Object.freeze({
    id: 'devices_3', kind: 'pack', title: '+3 компьютера', summary: 'Ещё три ПК в аккаунте',
    minPlan: 'basic', monthlyPrice: 249, devices: 3, points: 0, prices: packPrices(249), features: Object.freeze([]),
  }),
  points_1: Object.freeze({
    id: 'points_1', kind: 'pack', title: '+1 пункт', summary: 'Ещё один ПВЗ и +2 компьютера',
    minPlan: 'basic', monthlyPrice: 290, devices: 2, points: 1, prices: packPrices(290), features: Object.freeze([]),
  }),
  points_3: Object.freeze({
    id: 'points_3', kind: 'pack', title: '+3 пункта', summary: 'Ещё три ПВЗ и +6 компьютеров',
    minPlan: 'basic', monthlyPrice: 790, devices: 6, points: 3, prices: packPrices(790), features: Object.freeze([]),
  }),
  // Зеркало пункта: его ячейки, «в пути» и клиенты видны с других ПК аккаунта. Цена — за пункт:
  // зеркало занимает место в облаке. Пункты берутся по порядку подключения (первые N).
  mirror_1: Object.freeze({
    id: 'mirror_1', kind: 'pack', title: 'Загрузка с другого ПК', summary: 'Ячейки, «в пути» и история клиентов одного пункта — на других компьютерах аккаунта, напрямую с компьютера пункта',
    minPlan: 'standard', monthlyPrice: 199, devices: 0, points: 0, mirror: 1, prices: packPrices(199), features: Object.freeze(['mirror']),
  }),
  mirror_3: Object.freeze({
    id: 'mirror_3', kind: 'pack', title: 'Загрузка с другого ПК — 3 пункта', summary: 'То же для трёх пунктов',
    minPlan: 'standard', monthlyPrice: 597, devices: 0, points: 0, mirror: 3, prices: packPrices(597), features: Object.freeze(['mirror']),
  }),
});

function isSalePlan(value) {
  return SALE_PLANS.includes(value);
}

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
 * addons — { archive: { ends_at } } из app_entitlements; codesLimit — снимок лимита кодов подписки.
 */
function effectiveFeatures(plan, addons, free, codesLimit = 0) {
  // зеркало в бесплатный режим не входит — только купленное (место в облаке)
  const mirror = mirrorLimit(plan, addons, false) > 0 ? ['mirror'] : [];
  if (free) return [...new Set([...PRO_FEATURES, ...Object.values(ADDONS).flatMap(a => a.features).filter(f => f !== 'mirror'), ...mirror])];
  // 'code' открыт на любом тарифе: подбор всё равно списывается из месячного лимита или пакетов.
  const base = isPlan(plan) ? [...PLANS[plan].features, ...BASIC_FEATURES] : [];
  if (plan === 'standard' && Number(codesLimit) > 0) base.push(...LEGACY_STANDARD_EXTRA);
  for (const [id, info] of Object.entries(addons || {})) {
    if (addonAllowed(id, plan) && info && Date.parse(info.ends_at) > Date.now()) base.push(...ADDONS[id].features);
  }
  return [...new Set(base)];
}

/**
 * Сколько ПК и пунктов можно подключить: тариф (ПК — из снимка подписки, пункты — из
 * конфига) + действующие пакеты. Без подписки — 1 и 1. Бесплатный режим/безлимит — 99.
 */
function accountLimits(plan, addons, subDeviceLimit, unlimited) {
  if (unlimited) return { devices: 99, points: 99 };
  let devices = isPlan(plan) ? Math.max(Number(subDeviceLimit) || 0, PLANS[plan].devices) : 1;
  let points = isPlan(plan) ? PLANS[plan].points : 1;
  for (const [id, info] of Object.entries(addons || {})) {
    const a = ADDONS[id];
    if (a?.kind === 'pack' && info && Date.parse(info.ends_at) > Date.now()) {
      devices += a.devices;
      points += a.points;
    }
  }
  return { devices, points };
}

// Сколько пунктов аккаунта зеркалируется: действующие пакеты mirror_* на тарифе не ниже minPlan.
// Бесплатный режим не даёт зеркала; безлимит — все пункты.
function mirrorLimit(plan, addons, unlimited) {
  if (unlimited) return 99;
  let n = 0;
  for (const [id, info] of Object.entries(addons || {})) {
    const a = ADDONS[id];
    if (a?.mirror && addonAllowed(id, plan) && info && Date.parse(info.ends_at) > Date.now()) n += a.mirror;
  }
  return n;
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
    order: SALE_PLANS,
    terms: Object.keys(TERMS).map(months => ({ months: Number(months), discountPercent: TERMS[months] })),
    features: FEATURE_TITLES,
    plans: SALE_PLANS.map(id => {
      const p = PLANS[id];
      return {
        id,
        title: p.title,
        summary: p.summary,
        monthlyPrice: p.monthlyPrice,
        codes: p.codes,
        stickers: p.stickers,
        devices: p.devices,
        points: p.points,
        features: p.features,
        prices: Object.fromEntries(Object.keys(TERMS).map(months => [months, planPrice(id, Number(months))])),
        comparePrices: { ...(p.compare || {}) },
      };
    }),
    addons: Object.values(ADDONS).map(a => ({
      id: a.id,
      title: a.title,
      summary: a.summary,
      kind: a.kind || 'service',
      minPlan: a.minPlan,
      prices: { ...a.prices },
      features: [...a.features],
      ...(a.kind === 'pack' ? { monthlyPrice: a.monthlyPrice, devices: a.devices, points: a.points, mirror: a.mirror || 0 } : {}),
    })),
  };
}

module.exports = {
  ADDONS, FEATURE_TITLES, PLAN_ORDER, PLANS, SALE_PLANS, TERMS,
  accountLimits, addonAllowed, addonPrice, addonSnapshot, effectiveFeatures, isAddon, isPlan, isSalePlan, isTerm, mirrorLimit,
  orderSnapshot, planPrice, planRank, publicPlans,
};
