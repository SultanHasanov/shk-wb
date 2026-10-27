import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PackagesPage } from './PackagesPage';

const bootstrap = {
  profile: { userId: 'user-1', email: 'user@example.com', telegramOnly: false, displayName: '', phone: '', payerStatus: 'individual', registeredAt: '2026-08-01T00:00:00Z', lastSignInAt: null, telegram: null, preferences: { thermalPrintSettings: {}, notifyOrderStatus: true, notifyKeyExpiry: true, notifyLowBalance: false, notifyProductNews: true, historyImportedAt: null, historyImportedCount: 0, historyImportNoticeDismissedAt: null } },
  assets: [], orders: [], notifications: [], unreadNotifications: 0,
  referral: { code: 'CODE', link: '', availableKopecks: 0, reservedKopecks: 0, earnedKopecks: 0, paidKopecks: 0, invited: 0, events: [], withdrawals: [] },
  overview: { activeKeys: 0, stickersLeft: 0, stickersTotal: 0, needsAttention: 0 },
  wallet: { balanceKopecks: 8150, discountAvailable: true, ledger: [{ kind: 'admin', amountKopecks: 8100, orderId: null, note: 'legacy_stickers_conversion', createdAt: '2026-11-01T00:00:00Z' }] },
};

let paymentBody: Record<string, unknown> | null;
const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  paymentBody = null;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/payments/create')) {
      paymentBody = JSON.parse(String(init?.body));
      return json({ error: 'stop before redirect' }, 400);
    }
    return json(bootstrap);
  }));
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><PackagesPage /></MemoryRouter></QueryClientProvider>);
}

describe('баланс генератора в кабинете', () => {
  it('показывает баланс, конвертацию и разовую скидку', async () => {
    renderPage();
    expect(await screen.findByText('81,50 ₽')).toBeInTheDocument();
    expect(screen.getByText('Конвертация старого пакета')).toBeInTheDocument();
    expect(screen.getByText(/разовую скидку 20%/)).toBeInTheDocument();
  });

  it('принимает пополнение с копейками от 20 рублей', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByRole('textbox', { name: 'Сумма пополнения, ₽' });
    await user.clear(input);
    await user.type(input, '20,50');
    await user.click(screen.getByRole('button', { name: 'Пополнить баланс' }));
    await waitFor(() => expect(paymentBody).not.toBeNull());
    expect(paymentBody).toMatchObject({ productKind: 'wallet_topup', walletAmount: 20.5, returnTo: 'cabinet' });
  });
});
