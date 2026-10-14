import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney, getCurrency, preferCurrency, setCurrency } from './currency';

const nbsp = (value: string) => value.replace(/\s/g, ' ');

afterEach(() => {
  setCurrency('RUB');
  localStorage.clear();
});

describe('валюта цен', () => {
  it('в рублях форматирует как раньше', () => {
    expect(nbsp(formatMoney(135, 'RUB', 5.5))).toBe('135 ₽');
    expect(formatMoney(0.27, 'RUB', 5.5, true)).toBe('0,27 ₽');
  });

  it('в тенге округляет итог до целого, а цену за штуку — до десятых', () => {
    expect(nbsp(formatMoney(135, 'KZT', 5.5))).toBe('743 ₸');
    // 0,27 ₽ × 5,5 = 1,485 ₸ → 1,5 ₸: иначе все пакеты выглядели бы одинаково по 1 ₸
    expect(formatMoney(0.27, 'KZT', 5.5, true)).toBe('1,5 ₸');
  });

  it('выбор человека важнее валюты по умолчанию', () => {
    setCurrency('RUB');
    preferCurrency('KZT');
    expect(getCurrency()).toBe('RUB');
    localStorage.clear();
    preferCurrency('KZT');
    expect(getCurrency()).toBe('KZT');
  });
});
