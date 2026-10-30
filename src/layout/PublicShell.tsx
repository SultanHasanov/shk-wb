import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AppWindow, Home, LogIn, MoreHorizontal, Printer, QrCode, Tag, User, X } from 'lucide-react';
import { Button } from '../ui';
import { TabBar, type TabItem } from './TabBar';
import { AnnouncementBanner } from '../components/AnnouncementBanner';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { CookieBanner } from '../components/CookieBanner';
import { CurrencySwitch } from '../components/CurrencySwitch';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { isKzPath, localizePath, type T, useLocalePath, useStoredLocale, useT } from '../i18n';
import { isPrerender } from '../lib/prerender';
import { TelegramIcon } from '../components/TelegramIcon';
import { BrandMark } from '../components/BrandMark';
import { useStores } from '../stores/root-store';
import { useVisitCounter } from '../lib/visits';
import { BOT_URL, CHANNEL_URL } from '../lib/telegram';
import s from './PublicShell.module.css';

/** Основная навигация: одни и те же разделы в шапке (десктоп) и в таббаре (мобайл). */
const primaryNav = (t: T) => [
  { to: '/', label: t('Генератор', 'Генератор'), short: t('Генератор', 'Генератор'), end: true, Icon: QrCode },
  { to: '/program', label: t('Помощник ПВЗ', 'ПВЗ көмекшісі'), short: t('Помощник', 'Көмекші'), end: false, Icon: AppWindow },
  { to: '/cell-print', label: t('Печать ячеек', 'Ұяшық басып шығару'), short: t('Печать', 'Басып шығ.'), end: false, Icon: Printer },
  { to: '/tarify', label: t('Тарифы', 'Тарифтер'), short: t('Тарифы', 'Тарифтер'), end: false, Icon: Tag },
];

/** Дополнительные ссылки — в футере и в мобильной шторке «Ещё». */
const moreLinks = (t: T) => [
  { to: '/contacts', label: t('Контакты', 'Байланыс') },
  { to: '/vozvratnye-stikery-wb', label: t('Возвратные стикеры ВБ', 'WB қайтару стикерлері') },
  { to: '/qr-korobov-wb', label: t('QR коробов WB', 'WB қорап QR-кодтары') },
];

const footerDocs = (t: T) => [
  { to: '/offer', label: t('Публичная оферта', 'Жария оферта') },
  { to: '/privacy', label: t('Политика конфиденциальности', 'Құпиялылық саясаты') },
  { to: '/cookie', label: t('Использование cookie', 'Cookie пайдалану') },
];

/**
 * Оболочка публичной части: липкая шапка и тёмный футер на десктопе, нижняя
 * навигация (таббар) и шторка «Ещё» на телефоне. Раньше лендинг и генератор
 * рендерились внутри админского сайдбара — публичное лицо сайта выглядело как
 * внутренний инструмент.
 */
export const PublicShell = observer(() => {
  const { auth } = useStores();
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const lp = useLocalePath();
  const storedLocale = useStoredLocale();
  const nav = primaryNav(t);

  // Только публичная часть: заходы админа в панель посещаемостью сайта не были
  // и в старой статике — js/visits.js на admin-enigma не подключался.
  useVisitCounter();

  // Закрывать шторку «Ещё» при переходе
  useEffect(() => setMoreOpen(false), [location.pathname]);

  // Шторка «Ещё» блокирует фон — иначе прокрутка уходит в страницу под ней.
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  // Кто выбрал казахский, с русского адреса попадает на казахский. Робот без
  // localStorage остаётся на русской версии, поэтому индексу это не мешает.
  useEffect(() => {
    if (isPrerender() || storedLocale !== 'kk' || isKzPath(location.pathname)) return;
    navigate(localizePath(location.pathname, 'kk') + location.search + location.hash, { replace: true });
  }, [storedLocale, location.pathname, location.search, location.hash, navigate]);

  // Нижняя навигация строго по прототипу: четыре раздела + «Ещё». Аккаунт — не
  // вкладка, а иконка в шапке (ниже), поэтому здесь его нет. Первая вкладка на
  // телефоне называется «Главная» с иконкой дома (в десктоп-шапке это «Генератор»).
  const tabs: TabItem[] = [
    { key: '/', to: lp('/'), end: true, label: t('Главная', 'Басты бет'), Icon: Home },
    { key: '/program', to: lp('/program'), label: t('Помощник', 'Көмекші'), Icon: AppWindow },
    { key: '/cell-print', to: lp('/cell-print'), label: t('Печать', 'Басып шығ.'), Icon: Printer },
    { key: '/tarify', to: lp('/tarify'), label: t('Тарифы', 'Тарифтер'), Icon: Tag },
    {
      key: 'more',
      label: t('Ещё', 'Тағы'),
      Icon: MoreHorizontal,
      onClick: () => setMoreOpen(true),
      active: moreOpen,
    },
  ];

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
            <BrandMark />
            ШК ВБ
          </Link>

          <nav className={s.nav} aria-label={t('Основная навигация', 'Негізгі навигация')}>
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
            <Link to={`${lp('/')}#faq`} className={s.navLink}>
              {t('Вопросы', 'Сұрақтар')}
            </Link>
          </nav>

          {/* Язык, валюта, бот и канал переехали в футер и в шторку «Ещё»:
              в утверждённом прототипе шапка — только навигация и вход. */}
          <div className={s.actions}>
            <span className={`${s.wbchip} ${s.wideOnly}`}>
              <span className={s.wbdot} aria-hidden="true" />
              {t('Работает с Wildberries', 'Wildberries-пен жұмыс істейді')}
            </span>
            {/* Раньше кнопка всегда вела на /login: шапка не читала сессию,
                поэтому после входа на публичных страницах висело «Войти».
                Пока сессия проверяется, кнопку не рисуем — иначе «Войти»
                мигает перед «Кабинетом» на каждой загрузке. */}
            {auth.status !== 'initializing' && (
              <Link to={auth.isAuthenticated ? '/cabinet' : '/login'} className={s.wideOnly}>
                <Button variant="secondary" size="sm">
                  {auth.isAuthenticated ? t('Кабинет', 'Кабинет') : t('Войти', 'Кіру')}
                </Button>
              </Link>
            )}

            {/* Телефон (по прототипу): компактный индикатор WB и иконка аккаунта.
                «Ещё» на мобайле — это вкладка таббара, а не кнопка в шапке. */}
            <span className={`${s.wbMini} ${s.mobileOnly}`} aria-hidden="true">
              <span className={s.wbdot} />
              WB
            </span>
            {auth.status !== 'initializing' && (
              <Link
                to={auth.isAuthenticated ? '/cabinet' : '/login'}
                className={`${s.acctBtn} ${s.mobileOnly}`}
                aria-label={auth.isAuthenticated ? t('Личный кабинет', 'Жеке кабинет') : t('Войти в аккаунт', 'Аккаунтқа кіру')}
              >
                {auth.isAuthenticated ? <User size={20} /> : <LogIn size={20} />}
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className={s.main} id="content">
        <Breadcrumbs />
        <Outlet />
      </main>

      <footer className={s.footer}>
        <div className={s.footerInner}>
          <div className={s.footGrid}>
            <div>
              <div className={s.footBrand}>
                <BrandMark size={26} />
                ШК ВБ
              </div>
              <p className={s.footAbout}>
                {t(
                  'Генератор возвратных кодов и две программы для пунктов выдачи Wildberries — под одним аккаунтом.',
                  'Қайтару кодтарының генераторы және Wildberries беру пункттеріне арналған екі бағдарлама — бір аккаунтта.',
                )}
              </p>
            </div>

            <div>
              <h4 className={s.footTitle}>{t('Инструменты', 'Құралдар')}</h4>
              <Link to={lp('/')}>{t('Генератор кодов', 'Кодтар генераторы')}</Link>
              {nav.slice(1).map(item => (
                <Link key={item.to} to={lp(item.to)}>
                  {item.label}
                </Link>
              ))}
              {moreLinks(t)
                .filter(item => item.to !== '/contacts')
                .map(item => (
                  <Link key={item.to} to={lp(item.to)}>
                    {item.label}
                  </Link>
                ))}
              {/* Внешняя ссылка отдельно: списки выше типизированы под роутерные пути. */}
              <a href={BOT_URL} target="_blank" rel="noopener noreferrer">
                {t('Телеграм-бот', 'Телеграм-бот')}
              </a>
            </div>

            <div>
              <h4 className={s.footTitle}>{t('Документы', 'Құжаттар')}</h4>
              {footerDocs(t).map(item => (
                <Link key={item.to} to={lp(item.to)}>
                  {item.label}
                </Link>
              ))}
              <Link to={lp('/contacts')}>{t('Контакты', 'Байланыс')}</Link>
              <a href={CHANNEL_URL} target="_blank" rel="noopener noreferrer">
                {t('Telegram-канал', 'Telegram-арна')}
              </a>
            </div>
          </div>

          <p className={s.disc}>
            {t(
              'Доступ к программам разрешён лицам старше 18 лет. Сервис не связан с ООО «Вайлдберриз» и является независимым инструментом для операторов пунктов выдачи. Названия и товарные знаки принадлежат их правообладателям.',
              'Бағдарламаларға 18 жастан асқан тұлғаларға рұқсат етіледі. Сервис «Вайлдберриз» ЖШҚ-мен байланысты емес және беру пункттерінің операторларына арналған тәуелсіз құрал болып табылады. Атаулар мен тауар белгілері олардың құқық иелеріне тиесілі.',
            )}
          </p>

          <div className={s.footBottom}>
            <span>© {new Date().getFullYear()} ШК ВБ</span>
            <span className={s.switches}>
              <LanguageSwitch />
              <CurrencySwitch />
            </span>
          </div>
        </div>
      </footer>

      {/* Нижняя навигация и шторка «Ещё» — только на телефоне (CSS). */}
      <TabBar items={tabs} label={t('Основная навигация', 'Негізгі навигация')} />

      {moreOpen && (
        <div className={s.sheetRoot} role="dialog" aria-modal="true" aria-label={t('Ещё', 'Тағы')}>
          <button type="button" className={s.sheetScrim} aria-label={t('Закрыть', 'Жабу')} onClick={() => setMoreOpen(false)} />
          <div className={s.sheet}>
            <div className={s.sheetHead}>
              <span>{t('Ещё', 'Тағы')}</span>
              <button type="button" className={s.sheetClose} onClick={() => setMoreOpen(false)} aria-label={t('Закрыть', 'Жабу')}>
                <X size={20} />
              </button>
            </div>

            <div className={s.sheetLinks}>
              {/* «Вопросы» есть в шапке десктопа, а на телефоне до FAQ было не добраться. */}
              <Link to={`${lp('/')}#faq`} className={s.sheetLink} onClick={() => setMoreOpen(false)}>
                {t('Вопросы', 'Сұрақтар')}
              </Link>
              {moreLinks(t).map(item => (
                <Link key={item.to} to={lp(item.to)} className={s.sheetLink}>
                  {item.label}
                </Link>
              ))}
              <a href={BOT_URL} target="_blank" rel="noopener noreferrer" className={s.sheetLink}>
                <TelegramIcon className={s.tgIco} />
                {t('Бот генерации в Telegram', 'Telegram-дағы генерация боты')}
              </a>
              <a href={CHANNEL_URL} target="_blank" rel="noopener noreferrer" className={s.sheetLink}>
                <TelegramIcon className={s.tgIco} />
                {t('Telegram-канал', 'Telegram-арна')}
              </a>
            </div>

            <div className={s.sheetSwitches}>
              <span className={s.switchLabel}>{t('Язык и валюта', 'Тіл және валюта')}</span>
              <span className={s.switches}>
                <LanguageSwitch />
                <CurrencySwitch />
              </span>
            </div>
          </div>
        </div>
      )}

      {/* В старом проекте плашку показывал js/cookie-notice.js; при переезде на
          React она потерялась вместе со страницей политики cookie. */}
      <CookieBanner />
    </div>
  );
});
