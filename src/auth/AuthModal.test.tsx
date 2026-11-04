import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import { AuthModal } from './AuthModal';
import { rootStore } from '../stores/root-store';

// Виджет Telegram грузит скрипт с telegram.org — в jsdom его нет, а провайдеры OAuth читаются с сервера.
vi.mock('./TelegramLogin', () => ({ TelegramLogin: () => <div>Telegram-виджет</div> }));
vi.mock('../api/client', () => ({ api: vi.fn(async () => ({ providers: [{ id: 'yandex', title: 'Яндекс ID' }, { id: 'mailru', title: 'Mail.ru' }] })) }));

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><MemoryRouter><ToastProvider><AuthModal /></ToastProvider></MemoryRouter></QueryClientProvider>,
  );
}

describe('модалка входа', () => {
  beforeEach(() => {
    rootStore.auth.setTestUser(null);
    rootStore.ui.closeAuth();
  });

  it('закрыта, пока ui.authModal пуст; открывается со входом и рядом внешних входов', async () => {
    renderModal();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rootStore.ui.openAuth('login');
    expect(await screen.findByRole('dialog', { name: 'Вход в кабинет' })).toBeInTheDocument();
    expect(screen.getByLabelText('Электронная почта')).toBeInTheDocument();
    expect(screen.getByLabelText('Пароль')).toHaveAttribute('type', 'password');
    expect(screen.getByText('Telegram-виджет')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Войти через Яндекс ID' })).toHaveAttribute('href', '/api/auth/oauth/yandex/start?next=%2Fcabinet');
    expect(screen.getByRole('link', { name: 'Войти через Mail.ru' })).toBeInTheDocument();
  });

  it('глазок показывает и прячет пароль', async () => {
    renderModal();
    rootStore.ui.openAuth('login');
    const user = userEvent.setup();
    const field = await screen.findByLabelText('Пароль');
    await user.click(screen.getByRole('button', { name: 'Показать пароль' }));
    expect(field).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Скрыть пароль' }));
    expect(field).toHaveAttribute('type', 'password');
  });

  it('переключается на регистрацию и «забыли пароль» внутри окна, без внешних входов в режиме восстановления', async () => {
    renderModal();
    rootStore.ui.openAuth('login');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Создать аккаунт' }));
    expect(await screen.findByRole('dialog', { name: 'Создать аккаунт' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Я принимаю/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '← Вернуться ко входу' }));
    await user.click(await screen.findByRole('button', { name: 'Забыли пароль?' }));
    expect(await screen.findByRole('dialog', { name: 'Восстановление пароля' })).toBeInTheDocument();
    expect(screen.queryByText('Telegram-виджет')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Пароль')).not.toBeInTheDocument();
  });

  it('ошибка OAuth с сервера показывается текстом, внешние входы ведут в from', async () => {
    renderModal();
    rootStore.ui.openAuth('login', { from: '/tarify', oauthError: 'denied' });
    expect(await screen.findByText(/Вход отменён на стороне сервиса/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Войти через Яндекс ID' })).toHaveAttribute('href', '/api/auth/oauth/yandex/start?next=%2Ftarify');
  });

  it('закрывается крестиком и сбрасывает состояние стора', async () => {
    renderModal();
    rootStore.ui.openAuth('register');
    const user = userEvent.setup();
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(rootStore.ui.authModal).toBeNull());
  });
});
