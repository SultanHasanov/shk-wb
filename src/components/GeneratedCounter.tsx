import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import s from './GeneratedCounter.module.css';

type Stats = { returnStickers: number; customStickers: number };

const nf = new Intl.NumberFormat('ru-RU');

/** Набор числа от нуля до target. Уважает prefers-reduced-motion. */
function useCountUp(target: number, duration = 900) {
  const [value, setValue] = useState(target);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || target === 0) {
      setValue(target);
      return;
    }

    let frame = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      // easeOutCubic — быстро стартует, мягко останавливается
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(target * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return value;
}

function Item({ value, label }: { value: number; label: string }) {
  const shown = useCountUp(value);
  return (
    <div className={s.item}>
      <span className={s.value}>{nf.format(shown)}</span>
      <span className={s.label}>{label}</span>
    </div>
  );
}

/**
 * Социальное доказательство живыми числами.
 * Эндпоинт /api/sticker-stats существовал и был прописан в vercel.json, но не
 * использовался ни строчкой.
 *
 * Важно: при ошибке, загрузке или нулях блок не рендерится вовсе. Счётчик
 * доверия, показывающий «0» или сообщение об ошибке, работает против доверия.
 */
export function GeneratedCounter() {
  const { data } = useQuery({
    queryKey: ['sticker-stats'],
    queryFn: () => api<Stats>('/api/sticker-stats'),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const total = (data?.returnStickers ?? 0) + (data?.customStickers ?? 0);
  if (!data || total === 0) return null;

  return (
    <section className={s.band} aria-label="Статистика сервиса">
      <div className={s.inner}>
        <Item value={data.returnStickers} label="возвратных стикеров" />
        <Item value={data.customStickers} label="стикеров по номеру" />
        <p className={s.caption}>Уже сгенерировано пользователями сервиса</p>
      </div>
    </section>
  );
}
