import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PricingPacks } from './PricingPacks';

function renderBlock() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><PricingPacks /></MemoryRouter></QueryClientProvider>);
}

describe('новые тарифы генерации', () => {
  it('показывает две фиксированные цены вместо пакетов', () => {
    renderBlock();
    expect(screen.getByText('7,50 ₽')).toBeInTheDocument();
    expect(screen.getByText('20 ₽')).toBeInTheDocument();
    expect(screen.getByText('Пачка из 50 кодов · один PDF')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('ведёт на пополнение общего баланса', () => {
    renderBlock();
    expect(screen.getByRole('link', { name: 'Пополнить баланс' })).toHaveAttribute('href', '/cabinet/packages');
  });
});
