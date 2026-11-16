import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { LinuxInstall, PlatformCards } from './LinuxInstall';
import { LINUX_INSTALL_COMMAND } from '../lib/downloads';

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('Помощник ПВЗ для Linux на странице программы', () => {
  it('команда дословная, «Копировать» кладёт её в буфер и показывает «Скопировано»', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    wrap(<PlatformCards downloadUrl="/dl/setup.exe" />);

    expect(screen.getByText(LINUX_INSTALL_COMMAND)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Скачать бесплатно/ })).toHaveAttribute('href', '/dl/setup.exe');

    await user.click(screen.getByRole('button', { name: 'Скопировать команду' }));
    expect(writeText).toHaveBeenCalledWith('curl -fsSL https://shk-wb.ru/dl/linux.sh | sh');
    expect(await screen.findByText('Скопировано')).toBeInTheDocument();
  });

  it('без IntersectionObserver терминал сразу показывает весь вывод, со сноской про ссылку', () => {
    const { container } = wrap(<LinuxInstall />);
    const term = container.querySelector('[data-terminal-output]') as HTMLElement;
    expect(within(term).getByText('Открываю браузер…')).toBeInTheDocument();
    expect(within(term).getByText('http://127.0.0.1:47815/?t=…')).toBeInTheDocument();
    expect(screen.getByText('Браузер откроется сам')).toBeInTheDocument();
    // в выводе нет номера пункта и номера версии
    expect(term.textContent).not.toMatch(/пункт \d|версия \d|версию \d/);
  });
});
