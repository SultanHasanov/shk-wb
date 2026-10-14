import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { formatPerUnit as rubPerUnit, formatTotal as rubTotal } from './pricing';

/**
 * Валюта показа цен: ₽ или ₸.
 *
 * Только показ. ЮKassa списывает рубли, серверные цены в рублях, поэтому в ₸
 * перед оплатой отдельно пишем рублёвую сумму (RubChargeNote). Курс задаёт
 * владелец в админке (site_settings.kzt_per_rub), отдаёт /api/payments/config.
 *
 * Выбор живёт в модуле, а не в MobX-сторе: цены рисуют и не-observer
 * компоненты, а useSyncExternalStore перерисует их все при переключении.
 */

export type Currency = 'RUB' | 'KZT';

const STORAGE_KEY = 'currency';
export const FALLBACK_KZT_PER_RUB = 5.5;

function readStored(): Currency | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'KZT' || value === 'RUB' ? value : null;
  } catch {
    return null;
  }
}

let current: Currency = readStored() ?? 'RUB';
const listeners = new Set<() => void>();

export function getCurrency(): Currency {
  return current;
}

export function setCurrency(next: Currency, remember = true) {
  const changed = next !== current;
  current = next;
  // Запоминаем и без смены: явный выбор ₽ должен перебить ₸ по умолчанию у партнёра.
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Приватный режим: выбор проживёт до перезагрузки.
    }
  }
  if (changed) listeners.forEach(listener => listener());
}

/** Валюта по умолчанию, если человек сам ещё не выбирал (казахская версия, партнёр). */
export function preferCurrency(next: Currency) {
  if (readStored() === null) setCurrency(next, false);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCurrency(): Currency {
  // На пререндере всегда рубли: HTML для поисковиков не зависит от выбора посетителя.
  return useSyncExternalStore(subscribe, getCurrency, () => 'RUB');
}

export function useKztRate(): number {
  const config = useQuery({
    queryKey: ['payments', 'config'],
    queryFn: () => api<{ kztPerRub?: number }>('/api/payments/config'),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const rate = Number(config.data?.kztPerRub);
  return Number.isFinite(rate) && rate > 0 ? rate : FALLBACK_KZT_PER_RUB;
}

const kztTotal = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'KZT', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 });

export function formatMoney(rub: number, currency: Currency, rate: number, perUnit = false): string {
  if (currency === 'RUB') return perUnit ? rubPerUnit(rub) : rubTotal(rub);
  const kzt = rub * rate;
  // За штуку — с одним знаком: 0,27 ₽ × 5,5 = 1,5 ₸, а округление до целого сравняло бы все пакеты.
  return perUnit ? `${(Math.round(kzt * 10) / 10).toFixed(1).replace('.', ',')} ₸` : kztTotal.format(Math.round(kzt));
}

/** Форматтеры цен в выбранной валюте; подменяют formatTotal/formatPerUnit из pricing.ts. */
export function useMoney() {
  const currency = useCurrency();
  const rate = useKztRate();
  return {
    currency,
    rate,
    isKzt: currency === 'KZT',
    formatTotal: (rub: number) => formatMoney(rub, currency, rate),
    formatPerUnit: (rub: number) => formatMoney(rub, currency, rate, true),
  };
}
