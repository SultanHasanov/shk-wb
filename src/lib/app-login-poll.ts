import { ApiError } from '../api/client';

/** Опрос статуса кода входа программы на странице /app-login. */
export const LOGIN_POLL_MS = 3000;

/**
 * Окончательный ответ по коду: код не найден (404) или устарел (410). Дальше опрашивать бессмысленно —
 * показываем сообщение. Всё прочее (сеть моргнула, 502 при перезапуске сервера) — временный сбой:
 * экран с кнопками остаётся, опрос продолжается.
 */
export function isFinalLoginStatusError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 404 || error.status === 410);
}

/** Повторы одного запроса опроса: до 2 при временном сбое, без повторов при окончательном ответе. */
export function retryLoginStatus(failureCount: number, error: unknown): boolean {
  return !isFinalLoginStatusError(error) && failureCount < 2;
}

/** Интервал опроса: стоп, когда код уже занят или окончательно недействителен; при временном сбое — продолжаем. */
export function loginStatusInterval(data: { status?: string } | undefined, error: unknown): number | false {
  if (data && data.status !== 'pending') return false;
  if (isFinalLoginStatusError(error)) return false;
  return LOGIN_POLL_MS;
}
