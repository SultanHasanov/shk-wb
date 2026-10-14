import { Alert } from '../ui';
import { formatTotal } from '../lib/pricing';
import { type Currency, setCurrency, useCurrency, useKztRate } from '../lib/currency';
import { useT } from '../i18n';
import s from './CurrencySwitch.module.css';

const OPTIONS: ReadonlyArray<{ value: Currency; label: string; title: [string, string] }> = [
  { value: 'RUB', label: '₽', title: ['Цены в рублях', 'Бағалар рубльмен'] },
  { value: 'KZT', label: '₸', title: ['Цены в тенге', 'Бағалар теңгемен'] },
];

/** Переключатель валюты цен. Компактный: живёт в и так плотной шапке сайта. */
export function CurrencySwitch({ className = '' }: { className?: string }) {
  const currency = useCurrency();
  const t = useT();
  return (
    <div className={`${s.switch} ${className}`} role="radiogroup" aria-label={t('Валюта цен', 'Баға валютасы')}>
      {OPTIONS.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={currency === option.value}
          title={t(...option.title)}
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
  const t = useT();
  if (currency !== 'KZT' || rub <= 0) return null;
  const kzt = Math.round(rub * rate).toLocaleString('ru-RU');
  return (
    <Alert tone="info">
      {t('Оплата проходит в рублях через ЮKassa: спишется', 'Төлем ЮKassa арқылы рубльмен өтеді: есептен шығарылады')}{' '}
      <strong>{formatTotal(rub)}</strong>{' '}
      {t(`(≈ ${kzt} ₸ по курсу сайта). Точную сумму в тенге посчитает ваш банк.`, `(сайт бағамы бойынша ≈ ${kzt} ₸). Теңгедегі нақты соманы сіздің банкіңіз есептейді.`)}
    </Alert>
  );
}
