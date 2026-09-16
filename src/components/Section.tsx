import { useId } from 'react';
import type { ReactNode } from 'react';
import s from './Section.module.css';

/**
 * Секция лендинга: надзаголовок, заголовок, лид и содержимое.
 *
 * Раньше каждый блок объявлял собственные .section/.title/.head в своём
 * CSS-модуле — четыре почти одинаковые копии с разъехавшимися размерами
 * (fs-24 в Faq и CrossSell, fs-30 в PricingPacks).
 *
 * tone="band" — секция во всю ширину с подложкой, для смены ритма страницы.
 */
export function Section({
  id,
  eyebrow,
  title,
  lead,
  align = 'start',
  tone = 'plain',
  children,
}: {
  id?: string;
  eyebrow?: string;
  title?: ReactNode;
  lead?: ReactNode;
  align?: 'start' | 'center';
  tone?: 'plain' | 'band';
  children: ReactNode;
}) {
  const headingId = useId();

  const head = (eyebrow || title || lead) && (
    <div className={`${s.head} ${align === 'center' ? s.center : ''}`}>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      {title && (
        <h2 className={s.title} id={headingId}>
          {title}
        </h2>
      )}
      {lead && <p className={s.lead}>{lead}</p>}
    </div>
  );

  const labelledBy = title ? headingId : undefined;

  if (tone === 'band') {
    return (
      <section className={s.band} id={id} aria-labelledby={labelledBy}>
        <div className={s.inner}>
          {head}
          {children}
        </div>
      </section>
    );
  }

  return (
    <section className={s.section} id={id} aria-labelledby={labelledBy}>
      {head}
      {children}
    </section>
  );
}
