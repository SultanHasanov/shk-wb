import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type Match = { sid: string; cells: string[]; name: string; tail: string; why: string[] };
type Cell = { cell: string; sid: string; name: string; tail: string; days: number | null; goods: { title: string; brand: string; size: string; color: string; nm: number | null; shk: string; price: number | null }[] };
const pvzWeb = require('../../server/_pvz-web.js') as {
  _test: {
    cellsView: (goods: unknown[], now?: number) => Cell[];
    eventsView: (goods: unknown[]) => { kind: string; sid: string; cell: string; at: string; employee: string; title: string; price: number | null }[];
    chargeRequestId: (userId: string, sid: string, day: string) => string;
    findMatches: (goods: unknown[], digits: string) => Match[];
    parsePhone: (value: string) => string | null;
    wbView: (connection: unknown) => { state: string; points?: { id: number; name: string }[]; pointId?: number | null };
  };
};
const { cellsView, chargeRequestId, eventsView, findMatches, parsePhone, wbView } = pvzWeb._test;

const NOW = Date.parse('2026-11-21T09:00:00Z');
const goods = [
  { buyer_sid: 38120457, cell: '214', buyer: { mobile: '79000004712', name: 'Анна' }, shk_code: 41200357812, vendor_code: 377869894, info: { name: 'Кроссовки', brand: 'Stride', goods_size: '42', color: 'белый' }, price: 3990, price_with_sale: 3490, status: 'GOODS_READY', status_updated: '2026-11-20T08:00:00Z' },
  { buyer_sid: 38120457, cell: '214', buyer: { mobile: '79000004712', name: 'Анна' }, shk_code: 41200357813, info: { name: '', subject_name: 'Носки', goods_size: '0' }, status: 'GOODS_READY', status_updated: '2026-11-19T08:00:00Z' },
  { buyer_sid: 27455190, cell: '15', buyer: { mobile: '79000003712', name: 'Игорь' }, shk_id: '41200361140', status: 'GOODS_READY' },
  // уже выдан — в ячейках его нет, но поиск по списку его находит (как в боте)
  { buyer_sid: 41977302, cell: '218', buyer: { mobile: '79000000563', name: 'Мария' }, shk_id: '41200344901', status: 'GOODS_RECIEVED', status_updated: '2026-11-18T10:00:00Z', price: 1200, info: { name: 'Плед' }, history: [{ status: 'GOODS_RECIEVED', employee_id: 555 }] },
  { buyer_sid: 41977302, cell: '218', buyer: { mobile: '79000000563' }, shk_id: '41200344902', status: 'GOODS_RETURNED', status_updated: '2026-11-19T10:00:00Z', is_paid: true },
  { buyer_sid: 30561128, cell: '221', buyer: { mobile: '79000008840' }, shk_code: 41200298455, status: 'GOODS_DECLINED', status_updated: '2026-11-21T07:00:00Z', is_paid: false, try_on: true, repackaging_status: 'NeedRepackaged' },
];

describe('веб-версия Помощника: ячейки', () => {
  it('собирает клиента и его товары по ячейке, выданные не показывает', () => {
    const cells = cellsView(goods, NOW);
    expect(cells.map(c => c.cell)).toEqual(['15', '214', '221']);
    // отказ ещё лежит в пункте — он в ячейке, с метками
    expect((cells[2].goods[0] as unknown as { marks: string[] }).marks).toEqual(['declined', 'unpaid', 'tryon', 'repack']);
    expect((cells[1].goods[0] as unknown as { marks: string[] }).marks).toEqual([]);
    const anna = cells[1];
    expect(anna).toMatchObject({ sid: '38120457', name: 'Анна', tail: '47-12', days: 3 });
    expect(anna.goods).toHaveLength(2);
    expect(anna.goods[0]).toMatchObject({ title: 'Кроссовки', brand: 'Stride', size: '42', color: 'белый', nm: 377869894, shk: '41200357812', price: 3490 });
    expect(anna.goods[1]).toMatchObject({ title: 'Носки', size: '', nm: null, shk: '41200357813', price: null });
    expect(cells[0].days).toBeNull();
  });
});

describe('веб-версия Помощника: история', () => {
  it('выданные и возвращённые — события, свежие сверху, с сотрудником', () => {
    const events = eventsView(goods);
    expect(events.map(e => e.kind)).toEqual(['returned', 'received']);
    expect(events[1]).toMatchObject({ sid: '41977302', cell: '218', employee: '555', title: 'Плед', price: 1200, at: '2026-11-18T10:00:00.000Z' });
    expect(events[0].employee).toBe('');
  });
});

describe('веб-версия Помощника: поиск клиента', () => {
  it('ищет по ячейке, хвосту телефона, ШК и ID клиента', () => {
    expect(findMatches(goods, '214')).toMatchObject([{ sid: '38120457', why: ['cell'] }]);
    expect(findMatches(goods, '712').map(m => m.sid).sort()).toEqual(['27455190', '38120457']);
    expect(findMatches(goods, '712')[0].why).toEqual(['phone']);
    expect(findMatches(goods, '41200361140')).toMatchObject([{ sid: '27455190', cells: ['15'], why: ['shk'] }]);
    expect(findMatches(goods, '38120457')).toMatchObject([{ why: ['sid'] }]);
    expect(findMatches(goods, '999')).toEqual([]);
  });

  it('полный номер телефона сводит к последним четырём цифрам', () => {
    expect(findMatches(goods, '79991234712')).toMatchObject([{ sid: '38120457', tail: '47-12' }]);
  });
});

describe('веб-версия Помощника: вход и списание', () => {
  it('принимает только российские номера', () => {
    expect(parsePhone('+7 (999) 123-45-67')).toBe('79991234567');
    expect(parsePhone('89991234567')).toBe('79991234567');
    expect(parsePhone('9991234567')).toBe('79991234567');
    expect(parsePhone('41200357812')).toBeNull();
    expect(parsePhone('')).toBeNull();
  });

  it('один id списания на клиента в сутки', () => {
    const a = chargeRequestId('u1', '38120457', '2026-11-21');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(chargeRequestId('u1', '38120457', '2026-11-21')).toBe(a);
    expect(chargeRequestId('u1', '38120457', '2026-11-22')).not.toBe(a);
    expect(chargeRequestId('u2', '38120457', '2026-11-21')).not.toBe(a);
  });

  it('не отдаёт браузеру токены WB — только состояние и пункты', () => {
    const view = wbView({ state: 'ready', session: { token: 'secret', pointId: 5, points: [{ id: 5, name: 'Пункт', shard: 3 }] } });
    expect(view).toEqual({ state: 'ready', points: [{ id: 5, name: 'Пункт' }], pointId: 5 });
    expect(wbView({ state: 'await_code', session: { phone: '79991234567' } })).toEqual({ state: 'none' });
    expect(wbView(null)).toEqual({ state: 'none' });
  });
});
