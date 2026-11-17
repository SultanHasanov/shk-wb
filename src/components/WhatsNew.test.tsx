import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsNew } from './WhatsNew';
import { WHATS_NEW, readWhatsNewState, type WhatsNewEntry } from '../lib/whats-new';

// Окно проверяется на одной новости: новые записи в списке тест не ломают.
vi.mock('../lib/whats-new', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/whats-new')>();
  return { ...actual, WHATS_NEW: actual.WHATS_NEW.filter((n) => n.id === '2026-11-staff-quick') };
});

const OLD_ACCOUNT = '2026-08-01T10:00:00Z';
const first = WHATS_NEW[0];

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderNews(props: { userId?: string; createdAt?: string | null; entries?: WhatsNewEntry[] } = {}) {
  return render(
    <MemoryRouter initialEntries={['/cabinet']}>
      <WhatsNew userId={props.userId ?? 'u1'} createdAt={props.createdAt === undefined ? OLD_ACCOUNT : props.createdAt} entries={props.entries} />
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());

describe('окно «Что нового»', () => {
  it('показывает новость с пунктами, «Понятно» закрывает, повторный заход окно не показывает', async () => {
    const user = userEvent.setup();
    const { unmount } = renderNews();

    expect(screen.getByRole('dialog', { name: 'Что нового' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: first.title[0] })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(first.items.length);
    expect(screen.getByText(first.items[0][0])).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Понятно' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(readWhatsNewState('u1').seen).toEqual([first.id]);
    // адрес не менялся
    expect(screen.getByTestId('where')).toHaveTextContent('/cabinet');

    unmount();
    renderNews();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('«Открыть раздел» ведёт в раздел новости и тоже считается прочтением', async () => {
    const user = userEvent.setup();
    const { unmount } = renderNews();

    await user.click(screen.getByRole('button', { name: 'Открыть раздел' }));
    expect(screen.getByTestId('where')).toHaveTextContent(first.sections[0]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    unmount();
    renderNews();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('крестик и Esc — тоже «прочитано»', async () => {
    const user = userEvent.setup();
    const { unmount } = renderNews();
    await user.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(readWhatsNewState('u1').seen).toEqual([first.id]);
    unmount();

    renderNews({ userId: 'u2' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(readWhatsNewState('u2').seen).toEqual([first.id]);
  });

  it('новому аккаунту старую новость не показывает', () => {
    renderNews({ createdAt: '2027-01-10T08:00:00Z' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('у другого аккаунта в том же браузере окно своё', async () => {
    const user = userEvent.setup();
    const { unmount } = renderNews({ userId: 'u1' });
    await user.click(screen.getByRole('button', { name: 'Понятно' }));
    unmount();

    renderNews({ userId: 'u2' });
    expect(screen.getByRole('dialog', { name: 'Что нового' })).toBeInTheDocument();
  });

  it('несколько новостей: у каждой своя кнопка раздела, новость без раздела — без кнопки', async () => {
    const user = userEvent.setup();
    const entries: WhatsNewEntry[] = [
      { id: 'b', date: '2026-12-01', sections: ['/cabinet/keys'], title: ['Ключи', 'Кілттер'], items: [['Один', 'Бір']] },
      { id: 'a', date: '2026-11-20', sections: [], title: ['Общее', 'Жалпы'], items: [['Два', 'Екі']] },
    ];
    renderNews({ entries });

    expect(screen.getByRole('heading', { level: 3, name: 'Ключи' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Общее' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Открыть раздел' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Открыть раздел' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/cabinet/keys');
    expect(readWhatsNewState('u1').seen.sort()).toEqual(['a', 'b']);
  });

  it('localStorage недоступен — окно всё равно закрывается и не возвращается до перезагрузки', async () => {
    const user = userEvent.setup();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      const { rerender } = renderNews();
      await user.click(screen.getByRole('button', { name: 'Понятно' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      rerender(
        <MemoryRouter initialEntries={['/cabinet']}>
          <WhatsNew userId="u1" createdAt={OLD_ACCOUNT} />
          <Where />
        </MemoryRouter>,
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
