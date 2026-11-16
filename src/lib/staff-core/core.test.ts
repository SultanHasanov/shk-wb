import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAdjust,
  addPayment,
  buildOverview,
  clearDay,
  closeMonth,
  copyDays,
  crowdedDays,
  dueFor,
  emptySchedule,
  keepOnly,
  maxPerDay,
  overLimit,
  exportSheets,
  monthCalc,
  normalizeSchedule,
  paidDays,
  paidOn,
  paintCell,
  payDate,
  personKey,
  personTotal,
  pointMoney,
  quickToggle,
  repeatPrevWeek,
  scheduleText,
  setOwnerDay,
  setShkCount,
  shiftCode,
  swapShifts,
  transferShifts,
  weeksDays,
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

describe('сколько человек в день', () => {
  it('по умолчанию один; больше — день помечается, настройка разрешает двоих', () => {
    let d = paintCell(sched(), 'a', '2026-11-20', 'full');
    d = paintCell(d, 'm', '2026-11-20', 'am');
    expect(maxPerDay(d)).toBe(1);
    expect(overLimit(d, '2026-11-20')).toBe(true);
    expect(overLimit({ ...d, maxPerDay: 2 }, '2026-11-20')).toBe(false);
    expect(maxPerDay({ ...d, maxPerDay: 7 })).toBe(1);
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

describe('быстрый выбор у дня', () => {
  it('ставит, снимает и при одном человеке в день заменяет стоящего', () => {
    let r = quickToggle(sched(), 'a', '2026-11-20');
    expect(r).toMatchObject({ kind: 'done' });
    let d = (r as { data: ScheduleData }).data;
    expect(d.shifts['2026-11-20']).toEqual([{ staffId: 'a', kind: 'full' }]);
    r = quickToggle(d, 'm', '2026-11-20');
    expect(r).toMatchObject({ kind: 'done', swapped: 'a' });
    d = (r as { data: ScheduleData }).data;
    expect(d.shifts['2026-11-20']).toEqual([{ staffId: 'm', kind: 'full' }]);
    r = quickToggle(d, 'm', '2026-11-20');
    expect((r as { data: ScheduleData }).data.shifts['2026-11-20']).toBeUndefined();
  });

  it('не теряет молча полсмены, замену и введённые товары — спрашивает', () => {
    const half = paintCell(sched(), 'a', '2026-11-20', 'am');
    expect(quickToggle(half, 'm', '2026-11-20')).toEqual({ kind: 'ask', working: ['a'], limit: 1 });
    const goods = setShkCount(paintCell(sched(), 'a', '2026-11-20', 'full'), 'a', '2026-11-20', 40);
    expect(quickToggle(goods, 'm', '2026-11-20').kind).toBe('ask');
    // двое разрешены: третий уже не помещается
    let two: ScheduleData = { ...paintCell(sched(), 'a', '2026-11-20', 'full'), maxPerDay: 2 };
    two = (quickToggle(two, 'm', '2026-11-20') as { data: ScheduleData }).data;
    expect(two.shifts['2026-11-20']).toHaveLength(2);
    expect(quickToggle(two, 'z', '2026-11-20')).toEqual({ kind: 'ask', working: ['a', 'm'], limit: 2 });
  });

  it('закрытый месяц не меняет; смена сотрудника снимает день владельца', () => {
    const closed: ScheduleData = { ...sched(), closed: { '2026-10': { at: 'x', balances: {} } } };
    expect(quickToggle(closed, 'a', '2026-10-05')).toEqual({ kind: 'done', data: closed });
    const own = setOwnerDay(sched(), '2026-11-20', true);
    const r = quickToggle(own, 'a', '2026-11-20') as { data: ScheduleData };
    expect(r.data.ownerDays).toEqual([]);
    expect(clearDay(setOwnerDay(sched(), '2026-11-21', true), '2026-11-21').ownerDays).toEqual([]);
  });

  it('оставить одного и найти дни с превышением, в том числе прошедшие', () => {
    let d = paintCell(sched(), 'a', '2026-11-02', 'full');
    d = paintCell(d, 'm', '2026-11-02', 'full');
    expect(crowdedDays(d, ['2026-11-01', '2026-11-02', '2026-11-03'])).toEqual(['2026-11-02']);
    expect(keepOnly(d, '2026-11-02', 'm').shifts['2026-11-02']).toEqual([{ staffId: 'm', kind: 'full' }]);
  });
});

describe('выплата за выбранный месяц', () => {
  it('дата учёта остаётся внутри оплачиваемого месяца', () => {
    expect(payDate('2026-11', '2026-11-16')).toBe('2026-11-16');
    expect(payDate('2026-10', '2026-11-16')).toBe('2026-10-31');
    expect(payDate('2026-12', '2026-11-16')).toBe('2026-12-01');
    expect(paidOn({ id: '1', staffId: 'a', date: '2026-10-31', paidAt: '2026-11-16', type: 'salary', amount: 1, method: 'cash', note: '' })).toBe('2026-11-16');
  });

  it('октябрь до начала учёта: зарплата за него гасит остаток октября и не трогает ноябрь', () => {
    let d = sched();
    for (const day of ['2026-10-05', '2026-10-06']) d = paintCell(d, 'a', day, 'full');
    d = paintCell(d, 'a', '2026-11-03', 'full');
    d = { ...d, ledgerFrom: '2026-11' };
    expect(dueFor(anna, d, '2026-10')).toMatchObject({ due: 5000, settledLater: false });
    d = addPayment(d, { staffId: 'a', date: payDate('2026-10', '2026-11-20'), paidAt: '2026-11-20', type: 'salary', amount: 5000, method: 'cash', note: '' });
    expect(dueFor(anna, d, '2026-10').due).toBe(0);
    expect(monthCalc(anna, d, '2026-11').left).toBe(2500);
  });

  it('остаток прошлого месяца, выплаченный уже в следующем, второй раз не предлагается', () => {
    let d: ScheduleData = { ...sched(), ledgerFrom: '2026-10' };
    for (const day of ['2026-10-05', '2026-10-06']) d = paintCell(d, 'a', day, 'full');
    d = paintCell(d, 'a', '2026-11-03', 'full');
    expect(dueFor(anna, d, '2026-10').due).toBe(5000);
    d = addPayment(d, { staffId: 'a', date: '2026-11-10', type: 'salary', amount: 5000, method: 'cash', note: '' });
    expect(dueFor(anna, d, '2026-10')).toMatchObject({ due: 0, settledLater: true });
    expect(dueFor(anna, d, '2026-11').due).toBe(2500);
  });
});

describe('оплаченные дни', () => {
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
  function worked(): ScheduleData {
    let d: ScheduleData = { ...sched(), ledgerFrom: '2026-11' };
    for (const day of days) d = paintCell(d, 'a', day, 'full');
    return paintCell(d, 'a', '2026-11-25', 'full');
  }
  const pay = (d: ScheduleData, amount: number, date = '2026-11-10') => addPayment(d, { staffId: 'a', date, type: 'salary', amount, method: 'cash', note: '' });
  const sumUnpaid = (d: ScheduleData, month = '2026-11') => Object.values(paidDays(anna, d, month).unpaid).reduce((a, b) => a + b, 0);

  it('без выплат все отработанные дни не оплачены, будущие без отметки', () => {
    const m = paidDays(anna, worked(), '2026-11');
    expect(m.state).toEqual({ '2026-11-02': 'due', '2026-11-03': 'due', '2026-11-04': 'due', '2026-11-05': 'due' });
    expect(sumUnpaid(worked())).toBe(monthCalc(anna, worked(), '2026-11').left);
  });

  it('выплаты закрывают дни по порядку с самых ранних, неполная — частично', () => {
    const d = pay(worked(), 6000);
    const m = paidDays(anna, d, '2026-11');
    expect(m.state).toEqual({ '2026-11-02': 'paid', '2026-11-03': 'paid', '2026-11-04': 'part', '2026-11-05': 'due' });
    expect(m.unpaid).toEqual({ '2026-11-04': 1500, '2026-11-05': 2500 });
    expect(sumUnpaid(d)).toBe(monthCalc(anna, d, '2026-11').left);
    expect(Object.values(paidDays(anna, pay(d, 4000), '2026-11').state)).toEqual(['paid', 'paid', 'paid', 'paid']);
  });

  it('штраф уменьшает долг, премия остаётся долгом после смен', () => {
    const fined = addAdjust(worked(), { staffId: 'a', date: '2026-11-06', amount: -2500, reason: 'опоздание' });
    expect(paidDays(anna, fined, '2026-11').state['2026-11-02']).toBe('paid');
    expect(sumUnpaid(fined)).toBe(7500);
    // выплачено всё за смены, премия ещё нет — смены оплачены
    const bonus = pay(addAdjust(worked(), { staffId: 'a', date: '2026-11-03', amount: 1000, reason: 'приёмка' }), 10000);
    expect(Object.values(paidDays(anna, bonus, '2026-11').state)).toEqual(['paid', 'paid', 'paid', 'paid']);
    expect(monthCalc(anna, bonus, '2026-11').left).toBe(1000);
  });

  it('оплата за принятые товары считается по дням с товарами', () => {
    const olga: StaffEntry = { id: 'o', name: 'Ольга', last4: '', sid: '', phone: '', payMode: 'shk', shkRates: [{ from: '2026-01-01', rate: 10 }] };
    let d: ScheduleData = { ...sched(), ledgerFrom: '2026-11' };
    for (const day of ['2026-11-02', '2026-11-03']) d = setShkCount(paintCell(d, 'o', day, 'full'), 'o', day, 100);
    d = addPayment(d, { staffId: 'o', date: '2026-11-10', type: 'salary', amount: 1000, method: 'cash', note: '' });
    expect(paidDays(olga, d, '2026-11').state).toEqual({ '2026-11-02': 'paid', '2026-11-03': 'due' });
  });

  it('прошлый месяц: долг перешёл и выплачен в следующем — дни оплачены; до начала учёта — сам по себе', () => {
    let d: ScheduleData = { ...sched(), ledgerFrom: '2026-10' };
    for (const day of ['2026-10-05', '2026-10-06']) d = paintCell(d, 'a', day, 'full');
    d = paintCell(d, 'a', '2026-11-03', 'full');
    expect(paidDays(anna, d, '2026-10').state).toEqual({ '2026-10-05': 'due', '2026-10-06': 'due' });
    const later = pay(d, 5000);
    expect(paidDays(anna, later, '2026-10').state).toEqual({ '2026-10-05': 'paid', '2026-10-06': 'paid' });
    expect(paidDays(anna, later, '2026-11').state).toEqual({ '2026-11-03': 'due' });
    // через закрытый месяц остаток тоже переходит
    const closed = closeMonth(d, [anna], '2026-10');
    expect(paidDays(anna, pay(closed, 2500), '2026-10').state).toEqual({ '2026-10-05': 'paid', '2026-10-06': 'due' });
    // учёт начат с ноября: октябрь считается отдельно, ноябрьская выплата его не закрывает
    const before = pay({ ...d, ledgerFrom: '2026-11' }, 2500);
    expect(paidDays(anna, before, '2026-10').state).toEqual({ '2026-10-05': 'due', '2026-10-06': 'due' });
    expect(paidDays(anna, before, '2026-11').state).toEqual({ '2026-11-03': 'paid' });
    expect(paidDays(anna, d, '2026-12').state).toEqual({});
  });

  it('месяц, закрытый по-старому, оплачен целиком', () => {
    let d = paintCell(sched(), 'a', '2026-09-07', 'full');
    d = { ...d, closed: { '2026-09': { at: 'x', rows: [{ staffId: 'a', name: 'Анна', shifts: 1, earned: 2500, bonus: 0, fines: 0, wb: 0, wbBack: 0, pending: 0, advance: 0, advancePaid: false, total: 2500, toPay: 2500 }] } } };
    expect(paidDays(anna, d, '2026-09').state).toEqual({ '2026-09-07': 'paid' });
  });
});

describe('недели для мастера', () => {
  it('дни выбранных недель в пределах месяца, с отсечкой', () => {
    expect(weeksDays('2026-11', ['2026-10-26'])).toEqual(['2026-11-01']);
    expect(weeksDays('2026-11', ['2026-11-16', '2026-11-30'], '2026-11-20')).toEqual(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-30']);
    expect(weeksDays('2026-11', [])).toEqual([]);
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
