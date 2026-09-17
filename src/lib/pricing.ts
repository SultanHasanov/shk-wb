/**
 * Цены пакетов генераций.
 *
 * ИСТОЧНИК ИСТИНЫ — `PACKAGE_PRICES` в server/_payments.js. Тот файл на CommonJS и
 * собирается в серверный бандл, импортировать его во фронтенд нельзя, поэтому
 * таблица продублирована здесь. Чтобы копии не разъехались, есть спек
 * pricing.test.ts: он читает server/_payments.js как текст и сверяет числа.
 * Меняете цену — меняйте в обоих местах, спек не даст забыть.
 */
export const PACKAGE_PRICES: Readonly<Record<number, number>> = Object.freeze({
  1: 5,
  20: 12,
  30: 17,
  40: 22,
  50: 23,
  100: 36,
  200: 63,
  500: 135,
});

/** Тарифы, которые показываем на лендинге (как в старом блоке «Пакеты генераций»). */
export const HEADLINE_PACKS = [1, 50, 100, 200, 500] as const;

/** Пакет, на котором стоит маркер «Чаще всего берут». */
export const POPULAR_PACK = 200;

export type Pack = {
  quantity: number;
  total: number;
  /** Цена за штуку в рублях, не округлённая. */
  perUnit: number;
};

export function getPack(quantity: number): Pack {
  const total = PACKAGE_PRICES[quantity];
  if (total === undefined) throw new Error(`Нет пакета на ${quantity} генераций`);
  return { quantity, total, perUnit: total / quantity };
}

export const HEADLINE_PACK_LIST: readonly Pack[] = HEADLINE_PACKS.map(getPack);

/* ============ Ключи «Печати ячеек» ============
   Матрица «срок × количество компьютеров». Тот же источник истины —
   CELL_PRINT_PRICES в server/_payments.js, сверяется тем же спеком. */

export const CELL_PRINT_PRICES: Readonly<Record<number, Readonly<Record<number, number>>>> =
  Object.freeze({
    7: Object.freeze({ 1: 50, 2: 85, 3: 115, 5: 175, 10: 300, 20: 500 }),
    30: Object.freeze({ 1: 150, 2: 255, 3: 345, 5: 525, 10: 900, 20: 1500 }),
    90: Object.freeze({ 1: 350, 2: 595, 3: 805, 5: 1225, 10: 2100, 20: 3500 }),
    180: Object.freeze({ 1: 600, 2: 1020, 3: 1380, 5: 2100, 10: 3600, 20: 6000 }),
    365: Object.freeze({ 1: 1000, 2: 1700, 3: 2300, 5: 3500, 10: 6000, 20: 10000 }),
  });

/** Сроки в том же порядке, что в таблице цен. 180 дней в старом селекте не было,
 *  хотя тариф существует и на сервере, и в прайсе старой страницы. */
export const CELL_PRINT_DURATIONS = [
  { days: 7, label: '1 неделя' },
  { days: 30, label: '1 месяц' },
  { days: 90, label: '3 месяца' },
  { days: 180, label: '6 месяцев' },
  { days: 365, label: '1 год' },
] as const;

export const CELL_PRINT_DEVICES = [1, 2, 3, 5, 10, 20] as const;

export type CellPrintMarketplaceScope = 'wb' | 'ozon' | 'both';

export const CELL_PRINT_SCOPE_OPTIONS: readonly { value: CellPrintMarketplaceScope; label: string }[] = [
  { value: 'wb', label: 'Wildberries' },
  { value: 'ozon', label: 'Ozon' },
  { value: 'both', label: 'WB + Ozon −10%' },
];

/** Склонение «компьютер / компьютера / компьютеров». */
export function computerWord(count: number): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'компьютеров';
  const mod10 = count % 10;
  if (mod10 === 1) return 'компьютер';
  if (mod10 >= 2 && mod10 <= 4) return 'компьютера';
  return 'компьютеров';
}

export function getCellPrintPrice(days: number, devices: number): number {
  const total = CELL_PRINT_PRICES[days]?.[devices];
  if (total === undefined) throw new Error(`Нет тарифа на ${days} дней и ${devices} устройств`);
  return total;
}

/** WB и Ozon по отдельности стоят одинаково. Комплект дешевле двух отдельных ключей на 10%. */
export function getCellPrintScopedPrice(
  days: number,
  devices: number,
  scope: CellPrintMarketplaceScope,
): number {
  const singleMarketplacePrice = getCellPrintPrice(days, devices);
  return scope === 'both' ? Math.round(singleMarketplacePrice * 2 * 0.9) : singleMarketplacePrice;
}

/** Экономия на компьютер относительно покупки того же срока по одному ПК.
 *  Это главный аргумент тарифов на несколько рабочих мест. */
export function getCellPrintSavingPercent(days: number, devices: number): number {
  if (devices <= 1) return 0;
  const single = getCellPrintPrice(days, 1) * devices;
  return Math.round((1 - getCellPrintPrice(days, devices) / single) * 100);
}

/* ============ Итерации «Подбора кодов» ============ */

/* Сама программа больше не продаётся: установщик отдаётся бесплатно через
   /api/payments/download-program, платными остались только итерации. */

export const LICENSE_PRICES: Readonly<Record<number, number>> = Object.freeze({
  1: 25,
  3: 40,
  5: 50,
  10: 90,
  20: 150,
});

export const POPULAR_LICENSE_PACK = 5;

export function getLicensePack(iterations: number): Pack {
  const total = LICENSE_PRICES[iterations];
  if (total === undefined) throw new Error(`Нет пакета на ${iterations} итераций`);
  return { quantity: iterations, total, perUnit: total / iterations };
}

export const LICENSE_PACK_LIST: readonly Pack[] = Object.keys(LICENSE_PRICES)
  .map(Number)
  .sort((a, b) => a - b)
  .map(getLicensePack);

/** Склонение «итерация / итерации / итераций». */
export function iterationWord(count: number): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'итераций';
  const mod10 = count % 10;
  if (mod10 === 1) return 'итерация';
  if (mod10 >= 2 && mod10 <= 4) return 'итерации';
  return 'итераций';
}

const rub = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
});

/** «135 ₽» */
export function formatTotal(value: number): string {
  return rub.format(value);
}

/** «0,27 ₽» — две цифры после запятой, потому что это главный аргумент сравнения. */
export function formatPerUnit(value: number): string {
  return `${value.toFixed(2).replace('.', ',')} ₽`;
}

/** Минимальная цена за штуку среди всех пакетов — то самое «от 0,27 ₽» в hero. */
export const MIN_PER_UNIT = Math.min(
  ...Object.entries(PACKAGE_PRICES).map(([qty, total]) => total / Number(qty)),
);
