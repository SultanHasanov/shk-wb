// График смен и зарплата сотрудников: модель `wb_pvz_tools/schedule.json` и весь расчёт.
// Rust только хранит файл — логика здесь. Учёт выплат и удержаний — lib/payroll.ts.

import type { StaffEntry } from "./types";

// ---------- модель ----------

export type ShiftKind = "full" | "half" | "custom";

export interface Shift {
  staffId: string;
  kind: ShiftKind;
  /** «свои часы» — HH:MM */
  from?: string;
  to?: string;
  /** вышел вместо этого сотрудника (оплата — тому, кто вышел) */
  replaces?: string;
  /** поставлено автозаполнением */
  auto?: boolean;
}

export type TemplateKind = "none" | "2/2" | "3/3" | "1/1" | "5/2" | "weekdays";

export interface Template {
  kind: TemplateKind;
  /** первый рабочий день цикла */
  start: string;
  /** для "weekdays": 0 = пн … 6 = вс */
  weekdays?: number[];
}

export interface Adjust {
  id: string;
  staffId: string;
  date: string;
  /** > 0 — премия, < 0 — штраф */
  amount: number;
  reason: string;
  /** correction — исправление прошлого месяца (знак — доплатить/удержать) */
  kind?: "correction";
  /** отменено: запись остаётся в журнале зачёркнутой */
  cancelled?: Cancelled;
}

export interface Cancelled {
  at: string;
  why: string;
}

/** Деньги, которые сотрудник получил: аванс, зарплата или выплата вне графика (под расчёт). */
export interface Payment {
  id: string;
  staffId: string;
  date: string;
  type: "advance" | "salary" | "other";
  amount: number;
  method: "cash" | "card" | "other";
  note: string;
  cancelled?: Cancelled;
}

/** Удержание WB, введённое вручную из уведомления в кабинете ПВЗ. */
export interface Deduction {
  id: string;
  kind: string;
  amount: number;
  date: string;
  shk?: string;
  /** null — пока не решено, с кого удержать */
  assign: { type: "staff"; id: string } | { type: "split"; ids: string[] } | { type: "skip" } | null;
  /** held — удержано, disputed — оспариваем (не вычитаем), returned — WB вернул */
  status: "held" | "disputed" | "returned";
  returnedAt?: string;
  note?: string;
}

export interface Advance {
  amount: number;
  paid: boolean;
}

export interface AdvanceRule {
  day: number;
  /** shifts — за смены до дня аванса; fixed — фикс. сумма; percent — % от начисленного до дня аванса */
  mode: "shifts" | "fixed" | "percent";
  value: number;
}

export interface PenaltyOverride {
  /** assign — на выбранных поровну; skip — не удерживать с сотрудников */
  mode: "assign" | "skip";
  staffIds?: string[];
}

export interface PayRow {
  staffId: string;
  name: string;
  shifts: number;
  /** начислено: смены + принятые ШК */
  earned: number;
  /** принято ШК за месяц и сколько за них (входит в earned); в старых закрытых месяцах полей нет */
  shk?: number;
  shkEarned?: number;
  bonus: number;
  fines: number;
  /** удержания WB (удержано + оспаривается) */
  wb: number;
  /** WB вернул удержание из уже закрытого месяца — доплата в этом месяце */
  wbBack: number;
  /** «будет удержано»: WB ещё не списал — в итог не входит */
  pending: number;
  advance: number;
  advancePaid: boolean;
  /** всего за месяц = смены + премии + возвраты WB − штрафы − удержания */
  total: number;
  /** остаток к выплате в день зарплаты = всего − аванс */
  toPay: number;
  /** у сотрудника нет ставки — начислено 0 */
  noRate?: boolean;
}

export interface ClosedMonth {
  at: string;
  /** остаток каждого на конец месяца — с него начинается следующий */
  balances?: Record<string, number>;
  /** старый формат (до учёта выплат): зафиксированный расчёт */
  rows?: PayRow[];
  /** какие удержания вошли в расчёт закрытого месяца — чтобы потом вернуть их доплатой */
  wbKeys?: Record<string, { key: string; share: number }[]>;
}

export interface ScheduleData {
  v: 1;
  shifts: Record<string, Shift[]>;
  templates: Record<string, Template>;
  autoExtend: boolean;
  /** до какой даты автозаполнение уже прошло (чтобы удалённые смены не возвращались) */
  filledUntil?: string;
  dayHours: { from: string; to: string };
  adjustments: Adjust[];
  advances: Record<string, Record<string, Advance>>;
  advanceRule: AdvanceRule;
  payDay: number;
  deductWb: boolean;
  penaltyOverrides: Record<string, PenaltyOverride>;
  closed: Record<string, ClosedMonth>;
  /** скрытые подсказки «выдачи без смены» по дням */
  hiddenHints?: string[];
  /** имена удалённых сотрудников — для их прошлых смен */
  removedNames?: Record<string, string>;
  migrated?: boolean;
  /** общая цена за принятый ШК, ₽ (у сотрудника может быть своя — `shkRates`) */
  shkPrice?: number;
  /** принято ШК: сотрудник → день → количество (вводится вручную) */
  shkCounts?: Record<string, Record<string, ShkCount>>;
  /** выплаты сотрудникам */
  payments?: Payment[];
  /** удержания WB, введённые вручную */
  deductions?: Deduction[];
  /** дни, когда на смене сам владелец: сотрудникам не оплачиваются */
  ownerDays?: string[];
  /** с какого месяца ведётся учёт выплат: остаток переносится только начиная с него */
  ledgerFrom?: string;
}

export interface ShkCount {
  n: number;
  /** wb — загружено старой версией из WB; новые числа всегда manual */
  src: "manual" | "wb";
}

export function emptySchedule(): ScheduleData {
  return {
    v: 1,
    shifts: {},
    templates: {},
    autoExtend: false,
    dayHours: { from: "09:00", to: "21:00" },
    adjustments: [],
    advances: {},
    advanceRule: { day: 15, mode: "shifts", value: 0 },
    payDay: 31,
    deductWb: true,
    penaltyOverrides: {},
    closed: {},
  };
}

export function normalizeSchedule(raw: any): ScheduleData {
  const base = emptySchedule();
  if (!raw || typeof raw !== "object") return base;
  return {
    ...base,
    ...raw,
    dayHours: { ...base.dayHours, ...(raw.dayHours ?? {}) },
    advanceRule: { ...base.advanceRule, ...(raw.advanceRule ?? {}) },
    shifts: raw.shifts ?? {},
    templates: raw.templates ?? {},
    adjustments: raw.adjustments ?? [],
    advances: raw.advances ?? {},
    penaltyOverrides: raw.penaltyOverrides ?? {},
    closed: raw.closed ?? {},
    shkCounts: raw.shkCounts ?? {},
    payments: raw.payments ?? [],
    deductions: raw.deductions ?? [],
    ownerDays: raw.ownerDays ?? [],
  };
}

/** Перенос старого формата config.staff[sid] = {rate, shifts[]} (CustomTkinter-версия). */
export function migrateLegacy(data: ScheduleData, staff: StaffEntry[], cfg: any): { data: ScheduleData; staffPatches: Record<string, Partial<StaffEntry>> } {
  const patches: Record<string, Partial<StaffEntry>> = {};
  if (data.migrated) return { data, staffPatches: patches };
  const next = { ...data, shifts: { ...data.shifts } };
  const legacy = (cfg?.staff ?? {}) as Record<string, { rate?: number; shifts?: string[] }>;
  for (const s of staff) {
    const old = s.sid ? legacy[s.sid] : undefined;
    if (!old) continue;
    if (old.rate && !(s.rates && s.rates.length)) patches[s.id] = { rates: [{ from: "2000-01-01", rate: Number(old.rate) }] };
    for (const day of old.shifts ?? []) {
      const list = next.shifts[day] ?? [];
      if (!list.some((x) => x.staffId === s.id)) next.shifts[day] = [...list, { staffId: s.id, kind: "full" }];
    }
  }
  next.migrated = true;
  return { data: next, staffPatches: patches };
}

// ---------- даты (локальные YYYY-MM-DD) ----------

export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function todayYmd(): string {
  return ymd(new Date());
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86400000);
}

/** 0 = понедельник */
export function weekday(s: string): number {
  return (parseYmd(s).getDay() + 6) % 7;
}

export function weekStart(s: string): string {
  return addDays(s, -weekday(s));
}

export function monthKey(s: string): string {
  return s.slice(0, 7);
}

export function monthStart(key: string): string {
  return `${key}-01`;
}

export function monthEnd(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return ymd(new Date(y, m, 0));
}

export function shiftMonth(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return ymd(d).slice(0, 7);
}

export function range(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** ISO с часовым поясом от WB → местная дата */
export function isoToYmd(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso.slice(0, 10) : ymd(d);
}

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function dayMonth(s: string): string {
  const d = parseYmd(s);
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
}

export function shortDate(s: string): string {
  const d = parseYmd(s);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function monthTitle(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS_NOM[m - 1]} ${y}`;
}

export function monthGen(key: string): string {
  const [, m] = key.split("-").map(Number);
  return MONTHS_GEN[m - 1];
}

export function weekTitle(start: string): string {
  const end = addDays(start, 6);
  const a = parseYmd(start), b = parseYmd(end);
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} – ${b.getDate()} ${MONTHS_GEN[b.getMonth()]}`;
  return `${a.getDate()} ${MONTHS_GEN[a.getMonth()]} – ${b.getDate()} ${MONTHS_GEN[b.getMonth()]}`;
}

// ---------- сотрудники: цвет, ставка ----------

export const PALETTE = [
  { bg: "#efeafc", fg: "#4a3196", solid: "#7a5ce0" },
  { bg: "#e6effd", fg: "#174a9e", solid: "#3d7fe6" },
  { bg: "#fdf0e2", fg: "#8a4307", solid: "#e08a3c" },
  { bg: "#e1f3f1", fg: "#0a5a54", solid: "#1f9d92" },
  { bg: "#fce8ef", fg: "#9a1f4f", solid: "#e0517f" },
  { bg: "#eef4df", fg: "#45601a", solid: "#7fa83a" },
  { bg: "#e9eaf0", fg: "#3a3d52", solid: "#6b6f88" },
  { bg: "#fbf3d9", fg: "#6e5300", solid: "#c9a227" },
];

export function colorOf(s: StaffEntry, index: number) {
  const i = typeof s.color === "number" ? s.color : index;
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function shortName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function isActive(s: StaffEntry): boolean {
  return s.active !== false;
}

function rateIn(list: { from: string; rate: number }[] | undefined, date: string): number {
  const rates = [...(list ?? [])].sort((a, b) => a.from.localeCompare(b.from));
  let r = rates.length ? rates[0].rate : 0;
  for (const x of rates) if (x.from <= date) r = x.rate;
  return r || 0;
}

export function rateOn(s: StaffEntry, date: string): number {
  return rateIn(s.rates, date);
}

/** Цена за принятый ШК на дату (0 — за товар не платим). */
export function shkRateOn(s: StaffEntry, date: string): number {
  return rateIn(s.shkRates, date);
}

export function currentRate(s: StaffEntry): number {
  return rateOn(s, todayYmd());
}

/** Как платим сотруднику: фикс за смену (по умолчанию) или за принятые ШК. */
export function paysShk(s: StaffEntry): boolean {
  return s.payMode === "shk";
}

/** Цена за принятый ШК на дату: своя у сотрудника, иначе общая. */
export function shkPriceOn(s: StaffEntry, data: ScheduleData, date: string): number {
  return shkRateOn(s, date) || data.shkPrice || 0;
}

export function shkCountOn(data: ScheduleData, staffId: string, day: string): ShkCount | undefined {
  return data.shkCounts?.[staffId]?.[day];
}

/** Записать количество за день вручную (null — очистить). */
export function setShkCount(data: ScheduleData, staffId: string, day: string, n: number | null): ScheduleData {
  const all = { ...(data.shkCounts ?? {}) };
  const mine = { ...(all[staffId] ?? {}) };
  if (n == null) delete mine[day];
  else mine[day] = { n, src: "manual" };
  all[staffId] = mine;
  return { ...data, shkCounts: all };
}

// ---------- смены ----------

function minutes(hhmm?: string): number {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function dayLength(data: ScheduleData): number {
  const len = minutes(data.dayHours.to) - minutes(data.dayHours.from);
  return len > 0 ? len : 12 * 60;
}

/** Доля полной смены: полная — 1, половина — 0.5, свои часы — часы / длину смены. */
export function shiftValue(sh: Shift, data: ScheduleData): number {
  if (sh.kind === "half") return 0.5;
  if (sh.kind === "custom") {
    const len = minutes(sh.to) - minutes(sh.from);
    if (len <= 0) return 1;
    return Math.round((len / dayLength(data)) * 100) / 100;
  }
  return 1;
}

export function halfHours(data: ScheduleData): { first: string; second: string } {
  const a = minutes(data.dayHours.from), b = minutes(data.dayHours.to);
  const mid = a + Math.round((b - a) / 2);
  const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { first: `${f(a)} – ${f(mid)}`, second: `${f(mid)} – ${f(b)}` };
}

export function shiftHoursLabel(sh: Shift, data: ScheduleData): string {
  const t = (s: string) => s.replace(/^0/, "");
  if (sh.kind === "custom" && sh.from && sh.to) return `${t(sh.from)} – ${t(sh.to)}`;
  if (sh.kind === "half") return halfHours(data).first.replace(/0(\d):/g, "$1:");
  return `${t(data.dayHours.from)} – ${t(data.dayHours.to)}`;
}

export function shiftsOn(data: ScheduleData, day: string): Shift[] {
  return data.shifts[day] ?? [];
}

export function shiftOf(data: ScheduleData, day: string, staffId: string): Shift | undefined {
  return shiftsOn(data, day).find((x) => x.staffId === staffId);
}

/** Кто вышел вместо этого сотрудника в этот день. */
export function replacedBy(data: ScheduleData, day: string, staffId: string): Shift | undefined {
  return shiftsOn(data, day).find((x) => x.replaces === staffId);
}

export function setShifts(data: ScheduleData, day: string, list: Shift[]): ScheduleData {
  const shifts = { ...data.shifts };
  if (list.length) shifts[day] = list;
  else delete shifts[day];
  return { ...data, shifts };
}

export function putShift(data: ScheduleData, day: string, sh: Shift): ScheduleData {
  const list = shiftsOn(data, day).filter((x) => x.staffId !== sh.staffId);
  return setShifts(data, day, [...list, sh]);
}

export function removeShift(data: ScheduleData, day: string, staffId: string): ScheduleData {
  return setShifts(data, day, shiftsOn(data, day).filter((x) => x.staffId !== staffId));
}

/** Замена: смена `who` уходит к `by`; у `by` пометка «вместо who». */
export function replaceShift(data: ScheduleData, day: string, who: string, by: string): ScheduleData {
  const own = shiftOf(data, day, who);
  const kind = own?.kind ?? "full";
  let next = removeShift(data, day, who);
  next = removeShift(next, day, by);
  return putShift(next, day, { staffId: by, kind, from: own?.from, to: own?.to, replaces: who });
}

/** Отменить замену: вернуть смену тому, кого заменяли. */
export function undoReplace(data: ScheduleData, day: string, who: string): ScheduleData {
  const rep = replacedBy(data, day, who);
  if (!rep) return data;
  let next = removeShift(data, day, rep.staffId);
  return putShift(next, day, { staffId: who, kind: rep.kind, from: rep.from, to: rep.to });
}

// ---------- автозаполнение ----------

export const TEMPLATE_LABEL: Record<TemplateKind, string> = {
  none: "Не заполнять",
  "2/2": "2/2",
  "3/3": "3/3",
  "1/1": "1/1",
  "5/2": "5/2 (пн–пт)",
  weekdays: "По дням недели",
};

export function worksOn(t: Template, day: string): boolean {
  if (t.kind === "none" || !t.start || day < t.start) return false;
  if (t.kind === "5/2") return weekday(day) < 5;
  if (t.kind === "weekdays") return (t.weekdays ?? []).includes(weekday(day));
  const n = t.kind === "2/2" ? 2 : t.kind === "3/3" ? 3 : 1;
  return diffDays(t.start, day) % (2 * n) < n;
}

export interface FillPlan {
  added: { day: string; staffId: string }[];
  kept: number;
}

/** Что поставит автозаполнение: только пустые дни сотрудника, замены и ручные смены не трогаем. */
export function planAutofill(
  data: ScheduleData,
  staff: StaffEntry[],
  templates: Record<string, Template>,
  from: string,
  to: string,
): FillPlan {
  return planAutofillDays(data, staff, templates, range(from, to));
}

/** То же по произвольному набору дней (выбранные недели). */
export function planAutofillDays(
  data: ScheduleData,
  staff: StaffEntry[],
  templates: Record<string, Template>,
  days: string[],
): FillPlan {
  const added: FillPlan["added"] = [];
  let kept = 0;
  const people = staff.filter(isActive);
  for (const day of days) {
    if (data.closed[monthKey(day)]) continue;
    for (const s of people) {
      const own = shiftOf(data, day, s.id);
      const t = templates[s.id];
      if (own || replacedBy(data, day, s.id)) {
        if (own && !own.auto) kept++;
        continue;
      }
      if (t && worksOn(t, day)) added.push({ day, staffId: s.id });
    }
  }
  return { added, kept };
}

export function applyPlan(data: ScheduleData, plan: FillPlan): ScheduleData {
  let next = data;
  for (const a of plan.added) next = putShift(next, a.day, { staffId: a.staffId, kind: "full", auto: true });
  return next;
}

/** Недели месяца (пн–вс), дни обрезаны по месяцу. */
export function monthWeeks(month: string): { start: string; days: string[] }[] {
  const out: { start: string; days: string[] }[] = [];
  const first = monthStart(month), last = monthEnd(month);
  for (let w = weekStart(first); w <= last; w = addDays(w, 7)) {
    out.push({ start: w, days: range(w, addDays(w, 6)).filter((d) => d >= first && d <= last) });
  }
  return out;
}

/** Очистить дни: все смены или только поставленные автозаполнением (ручные и замены остаются). */
export function clearDays(data: ScheduleData, days: string[], onlyAuto: boolean): { data: ScheduleData; removed: number } {
  let removed = 0;
  let next = data;
  for (const day of days) {
    if (data.closed[monthKey(day)]) continue;
    const list = shiftsOn(next, day);
    const keep = onlyAuto ? list.filter((x) => !x.auto || x.replaces) : [];
    removed += list.length - keep.length;
    if (keep.length !== list.length) next = setShifts(next, day, keep);
  }
  return { data: next, removed };
}

/** «Продлевать автоматически»: дозаполнить до конца следующего месяца, начиная после filledUntil. */
export function autoExtend(
  data: ScheduleData,
  staff: StaffEntry[],
): { data: ScheduleData; added: FillPlan["added"]; until: string } | null {
  if (!data.autoExtend) return null;
  const until = monthEnd(shiftMonth(monthKey(todayYmd()), 1));
  const from = data.filledUntil ? addDays(data.filledUntil, 1) : todayYmd();
  if (from > until) return null;
  const plan = planAutofill(data, staff, data.templates, from, until);
  return { data: { ...applyPlan(data, plan), filledUntil: until }, added: plan.added, until };
}

// ---------- точечная отмена и закрытые месяцы ----------

export type DaysSnapshot = Record<string, Shift[]>;

/** Запомнить смены этих дней — для «Отменить», которое не трогает остальное. */
export function snapshotDays(data: ScheduleData, days: string[]): DaysSnapshot {
  const out: DaysSnapshot = {};
  for (const d of days) out[d] = shiftsOn(data, d);
  return out;
}

export function restoreDays(data: ScheduleData, snap: DaysSnapshot): ScheduleData {
  let next = data;
  for (const [d, list] of Object.entries(snap)) next = setShifts(next, d, list);
  return next;
}

export function isClosedDay(data: ScheduleData, day: string): boolean {
  return !!data.closed[monthKey(day)];
}

/** Ручная правка смены: убрать пометку «по шаблону». */
export function asManual(sh: Shift): Shift {
  const { auto: _a, ...rest } = sh;
  return rest;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
