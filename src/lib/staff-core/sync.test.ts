import { describe, expect, it } from 'vitest';
// @ts-expect-error — скрипт на чистом JS, типов у него нет
import { diffMirror } from '../../../scripts/sync-staff-core.mjs';

describe('копии «Сотрудников» в программе', () => {
  it('совпадают с сайтом (если программа лежит рядом)', () => {
    const bad: string[] | null = diffMirror();
    // программы рядом нет (CI, чужой компьютер) — сверять нечего
    if (bad === null) return;
    expect(bad, 'выполните: node scripts/sync-staff-core.mjs --write').toEqual([]);
  });
});
