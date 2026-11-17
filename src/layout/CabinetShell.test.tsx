import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CabinetShell } from './CabinetShell';
import { rootStore } from '../stores/root-store';
import { WHATS_NEW, readWhatsNewState } from '../lib/whats-new';

// Механика окна и метки проверяется на одной новости про «Сотрудников»: новые записи в списке тест не ломают.
vi.mock('../lib/whats-new', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/whats-new')>();
  const list = actual.WHATS_NEW.filter((n) => n.id === '2026-11-staff-quick');
  // функции модуля берут список по умолчанию изнутри — подставляем его явно
  return {
    ...actual,
    WHATS_NEW: list,
    entriesForAccount: (c: string | null | undefined, e = list) => actual.entriesForAccount(c, e),
    unseenEntries: (s: Parameters<typeof actual.unseenEntries>[0], c: string | null, e = list) => actual.unseenEntries(s, c, e),
    newSections: (s: Parameters<typeof actual.newSections>[0], now: Date, e = list) => actual.newSections(s, now, e),
    markOpened: (s: Parameters<typeof actual.markOpened>[0], p: string, e = list) => actual.markOpened(s, p, e),
  };
});

const news = WHATS_NEW[0];
const bootstrap = {
  profile: { userId: 'u-old', email: 'user@example.com', displayName: 'Иван' },
  assets: [],
  orders: [],
  notifications: [],
  unreadNotifications: 0,
  feedbackUnread: 0,
  partner: null,
  wallet: null,
};

function response(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

function renderShell(path = '/cabinet', data: Record<string, unknown> = bootstrap) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (String(input).includes('/api/cabinet/bootstrap') ? response(data) : response({}))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<CabinetShell />}>
            <Route path="/cabinet" element={<h1>Страница обзора</h1>} />
            <Route path="/cabinet/staff" element={<h1>Страница сотрудников</h1>} />
            <Route path="/cabinet/keys" element={<h1>Страница ключей</h1>} />
            <Route path="/cabinet/payment-result" element={<h1>Страница оплаты</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const staffLink = () => screen.getByRole('link', { name: /^Сотрудники/, hidden: true });

describe('кабинет: «Что нового» и метка new в меню', () => {
  beforeEach(() => {
    localStorage.clear();
    // Метка живёт 14 дней от даты новости — фиксируем «сегодня» на следующий день после неё.
    // Подменяем только Date: таймеры нужны react-query и userEvent настоящими.
    vi.useFakeTimers({ toFake: ['Date'] });
    const [y, m, d] = news.date.split('-').map(Number);
    vi.setSystemTime(new Date(y, m - 1, d + 1, 12));
    rootStore.ui.closeMobile();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rootStore.auth.setTestUser(null);
  });

  it('давний аккаунт: окно один раз, метка у раздела держится до его открытия', async () => {
    rootStore.auth.setTestUser({ id: 'u-old', email: 'user@example.com', created_at: '2026-08-01T10:00:00Z' } as never);
    const user = userEvent.setup();
    const { unmount } = renderShell('/cabinet');

    // окно появляется после загрузки кабинета
    expect(await screen.findByRole('dialog', { name: 'Что нового' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: news.title[0] })).toBeInTheDocument();
    expect(within(staffLink()).getByText('new')).toBeInTheDocument();
    // с телефона «Сотрудники» только за «Ещё» — там отметка «есть новое»
    expect(screen.getByRole('button', { name: 'Ещё, есть новое', hidden: true })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Понятно' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // окно закрыто, а метка остаётся: раздел ещё не открывали
    expect(within(staffLink()).getByText('new')).toBeInTheDocument();
    expect(readWhatsNewState('u-old')).toEqual({ seen: [news.id], opened: {} });

    // другой раздел метку не снимает
    await user.click(screen.getByRole('link', { name: 'Ключи и доступы' }));
    expect(await screen.findByRole('heading', { name: 'Страница ключей' })).toBeInTheDocument();
    expect(within(staffLink()).getByText('new')).toBeInTheDocument();

    await user.click(staffLink());
    expect(await screen.findByRole('heading', { name: 'Страница сотрудников' })).toBeInTheDocument();
    await waitFor(() => expect(within(staffLink()).queryByText('new')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Ещё', hidden: true })).toBeInTheDocument();
    expect(readWhatsNewState('u-old')).toEqual({ seen: [news.id], opened: { '/cabinet/staff': news.id } });

    // следующий заход: ни окна, ни метки
    unmount();
    renderShell('/cabinet');
    expect(await screen.findByRole('heading', { name: 'Страница обзора' })).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(staffLink()).queryByText('new')).not.toBeInTheDocument();
  });

  it('«Открыть раздел» из окна ведёт в раздел и сразу снимает метку', async () => {
    rootStore.auth.setTestUser({ id: 'u-old', email: 'user@example.com', created_at: '2026-08-01T10:00:00Z' } as never);
    const user = userEvent.setup();
    renderShell('/cabinet');

    await user.click(await screen.findByRole('button', { name: 'Открыть раздел' }));
    expect(await screen.findByRole('heading', { name: 'Страница сотрудников' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(within(staffLink()).queryByText('new')).not.toBeInTheDocument());
    expect(readWhatsNewState('u-old')).toEqual({ seen: [news.id], opened: { '/cabinet/staff': news.id } });
  });

  it('новый аккаунт (зарегистрирован после новости): ни окна, ни метки', async () => {
    const [y, m, d] = news.date.split('-').map(Number);
    rootStore.auth.setTestUser({ id: 'u-new', email: 'new@example.com', created_at: new Date(Date.UTC(y, m - 1, d + 1, 8)).toISOString() } as never);
    renderShell('/cabinet', { ...bootstrap, wallet: { balanceKopecks: 12300 } });

    // баланс в шапке виден — значит, кабинет уже загрузился и окно показалось бы
    expect(await screen.findByText('Пополнить')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(staffLink()).queryByText('new')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ещё', hidden: true })).toBeInTheDocument();
  });

  it('счётчик непрочитанных на «Ещё» важнее точки «есть новое»', async () => {
    rootStore.auth.setTestUser({ id: 'u-old', email: 'user@example.com', created_at: '2026-08-01T10:00:00Z' } as never);
    renderShell('/cabinet', { ...bootstrap, unreadNotifications: 3 });

    expect(await screen.findByRole('dialog', { name: 'Что нового' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ещё, непрочитанных: 3', hidden: true })).toHaveTextContent('3');
  });

  it('на странице результата оплаты окно не всплывает, но метка в меню есть', async () => {
    rootStore.auth.setTestUser({ id: 'u-old', email: 'user@example.com', created_at: '2026-08-01T10:00:00Z' } as never);
    renderShell('/cabinet/payment-result', { ...bootstrap, wallet: { balanceKopecks: 12300 } });

    expect(await screen.findByText('Пополнить')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(staffLink()).getByText('new')).toBeInTheDocument();
    expect(readWhatsNewState('u-old').seen).toEqual([]);
  });
});
