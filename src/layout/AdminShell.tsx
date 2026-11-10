import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType, FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronRight, CreditCard, Grid2X2, Handshake, KeyRound, LayoutDashboard, LogOut, Megaphone,
  Menu, Monitor, MoreHorizontal, Package, Printer, ScrollText, Search, Send, Server, Users, Wallet, X,
} from 'lucide-react';
import { useAdminAttention, useAdminLogout, useAdminSystem, useAdminUserCounts } from '../api/admin';
import type { AdminSystem } from '../api/admin';
import { StatusDot } from '../pages/admin/kit';
import { TabBar } from './TabBar';
import type { TabItem } from './TabBar';
import s from './AdminShell.module.css';

type NavItem = {
  to: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
  end?: boolean;
  /** Дополнительные адреса, на которых пункт подсвечен (Пулы: стикеры и коробки). */
  also?: readonly string[];
  badge?: 'users' | 'withdrawals';
  status?: 'system';
};

type NavGroup = { title: string | null; items: readonly NavItem[] };

/** Группы меню — как в макете Main (боковое меню) и M-Menu («Ещё»). */
export const ADMIN_NAV: readonly NavGroup[] = [
  {
    title: null,
    items: [
      { to: '/panel', label: 'Обзор', Icon: LayoutDashboard, end: true },
      { to: '/panel/users', label: 'Пользователи', Icon: Users, badge: 'users' },
    ],
  },
  {
    title: 'Продукты',
    items: [
      { to: '/panel/program', label: 'Помощник ПВЗ', Icon: Monitor },
      { to: '/panel/cell-print', label: 'ПВЗ Принт', Icon: Printer },
      { to: '/panel/access-codes', label: 'Коды генератора', Icon: KeyRound },
      { to: '/panel/sticker-pool', label: 'Пулы номеров', Icon: Package, also: ['/panel/box-pool'] },
    ],
  },
  {
    title: 'Деньги',
    items: [
      { to: '/panel/payments', label: 'Заказы и оплата', Icon: CreditCard },
      { to: '/panel/cabinet', label: 'Выплаты', Icon: Wallet, badge: 'withdrawals' },
      { to: '/panel/partners', label: 'Партнёры', Icon: Handshake },
    ],
  },
  {
    title: 'Связь',
    items: [
      { to: '/panel/announcements', label: 'Объявления', Icon: Megaphone },
      { to: '/panel/broadcasts', label: 'Рассылки', Icon: Send },
    ],
  },
  {
    title: 'Контроль',
    items: [
      { to: '/panel/audit', label: 'Журнал', Icon: ScrollText },
      { to: '/panel/system', label: 'Система', Icon: Server, status: 'system' },
    ],
  },
];

const titles: Record<string, string> = {
  '/panel': 'Обзор',
  '/panel/users': 'Пользователи',
  '/panel/access-codes': 'Коды генератора',
  '/panel/partners': 'Партнёры',
  '/panel/sticker-pool': 'Диапазон номеров стикеров',
  '/panel/box-pool': 'Диапазон номеров коробок',
  '/panel/payments': 'Заказы и оплата',
  '/panel/program': 'Программа «Помощник ПВЗ»',
  '/panel/cell-print': 'ПВЗ Принт',
  '/panel/announcements': 'Объявления',
  '/panel/cabinet': 'Выплаты',
  '/panel/broadcasts': 'Рассылки',
  '/panel/audit': 'Журнал',
  '/panel/system': 'Система',
};

/** Карточка пользователя рисует свою нижнюю панель действий — общую там прячем. */
export const USER_CARD_PATH = /^\/panel\/users\/[^/]+\/?$/;

/** Пункты, что живут в нижней панели телефона; остальное — в «Ещё». */
const TAB_PATHS = ['/panel', '/panel/users', '/panel/audit'];

const counter = new Intl.NumberFormat('ru-RU');

function isActive(item: NavItem, pathname: string): boolean {
  const match = (to: string) => (item.end ? pathname === to || pathname === `${to}/` : pathname === to || pathname.startsWith(`${to}/`));
  return match(item.to) || (item.also ?? []).some(match);
}

/** Сводный статус «Системы» для точки: хуже всего — то и показываем. */
export function systemTone(system: AdminSystem | undefined): { tone: 'ok' | 'warning' | 'error' | 'muted'; label: string } {
  if (!system) return { tone: 'muted', label: 'Нет данных' };
  const statuses = [
    system.bot?.status, system.relay?.status, system.webhook?.status, system.botNode?.status,
    system.disk?.status, system.database?.status, system.backups?.status,
  ].filter(Boolean);
  if (statuses.includes('down')) return { tone: 'error', label: 'Сбой' };
  if (statuses.includes('warning') || system.egress.status === 'warning') return { tone: 'warning', label: 'Внимание' };
  return { tone: 'ok', label: 'Работает' };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

function isPhone(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
}

export function AdminShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const logout = useAdminLogout();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const counts = useAdminUserCounts();
  const attention = useAdminAttention();
  // Состояние «Системы» тяжёлое (бот, узел, диск, бэкапы): спрашиваем, только
  // когда открыт лист «Ещё»; в боковом меню точка — из уже полученного ответа.
  const system = useAdminSystem({ enabled: moreOpen });
  const systemDot = system.data ? systemTone(system.data) : null;

  const isUserCard = USER_CARD_PATH.test(pathname);
  const title =
    titles[pathname] ??
    (pathname.startsWith('/panel/users/') ? 'Пользователь' : pathname.startsWith('/panel/partners/') ? 'Партнёр' : 'Панель');

  const closeAll = useCallback(() => {
    setMenuOpen(false);
    setMoreOpen(false);
  }, []);

  // Раздел меняется — ящик и лист закрываем: иначе после перехода они висели
  // поверх страницы, ради которой их и открыли.
  useEffect(closeAll, [pathname, closeAll]);

  useEffect(() => {
    if (!menuOpen && !moreOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeAll();
    document.addEventListener('keydown', onKey);
    // Иначе за полупрозрачной подложкой прокручивается страница под ящиком.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [menuOpen, moreOpen, closeAll]);

  // «/» — к поиску, как в макете (подсказка на поле). В полях ввода не перехватываем.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const input = searchRef.current;
      // На телефоне поле спрятано (там значок-ссылка) — фокусировать нечего.
      const form = input?.closest('form');
      if (!input || !form || window.getComputedStyle(form).display === 'none') return;
      e.preventDefault();
      input.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    navigate(q ? `/panel/users?q=${encodeURIComponent(q)}` : '/panel/users');
    searchRef.current?.blur();
  };

  const badgeFor = (item: NavItem): number | null => {
    if (item.badge === 'users') return counts.data?.all ?? null;
    if (item.badge === 'withdrawals') return attention.data?.withdrawals.count || null;
    return null;
  };

  const openMenu = () => {
    // На телефоне меню — лист «Ещё» над нижней панелью (макет M-Menu), на
    // планшете — прежний выезжающий ящик.
    if (isPhone()) setMoreOpen(true);
    else setMenuOpen(v => !v);
  };

  const tabs: TabItem[] = [
    { key: 'overview', label: 'Обзор', Icon: LayoutDashboard, to: '/panel', end: true, active: moreOpen ? false : undefined },
    { key: 'users', label: 'Пользователи', Icon: Users, to: '/panel/users', active: moreOpen ? false : undefined },
    { key: 'audit', label: 'Журнал', Icon: ScrollText, to: '/panel/audit', active: moreOpen ? false : undefined },
    {
      key: 'more',
      label: 'Ещё',
      Icon: MoreHorizontal,
      onClick: () => setMoreOpen(v => !v),
      active: moreOpen || !TAB_PATHS.some(path => (path === '/panel' ? pathname === path : pathname.startsWith(path))),
      badge: attention.data?.withdrawals.count || undefined,
      ariaLabel: attention.data?.withdrawals.count ? `Ещё, заявок на выплату: ${attention.data.withdrawals.count}` : 'Ещё',
    },
  ];

  return (
    <div className={`${s.shell} ${menuOpen ? s.open : ''} ${isUserCard ? '' : s.withTabbar}`}>
      <a className="skip-link" href="#content">
        Перейти к содержимому
      </a>

      <button className={s.scrim} onClick={closeAll} aria-label="Закрыть меню" tabIndex={-1} />

      <aside className={s.sidebar}>
        <div className={s.sidebarHead}>
          <NavLink to="/panel" className={s.brand} onClick={closeAll}>
            <span className={s.logo} aria-hidden="true">
              ШК
            </span>
            <span className={s.brandText}>
              <span className={s.brandName}>ШК ВБ</span>
              <span className={s.brandSub}>Админка</span>
            </span>
          </NavLink>
          <button type="button" className={s.closeMenu} onClick={closeAll} aria-label="Закрыть меню">
            <X size={20} />
          </button>
        </div>

        <nav className={s.group} aria-label="Разделы админки">
          {ADMIN_NAV.map(group => (
            <div key={group.title ?? 'main'} className={s.navGroup}>
              {group.title && <div className={s.groupTitle}>{group.title}</div>}
              {group.items.map(item => {
                const badge = badgeFor(item);
                const active = isActive(item, pathname);
                return (
                  // Link, а не NavLink: подсветку считаем сами — «Пулы номеров» активны и на коробках.
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={closeAll}
                    aria-current={active ? 'page' : undefined}
                    className={`${s.nav} ${active ? s.active : ''}`}
                  >
                    <item.Icon size={18} />
                    <span className={s.navLabel}>{item.label}</span>
                    {badge !== null && (
                      <span className={item.badge === 'withdrawals' ? s.navBadgeAccent : s.navCount}>{counter.format(badge)}</span>
                    )}
                    {item.status === 'system' && systemDot && (
                      <span className={s.navDot} data-tone={systemDot.tone} title={systemDot.label} aria-hidden="true" />
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className={s.bottom}>
          <NavLink to="/" className={s.nav} onClick={closeAll}>
            <Grid2X2 size={18} />
            На сайт
          </NavLink>
          {/* Кнопки выхода в старой админке не было вовсе — сессия просто жила 8 часов. */}
          <button type="button" className={s.nav} onClick={() => logout.mutate()}>
            <LogOut size={18} />
            Выйти
          </button>
        </div>
      </aside>

      <div className={s.content}>
        <header className={s.head}>
          <button
            type="button"
            className={s.burger}
            onClick={openMenu}
            aria-label="Открыть меню"
            aria-expanded={menuOpen || moreOpen}
          >
            <Menu size={21} />
          </button>
          <h1>{title}</h1>
          <form className={s.search} role="search" onSubmit={submitSearch}>
            <Search size={17} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Найти: почта, телефон, Telegram, ключ, ID"
              aria-label="Поиск пользователя"
              enterKeyHint="search"
            />
            <kbd className={s.searchKey} aria-hidden="true">
              /
            </kbd>
          </form>
          <button
            type="button"
            className={s.searchIcon}
            aria-label="Поиск пользователя"
            onClick={() => navigate('/panel/users')}
          >
            <Search size={20} />
          </button>
        </header>
        <main id="content">
          <Outlet />
        </main>
      </div>

      {moreOpen && (
        <div className={`${s.more} ${isUserCard ? s.moreFull : ''}`} role="dialog" aria-modal="true" aria-label="Все разделы">
          <div className={s.moreHead}>
            <h2>Ещё</h2>
            <button type="button" className={s.moreClose} onClick={() => setMoreOpen(false)} aria-label="Закрыть">
              <X size={20} />
            </button>
          </div>
          <nav className={s.moreBody} aria-label="Все разделы">
            {ADMIN_NAV.map(group => {
              // Что уже есть в нижней панели, в листе не повторяем; на карточке
              // пользователя нижней панели нет — там лист показывает всё.
              const items = group.items.filter(item => isUserCard || !TAB_PATHS.includes(item.to));
              if (items.length === 0) return null;
              return (
                <div key={group.title ?? 'main'} className={s.moreGroup}>
                  {group.title && <div className={s.groupTitle}>{group.title}</div>}
                  <div className={s.moreList}>
                    {items.map(item => {
                      const badge = badgeFor(item);
                      return (
                        <NavLink key={item.to} to={item.to} end={item.end} className={s.moreItem} onClick={closeAll}>
                          <span className={s.moreIcon}>
                            <item.Icon size={18} />
                          </span>
                          <span className={s.navLabel}>{item.label}</span>
                          {item.badge === 'withdrawals' && badge !== null && (
                            <span className={s.navBadgeAccent} aria-label={`${badge} заявок ждут`}>
                              {counter.format(badge)}
                            </span>
                          )}
                          {item.status === 'system' &&
                            (system.isPending ? (
                              <StatusDot tone="muted" label="Проверяем…" />
                            ) : system.isError ? (
                              <StatusDot tone="muted" label="Нет данных" />
                            ) : (
                              <StatusDot tone={systemTone(system.data).tone} label={systemTone(system.data).label} />
                            ))}
                          <ChevronRight size={18} className={s.moreChevron} aria-hidden="true" />
                        </NavLink>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <div className={s.moreFoot}>
              <NavLink to="/" className={s.moreItem} onClick={closeAll}>
                <span className={s.moreIcon}>
                  <Grid2X2 size={18} />
                </span>
                <span className={s.navLabel}>На сайт</span>
              </NavLink>
              <button type="button" className={s.moreItem} onClick={() => logout.mutate()}>
                <span className={s.moreIcon}>
                  <LogOut size={18} />
                </span>
                <span className={s.navLabel}>Выйти</span>
              </button>
            </div>
          </nav>
        </div>
      )}

      {!isUserCard && <TabBar items={tabs} label="Главные разделы" />}
    </div>
  );
}
