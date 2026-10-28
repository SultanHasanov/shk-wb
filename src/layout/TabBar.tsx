import type { ComponentType } from 'react';
import { NavLink } from 'react-router-dom';
import s from './TabBar.module.css';

/**
 * Пункт нижней навигации. Либо ссылка (to), либо кнопка (onClick) — «Ещё»
 * открывает шторку и ссылкой не является. placeholder рисует неинтерактивную
 * ячейку того же размера: пока auth.status === 'initializing', вкладка
 * «Кабинет/Войти» не должна прыгать и менять ширину соседей.
 */
export type TabItem = {
  key: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
  to?: string;
  end?: boolean;
  onClick?: () => void;
  /** Счётчик на иконке (непрочитанные уведомления). */
  badge?: number;
  /** Доступное имя, если видимой подписи и бейджа мало (у «Ещё» с бейджем). */
  ariaLabel?: string;
  /** Активна принудительно (кнопка «Ещё», когда шторка открыта). */
  active?: boolean;
  placeholder?: boolean;
};

/**
 * Нижняя навигация мобильного приложения. Общая для публичной части и кабинета:
 * обе оболочки собирают свой набор пунктов и передают сюда. На десктопе скрыта
 * (навигация живёт в шапке/сайдбаре).
 */
export function TabBar({ items, label }: { items: readonly TabItem[]; label: string }) {
  return (
    <nav className={s.tabbar} aria-label={label}>
      {items.map(item => {
        const Icon = item.Icon;
        const badge =
          typeof item.badge === 'number' && item.badge > 0 ? (
            <span className={s.badge} aria-hidden="true">
              {item.badge > 99 ? '99+' : item.badge}
            </span>
          ) : null;
        const inner = (
          <>
            <span className={s.icon}>
              <Icon size={22} />
              {badge}
            </span>
            <span className={s.label}>{item.label}</span>
          </>
        );

        if (item.placeholder) {
          return (
            <span key={item.key} className={s.tab} aria-hidden="true">
              {inner}
            </span>
          );
        }

        if (item.to) {
          return (
            <NavLink
              key={item.key}
              to={item.to}
              end={item.end}
              aria-label={item.ariaLabel}
              className={({ isActive }) => `${s.tab} ${(item.active ?? isActive) ? s.active : ''}`}
            >
              {inner}
            </NavLink>
          );
        }

        return (
          <button
            key={item.key}
            type="button"
            aria-label={item.ariaLabel}
            className={`${s.tab} ${item.active ? s.active : ''}`}
            onClick={item.onClick}
          >
            {inner}
          </button>
        );
      })}
    </nav>
  );
}
