import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../ui';
import { RequireAdmin } from '../../layout/RequireAdmin';
import { AdminUserPage, AdminUsersPage } from '.';

const user = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'shop@example.com',
  emailConfirmed: true,
  telegramOnly: false,
  banned: false,
  createdAt: '2026-08-01T10:00:00Z',
  lastSignInAt: '2026-09-01T10:00:00Z',
  displayName: 'Иван',
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
};

const detail = {
  userId: user.userId,
  email: user.email,
  telegramOnly: false,
  emailConfirmed: true,
  banned: false,
  createdAt: user.createdAt,
  lastSignInAt: user.lastSignInAt,
  confirmValue: user.email,
  profile: { display_name: 'Иван', phone: '+79990000000', payer_status: 'individual' },
  telegram: null,
  codes: [
    {
      id: 7,
      code: '481902',
      name: 'Пакет',
      active: true,
      limit: 100,
      used: 40,
      createdAt: user.createdAt,
    },
  ],
  programKeys: [],
  cellLicenses: [],
  orders: [],
  referral: {
    code: 'ADE1CB',
    availableKopecks: 5000,
    earnedKopecks: 5000,
    paidKopecks: 0,
    invited: 1,
    referrals: [
      {
        userId: '22222222-2222-4222-8222-222222222222',
        email: 'friend@example.com',
        displayName: 'Друг',
        phone: null,
        registeredAt: '2026-08-02T10:00:00Z',
        attributedAt: '2026-08-02T10:00:00Z',
        paidOrders: 1,
        paidKopecks: 50000,
        refundedKopecks: 0,
        rewardedKopecks: 5000,
        reversedKopecks: 0,
        earnedKopecks: 5000,
        orders: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            status: 'succeeded',
            productKind: 'stickers',
            amountKopecks: 50000,
            grossKopecks: 50000,
            refundedKopecks: 0,
            createdAt: '2026-08-03T10:00:00Z',
            paidAt: '2026-08-03T10:01:00Z',
          },
        ],
      },
    ],
  },
  notifications: [],
  historyEntries: 0,
  actions: [],
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

beforeEach(() => {
  listCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('action=list')) {
        listCalls.push(url);
        return response({ items: [user], total: 1, page: 0, pageSize: 25 });
      }
      if (url.includes('action=detail')) return response(detail);
      if (url.includes('/api/admin/session')) return response(null, 204);
      return response({});
    }),
  );
});

function renderPage(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/panel/users/${user.userId}`]}>
        <ToastProvider>
          <Routes>
            <Route path="/panel/users/:userId" element={ui} />
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

  it('показывает найденных пользователей и их выручку', async () => {
    renderPage(<AdminUsersPage />);
    expect(await screen.findByText('shop@example.com')).toBeInTheDocument();
    expect(screen.getByText('40 из 100')).toBeInTheDocument();
  });

  // Поиск идёт по семи полям через ilike, поэтому запрос на каждую букву — это
  // прямая нагрузка на базу.
  it('откладывает запрос поиска, а не шлёт его на каждую букву', async () => {
    const typist = userEvent.setup();
    renderPage(<AdminUsersPage />);
    await screen.findByText('shop@example.com');
    listCalls = [];
    await typist.type(screen.getByRole('textbox'), 'иван');
    expect(listCalls).toHaveLength(0);
    await waitFor(() =>
      expect(listCalls.some(url => url.includes('q=%D0%B8%D0%B2%D0%B0%D0%BD'))).toBe(true),
    );
  });

  it('не даёт удалить аккаунт, пока почта не введена точно', async () => {
    const typist = userEvent.setup();
    renderPage(<AdminUserPage />);
    await typist.click(await screen.findByRole('button', { name: /Удалить аккаунт/ }));
    const confirmButton = await screen.findByRole('button', { name: /Удалить навсегда/ });
    expect(confirmButton).toBeDisabled();
    await typist.type(screen.getByRole('textbox'), 'shop@example.com');
    expect(confirmButton).toBeEnabled();
  });
});
