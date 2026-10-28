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
    { type: 'program', id: 1, key: 'WBPK-AAAA-BBBB-CCCC', label: 'Пакет подборов', active: true, createdAt: '2026-08-01T00:00:00Z', used: 2, total: 5 },
    { type: 'cell_print', id: 2, key: 'CP-DDDD-EEEE-FFFF', label: 'Печать ячеек', active: true, createdAt: '2026-08-01T00:00:00Z', durationDays: 30, deviceLimit: 5, activatedAt: '2026-08-02T00:00:00Z', expiresAt: '2026-09-02T00:00:00Z', devices: [1, 2, 3].map(id => ({ id, name: `Устройство ${id}`, firstSeenAt: '2026-08-02T00:00:00Z', lastSeenAt: '2026-08-03T00:00:00Z' })) },
  ],
  orders: [], notifications: [], unreadNotifications: 0,
  referral: { code: 'CODE', link: '', availableKopecks: 5000, reservedKopecks: 0, earnedKopecks: 5000, paidKopecks: 0, invited: 0, events: [], withdrawals: [] },
  overview: { activeKeys: 2, stickersLeft: 0, stickersTotal: 0, needsAttention: 0 },
};

let paymentBody: Record<string, unknown> | null;
let claimBody: Record<string, unknown> | null;
let claimed: boolean;
function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  paymentBody = null;
  claimBody = null;
  claimed = false;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/cabinet/assets/claim')) {
      claimBody = JSON.parse(String(init?.body));
      claimed = true;
      return json({ ok: true }, 201);
    }
    if (String(input).includes('/api/payments/create')) {
      paymentBody = JSON.parse(String(init?.body));
      return json({ error: 'Тестовая остановка перед переходом в ЮKassa' }, 400);
    }
    if (claimed) {
      const extra = { ...bootstrap.assets[1], id: 3, key: 'CP-GGGG-HHHH-JJJJ', devices: [] };
      return json({ ...bootstrap, assets: [...bootstrap.assets, extra] });
    }
    return json(bootstrap);
  }));
});

function renderPage(path = '/cabinet/keys') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><ToastProvider><KeysPage /></ToastProvider></MemoryRouter></QueryClientProvider>);
}

describe('покупка и продление ключей в кабинете', () => {
  it('показывает бесплатное скачивание обеих программ и покупку новых ключей', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Пакеты подборов' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Печать ячеек' })).toBeInTheDocument();
    // Сами программы больше не продаются: у обеих карточек только скачивание.
    expect(screen.queryByRole('button', { name: 'Купить программу' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Скачать программу' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Купить (пакет|новый ключ)/ }).length).toBeGreaterThan(0);
  });

  it('ключи в интерфейсе маскированы, полный ключ не показывается', async () => {
    renderPage();
    expect(await screen.findByText('CP-••••-••••-FFFF')).toBeInTheDocument();
    expect(screen.getByText('WBPK-••••-••••-CCCC')).toBeInTheDocument();
    expect(screen.queryByText('CP-DDDD-EEEE-FFFF')).not.toBeInTheDocument();
    expect(screen.queryByText('WBPK-AAAA-BBBB-CCCC')).not.toBeInTheDocument();
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

  it('позволяет купить ключ только для Ozon и передаёт выбранные права серверу', async () => {
    const user = userEvent.setup();
    renderPage();
    const buyButtons = await screen.findAllByRole('button', { name: /Купить (пакет|новый ключ)/ });
    await user.click(buyButtons[1]);
    await user.click(screen.getByRole('button', { name: 'Ozon' }));
    await user.click(screen.getByRole('checkbox', { name: /Принимаю/ }));
    await user.click(screen.getByRole('button', { name: 'Перейти к оплате' }));
    await waitFor(() => expect(paymentBody).not.toBeNull());
    expect(paymentBody).toMatchObject({
      productKind: 'cell_print_license',
      marketplaceScope: 'ozon',
      durationDays: 30,
      deviceLimit: 1,
      returnTo: 'cabinet',
    });
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

  it('ссылка из программы ?renew= сразу открывает продление своего ключа', async () => {
    const user = userEvent.setup();
    renderPage('/cabinet/keys?renew=cp-dddd-eeee-ffff');
    await user.click(await screen.findByRole('checkbox', { name: /Принимаю/ }));
    await user.click(screen.getByRole('button', { name: 'Перейти к оплате' }));
    await waitFor(() => expect(paymentBody).not.toBeNull());
    expect(paymentBody).toMatchObject({ productKind: 'cell_print_license', renewalTargetKey: 'CP-DDDD-EEEE-FFFF' });
    expect(claimBody).toBeNull();
  });

  it('ключ без аккаунта: сначала подтверждение привязки, потом продление', async () => {
    const user = userEvent.setup();
    renderPage('/cabinet/keys?renew=CP-GGGG-HHHH-JJJJ');
    // Чужой/ничейный ключ не привязывается молча — сначала подтверждение в модалке.
    await user.click(await screen.findByRole('button', { name: 'Привязать и продлить' }));
    await waitFor(() => expect(claimBody).toEqual({ kind: 'cell_print', value: 'CP-GGGG-HHHH-JJJJ' }));
    await user.click(await screen.findByRole('checkbox', { name: /Принимаю/ }));
    await user.click(screen.getByRole('button', { name: 'Перейти к оплате' }));
    await waitFor(() => expect(paymentBody).not.toBeNull());
    expect(paymentBody).toMatchObject({ productKind: 'cell_print_license', renewalTargetKey: 'CP-GGGG-HHHH-JJJJ' });
  });

  it('отмена подтверждения не привязывает чужой ключ', async () => {
    const user = userEvent.setup();
    renderPage('/cabinet/keys?renew=CP-GGGG-HHHH-JJJJ');
    await user.click(await screen.findByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Привязать и продлить' })).not.toBeInTheDocument());
    expect(claimBody).toBeNull();
    expect(paymentBody).toBeNull();
  });
});
