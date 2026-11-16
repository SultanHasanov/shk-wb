import { describe, expect, it } from 'vitest';
import { merge3 } from './merge';

// Первые случаи повторяют тесты программы (src-tauri/src/docs.rs): сайт и ПК должны сливать одинаково.
describe('слияние как в программе', () => {
  it('заметки, добавленные в двух местах, остаются', () => {
    const base = { 42: [{ id: 'a', text: 'старая' }] };
    const local = { 42: [{ id: 'a', text: 'старая' }, { id: 'b', text: 'с сайта' }] };
    const remote = { 42: [{ id: 'a', text: 'старая' }, { id: 'c', text: 'с ПК' }], 7: [{ id: 'd', text: 'новый' }] };
    const out = merge3('schedule', base, local, remote) as Record<string, { id: string }[]>;
    expect(out['42'].map(n => n.id)).toEqual(['a', 'b', 'c']);
    expect(out['7'][0].id).toBe('d');
  });

  it('удаление в одном месте побеждает, только если другое этот элемент не трогало', () => {
    const base = { 42: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] };
    const out = merge3('schedule', base, { 42: [{ id: 'b', text: 'y' }] }, { 42: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y2' }] });
    expect(out).toEqual({ 42: [{ id: 'b', text: 'y2' }] });
  });

  it('первая встреча без базы — объединение', () => {
    const out = merge3('staff', undefined,
      { staff_list: [{ id: 's1', name: 'Аня' }], staff: { 100: { rate: 800 } } },
      { staff_list: [{ id: 's2', name: 'Боря' }], staff: { 200: { rate: 900 } } }) as { staff_list: unknown[]; staff: Record<string, { rate: number }> };
    expect(out.staff_list).toHaveLength(2);
    expect(out.staff['100'].rate).toBe(800);
    expect(out.staff['200'].rate).toBe(900);
  });

  it('пустой список не стирает облако и наоборот', () => {
    const empty = { staff_list: [], staff: {} };
    const full = { staff_list: [{ id: 's1', name: 'Аня' }, { id: 's2', name: 'Боря' }], staff: {} };
    expect(merge3('staff', undefined, empty, full)).toEqual(full);
    expect(merge3('staff', undefined, full, empty)).toEqual(full);
  });

  it('пустые выплаты не стирают заполненные', () => {
    const remote = { shifts: { '2026-11-01': [{ staffId: 's1' }] }, payments: [{ id: 'p1', sum: 500 }], payDay: 31 };
    expect(merge3('schedule', undefined, { shifts: {}, payments: [], payDay: 31 }, remote)).toEqual(remote);
  });

  it('удалить всех в одном месте можно, если другое не трогало', () => {
    const base = { staff_list: [{ id: 's1', name: 'Аня' }] };
    expect(merge3('staff', base, { staff_list: [] }, base)).toEqual({ staff_list: [] });
  });

  it('пустой список из облака не стирает свой (предохранитель)', () => {
    const full = { staff_list: [{ id: 's1' }, { id: 's2' }], staff: {} };
    expect(merge3('staff', full, full, { staff_list: [], staff: {} })).toEqual(full);
  });

  it('одно значение поменяли оба — остаётся вариант этого места', () => {
    const out = merge3('schedule', { advanceRule: { day: 10 } }, { advanceRule: { day: 15 } }, { advanceRule: { day: 20 } }) as { advanceRule: { day: number } };
    expect(out.advanceRule.day).toBe(15);
  });
});

describe('слияние смен по дням (новое правило)', () => {
  it('правки одного дня на сайте и на ПК не теряют друг друга', () => {
    const base = { shifts: { '2026-11-18': [{ staffId: 'a', kind: 'full' }] } };
    const site = { shifts: { '2026-11-18': [{ staffId: 'a', kind: 'full' }, { staffId: 'b', kind: 'half' }] } };
    const pc = { shifts: { '2026-11-18': [{ staffId: 'a', kind: 'custom', from: '10:00', to: '18:00' }] } };
    const out = merge3('schedule', base, site, pc) as typeof site;
    expect(out.shifts['2026-11-18']).toEqual([
      { staffId: 'a', kind: 'custom', from: '10:00', to: '18:00' },
      { staffId: 'b', kind: 'half' },
    ]);
  });

  it('смену убрали на сайте, а на ПК поставили другому — остаётся только новая', () => {
    const base = { shifts: { d: [{ staffId: 'a', kind: 'full' }] } };
    const out = merge3('schedule', base, { shifts: {} }, { shifts: { d: [{ staffId: 'a', kind: 'full' }, { staffId: 'b', kind: 'full' }] } }) as { shifts: Record<string, unknown[]> };
    expect(out.shifts.d).toEqual([{ staffId: 'b', kind: 'full' }]);
  });

  it('ставки с разных дат сливаются', () => {
    const base = { staff_list: [{ id: 's1', rates: [{ from: '2026-01-01', rate: 2000 }] }] };
    const site = { staff_list: [{ id: 's1', rates: [{ from: '2026-01-01', rate: 2000 }, { from: '2026-11-01', rate: 2500 }] }] };
    const pc = { staff_list: [{ id: 's1', rates: [{ from: '2026-01-01', rate: 2100 }] }] };
    const out = merge3('staff', base, site, pc) as typeof site;
    expect(out.staff_list[0].rates).toEqual([{ from: '2026-01-01', rate: 2100 }, { from: '2026-11-01', rate: 2500 }]);
  });

  it('неизвестные поля и старый формат сохраняются', () => {
    const doc = { staff_list: [{ id: 's1', name: 'Аня', future: 1 }], staff: { 123: { rate: 900, shifts: ['2026-01-01'] } }, extra: true };
    expect(merge3('staff', doc, { ...doc, staff_list: [{ id: 's1', name: 'Анна', future: 1 }] }, doc)).toEqual({ ...doc, staff_list: [{ id: 's1', name: 'Анна', future: 1 }] });
  });
});
