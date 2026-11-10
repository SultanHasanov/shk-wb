import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError } from '../../api/admin';
import type { AdminAttention, AdminAuditPage, AdminSystem } from '../../api/admin';
import AdminRoutes from '../../app/AdminRoutes';
import { AdminShell } from '../../layout/AdminShell';
import { ToastProvider } from '../../ui';
import { DataState } from './kit';

const attention: AdminAttention = {
  generatedAt: '2026-11-10T11:00:00.000Z',
  withdrawals: { count: 3, amountKopecks: 240000, oldestAt: '2026-11-08T10:00:00.000Z' },
  stuckOrders: { count: 1, oldestAt: '2026-11-10T10:00:00.000Z' },
  stickerPool: { available: 312, threshold: 500, low: true },
  boxPool: { available: 9000, threshold: 500, low: false },
  failedDeliveries24h: { count: 2, byChannel: { email: 1, telegram: 1, pc: 0 } },
  restrictionsExpiringToday: {
    count: 1,
    items: [{ userId: '33333333-3333-4333-8333-333333333333', label: 'ivan.petrov@example.ru', until: '2026-11-10T15:00:00.000Z' }],
  },
  restrictedTotal: 4,
  subscriptions: { active: 87, expiring7: 9 },
  onlinePcs: 41,
  usersTotal: 1284,
  total: 5,
};

const auditPage: AdminAuditPage = {
  items: [
    {
      id: 41,
      createdAt: '2026-11-10T11:12:08.000Z',
      action: 'walletAdjust',
      category: 'money',
      danger: true,
      targetUserId: '11111111-1111-4111-8111-111111111111',
      target: { userId: '11111111-1111-4111-8111-111111111111', email: 'oleg.m@example.ru', displayName: null, telegramUsername: null },
      reason: 'компенсация за сбой 08.11',
      payload: { direction: 'credit', amountKopecks: 50000 },
      before: { balanceKopecks: 12000 },
      after: { balanceKopecks: 62000 },
      result: 'ok',
      adminFingerprint: 'abcdefabcdefa1f3',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36',
    },
  ],
  nextCursor: null,
  total: 1,
};

const system: AdminSystem = {
  generatedAt: '2026-11-10T11:00:00.000Z',
  cached: false,
  bot: {
    status: 'ok',
    processesUpdates: false,
    lastUpdateAgoSec: null,
    window: null,
    alerts: {
      updates: { active: false, sentAt: null },
      relay: { active: false, sentAt: null },
      webhook: { active: false, sentAt: null },
      'bot-node': { active: false, sentAt: null },
    },
  },
  relay: { status: 'ok', base: 'https://tg.shk-wb.ru:88', latencyMs: 34, error: null },
  webhook: null,
  botNode: { status: 'ok', url: 'https://tg.shk-wb.ru:88', latencyMs: 40, error: null, release: null },
  site: { status: 'ok', uptimeSec: 273_600, release: '2026-11-10_1412', role: 'site' },
  egress: { status: 'warning', note: 'Превышен лимит, отсрочка до 09.12' },
  disk: { status: 'ok', totalBytes: 40 * 1024 ** 3, freeBytes: 15.2 * 1024 ** 3, usedPercent: 62, alertFreeBytes: 6 * 1024 ** 3 },
  database: { status: 'ok', sizeBytes: 312 * 1024 ** 2, limitBytes: 524288000, alertBytes: 400 * 1024 ** 2 },
  backups: null,
  programs: { pvzHelper: { latest: '1.12.0', minVersion: '1.10.0', mandatory: false, devicesBelowMin: 6 }, cellPrint: { latest: '2.2.0', signed: true } },
  env: [
    { name: 'RESEND_API_KEY', value: 'задан' },
    { name: 'PVZ_APP_MIN_VERSION', value: '1.10.0' },
  ],
};

function response(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/admin/session')) return response(null, 204);
      if (url.includes('action=counts')) return response({ all: 1284, paying: 203, subscribed: 87, expiring: 9, unlimited: 2, restricted: 4, telegram: 300, inactive: 50, new30: 146 });
      if (url.includes('resource=attention')) return response(attention);
      if (url.includes('resource=audit')) return response(auditPage);
      if (url.includes('resource=deliveries')) return response({ items: [], nextCursor: null, stats24h: { sent: 41, failed: 2, notConfigured: 1, waitingPc: 1 } });
      if (url.includes('resource=system')) return response(system);
      if (url.includes('action=summary')) return response(null, 502);
      return response({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Нижняя панель телефона. По селектору: вне @media она display:none, и запросы по ролям её не видят. */
function tabBar(): HTMLElement | null {
  return document.querySelector<HTMLElement>('nav[aria-label="Главные разделы"]');
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderShell(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Routes>
            <Route path="/panel" element={<AdminShell />}>
              <Route index element={<div>обзор</div>} />
              <Route path="users" element={<div>список</div>} />
              <Route path="users/:userId" element={<div>карточка</div>} />
              <Route path="*" element={<div>раздел</div>} />
            </Route>
          </Routes>
          <LocationProbe />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderRoutes(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Routes>
            <Route path="/panel/*" element={<AdminRoutes />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('оболочка админки', () => {
  it('группы меню и пункты — как в макете', async () => {
    renderShell('/panel');
    const nav = screen.getByRole('navigation', { name: 'Разделы админки' });
    for (const group of ['Продукты', 'Деньги', 'Связь', 'Контроль']) {
      expect(within(nav).getByText(group)).toBeInTheDocument();
    }
    const expected: Array<[string, string]> = [
      ['Обзор', '/panel'],
      ['Пользователи', '/panel/users'],
      ['Помощник ПВЗ', '/panel/program'],
      ['ПВЗ Принт', '/panel/cell-print'],
      ['Коды генератора', '/panel/access-codes'],
      ['Пулы номеров', '/panel/sticker-pool'],
      ['Заказы и оплата', '/panel/payments'],
      ['Выплаты', '/panel/cabinet'],
      ['Партнёры', '/panel/partners'],
      ['Объявления', '/panel/announcements'],
      ['Рассылки', '/panel/broadcasts'],
      ['Журнал', '/panel/audit'],
      ['Система', '/panel/system'],
    ];
    for (const [label, href] of expected) {
      expect(within(nav).getByRole('link', { name: new RegExp(`^${label}`) })).toHaveAttribute('href', href);
    }
    // Бейджи: всего пользователей и заявки на выплату
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: /^Пользователи/ }).textContent?.replace(/\s/g, ' ')).toBe('Пользователи1 284'),
    );
    expect(within(within(nav).getByRole('link', { name: /^Выплаты/ })).getByText('3')).toBeInTheDocument();
  });

  it('«Пулы номеров» подсвечены и на коробках', () => {
    renderShell('/panel/box-pool');
    const nav = screen.getByRole('navigation', { name: 'Разделы админки' });
    expect(within(nav).getByRole('link', { name: /^Пулы номеров/ })).toHaveAttribute('aria-current', 'page');
  });

  // jsdom не применяет @media: панель в разметке есть всегда, а на десктопе её прячет
  // CSS (display: none) — поэтому ищем по селектору, а не по ролям.
  it('на узком экране есть нижняя панель «Обзор · Пользователи · Журнал · Ещё»', async () => {
    const user = userEvent.setup();
    renderShell('/panel');
    const bar = tabBar()!;
    const items = Array.from(bar.querySelectorAll<HTMLElement>('a, button'));
    expect(items.map(el => el.textContent?.replace(/\d+/g, '').trim())).toEqual(['Обзор', 'Пользователи', 'Журнал', 'Ещё']);
    expect(items.slice(0, 3).map(el => el.getAttribute('href'))).toEqual(['/panel', '/panel/users', '/panel/audit']);

    // «Ещё» — лист с остальными разделами; «Система» спрашивается только сейчас
    expect(calls.some(url => url.includes('resource=system'))).toBe(false);
    await user.click(items[3]);
    const sheet = screen.getByRole('dialog', { name: 'Все разделы' });
    expect(within(sheet).getByRole('link', { name: /Помощник ПВЗ/ })).toBeInTheDocument();
    expect(within(sheet).queryByRole('link', { name: /^Журнал/ })).not.toBeInTheDocument();
    expect(await within(sheet).findByText('Внимание')).toBeInTheDocument();
    expect(calls.some(url => url.includes('resource=system'))).toBe(true);
  });

  it('на карточке пользователя нижней панели нет', () => {
    renderShell('/panel/users/11111111-1111-4111-8111-111111111111');
    expect(screen.getByText('карточка')).toBeInTheDocument();
    expect(tabBar()).not.toBeInTheDocument();
    // а на списке — есть (проверка, что запрос выше вообще умеет её найти)
    cleanup();
    renderShell('/panel/users');
    expect(tabBar()!).toBeInTheDocument();
  });

  it('поиск в шапке: «/» ставит фокус, Enter ведёт в список пользователей', async () => {
    const user = userEvent.setup();
    renderShell('/panel');
    const input = screen.getByRole('searchbox', { name: 'Поиск пользователя' });
    await user.keyboard('/');
    expect(input).toHaveFocus();
    await user.type(input, 'anna@example.ru{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent('/panel/users?q=anna%40example.ru');
  });
});

describe('маршруты', () => {
  it('/panel/audit рендерит журнал', async () => {
    renderRoutes('/panel/audit');
    expect(await screen.findByRole('heading', { level: 1, name: 'Журнал' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Действия' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/Кошелёк: \+500/)).toBeInTheDocument();
    expect(screen.getByText('Опасное')).toBeInTheDocument();
  });

  it('/panel/audit?tab=deliveries — вкладка доставок', async () => {
    renderRoutes('/panel/audit?tab=deliveries&status=error');
    expect(await screen.findByText('Нет доставок с таким каналом и статусом')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Доставки/ })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(calls.some(url => url.includes('resource=deliveries') && url.includes('status=error'))).toBe(true));
  });

  it('/panel/system рендерит «Систему», пустые блоки не роняют страницу', async () => {
    renderRoutes('/panel/system');
    expect(await screen.findByRole('heading', { level: 1, name: 'Система' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Telegram-бот' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Вебхук Telegram' })).toBeInTheDocument();
    expect(screen.getByText('6 ПК на старых')).toBeInTheDocument();
    expect(screen.getByText('RESEND_API_KEY')).toBeInTheDocument();
  });

  it('обзор: «Требует внимания» из ответа сервера', async () => {
    renderRoutes('/panel');
    expect(await screen.findByText('3 заявки на выплату')).toBeInTheDocument();
    expect(screen.getByText('1 заказ завис в ожидании')).toBeInTheDocument();
    expect(screen.getByText('Заканчиваются номера стикеров')).toBeInTheDocument();
    expect(screen.queryByText('Заканчиваются номера коробок')).not.toBeInTheDocument();
    expect(screen.getByText('2 сообщения не доставлены')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ограничение истекает сегодня/ })).toHaveAttribute(
      'href',
      '/panel/users/33333333-3333-4333-8333-333333333333',
    );
    // Сводка упала (502) — честная ошибка, а не пустые нули
    expect(await screen.findAllByText('Не удалось загрузить данные')).not.toHaveLength(0);
  });
});

describe('DataState', () => {
  const base = { data: undefined as string[] | undefined, isPending: false, isError: false, error: null as unknown, refetch: vi.fn() };

  it('три разных состояния: загрузка, пусто, ошибка', async () => {
    const user = userEvent.setup();
    const children = (items: string[]) => <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>;
    const { rerender } = render(
      <DataState query={{ ...base, isPending: true }} isEmpty={items => items.length === 0} empty={<p>Пока ничего нет</p>}>
        {children}
      </DataState>,
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Пока ничего нет')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    rerender(
      <DataState query={{ ...base, data: [] }} isEmpty={items => items.length === 0} empty={<p>Пока ничего нет</p>}>
        {children}
      </DataState>,
    );
    expect(screen.getByText('Пока ничего нет')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const refetch = vi.fn();
    const error = new AdminApiError('Database request failed', { status: 502, code: null, data: null, path: '/api/admin/data?resource=audit&limit=50' });
    rerender(
      <DataState query={{ ...base, isError: true, error, refetch }} isEmpty={items => items.length === 0} empty={<p>Пока ничего нет</p>}>
        {children}
      </DataState>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Не удалось загрузить данные');
    expect(alert).toHaveTextContent('HTTP 502 · /api/admin/data?resource=audit');
    expect(screen.queryByText('Пока ничего нет')).not.toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(refetch).toHaveBeenCalledTimes(1);

    rerender(
      <DataState query={{ ...base, data: ['a', 'b'] }} isEmpty={items => items.length === 0} empty={<p>Пока ничего нет</p>}>
        {children}
      </DataState>,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
