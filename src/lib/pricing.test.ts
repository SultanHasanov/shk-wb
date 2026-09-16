import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CELL_PRINT_DEVICES,
  CELL_PRINT_DURATIONS,
  CELL_PRINT_PRICES,
  computerWord,
  formatPerUnit,
  formatTotal,
  getCellPrintPrice,
  getCellPrintSavingPercent,
  getLicensePack,
  getPack,
  iterationWord,
  LICENSE_PRICES,
  MIN_PER_UNIT,
  PACKAGE_PRICES,
} from './pricing';

const payments = () => readFileSync(resolve(process.cwd(), 'server/_payments.js'), 'utf8');

/**
 * Фронтовые таблицы цен — копии серверных (server/_payments.js на CommonJS, импортировать
 * нельзя). Этот спек читает исходник как текст и сверяет числа, чтобы копии не разъехались.
 */
function readFlatTable(name: string): Record<string, number> {
  const match = payments().match(
    new RegExp(`const ${name}\\s*=\\s*Object\\.freeze\\(\\{([^}]*)\\}\\)`),
  );
  if (!match) throw new Error(`${name} не найдены в server/_payments.js`);

  const prices: Record<string, number> = {};
  for (const [, qty, total] of match[1].matchAll(/(\d+)\s*:\s*(\d+)/g)) {
    prices[qty] = Number(total);
  }
  return prices;
}

/** CELL_PRINT_PRICES вложенная, поэтому разбирается в два прохода. */
function readCellPrintTable(): Record<string, Record<string, number>> {
  const match = payments().match(/const CELL_PRINT_PRICES\s*=\s*Object\.freeze\(([\s\S]*?)\);/);
  if (!match) throw new Error('CELL_PRINT_PRICES не найдены в server/_payments.js');

  const table: Record<string, Record<string, number>> = {};
  for (const [, days, body] of match[1].matchAll(/(\d+)\s*:\s*\{([^}]*)\}/g)) {
    const row: Record<string, number> = {};
    for (const [, devices, total] of body.matchAll(/(\d+)\s*:\s*(\d+)/g)) {
      row[devices] = Number(total);
    }
    table[days] = row;
  }
  return table;
}

describe('цены пакетов', () => {
  it('совпадают с server/_payments.js', () => {
    expect(PACKAGE_PRICES).toEqual(readFlatTable('PACKAGE_PRICES'));
  });

  it('считает цену за штуку', () => {
    expect(getPack(500)).toEqual({ quantity: 500, total: 135, perUnit: 135 / 500 });
    expect(formatPerUnit(getPack(500).perUnit)).toBe('0,27 ₽');
    expect(formatPerUnit(getPack(200).perUnit)).toBe('0,32 ₽');
  });

  it('форматирует итоговую сумму', () => {
    expect(formatTotal(135).replace(/ /g, ' ')).toBe('135 ₽');
  });

  it('минимальная цена за штуку соответствует обещанию «от 0,27 ₽» в hero', () => {
    expect(formatPerUnit(MIN_PER_UNIT)).toBe('0,27 ₽');
  });

  it('падает на неизвестном пакете', () => {
    expect(() => getPack(77)).toThrow('Нет пакета на 77 генераций');
  });
});

describe('ключи «Печати ячеек»', () => {
  it('совпадают с server/_payments.js', () => {
    expect(CELL_PRINT_PRICES).toEqual(readCellPrintTable());
  });

  it('на каждый срок из селекта есть цена для каждого количества компьютеров', () => {
    for (const { days } of CELL_PRINT_DURATIONS) {
      for (const devices of CELL_PRINT_DEVICES) {
        expect(getCellPrintPrice(days, devices)).toBeGreaterThan(0);
      }
    }
  });

  it('считает цену тарифа', () => {
    expect(getCellPrintPrice(30, 1)).toBe(150);
    expect(getCellPrintPrice(365, 20)).toBe(10000);
  });

  it('падает на несуществующем тарифе', () => {
    expect(() => getCellPrintPrice(45, 1)).toThrow('Нет тарифа на 45 дней и 1 устройств');
  });

  it('считает экономию на компьютер — обещание «до −50%» на странице', () => {
    expect(getCellPrintSavingPercent(365, 1)).toBe(0);
    expect(getCellPrintSavingPercent(365, 5)).toBe(30);
    expect(getCellPrintSavingPercent(365, 20)).toBe(50);
  });
});

describe('итерации «Подбора кодов»', () => {
  it('совпадают с server/_payments.js', () => {
    expect(LICENSE_PRICES).toEqual(readFlatTable('LICENSE_PRICES'));
  });

  it('сама программа не продаётся: api/payments.js отвергает productKind=program', () => {
    const source = readFileSync(resolve(process.cwd(), 'api/payments.js'), 'utf8');
    expect(source).toContain("Программа скачивается бесплатно");
  });

  it('считает цену итерации', () => {
    expect(getLicensePack(20)).toEqual({ quantity: 20, total: 150, perUnit: 7.5 });
    expect(formatPerUnit(getLicensePack(20).perUnit)).toBe('7,50 ₽');
  });
});

describe('склонения', () => {
  it('склоняет компьютеры', () => {
    expect(computerWord(1)).toBe('компьютер');
    expect(computerWord(2)).toBe('компьютера');
    expect(computerWord(5)).toBe('компьютеров');
    expect(computerWord(11)).toBe('компьютеров');
    expect(computerWord(20)).toBe('компьютеров');
  });

  it('склоняет итерации', () => {
    expect(iterationWord(1)).toBe('итерация');
    expect(iterationWord(3)).toBe('итерации');
    expect(iterationWord(10)).toBe('итераций');
  });
});
