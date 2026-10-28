import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PricingPacks } from './PricingPacks';

function renderBlock() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><PricingPacks /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('тарифы генерации', () => {
  it('показывает поштучные пакеты и фиксированную цену пачки', () => {
    renderBlock();
    expect(screen.getByText('от 3 ₽')).toBeInTheDocument();
    expect(screen.getByText('20 ₽')).toBeInTheDocument();
    expect(screen.getByText('Пачка из 50 кодов · один PDF')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('по клику на тариф сразу показывает способ оплаты', async () => {
    const user = userEvent.setup();
    renderBlock();
    await user.click(screen.getByRole('button', { name: /от 3 ₽/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Способ оплаты');
    expect(screen.getByRole('dialog')).toHaveTextContent('7,50 ₽');
    expect(screen.getByText('Банковская карта или СБП')).toBeInTheDocument();
  });

  it('пересчитывает итог при выборе пакета 100 генераций', async () => {
    const user = userEvent.setup();
    renderBlock();
    await user.click(screen.getByRole('button', { name: /от 3 ₽/ }));
    await user.click(screen.getByRole('radio', { name: /100 шт/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent('300 ₽');
    expect(screen.getByRole('dialog')).toHaveTextContent('3 ₽ / шт. · −60%');
  });
});
