import { useEffect } from 'react';
import { isPrerender } from './prerender';

/**
 * Собственный счётчик визитов — порт js/visits.js, потерянного при переезде на
 * React. Пишет в site_stats / site_visitor_days через POST /api/visits.
 *
 * Он не дублирует Метрику, а страхует её: это единственный источник посещаемости,
 * который не зависит от внешнего скрипта и от блокировщиков рекламы. Когда
 * счётчик Метрики отвалился, сверить график было буквально не с чем.
 */
const VISITOR_KEY = 'wb_visitor_id';
const DAY_KEY = 'wb_visit_counted_day';

/** Сутки считаются по Москве — так же, как их режет record_visit на стороне БД. */
function moscowDay(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Формат обязан проходить валидацию `^[A-Za-z0-9_-]{8,100}$` в api/visits.js. */
function visitorId(): string | null {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id = `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    // Приватный режим и запрет хранилища не должны ронять оболочку сайта.
    return null;
  }
}

function alreadyCountedToday(day: string): boolean {
  try {
    const counted = sessionStorage.getItem(DAY_KEY) === day;
    sessionStorage.setItem(DAY_KEY, day);
    return counted;
  } catch {
    return false;
  }
}

export function recordVisit(): void {
  if (typeof window === 'undefined' || isPrerender()) return;

  const id = visitorId();
  if (!id) return;

  const init = alreadyCountedToday(moscowDay())
    ? undefined
    : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: id }),
      };

  // Счётчик нигде не показывается, ответ не нужен: важна только запись.
  fetch('/api/visits', init).catch(() => {});
}

export function useVisitCounter(): void {
  useEffect(() => {
    recordVisit();
  }, []);
}
