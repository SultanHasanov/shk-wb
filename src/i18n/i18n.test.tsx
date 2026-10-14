import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundPage } from '../pages/NotFoundPage';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { localeForPath, localizePath, setLocalePreference, stripLocale } from '.';

afterEach(() => {
  localStorage.clear();
  setLocalePreference('ru');
  localStorage.clear();
});

describe('адреса языковых версий', () => {
  it('добавляет и снимает префикс /kz только у публичных страниц', () => {
    expect(localizePath('/', 'kk')).toBe('/kz');
    expect(localizePath('/program', 'kk')).toBe('/kz/program');
    expect(localizePath('/kz/program', 'ru')).toBe('/program');
    expect(localizePath('/kz', 'ru')).toBe('/');
    expect(localizePath('/#packages', 'kk')).toBe('/kz#packages');
    // Кабинет и вход не дублируются по языкам — язык там берётся из выбора.
    expect(localizePath('/cabinet/keys', 'kk')).toBe('/cabinet/keys');
    expect(localizePath('/login', 'kk')).toBe('/login');
    expect(stripLocale('/kz/cell-print')).toBe('/cell-print');
  });

  it('язык публичной страницы определяет адрес, а кабинета — сохранённый выбор', () => {
    expect(localeForPath('/kz/program', null)).toBe('kk');
    expect(localeForPath('/program', 'kk')).toBe('ru');
    expect(localeForPath('/cabinet', 'kk')).toBe('kk');
    expect(localeForPath('/cabinet', null)).toBe('ru');
    // /kzx — не казахская версия, а просто несуществующий адрес.
    expect(localeForPath('/kzx', null)).toBe('ru');
  });
});

function renderAt(path: string) {
  function Where() {
    return <span data-testid="where">{useLocation().pathname}</span>;
  }
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LanguageSwitch />
      <Where />
      <Routes>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('переключение языка', () => {
  it('показывает страницу по-казахски на /kz-адресе', () => {
    renderAt('/kz/nothing-here');
    expect(screen.getByRole('heading', { name: 'Мұндай бет жоқ' })).toBeInTheDocument();
  });

  it('ведёт на ту же страницу на другом языке и запоминает выбор', async () => {
    const user = userEvent.setup();
    renderAt('/nothing-here');
    expect(screen.getByRole('heading', { name: 'Такой страницы нет' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'KZ' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/kz/nothing-here');
    expect(screen.getByRole('heading', { name: 'Мұндай бет жоқ' })).toBeInTheDocument();
    expect(localStorage.getItem('locale')).toBe('kk');
  });
});
