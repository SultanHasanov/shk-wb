import { Link, Outlet } from 'react-router-dom';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { BrandMark } from '../components/BrandMark';
import { useLocalePath, useT } from '../i18n';
import s from './AuthShell.module.css';

/**
 * Оболочка авторизации: центрированная карточка без хрома.
 * Раньше форма входа рендерилась внутри админского сайдбара с навигацией
 * «Обзор / Ключи / Настройки», хотя пользователь ещё не вошёл.
 */
export function AuthShell() {
  const t = useT();
  const lp = useLocalePath();
  return (
    <div className={s.shell}>
      <div className={s.top}>
        <Link to={lp('/')} className={s.brand} aria-label={t('ШК ВБ — главная', 'ШК ВБ — басты бет')}>
          <BrandMark size={26} />
          ШК ВБ
        </Link>
        <LanguageSwitch />
      </div>

      <main className={s.main}>
        <div className={s.panel}>
          <Outlet />
        </div>
      </main>

      <div className={s.bottom}>
        <a href={lp('/offer')}>{t('Оферта', 'Оферта')}</a> ·{' '}
        <a href={lp('/privacy')}>{t('Политика конфиденциальности', 'Құпиялылық саясаты')}</a>
      </div>
    </div>
  );
}
