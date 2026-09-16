import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { RequireAuth } from './RequireAuth';
import { rootStore } from '../stores/root-store';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>Экран входа</div>} />
        <Route element={<RequireAuth />}>
          <Route path="/cabinet" element={<div>Кабинет</div>} />
          <Route path="/cabinet/keys" element={<div>Ключи</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('гард кабинета', () => {
  beforeEach(() => rootStore.auth.setTestUser(null));

  it('не пускает неавторизованного в кабинет', () => {
    renderAt('/cabinet');
    expect(screen.getByText('Экран входа')).toBeInTheDocument();
    expect(screen.queryByText('Кабинет')).not.toBeInTheDocument();
  });

  it('закрывает и вложенные маршруты', () => {
    renderAt('/cabinet/keys');
    expect(screen.getByText('Экран входа')).toBeInTheDocument();
    expect(screen.queryByText('Ключи')).not.toBeInTheDocument();
  });

  it('пропускает вошедшего', () => {
    rootStore.auth.setTestUser({ email: 'user@example.com' } as never);
    renderAt('/cabinet');
    expect(screen.getByText('Кабинет')).toBeInTheDocument();
  });
});
