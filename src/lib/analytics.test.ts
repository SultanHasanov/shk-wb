import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordVisit } from './visits';

/**
 * Регрессия на переезд с React: счётчики отвалились молча, и сайт трое суток
 * показывал в Метрике десятую часть посещаемости. Оба провала были невидимы —
 * ничего не падало, просто данные не доходили.
 */
describe('счётчик визитов', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('шлёт идентификатор в формате, который принимает api/visits.js', () => {
    recordVisit();

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/visits');
    expect(init?.method).toBe('POST');

    const { visitorId } = JSON.parse(String(init?.body));
    // Та же проверка стоит на сервере: невалидный id вернёт 400 и визит пропадёт.
    expect(visitorId).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });

  it('за сутки засчитывает визит один раз, дальше только читает', () => {
    recordVisit();
    recordVisit();

    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe('POST');
    expect(vi.mocked(fetch).mock.calls[1][1]).toBeUndefined();
  });

  it('переживает недоступное хранилище, не роняя страницу', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('доступ к хранилищу запрещён');
    });

    expect(() => recordVisit()).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();

    getItem.mockRestore();
  });
});

describe('CSP не должна блокировать Метрику', () => {
  const policy: string = JSON.parse(readFileSync('vercel.json', 'utf8'))
    .headers.find((entry: { source: string }) => entry.source === '/(.*)')
    .headers.find((header: { key: string }) => header.key === 'Content-Security-Policy').value;

  const directive = (name: string) =>
    policy.split(';').map(part => part.trim()).find(part => part.startsWith(`${name} `)) ?? '';

  // Скрипт счётчика можно вернуть на страницу и всё равно не собрать ни одного
  // визита: default-src 'self' режет и загрузку tag.js, и отправку хитов.
  it('разрешает загрузку tag.js', () => {
    expect(directive('script-src')).toContain('https://mc.yandex.ru');
  });

  it('разрешает отправку хитов', () => {
    expect(directive('connect-src')).toContain('https://mc.yandex.ru');
  });
});
