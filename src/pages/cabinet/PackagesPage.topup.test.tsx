import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../ui';
import { PackagesPage } from './PackagesPage';

const bootstrap = {
  profile: {
    userId: 'user-1',
    email: 'user@example.com',
    telegramOnly: false,
    displayName: '',
    phone: '',
    payerStatus: 'individual',
    registeredAt: '2026-08-01T00:00:00Z',
    lastSignInAt: null,
    telegram: null,
    preferences: {
      thermalPrintSettings: {},
      notifyOrderStatus: true,
      notifyKeyExpiry: true,
      notifyLowBalance: false,
      notifyProductNews: true,
      historyImportedAt: null,
      historyImportedCount: 0,
      historyImportNoticeDismissedAt: null,
    },
  },
  assets: [
    {
      type: 'sticker',
      key: '481902',
      label: 'Пакет генераций',
      active: true,
      createdAt: '2026-08-01T00:00:00Z',
      limits: { used: 10, total: 200 },
    },
  ],
  orders: [],
  notifications: [],
  unreadNotifications: 0,
  referral: {
    code: 'CODE',
    link: '',
    availableKopecks: 0,
    reservedKopecks: 0,
    earnedKopecks: 0,
    paidKopecks: 0,
    invited: 0,
    events: [],
    withdrawals: [],
  },
  overview: { activeKeys: 1, stickersLeft: 190, stickersTotal: 200, needsAttention: 0 },
};

let paymentBody: Record<string, unknown> | null;
function json(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

beforeEach(() => {
  paymentBody = null;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/payments/create')) {
        paymentBody = JSON.parse(String(init?.body));
        return json({ error: 'Тестовая остановка перед переходом в ЮKassa' }, 400);
      }
      return json(bootstrap);
    }),
  );
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <PackagesPage />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('пакеты генераций в кабинете', () => {
  it('показывает один общий остаток без разбивки по типам', async () => {
    renderPage();
    expect(await screen.findByText('190')).toBeInTheDocument();
    expect(screen.getByText('10 из 200')).toBeInTheDocument();
    expect(screen.queryByText('Стикеры товаров · массово')).toBeNull();
    expect(screen.queryByText('QR коробок · массово')).toBeNull();
  });

  /* Пополнение кладёт генерации в тот же код: без него постоянный покупатель
     копит отдельные коды с остатками. */
  it('передаёт серверу код пополнения и возврат в кабинет', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Пополнить' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Количество генераций' }), '100');
    await user.click(screen.getByRole('checkbox', { name: /Принимаю/ }));
    await user.click(screen.getByRole('button', { name: 'Перейти к оплате' }));
    await waitFor(() => expect(paymentBody).not.toBeNull());
    expect(paymentBody).toMatchObject({
      productKind: 'stickers',
      renewalTargetKey: '481902',
      quantity: 100,
      returnTo: 'cabinet',
    });
  });
});
