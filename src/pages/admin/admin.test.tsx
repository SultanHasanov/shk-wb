import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../ui';
import { RequireAdmin } from '../../layout/RequireAdmin';
import { AdminCabinetPage, AdminPoolPage, AdminUserPreviewPage, AdminUsersPage } from '.';

const user = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'shop@example.com',
  emailConfirmed: true,
  telegramOnly: false,
  banned: false,
  createdAt: '2026-08-01T10:00:00Z',
  lastSignInAt: '2026-09-01T10:00:00Z',
  displayName: 'Иван Петров',
  phone: '+79990000000',
  payerStatus: 'individual',
  telegramUsername: null,
  codes: 1,
  generationLimit: 100,
  generationUsed: 40,
  programKeys: 0,
  cellLicenses: 0,
  cellActive: 0,
  ordersPaid: 2,
  revenueKopecks: 240000,
  refundedKopecks: 0,
  lastOrderAt: '2026-09-01T10:00:00Z',
  referralCode: 'ADE1CB',
  referralEarnedKopecks: 5000,
  referralAvailableKopecks: 5000,
  invited: 1,
  walletKopecks: 125000,
  app: { plan: 'standard', endsAt: '2026-11-13T12:00:00Z', paidUntil: '2026-11-13T12:00:00Z', expiresInDays: 3 },
  devices: { used: 2, limit: 3 },
  points: { used: 1, limit: null },
  lastSeenAt: null,
  restricted: true,
  restriction: { scopes: ['purchases'], until: null },
  unlimited: false,
  unlimitedUntil: null,
};

const counts = {
  all: 1284, paying: 203, subscribed: 87, expiring: 9, unlimited: 6, restricted: 4, telegram: 418, inactive: 0, new30: 146,
};

function response(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(status === 204 ? null : JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

let listCalls: string[] = [];
let requests: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  listCalls = [];
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes('action=list')) {
        listCalls.push(url);
        return response({ items: [user], total: 1, page: 0, pageSize: 25 });
      }
      if (url.includes('action=counts')) return response(counts);
      if (url.includes('/api/admin/session')) return response(null, 204);
      return response({});
    }),
  );
});

afterEach(() => {
  try {
    window.sessionStorage.clear();
  } catch {
    /* jsdom без хранилища — нечего чистить */
  }
});

function renderPage(ui: ReactElement, path = '/panel/users') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Routes>
            <Route path="/panel/users/:userId/preview" element={ui} />
            <Route path="*" element={ui} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('админка', () => {
  it('показывает форму входа вместо содержимого, когда сессии нет', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response({ error: 'Unauthorized' }, 401)),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/panel']}>
          <ToastProvider>
            <Routes>
              <Route element={<RequireAdmin />}>
                <Route path="/panel" element={<div>секретное содержимое</div>} />
              </Route>
            </Routes>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: /Панель управления/ })).toBeInTheDocument();
    expect(screen.queryByText('секретное содержимое')).not.toBeInTheDocument();
  });

  // Ручка сессии отвечает пустым 204. Пока adminApi отдавал на него undefined,
  // react-query считал запрос сбойным и вместо панели показывал ошибку.
  it('пускает внутрь, когда сессия есть, несмотря на пустой ответ', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/panel']}>
          <ToastProvider>
            <Routes>
              <Route element={<RequireAdmin />}>
                <Route path="/panel" element={<div>секретное содержимое</div>} />
              </Route>
            </Routes>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('секретное содержимое')).toBeInTheDocument();
    expect(screen.queryByText(/Не удалось проверить доступ/)).not.toBeInTheDocument();
  });
});

describe('список пользователей', () => {
  it('показывает новые колонки: тариф, баланс, ПК и пункты, выручку, бейджи', async () => {
    renderPage(<AdminUsersPage />);
    const name = await screen.findByText('Иван Петров');
    const row = name.closest('tr') as HTMLElement;
    expect(within(row).getByText('shop@example.com')).toBeInTheDocument();
    expect(within(row).getByText('Ограничен')).toBeInTheDocument();
    expect(within(row).getByText(/^Стандарт · до 13\.11$/)).toBeInTheDocument();
    expect(within(row).getByText('через 3 дн')).toBeInTheDocument();
    expect(within(row).getByText('1 250 ₽')).toBeInTheDocument();
    expect(within(row).getByText('2/3 · 1/∞')).toBeInTheDocument();
    expect(within(row).getByText('2 400 ₽')).toBeInTheDocument();
    // Строка — настоящая ссылка на карточку (клавиатура, средняя кнопка).
    expect(within(row).getByRole('link')).toHaveAttribute('href', `/panel/users/${user.userId}`);
    // На телефоне ячейки становятся карточкой с подписями из data-label.
    expect(within(row).getByText('1 250 ₽').closest('td')).toHaveAttribute('data-label', 'Баланс');
  });

  it('показывает сводку из counts и число новых за 30 дней', async () => {
    renderPage(<AdminUsersPage />);
    expect(await screen.findByText('1 284 аккаунта · 146 новых за 30 дней')).toBeInTheDocument();
    const tile = screen.getByRole('button', { name: /Истекает за 7 дней/ });
    expect(within(tile).getByText('9')).toBeInTheDocument();
  });

  // Поиск идёт по семи полям через ilike, поэтому запрос на каждую букву — это
  // прямая нагрузка на базу.
  it('откладывает запрос поиска, а не шлёт его на каждую букву', async () => {
    const typist = userEvent.setup();
    renderPage(<AdminUsersPage />);
    await screen.findByText('Иван Петров');
    listCalls = [];
    await typist.type(screen.getByRole('searchbox'), 'иван');
    expect(listCalls).toHaveLength(0);
    await waitFor(() =>
      expect(listCalls.some(url => url.includes('q=%D0%B8%D0%B2%D0%B0%D0%BD'))).toBe(true),
    );
    // Одна буква — один запрос не уходил: после паузы ушёл ровно один.
    expect(listCalls.filter(url => url.includes('q=%D0%B8%D0%B2%D0%B0%D0%BD'))).toHaveLength(1);
  });

  it('чипы фильтра меняют filter в запросе и сбрасывают страницу', async () => {
    const typist = userEvent.setup();
    renderPage(<AdminUsersPage />, '/panel/users?page=3');
    await screen.findByText('Иван Петров');
    expect(listCalls.at(-1)).toContain('page=2');
    listCalls = [];
    await typist.click(screen.getByRole('radio', { name: 'Ограничены' }));
    await waitFor(() => expect(listCalls.some(url => url.includes('filter=restricted'))).toBe(true));
    expect(listCalls.at(-1)).toContain('page=0');
    expect(screen.getByRole('radio', { name: 'Ограничены' })).toHaveAttribute('aria-checked', 'true');
  });

  it('берёт фильтр, сортировку и поиск из адреса', async () => {
    renderPage(<AdminUsersPage />, '/panel/users?filter=expiring&sort=balance&q=ivan&size=50');
    await screen.findByText('Иван Петров');
    const url = listCalls[0];
    expect(url).toContain('filter=expiring');
    expect(url).toContain('sort=balance');
    expect(url).toContain('q=ivan');
    expect(url).toContain('pageSize=50');
    expect(screen.getByRole('searchbox')).toHaveValue('ivan');
  });

  it('подсвечивает последнюю открытую карточку', async () => {
    window.sessionStorage.setItem('admin.lastUserId', user.userId);
    renderPage(<AdminUsersPage />);
    const row = (await screen.findByText('Иван Петров')).closest('tr') as HTMLElement;
    expect(row).toHaveAttribute('data-selected', 'true');
    expect(screen.getByText('Выделена последняя открытая карточка')).toBeInTheDocument();
  });

  it('при пустом результате фильтра предлагает сбросить фильтры', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('action=list')) return response({ items: [], total: 0, page: 0, pageSize: 25 });
        if (url.includes('action=counts')) return response(counts);
        return response({});
      }),
    );
    renderPage(<AdminUsersPage />, '/panel/users?filter=unlimited');
    expect(await screen.findByText('Никого не нашли')).toBeInTheDocument();
    expect(screen.getByText(/Под фильтр «Безлимит»/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сбросить фильтры' })).toBeInTheDocument();
  });

  it('при ошибке сервера показывает ошибку с повтором, а не «никого нет»', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('action=list')) return response({ error: 'Database request failed' }, 502);
        if (url.includes('action=counts')) return response(counts);
        return response({});
      }),
    );
    renderPage(<AdminUsersPage />);
    expect(await screen.findByText('Не удалось загрузить данные')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Повторить/ })).toBeInTheDocument();
    expect(screen.queryByText('Никого не нашли')).not.toBeInTheDocument();
  });
});

describe('остальные страницы', () => {
  it('рассылка в Telegram уходит только после окна с причиной и с ключом повтора', async () => {
    const typist = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.includes('telegram-audience')) {
          return response({ activated: 10, available: 8, blocked: 2, legacy: 3, legacyBefore: '2026-10-01T00:00:00Z' });
        }
        if (url.includes('telegram-broadcast')) return response({ sent: 8, failed: 0, blocked: 0, total: 8 });
        return response({});
      }),
    );
    renderPage(<AdminCabinetPage section="broadcasts" />, '/panel/broadcasts');
    await screen.findByText(/Доступно для рассылки/);
    await typist.type(screen.getAllByRole('textbox')[0], 'Здравствуйте!');
    await typist.click(await screen.findByRole('button', { name: 'Отправить в Telegram' }));
    const send = await screen.findByRole('button', { name: 'Отправить 8 получателям' });
    expect(send).toBeDisabled();
    expect(requests.some(r => r.url.includes('telegram-broadcast'))).toBe(false);
    await typist.type(screen.getByPlaceholderText(/анонс новой версии/), 'анонс');
    await typist.click(send);
    await waitFor(() => expect(requests.some(r => r.url.includes('telegram-broadcast'))).toBe(true));
    const body = requests.find(r => r.url.includes('telegram-broadcast'))?.body as Record<string, unknown>;
    expect(body.text).toBe('Здравствуйте!');
    expect(body.reason).toBe('анонс');
    expect(String(body.idempotencyKey)).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  });

  it('выплаты подписаны по-русски, а «Выплачено» есть только у одобренной заявки', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes('/withdrawals')) {
          return response([
            { id: 'w1', amount_kopecks: 50000, bank_name: 'Т-Банк', sbp_phone: '+7999', status: 'pending', admin_note: null, created_at: '2026-11-01T10:00:00Z', user_id: null },
            { id: 'w2', amount_kopecks: 70000, bank_name: 'Сбер', sbp_phone: '+7998', status: 'approved', admin_note: null, created_at: '2026-11-02T10:00:00Z', user_id: null },
          ]);
        }
        return response({});
      }),
    );
    renderPage(<AdminCabinetPage section="withdrawals" />, '/panel/cabinet');
    const pendingRow = (await screen.findByText('Ждёт решения')).closest('tr') as HTMLElement;
    const approvedRow = screen.getByText('Одобрена').closest('tr') as HTMLElement;
    expect(within(pendingRow).queryByRole('button', { name: 'Выплачено' })).not.toBeInTheDocument();
    expect(within(pendingRow).getByRole('button', { name: 'Одобрить' })).toBeInTheDocument();
    expect(within(approvedRow).getByRole('button', { name: 'Выплачено' })).toBeInTheDocument();
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
  });

  it('предпросмотр кабинета подписывает отменённый заказ как «Отменён»', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes('action=detail')) {
          return response({
            userId: user.userId, email: user.email, telegramOnly: false, emailConfirmed: true, banned: false,
            createdAt: user.createdAt, lastSignInAt: null, confirmValue: user.email,
            profile: { display_name: 'Иван' }, telegram: null, codes: [], programKeys: [], cellLicenses: [], orders: [],
            customOrders: [{
              id: 'o1', title: 'Индивидуальный заказ', status: 'canceled', quantity: 10, created_at: '2026-11-01T10:00:00Z',
              total_amount: 100, paid_amount: 0, amount_due: 100,
            }],
            historyEntries: 0, actions: [],
          });
        }
        return response({});
      }),
    );
    renderPage(<AdminUserPreviewPage />, `/panel/users/${user.userId}/preview`);
    expect(await screen.findByText('Отменён')).toBeInTheDocument();
  });
});

/** Все .tsx/.ts в src/pages/admin (включая карточку пользователя и кит), кроме тестов. */
function adminSources(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...adminSources(path));
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) files.push(path);
  }
  return files;
}

describe('исходники админки', () => {
  // Инвариант 8 контракта: опасные действия — только через ConfirmDialog с причиной.
  // window.prompt/confirm не дают ни причины для журнала, ни защиты от двойного клика,
  // а на телефоне выглядят как системная ошибка.
  it('нигде в src/pages/admin нет window.prompt и window.confirm', () => {
    const root = resolve(__dirname);
    const offenders = adminSources(root)
      .filter(file => /\bwindow\s*\.\s*(prompt|confirm)\s*\(/.test(readFileSync(file, 'utf8')))
      .map(file => relative(root, file));
    expect(offenders).toEqual([]);
  });
});

describe('пулы номеров', () => {
  it('переключение «Стикеры / Коробки» не переносит чужой диапазон и номер страницы', async () => {
    const poolCalls: string[] = [];
    const sticker = {
      total: 1000, available: 400, used: 600, start: '1000', end: '1999', page: 0, pageSize: 100,
      recentUsed: [{ code: '1000', batchId: 'batch-1', allocatedAt: '2026-11-01T10:00:00Z' }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('resource=stickerPool')) {
          poolCalls.push(url);
          return response(sticker);
        }
        if (url.includes('resource=boxPool')) {
          poolCalls.push(url);
          // Медленный ответ: пул коробок ещё грузится, когда админ уже на его странице.
          return new Promise<Response>(() => {});
        }
        return response({});
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const actor = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/panel/sticker-pool']}>
          <ToastProvider>
            <Routes>
              <Route path="/panel/sticker-pool" element={<AdminPoolPage kind="stickerPool" title="Стикеры" />} />
              <Route path="/panel/box-pool" element={<AdminPoolPage kind="boxPool" title="Коробки" />} />
            </Routes>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByDisplayValue('1999')).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Следующая страница' }));
    await waitFor(() => expect(poolCalls.some(url => url.includes('stickerPool') && url.includes('page=1'))).toBe(true));

    await actor.click(screen.getByRole('link', { name: 'Коробки' }));
    await waitFor(() => expect(poolCalls.some(url => url.includes('boxPool'))).toBe(true));
    // Номер страницы стикеров не переехал в коробки.
    expect(poolCalls.filter(url => url.includes('boxPool')).every(url => url.includes('page=0'))).toBe(true);
    // Пока пул коробок грузится, в форме нет диапазона стикеров.
    expect(screen.queryByDisplayValue('1000')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('1999')).not.toBeInTheDocument();
    expect(screen.queryByText('1000 — 1999')).not.toBeInTheDocument();
  });
});
