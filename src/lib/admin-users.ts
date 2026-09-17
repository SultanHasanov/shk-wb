/** Чистые помощники раздела «Пользователи»: тестируются без DOM и без сети. */

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
  program: 'Программа «Подбор кодов»',
  program_license: 'Итерации «Подбора кодов»',
  cell_print_license: 'Ключи «Печати ячеек»',
  cell_print_program: 'Пробный доступ «Печати ячеек»',
  cell_print_bundle: 'Программа и ключ «Печати ячеек»',
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
