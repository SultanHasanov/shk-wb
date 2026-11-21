import { Fragment, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileClock,
  Grid2X2,
  Handshake,
  Home,
  KeyRound,
  MessageSquare,
  MessageSquareText,
  Laptop,
  LogOut,
  Menu,
  Package,
  QrCode,
  Receipt,
  Settings,
  ShieldCheck,
  User,
  Users,
  Bell,
  WalletCards,
} from 'lucide-react';
import { Button } from '../ui';
import { TabBar, type TabItem } from './TabBar';
import { useQueryClient } from '@tanstack/react-query';
import { useStores } from '../stores/root-store';
import s from './CabinetShell.module.css';
import { ApiError, api } from '../api/client';
import { cabinetKey, money, useCabinet } from '../api/cabinet';
import { legacyStickerCodes } from '../lib/legacy-assets';
import { forgetPendingOrder, readPendingOrders } from '../lib/pending-orders';
import { preferCurrency } from '../lib/currency';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { WhatsNew, useWhatsNewState } from '../components/WhatsNew';
import { type T, useLocalePath, useT } from '../i18n';
import { APP_SUBSCRIPTIONS_LIVE } from '../lib/app-release';
import { entriesForAccount, isInSection, markOpened, newSections } from '../lib/whats-new';

type NavItem = { to: string; label: string; Icon: typeof Home; end: boolean };

/** Сайдбар разбит на группы, как в прототипе: без заголовка — главное, дальше программы, оплаты, аккаунт. */
const cabinetNavGroups = (t: T): { title: string | null; items: NavItem[] }[] => [
  {
    title: null,
    items: [
      { to: '/cabinet', label: t('Обзор', 'Шолу'), Icon: Home, end: true },
      // Раньше за генерацией приходилось уходить на публичную главную и возвращаться руками
      { to: '/cabinet/generator', label: t('Генератор', 'Генератор'), Icon: QrCode, end: false },
    ],
  },
  {
    title: t('Программы', 'Бағдарламалар'),
    items: [
      ...(APP_SUBSCRIPTIONS_LIVE ? [
        { to: '/cabinet/subscription', label: t('Подписка', 'Жазылым'), Icon: Laptop, end: false },
        // «Помощник ПВЗ» в браузере: открывается на весь экран, вне этой оболочки (src/pages/pvz-web)
        { to: '/cabinet/pvz-web', label: t('Веб-версия Помощника', 'Көмекшінің веб-нұсқасы'), Icon: Grid2X2, end: false },
        // график и зарплата пунктов — те же документы, что в «Помощнике ПВЗ» (server/_staff.js)
        { to: '/cabinet/staff', label: t('Сотрудники', 'Қызметкерлер'), Icon: CalendarDays, end: false },
        { to: '/cabinet/access', label: t('Доступ сотрудников', 'Қызметкерлер қолжетімділігі'), Icon: ShieldCheck, end: false },
        { to: '/cabinet/pc-messages', label: t('Сообщения на ПК', 'ДК-ға хабарламалар'), Icon: MessageSquare, end: false },
      ] : []),
      // QR для анонимных отзывов клиентов — бесплатно всем, без программы.
      { to: '/cabinet/feedback', label: t('Отзывы клиентов', 'Клиент пікірлері'), Icon: MessageSquareText, end: false },
      { to: '/cabinet/keys', label: t('Ключи и доступы', 'Кілттер мен қолжетімділік'), Icon: KeyRound, end: false },
    ],
  },
  {
    title: t('Оплаты', 'Төлемдер'),
    items: [
      { to: '/cabinet/packages', label: t('Пакеты и код', 'Пакеттер мен код'), Icon: Package, end: false },
      { to: '/cabinet/history', label: t('История генераций', 'Генерациялар тарихы'), Icon: FileClock, end: false },
      { to: '/cabinet/orders', label: t('Заказы', 'Тапсырыстар'), Icon: Receipt, end: false },
      // Раньше маршрут /cabinet/referrals существовал, но отсутствовал в навигации —
      // попасть на него через интерфейс было нельзя.
      { to: '/cabinet/referrals', label: t('Рефералы', 'Рефералдар'), Icon: Users, end: false },
    ],
  },
  {
    title: t('Аккаунт', 'Аккаунт'),
    items: [
      { to: '/cabinet/profile', label: t('Профиль', 'Профиль'), Icon: User, end: false },
      { to: '/cabinet/settings', label: t('Настройки', 'Баптаулар'), Icon: Settings, end: false },
      { to: '/cabinet/notifications', label: t('Уведомления', 'Хабарламалар'), Icon: Bell, end: false },
    ],
  },
];

const titlesFor = (t: T): Record<string, string> => ({
  '/cabinet': t('Кабинет', 'Кабинет'),
  '/cabinet/generator': t('Генератор', 'Генератор'),
  '/cabinet/payment-result': t('Результат оплаты', 'Төлем нәтижесі'),
  '/cabinet/subscription': t('Тарифы «Помощник ПВЗ»', '«ПВЗ көмекшісі» тарифтері'),
  '/cabinet/access': t('Доступ сотрудников', 'Қызметкерлер қолжетімділігі'),
  '/cabinet/pc-messages': t('Сообщения на ПК', 'ДК-ға хабарламалар'),
  '/cabinet/feedback': t('Отзывы клиентов', 'Клиент пікірлері'),
  '/cabinet/staff': t('Сотрудники', 'Қызметкерлер'),
  '/cabinet/keys': t('Ключи и устройства', 'Кілттер мен құрылғылар'),
  '/cabinet/packages': t('Баланс и пакеты', 'Баланс және пакеттер'),
  '/cabinet/history': t('История генераций', 'Генерациялар тарихы'),
  '/cabinet/orders': t('Заказы', 'Тапсырыстар'),
  '/cabinet/referrals': t('Рефералы', 'Рефералдар'),
  '/cabinet/profile': t('Профиль', 'Профиль'),
  '/cabinet/settings': t('Настройки', 'Баптаулар'),
  '/cabinet/notifications': t('Уведомления', 'Хабарламалар'),
  '/cabinet/partner': t('Партнёр', 'Серіктес'),
});

/** Раздел партнёра виден только аккаунтам, которые владелец назначил партнёрами. */
const partnerNavItem = (t: T) => ({ to: '/cabinet/partner', label: t('Партнёр', 'Серіктес'), Icon: Handshake, end: false });

/** Оболочка кабинета: сайдбар уместен здесь, но не на публичных страницах. */
export const CabinetShell = observer(() => {
  const { ui, auth } = useStores();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const cabinet = useCabinet();
  // Партнёр работает с клиентами в тенге — показываем цены в ₸, пока он сам не выберет иначе.
  const isPartner = Boolean(cabinet.data?.partner);
  useEffect(() => {
    if (isPartner) preferCurrency('KZT');
  }, [isPartner]);
  const accountRef = useRef<HTMLDivElement>(null);

  const t = useT();
  const lp = useLocalePath();
  const navGroups = cabinetNavGroups(t);
  if (cabinet.data?.partner) navGroups[0].items.unshift(partnerNavItem(t));
  const titles = titlesFor(t);
  const email = auth.displayName || t('Пользователь', 'Пайдаланушы');

  // «Что нового» (src/lib/whats-new.ts): метка «new» у обновившегося раздела, пока его не открыли.
  // Берём только новости про разделы, которые есть в меню этого аккаунта, и только вышедшие
  // после регистрации: новому человеку старые новости не нужны.
  const userId = auth.user?.id ?? null;
  const userCreatedAt = auth.user?.created_at ?? null;
  const navEnd = new Map(navGroups.flatMap(group => group.items.map(item => [item.to, item.end] as const)));
  const newsEntries = entriesForAccount(userCreatedAt).flatMap(entry => {
    const sections = entry.sections.filter(path => navEnd.has(path));
    // Новость про раздел, которого в этом меню нет, не показываем; общая (без разделов) остаётся.
    return entry.sections.length > 0 && sections.length === 0 ? [] : [{ ...entry, sections }];
  });
  const [newsState, updateNews] = useWhatsNewState(userId);
  const freshSections = userId ? newSections(newsState, new Date(), newsEntries) : new Set<string>();
  // Раздел открыт (сам или его вложенная страница) — метка снимается.
  const openedNow = [...freshSections]
    .filter(path => isInSection(location.pathname, path, navEnd.get(path)))
    .sort()
    .join('|');
  useEffect(() => {
    if (!openedNow) return;
    updateNews(state => openedNow.split('|').reduce((acc, path) => markOpened(acc, path), state));
  }, [openedNow, updateNews]);

  // Нижняя навигация кабинета (телефон): частые разделы + «Ещё», открывающее тот
  // же боковой drawer со всем списком. Бейдж уведомлений переезжает на «Ещё».
  const unread = cabinet.data?.unreadNotifications ?? 0;
  const tabPaths = ['/cabinet', '/cabinet/subscription', '/cabinet/packages', '/cabinet/referrals'];
  // Обновился раздел, до которого с телефона можно дойти только через «Ещё», — точка на «Ещё».
  // Счётчик непрочитанных важнее: при нём точка не рисуется (см. TabBar).
  const newsBehindMore = [...freshSections].some(path => !tabPaths.includes(path));
  const cabinetTabs: TabItem[] = [
    { key: 'overview', to: '/cabinet', end: true, label: t('Обзор', 'Шолу'), Icon: Home, dot: freshSections.has('/cabinet') },
    ...(APP_SUBSCRIPTIONS_LIVE
      ? [{ key: 'subscription', to: '/cabinet/subscription', label: t('Подписка', 'Жазылым'), Icon: Laptop, dot: freshSections.has('/cabinet/subscription') }]
      : []),
    { key: 'packages', to: '/cabinet/packages', label: t('Баланс', 'Баланс'), Icon: WalletCards, dot: freshSections.has('/cabinet/packages') },
    { key: 'referrals', to: '/cabinet/referrals', label: t('Рефералы', 'Рефералдар'), Icon: Users, dot: freshSections.has('/cabinet/referrals') },
    {
      key: 'more',
      label: t('Ещё', 'Тағы'),
      Icon: Menu,
      onClick: ui.toggleMobile,
      active: ui.sidebarOpen || !tabPaths.includes(location.pathname),
      badge: unread,
      dot: newsBehindMore,
      ariaLabel:
        unread > 0
          ? t(`Ещё, непрочитанных: ${unread}`, `Тағы, оқылмаған: ${unread}`)
          : newsBehindMore
            ? t('Ещё, есть новое', 'Тағы, жаңалық бар')
            : t('Ещё', 'Тағы'),
    },
  ];

  // Закрывать аккаунт-меню по клику вне и по Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!accountRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!auth.user) return;
    const marker = `cabinet_history_imported_${auth.user.id}`;
    if (localStorage.getItem(marker) === '1') return;
    let entries: unknown[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem('sticker_generation_history_v1') || '[]');
      if (Array.isArray(parsed))
        entries = parsed.slice(0, 100).map((item: Record<string, unknown>) => ({
          id: String(item.id || `local-${String(item.createdAt || Date.now())}`),
          mode: item.mode === 'custom' ? 'custom' : 'range',
          category: item.category === 'box' ? 'box' : 'product',
          prefix: typeof item.prefix === 'string' ? item.prefix : '',
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
          quantity: Number(item.quantity) || 1,
          ...(typeof item.code === 'string' ? { code: item.code } : {}),
          ...(typeof item.batchId === 'string' ? { batchId: item.batchId } : {}),
          ...(Array.isArray(item.stickers)
            ? {
                stickers: item.stickers.map((s: { code?: unknown }) => ({
                  code: String(s.code || ''),
                })),
              }
            : {}),
        }));
    } catch {
      entries = [];
    }
    api<{ imported: number }>('/api/cabinet/history/import', {
      method: 'POST',
      body: JSON.stringify({ entries }),
    })
      .then(() => localStorage.setItem(marker, '1'))
      .catch(() => {});
  }, [auth.user]);

  useEffect(() => {
    if (!auth.user) return;
    const userId = auth.user.id;
    let cancelled = false;
    const pending = legacyStickerCodes(localStorage).filter(code => {
      try {
        return localStorage.getItem(`cabinet_asset_claim_v1_${userId}_${code}`) !== '1';
      } catch {
        return true;
      }
    });
    if (!pending.length) return;
    const markProcessed = (code: string) => {
      try {
        localStorage.setItem(`cabinet_asset_claim_v1_${userId}_${code}`, '1');
      } catch {
        // Claiming remains successful even when this browser cannot persist the marker.
      }
    };

    void Promise.allSettled(
      pending.map(async code => {
        try {
          await api('/api/cabinet/assets/claim', {
            method: 'POST',
            body: JSON.stringify({ kind: 'sticker', value: code }),
          });
          if (!cancelled) markProcessed(code);
          return true;
        } catch (error) {
          if (
            error instanceof ApiError &&
            (error.code === 'ASSET_UNAVAILABLE' ||
              error.code === 'ASSET_OWNED' ||
              error.code === 'ASSET_NOT_FOUND')
          ) {
            if (!cancelled) markProcessed(code);
            return false;
          }
          throw error;
        }
      }),
    ).then(results => {
      if (!cancelled && results.some(result => result.status === 'fulfilled' && result.value)) {
        void queryClient.invalidateQueries({ queryKey: cabinetKey });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [auth.user, queryClient]);

  // Заказы, оплаченные без входа. Забираем их отдельно от кодов: у заказа,
  // страницу результата которого человек не открыл, кода в браузере нет вовсе,
  // а вместе с заказом кабинету достаётся и выданный им код доступа.
  useEffect(() => {
    if (!auth.user) return;
    const pending = readPendingOrders(localStorage);
    if (!pending.length) return;
    let cancelled = false;

    void Promise.allSettled(
      pending.map(async token => {
        try {
          await api('/api/cabinet/assets/claim', {
            method: 'POST',
            body: JSON.stringify({ kind: 'order', value: token }),
          });
          forgetPendingOrder(localStorage, token);
          return true;
        } catch (error) {
          // Чужой или ещё не оплаченный заказ забрать нельзя. Первый случай
          // безнадёжен и токен пора выбросить, второй — повторим при следующем
          // заходе, когда ЮKassa подтвердит оплату.
          if (error instanceof ApiError && error.code === 'ASSET_OWNED') {
            forgetPendingOrder(localStorage, token);
          }
          return false;
        }
      }),
    ).then(results => {
      if (!cancelled && results.some(result => result.status === 'fulfilled' && result.value)) {
        void queryClient.invalidateQueries({ queryKey: cabinetKey });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [auth.user, queryClient]);

  return (
    <div
      className={`${s.shell} ${ui.sidebarCollapsed ? s.collapsed : ''} ${ui.sidebarOpen ? s.open : ''} ${location.pathname === '/cabinet' ? s.overviewRoute : ''}`}
    >
      {/* Ссылка была только в PublicShell — клавиатурный пользователь кабинета
          каждый раз проходил весь сайдбар, чтобы добраться до содержимого. */}
      <a className="skip-link" href="#content">
        {t('Перейти к содержимому', 'Мазмұнға өту')}
      </a>

      <button className={s.scrim} onClick={ui.closeMobile} aria-label={t('Закрыть меню', 'Мәзірді жабу')} />

      <aside className={s.sidebar}>
        <NavLink to="/cabinet" className={s.brand}>
          <span className={s.mark} aria-hidden="true">
            ШК
          </span>
          <span className={s.label}>ШК ВБ</span>
        </NavLink>

        <nav className={s.group} aria-label={t('Навигация кабинета', 'Кабинет навигациясы')}>
          {navGroups.map(group => (
            <Fragment key={group.title ?? 'main'}>
          {group.title && <div className={s.groupTitle}>{group.title}</div>}
          {group.items.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={ui.closeMobile}
              className={({ isActive }) => `${s.nav} ${isActive ? s.active : ''}`}
            >
              <span className={s.navIcon}>
                <Icon size={20} />
                {to === '/cabinet/notifications' && Boolean(cabinet.data?.unreadNotifications) && (
                  <span
                    className={s.notificationBadge}
                    aria-label={t(`Непрочитанных уведомлений: ${cabinet.data?.unreadNotifications}`, `Оқылмаған хабарламалар: ${cabinet.data?.unreadNotifications}`)}
                  >
                    {(cabinet.data?.unreadNotifications ?? 0) > 99
                      ? '99+'
                      : cabinet.data?.unreadNotifications}
                  </span>
                )}
                {to === '/cabinet/feedback' && Boolean(cabinet.data?.feedbackUnread) && (
                  <span
                    className={s.notificationBadge}
                    aria-label={t(`Новых отзывов: ${cabinet.data?.feedbackUnread}`, `Жаңа пікірлер: ${cabinet.data?.feedbackUnread}`)}
                  >
                    {(cabinet.data?.feedbackUnread ?? 0) > 99 ? '99+' : cabinet.data?.feedbackUnread}
                  </span>
                )}
              </span>
              <span className={s.label}>{label}</span>
              {freshSections.has(to) && (
                <span className={s.newPill} title={t('В разделе есть новое', 'Бөлімде жаңалық бар')}>
                  new
                </span>
              )}
            </NavLink>
          ))}
            </Fragment>
          ))}
        </nav>

        <div className={s.bottom}>
          <NavLink to={lp('/')} className={s.nav} onClick={ui.closeMobile}>
            <Grid2X2 size={20} />
            <span className={s.label}>{t('На сайт', 'Сайтқа')}</span>
          </NavLink>
          <button className={s.collapse} onClick={ui.toggleCollapsed} aria-label={t('Свернуть меню', 'Мәзірді жию')}>
            {ui.sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>
      </aside>

      <div className={s.content}>
        <header className={s.topbar}>
          <Button
            variant="ghost"
            className={`mobile-only ${s.mobileMenuButton}`}
            onClick={ui.toggleMobile}
            aria-label={t('Открыть меню', 'Мәзірді ашу')}
          >
            <Menu size={21} />
          </Button>
          <span className={s.title}>{titles[location.pathname] ?? t('Кабинет', 'Кабинет')}</span>

          <div className={s.topActions}>
            {cabinet.data?.wallet && (
              <NavLink to="/cabinet/packages" className={s.balanceChip}>
                {t('Баланс', 'Баланс')} <b>{money(cabinet.data.wallet.balanceKopecks)}</b>
                <span className={s.balanceTopup}>{t('Пополнить', 'Толықтыру')}</span>
              </NavLink>
            )}
            <span className={s.language}><LanguageSwitch /></span>
            <div className={s.account} ref={accountRef}>
              <button
                type="button"
                className={s.accountTrigger}
                onClick={() => setMenuOpen(v => !v)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                <span className={s.avatar} aria-hidden="true">
                  {email.slice(0, 1)}
                </span>
                <span className={s.accountEmail}>{email}</span>
                <ChevronDown size={15} />
              </button>

              {menuOpen && (
                <div className={s.menu} role="menu">
                  <div className={s.menuHead}>{email}</div>
                  <button
                    type="button"
                    role="menuitem"
                    className={s.menuItem}
                    onClick={() => {
                      setMenuOpen(false);
                      navigate('/cabinet/settings');
                    }}
                  >
                    <Settings size={16} />
                    {t('Настройки', 'Баптаулар')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={`${s.menuItem} ${s.menuDanger}`}
                    onClick={async () => {
                      setMenuOpen(false);
                      try {
                        await auth.signOut();
                        navigate(lp('/'));
                      } catch {
                        navigate(lp('/'));
                      }
                    }}
                  >
                    <LogOut size={16} />
                    {t('Выйти', 'Шығу')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main id="content">
          {cabinet.isError && (
            <div className={s.loadError} role="alert">
              <span>{t('Не удалось загрузить данные кабинета. Повторите попытку.', 'Кабинет деректерін жүктеу мүмкін болмады. Қайталап көріңіз.')}</span>
              <Button variant="ghost" disabled={cabinet.isFetching} onClick={() => void cabinet.refetch()}>
                {t('Повторить', 'Қайталау')}
              </Button>
            </div>
          )}
          <Outlet />
        </main>
      </div>

      <TabBar items={cabinetTabs} label={t('Навигация кабинета', 'Кабинет навигациясы')} />

      {/* Окно «Что нового» — один раз, когда кабинет загрузился. На странице результата оплаты
          не показываем: человек ждёт итог платежа, новость дождётся следующего экрана. */}
      {auth.user && cabinet.data && location.pathname !== '/cabinet/payment-result' && (
        <WhatsNew userId={auth.user.id} createdAt={userCreatedAt} entries={newsEntries} />
      )}
    </div>
  );
});
