import { Alert } from '../ui';
import { formatTotal } from '../lib/pricing';
import { type Currency, setCurrency, useCurrency, useKztRate } from '../lib/currency';
import s from './CurrencySwitch.module.css';

const OPTIONS: ReadonlyArray<{ value: Currency; label: string; title: string }> = [
  { value: 'RUB', label: '₽', title: 'Цены в рублях' },
  { value: 'KZT', label: '₸', title: 'Цены в тенге' },
];

/** Переключатель валюты цен. Компактный: живёт в и так плотной шапке сайта. */
export function CurrencySwitch({ className = '' }: { className?: string }) {
  const currency = useCurrency();
  return (
    <div className={`${s.switch} ${className}`} role="radiogroup" aria-label="Валюта цен">
      {OPTIONS.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={currency === option.value}
          title={option.title}
          className={`${s.option} ${currency === option.value ? s.active : ''}`}
          onClick={() => setCurrency(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * При выбранных тенге честно говорим, сколько спишется: ЮKassa принимает
 * только рубли, а итог в тенге посчитает банк покупателя по своему курсу.
 */
export function RubChargeNote({ rub }: { rub: number }) {
  const currency = useCurrency();
  const rate = useKztRate();
  if (currency !== 'KZT' || rub <= 0) return null;
  return (
    <Alert tone="info">
      Оплата проходит в рублях через ЮKassa: спишется <strong>{formatTotal(rub)}</strong>
      {' '}(≈ {Math.round(rub * rate).toLocaleString('ru-RU')} ₸ по курсу сайта). Точную сумму в тенге посчитает ваш банк.
    </Alert>
  );
}
