import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { RequireAuth } from './RequireAuth';
import { rootStore } from '../stores/root-store';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>Главная</div>} />
        <Route element={<RequireAuth />}>
          <Route path="/cabinet" element={<div>Кабинет</div>} />
          <Route path="/cabinet/keys" element={<div>Ключи</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('гард кабинета', () => {
  beforeEach(() => {
    rootStore.auth.setTestUser(null);
    rootStore.ui.closeAuth();
  });

  it('не пускает неавторизованного: уводит на главную и открывает модалку входа с возвратом', () => {
    renderAt('/cabinet?order=1');
    expect(screen.getByText('Главная')).toBeInTheDocument();
    expect(screen.queryByText('Кабинет')).not.toBeInTheDocument();
    expect(rootStore.ui.authModal).toEqual({ mode: 'login', from: '/cabinet?order=1', oauthError: undefined });
  });

  it('закрывает и вложенные маршруты', () => {
    renderAt('/cabinet/keys');
    expect(screen.getByText('Главная')).toBeInTheDocument();
    expect(screen.queryByText('Ключи')).not.toBeInTheDocument();
    expect(rootStore.ui.authModal?.from).toBe('/cabinet/keys');
  });

  it('пропускает вошедшего и модалку не открывает', () => {
    rootStore.auth.setTestUser({ email: 'user@example.com' } as never);
    renderAt('/cabinet');
    expect(screen.getByText('Кабинет')).toBeInTheDocument();
    expect(rootStore.ui.authModal).toBeNull();
  });
});
