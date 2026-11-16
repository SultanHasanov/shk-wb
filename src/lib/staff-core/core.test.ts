import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOverview,
  copyDays,
  emptySchedule,
  exportSheets,
  monthCalc,
  normalizeSchedule,
  paintCell,
  personKey,
  personTotal,
  pointMoney,
  repeatPrevWeek,
  scheduleText,
  setOwnerDay,
  shiftCode,
  swapShifts,
  transferShifts,
  writeXlsx,
  type ScheduleData,
  type StaffEntry,
} from './index';

const anna: StaffEntry = { id: 'a', name: 'Анна Соколова', last4: '', sid: '', phone: '+7 900 000-00-01', rates: [{ from: '2026-01-01', rate: 2500 }] };
const marina: StaffEntry = { id: 'm', name: 'Марина Ким', last4: '', sid: '', phone: '', rates: [{ from: '2026-01-01', rate: 2000 }] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 20, 12, 0, 0));
});
afterEach(() => vi.useRealTimers());

function sched(): ScheduleData {
  return normalizeSchedule(emptySchedule());
}

describe('кисть', () => {
  it('ставит смену, утро, вечер и свои часы в формате программы', () => {
    let d = sched();
    d = paintCell(d, 'a', '2026-11-02', 'full');
    d = paintCell(d, 'a', '2026-11-03', 'am');
    d = paintCell(d, 'a', '2026-11-04', 'pm');
    d = paintCell(d, 'a', '2026-11-05', 'hours', { from: '10:00', to: '18:00' });
    expect(d.shifts['2026-11-02']).toEqual([{ staffId: 'a', kind: 'full' }]);
    expect(d.shifts['2026-11-03']).toEqual([{ staffId: 'a', kind: 'half' }]);
    expect(d.shifts['2026-11-04']).toEqual([{ staffId: 'a', kind: 'custom', from: '15:00', to: '21:00' }]);
    expect(d.shifts['2026-11-05']).toEqual([{ staffId: 'a', kind: 'custom', from: '10:00', to: '18:00' }]);
    expect(['С', 'У', 'В', '8ч']).toEqual(['02', '03', '04', '05'].map(x => shiftCode(d.shifts[`2026-11-${x}`][0], d)));
  });

  it('стирает и не трогает закрытый месяц', () => {
    let d = paintCell(sched(), 'a', '2026-10-02', 'full');
    d = { ...d, closed: { '2026-10': { at: 'x', balances: {} } } };
    expect(paintCell(d, 'a', '2026-10-02', 'erase')).toBe(d);
    expect(paintCell(d, 'a', '2026-10-03', 'full')).toBe(d);
  });

  it('день владельца убирает смены сотрудников, смена сотрудника снимает день владельца', () => {
    let d = paintCell(sched(), 'a', '2026-11-10', 'full');
    d = setOwnerDay(d, '2026-11-10', true);
    expect(d.shifts['2026-11-10']).toBeUndefined();
    expect(d.ownerDays).toEqual(['2026-11-10']);
    d = paintCell(d, 'm', '2026-11-10', 'full');
    expect(d.ownerDays).toEqual([]);
  });
});

describe('замены', () => {
  it('передать смены с пометкой: оплата тому, кто вышел', () => {
    let d = sched();
    for (const day of ['2026-11-17', '2026-11-18', '2026-11-19']) d = paintCell(d, 'a', day, 'full');
    d = paintCell(d, 'm', '2026-11-19', 'full');
    const r = transferShifts(d, 'a', 'm', ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'], true);
    expect(r.moved).toEqual(['2026-11-17', '2026-11-18']);
    expect(r.skipped).toEqual(['2026-11-19']);
    expect(r.data.shifts['2026-11-17']).toEqual([{ staffId: 'm', kind: 'full', replaces: 'a' }]);
    expect(personTotal(marina, r.data, ['2026-11-17', '2026-11-18', '2026-11-19']).money).toBe(6000);
  });

  it('поменять местами', () => {
    let d = paintCell(sched(), 'a', '2026-11-17', 'full');
    d = paintCell(d, 'm', '2026-11-18', 'am');
    const r = swapShifts(d, 'a', 'm', ['2026-11-17', '2026-11-18']);
    expect(r.data.shifts['2026-11-17']).toEqual([{ staffId: 'm', kind: 'full' }]);
    expect(r.data.shifts['2026-11-18']).toEqual([{ staffId: 'a', kind: 'half' }]);
  });

  it('повтор прошлой недели заполняет только пустые дни', () => {
    let d = paintCell(sched(), 'a', '2026-11-09', 'full');
    d = paintCell(d, 'm', '2026-11-10', 'pm');
    d = paintCell(d, 'a', '2026-11-16', 'am');
    const r = repeatPrevWeek(d, ['a', 'm'], '2026-11-16');
    expect(r.added).toBe(1);
    expect(r.data.shifts['2026-11-16']).toEqual([{ staffId: 'a', kind: 'half' }]);
    expect(r.data.shifts['2026-11-17']).toEqual([{ staffId: 'm', kind: 'custom', from: '15:00', to: '21:00' }]);
    expect(copyDays(d, ['a'], [], []).added).toBe(0);
  });
});

describe('зарплата совпадает с программой', () => {
  it('прошедшие смены начисляются, будущие — в прогнозе', () => {
    let d = sched();
    d = paintCell(d, 'a', '2026-11-05', 'full');
    d = paintCell(d, 'a', '2026-11-06', 'am');
    d = paintCell(d, 'a', '2026-11-25', 'full');
    const c = monthCalc(anna, d, '2026-11');
    expect(c.earned).toBe(3750);
    expect(c.planEarned).toBe(2500);
    expect(c.left).toBe(3750);
  });
});

describe('все пункты', () => {
  it('связывает человека по телефону и находит пересечения', () => {
    const p1 = { id: 'p1', name: 'Ленина', staff: [anna], schedule: paintCell(sched(), 'a', '2026-11-21', 'pm') };
    const twin: StaffEntry = { ...anna, id: 'x', phone: '89000000001' };
    const p2 = { id: 'p2', name: 'Мира', staff: [twin], schedule: paintCell(sched(), 'x', '2026-11-21', 'full') };
    expect(personKey(anna, 'p1')).toBe(personKey(twin, 'p2'));
    const o = buildOverview([p1, p2], ['2026-11-20', '2026-11-21']);
    expect(o.rows).toHaveLength(1);
    expect(o.conflicts).toEqual([{ day: '2026-11-21', key: 'tel:9000000001', name: 'Анна Соколова', pointIds: ['p1', 'p2'] }]);
    expect(o.cover['2026-11-20']).toEqual({ p1: 0, p2: 0 });
    expect(pointMoney(p2, '2026-11').earned).toBe(0);
  });
});

describe('выгрузка', () => {
  it('текст по дням и по людям', () => {
    let d = paintCell(sched(), 'm', '2026-11-16', 'full');
    d = paintCell(d, 'a', '2026-11-17', 'full');
    d = transferShifts(d, 'a', 'm', ['2026-11-17'], true).data;
    d = setOwnerDay(d, '2026-11-18', true);
    const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'];
    const text = scheduleText([anna, marina], d, { pointName: 'Ленина, 14', days, group: 'days', shortNames: true });
    expect(text).toBe('График: Ленина, 14\n16–19 ноября\n\nПн 16: Марина, 9:00–21:00\nВт 17: Марина, 9:00–21:00 (за Анна)\nСр 18: работает владелец\nЧт 19: никого нет');
    const byPeople = scheduleText([anna, marina], d, { pointName: 'Ленина, 14', days, group: 'people' });
    expect(byPeople).toContain('Марина Ким: пн 16, вт 17 (за Анна Соколова), с 9:00 до 21:00');
    expect(byPeople).toContain('Никого нет: чт 19');
  });

  it('Excel без листа зарплаты не содержит сумм и открывается как zip', () => {
    const d = paintCell(sched(), 'a', '2026-11-03', 'full');
    const sheets = exportSheets([anna, marina], d, { pointName: 'Ленина', month: '2026-11' });
    expect(sheets.map(s => s.name)).toEqual(['График', 'Список']);
    expect(JSON.stringify(sheets)).not.toContain('2500');
    const bytes = writeXlsx(exportSheets([anna], d, { pointName: 'Ленина', month: '2026-11', payroll: true }));
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('xl/worksheets/sheet3.xml');
    expect(text).toContain('Анна Соколова');
  });
});
