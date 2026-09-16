import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../ui';
import { KeysPage } from './KeysPage';

const bootstrap = {
  profile: { userId: 'user-1', email: 'user@example.com', telegramOnly: false, displayName: '', phone: '', payerStatus: 'individual', registeredAt: '2026-08-01T00:00:00Z', lastSignInAt: null, telegram: null, preferences: { thermalPrintSettings: {}, notifyOrderStatus: true, notifyKeyExpiry: true, notifyLowBalance: false, notifyProductNews: true, historyImportedAt: null, historyImportedCount: 0, historyImportNoticeDismissedAt: null } },
  assets: [
    { type: 'program', id: 1, key: 'WBPK-AAAA-BBBB-CCCC', label: 'Подбор кодов', active: true, createdAt: '2026-08-01T00:00:00Z', used: 2, total: 5 },
    { type: 'cell_print', id: 2, key: 'CP-DDDD-EEEE-FFFF', label: 'Печать ячеек', active: true, createdAt: '2026-08-01T00:00:00Z', durationDays: 30, deviceLimit: 5, activatedAt: '2026-08-02T00:00:00Z', expiresAt: '2026-09-02T00:00:00Z', devices: [1, 2, 3].map(id => ({ id, name: `Устройство ${id}`, firstSeenAt: '2026-08-02T00:00:00Z', lastSeenAt: '2026-08-03T00:00:00Z' })) },
  ],
  orders: [], notifications: [], unreadNotifications: 0,
  referral: { code: 'CODE', link: '', availableKopecks: 5000, reservedKopecks: 0, earnedKopecks: 5000, paidKopecks: 0, invited: 0, events: [], withdrawals: [] },
  overview: { activeKeys: 2, stickersLeft: 0, stickersTotal: 0, needsAttention: 0 },
};

let paymentBody: Record<string, unknown> | null;
function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  paymentBody = null;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/payments/create')) {
      paymentBody = JSON.parse(String(init?.body));
      return json({ error: 'Тестовая остановка перед переходом в ЮKassa' }, 400);
    }
    return json(bootstrap);
  }));
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><ToastProvider><KeysPage /></ToastProvider></MemoryRouter></QueryClientProvider>);
}

describe('покупка и продление ключей в кабинете', () => {
  it('показывает бесплатное скачивание обеих программ и покупку новых ключей', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Подбор кодов' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Печать ячеек' })).toBeInTheDocument();
    // Сами программы больше не продаются: у обеих карточек только скачивание.
    expect(screen.queryByRole('button', { name: 'Купить программу' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Скачать программу' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Купить новый ключ' })).toHaveLength(2);
  });

  it('передаёт серверу ключ пополнения и возврат в кабинет', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Пополнить итерации' }));
    await user.click(screen.getByRole('checkbox', { name: /Принимаю/ }));
    await user.click(screen.getByRole('button', { name: 'Перейти к оплате' }));
    await waitFor(() => expect(paymentBody).not.toBeNull());
    expect(paymentBody).toMatchObject({
      productKind: 'program_license',
      renewalTargetKey: 'WBPK-AAAA-BBBB-CCCC',
      returnTo: 'cabinet',
      licenseIterations: 5,
    });
    expect(await screen.findByText('Тестовая остановка перед переходом в ЮKassa')).toBeInTheDocument();
  });

  it('не разрешает выбрать лимит ниже числа активных устройств', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Продлить' }));
    const deviceSelect = screen.getByRole('combobox', { name: 'Количество компьютеров' });
    const options = Array.from(deviceSelect.querySelectorAll('option'));
    expect(options.find(option => option.value === '1')).toBeDisabled();
    expect(options.find(option => option.value === '2')).toBeDisabled();
    expect(options.find(option => option.value === '3')).not.toBeDisabled();
  });
});
