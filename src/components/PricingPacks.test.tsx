import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import { PricingPacks } from './PricingPacks';

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
      return json({});
    }),
  );
});

function renderBlock() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <PricingPacks />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function pay(user: ReturnType<typeof userEvent.setup>, email: string | null = 'buyer@example.com') {
  await user.click(screen.getByRole('checkbox', { name: /Принимаю/ }));
  const open = screen.getAllByRole('button', { name: 'Перейти к оплате' });
  await user.click(open[open.length - 1]);
  if (email) await user.type(screen.getByRole('textbox', { name: /Электронная почта/ }), email);
  const confirm = screen.getAllByRole('button', { name: 'Перейти к оплате' });
  await user.click(confirm[confirm.length - 1]);
  await waitFor(() => expect(paymentBody).not.toBeNull());
}

describe('покупка пакетов генераций', () => {
  it('покупает популярный пакет одним числом', async () => {
    const user = userEvent.setup();
    renderBlock();
    await pay(user);
    expect(paymentBody).toMatchObject({
      productKind: 'stickers',
      quantity: 200,
      returnTo: 'public',
      email: 'buyer@example.com',
    });
    // Пул общий, тип и режим на цену не влияют: если эти поля вернутся в тело
    // запроса, значит вернулось и разделение лимитов.
    expect(paymentBody).not.toHaveProperty('stickerTarget');
    expect(paymentBody).not.toHaveProperty('rangeQuantity');
  });

  it('оплачивает без почты: код появится на странице и применится сам', async () => {
    const user = userEvent.setup();
    renderBlock();
    await pay(user, null);
    expect(paymentBody).toMatchObject({ productKind: 'stickers', quantity: 200 });
    expect(paymentBody).not.toHaveProperty('email');
  });

  it('меняет пакет', async () => {
    const user = userEvent.setup();
    renderBlock();
    await user.click(screen.getByRole('radio', { name: /500 генераций/ }));
    await pay(user);
    expect(paymentBody).toMatchObject({ quantity: 500 });
  });

  it('не спрашивает, что печатать', async () => {
    renderBlock();
    expect(screen.queryByRole('radio', { name: 'QR для возвратных коробок' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Режим генерации' })).toBeNull();
  });
});
