import type { LucideIcon } from 'lucide-react';
import s from './FeatureGrid.module.css';

export type Feature = {
  title: string;
  text: string;
  Icon?: LucideIcon;
};

/** Сетка «иконка → заголовок → текст». Колонки подбираются по ширине, поэтому
 *  одинаково работает и на четырёх пунктах, и на восьми. */
export function FeatureGrid({ items }: { items: readonly Feature[] }) {
  return (
    <ul className={s.grid}>
      {items.map(({ title, text, Icon }) => (
        <li key={title} className={s.item}>
          {Icon && (
            <span className={s.icon} aria-hidden="true">
              <Icon size={22} />
            </span>
          )}
          <h3 className={s.title}>{title}</h3>
          <p className={s.text}>{text}</p>
        </li>
      ))}
    </ul>
  );
}
