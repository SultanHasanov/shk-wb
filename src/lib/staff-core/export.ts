// Выгрузка графика: таблица Excel (табель, список по дням, по желанию — зарплата) и текст для мессенджера.
// Без листа «Зарплата» в файле нет ни ставок, ни сумм — такой файл можно отправлять сотрудникам.

import { isOwnerDay } from "./payroll";
import { monthCalc, payrollPeople } from "./payroll";
import {
  WEEKDAYS,
  dayMonth,
  halfHours,
  isActive,
  monthEnd,
  monthStart,
  monthTitle,
  range,
  shiftOf,
  shiftsOn,
  shortName,
  weekday,
  type ScheduleData,
  type Shift,
} from "./schedule";
import { coverage, personTotal } from "./totals";
import type { StaffEntry } from "./types";
import type { Cell, Sheet } from "./xlsx";

const clock = (t: string) => t.replace(/^0(\d)/, "$1");

/** Часы смены «9:00–21:00». */
export function hoursOf(sh: Shift, data: ScheduleData): string {
  if (sh.kind === "custom" && sh.from && sh.to) return `${clock(sh.from)}–${clock(sh.to)}`;
  if (sh.kind === "half") {
    const [a, b] = halfHours(data).first.split(" – ");
    return `${clock(a)}–${clock(b)}`;
  }
  return `${clock(data.dayHours.from)}–${clock(data.dayHours.to)}`;
}

function minutes(t?: string): number {
  const [h, m] = String(t ?? "").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Буква в табеле: С — смена, У — утро, В — вечер, З — замена, «8ч» — свои часы. */
export function shiftCode(sh: Shift, data: ScheduleData): string {
  if (sh.replaces) return "З";
  if (sh.kind === "full") return "С";
  if (sh.kind === "half") return "У";
  const [mid, end] = halfHours(data).second.split(" – ");
  if (sh.from === mid && sh.to === end) return "В";
  const h = Math.round(((minutes(sh.to) - minutes(sh.from)) / 60) * 10) / 10;
  return `${String(h).replace(".", ",")}ч`;
}

export interface ExportOptions {
  pointName: string;
  month: string;
  /** лист «Зарплата» */
  payroll?: boolean;
}

function monthPeople(staff: StaffEntry[], data: ScheduleData, days: string[]): StaffEntry[] {
  return staff.filter((s) => isActive(s) || days.some((d) => shiftOf(data, d, s.id)));
}

const nameOf = (staff: StaffEntry[], data: ScheduleData, id: string) => staff.find((s) => s.id === id)?.name || data.removedNames?.[id] || "сотрудник";

export function timesheetSheet(staff: StaffEntry[], data: ScheduleData, o: ExportOptions): Sheet {
  const days = range(monthStart(o.month), monthEnd(o.month));
  const people = monthPeople(staff, data, days);
  const last = days.length + 1;
  const rows: Cell[][] = [];
  rows.push([{ v: `График: ${o.pointName}, ${monthTitle(o.month).toLowerCase()}`, s: "title" }]);
  rows.push([{ v: `Смена с ${clock(data.dayHours.from)} до ${clock(data.dayHours.to)}. С — смена, У — утро, В — вечер, З — вышел на замену, число с «ч» — свои часы.`, s: "note" }]);
  rows.push([{ v: "Сотрудник", s: "head" }, ...days.map((d) => ({ v: Number(d.slice(8)), s: "head" as const })), { v: "Смен", s: "head" }]);
  rows.push([{ v: "", s: "head" }, ...days.map((d) => ({ v: WEEKDAYS[weekday(d)].toLowerCase(), s: "head" as const })), { v: "", s: "head" }]);
  for (const s of people) {
    const row: Cell[] = [{ v: s.name || "Без имени", s: "bold" }];
    for (const d of days) {
      const sh = shiftOf(data, d, s.id);
      row.push(sh ? { v: shiftCode(sh, data), s: sh.replaces ? "sub" : "shift" } : { v: "", s: weekday(d) >= 5 ? "weekend" : "center" });
    }
    row.push({ v: personTotal(s, data, days).units, s: "boldNum" });
    rows.push(row);
  }
  if (days.some((d) => isOwnerDay(data, d))) {
    rows.push([{ v: "Владелец", s: "bold" }, ...days.map((d) => (isOwnerDay(data, d) ? { v: "✓", s: "owner" as const } : { v: "", s: weekday(d) >= 5 ? ("weekend" as const) : ("center" as const) })), { v: days.filter((d) => isOwnerDay(data, d)).length, s: "boldNum" }]);
  }
  rows.push([{ v: "В пункте, человек", s: "bold" }, ...days.map((d) => ({ v: coverage(data, d), s: "center" as const })), { v: "", s: "cell" }]);
  const subs = days.flatMap((d) => shiftsOn(data, d).filter((x) => x.replaces).map((x) => `${dayMonth(d)}: ${nameOf(staff, data, x.staffId)} за ${nameOf(staff, data, x.replaces!)}`));
  if (subs.length) {
    rows.push([]);
    rows.push([{ v: "Замены", s: "bold" }]);
    for (const line of subs) rows.push([{ v: line }]);
  }
  return {
    name: "График",
    rows,
    cols: [24, ...days.map(() => 4.6), 7],
    merges: [`A1:${colLetter(last)}1`, `A2:${colLetter(last)}2`, "A3:A4"],
    freeze: { rows: 4, cols: 1 },
  };
}

function colLetter(i: number): string {
  let n = i + 1, out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function listSheet(staff: StaffEntry[], data: ScheduleData, o: ExportOptions): Sheet {
  const days = range(monthStart(o.month), monthEnd(o.month));
  const rows: Cell[][] = [[{ v: `Список смен: ${o.pointName}, ${monthTitle(o.month).toLowerCase()}`, s: "title" }], []];
  rows.push(["Дата", "День", "Сотрудник", "Часы", "Отметка"].map((v) => ({ v, s: "head" as const })));
  for (const d of days) {
    const list = shiftsOn(data, d);
    const date = `${d.slice(8)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
    const wd = WEEKDAYS[weekday(d)].toLowerCase();
    if (isOwnerDay(data, d)) rows.push([{ v: date, s: "cell" }, { v: wd, s: "center" }, { v: "Владелец", s: "cell" }, { v: hoursOf({ staffId: "", kind: "full" }, data), s: "center" }, { v: "работает сам", s: "cell" }]);
    for (const sh of list) {
      rows.push([
        { v: date, s: "cell" },
        { v: wd, s: "center" },
        { v: nameOf(staff, data, sh.staffId), s: "cell" },
        { v: hoursOf(sh, data), s: "center" },
        { v: sh.replaces ? `замена за ${nameOf(staff, data, sh.replaces)}` : "", s: "cell" },
      ]);
    }
    if (!list.length && !isOwnerDay(data, d)) rows.push([{ v: date, s: "cell" }, { v: wd, s: "center" }, { v: "никого нет", s: "cell" }, { v: "", s: "cell" }, { v: "", s: "cell" }]);
  }
  return { name: "Список", rows, cols: [12, 6, 28, 14, 30], merges: ["A1:E1"], freeze: { rows: 3, cols: 0 } };
}

export function payrollSheet(staff: StaffEntry[], data: ScheduleData, o: ExportOptions): Sheet {
  const head = ["Сотрудник", "Перешло с прошлого месяца", "Смен", "Принято товаров", "Начислено", "Премии", "Штрафы", "Удержания WB", "Выплачено", "Осталось выплатить"];
  const rows: Cell[][] = [[{ v: `Зарплата: ${o.pointName}, ${monthTitle(o.month).toLowerCase()}`, s: "title" }], [{ v: "Начислено — только за уже отработанные дни.", s: "note" }]];
  rows.push(head.map((v) => ({ v, s: "head" as const })));
  const sum = Array(9).fill(0) as number[];
  for (const s of payrollPeople(staff, data, o.month)) {
    const c = monthCalc(s, data, o.month);
    const vals = [c.opening, c.units, c.shk, c.earned, c.bonus + c.creditSum, c.fine, c.heldSum, c.paid, c.left];
    vals.forEach((v, i) => { sum[i] += v; });
    rows.push([{ v: s.name || "Без имени", s: "bold" }, ...vals.map((v, i) => ({ v: i === 1 ? Math.round(v * 100) / 100 : v, s: "num" as const }))]);
  }
  rows.push([{ v: "Всего", s: "bold" }, ...sum.map((v, i) => ({ v: i === 1 ? Math.round(v * 100) / 100 : v, s: "boldNum" as const }))]);
  return { name: "Зарплата", rows, cols: [26, 14, 8, 12, 12, 10, 10, 12, 12, 14], merges: ["A1:J1", "A2:J2"], freeze: { rows: 3, cols: 1 } };
}

export function exportSheets(staff: StaffEntry[], data: ScheduleData, o: ExportOptions & { timesheet?: boolean; list?: boolean }): Sheet[] {
  const out: Sheet[] = [];
  if (o.timesheet !== false) out.push(timesheetSheet(staff, data, o));
  if (o.list !== false) out.push(listSheet(staff, data, o));
  if (o.payroll) out.push(payrollSheet(staff, data, o));
  return out;
}

export function fileName(pointName: string, month: string, ext: string): string {
  const safe = pointName.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "пункт";
  return `График ${safe} ${monthTitle(month).toLowerCase()}.${ext}`;
}

// ---------- текст ----------

export interface TextOptions {
  pointName: string;
  days: string[];
  group: "days" | "people";
  /** только имя, без фамилии */
  shortNames?: boolean;
}

const WD_TEXT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function periodTitle(days: string[]): string {
  if (!days.length) return "";
  const a = days[0], b = days[days.length - 1];
  if (a === b) return dayMonth(a);
  if (a.slice(0, 7) === b.slice(0, 7)) return `${Number(a.slice(8))}–${dayMonth(b)}`;
  return `${dayMonth(a)} – ${dayMonth(b)}`;
}

export function scheduleText(staff: StaffEntry[], data: ScheduleData, o: TextOptions): string {
  const name = (id: string) => {
    const full = nameOf(staff, data, id);
    return o.shortNames ? shortName(full) : full;
  };
  const lines = [`График: ${o.pointName}`, periodTitle(o.days), ""];
  const empty: string[] = [];
  if (o.group === "days") {
    for (const d of o.days) {
      const parts = shiftsOn(data, d).map((sh) => `${name(sh.staffId)}, ${hoursOf(sh, data)}${sh.replaces ? ` (за ${name(sh.replaces)})` : ""}`);
      if (isOwnerDay(data, d)) parts.unshift("работает владелец");
      lines.push(`${WD_TEXT[weekday(d)]} ${Number(d.slice(8))}: ${parts.length ? parts.join("; ") : "никого нет"}`);
    }
    return lines.join("\n").trim();
  }
  const ids: string[] = [];
  for (const d of o.days) for (const sh of shiftsOn(data, d)) if (!ids.includes(sh.staffId)) ids.push(sh.staffId);
  const order = staff.map((s) => s.id).filter((id) => ids.includes(id)).concat(ids.filter((id) => !staff.some((s) => s.id === id)));
  for (const id of order) {
    const byHours = new Map<string, string[]>();
    for (const d of o.days) {
      const sh = shiftOf(data, d, id);
      if (!sh) continue;
      const h = hoursOf(sh, data);
      const list = byHours.get(h) ?? [];
      list.push(`${WD_TEXT[weekday(d)].toLowerCase()} ${Number(d.slice(8))}${sh.replaces ? ` (за ${name(sh.replaces)})` : ""}`);
      byHours.set(h, list);
    }
    const parts = [...byHours.entries()].map(([h, ds]) => `${ds.join(", ")}, с ${h.replace("–", " до ")}`);
    lines.push(`${name(id)}: ${parts.join("; ")}`);
  }
  const owner = o.days.filter((d) => isOwnerDay(data, d));
  if (owner.length) lines.push(`Владелец: ${owner.map((d) => `${WD_TEXT[weekday(d)].toLowerCase()} ${Number(d.slice(8))}`).join(", ")}`);
  for (const d of o.days) if (!coverage(data, d)) empty.push(`${WD_TEXT[weekday(d)].toLowerCase()} ${Number(d.slice(8))}`);
  if (empty.length) lines.push("", `Никого нет: ${empty.join(", ")}`);
  return lines.join("\n").trim();
}
