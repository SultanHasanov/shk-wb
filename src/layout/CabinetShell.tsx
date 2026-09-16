import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileClock,
  Grid2X2,
  Home,
  KeyRound,
  LogOut,
  Menu,
  Package,
  QrCode,
  Receipt,
  Settings,
  User,
  Users,
  Bell,
} from 'lucide-react';
import { Button } from '../ui';
import { useQueryClient } from '@tanstack/react-query';
import { useStores } from '../stores/root-store';
import s from './CabinetShell.module.css';
import { ApiError, api } from '../api/client';
import { cabinetKey, useCabinet } from '../api/cabinet';
import { legacyStickerCodes } from '../lib/legacy-assets';
import { forgetPendingOrder, readPendingOrders } from '../lib/pending-orders';

const cabinetNav = [
  { to: '/cabinet', label: 'Обзор', Icon: Home, end: true },
  // Раньше за генерацией приходилось уходить на публичную главную и возвращаться руками
  { to: '/cabinet/generator', label: 'Генератор', Icon: QrCode, end: false },
  { to: '/cabinet/keys', label: 'Ключи и доступы', Icon: KeyRound, end: false },
  { to: '/cabinet/packages', label: 'Пакеты и код', Icon: Package, end: false },
  { to: '/cabinet/history', label: 'История генераций', Icon: FileClock, end: false },
  { to: '/cabinet/orders', label: 'Заказы', Icon: Receipt, end: false },
  // Раньше маршрут /cabinet/referrals существовал, но отсутствовал в навигации —
  // попасть на него через интерфейс было нельзя.
  { to: '/cabinet/referrals', label: 'Рефералы', Icon: Users, end: false },
  { to: '/cabinet/profile', label: 'Профиль', Icon: User, end: false },
  { to: '/cabinet/settings', label: 'Настройки', Icon: Settings, end: false },
  { to: '/cabinet/notifications', label: 'Уведомления', Icon: Bell, end: false },
] as const;

const titles: Record<string, string> = {
  '/cabinet': 'Обзор',
  '/cabinet/generator': 'Генератор',
  '/cabinet/payment-result': 'Результат оплаты',
  '/cabinet/keys': 'Ключи и доступы',
  '/cabinet/packages': 'Пакеты и код доступа',
  '/cabinet/history': 'История генераций',
  '/cabinet/orders': 'Заказы',
  '/cabinet/referrals': 'Рефералы',
  '/cabinet/profile': 'Профиль',
  '/cabinet/settings': 'Настройки',
  '/cabinet/notifications': 'Уведомления',
};

/** Оболочка кабинета: сайдбар уместен здесь, но не на публичных страницах. */
export const CabinetShell = observer(() => {
  const { ui, auth } = useStores();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const cabinet = useCabinet();
  const accountRef = useRef<HTMLDivElement>(null);

  const email = auth.displayName || 'Пользователь';

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
            (error.code === 'ASSET_OWNED' || error.code === 'ASSET_NOT_FOUND')
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
      className={`${s.shell} ${ui.sidebarCollapsed ? s.collapsed : ''} ${ui.sidebarOpen ? s.open : ''}`}
    >
      {/* Ссылка была только в PublicShell — клавиатурный пользователь кабинета
          каждый раз проходил весь сайдбар, чтобы добраться до содержимого. */}
      <a className="skip-link" href="#content">
        Перейти к содержимому
      </a>

      <button className={s.scrim} onClick={ui.closeMobile} aria-label="Закрыть меню" />

      <aside className={s.sidebar}>
        <NavLink to="/cabinet" className={s.brand}>
          <span className={s.mark} aria-hidden="true">
            ШК
          </span>
          <span className={s.label}>ШК ВБ</span>
        </NavLink>

        <nav className={s.group} aria-label="Навигация кабинета">
          <div className={s.groupTitle}>Кабинет</div>
          {cabinetNav.map(({ to, label, Icon, end }) => (
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
                    aria-label={`Непрочитанных уведомлений: ${cabinet.data?.unreadNotifications}`}
                  >
                    {(cabinet.data?.unreadNotifications ?? 0) > 99
                      ? '99+'
                      : cabinet.data?.unreadNotifications}
                  </span>
                )}
              </span>
              <span className={s.label}>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className={s.bottom}>
          <NavLink to="/" className={s.nav} onClick={ui.closeMobile}>
            <Grid2X2 size={20} />
            <span className={s.label}>На сайт</span>
          </NavLink>
          <button className={s.collapse} onClick={ui.toggleCollapsed} aria-label="Свернуть меню">
            {ui.sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>
      </aside>

      <div className={s.content}>
        <header className={s.topbar}>
          <Button
            variant="ghost"
            className="mobile-only"
            onClick={ui.toggleMobile}
            aria-label="Открыть меню"
          >
            <Menu size={21} />
          </Button>
          <span className={s.title}>{titles[location.pathname] ?? 'Кабинет'}</span>

          <div className={s.topActions}>
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
                    Настройки
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={`${s.menuItem} ${s.menuDanger}`}
                    onClick={async () => {
                      setMenuOpen(false);
                      try {
                        await auth.signOut();
                        navigate('/');
                      } catch {
                        navigate('/');
                      }
                    }}
                  >
                    <LogOut size={16} />
                    Выйти
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main id="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
});
