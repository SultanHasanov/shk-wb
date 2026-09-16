import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  Accordion,
  Button,
  EmptyState,
  Field,
  Input,
  Pagination,
  Progress,
  Segmented,
  Tabs,
} from '.';

describe('UI kit', () => {
  it('показывает кнопку', () => {
    render(<Button>Сохранить</Button>);
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
  });

  it('показывает пустое состояние', () => {
    render(<EmptyState />);
    expect(screen.getByText('Данных пока нет')).toBeInTheDocument();
  });

  it('блокирует кнопку на время загрузки', () => {
    render(<Button loading>Сохранить</Button>);
    const button = screen.getByRole('button', { name: 'Сохранить' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('связывает поле с ошибкой и помечает его невалидным', () => {
    render(
      <Field label="Почта" error="Введите корректную почту">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText('Почта');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Введите корректную почту');
  });

  it('переключает значение Segmented', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [value, setValue] = useState<'product' | 'box'>('product');
      return (
        <Segmented
          label="Тип стикера"
          value={value}
          onChange={setValue}
          options={[
            { value: 'product', label: 'Товары' },
            { value: 'box', label: 'QR коробок' },
          ]}
        />
      );
    }

    render(<Harness />);
    const product = screen.getByRole('radio', { name: 'Товары' });
    const box = screen.getByRole('radio', { name: 'QR коробок' });

    expect(product).toHaveAttribute('aria-checked', 'true');
    expect(box).toHaveAttribute('aria-checked', 'false');

    await user.click(box);

    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(product).toHaveAttribute('aria-checked', 'false');
  });

  const TABS = [
    { value: 'a', label: 'Первая', content: <p>Первое содержимое</p> },
    { value: 'b', label: 'Вторая', content: <p>Второе содержимое</p> },
    { value: 'c', label: 'Третья', content: <p>Третье содержимое</p> },
  ];

  it('показывает содержимое активной вкладки', async () => {
    const user = userEvent.setup();
    render(<Tabs label="Разделы" items={TABS} />);

    expect(screen.getByText('Первое содержимое')).toBeInTheDocument();
    expect(screen.queryByText('Второе содержимое')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Вторая' }));

    expect(screen.getByText('Второе содержимое')).toBeInTheDocument();
    expect(screen.queryByText('Первое содержимое')).not.toBeInTheDocument();
  });

  it('переключает вкладки стрелками и зацикливает их', async () => {
    const user = userEvent.setup();
    render(<Tabs label="Разделы" items={TABS} />);

    // Roving tabindex: в таблист Tab-ом заходят один раз, дальше — стрелки
    await user.tab();
    expect(screen.getByRole('tab', { name: 'Первая' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Вторая' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Третья' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Первая' })).toHaveAttribute('aria-selected', 'true');
  });

  it('скрывает пагинацию, когда страница всего одна', () => {
    const { container } = render(<Pagination page={1} pages={1} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('блокирует стрелки пагинации на краях диапазона', () => {
    render(<Pagination page={1} pages={3} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Предыдущая страница' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Следующая страница' })).toBeEnabled();
  });

  it('не выходит за границы шкалы прогресса', () => {
    render(<Progress value={140} max={100} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar.firstElementChild).toHaveStyle({ width: '100%' });
  });

  it('раскрывает ответ аккордеона', async () => {
    const user = userEvent.setup();
    render(<Accordion items={[{ q: 'Вопрос', a: 'Ответ' }]} />);

    const summary = screen.getByText('Вопрос');
    expect(summary.closest('details')).not.toHaveAttribute('open');

    await user.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
  });
});
