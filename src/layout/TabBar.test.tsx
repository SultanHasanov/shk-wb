import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QrCode, User } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { TabBar, type TabItem } from './TabBar';

// Таббар по умолчанию display:none (виден только в @media телефона, которого в
// jsdom нет), поэтому его элементы «скрыты» для дерева доступности — ищем их с
// hidden:true: проверяем разметку и пропсы, а не видимость на десктопе.
function renderBar(items: TabItem[], path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TabBar items={items} label="Навигация" />
    </MemoryRouter>,
  );
}

describe('TabBar', () => {
  it('ведёт на локализованные /kz-адреса, когда их передали пунктами', () => {
    renderBar([
      { key: 'gen', to: '/kz', end: true, label: 'Генератор', Icon: QrCode },
      { key: 'program', to: '/kz/program', label: 'Помощник', Icon: QrCode },
    ]);
    expect(screen.getByRole('link', { name: 'Генератор', hidden: true })).toHaveAttribute('href', '/kz');
    expect(screen.getByRole('link', { name: 'Помощник', hidden: true })).toHaveAttribute('href', '/kz/program');
  });

  it('показывает «Кабинет» для вошедшего и «Войти» для гостя', () => {
    const { unmount } = renderBar([{ key: 'account', to: '/cabinet', label: 'Кабинет', Icon: User }]);
    expect(screen.getByRole('link', { name: 'Кабинет', hidden: true })).toHaveAttribute('href', '/cabinet');
    unmount();

    renderBar([{ key: 'account', to: '/login', label: 'Войти', Icon: User }]);
    expect(screen.getByRole('link', { name: 'Войти', hidden: true })).toHaveAttribute('href', '/login');
  });

  it('рисует заглушку того же места без ссылки, пока сессия проверяется', () => {
    renderBar([{ key: 'account', label: 'Войти', Icon: User, placeholder: true }]);
    // Заглушка не кликабельна: ни ссылки, ни кнопки — просто ячейка с подписью.
    expect(screen.queryByRole('link', { hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByText('Войти')).toBeInTheDocument();
  });

  it('«Ещё» — это кнопка со счётчиком непрочитанных и обработчиком', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderBar([{ key: 'more', label: 'Ещё', Icon: User, onClick, badge: 3, ariaLabel: 'Ещё, непрочитанных: 3' }]);

    const button = screen.getByRole('button', { name: 'Ещё, непрочитанных: 3', hidden: true });
    expect(button).toHaveTextContent('3');
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('не рисует бейдж, когда непрочитанных нет', () => {
    renderBar([{ key: 'more', label: 'Ещё', Icon: User, onClick: () => {}, badge: 0 }]);
    expect(screen.getByRole('button', { name: 'Ещё', hidden: true })).not.toHaveTextContent('0');
  });
});
