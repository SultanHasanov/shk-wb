import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChipFilter, ConfirmDialog, NumberDialog, ResponsiveTable, TermPicker, parseBoundedInt } from '.';
import type { ResponsiveColumn } from '.';

describe('ConfirmDialog', () => {
  it('без причины кнопка выключена, с причиной — включается и передаёт её', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Завершить все сеансы?"
        confirmLabel="Завершить"
        tone="danger"
        requireReason
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Завершить' });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    // Одни пробелы — тоже «нет причины»
    await user.type(screen.getByLabelText('Причина для журнала *'), '   ');
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText('Причина для журнала *'), 'запрос владельца');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ reason: 'запрос владельца' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('удаление включается только при точном вводе почты', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Удалить аккаунт навсегда?"
        confirmLabel="Удалить навсегда"
        tone="danger"
        typeToConfirm="anna.s@example.ru"
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Удалить навсегда' });
    const input = screen.getByLabelText(/чтобы подтвердить/);
    await user.type(input, 'anna.s@example');
    expect(confirm).toBeDisabled();
    await user.type(input, '.ru');
    expect(confirm).toBeEnabled();
    await user.clear(input);
    await user.type(input, 'ANNA.S@example.ru');
    expect(confirm).toBeDisabled();
  });

  it('двойной клик — один вызов; ошибка остаётся в окне, окно не закрывается', async () => {
    let reject: (error: Error) => void = () => {};
    const onConfirm = vi.fn(() => new Promise((_, fail) => (reject = fail)));
    const onOpenChange = vi.fn();
    render(<ConfirmDialog open onOpenChange={onOpenChange} title="Отвязать Telegram?" confirmLabel="Отвязать" onConfirm={onConfirm} />);
    const confirm = screen.getByRole('button', { name: 'Отвязать' });
    // fireEvent — без ожидания перерисовки между кликами: так быстрее, чем успеет выключиться кнопка
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    reject(new Error('Запрос уже выполняется'));
    expect(await screen.findByText('Запрос уже выполняется')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: 'Отвязать' })).toBeEnabled();
  });
});

describe('NumberDialog', () => {
  it('разбор: только целые в границах', () => {
    expect(parseBoundedInt('30', 1, 3650)).toBe(30);
    expect(parseBoundedInt(' 7 ', 1, 3650)).toBe(7);
    expect(parseBoundedInt('0', 1, 3650)).toBeNull();
    expect(parseBoundedInt('3651', 1, 3650)).toBeNull();
    expect(parseBoundedInt('1.5', 1, 3650)).toBeNull();
    expect(parseBoundedInt('1e3', 1, 3650)).toBeNull();
    expect(parseBoundedInt('', 1, 3650)).toBeNull();
    expect(parseBoundedInt('15', 0, 100, 10)).toBeNull();
    expect(parseBoundedInt('20', 0, 100, 10)).toBe(20);
  });

  it('вне границ кнопка выключена; пресет подставляет число; превью и вызов', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <NumberDialog
        open
        onOpenChange={() => {}}
        title="Продлить лицензию"
        label="Дней"
        min={1}
        max={3650}
        presets={[
          { value: 30, label: '30 дней' },
          { value: 90, label: '90 дней' },
        ]}
        preview={value => <span>Новый срок: +{value}</span>}
        confirmLabel="Продлить"
        onConfirm={onConfirm}
      />,
    );
    const input = screen.getByLabelText('Дней');
    const confirm = screen.getByRole('button', { name: 'Продлить' });
    expect(confirm).toBeDisabled();

    await user.type(input, '0');
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, '3651');
    expect(confirm).toBeDisabled();
    expect(screen.getByText('Целое число от 1 до 3650')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '90 дней' }));
    expect(input).toHaveValue(90);
    expect(screen.getByRole('button', { name: '90 дней' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Новый срок: +90')).toBeInTheDocument();
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(90, { reason: '' });
  });

  it('с обязательной причиной без неё не отправляет', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <NumberDialog open onOpenChange={() => {}} title="Генерации" label="Сколько" min={1} max={100} initial={10} requireReason confirmLabel="Добавить" onConfirm={onConfirm} />,
    );
    const confirm = screen.getByRole('button', { name: 'Добавить' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Причина для журнала *'), 'компенсация');
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(10, { reason: 'компенсация' });
  });
});

type Row = { id: string; name: string; balance: string };
const columns: ResponsiveColumn<Row>[] = [
  { key: 'name', header: 'Пользователь', primary: true, cell: row => row.name },
  { key: 'balance', header: 'Баланс', align: 'end', cell: row => row.balance },
  { key: 'extra', header: <span>Иконка</span>, label: 'Доп.', hideOnMobile: true, cell: () => '—' },
];

describe('ResponsiveTable', () => {
  it('ставит data-label каждой ячейке и делает строку ссылкой', () => {
    render(
      <MemoryRouter>
        <ResponsiveTable
          rows={[
            { id: 'a', name: 'Анна', balance: '120 ₽' },
            { id: 'b', name: 'Олег', balance: '0 ₽' },
          ]}
          columns={columns}
          rowKey={row => row.id}
          rowHref={row => `/panel/users/${row.id}`}
          selectedKey="b"
          rowActions={row => <button type="button">Открыть {row.name}</button>}
        />
      </MemoryRouter>,
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const cells = within(rows[0]).getAllByRole('cell');
    expect(cells[0]).toHaveAttribute('data-label', 'Пользователь');
    expect(cells[1]).toHaveAttribute('data-label', 'Баланс');
    expect(cells[2]).toHaveAttribute('data-label', 'Доп.');
    expect(within(rows[0]).getByRole('link', { name: 'Анна' })).toHaveAttribute('href', '/panel/users/a');
    expect(rows[1]).toHaveAttribute('data-selected', 'true');
    expect(within(rows[1]).getByRole('button', { name: 'Открыть Олег' })).toBeInTheDocument();
  });

  it('пусто и загрузка — разные состояния', () => {
    const { rerender } = render(
      <ResponsiveTable rows={[]} columns={columns} rowKey={(row: Row) => row.id} empty={<p>Никого не нашли</p>} />,
    );
    expect(screen.getByText('Никого не нашли')).toBeInTheDocument();
    rerender(<ResponsiveTable rows={[]} columns={columns} rowKey={(row: Row) => row.id} loading skeletonRows={3} empty={<p>Никого не нашли</p>} />);
    expect(screen.queryByText('Никого не нашли')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
  });
});

describe('ChipFilter и TermPicker', () => {
  it('чип меняет значение и показывает счётчик', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState<'all' | 'paying' | 'restricted'>('all');
      return (
        <>
          <ChipFilter
            label="Фильтр"
            value={value}
            onChange={setValue}
            options={[
              { value: 'all', label: 'Все', count: 1284 },
              { value: 'paying', label: 'С покупками', count: 203 },
              { value: 'restricted', label: 'Ограничены', count: 4 },
            ]}
          />
          <output>{value}</output>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('radio', { name: /Все/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: /Ограничены/ }));
    expect(screen.getByRole('status')).toHaveTextContent('restricted');
    expect(screen.getByRole('radio', { name: /Ограничены/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('дата появляется только у пресета с датой', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState({ preset: 'forever', date: '' });
      return (
        <TermPicker
          value={value}
          onChange={setValue}
          presets={[
            { value: 'forever', label: 'Бессрочно' },
            { value: 'date', label: 'До даты' },
          ]}
          dateLabel="Действует до"
        />
      );
    }
    render(<Harness />);
    expect(screen.queryByLabelText('Действует до')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'До даты' }));
    expect(screen.getByLabelText('Действует до')).toHaveAttribute('type', 'date');
  });
});
