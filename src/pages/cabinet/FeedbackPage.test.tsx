import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../ui';
import { FeedbackPage } from './FeedbackPage';

// Виджет Telegram грузит скрипт с telegram.org — в тесте это кнопка, которая сразу «привязывает».
vi.mock('../../auth/TelegramLogin', () => ({
  TelegramLogin: ({ onSuccess }: { onSuccess?: () => void }) => <button type="button" onClick={() => onSuccess?.()}>Виджет Telegram</button>,
}));

const prefs = { thermalPrintSettings: {}, notifyOrderStatus: true, notifyKeyExpiry: true, notifyLowBalance: false, notifyProductNews: true, historyImportedAt: null, historyImportedCount: 0, historyImportNoticeDismissedAt: null };
const profile = (telegram: unknown) => ({ userId: 'u1', email: 'owner@example.ru', telegramOnly: false, displayName: 'Владелец', phone: '', payerStatus: 'individual', registeredAt: '2026-08-01T00:00:00Z', lastSignInAt: null, telegram, oauth: [], preferences: prefs });
const bootstrap = (telegram: unknown) => ({ profile: profile(telegram), assets: [], orders: [], notifications: [], unreadNotifications: 0, feedbackUnread: 0, referral: {}, overview: {}, wallet: {} });
const summary = { count30: 1, avg30: 2, unread: 1, kinds30: { thanks: 0, idea: 0, complaint: 1 }, ratings30: [0, 1, 0, 0, 0] };
const board = {
  id: '11111111-1111-4111-8111-111111111111', slug: 'K7M4PX2Q', url: 'https://shk-wb.ru/o/K7M4PX2Q', label: 'Стол выдачи', place: 'ПВЗ', address: 'ул. Ленина, 24',
  headline: 'Как вам наш пункт?', note: '', design: { format: 'a5', theme: 'fuchsia', color: '#cb11ab' }, notifyTelegram: true, notifyEmail: true, isActive: true,
  createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z', stats: { total30: 1, unread: 1 },
};
const entry = { id: '33333333-3333-4333-8333-333333333333', boardId: board.id, rating: 2, kind: 'complaint', comment: 'Долго искали заказ', photos: [], isRead: false, createdAt: '2026-11-15T11:00:00Z' };

let linked = false;
let boards: unknown[] = [];
const calls: { url: string; method: string; body: unknown }[] = [];

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  linked = false;
  boards = [];
  calls.length = 0;
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET');
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/api/cabinet/feedback/boards')) {
      if (method === 'POST') return json({ ...board, ...JSON.parse(String(init.body)) }, 201);
      return json({ items: boards, summary: boards.length ? summary : { ...summary, count30: 0, avg30: null, unread: 0, ratings30: [0, 0, 0, 0, 0] }, limit: 10 });
    }
    if (url.includes('/api/cabinet/feedback/entries')) {
      if (method === 'PATCH') return json({ updated: 1 });
      return json({ items: [entry], nextCursor: null });
    }
    return json(bootstrap(linked ? { first_name: 'Владелец', username: 'owner' } : null));
  }));
});
afterEach(() => vi.unstubAllGlobals());

function renderPage(path = '/cabinet/feedback') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><ToastProvider><FeedbackPage /></ToastProvider></MemoryRouter></QueryClientProvider>);
}

describe('Отзывы клиентов: конструктор QR', () => {
  it('без QR сразу открывает конструктор', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Отзывы клиентов' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Создать QR-код' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Печать/ })).toBeDisabled();
  });

  it('несохранённый QR переживает закрытие страницы — черновик восстанавливается', async () => {
    const user = userEvent.setup();
    const first = renderPage('/cabinet/feedback?tab=qr');
    const place = await screen.findByLabelText('Название на карточке');
    await user.type(place, 'ПВЗ на Ленина');
    await waitFor(() => expect(window.localStorage.getItem('shk:feedback-draft:u1:new')).toContain('ПВЗ на Ленина'));
    first.unmount();

    renderPage('/cabinet/feedback?tab=qr');
    expect(await screen.findByText(/Восстановили несохранённые изменения/)).toBeInTheDocument();
    expect(screen.getByLabelText('Название на карточке')).toHaveValue('ПВЗ на Ленина');
    await user.click(screen.getByRole('button', { name: 'Начать заново' }));
    expect(screen.getByLabelText('Название на карточке')).toHaveValue('');
    await waitFor(() => expect(window.localStorage.getItem('shk:feedback-draft:u1:new')).toBeNull());
  });

  it('Telegram не привязан — предлагает привязать и после привязки оставляет в конструкторе с тем же текстом', async () => {
    const user = userEvent.setup();
    renderPage('/cabinet/feedback?tab=qr');
    await user.type(await screen.findByLabelText('Адрес'), 'ул. Мира, 5');
    await user.click(screen.getByRole('button', { name: 'Привязать Telegram' }));
    linked = true;
    await user.click(await screen.findByRole('button', { name: 'Виджет Telegram' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Привязать Telegram' })).not.toBeInTheDocument());
    expect(screen.getByText('В наш бот, вместе с фото')).toBeInTheDocument();
    expect(screen.getByLabelText('Адрес')).toHaveValue('ул. Мира, 5');
  });

  it('выключенный Telegram не просит привязку', async () => {
    const user = userEvent.setup();
    renderPage('/cabinet/feedback?tab=qr');
    expect(await screen.findByRole('button', { name: 'Привязать Telegram' })).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Telegram' }));
    expect(screen.queryByRole('button', { name: 'Привязать Telegram' })).not.toBeInTheDocument();
  });

  it('создание QR отправляет форму и чистит черновик', async () => {
    const user = userEvent.setup();
    renderPage('/cabinet/feedback?tab=qr');
    await user.type(await screen.findByLabelText('Название на карточке'), 'ПВЗ');
    await user.click(screen.getByRole('button', { name: 'Создать QR-код' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/cabinet/feedback/boards'))).toBe(true));
    const post = calls.find(c => c.method === 'POST')!;
    expect(post.body).toMatchObject({ place: 'ПВЗ', headline: 'Как вам наш пункт?', design: { format: 'a5', theme: 'fuchsia' }, isActive: true });
    await waitFor(() => expect(window.localStorage.getItem('shk:feedback-draft:u1:new')).toBeNull());
    // Таймер автосохранения (300 мс) не должен вернуть черновик уже созданного QR.
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(window.localStorage.getItem('shk:feedback-draft:u1:new')).toBeNull();
  });
});

describe('Отзывы клиентов: входящие', () => {
  it('показывает отзыв и отмечает прочитанным', async () => {
    boards = [board];
    const user = userEvent.setup();
    renderPage('/cabinet/feedback');
    expect(await screen.findByText('Долго искали заказ')).toBeInTheDocument();
    expect(screen.getByText('Жалоба')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Прочитано' }));
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH' && (c.body as { id?: string })?.id === entry.id)).toBe(true));
  });
});
