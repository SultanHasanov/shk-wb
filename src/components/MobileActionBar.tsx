import type { ReactNode } from 'react';
import s from './MobileActionBar.module.css';

/**
 * Липкая нижняя панель действия на телефоне (по прототипам Mobile_Product /
 * Mobile_CellPrint): слева цена/пояснение, справа главная кнопка. На десктопе
 * скрыта — там та же кнопка живёт в hero и в блоке покупки. Панель стоит НАД
 * общим таббаром (её `bottom` = высота таббара), а спейсер в потоке не даёт
 * контенту спрятаться под ней.
 */
export function MobileActionBar({
  note,
  subnote,
  children,
}: {
  note: ReactNode;
  subnote?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className={s.spacer} aria-hidden="true" />
      <div className={s.bar} data-hide-on-keyboard="">
        <span className={s.note}>
          {note}
          {subnote != null && <small>{subnote}</small>}
        </span>
        <span className={s.action}>{children}</span>
      </div>
    </>
  );
}
