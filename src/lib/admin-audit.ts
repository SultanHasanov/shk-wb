import type { AdminAuditEntry, AuditCategory } from '../api/admin';

/**
 * Чистые помощники журнала админки: подписи действий, «было → стало»,
 * форматирование значений, группировка по дням и выгрузка в CSV.
 * Таблица действий обязана совпадать с серверной (`server/_admin-audit.js`,
 * контракт 5.6): по ней сервер фильтрует категории и «только опасные».
 */

export const AUDIT_CATEGORIES: Record<
  AuditCategory,
  { label: string; tone: 'accent' | 'error' | 'success' | 'warning' | 'default' }
> = {
  limits: { label: 'Лимиты', tone: 'accent' },
  restrict: { label: 'Ограничения', tone: 'error' },
  messages: { label: 'Сообщения', tone: 'success' },
  money: { label: 'Деньги', tone: 'warning' },
  keys: { label: 'Ключи и подписки', tone: 'default' },
  settings: { label: 'Настройки', tone: 'default' },
  deletions: { label: 'Удаления', tone: 'error' },
  other: { label: 'Прочее', tone: 'default' },
};

/** Порядок категорий в фильтре журнала (как в макете Audit). */
export const AUDIT_CATEGORY_ORDER: readonly AuditCategory[] = [
  'limits', 'restrict', 'messages', 'money', 'keys', 'settings', 'deletions',
];

export const ACTION_META: Record<string, { label: string; category: AuditCategory; danger?: boolean }> = {
  grantSticker: { label: 'Выдан код генератора', category: 'keys' },
  topupSticker: { label: 'Пополнен код генератора', category: 'keys' },
  patchCode: { label: 'Изменён код генератора', category: 'keys' },
  createIndividualStickerOrder: { label: 'Выставлен индивидуальный заказ', category: 'money' },
  grantProgramKey: { label: 'Выдан ключ подборов', category: 'keys' },
  patchProgramKey: { label: 'Изменён ключ подборов', category: 'keys' },
  grantCellLicense: { label: 'Выдан ключ ПВЗ Принт', category: 'keys' },
  patchCellLicense: { label: 'Изменён ключ ПВЗ Принт', category: 'keys' },
  grantAppSubscription: { label: 'Выдана подписка', category: 'keys' },
  revokeAppSubscription: { label: 'Отозвана подписка', category: 'keys', danger: true },
  grantAppAddon: { label: 'Подключена услуга', category: 'keys' },
  revokeAppAddon: { label: 'Отключена услуга', category: 'keys' },
  revokeAppPoint: { label: 'Отключён пункт', category: 'keys' },
  revokeAppDevice: { label: 'Отвязан ПК', category: 'keys' },
  setDeviceRole: { label: 'Изменена роль ПК', category: 'keys' },
  attach: { label: 'Привязан актив', category: 'keys' },
  profile: { label: 'Изменён профиль', category: 'settings' },
  appCodeViaBot: { label: 'Код клиента через бот (для пользователя)', category: 'settings' },
  setOverrides: { label: 'Выданы ручные лимиты', category: 'limits' },
  clearOverrides: { label: 'Сняты ручные лимиты', category: 'limits' },
  walletAdjust: { label: 'Кошелёк', category: 'money', danger: true },
  restrict: { label: 'Ограничение', category: 'restrict', danger: true },
  updateRestriction: { label: 'Изменено ограничение', category: 'restrict', danger: true },
  liftRestriction: { label: 'Снято ограничение', category: 'restrict' },
  block: { label: 'Блокировка (старая кнопка)', category: 'restrict', danger: true },
  unblock: { label: 'Разблокировка (старая кнопка)', category: 'restrict' },
  message: { label: 'Сообщение', category: 'messages' },
  notify: { label: 'Сообщение (старое окно)', category: 'messages' },
  retryDelivery: { label: 'Повторная доставка', category: 'messages' },
  sendNews: { label: 'Новость всем', category: 'messages', danger: true },
  sendTelegramBroadcast: { label: 'Рассылка в Telegram', category: 'messages', danger: true },
  logoutAll: { label: 'Завершены все сеансы', category: 'settings', danger: true },
  unlinkTelegram: { label: 'Отвязан Telegram', category: 'settings', danger: true },
  unlinkOAuth: { label: 'Отвязан способ входа', category: 'settings', danger: true },
  deleteAccount: { label: 'Аккаунт удалён', category: 'deletions', danger: true },
  deleteResource: { label: 'Удалена запись', category: 'deletions', danger: true },
  createResource: { label: 'Создана запись', category: 'settings' },
  updateResource: { label: 'Изменена запись', category: 'settings' },
  setAppFreeMode: { label: 'Флаг: бесплатный режим Помощника', category: 'settings', danger: true },
  setAppCrackFallback: { label: 'Флаг: резервный подбор «Быстрый QR»', category: 'settings' },
  setAppCodeViaBot: { label: 'Флаг: код клиента только через бот', category: 'settings', danger: true },
  setPaymentsEnabled: { label: 'Оплата на сайте', category: 'settings', danger: true },
  upsertPriceTier: { label: 'Ступень цены сохранена', category: 'money' },
  deletePriceTier: { label: 'Ступень цены удалена', category: 'money' },
  syncPaymentOrder: { label: 'Заказ проверен в ЮKassa', category: 'money' },
  setStickerPoolRange: { label: 'Диапазон номеров стикеров', category: 'settings', danger: true },
  setBoxPoolRange: { label: 'Диапазон номеров коробок', category: 'settings', danger: true },
  processWithdrawal: { label: 'Заявка на выплату', category: 'money', danger: true },
  setKztRate: { label: 'Курс тенге', category: 'settings' },
  createPartner: { label: 'Создан партнёр', category: 'keys' },
  grantPartnerPool: { label: 'Пул партнёра', category: 'keys' },
  updatePartner: { label: 'Изменён партнёр', category: 'keys' },
  partnerPayment: { label: 'Оплата партнёра', category: 'money' },
  togglePartnerItem: { label: 'Позиция партнёра вкл/выкл', category: 'keys' },
};

/** Подписи ресурсов общего CRUD (`createResource|updateResource|deleteResource`). */
export const RESOURCE_LABELS: Record<string, string> = {
  key: 'ключ подборов',
  message: 'объявление',
  stickerAccess: 'код генератора',
  programPromo: 'промокод программы',
  cellLicense: 'ключ ПВЗ Принт',
  cellPromo: 'промокод ПВЗ Принт',
  cellAnnouncement: 'объявление ПВЗ Принт',
  cellRelease: 'релиз ПВЗ Принт',
  cellActivation: 'активация ПВЗ Принт',
};

export function actionMeta(action: string): { label: string; category: AuditCategory; danger: boolean } {
  const meta = Object.prototype.hasOwnProperty.call(ACTION_META, action) ? ACTION_META[action] : null;
  if (!meta) return { label: action, category: 'other', danger: false };
  return { label: meta.label, category: meta.category, danger: Boolean(meta.danger) };
}

/* ============ Подписи значений ============ */

export const SCOPE_LABELS: Record<string, string> = {
  all: 'полностью',
  site: 'сайт и кабинет',
  app: 'Помощник ПВЗ',
  cell_print: 'ПВЗ Принт',
  bot: 'Telegram-бот',
  purchases: 'покупки',
  withdrawals: 'выводы',
};

export const CHANNEL_LABELS: Record<string, string> = {
  cabinet: 'кабинет',
  email: 'почта',
  telegram: 'Telegram',
  pc: 'ПК',
};

export const FIELD_LABELS: Record<string, string> = {
  devices_bonus: 'ПК бонус',
  device_bonus: 'ПК бонус',
  devices: 'ПК бонус',
  points_bonus: 'Пункты бонус',
  points: 'Пункты бонус',
  mirror_bonus: 'Зеркало бонус',
  mirror: 'Зеркало бонус',
  codes_mode: 'Подборы: режим',
  mode: 'Режим',
  codes_monthly: 'Подборы в мес.',
  codes_limit: 'Подборы в мес.',
  monthly: 'Подборы в мес.',
  codes_until: 'Подборы до',
  slots_until: 'Места до',
  unlimited: 'Безлимит',
  unlimited_until: 'Безлимит до',
  note: 'Заметка',
  until: 'До',
  balance: 'Баланс',
  balanceKopecks: 'Баланс',
  balance_kopecks: 'Баланс',
  amountKopecks: 'Сумма',
  amount_kopecks: 'Сумма',
  direction: 'Направление',
  comment: 'Комментарий',
  enabled: 'Включено',
  scopes: 'Области',
  publicMessage: 'Текст пользователю',
  public_message: 'Текст пользователю',
  lifted: 'Снято',
  restored: 'Возвращено',
  status: 'Статус',
  active: 'Активен',
  limit: 'Лимит',
  used: 'Использовано',
  display_name: 'Имя',
  displayName: 'Имя',
  phone: 'Телефон',
  payer_status: 'Статус плательщика',
  app_code_via_bot_off: 'Код без бота',
  channels: 'Каналы',
  delivered: 'Доставлено',
  role: 'Роль',
  start: 'Начало',
  end: 'Конец',
  inserted: 'Добавлено номеров',
  title: 'Заголовок',
  subject: 'Тема',
  name: 'Название',
  plan: 'Тариф',
  ends_at: 'Действует до',
  endsAt: 'Действует до',
  expires_at: 'Действует до',
  expiresAt: 'Действует до',
  duration_days: 'Дней',
  durationDays: 'Дней',
  device_limit: 'Лимит ПК',
  deviceLimit: 'Лимит ПК',
  marketplace_scope: 'Маркетплейс',
  sent: 'Отправлено',
  failed: 'Ошибок',
  blocked: 'Заблокировали бота',
  total: 'Всего',
  campaign: 'Кампания',
  textPreview: 'Текст',
  onlyLegacy: 'Только старые',
  removeKeyboard: 'Убрать клавиатуру',
  orderId: 'Заказ',
  kind: 'Вид',
  min_quantity: 'От количества',
  unit_price: 'Цена за штуку',
  kztPerRub: 'Тенге за рубль',
  restricted: 'Ограничен',
  banned: 'Блокировка',
  stickerCodes: 'Коды генератора',
  programKeys: 'Ключи подборов',
  cellLicenses: 'Ключи ПВЗ Принт',
  sessions: 'Сеансы',
  telegram: 'Telegram',
  provider: 'Способ входа',
  attempts: 'Попыток',
  authBan: 'Бан входа',
};

/** Поля, которые сервер обновляет при каждой записи: в «было → стало» это шум. */
const NOISE_FIELDS = new Set(['updated_at', 'updatedAt', 'created_at', 'createdAt', 'updated_by', 'updatedBy', 'user_id', 'userId']);

const VALUE_LABELS: Record<string, Record<string, string>> = {
  codes_mode: { add: 'прибавка к тарифу', set: 'ровно столько' },
  mode: { add: 'прибавка к тарифу', set: 'ровно столько', tariff: 'по тарифу' },
  role: { owner: 'владелец', work: 'рабочий' },
  direction: { credit: 'пополнение', debit: 'списание' },
  plan: { basic: 'Базовый', standard: 'Стандарт', pro: 'Про' },
  marketplace_scope: { wb: 'WB', ozon: 'Ozon', both: 'WB и Ozon', legacy_unassigned: 'не выбран' },
  status: {
    pending: 'ожидает', approved: 'одобрена', paid: 'выплачена', rejected: 'отклонена',
    succeeded: 'оплачен', canceled: 'отменён', waiting_for_capture: 'ждёт подтверждения',
    sent: 'доставлено', failed: 'ошибка', not_configured: 'не настроено', blocked: 'бот заблокирован',
  },
  sessions: { ended: 'завершены' },
  provider: { yandex: 'Яндекс ID', mailru: 'Mail.ru', vkid: 'VK ID' },
  authBan: { failed: 'не поставлен' },
};

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const rubles = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const integers = new Intl.NumberFormat('ru-RU');

function isKopeckField(field: string): boolean {
  return /kopecks$/i.test(field) || field === 'balance';
}

/** «1 240 ₽» — без «,00», с неразрывными пробелами, как в остальной админке. */
export function formatKopecks(kopecks: number): string {
  const sign = kopecks < 0 ? '−' : '';
  return `${sign}${rubles.format(Math.abs(kopecks) / 100)} ₽`;
}

const mskDateTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const mskDateTimeSeconds = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const mskTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const mskDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
const mskDayMonth = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
const mskDayMonthYear = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });

/** «10.11.2026 14:12» по Москве (без запятой, которую ставит Intl). */
export function formatMskDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return mskDateTime.format(new Date(time)).replace(',', '');
}

/** «10.11.2026 14:12:08 МСК» — подпись записи журнала. */
export function formatMskStamp(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return `${mskDateTimeSeconds.format(new Date(time)).replace(',', '')} МСК`;
}

/** «14:12» по Москве. */
export function formatMskTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return mskTime.format(new Date(time));
}

/** Ключ дня по Москве: «2026-11-10». */
export function mskDayKeyOf(date: Date): string {
  return mskDayKey.format(date);
}

function labelArray(field: string, values: unknown[]): string {
  if (values.length === 0) return '—';
  const strings = values.map(v => (typeof v === 'string' ? v : formatAuditValue(field, v)));
  const allIn = (labels: Record<string, string>) =>
    strings.every(v => Object.prototype.hasOwnProperty.call(labels, v));
  // Массив областей ограничения или каналов сообщения узнаём по значениям, а не по имени
  // поля: сервер кладёт их и в scopes/channels, и во вложенные объекты.
  if (allIn(SCOPE_LABELS)) return strings.map(v => SCOPE_LABELS[v]).join(', ');
  if (allIn(CHANNEL_LABELS)) return strings.map(v => CHANNEL_LABELS[v]).join(', ');
  return strings.join(', ');
}

export function formatAuditValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'number') {
    if (isKopeckField(field)) return formatKopecks(value);
    return integers.format(value);
  }
  if (typeof value === 'string') {
    if (isKopeckField(field) && /^-?\d+$/.test(value)) return formatKopecks(Number(value));
    const labels = VALUE_LABELS[field];
    if (labels && Object.prototype.hasOwnProperty.call(labels, value)) return labels[value];
    if (ISO_DATETIME.test(value)) return formatMskDateTime(value);
    if (ISO_DATE.test(value)) return `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}`;
    if (field === 'scope' && Object.prototype.hasOwnProperty.call(SCOPE_LABELS, value)) return SCOPE_LABELS[value];
    return value;
  }
  if (Array.isArray(value)) return labelArray(field, value);
  if (typeof value === 'object') {
    // Вложенный объект («restored»: {stickerCodes: 2, …}) — одной строкой «ключ: значение».
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${FIELD_LABELS[k] ?? k}: ${formatAuditValue(k, v)}`);
    const text = parts.join(', ');
    return text ? (text.length > 160 ? `${text.slice(0, 159)}…` : text) : '—';
  }
  return String(value);
}

export type AuditDiffRow = { field: string; label: string; before: string; after: string };

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Только изменившиеся поля. Порядок — как в «было», новые поля «стало» — в конце. */
export function diffValues(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditDiffRow[] {
  const b = before && typeof before === 'object' ? before : {};
  const a = after && typeof after === 'object' ? after : {};
  const keys: string[] = [];
  for (const key of [...Object.keys(b), ...Object.keys(a)]) {
    if (!keys.includes(key) && !NOISE_FIELDS.has(key)) keys.push(key);
  }
  const rows: AuditDiffRow[] = [];
  for (const field of keys) {
    if (sameValue(b[field], a[field])) continue;
    rows.push({
      field,
      label: FIELD_LABELS[field] ?? field,
      before: formatAuditValue(field, b[field]),
      after: formatAuditValue(field, a[field]),
    });
  }
  return rows;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function balanceOf(values: Record<string, unknown> | null): number | null {
  if (!values) return null;
  return numberFrom(values.balanceKopecks ?? values.balance_kopecks ?? values.balance);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Деталь заголовка: «+500 ₽», «покупки, выводы», «почта, Telegram, ПК». */
function titleDetail(entry: AdminAuditEntry): string | null {
  const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  switch (entry.action) {
    case 'walletAdjust': {
      const amount = numberFrom(payload.amountKopecks);
      if (amount !== null) {
        const sign = payload.direction === 'debit' ? '−' : '+';
        return `${sign}${formatKopecks(Math.abs(amount))}`;
      }
      const before = balanceOf(entry.before);
      const after = balanceOf(entry.after);
      if (before !== null && after !== null && before !== after) {
        return `${after > before ? '+' : '−'}${formatKopecks(Math.abs(after - before))}`;
      }
      return null;
    }
    case 'restrict':
    case 'updateRestriction':
    case 'block': {
      const scopes = stringList(payload.scopes).length ? stringList(payload.scopes) : stringList(entry.after?.scopes);
      return scopes.length ? labelArray('scopes', scopes) : entry.action === 'block' ? SCOPE_LABELS.all : null;
    }
    case 'message':
    case 'notify': {
      const channels = stringList(payload.channels).length ? stringList(payload.channels) : stringList(entry.after?.channels);
      return channels.length ? labelArray('channels', channels) : null;
    }
    case 'createResource':
    case 'updateResource':
    case 'deleteResource': {
      const resource = typeof payload.resource === 'string' ? payload.resource : null;
      return resource ? (RESOURCE_LABELS[resource] ?? resource) : null;
    }
    case 'unlinkOAuth': {
      const provider = typeof payload.provider === 'string' ? payload.provider : null;
      const names: Record<string, string> = { yandex: 'Яндекс ID', mailru: 'Mail.ru', vkid: 'VK ID' };
      return provider ? (names[provider] ?? provider) : null;
    }
    case 'setDeviceRole': {
      const role = typeof payload.role === 'string' ? payload.role : null;
      return role ? formatAuditValue('role', role) : null;
    }
    default:
      return null;
  }
}

export function describeAction(entry: AdminAuditEntry): {
  title: string;
  categoryLabel: string;
  danger: boolean;
  diff: AuditDiffRow[];
} {
  const meta = actionMeta(entry.action);
  const category: AuditCategory = entry.category && entry.category in AUDIT_CATEGORIES ? entry.category : meta.category;
  const detail = titleDetail(entry);
  return {
    title: detail ? `${meta.label}: ${detail}` : meta.label,
    categoryLabel: AUDIT_CATEGORIES[category].label,
    danger: typeof entry.danger === 'boolean' ? entry.danger : meta.danger,
    diff: diffValues(entry.before, entry.after),
  };
}

/* ============ Кто сделал ============ */

export function userAgentLabel(ua: string | null): string {
  if (!ua) return '';
  let browser = '';
  if (/YaBrowser\//.test(ua)) browser = 'Яндекс Браузер';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  else if (/curl\//i.test(ua)) browser = 'curl';
  let os = '';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  const label = [browser, os].filter(Boolean).join(', ');
  return label || 'неизвестный браузер';
}

/** «Админ · IP ··a1f3 · Chrome, Windows»; системные записи — «Система», перенос — «Перенос данных». */
export function adminLabel(entry: Pick<AdminAuditEntry, 'adminFingerprint' | 'userAgent'>): string {
  const fp = entry.adminFingerprint;
  if (fp === 'system' || fp === 'auto') return 'Система';
  if (fp === 'migration') return 'Перенос данных';
  const parts = ['Админ'];
  if (fp) parts.push(`IP ··${fp.slice(-4)}`);
  const ua = userAgentLabel(entry.userAgent);
  if (ua) parts.push(ua);
  return parts.join(' · ');
}

/** Подпись пользователя записи: имя → почта → @telegram → начало ID. */
export function auditTargetLabel(entry: Pick<AdminAuditEntry, 'target' | 'targetUserId'>): { title: string; sub: string | null } | null {
  const target = entry.target;
  const id = target?.userId ?? entry.targetUserId;
  if (!id) return null;
  const email = target?.email && !target.email.endsWith('@users.invalid') ? target.email : null;
  const tg = target?.telegramUsername ? `@${target.telegramUsername}` : null;
  const title = target?.displayName || email || tg || id.slice(0, 8);
  const sub = [email, tg].find(value => value && value !== title) ?? null;
  return { title, sub };
}

/* ============ Группировка по дням ============ */

export function groupByDay<T extends { createdAt: string }>(
  items: readonly T[],
  now: Date = new Date(),
): Array<{ key: string; label: string; items: T[] }> {
  const todayKey = mskDayKeyOf(now);
  const yesterdayKey = mskDayKeyOf(new Date(now.getTime() - 86_400_000));
  const thisYear = todayKey.slice(0, 4);
  const groups: Array<{ key: string; label: string; items: T[] }> = [];
  const byKey = new Map<string, { key: string; label: string; items: T[] }>();
  for (const item of items) {
    const time = Date.parse(item.createdAt);
    if (Number.isNaN(time)) continue;
    const date = new Date(time);
    const key = mskDayKeyOf(date);
    let group = byKey.get(key);
    if (!group) {
      const dayMonth = key.slice(0, 4) === thisYear ? mskDayMonth.format(date) : mskDayMonthYear.format(date).replace(/\s*г\.$/, '');
      const label = key === todayKey ? `Сегодня, ${dayMonth}` : key === yesterdayKey ? `Вчера, ${dayMonth}` : dayMonth;
      group = { key, label, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/* ============ CSV ============ */

function csvCell(value: string): string {
  // Формулу в ячейке Excel выполнит при открытии: имена и причины пишут люди.
  const safe = /^[=@\t\r]/.test(value) || /^[+-][^\d\s]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV для Excel: BOM, разделитель «;», строки через CRLF. */
export function auditToCsv(entries: readonly AdminAuditEntry[]): string {
  const header = ['Дата', 'Действие', 'Пользователь', 'Причина', 'Было', 'Стало', 'Админ'];
  const lines = [header.map(csvCell).join(';')];
  for (const entry of entries) {
    const { title, diff } = describeAction(entry);
    const target = auditTargetLabel(entry);
    const user = target ? [target.title, target.sub, entry.target?.userId ?? entry.targetUserId].filter(Boolean).join(' · ') : '';
    lines.push(
      [
        formatMskDateTime(entry.createdAt),
        title,
        user,
        entry.reason ?? '',
        diff.map(row => `${row.label}: ${row.before}`).join(', '),
        diff.map(row => `${row.label}: ${row.after}`).join(', '),
        adminLabel(entry),
      ]
        .map(csvCell)
        .join(';'),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
