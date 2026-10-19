import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const wallet = require('../../server/_wallet.js') as {
  generationCost: (units: number) => number | null;
  affordableGenerations: (balanceRub: number) => number;
  topupBonus: (rub: number) => number;
  validTopup: (rub: number) => boolean;
  formatRub: (rub: number) => string;
};

describe('баланс в Telegram-боте', () => {
  it('считает генерации по таблице пакетов: не дороже пакета сверху и штучной цены снизу', () => {
    expect(wallet.generationCost(1)).toBe(5);
    expect(wallet.generationCost(7)).toBe(12); // пакет на 20 дешевле, чем 7 × 5 ₽
    expect(wallet.generationCost(20)).toBe(12);
    expect(wallet.generationCost(25)).toBe(15); // 25 × 0,60 ₽ (цена штуки пакета на 20) дешевле пакета на 30
    expect(wallet.generationCost(300)).toBe(94.5); // 300 × 0,315 ₽
    expect(wallet.generationCost(500)).toBe(135);
    expect(wallet.generationCost(0)).toBeNull();
  });

  it('цена не убывает с ростом количества', () => {
    let previous = 0;
    for (let units = 1; units <= 500; units += 1) {
      const cost = wallet.generationCost(units) as number;
      expect(cost).toBeGreaterThanOrEqual(previous);
      previous = cost;
    }
  });

  it('бонус к пополнению и границы суммы', () => {
    expect([100, 499, 500, 999, 1000, 2000].map(wallet.topupBonus)).toEqual([0, 0, 25, 49, 100, 200]);
    expect(wallet.validTopup(24)).toBe(false);
    expect(wallet.validTopup(25)).toBe(true);
    expect(wallet.validTopup(150.5)).toBe(false);
    expect(wallet.validTopup(50001)).toBe(false);
  });

  it('показывает, на сколько стикеров хватит, по лучшей цене', () => {
    expect(wallet.affordableGenerations(135)).toBe(500);
    expect(wallet.affordableGenerations(0)).toBe(0);
    expect(wallet.formatRub(94.5).replace(/\s/g, ' ')).toBe('94,50 ₽');
  });
});
