import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import s from './Hero.module.css';

/**
 * Градиентный hero публичных страниц. Восстановлен из старого index.html:
 * eyebrow, заголовок с акцентом, вводный абзац и строка доверия — всё это
 * пропало при переезде на React, из-за чего лендинг выглядел как админка.
 */
export function Hero({
  eyebrow,
  title,
  copy,
  trust,
  compact = false,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  copy?: ReactNode;
  trust?: readonly string[];
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={`${s.hero} ${compact ? s.compact : ''}`}>
      <div className={s.inner}>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className={s.title}>{title}</h1>
        {copy && <p className={s.copy}>{copy}</p>}
        {trust && trust.length > 0 && (
          <ul className={s.trust}>
            {trust.map(item => (
              <li key={item}>
                <Check size={15} strokeWidth={3} />
                {item}
              </li>
            ))}
          </ul>
        )}
        {children}
      </div>
    </section>
  );
}
