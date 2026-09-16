import { Link, Outlet } from 'react-router-dom';
import s from './AuthShell.module.css';

/**
 * Оболочка авторизации: центрированная карточка без хрома.
 * Раньше форма входа рендерилась внутри админского сайдбара с навигацией
 * «Обзор / Ключи / Настройки», хотя пользователь ещё не вошёл.
 */
export function AuthShell() {
  return (
    <div className={s.shell}>
      <div className={s.top}>
        <Link to="/" className={s.brand} aria-label="ШК ВБ — главная">
          <span className={s.mark} aria-hidden="true">
            ШК
          </span>
          ШК ВБ
        </Link>
      </div>

      <main className={s.main}>
        <div className={s.panel}>
          <Outlet />
        </div>
      </main>

      <div className={s.bottom}>
        <a href="/offer">Оферта</a> · <a href="/privacy">Политика конфиденциальности</a>
      </div>
    </div>
  );
}
