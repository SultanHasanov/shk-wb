import { useLocation, useNavigate } from 'react-router-dom';
import { type Locale, isKzPath, localizePath, setLocalePreference, useLocale, useT } from '../i18n';
import s from './CurrencySwitch.module.css';

const OPTIONS: ReadonlyArray<{ value: Locale; label: string; title: string }> = [
  { value: 'ru', label: 'RU', title: 'Русский' },
  { value: 'kk', label: 'KZ', title: 'Қазақша' },
];

/**
 * Переключатель языка. На публичной странице ведёт на тот же адрес на другом
 * языке (/program ↔ /kz/program), в кабинете — просто запоминает выбор.
 */
export function LanguageSwitch({ className = '' }: { className?: string }) {
  const locale = useLocale();
  const t = useT();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();

  const choose = (next: Locale) => {
    setLocalePreference(next);
    const target = localizePath(pathname, next);
    const isPublic = isKzPath(pathname) || target !== pathname;
    if (isPublic && target !== pathname) navigate(target + search + hash);
  };

  return (
    <div className={`${s.switch} ${className}`} role="radiogroup" aria-label={t('Язык сайта', 'Сайт тілі')}>
      {OPTIONS.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          lang={option.value}
          aria-checked={locale === option.value}
          title={option.title}
          className={`${s.option} ${locale === option.value ? s.active : ''}`}
          onClick={() => choose(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
