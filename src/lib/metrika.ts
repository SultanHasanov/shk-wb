import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { isPrerender } from './prerender';

/**
 * Яндекс.Метрика.
 *
 * До переезда на React счётчик подключал js/metrika.js на каждой статической
 * странице. В SPA его не перенесли, и с 31.08 сайт перестал считать визиты
 * вообще — график в Метрике упал до нуля не потому, что ушли люди.
 *
 * Опции init повторяют старый файл дословно: изменение набора (clickmap,
 * webvisor, accurateTrackBounce) меняет и то, как считаются отказы, из-за чего
 * данные до и после переезда стали бы несравнимы.
 */
const COUNTER_ID = 111723088;

const TAG_SRC = `https://mc.yandex.ru/metrika/tag.js?id=${COUNTER_ID}`;

type MetrikaFn = ((id: number, action: string, ...args: unknown[]) => void) & {
  /** Очередь вызовов до загрузки tag.js. */
  a?: unknown[][];
  /** Момент установки счётчика — Метрика меряет по нему время загрузки. */
  l?: number;
};

declare global {
  interface Window {
    ym?: MetrikaFn;
  }
}

export function initMetrika(): void {
  if (typeof window === 'undefined') return;
  // В dev каждая перезагрузка страницы давала бы визит с localhost.
  if (!import.meta.env.PROD) return;
  if (isPrerender()) return;
  if (window.ym) return;

  const queue: MetrikaFn = function (...args: unknown[]) {
    (queue.a = queue.a || []).push(args);
  } as MetrikaFn;
  queue.l = Date.now();
  window.ym = queue;

  const script = document.createElement('script');
  script.async = true;
  script.src = TAG_SRC;
  document.head.appendChild(script);

  window.ym(COUNTER_ID, 'init', {
    ssr: true,
    clickmap: true,
    ecommerce: 'dataLayer',
    referrer: document.referrer,
    url: location.href,
    accurateTrackBounce: true,
    trackLinks: true,
    webvisor: true,
  });
}

/**
 * Переходы внутри SPA адрес меняют, а страницу не перезагружают, поэтому сама
 * Метрика видит только первый экран: без явного hit визит из четырёх страниц
 * считался бы одной. Первый хит шлёт init — его здесь пропускаем.
 */
export function useMetrikaPageviews(): void {
  const location = useLocation();
  const previousUrl = useRef<string | null>(null);

  useEffect(() => {
    const url = window.location.href;
    if (previousUrl.current === null || previousUrl.current === url) {
      previousUrl.current = url;
      return;
    }
    const referer = previousUrl.current;
    previousUrl.current = url;
    window.ym?.(COUNTER_ID, 'hit', url, { referer });
  }, [location.pathname, location.search]);
}
