import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { Button } from '../ui';
import { AnnouncementBanner } from '../components/AnnouncementBanner';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { CookieBanner } from '../components/CookieBanner';
import { CurrencySwitch } from '../components/CurrencySwitch';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { isKzPath, localizePath, type T, useLocalePath, useStoredLocale, useT } from '../i18n';
import { isPrerender } from '../lib/prerender';
import { TelegramIcon } from '../components/TelegramIcon';
import { useStores } from '../stores/root-store';
import { useVisitCounter } from '../lib/visits';
import { BOT_URL, CHANNEL_URL } from '../lib/telegram';
import s from './PublicShell.module.css';

const navItems = (t: T) => [
  { to: '/', label: t('Генератор', 'Генератор'), end: true },
  { to: '/cell-print', label: t('Печать ячеек', 'Ұяшық басып шығару'), end: false },
  { to: '/program', label: t('Помощник ПВЗ', 'ПВЗ көмекшісі'), end: false },
  { to: '/contacts', label: t('Контакты', 'Байланыс'), end: false },
];

/** В шапке уже четыре пункта, поэтому контентный лендинг живёт только в футере. */
const footerTools = (t: T) => [
  ...navItems(t),
  { to: '/vozvratnye-stikery-wb', label: t('Возвратные стикеры ВБ', 'WB қайтару стикерлері'), end: false },
  { to: '/qr-korobov-wb', label: t('QR коробов WB', 'WB қорап QR-кодтары'), end: false },
];

const footerDocs = (t: T) => [
  { to: '/offer', label: t('Публичная оферта', 'Жария оферта') },
  { to: '/privacy', label: t('Политика конфиденциальности', 'Құпиялылық саясаты') },
  { to: '/cookie', label: t('Использование cookie', 'Cookie пайдалану') },
];

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
  const navigate = useNavigate();
  const t = useT();
  const lp = useLocalePath();
  const storedLocale = useStoredLocale();
  const nav = navItems(t);

  // Только публичная часть: заходы админа в панель посещаемостью сайта не были
  // и в старой статике — js/visits.js на admin-enigma не подключался.
  useVisitCounter();

  // Закрывать мобильное меню при переходе
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Кто выбрал казахский, с русского адреса попадает на казахский. Робот без
  // localStorage остаётся на русской версии, поэтому индексу это не мешает.
  useEffect(() => {
    if (isPrerender() || storedLocale !== 'kk' || isKzPath(location.pathname)) return;
    navigate(localizePath(location.pathname, 'kk') + location.search + location.hash, { replace: true });
  }, [storedLocale, location.pathname, location.search, location.hash, navigate]);

  return (
    <div className={s.shell}>
      <a className="skip-link" href="#content">
        {t('Перейти к содержимому', 'Мазмұнға өту')}
      </a>

      {/* Объявления публикуются в панели управления и раньше доходили только до
          десктопной программы: полоса из старого index.html не пережила переезд. */}
      <AnnouncementBanner />

      <header className={s.header}>
        <div className={s.headerInner}>
          <Link to={lp('/')} className={s.brand} aria-label={t('ШК ВБ — главная', 'ШК ВБ — басты бет')}>
            <span className={s.mark} aria-hidden="true">
              ШК
            </span>
            ШК ВБ
          </Link>

          <nav
            className={`${s.nav} ${menuOpen ? s.navOpen : ''}`}
            aria-label={t('Основная навигация', 'Негізгі навигация')}
            id="site-nav"
          >
            {nav.map(item => (
              <NavLink
                key={item.to}
                to={lp(item.to)}
                end={item.end}
                className={({ isActive }) => `${s.navLink} ${isActive ? s.navActive : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
            {/* На телефоне в шапке нет места — валюта переезжает в выпадающее меню. */}
            <div className={s.mobileOnly}>
              <span className={s.switchLabel}>{t('Язык и валюта', 'Тіл және валюта')}</span>
              <span className={s.switches}>
                <LanguageSwitch />
                <CurrencySwitch />
              </span>
            </div>
          </nav>

          <div className={s.actions}>
            <LanguageSwitch className={s.wideOnly} />
            <CurrencySwitch className={s.wideOnly} />
            {/* Шапка уже плотная: четыре пункта навигации, канал, вход и бургер.
                Поэтому пилюля бота показывается только на широком экране — на
                мобильном он доступен из блока у генератора и из футера. */}
            <a
              className={`${s.tg} ${s.tgWide}`}
              href={BOT_URL}
              target="_blank"
              rel="noopener noreferrer"
              title={t('Бот генерации ШК в Telegram', 'Telegram-дағы ШК генерациялау боты')}
            >
              <TelegramIcon className={s.tgIco} />
              <span>{t('Бот', 'Бот')}</span>
            </a>
            <a className={s.tg} href={CHANNEL_URL} target="_blank" rel="noopener noreferrer">
              <img
                className={s.tgAva}
                src="/images/telegram-wb-tools-avatar-112.webp"
                alt={t('Аватар канала WB Tools', 'WB Tools арнасының аватары')}
                width={26}
                height={26}
                loading="lazy"
              />
              <TelegramIcon className={s.tgIco} />
              <span>{t('Telegram-канал', 'Telegram-арна')}</span>
            </a>
            {/* Раньше кнопка всегда вела на /login: шапка не читала сессию,
                поэтому после входа на публичных страницах висело «Войти».
                Пока сессия проверяется, кнопку не рисуем — иначе «Войти»
                мигает перед «Кабинетом» на каждой загрузке. */}
            {auth.status !== 'initializing' && (
              <Link to={auth.isAuthenticated ? '/cabinet' : '/login'}>
                <Button variant="secondary" size="sm">
                  {auth.isAuthenticated ? t('Кабинет', 'Кабинет') : t('Войти', 'Кіру')}
                </Button>
              </Link>
            )}
            <button
              type="button"
              className={s.burger}
              onClick={() => setMenuOpen(v => !v)}
              aria-label={menuOpen ? t('Закрыть меню', 'Мәзірді жабу') : t('Открыть меню', 'Мәзірді ашу')}
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
              {t(
                'Инструменты для пунктов выдачи Wildberries: генератор возвратных ШК и стикеров, автоматическая печать номера ячейки, программа «Помощник ПВЗ».',
                'Wildberries беру пункттеріне арналған құралдар: қайтару ШК мен стикерлерінің генераторы, ұяшық нөмірін автоматты басып шығару, «ПВЗ көмекшісі» бағдарламасы.',
              )}
            </p>
          </div>

          <div>
            <div className={s.footerTitle}>{t('Инструменты', 'Құралдар')}</div>
            <div className={s.footerCol}>
              {footerTools(t).map(item => (
                <Link key={item.to} to={lp(item.to)}>
                  {item.label}
                </Link>
              ))}
              {/* Внешняя ссылка отдельно от списка: footerTools типизирован под
                  роутерные пути и рендерится через <Link>. */}
              <a href={BOT_URL} target="_blank" rel="noopener noreferrer">
                {t('Бот генерации в Telegram', 'Telegram-дағы генерация боты')}
              </a>
            </div>
          </div>

          <div>
            <div className={s.footerTitle}>{t('Документы', 'Құжаттар')}</div>
            <div className={s.footerCol}>
              {/* Раньше это были <a> на статические .html вне роутера */}
              {footerDocs(t).map(item => (
                <Link key={item.to} to={lp(item.to)}>
                  {item.label}
                </Link>
              ))}
              <a href={CHANNEL_URL} target="_blank" rel="noopener noreferrer">
                {t('Telegram-канал', 'Telegram-арна')}
              </a>
            </div>
          </div>
        </div>

        <div className={s.footerBottom}>
          <span>© {new Date().getFullYear()} ШК ВБ</span>
          <span>
            {t(
              'Сервис не связан с ООО «Вайлдберриз» и не является его официальным продуктом.',
              'Сервис «Вайлдберриз» ЖШҚ-мен байланысты емес және оның ресми өнімі болып табылмайды.',
            )}
          </span>
        </div>
      </footer>

      {/* В старом проекте плашку показывал js/cookie-notice.js; при переезде на
          React она потерялась вместе со страницей политики cookie. */}
      <CookieBanner />
    </div>
  );
});
