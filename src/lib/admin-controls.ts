/**
 * Чистые помощники карточки пользователя: ограничения, ручные лимиты, кошелёк,
 * сообщения. Без DOM и без сети — тестируются отдельно (src/lib/admin-controls.test.ts).
 * Контракт — раздел 5.5 («src/lib/admin-controls.ts»).
 */
import type { AdminRestriction, AdminUserDetail, RestrictionScope } from '../api/admin';
import type { SetOverridesBody } from '../api/admin-controls';

type PartialScope = Exclude<RestrictionScope, 'all'>;

/* ============ Ограничения: области и сроки ============ */

/**
 * Подписи областей. У «Сайт и кабинет» текст макета («открытые сессии
 * завершатся») исправлен: сервер для `site` сессии не гасит — GoTrue-бан и
 * выход из сессий только у «Полностью».
 */
export const SCOPE_META: Record<PartialScope, { label: string; description: string }> = {
  site: { label: 'Сайт и кабинет', description: 'Сайт и кабинет ответят «Доступ ограничен»' },
  app: { label: 'Помощник ПВЗ', description: 'Подборы и права на всех ПК отключатся, ключ устройства сохранится' },
  cell_print: { label: 'ПВЗ Принт', description: 'Лицензии станут недействительны' },
  bot: { label: 'Telegram-бот', description: 'Бот ответит, что доступ ограничен' },
  purchases: { label: 'Покупки', description: 'Нельзя оплатить и списать с кошелька' },
  withdrawals: { label: 'Выводы', description: 'Нельзя вывести реферальные' },
};

export const PARTIAL_SCOPES: readonly PartialScope[] = ['site', 'app', 'cell_print', 'bot', 'purchases', 'withdrawals'];

/** Подписи внутри фразы: «Ограничено: покупки и выводы». */
const SCOPE_INLINE: Record<RestrictionScope, string> = {
  all: 'полностью',
  site: 'сайт и кабинет',
  app: 'Помощник ПВЗ',
  cell_print: 'ПВЗ Принт',
  bot: 'Telegram-бот',
  purchases: 'покупки',
  withdrawals: 'выводы',
};

/** «покупки, выводы и бот» — последний элемент через «и». */
export function joinRu(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

/** ['all'] → 'полностью'; иначе 'покупки и выводы' (в порядке PARTIAL_SCOPES). */
export function scopesLabel(scopes: readonly RestrictionScope[]): string {
  if (scopes.includes('all')) return SCOPE_INLINE.all;
  const ordered = PARTIAL_SCOPES.filter(scope => scopes.includes(scope));
  return joinRu(ordered.map(scope => SCOPE_INLINE[scope]));
}

/** Есть ли область в ограничении: «Полностью» покрывает всё (как covers() на сервере). */
export function coversScope(scopes: readonly RestrictionScope[], scope: PartialScope): boolean {
  return scopes.includes('all') || scopes.includes(scope);
}

export const RESTRICT_TERMS: ReadonlyArray<{ value: '1' | '7' | '30' | 'forever' | 'custom'; label: string }> = [
  { value: '1', label: '1 день' },
  { value: '7', label: '7 дней' },
  { value: '30', label: '30 дней' },
  { value: 'forever', label: 'Бессрочно' },
  { value: 'custom', label: 'Своя дата' },
];

export const LIMIT_TERMS: ReadonlyArray<{ value: 'forever' | 'date'; label: string }> = [
  { value: 'forever', label: 'Бессрочно' },
  { value: 'date', label: 'До даты' },
];

/* ============ Даты по Москве ============ */

const MSK = 'Europe/Moscow';
const mskDay = new Intl.DateTimeFormat('en-CA', { timeZone: MSK, year: 'numeric', month: '2-digit', day: '2-digit' });
const mskDayMonth = new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, day: 'numeric', month: 'long' });
const mskTime = new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, hour: '2-digit', minute: '2-digit' });
const mskShort = new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, day: '2-digit', month: '2-digit' });
const mskFull = new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, day: '2-digit', month: '2-digit', year: 'numeric' });

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD существует в календаре (а не 2026-02-31). */
function isRealDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** Сегодня по Москве, YYYY-MM-DD. */
export function mskDateOf(date: Date): string {
  return mskDay.format(date);
}

/** ISO → дата по Москве YYYY-MM-DD (для поля даты); пусто/мусор → ''. */
export function mskDateOfIso(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : mskDay.format(new Date(time));
}

function addDays(date: string, days: number): string {
  const m = DATE_RE.exec(date)!;
  const probe = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return probe.toISOString().slice(0, 10);
}

/**
 * Срок ограничения. Пресет N → сегодня по Москве + N дней в 18:00 МСК;
 * custom → выбранная дата в 18:00 МСК; forever → null.
 * Некорректная дата или срок не позже чем через 5 минут → undefined (сервер
 * такое всё равно отклонит, а кнопку лучше выключить сразу).
 */
export function restrictUntil(term: string, customDate: string, now: Date = new Date()): string | null | undefined {
  if (term === 'forever') return null;
  let date: string;
  if (term === 'custom') {
    if (!isRealDate(customDate)) return undefined;
    date = customDate;
  } else if (/^\d+$/.test(term) && Number(term) > 0 && Number(term) <= 1825) {
    date = addDays(mskDateOf(now), Number(term));
  } else {
    return undefined;
  }
  const iso = `${date}T18:00:00+03:00`;
  if (Date.parse(iso) <= now.getTime() + 5 * 60_000) return undefined;
  return iso;
}

/** Срок ручного лимита: «До даты» — до конца выбранного дня по Москве. */
export function limitUntil(term: 'forever' | 'date', date: string): string | null | undefined {
  if (term === 'forever') return null;
  if (!isRealDate(date)) return undefined;
  return `${date}T23:59:59+03:00`;
}

/** '17 ноября в 18:00' по Москве. */
export function formatUntilLong(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  return `${mskDayMonth.format(date)} в ${mskTime.format(date)}`;
}

/** '17.11' по Москве. */
export function formatUntilShort(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return mskShort.format(new Date(time));
}

/** '17.11.2026' по Москве. */
export function formatDateMsk(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '—' : mskFull.format(new Date(time));
}

/** 'осталось 7 дней' / 'срок вышел'. */
export function daysLeftLabel(iso: string, now: number = Date.now()): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  if (time <= now) return 'срок вышел';
  const days = Math.ceil((time - now) / 86_400_000);
  return `осталось ${days} ${plural(days, ['день', 'дня', 'дней'])}`;
}

/** Ровно как restrictionMessage на сервере (контракт 2.1) без собственного текста. */
export function defaultPublicMessage(until: string | null): string {
  return `Доступ ограничен администратором.${until ? ` До ${formatUntilShort(until)}` : ''}`;
}

/* ============ Склонения и деньги ============ */

/** plural(2, ['код', 'кода', 'кодов']) → 'кода'. */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const a = Math.abs(n) % 10;
  const b = Math.abs(n) % 100;
  if (a === 1 && b !== 11) return forms[0];
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return forms[1];
  return forms[2];
}

const rubles = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const integers = new Intl.NumberFormat('ru-RU');

/** '1 240 ₽' (минус — типографский). */
export function rub(kopecks: number): string {
  const sign = kopecks < 0 ? '−' : '';
  return `${sign}${rubles.format(Math.abs(kopecks) / 100)} ₽`;
}

/** '1 240' */
export function int(n: number): string {
  return integers.format(n);
}

/** «500», «500,5», «500.50» → копейки; иначе null. */
export function parseRubles(raw: string): number | null {
  const text = raw.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const kopecks = Math.round(Number(text) * 100);
  return Number.isSafeInteger(kopecks) ? kopecks : null;
}

/* ============ Что произойдёт при ограничении ============ */

function counts(detail: AdminUserDetail) {
  return {
    codes: (detail.codes ?? []).filter(code => code.active).length,
    keys: (detail.programKeys ?? []).filter(key => key.active).length,
    cell: (detail.cellLicenses ?? []).filter(license => license.active).length,
    devices: (detail.app?.devices ?? []).filter(device => !device.revokedAt).length,
    wallet: Number(detail.wallet?.balanceKopecks ?? 0),
    referral: Number(detail.referral?.availableKopecks ?? 0),
  };
}

function codesPhrase(n: number) {
  return `${n} ${plural(n, ['код', 'кода', 'кодов'])} генератора`;
}
function keysPhrase(n: number) {
  return `${n} ${plural(n, ['ключ', 'ключа', 'ключей'])} подборов`;
}
function cellPhrase(n: number) {
  return `${n} ${plural(n, ['лицензия', 'лицензии', 'лицензий'])} ПВЗ Принт`;
}

/** Список последствий для окна «Ограничить» (макет Restrict, блок «Что произойдёт»). */
export function restrictEffects(
  detail: AdminUserDetail,
  scopes: readonly RestrictionScope[],
  until: string | null | undefined,
  publicMessage: string,
): Array<{ text: string; strong?: boolean }> {
  if (scopes.length === 0) return [];
  const c = counts(detail);
  const on = (scope: PartialScope) => coversScope(scopes, scope);
  const full = scopes.includes('all');
  const effects: Array<{ text: string; strong?: boolean }> = [];

  if (full) effects.push({ text: 'Вход на сайт закроется, открытые сессии на сайте и в программах завершатся' });
  else if (on('site')) effects.push({ text: 'Сайт и кабинет ответят «Доступ ограничен»' });

  if (on('app')) {
    const parts: string[] = [];
    if (full && c.codes > 0) parts.push(codesPhrase(c.codes));
    if (c.keys > 0) parts.push(keysPhrase(c.keys));
    parts.push(c.devices > 0 ? `права на ${c.devices} ПК` : 'права в Помощнике ПВЗ');
    effects.push({ text: `Отключатся ${joinRu(parts)}, ключ устройства сохранится` });
  }
  if (on('cell_print')) {
    effects.push({
      text:
        c.cell === 0
          ? 'ПВЗ Принт ответит «Доступ ограничен» (действующих лицензий нет)'
          : `${c.cell === 1 ? 'Отключится' : 'Отключатся'} ${cellPhrase(c.cell)}`,
    });
  }
  if (on('bot')) effects.push({ text: 'Бот ответит, что доступ ограничен' });

  if (on('purchases') && on('withdrawals')) {
    effects.push({ text: `Нельзя оплатить и вывести: кошелёк ${rub(c.wallet)} и реферальные ${rub(c.referral)} сохранятся` });
  } else if (on('purchases')) {
    effects.push({ text: `Нельзя оплатить и списать с кошелька, баланс ${rub(c.wallet)} сохранится` });
  } else if (on('withdrawals')) {
    effects.push({ text: `Нельзя вывести реферальные, доступно ${rub(c.referral)}` });
  }

  const shown = publicMessage.trim() || defaultPublicMessage(until ?? null);
  const who =
    on('app') || on('cell_print') ? 'Программа покажет' : on('bot') ? 'Бот ответит' : on('site') ? 'На сайте покажем' : 'При оплате и выводе покажем';
  effects.push({ text: `${who}: «${shown}»` });

  if (until === null) effects.push({ text: 'Само не снимется — только вручную', strong: true });
  else if (until) effects.push({ text: `Автоматически снимется ${formatUntilLong(until)}`, strong: true });
  else effects.push({ text: 'Выберите дату, когда снять', strong: true });

  return effects;
}

/* ============ Что вернётся при снятии ============ */

/** Таблицы, которые выключает каждая область (как SCOPE_TABLES на сервере). */
function tablesOf(scopes: readonly RestrictionScope[]) {
  const all = scopes.includes('all');
  return {
    // Коды генератора выключает только полное ограничение: пакеты стикеров
    // работают и на открытом сайте, и в боте, а не только в Помощнике ПВЗ.
    codes: all,
    keys: all || scopes.includes('app'),
    cell: all || scopes.includes('cell_print'),
  };
}

/**
 * Окно «Снять ограничение»: что вернётся и что останется выключенным.
 * Вернётся только то, что выключило само ограничение (disabledItems) и что до
 * сих пор выключено; выключенное вручную — останется. Дату ручного выключения
 * не показываем: её нигде не хранят.
 */
export function liftPreview(
  detail: AdminUserDetail,
  restriction: AdminRestriction,
): { willReturn: string[]; staysOff: Array<{ label: string; note: string }>; legacy: boolean } {
  const scopes = restriction.scopes;
  const items = restriction.disabledItems ?? { stickerCodes: [], programKeys: [], cellLicenses: [], legacy: false };
  const legacy = Boolean(items.legacy);
  const c = counts(detail);
  const ids = {
    codes: new Set((items.stickerCodes ?? []).map(Number)),
    keys: new Set((items.programKeys ?? []).map(Number)),
    cell: new Set((items.cellLicenses ?? []).map(Number)),
  };
  const codes = detail.codes ?? [];
  const keys = detail.programKeys ?? [];
  const cells = detail.cellLicenses ?? [];
  const on = (scope: PartialScope) => coversScope(scopes, scope);
  const willReturn: string[] = [];

  if (scopes.includes('all')) willReturn.push('Вход на сайт и в программы');
  else if (on('site')) willReturn.push('Сайт и кабинет');

  if (legacy) {
    willReturn.push('Все выключенные коды, ключи и лицензии аккаунта — так снималась старая блокировка');
  } else {
    const codesBack = codes.filter(code => !code.active && ids.codes.has(Number(code.id))).length;
    const keysBack = keys.filter(key => !key.active && ids.keys.has(Number(key.id))).length;
    const cellBack = cells.filter(license => !license.active && ids.cell.has(Number(license.id))).length;
    if (on('app')) {
      const parts: string[] = [];
      if (codesBack > 0) parts.push(codesPhrase(codesBack));
      if (keysBack > 0) parts.push(keysPhrase(keysBack));
      parts.push(c.devices > 0 ? `подборы и права на ${c.devices} ПК` : 'подборы и права в Помощнике ПВЗ');
      willReturn.push(parts.join(' · '));
    }
    if (on('cell_print')) {
      willReturn.push(cellBack > 0 ? `${cellPhrase(cellBack)} · снова станет действительной` : 'Вход в ПВЗ Принт');
    }
  }
  if (on('bot')) willReturn.push('Telegram-бот');
  if (on('purchases') && on('withdrawals')) willReturn.push(`Покупки и выводы · кошелёк ${rub(c.wallet)}, реферальные ${rub(c.referral)}`);
  else if (on('purchases')) willReturn.push(`Покупки · кошелёк ${rub(c.wallet)}`);
  else if (on('withdrawals')) willReturn.push(`Выводы · реферальные ${rub(c.referral)}`);

  const staysOff: Array<{ label: string; note: string }> = [];
  if (!legacy) {
    const tables = tablesOf(scopes);
    const note = 'выключен вручную — снятие ограничения его не включит';
    if (tables.codes)
      for (const code of codes) if (!code.active && !ids.codes.has(Number(code.id))) staysOff.push({ label: `Код генератора ${code.code}`, note });
    if (tables.keys)
      for (const key of keys) if (!key.active && !ids.keys.has(Number(key.id))) staysOff.push({ label: `Ключ подборов ${key.key}`, note });
    if (tables.cell)
      for (const license of cells)
        if (!license.active && !ids.cell.has(Number(license.id)))
          staysOff.push({ label: `Лицензия ПВЗ Принт ${license.key}`, note: 'выключена вручную — снятие ограничения её не включит' });
  }
  return { willReturn, staysOff, legacy };
}

/* ============ Ручные лимиты ============ */

/** 'exact' — подпись окна «Задать ровно»; в API это 'set'. */
export type CodesMode = 'tariff' | 'add' | 'exact';

export type LimitsDraft = {
  codesMode: CodesMode;
  codes: number;
  codesTerm: 'forever' | 'date';
  codesDate: string;
  devices: number;
  points: number;
  mirror: number;
  slotsTerm: 'forever' | 'date';
  slotsDate: string;
  unlimited: boolean;
  unlimitedTerm: 'forever' | 'date';
  unlimitedDate: string;
  note: string;
};

export const SLOT_MAX = 20;
export const CODES_MAX = 100000;

/** Черновик окна «Лимиты» из карточки. Истёкшие правки считаются снятыми. */
export function draftFromDetail(detail: AdminUserDetail): LimitsDraft {
  const ov = detail.overrides ?? null;
  const codes = ov?.codes && ov.codes.active ? ov.codes : null;
  const slots = ov?.slots && ov.slots.active ? ov.slots : null;
  const unlimited = ov?.unlimited && ov.unlimited.active && ov.unlimited.enabled ? ov.unlimited : null;
  return {
    codesMode: codes ? (codes.mode === 'set' ? 'exact' : 'add') : 'tariff',
    codes: codes ? Number(codes.monthly) || 0 : 0,
    codesTerm: codes?.until ? 'date' : 'forever',
    codesDate: mskDateOfIso(codes?.until),
    // старая надбавка ПК (app_device_bonuses) учитывается сервером через greatest — показываем то же число,
    // иначе сохранение мест молча её уменьшило бы (сервер удаляет старую строку при записи мест)
    devices: Math.max(slots ? Number(slots.devices) || 0 : 0, Number(detail.legacyDeviceBonus) || 0),
    points: slots ? Number(slots.points) || 0 : 0,
    mirror: slots ? Number(slots.mirror) || 0 : 0,
    slotsTerm: slots?.until ? 'date' : 'forever',
    slotsDate: mskDateOfIso(slots?.until),
    unlimited: Boolean(unlimited),
    unlimitedTerm: unlimited?.until ? 'date' : 'forever',
    unlimitedDate: mskDateOfIso(unlimited?.until),
    note: ov?.note ?? '',
  };
}

function limitNum(value: number | null | undefined): string {
  return value === null || value === undefined ? 'без лимита' : int(value);
}

/** Итог подборов в месяц по черновику (без безлимита). */
export function draftCodesTotal(baseCodes: number, draft: Pick<LimitsDraft, 'codesMode' | 'codes'>): number {
  if (draft.codesMode === 'add') return baseCodes + draft.codes;
  if (draft.codesMode === 'exact') return draft.codes;
  return baseCodes;
}

/** «Было → станет»: подборы, ПК, пункты, зеркало, безлимит. При безлимите «станет» = 'без лимита'. */
export function limitsPreview(
  detail: AdminUserDetail,
  draft: LimitsDraft,
): Array<{ label: string; from: string; to: string; changed: boolean }> {
  const limits = detail.app?.limits;
  const base = limits?.base ?? { devices: 1, points: 1, mirror: 0, codes: 0 };
  const envUnlimited = detail.unlimited?.source === 'env' && detail.unlimited.active;
  const unlimitedNow = Boolean(detail.unlimited?.active);
  const unlimitedNext = draft.unlimited || envUnlimited;
  const rows: Array<[string, string, string]> = [
    ['Подборы в месяц', unlimitedNow ? 'без лимита' : int(limits?.codesLimit ?? base.codes), unlimitedNext ? 'без лимита' : int(draftCodesTotal(base.codes, draft))],
    ['ПК', limitNum(limits ? limits.devices : base.devices), unlimitedNext ? 'без лимита' : int(base.devices + draft.devices)],
    ['Пункты', limitNum(limits ? limits.points : base.points), unlimitedNext ? 'без лимита' : int(base.points + draft.points)],
    ['Зеркало', limitNum(limits ? limits.mirror : base.mirror), unlimitedNext ? 'без лимита' : int(base.mirror + draft.mirror)],
    ['Безлимит', unlimitedNow ? 'да' : 'нет', unlimitedNext ? 'да' : 'нет'],
  ];
  return rows.map(([label, from, to]) => ({ label, from, to, changed: from !== to }));
}

/** Ошибка черновика для подсказки в подвале; null — можно сохранять. */
export function limitsDraftError(draft: LimitsDraft): string | null {
  const intIn = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
  if (draft.codesMode !== 'tariff') {
    if (!intIn(draft.codes, CODES_MAX)) return `Подборы: целое число от 0 до ${int(CODES_MAX)}`;
    if (limitUntil(draft.codesTerm, draft.codesDate) === undefined) return 'Выберите дату для подборов';
  }
  if (![draft.devices, draft.points, draft.mirror].every(n => intIn(n, SLOT_MAX))) return `Места: от 0 до ${SLOT_MAX} каждого вида`;
  if (limitUntil(draft.slotsTerm, draft.slotsDate) === undefined) return 'Выберите дату для мест';
  if (draft.unlimited && limitUntil(draft.unlimitedTerm, draft.unlimitedDate) === undefined) return 'Выберите дату для безлимита';
  if (draft.note.length > 300) return 'Заметка — не длиннее 300 символов';
  return null;
}

function codesSection(draft: LimitsDraft): NonNullable<SetOverridesBody['codes']> {
  if (draft.codesMode === 'tariff') return { mode: 'tariff', monthly: 0, until: null };
  return {
    mode: draft.codesMode === 'exact' ? 'set' : 'add',
    monthly: draft.codes,
    until: limitUntil(draft.codesTerm, draft.codesDate) ?? null,
  };
}
function slotsSection(draft: LimitsDraft): NonNullable<SetOverridesBody['slots']> {
  return { devices: draft.devices, points: draft.points, mirror: draft.mirror, until: limitUntil(draft.slotsTerm, draft.slotsDate) ?? null };
}
function unlimitedSection(draft: LimitsDraft): NonNullable<SetOverridesBody['unlimited']> {
  return { enabled: draft.unlimited, until: draft.unlimited ? (limitUntil(draft.unlimitedTerm, draft.unlimitedDate) ?? null) : null };
}

/**
 * Тело setOverrides. Без `initial` — все секции; с `initial` — только те, что
 * изменились (иначе каждое сохранение писало бы в журнал «изменения» без изменений,
 * а запись мест лишний раз удаляла бы старую надбавку ПК). UI 'exact' = API 'set'.
 */
export function draftToRequest(
  draft: LimitsDraft,
  userId: string,
  reason: string,
  idempotencyKey: string,
  initial?: LimitsDraft,
): SetOverridesBody {
  const body: SetOverridesBody = { userId, reason, idempotencyKey };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const codes = codesSection(draft);
  const slots = slotsSection(draft);
  const unlimited = unlimitedSection(draft);
  if (!initial || !same(codes, codesSection(initial))) body.codes = codes;
  if (!initial || !same(slots, slotsSection(initial))) body.slots = slots;
  if (!initial || !same(unlimited, unlimitedSection(initial))) body.unlimited = unlimited;
  if (!initial || draft.note.trim() !== initial.note.trim()) body.note = draft.note.trim();
  return body;
}

/** Есть ли в теле что сохранять, кроме служебных полей. */
export function hasOverrideSections(body: SetOverridesBody): boolean {
  return body.codes !== undefined || body.slots !== undefined || body.unlimited !== undefined || body.note !== undefined;
}

/* ============ Кошелёк ============ */

export const WALLET_MAX_KOPECKS = 10_000_000;

export function walletPreview(
  balanceKopecks: number,
  direction: 'credit' | 'debit',
  amountKopecks: number,
): { toKopecks: number; overdraft: boolean } {
  const toKopecks = direction === 'credit' ? balanceKopecks + amountKopecks : balanceKopecks - amountKopecks;
  return { toKopecks, overdraft: direction === 'debit' && amountKopecks > balanceKopecks };
}

/* ============ Сообщения ============ */

export const MESSAGE_LIMITS = Object.freeze({ subject: 160, body: 4000, link: 500, pc: 500, cabinetBody: 2000, telegram: 4096, devices: 10 });

/** ТОЧНО как pcMessageText на сервере (контракт 2.6). */
export function pcMessageText(subject: string, body: string): string {
  const text = `Администрация ШК ВБ: ${subject}\n${body}`.replace(/\r\n/g, '\n').trim();
  return text.length > MESSAGE_LIMITS.pc ? `${text.slice(0, MESSAGE_LIMITS.pc - 1)}…` : text;
}

/** '' | '/страница' | 'https://…' (как проверка ссылки на сервере). */
export function isValidMessageLink(link: string): boolean {
  if (link.length > MESSAGE_LIMITS.link) return false;
  return link === '' || /^\/[^\s]*$/.test(link) || /^https:\/\/\S+$/.test(link);
}

/** '/x' → 'shk-wb.ru/x' для предпросмотра. */
export function linkPreview(link: string): string {
  return link.startsWith('/') ? `shk-wb.ru${link}` : link;
}

const STATUS_LABELS: Record<string, string> = {
  sent: 'доставлено',
  read: 'прочитано',
  pending: 'ожидает',
  queued: 'ждёт прочтения на ПК',
  duplicate: 'уже отправлено',
  failed: 'ошибка',
  not_configured: 'почта не настроена',
  blocked: 'бот заблокирован',
  not_linked: 'Telegram не привязан',
  not_started: 'бот не запущен',
  no_address: 'нет почты',
  not_confirmed: 'почта не подтверждена',
  expired: 'не прочитано, срок истёк',
  not_found: 'ПК не найден',
  too_many_open: 'на ПК много непрочитанных',
  skipped: 'пропущено',
};

/** Подпись статуса канала: 'доставлено', 'прочитано', 'бот заблокирован', 'почта не настроена', … */
export function channelStatusLabel(channel: string, status: string): string {
  // Resend отвечает «принято к отправке» — честнее «отправлено», чем «доставлено».
  if (channel === 'email' && status === 'sent') return 'отправлено';
  if (channel === 'cabinet' && status === 'sent') return 'доставлено, не прочитано';
  if (channel === 'pc' && status === 'pending') return 'доставим, когда ПК включится';
  if (channel === 'pc' && status === 'sent') return 'показано, не прочитано';
  return STATUS_LABELS[status] ?? status;
}

/** Тон бейджа статуса. */
export function channelStatusTone(status: string): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'sent' || status === 'read' || status === 'queued' || status === 'duplicate') return 'success';
  if (status === 'pending' || status === 'not_configured' || status === 'expired' || status === 'too_many_open') return 'warning';
  if (status === 'failed' || status === 'blocked' || status === 'not_found') return 'error';
  return 'default';
}

/** Успех для итога «Отправлено по N из M»: sent, queued, duplicate (контракт 3.3). */
export function isChannelOk(status: string): boolean {
  return status === 'sent' || status === 'queued' || status === 'duplicate';
}

export function pluralChannels(n: number): string {
  return plural(n, ['канал', 'канала', 'каналов']);
}

export const CHANNEL_TITLES: Record<'cabinet' | 'email' | 'telegram' | 'pc', string> = {
  cabinet: 'Кабинет',
  email: 'Почта',
  telegram: 'Telegram',
  pc: 'ПК',
};
