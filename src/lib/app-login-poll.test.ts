import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { LOGIN_POLL_MS, isFinalLoginStatusError, loginStatusInterval, retryLoginStatus } from './app-login-poll';

// Опрос статуса кода на /app-login: временный сбой не должен заменять экран с кнопками ошибкой.

describe('опрос статуса кода входа', () => {
  it('окончательные ответы — только «не найден» (404) и «устарел» (410)', () => {
    expect(isFinalLoginStatusError(new ApiError('Код устарел', 410, 'EXPIRED'))).toBe(true);
    expect(isFinalLoginStatusError(new ApiError('Код не найден', 404, 'NOT_FOUND'))).toBe(true);
    expect(isFinalLoginStatusError(new ApiError('Database request failed', 502))).toBe(false);
    expect(isFinalLoginStatusError(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('временный сбой — до 2 повторов, окончательный ответ — без повторов', () => {
    const flaky = new TypeError('Failed to fetch');
    expect(retryLoginStatus(0, flaky)).toBe(true);
    expect(retryLoginStatus(1, flaky)).toBe(true);
    expect(retryLoginStatus(2, flaky)).toBe(false);
    expect(retryLoginStatus(0, new ApiError('Код устарел', 410, 'EXPIRED'))).toBe(false);
  });

  it('после временного сбоя опрос продолжается, на окончательном — стоп', () => {
    expect(loginStatusInterval(undefined, null)).toBe(LOGIN_POLL_MS);
    expect(loginStatusInterval({ status: 'pending' }, new ApiError('Bad gateway', 502))).toBe(LOGIN_POLL_MS);
    expect(loginStatusInterval(undefined, new TypeError('Failed to fetch'))).toBe(LOGIN_POLL_MS);
    expect(loginStatusInterval({ status: 'pending' }, new ApiError('Код устарел', 410, 'EXPIRED'))).toBe(false);
  });

  it('код уже подтвердили — опрос останавливается', () => {
    expect(loginStatusInterval({ status: 'approved' }, null)).toBe(false);
  });
});
