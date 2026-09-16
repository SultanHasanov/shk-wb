import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * React Router не прокручивает к якорю сам — <Link to="/#packages"> просто
 * открывает главную сверху. Без этого ссылки «Пополнить пакет» из кабинета и
 * «Выбрать пакет» из генератора никуда не ведут визуально.
 *
 * Элемент может ещё не отрисоваться в момент навигации, поэтому пробуем
 * несколько кадров подряд, а не один раз.
 */
export function ScrollToHash() {
  const { hash, pathname } = useLocation();

  useEffect(() => {
    if (!hash) {
      window.scrollTo({ top: 0 });
      return;
    }

    const id = decodeURIComponent(hash.slice(1));
    let attempts = 0;
    let frame = 0;

    const tryScroll = () => {
      const target = document.getElementById(id);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      // ~20 кадров ≈ 300мс: хватает на монтирование страницы, но не залипает надолго
      if (attempts++ < 20) frame = requestAnimationFrame(tryScroll);
    };

    frame = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(frame);
  }, [hash, pathname]);

  return null;
}
