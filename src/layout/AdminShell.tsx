import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Bell, Boxes, CreditCard, Grid2X2, KeyRound, LayoutDashboard, LogOut, Megaphone,
  Menu, Package, Printer, Ticket, Users, Wallet, X,
} from 'lucide-react';
import { useAdminLogout } from '../api/admin';
import { Button } from '../ui';
import s from './AdminShell.module.css';

const nav = [
  { to: '/panel', label: 'Обзор', Icon: LayoutDashboard, end: true },
  { to: '/panel/users', label: 'Пользователи', Icon: Users, end: false },
  { to: '/panel/access-codes', label: 'Коды доступа', Icon: KeyRound, end: false },
  { to: '/panel/sticker-pool', label: 'Пул стикеров', Icon: Package, end: false },
  { to: '/panel/box-pool', label: 'Пул коробок', Icon: Boxes, end: false },
  { to: '/panel/payments', label: 'Оплата', Icon: CreditCard, end: false },
  { to: '/panel/program', label: 'Программа', Icon: Ticket, end: false },
  { to: '/panel/cell-print', label: 'Печать ячеек', Icon: Printer, end: false },
  { to: '/panel/announcements', label: 'Объявления', Icon: Megaphone, end: false },
  { to: '/panel/cabinet', label: 'Выплаты и рассылка', Icon: Wallet, end: false },
] as const;

const titles: Record<string, string> = {
  '/panel': 'Обзор',
  '/panel/users': 'Пользователи',
  '/panel/access-codes': 'Коды доступа к генератору',
  '/panel/sticker-pool': 'Диапазон номеров стикеров',
  '/panel/box-pool': 'Диапазон номеров коробок',
  '/panel/payments': 'Оплата',
  '/panel/program': 'Программа «Подбор кодов»',
  '/panel/cell-print': 'Печать ячеек',
  '/panel/announcements': 'Объявления',
  '/panel/cabinet': 'Выплаты и рассылка',
};

export function AdminShell() {
  const { pathname } = useLocation();
  const logout = useAdminLogout();
  const [menuOpen, setMenuOpen] = useState(false);
  const title = titles[pathname] ?? (pathname.startsWith('/panel/users/') ? 'Пользователь' : 'Панель');
  const close = () => setMenuOpen(false);

  // Раздел меняется — ящик закрываем: иначе после перехода он висел поверх
  // страницы, ради которой его и открыли.
  useEffect(close, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    // Иначе за полупрозрачной подложкой прокручивается страница под ящиком.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  return (
    <div className={`${s.shell} ${menuOpen ? s.open : ''}`}>
      <a className="skip-link" href="#content">
        Перейти к содержимому
      </a>

      <button className={s.scrim} onClick={close} aria-label="Закрыть меню" tabIndex={-1} />

      <aside className={s.sidebar}>
        <div className={s.sidebarHead}>
          <NavLink to="/panel" className={s.brand} onClick={close}>
            <Bell size={18} />
            Панель
          </NavLink>
          <button type="button" className={s.closeMenu} onClick={close} aria-label="Закрыть меню">
            <X size={20} />
          </button>
        </div>

        <nav className={s.group} aria-label="Разделы админки">
          <div className={s.groupTitle}>Разделы</div>
          {nav.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={close}
              className={({ isActive }) => `${s.nav} ${isActive ? s.active : ''}`}
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className={s.bottom}>
          <NavLink to="/" className={s.nav} onClick={close}>
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
            onClick={() => setMenuOpen(v => !v)}
            aria-label="Открыть меню"
            aria-expanded={menuOpen}
          >
            <Menu size={21} />
          </button>
          <h1>{title}</h1>
          <Button
            variant="ghost"
            size="sm"
            className={s.headLogout}
            onClick={() => logout.mutate()}
            loading={logout.isPending}
          >
            <LogOut size={16} />
            Выйти
          </Button>
        </header>
        <main id="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
