/**
 * Партнёрка: общие типы и денежные расчёты для панели партнёра и админки.
 *
 * Деньги считаются так же, как в 20261015_partners.sql (partner_take +
 * partner_price_kzt): стоимость в рублях = единицы × оптовая цена партнёра,
 * цена клиенту = своя от партнёра или стоимость × курс × (1 + наценка).
 * Здесь это превью до выпуска; в журнал пишет сервер, и его числа главные.
 */

export type PartnerResource = 'sticker' | 'program' | 'cell';

export type PartnerPoolEntry = { granted: number; used: number };

export type Partner = {
  id: string;
  userId: string;
  name: string;
  country: string;
  currency: 'RUB' | 'KZT';
  active: boolean;
  note: string;
  createdAt: string;
  prices: Record<PartnerResource, number>;
  markupPercent: number;
  pool: Record<PartnerResource, PartnerPoolEntry>;
};

export type PartnerBalance = {
  issuedRub: number;
  paidRub: number;
  dueRub: number;
  revenueKzt: number;
};

export type PartnerItem = {
  kind: PartnerResource;
  id: number;
  value: string;
  note: string;
  active: boolean;
  createdAt: string;
  limit?: number;
  used?: number;
  durationDays?: number;
  deviceLimit?: number;
  marketplaceScope?: string;
  activatedAt?: string | null;
  expiresAt?: string | null;
};

export type PartnerLedgerEntry = {
  id: number;
  resource: PartnerResource;
  delta: number;
  kind: 'grant' | 'issue' | 'topup';
  refId: number | null;
  refLabel: string | null;
  actor: 'owner' | 'partner';
  note: string;
  costRub: number | null;
  kztPerRub: number | null;
  priceKzt: number | null;
  createdAt: string;
};

export type PartnerPayment = { id: number; amountRub: number; note: string; createdAt: string };

type ResourceLabel = { title: string; unit: string; short: string };

export const RESOURCE_LABELS: Record<PartnerResource, ResourceLabel> = {
  sticker: { title: 'Генерации (коды стикеров и QR)', unit: 'генераций', short: 'Код стикеров' },
  program: { title: 'Итерации «Подбора кодов»', unit: 'итераций', short: 'Ключ программы' },
  cell: { title: 'Печать ячеек, дни·ПК', unit: 'дней·ПК', short: 'Ключ печати ячеек' },
};

/** Подписи для панели партнёра на казахском; админка владельца всегда русская. */
const RESOURCE_LABELS_KK: Record<PartnerResource, ResourceLabel> = {
  sticker: { title: 'Генерациялар (стикер және QR кодтары)', unit: 'генерация', short: 'Стикер коды' },
  program: { title: '«Кодтарды іріктеу» итерациялары', unit: 'итерация', short: 'Бағдарлама кілті' },
  cell: { title: 'Ұяшық басып шығару, күн·ДК', unit: 'күн·ДК', short: 'Ұяшық басып шығару кілті' },
};

export function resourceLabels(locale: 'ru' | 'kk') {
  return locale === 'kk' ? RESOURCE_LABELS_KK : RESOURCE_LABELS;
}

export const CELL_DURATIONS = [3, 7, 30, 90, 180, 365] as const;
export const CELL_DEVICE_LIMITS = [1, 2, 3, 5, 10, 20] as const;

export function poolLeft(entry: PartnerPoolEntry) {
  return Math.max(0, entry.granted - entry.used);
}

export function costRub(units: number, unitPrice: number) {
  return Math.round(units * unitPrice * 100) / 100;
}

/** Цена клиенту по наценке, до целого тенге — как partner_price_kzt. */
export function suggestedKzt(cost: number, kztPerRub: number, markupPercent: number) {
  return Math.round(cost * kztPerRub * (1 + markupPercent / 100));
}

const rubFormat = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const kztFormat = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'KZT', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 });

export const formatRub = (value: number) => rubFormat.format(value);
export const formatKzt = (value: number) => kztFormat.format(value);

/** Готовый текст для клиента: партнёр отправляет его в мессенджер одной кнопкой.
 *  На казахском — со ссылками на казахскую версию сайта. */
export function clientMessage(
  item: Pick<PartnerItem, 'kind' | 'value' | 'limit' | 'durationDays' | 'deviceLimit'>,
  locale: 'ru' | 'kk' = 'ru',
) {
  if (locale === 'kk') {
    if (item.kind === 'sticker') {
      return `shk-wb.ru стикер генераторына қолжетімділік кодыңыз: ${item.value}\n` +
        `Генерациялар: ${item.limit}. Кодты https://shk-wb.ru/kz сайтындағы «Қолжетімділік коды» өрісіне енгізіңіз.`;
    }
    if (item.kind === 'program') {
      return `«Кодтарды іріктеу» бағдарламасының кілті: ${item.value}\n` +
        `Итерациялар: ${item.limit}. Бағдарламаны жүктеу: https://shk-wb.ru/kz/program`;
    }
    return `«Ұяшық басып шығару» бағдарламасының кілті: ${item.value}\n` +
      `Мерзімі: алғашқы белсендіруден бастап ${item.durationDays} күн, компьютерлер: ${item.deviceLimit}. ` +
      'Бағдарламаны жүктеу: https://shk-wb.ru/kz/cell-print';
  }
  if (item.kind === 'sticker') {
    return `Ваш код доступа к генератору стикеров shk-wb.ru: ${item.value}\n` +
      `Генераций: ${item.limit}. Введите код на сайте https://shk-wb.ru в поле «Код доступа».`;
  }
  if (item.kind === 'program') {
    return `Ваш ключ программы «Подбор кодов»: ${item.value}\n` +
      `Итераций: ${item.limit}. Скачать программу: https://shk-wb.ru/program`;
  }
  return `Ваш ключ программы «Печать ячеек»: ${item.value}\n` +
    `Срок: ${item.durationDays} дн. с первой активации, компьютеров: ${item.deviceLimit}. ` +
    'Скачать программу: https://shk-wb.ru/cell-print';
}
