// Итоги за период одной функцией: в программе их считали три разных цикла (табель, итоги месяца, очистка).

import { isOwnerDay } from "./payroll";
import { paysShk, rateOn, shiftOf, shiftValue, shiftsOn, type ScheduleData } from "./schedule";
import type { StaffEntry } from "./types";

export interface PersonTotal {
  staffId: string;
  /** смен (половина — 0.5, свои часы — доля) */
  units: number;
  /** по ставке за смену; у тех, кому платим за товары, — 0 */
  money: number;
  /** платим за принятые товары — сумма считается в зарплате */
  byGoods: boolean;
  /** есть смены без ставки */
  noRate: boolean;
}

export function personTotal(s: StaffEntry, data: ScheduleData, days: string[]): PersonTotal {
  const byGoods = paysShk(s);
  let units = 0, money = 0, noRate = false;
  for (const day of days) {
    const sh = shiftOf(data, day, s.id);
    if (!sh) continue;
    const v = shiftValue(sh, data);
    units += v;
    if (byGoods) continue;
    const rate = rateOn(s, day);
    if (!rate) noRate = true;
    money += v * rate;
  }
  return { staffId: s.id, units: Math.round(units * 100) / 100, money: Math.round(money), byGoods, noRate };
}

/** Сколько человек в пункте в день: сотрудники со сменой + владелец, если отмечен. */
export function coverage(data: ScheduleData, day: string): number {
  return shiftsOn(data, day).length + (isOwnerDay(data, day) ? 1 : 0);
}

/** Дни без людей (не считая дней владельца). */
export function emptyDays(data: ScheduleData, days: string[]): string[] {
  return days.filter((d) => coverage(data, d) === 0);
}

export function periodTotals(staff: StaffEntry[], data: ScheduleData, days: string[]) {
  const people = staff.map((s) => personTotal(s, data, days));
  return {
    people,
    money: people.reduce((a, p) => a + p.money, 0),
    units: Math.round(people.reduce((a, p) => a + p.units, 0) * 100) / 100,
  };
}

/** «12,5» вместо «12.5» и без хвостов «0,6666». */
export function unitsText(n: number): string {
  return String(Math.round(n * 10) / 10).replace(".", ",");
}

export function rub(n: number): string {
  return `${Math.round(n).toLocaleString("ru-RU")} ₽`;
}
