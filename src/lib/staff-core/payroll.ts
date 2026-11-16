// Учёт зарплаты: у каждого сотрудника счёт по месяцам.
// Остаток с прошлого месяца + начислено (смены / ШК) + премии и возвраты − штрафы − удержания WB − выплачено.
// Всё вводится вручную; записи не удаляются, а отменяются (cancelled) — так видна история.

import type { StaffEntry } from "./types";
import {
  isActive,
  monthEnd,
  monthKey,
  monthStart,
  newId,
  paysShk,
  range,
  rateOn,
  shiftMonth,
  shiftOf,
  shiftValue,
  shkCountOn,
  shkPriceOn,
  todayYmd,
  type Adjust,
  type Deduction,
  type Payment,
  type ScheduleData,
  type Shift,
} from "./schedule";

export const PAY_TYPE: Record<Payment["type"], string> = { advance: "Аванс", salary: "Зарплата", other: "Выплата вне графика" };
export const PAY_METHOD: Record<Payment["method"], string> = { cash: "Наличные из кассы", card: "Перевод на карту", other: "Другое" };
export const DEDUCTION_KINDS = ["Подмена товара", "Зависший товар", "Брак", "Утеря", "Другое"];

/**
 * Переход на учёт выплат (один раз). Остаток начинает переноситься с текущего месяца:
 * раньше выплаты не записывались, и прошлые месяцы иначе выглядели бы долгами.
 * Отмеченные «выплачен» авансы текущего месяца становятся записями о выплате.
 */
export function migrateLedger(data: ScheduleData): ScheduleData {
  if (data.ledgerFrom) return data;
  const month = monthKey(todayYmd());
  const payments: Payment[] = [...(data.payments ?? [])];
  for (const [m, list] of Object.entries(data.advances ?? {})) {
    if (m < month) continue;
    for (const [staffId, a] of Object.entries(list)) {
      if (!a.paid || !(a.amount > 0)) continue;
      const day = `${m}-${String(Math.min(data.advanceRule.day || 15, 28)).padStart(2, "0")}`;
      payments.push({ id: newId(), staffId, date: day, type: "advance", amount: a.amount, method: "other", note: "Аванс (отмечен до перехода на учёт выплат)" });
    }
  }
  return { ...data, payments, ledgerFrom: month };
}

const live = <T extends { cancelled?: unknown }>(x: T) => !x.cancelled;

export function isOwnerDay(data: ScheduleData, day: string): boolean {
  return (data.ownerDays ?? []).includes(day);
}

/** Доля удержания на сотрудника (1 — всё на нём, 0 — не на нём). */
export function deductionShare(d: Deduction, staffId: string): number {
  if (!d.assign) return 0;
  if (d.assign.type === "staff") return d.assign.id === staffId ? 1 : 0;
  if (d.assign.type === "split") return d.assign.ids.includes(staffId) ? 1 / d.assign.ids.length : 0;
  return 0;
}

/** Аванс по правилу: за смены (или ШК) с 1-го по день аванса, процент от них или фикс. */
export function computeAdvance(s: StaffEntry, data: ScheduleData, month: string): number {
  const rule = data.advanceRule;
  if (rule.mode === "fixed") return rule.value || 0;
  const dayN = `${month}-${String(Math.max(1, Math.min(rule.day, 31))).padStart(2, "0")}`;
  const until = dayN < monthEnd(month) ? dayN : monthEnd(month);
  const shk = paysShk(s);
  let earned = 0;
  for (const day of range(monthStart(month), until)) {
    if (shk) {
      earned += (shkCountOn(data, s.id, day)?.n ?? 0) * shkPriceOn(s, data, day);
      continue;
    }
    const sh = shiftOf(data, day, s.id);
    if (sh) earned += shiftValue(sh, data) * rateOn(s, day);
  }
  if (rule.mode === "percent") return Math.round((earned * (rule.value || 0)) / 100);
  return Math.round(earned);
}

export interface MonthCalc {
  staffId: string;
  month: string;
  /** долг пункта перед сотрудником (+) или сотрудника перед пунктом (−) на 1-е число */
  opening: number;
  /** смены, которые уже прошли (в текущем месяце — до сегодня включительно) */
  days: { day: string; shift: Shift; value: number; rate: number }[];
  shkDays: { day: string; n: number; rate: number }[];
  units: number;
  shk: number;
  earned: number;
  /** ещё по графику до конца месяца */
  planUnits: number;
  planEarned: number;
  bonuses: Adjust[];
  fines: Adjust[];
  bonus: number;
  fine: number;
  /** удержания WB на этом сотруднике, которые вычитаются в этом месяце */
  held: { d: Deduction; amount: number }[];
  heldSum: number;
  /** оспариваются — пока не вычитаем */
  disputed: { d: Deduction; amount: number }[];
  /** WB вернул удержание прошлого месяца — доплата */
  credits: { d: Deduction; amount: number }[];
  creditSum: number;
  payments: Payment[];
  paid: number;
  advancePaid: number;
  /** аванс по правилу */
  advance: number;
  /** осталось выплатить (минус — сотрудник получил больше) */
  left: number;
  /** к дню зарплаты, если всё пройдёт по графику */
  forecast: number;
  noRate: boolean;
  closed: boolean;
  /** месяц закрыт до перехода на учёт выплат: суммы из сохранённого расчёта */
  legacy: boolean;
  /** месяц до начала учёта выплат: остаток не переносится */
  beforeLedger: boolean;
}

function cutoff(month: string): string {
  const t = todayYmd();
  const cur = monthKey(t);
  return month < cur ? "9999-99-99" : month > cur ? "0000-00-00" : t;
}

export function monthCalc(s: StaffEntry, data: ScheduleData, month: string, depth = 0): MonthCalc {
  const closed = data.closed[month];
  const ledgerFrom = data.ledgerFrom ?? month;
  const beforeLedger = month < ledgerFrom;
  const byShk = paysShk(s);
  const cut = cutoff(month);
  const days: MonthCalc["days"] = [];
  const shkDays: MonthCalc["shkDays"] = [];
  let planUnits = 0, planEarned = 0;
  for (const day of range(monthStart(month), monthEnd(month))) {
    const sh = shiftOf(data, day, s.id);
    if (day > cut) {
      if (sh) {
        const v = shiftValue(sh, data);
        planUnits += v;
        // за ШК будущее оцениваем по среднему за прошедшие смены
        planEarned += byShk ? 0 : v * rateOn(s, day);
      }
      continue;
    }
    if (sh) days.push({ day, shift: sh, value: shiftValue(sh, data), rate: byShk ? 0 : rateOn(s, day) });
    const c = byShk ? shkCountOn(data, s.id, day) : undefined;
    if (c && c.n) shkDays.push({ day, n: c.n, rate: shkPriceOn(s, data, day) });
  }
  const units = days.reduce((a, d) => a + d.value, 0);
  const shk = shkDays.reduce((a, d) => a + d.n, 0);
  const shkEarned = shkDays.reduce((a, d) => a + d.n * d.rate, 0);
  if (byShk && planUnits && days.length) planEarned = (shkEarned / days.length) * planUnits;
  const earned = Math.round(days.reduce((a, d) => a + d.value * d.rate, 0) + shkEarned);

  const adj = data.adjustments.filter((a) => a.staffId === s.id && monthKey(a.date) === month && live(a));
  const bonuses = adj.filter((a) => a.amount > 0);
  const fines = adj.filter((a) => a.amount < 0);
  const bonus = bonuses.reduce((x, a) => x + a.amount, 0);
  const fine = fines.reduce((x, a) => x - a.amount, 0);

  const held: MonthCalc["held"] = [], disputed: MonthCalc["disputed"] = [], credits: MonthCalc["credits"] = [];
  if (data.deductWb) {
    for (const d of data.deductions ?? []) {
      const share = deductionShare(d, s.id);
      if (!share) continue;
      const amount = Math.round(d.amount * share);
      const dm = monthKey(d.date);
      const rm = d.returnedAt ? monthKey(d.returnedAt) : "";
      if (dm === month) {
        if (d.status === "held" || (d.status === "returned" && rm !== month)) held.push({ d, amount });
        else if (d.status === "disputed") disputed.push({ d, amount });
      }
      if (d.status === "returned" && rm === month && dm !== month) credits.push({ d, amount });
    }
  }
  const heldSum = held.reduce((a, x) => a + x.amount, 0);
  const creditSum = credits.reduce((a, x) => a + x.amount, 0);

  const payments = (data.payments ?? []).filter((p) => p.staffId === s.id && monthKey(p.date) === month && live(p)).sort((a, b) => a.date.localeCompare(b.date));
  const paid = payments.reduce((a, p) => a + p.amount, 0);
  const advancePaid = payments.filter((p) => p.type === "advance").reduce((a, p) => a + p.amount, 0);

  let opening = 0;
  if (!beforeLedger && month > ledgerFrom && depth < 60) {
    const prev = shiftMonth(month, -1);
    const bal = data.closed[prev]?.balances?.[s.id];
    opening = bal != null ? bal : monthCalc(s, data, prev, depth + 1).left;
  }

  const noRate = byShk ? shkDays.some((d) => !d.rate) : days.some((d) => !d.rate);
  const base: MonthCalc = {
    staffId: s.id, month, opening, days, shkDays, units, shk, earned, planUnits, planEarned: Math.round(planEarned),
    bonuses, fines, bonus, fine, held, heldSum, disputed, credits, creditSum, payments, paid, advancePaid,
    advance: computeAdvance(s, data, month), left: 0, forecast: 0, noRate, closed: !!closed, legacy: false, beforeLedger,
  };
  // закрыт по-старому (до учёта выплат): берём зафиксированные суммы, считаем выплаченным
  const snap = closed && !closed.balances ? closed.rows?.find((r) => r.staffId === s.id) : undefined;
  if (snap) {
    return {
      ...base, opening: 0, earned: snap.earned, units: snap.shifts, bonus: snap.bonus + (snap.wbBack ?? 0), fine: snap.fines,
      heldSum: snap.wb, creditSum: 0, paid: snap.total, left: 0, forecast: 0, legacy: true,
    };
  }
  base.left = opening + earned + bonus + creditSum - fine - heldSum - paid;
  base.forecast = base.left + base.planEarned;
  return base;
}

/** Кого показывать в зарплате месяца: работающие и все, у кого в месяце есть суммы. */
export function payrollPeople(staff: StaffEntry[], data: ScheduleData, month: string): StaffEntry[] {
  return staff.filter((s) => {
    if (isActive(s)) return true;
    const c = monthCalc(s, data, month);
    return c.units || c.shk || c.opening || c.payments.length || c.bonuses.length || c.fines.length || c.held.length || c.credits.length;
  });
}

/** Удержания, у которых не выбрано, с кого удерживать. */
export function undecided(data: ScheduleData, month?: string): Deduction[] {
  return (data.deductions ?? []).filter((d) => !d.assign && d.status !== "returned" && (!month || monthKey(d.date) === month));
}

/** Закрыть месяц: запоминаем остатки — с них начнётся следующий месяц. */
export function closeMonth(data: ScheduleData, staff: StaffEntry[], month: string): ScheduleData {
  const balances: Record<string, number> = {};
  for (const s of payrollPeople(staff, data, month)) balances[s.id] = monthCalc(s, data, month).left;
  return { ...data, closed: { ...data.closed, [month]: { at: new Date().toISOString(), balances } } };
}

export function reopenMonth(data: ScheduleData, month: string): ScheduleData {
  const closed = { ...data.closed };
  delete closed[month];
  return { ...data, closed };
}

export function addPayment(data: ScheduleData, p: Omit<Payment, "id">): ScheduleData {
  return { ...data, payments: [...(data.payments ?? []), { ...p, id: newId() }] };
}

export function cancelPayment(data: ScheduleData, id: string, why: string): ScheduleData {
  return { ...data, payments: (data.payments ?? []).map((p) => (p.id === id ? { ...p, cancelled: { at: todayYmd(), why } } : p)) };
}

export function cancelAdjust(data: ScheduleData, id: string, why: string): ScheduleData {
  return { ...data, adjustments: data.adjustments.map((a) => (a.id === id ? { ...a, cancelled: { at: todayYmd(), why } } : a)) };
}

/** Премия, штраф (частями за n месяцев) или корректировка. */
export function addAdjust(data: ScheduleData, a: { staffId: string; date: string; amount: number; reason: string; kind?: "correction" }, parts = 1): ScheduleData {
  const list = [...data.adjustments];
  const n = Math.max(1, parts);
  for (let i = 0; i < n; i++) {
    const date = i ? `${shiftMonth(monthKey(a.date), i)}-01` : a.date;
    const amount = i === n - 1 ? a.amount - Math.round(a.amount / n) * (n - 1) : Math.round(a.amount / n);
    list.push({ id: newId(), staffId: a.staffId, date, amount, reason: n > 1 ? `${a.reason} (часть ${i + 1} из ${n})` : a.reason, kind: a.kind });
  }
  return { ...data, adjustments: list };
}

export function saveDeduction(data: ScheduleData, d: Deduction): ScheduleData {
  const list = data.deductions ?? [];
  return { ...data, deductions: list.some((x) => x.id === d.id) ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d] };
}

export function removeDeduction(data: ScheduleData, id: string): ScheduleData {
  return { ...data, deductions: (data.deductions ?? []).filter((x) => x.id !== id) };
}

/** Журнал: все записи одним списком, новые сверху. */
export type JournalItem =
  | { kind: "payment"; date: string; staffId: string; p: Payment }
  | { kind: "adjust"; date: string; staffId: string; a: Adjust }
  | { kind: "deduction"; date: string; staffIds: string[]; d: Deduction };

export function journal(data: ScheduleData): JournalItem[] {
  const out: JournalItem[] = [];
  for (const p of data.payments ?? []) out.push({ kind: "payment", date: p.date, staffId: p.staffId, p });
  for (const a of data.adjustments) out.push({ kind: "adjust", date: a.date, staffId: a.staffId, a });
  for (const d of data.deductions ?? []) {
    const ids = !d.assign ? [] : d.assign.type === "staff" ? [d.assign.id] : d.assign.type === "split" ? d.assign.ids : [];
    out.push({ kind: "deduction", date: d.date, staffIds: ids, d });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
