// «Все пункты»: кто где работает, пересечения и деньги по пунктам. Списки сотрудников у пунктов свои
// (как в программе), поэтому один человек в двух пунктах — две записи; связываем их по номеру WB или телефону.

import { monthCalc, payrollPeople } from "./payroll";
import { isActive, shiftOf, shiftValue, type ScheduleData, type Shift } from "./schedule";
import { coverage } from "./totals";
import type { StaffEntry } from "./types";

export interface PointDocs {
  id: string;
  name: string;
  staff: StaffEntry[];
  schedule: ScheduleData;
}

const digits = (s: string | undefined) => String(s ?? "").replace(/\D/g, "");

/** Один и тот же человек в разных пунктах: совпал номер WB или последние 10 цифр телефона. */
export function personKey(s: StaffEntry, pointId: string): string {
  const sid = digits(s.sid);
  if (sid.length >= 4) return `sid:${sid}`;
  const phone = digits(s.phone);
  if (phone.length >= 10) return `tel:${phone.slice(-10)}`;
  return `id:${pointId}:${s.id}`;
}

export interface OverviewCell {
  pointId: string;
  shift: Shift;
}

export interface OverviewRow {
  key: string;
  name: string;
  /** в каких пунктах записан */
  points: string[];
  /** день → смены этого человека во всех пунктах */
  cells: Record<string, OverviewCell[]>;
  units: number;
}

export interface Overview {
  rows: OverviewRow[];
  /** один человек в двух пунктах в один день */
  conflicts: { day: string; key: string; name: string; pointIds: string[] }[];
  /** день → пункт → сколько людей */
  cover: Record<string, Record<string, number>>;
}

export function buildOverview(points: PointDocs[], days: string[]): Overview {
  const rows = new Map<string, OverviewRow>();
  const cover: Overview["cover"] = {};
  for (const day of days) cover[day] = {};
  for (const p of points) {
    for (const day of days) cover[day][p.id] = coverage(p.schedule, day);
    for (const s of p.staff) {
      const key = personKey(s, p.id);
      const hasShifts = days.some((d) => shiftOf(p.schedule, d, s.id));
      if (!hasShifts && !isActive(s)) continue;
      let row = rows.get(key);
      if (!row) {
        row = { key, name: s.name || "Без имени", points: [], cells: {}, units: 0 };
        rows.set(key, row);
      }
      if (!row.points.includes(p.id)) row.points.push(p.id);
      for (const day of days) {
        const sh = shiftOf(p.schedule, day, s.id);
        if (!sh) continue;
        (row.cells[day] ??= []).push({ pointId: p.id, shift: sh });
        row.units += shiftValue(sh, p.schedule);
      }
    }
  }
  const conflicts: Overview["conflicts"] = [];
  for (const row of rows.values()) {
    for (const day of days) {
      const cells = row.cells[day] ?? [];
      const ids = [...new Set(cells.map((c) => c.pointId))];
      if (ids.length > 1) conflicts.push({ day, key: row.key, name: row.name, pointIds: ids });
    }
  }
  const list = [...rows.values()].sort((a, b) => b.points.length - a.points.length || a.name.localeCompare(b.name, "ru"));
  return { rows: list, conflicts: conflicts.sort((a, b) => a.day.localeCompare(b.day)), cover };
}

export interface PointMoney {
  pointId: string;
  people: number;
  earned: number;
  paid: number;
  left: number;
}

/** Деньги пункта за месяц — тот же расчёт, что во вкладке «Зарплата». */
export function pointMoney(p: PointDocs, month: string): PointMoney {
  const people = payrollPeople(p.staff, p.schedule, month);
  let earned = 0, paid = 0, left = 0;
  for (const s of people) {
    const c = monthCalc(s, p.schedule, month);
    earned += c.earned;
    paid += c.paid;
    left += c.left;
  }
  return { pointId: p.id, people: p.staff.filter(isActive).length, earned, paid, left };
}
