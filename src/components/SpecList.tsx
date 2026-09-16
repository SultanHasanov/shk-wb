import type { ReactNode } from 'react';
import s from './SpecList.module.css';

export type Spec = { term: string; value: ReactNode };

/** Системные требования и характеристики. <dl> вместо таблицы: пар всего
 *  несколько, и на узком экране они складываются в столбик без горизонтальной
 *  прокрутки, которая неизбежна у <table>.
 *
 *  flush — без рамки и тени: внутри модалки или карточки вложенная «коробка»
 *  выглядит лишним слоем. */
export function SpecList({ items, flush = false }: { items: readonly Spec[]; flush?: boolean }) {
  return (
    <dl className={`${s.list} ${flush ? s.flush : ''}`}>
      {items.map(({ term, value }) => (
        <div key={term} className={s.row}>
          <dt className={s.term}>{term}</dt>
          <dd className={s.value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
