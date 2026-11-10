/** Чистые помощники раздела «Пользователи»: тестируются без DOM и без сети. */

import type { AdminUserRow, AdminUsersFilter, AdminUsersSort } from '../api/admin';
import { formatKopecks, formatMskDateTime, mskDayKeyOf } from './admin-audit';

/** Технической почте telegram-аккаунта в интерфейсе показывать нечего. */
export function isTelegramOnly(email: string | null | undefined): boolean {
  return Boolean(email && email.endsWith('@users.invalid'));
}

export function userLabel(user: {
  email: string | null;
  displayName?: string | null;
  telegramUsername?: string | null;
  userId: string;
}): string {
  if (user.email && !isTelegramOnly(user.email)) return user.email;
  if (user.telegramUsername) return `@${user.telegramUsername}`;
  if (user.displayName) return user.displayName;
  return user.userId.slice(0, 8);
}

/**
 * График регистраций: в ответе есть только дни, когда кто-то зарегистрировался.
 * Без досыпки пустых дней линия врёт — редкие точки выглядят как ровный поток.
 */
export function fillDailySeries(
  points: { day: string; count: number }[],
  days: number,
  today = new Date(),
): { day: string; count: number }[] {
  const known = new Map(points.map(point => [point.day.slice(0, 10), Number(point.count) || 0]));
  const result: { day: string; count: number }[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * 86400000);
    const day = date.toISOString().slice(0, 10);
    result.push({ day, count: known.get(day) ?? 0 });
  }
  return result;
}

const PRODUCT_LABELS: Record<string, string> = {
  stickers: 'Пакеты генераций',
  individual_stickers: 'Индивидуальные стикеры',
  program: 'Программа «Помощник ПВЗ»',
  program_license: 'Пакет подборов «Помощника ПВЗ»',
  wallet_topup: 'Пополнение баланса (бот)',
  cell_print_license: 'Ключи «Печати ячеек»',
  cell_print_program: 'Пробный доступ «Печати ячеек»',
  cell_print_bundle: 'Программа и ключ «Печати ячеек»',
  app_subscription: 'Подписка «Помощник ПВЗ»',
  app_addon: 'Помощник ПВЗ: услуга или пакет',
};

export function productLabel(kind: string): string {
  return PRODUCT_LABELS[kind] ?? kind;
}

const PAYER_LABELS: Record<string, string> = {
  individual: 'Физлицо',
  self_employed: 'Самозанятый',
  entrepreneur: 'ИП',
};

export function payerLabel(status: string | null | undefined): string {
  return status ? (PAYER_LABELS[status] ?? status) : '—';
}

export function orderStatusLabel(status: string): string {
  if (status === 'succeeded') return 'Оплачен';
  if (status === 'canceled') return 'Отменён';
  if (status === 'waiting_for_capture') return 'Ждёт подтверждения';
  return 'Ожидает оплаты';
}

/** Дата без времени: в таблицах пользователей время только мешает. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed)
    ? '—'
    : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short' }).format(new Date(parsed));
}

/* ============ Список пользователей (макет Users / M-Users) ============ */

/** Быстрые фильтры списка — в порядке макета. */
export const USER_FILTERS: ReadonlyArray<{ value: AdminUsersFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'paying', label: 'С покупками' },
  { value: 'subscribed', label: 'С подпиской' },
  { value: 'expiring', label: 'Истекает ≤ 7 дней' },
  { value: 'unlimited', label: 'Безлимит' },
  { value: 'restricted', label: 'Ограничены' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'inactive', label: 'Неактивные' },
];

/**
 * Старые фильтры, которых нет среди чипов, но сервер их понимает: на них могут
 * вести закладки. Чип для такого фильтра появляется, только пока он выбран.
 */
export const LEGACY_USER_FILTERS: ReadonlyArray<{ value: AdminUsersFilter; label: string }> = [
  { value: 'free', label: 'Без покупок' },
  { value: 'banned', label: 'Заблокированные (старое)' },
];

export const USER_SORTS: ReadonlyArray<{ value: AdminUsersSort; label: string }> = [
  { value: 'created_at', label: 'Сначала новые' },
  { value: 'last_sign_in_at', label: 'По последнему входу' },
  { value: 'revenue', label: 'По выручке' },
  { value: 'balance', label: 'По балансу' },
  { value: 'expiring', label: 'Подписка истекает' },
];

/** generation_used в выпадающем списке нет, но старую закладку с ним не ломаем. */
const KNOWN_SORTS = new Set<string>([...USER_SORTS.map(item => item.value), 'generation_used']);
const KNOWN_FILTERS = new Set<string>([...USER_FILTERS, ...LEGACY_USER_FILTERS].map(item => item.value));
export const USER_PAGE_SIZES = [25, 50, 100] as const;

export type UsersListState = {
  q: string;
  filter: AdminUsersFilter;
  sort: AdminUsersSort;
  /** с нуля, как у сервера; в адресе — с единицы */
  page: number;
  pageSize: number;
};

/** Состояние списка из адреса `/panel/users?q=&filter=&sort=&page=&size=`; мусор — к значениям по умолчанию. */
export function parseUsersParams(params: URLSearchParams): UsersListState {
  const filter = params.get('filter') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Number(params.get('page'));
  const size = Number(params.get('size'));
  return {
    q: (params.get('q') ?? '').slice(0, 200),
    filter: KNOWN_FILTERS.has(filter) ? (filter as AdminUsersFilter) : 'all',
    sort: KNOWN_SORTS.has(sort) ? (sort as AdminUsersSort) : 'created_at',
    page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page - 1 : 0,
    pageSize: (USER_PAGE_SIZES as readonly number[]).includes(size) ? size : USER_PAGE_SIZES[0],
  };
}

/** Обратно в адрес: значения по умолчанию не пишем, чтобы ссылка была короткой. */
export function usersParamsToSearch(state: UsersListState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.filter !== 'all') params.set('filter', state.filter);
  if (state.sort !== 'created_at') params.set('sort', state.sort);
  if (state.page > 0) params.set('page', String(state.page + 1));
  if (state.pageSize !== USER_PAGE_SIZES[0]) params.set('size', String(state.pageSize));
  return params;
}

export function filterLabel(filter: AdminUsersFilter): string {
  return [...USER_FILTERS, ...LEGACY_USER_FILTERS].find(item => item.value === filter)?.label ?? 'Все';
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** 1 аккаунт, 2 аккаунта, 5 аккаунтов. */
export function pluralAccounts(n: number): string {
  return pluralRu(n, 'аккаунт', 'аккаунта', 'аккаунтов');
}

const countFormat = new Intl.NumberFormat('ru-RU');

export function formatCount(n: number): string {
  return countFormat.format(n);
}

/** «1 284 аккаунта» */
export function accountsLabel(n: number): string {
  return `${formatCount(n)} ${pluralAccounts(n)}`;
}

/** «1–25 из 1 284»; пустая страница — пустая строка. */
export function rangeLabel(page: number, pageSize: number, shown: number, total: number): string {
  if (!shown) return '';
  const from = page * pageSize + 1;
  return `${formatCount(from)}–${formatCount(from + shown - 1)} из ${formatCount(total)}`;
}

const PLAN_LABELS: Record<string, string> = { basic: 'Базовый', standard: 'Стандарт', pro: 'Про' };

export function planLabel(plan: string | null | undefined): string {
  return plan ? (PLAN_LABELS[plan] ?? plan) : '—';
}

const mskDayMonth = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });

/** «03.01» по Москве. */
export function shortDayMonth(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '—' : mskDayMonth.format(new Date(time));
}

/**
 * Колонка «Тариф Помощника»: «Про · до 03.01», «Про · бессрочно» (безлимит без
 * подписки — у безлимита открыто всё, как у Про), «—». Плюс «через 3 дн», когда
 * оплаченный срок кончается в ближайшую неделю.
 */
export function tariffCell(row: Pick<AdminUserRow, 'app' | 'unlimited' | 'unlimitedUntil'>): {
  text: string;
  expiring: string | null;
  empty: boolean;
} {
  const app = row.app ?? null;
  const until = app?.paidUntil || app?.endsAt || null;
  const days = app?.expiresInDays;
  const expiring =
    app?.plan && typeof days === 'number' && days >= 0 && days <= 7
      ? days === 0
        ? 'сегодня'
        : `через ${days} дн`
      : null;
  if (app?.plan) {
    return { text: `${planLabel(app.plan)}${until ? ` · до ${shortDayMonth(until)}` : ''}`, expiring, empty: false };
  }
  if (row.unlimited) {
    return {
      text: `Про · ${row.unlimitedUntil ? `до ${shortDayMonth(row.unlimitedUntil)}` : 'бессрочно'}`,
      expiring: null,
      empty: false,
    };
  }
  return { text: '—', expiring: null, empty: true };
}

/** «3/∞», «1/1»; лимит null — безлимит. */
export function slotLabel(slot: { used: number; limit: number | null } | null | undefined): string {
  if (!slot) return '—';
  return `${slot.used}/${slot.limit === null ? '∞' : slot.limit}`;
}

/** Колонка «ПК / пункты»: «3/∞ · 2/∞». */
export function slotsLabel(row: Partial<Pick<AdminUserRow, 'devices' | 'points'>>): string {
  if (!row.devices && !row.points) return '—';
  return `${slotLabel(row.devices)} · ${slotLabel(row.points)}`;
}

/** Последний вход — на сайт или из программы, что позже. */
export function lastActivity(row: Partial<Pick<AdminUserRow, 'lastSignInAt' | 'lastSeenAt'>>): string | null {
  const site = row.lastSignInAt ? Date.parse(row.lastSignInAt) : NaN;
  const pc = row.lastSeenAt ? Date.parse(row.lastSeenAt) : NaN;
  if (Number.isNaN(site) && Number.isNaN(pc)) return null;
  if (Number.isNaN(pc)) return row.lastSignInAt ?? null;
  if (Number.isNaN(site)) return row.lastSeenAt ?? null;
  return (site >= pc ? row.lastSignInAt : row.lastSeenAt) ?? null;
}

const mskTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });

/** «сегодня 14:02», «вчера 21:15», «3 дня назад», дальше месяца — дата. Сутки — по Москве. */
export function relativeSeen(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '—';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '—';
  const date = new Date(time);
  const dayMs = (key: string) => Date.parse(`${key}T00:00:00Z`);
  const days = Math.round((dayMs(mskDayKeyOf(now)) - dayMs(mskDayKeyOf(date))) / 86_400_000);
  if (days <= 0) return `сегодня ${mskTime.format(date)}`;
  if (days === 1) return `вчера ${mskTime.format(date)}`;
  if (days <= 30) return `${days} ${pluralRu(days, 'день', 'дня', 'дней')} назад`;
  return shortDate(iso);
}

export type UserBadge = { label: string; tone: 'error' | 'accent' | 'default' | 'warning' };

/** Бейджи строки: Ограничен, Безлимит, Telegram, Не подтверждён. */
export function userBadges(
  row: Pick<AdminUserRow, 'banned' | 'telegramOnly' | 'telegramUsername' | 'emailConfirmed'> &
    Partial<Pick<AdminUserRow, 'restricted' | 'unlimited'>>,
): UserBadge[] {
  const badges: UserBadge[] = [];
  if (row.restricted || row.banned) badges.push({ label: 'Ограничен', tone: 'error' });
  if (row.unlimited) badges.push({ label: 'Безлимит', tone: 'accent' });
  if (row.telegramOnly || row.telegramUsername) badges.push({ label: 'Telegram', tone: 'default' });
  if (!row.emailConfirmed && !row.telegramOnly) badges.push({ label: 'Не подтверждён', tone: 'warning' });
  return badges;
}

/**
 * Имя и вторая строка карточки: имя из профиля, а под ним почта или телефон.
 * Без имени главной строкой становится почта (или @telegram), и тогда второй
 * идёт телефон — одно и то же дважды не повторяем.
 */
export function userNameAndContact(
  row: Pick<AdminUserRow, 'userId' | 'email' | 'displayName' | 'telegramUsername' | 'phone'>,
): { name: string; contact: string | null } {
  const email = row.email && !isTelegramOnly(row.email) ? row.email : null;
  const tg = row.telegramUsername ? `@${row.telegramUsername}` : null;
  const name = row.displayName?.trim() || userLabel(row);
  const contact = [email, row.phone, tg].find(value => value && value !== name) ?? null;
  return { name, contact };
}

/** «АС» из «Анна Смирнова», «S» из «shop@example.com». */
export function initials(name: string): string {
  const trimmed = name.trim().replace(/^@/, '');
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = Array.from(words[0])[0] ?? '';
  const second = words.length > 1 ? (Array.from(words[1])[0] ?? '') : '';
  return (first + second).toUpperCase();
}

/** Колонка «Выручка»: «6 830 ₽» и « · 14 зак.». */
export function revenueCell(row: Pick<AdminUserRow, 'revenueKopecks' | 'ordersPaid'>): { main: string; sub: string } {
  return {
    main: formatKopecks(row.revenueKopecks || 0),
    sub: row.ordersPaid ? ` · ${row.ordersPaid} зак.` : '',
  };
}

function csvCell(value: string): string {
  // Excel выполнит формулу из ячейки при открытии, а имена и почты пишут люди.
  const safe = /^[=@\t\r]/.test(value) || /^[+-][^\d\s]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const plainRubles = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });

/** Рубли числом для Excel: «1250,00» — с запятой, как ждёт русская локаль. */
function csvRubles(kopecks: number | null | undefined): string {
  return plainRubles.format((Number(kopecks) || 0) / 100);
}

function csvDate(iso: string | null | undefined): string {
  return iso ? formatMskDateTime(iso) : '';
}

/** CSV текущей выборки для Excel: BOM, «;», CRLF. */
export function usersToCsv(rows: readonly AdminUserRow[]): string {
  const header = [
    'ID', 'Почта', 'Имя', 'Телефон', 'Telegram', 'Регистрация', 'Последний вход', 'Тариф', 'Оплачено до',
    'Баланс, ₽', 'ПК', 'Пункты', 'Выручка, ₽', 'Заказов', 'Ограничен', 'Безлимит',
  ];
  const lines = [header.map(csvCell).join(';')];
  for (const row of rows) {
    const email = row.email && !isTelegramOnly(row.email) ? row.email : '';
    lines.push(
      [
        row.userId,
        email,
        row.displayName ?? '',
        row.phone ?? '',
        row.telegramUsername ? `@${row.telegramUsername}` : '',
        csvDate(row.createdAt),
        csvDate(lastActivity(row)),
        row.app?.plan ? planLabel(row.app.plan) : row.unlimited ? 'Безлимит' : '',
        csvDate(row.app?.paidUntil || row.app?.endsAt),
        csvRubles(row.walletKopecks),
        row.devices ? slotLabel(row.devices) : '',
        row.points ? slotLabel(row.points) : '',
        csvRubles(row.revenueKopecks),
        String(row.ordersPaid ?? 0),
        row.restricted || row.banned ? 'да' : 'нет',
        row.unlimited ? 'да' : 'нет',
      ]
        .map(csvCell)
        .join(';'),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/* ============ Подписи статусов для остальных страниц ============ */

const WITHDRAWAL_STATUS: Record<string, string> = {
  pending: 'Ждёт решения',
  approved: 'Одобрена',
  paid: 'Выплачено',
  rejected: 'Отклонена',
  canceled: 'Отменена',
};

/** Заявка на выплату: сырые pending/approved/paid людям ничего не говорят. */
export function withdrawalStatusLabel(status: string): string {
  return WITHDRAWAL_STATUS[status] ?? status;
}

const CUSTOM_ORDER_STATUS: Record<string, string> = {
  paid: 'Оплачен',
  canceled: 'Отменён',
  pending_payment: 'Ожидает оплаты',
};

/** Индивидуальный заказ стикеров (предпросмотр кабинета). */
export function customOrderStatusLabel(status: string): string {
  return CUSTOM_ORDER_STATUS[status] ?? 'Ожидает оплаты';
}

const MARKETPLACE_LABELS: Record<string, string> = {
  wb: 'Wildberries',
  ozon: 'Ozon',
  both: 'Wildberries и Ozon',
  legacy_unassigned: 'Не выбран',
};

export function marketplaceLabel(scope: string): string {
  return MARKETPLACE_LABELS[scope] ?? scope;
}
