// Правки графика для нового конструктора: кисть по ячейкам, строка «Владелец», замена на период,
// повтор прошлой недели. Всё поверх функций schedule.ts — формат смен прежний, программа 1.9+ читает его как есть.
// Закрытые месяцы не меняются ни одной из функций.

import { isOwnerDay } from "./payroll";
import {
  addDays,
  asManual,
  halfHours,
  isClosedDay,
  putShift,
  removeShift,
  replaceShift,
  setShifts,
  shiftOf,
  type ScheduleData,
  type Shift,
} from "./schedule";

export type Brush = "full" | "am" | "pm" | "hours" | "erase";
export interface Hours {
  from: string;
  to: string;
}

/** Вечерняя половина хранится как свои часы «середина – конец» — так её пишет программа. */
export function secondHalf(data: ScheduleData): Hours {
  const [from, to] = halfHours(data).second.split(" – ");
  return { from, to };
}

export function isSecondHalf(sh: Shift, data: ScheduleData): boolean {
  const h = secondHalf(data);
  return sh.kind === "custom" && sh.from === h.from && sh.to === h.to;
}

/** Какой кистью нарисована смена (для подсветки и «повторный щелчок стирает»). */
export function brushOf(sh: Shift | undefined, data: ScheduleData): Exclude<Brush, "erase"> | null {
  if (!sh) return null;
  if (sh.kind === "full") return "full";
  if (sh.kind === "half") return "am";
  if (isSecondHalf(sh, data)) return "pm";
  return "hours";
}

function shiftFor(staffId: string, brush: Exclude<Brush, "erase">, data: ScheduleData, hours?: Hours): Shift {
  if (brush === "am") return { staffId, kind: "half" };
  if (brush === "pm") return { staffId, kind: "custom", ...secondHalf(data) };
  if (brush === "hours" && hours?.from && hours.to && hours.from < hours.to) return { staffId, kind: "custom", from: hours.from, to: hours.to };
  return { staffId, kind: "full" };
}

/** Совпадает ли смена с тем, что ставит кисть (тогда первый щелчок по ней стирает). */
export function sameAsBrush(sh: Shift | undefined, brush: Brush, data: ScheduleData, hours?: Hours): boolean {
  if (!sh || brush === "erase") return false;
  const want = shiftFor(sh.staffId, brush, data, hours);
  return sh.kind === want.kind && (sh.from ?? "") === (want.from ?? "") && (sh.to ?? "") === (want.to ?? "");
}

/**
 * Одна ячейка кистью. Стереть — убрать смену; иначе поставить (пометка замены сохраняется).
 * Смена сотрудника в день владельца снимает отметку владельца: в программе это взаимоисключающие состояния.
 */
export function paintCell(data: ScheduleData, staffId: string, day: string, brush: Brush, hours?: Hours): ScheduleData {
  if (isClosedDay(data, day)) return data;
  const own = shiftOf(data, day, staffId);
  if (brush === "erase") return own ? removeShift(data, day, staffId) : data;
  const next: Shift = asManual({ ...shiftFor(staffId, brush, data, hours), ...(own?.replaces ? { replaces: own.replaces } : {}) });
  let out = putShift(data, day, next);
  if (isOwnerDay(out, day)) out = { ...out, ownerDays: (out.ownerDays ?? []).filter((d) => d !== day) };
  return out;
}

/**
 * «Работает владелец»: как переключатель «Владелец на смене» в программе — смены сотрудников этого дня убираются
 * (за день никому не начисляется). Снять отметку — просто убрать день из списка.
 */
export function setOwnerDay(data: ScheduleData, day: string, on: boolean): ScheduleData {
  if (isClosedDay(data, day)) return data;
  const list = data.ownerDays ?? [];
  if (!on) return list.includes(day) ? { ...data, ownerDays: list.filter((d) => d !== day) } : data;
  if (list.includes(day)) return data;
  return { ...setShifts(data, day, []), ownerDays: [...list, day] };
}

export interface TransferResult {
  data: ScheduleData;
  /** дни, которые перешли */
  moved: string[];
  /** дни, где у того, кто выходит, уже своя смена, или месяц закрыт */
  skipped: string[];
}

/** Замена на период: смены `from` переходят к `to`. mark — с пометкой «за …» (оплата тому, кто вышел). */
export function transferShifts(data: ScheduleData, from: string, to: string, days: string[], mark: boolean): TransferResult {
  let next = data;
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const day of days) {
    const sh = shiftOf(next, day, from);
    if (!sh) continue;
    if (isClosedDay(next, day) || shiftOf(next, day, to)) {
      skipped.push(day);
      continue;
    }
    if (mark) next = replaceShift(next, day, from, to);
    else {
      next = removeShift(next, day, from);
      next = putShift(next, day, asManual({ staffId: to, kind: sh.kind, from: sh.from, to: sh.to }));
    }
    moved.push(day);
  }
  return { data: next, moved, skipped };
}

/** Поменять местами: в каждый день периода смены двоих меняются хозяевами. */
export function swapShifts(data: ScheduleData, a: string, b: string, days: string[]): TransferResult {
  let next = data;
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const day of days) {
    const sa = shiftOf(next, day, a);
    const sb = shiftOf(next, day, b);
    if (!sa && !sb) continue;
    if (isClosedDay(next, day)) {
      skipped.push(day);
      continue;
    }
    next = removeShift(removeShift(next, day, a), day, b);
    if (sa) next = putShift(next, day, asManual({ ...sa, staffId: b, replaces: undefined }));
    if (sb) next = putShift(next, day, asManual({ ...sb, staffId: a, replaces: undefined }));
    moved.push(day);
  }
  return { data: cleanUndefined(next), moved, skipped };
}

/** Повторить смены дней `src` в дни `dst` того же размера: только пустые ячейки, закрытые месяцы не трогаем. */
export function copyDays(data: ScheduleData, staffIds: string[], src: string[], dst: string[]): { data: ScheduleData; added: number } {
  let next = data;
  let added = 0;
  const people = new Set(staffIds);
  src.forEach((from, i) => {
    const day = dst[i];
    if (!day || isClosedDay(next, day) || isOwnerDay(next, day)) return;
    for (const sh of next.shifts[from] ?? []) {
      if (!people.has(sh.staffId) || sh.replaces || shiftOf(next, day, sh.staffId)) continue;
      next = putShift(next, day, asManual({ staffId: sh.staffId, kind: sh.kind, from: sh.from, to: sh.to }));
      added++;
    }
  });
  return { data: cleanUndefined(next), added };
}

/** Неделя `weekStart` повторяет предыдущую. */
export function repeatPrevWeek(data: ScheduleData, staffIds: string[], weekStart: string): { data: ScheduleData; added: number } {
  const dst = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const src = dst.map((d) => addDays(d, -7));
  return copyDays(data, staffIds, src, dst);
}

/** JSON не хранит undefined, а сравнение версий должно видеть одно и то же. */
function cleanUndefined(data: ScheduleData): ScheduleData {
  const shifts: ScheduleData["shifts"] = {};
  for (const [day, list] of Object.entries(data.shifts)) {
    shifts[day] = list.map((sh) => {
      const out = { ...sh } as Record<string, unknown>;
      for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
      return out as unknown as Shift;
    });
  }
  return { ...data, shifts };
}

/** Сколько человек может работать в пункте в один день: 1 (по умолчанию), 2 или 3. */
export function maxPerDay(data: ScheduleData): number {
  const n = Number(data.maxPerDay);
  return n === 2 || n === 3 ? n : 1;
}

/** В этот день сотрудников больше, чем разрешено настройкой пункта. */
export function overLimit(data: ScheduleData, day: string): boolean {
  return (data.shifts[day]?.length ?? 0) > maxPerDay(data);
}
