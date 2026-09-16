import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { Button } from '../ui';
import { AnnouncementBanner } from '../components/AnnouncementBanner';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { CookieBanner } from '../components/CookieBanner';
import { TelegramIcon } from '../components/TelegramIcon';
import { useStores } from '../stores/root-store';
import { useVisitCounter } from '../lib/visits';
import { BOT_URL, CHANNEL_URL } from '../lib/telegram';
import s from './PublicShell.module.css';

const nav = [
  { to: '/', label: 'Генератор', end: true },
  { to: '/cell-print', label: 'Печать ячеек', end: false },
  { to: '/program', label: 'Подбор кодов', end: false },
  { to: '/contacts', label: 'Контакты', end: false },
] as const;

/** В шапке уже четыре пункта, поэтому контентный лендинг живёт только в футере. */
const footerTools = [
  ...nav,
  { to: '/vozvratnye-stikery-wb', label: 'Возвратные стикеры ВБ', end: false },
  { to: '/qr-korobov-wb', label: 'QR коробов WB', end: false },
] as const;

const footerDocs = [
  { to: '/offer', label: 'Публичная оферта' },
  { to: '/privacy', label: 'Политика конфиденциальности' },
  { to: '/cookie', label: 'Использование cookie' },
] as const;

/**
 * Оболочка публичной части: горизонтальная шапка и футер, без сайдбара.
 * Раньше лендинг, генератор и cell-print рендерились внутри админского
 * сайдбара на 260px, из-за чего публичное лицо сайта выглядело как
 * внутренний инструмент.
 */
export const PublicShell = observer(() => {
  const { auth } = useStores();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Только публичная часть: заходы админа в панель посещаемостью сайта не были
  // и в старой статике — js/visits.js на admin-enigma не подключался.
  useVisitCounter();

  // Закрывать мобильное меню при переходе
  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className={s.shell}>
      <a className="skip-link" href="#content">
        Перейти к содержимому
      </a>

      {/* Объявления публикуются в панели управления и раньше доходили только до
          десктопной программы: полоса из старого index.html не пережила переезд. */}
      <AnnouncementBanner />

      <header className={s.header}>
        <div className={s.headerInner}>
          <Link to="/" className={s.brand} aria-label="ШК ВБ — главная">
            <span className={s.mark} aria-hidden="true">
              ШК
            </span>
            ШК ВБ
          </Link>

          <nav
            className={`${s.nav} ${menuOpen ? s.navOpen : ''}`}
            aria-label="Основная навигация"
            id="site-nav"
          >
            {nav.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `${s.navLink} ${isActive ? s.navActive : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className={s.actions}>
            {/* Шапка уже плотная: четыре пункта навигации, канал, вход и бургер.
                Поэтому пилюля бота показывается только на широком экране — на
                мобильном он доступен из блока у генератора и из футера. */}
            <a
              className={`${s.tg} ${s.tgWide}`}
              href={BOT_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="Бот генерации ШК в Telegram"
            >
              <TelegramIcon className={s.tgIco} />
              <span>Бот</span>
            </a>
            <a className={s.tg} href={CHANNEL_URL} target="_blank" rel="noopener noreferrer">
              <img
                className={s.tgAva}
                src="/images/telegram-wb-tools-avatar.png"
                alt="Аватар канала WB Tools"
                width={26}
                height={26}
                loading="lazy"
              />
              <TelegramIcon className={s.tgIco} />
              <span>Telegram-канал</span>
            </a>
            {/* Раньше кнопка всегда вела на /login: шапка не читала сессию,
                поэтому после входа на публичных страницах висело «Войти».
                Пока сессия проверяется, кнопку не рисуем — иначе «Войти»
                мигает перед «Кабинетом» на каждой загрузке. */}
            {auth.status !== 'initializing' && (
              <Link to={auth.isAuthenticated ? '/cabinet' : '/login'}>
                <Button variant="secondary" size="sm">
                  {auth.isAuthenticated ? 'Кабинет' : 'Войти'}
                </Button>
              </Link>
            )}
            <button
              type="button"
              className={s.burger}
              onClick={() => setMenuOpen(v => !v)}
              aria-label={menuOpen ? 'Закрыть меню' : 'Открыть меню'}
              aria-expanded={menuOpen}
              aria-controls="site-nav"
            >
              {menuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
      </header>

      <main className={s.main} id="content">
        <Breadcrumbs />
        <Outlet />
      </main>

      <footer className={s.footer}>
        <div className={s.footerInner}>
          <div className={s.footerAbout}>
            <div className={s.brand}>
              <span className={s.mark} aria-hidden="true">
                ШК
              </span>
              ШК ВБ
            </div>
            <p>
              Инструменты для пунктов выдачи Wildberries: генератор возвратных ШК и стикеров,
              автоматическая печать номера ячейки, подбор кодов.
            </p>
          </div>

          <div>
            <div className={s.footerTitle}>Инструменты</div>
            <div className={s.footerCol}>
              {footerTools.map(item => (
                <Link key={item.to} to={item.to}>
                  {item.label}
                </Link>
              ))}
              {/* Внешняя ссылка отдельно от списка: footerTools типизирован под
                  роутерные пути и рендерится через <Link>. */}
              <a href={BOT_URL} target="_blank" rel="noopener noreferrer">
                Бот генерации в Telegram
              </a>
            </div>
          </div>

          <div>
            <div className={s.footerTitle}>Документы</div>
            <div className={s.footerCol}>
              {/* Раньше это были <a> на статические .html вне роутера */}
              {footerDocs.map(item => (
                <Link key={item.to} to={item.to}>
                  {item.label}
                </Link>
              ))}
              <a href={CHANNEL_URL} target="_blank" rel="noopener noreferrer">
                Telegram-канал
              </a>
            </div>
          </div>
        </div>

        <div className={s.footerBottom}>
          <span>© {new Date().getFullYear()} ШК ВБ</span>
          <span>Сервис не связан с ООО «Вайлдберриз» и не является его официальным продуктом.</span>
        </div>
      </footer>

      {/* В старом проекте плашку показывал js/cookie-notice.js; при переезде на
          React она потерялась вместе со страницей политики cookie. */}
      <CookieBanner />
    </div>
  );
});
