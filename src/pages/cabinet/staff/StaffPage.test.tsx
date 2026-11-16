import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../ui';
import { StaffPage } from './StaffPage';

const POINT = '33333333-3333-4333-8333-333333333333';
const staffDoc = { staff_list: [
  { id: 's1', name: 'Анна Соколова', last4: '', sid: '', phone: '', rates: [{ from: '2026-01-01', rate: 2500 }] },
  { id: 's2', name: 'Марина Ким', last4: '', sid: '', phone: '', rates: [{ from: '2026-01-01', rate: 2000 }] },
], staff: {} };
const scheduleDoc = { v: 1, shifts: { '2026-11-03': [{ staffId: 's1', kind: 'full' }] }, dayHours: { from: '09:00', to: '21:00' } };

let allowed = true;
// график, который отдаёт сервер: тесты подставляют свой
let schedule: Record<string, unknown> = scheduleDoc;
let putStatus = 200;
const calls: { url: string; method: string; body: any }[] = [];

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
  allowed = true;
  schedule = scheduleDoc;
  putStatus = 200;
  calls.length = 0;
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === '/api/cabinet/staff' && method === 'GET') return json({ allowed, points: [{ id: POINT, name: 'Ленина, 14', wbPointId: '317162' }] });
    if (url.startsWith('/api/cabinet/staff?point=')) {
      return json({ point: { id: POINT, name: 'Ленина, 14', wbPointId: '317162' }, staff: { version: 3, data: staffDoc, updatedAt: '', fromSite: false }, schedule: { version: 7, data: schedule, updatedAt: '', fromSite: false } });
    }
    if (url === '/api/cabinet/staff' && method === 'PUT') {
      if (putStatus === 409) {
        putStatus = 200;
        return json({ error: 'conflict', code: 'VERSION_CONFLICT', current: { version: 8, data: { ...scheduleDoc, shifts: { ...scheduleDoc.shifts, '2026-11-20': [{ staffId: 's1', kind: 'half' }] } } } }, 409);
      }
      return json({ version: body.base + 1 });
    }
    return json({});
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function renderPage(path = '/cabinet/staff') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><ToastProvider><StaffPage /></ToastProvider></MemoryRouter></QueryClientProvider>);
}

const puts = () => calls.filter(c => c.method === 'PUT');

describe('Сотрудники на сайте', () => {
  it('без тарифа — замок вместо графика', async () => {
    allowed = false;
    renderPage();
    expect(await screen.findByText('«Сотрудники» входят в тарифы «Стандарт» и «Про»')).toBeInTheDocument();
    expect(calls.some(c => c.url.includes('?point='))).toBe(false);
  });

  async function setShift(user: ReturnType<typeof userEvent.setup>, day: string, person: string, option: RegExp) {
    await user.click(await screen.findByRole('button', { name: new RegExp(`^${day}:`) }));
    await user.click(screen.getByRole('button', { name: `${person}: смена ${day}` }));
    fireEvent.pointerDown(screen.getByRole('option', { name: option }));
  }

  it('график — календарь: день открывается справа, смена выбирается из списка и сохраняется', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('button', { name: '3 ноября: Анна' })).toBeInTheDocument();
    // сегодня открыт сразу — не нужно гадать, куда нажимать
    expect(screen.getByRole('region', { name: 'Смены 16 ноября' })).toBeInTheDocument();
    await setShift(user, '10 ноября', 'Анна Соколова', /^Смена, 9:00–21:00/);
    expect(await screen.findByRole('button', { name: '10 ноября: Анна' })).toBeInTheDocument();
    await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    expect(puts()[0].body).toMatchObject({ key: 'schedule', point: POINT, base: 7 });
    expect(puts()[0].body.data.shifts['2026-11-10']).toEqual([{ staffId: 's1', kind: 'full' }]);
    expect(puts()[0].body.data.shifts['2026-11-03']).toEqual([{ staffId: 's1', kind: 'full' }]);
    expect(await screen.findByText(/Сохранено в/)).toBeInTheDocument();
    // отмена возвращает как было и тоже сохраняется
    await user.click(screen.getByRole('button', { name: /Отменить/ }));
    await waitFor(() => expect(puts()).toHaveLength(2), { timeout: 3000 });
    expect(puts()[1].body.base).toBe(8);
    expect(puts()[1].body.data.shifts['2026-11-10']).toBeUndefined();
  });

  it('второго человека в день не ставит молча: предупреждает и предлагает заменить или разрешить двоих', async () => {
    const user = userEvent.setup();
    renderPage();
    await setShift(user, '3 ноября', 'Марина Ким', /^Смена, 9:00–21:00/);
    const warn = await screen.findByRole('alert');
    expect(warn.textContent).toContain('уже работает: Анна');
    expect(warn.textContent).toContain('в пункте работает один человек');
    expect(puts()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Поставить вместо: Анна' }));
    await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    expect(puts()[0].body.data.shifts['2026-11-03']).toEqual([{ staffId: 's2', kind: 'full' }]);
    // «разрешить двоих» записывает настройку пункта и ставит обоих
    await setShift(user, '3 ноября', 'Анна Соколова', /^Полсмены утром/);
    await user.click(await screen.findByRole('button', { name: 'Разрешить двоих в день' }));
    await waitFor(() => expect(puts()).toHaveLength(2), { timeout: 3000 });
    expect(puts()[1].body.data.maxPerDay).toBe(2);
    expect(puts()[1].body.data.shifts['2026-11-03']).toEqual([{ staffId: 's2', kind: 'full' }, { staffId: 's1', kind: 'half' }]);
  });

  it('правку с компьютера пункта не затирает: сливает и сохраняет обе', async () => {
    putStatus = 409;
    const user = userEvent.setup();
    renderPage();
    await setShift(user, '12 ноября', 'Анна Соколова', /^Смена, 9:00–21:00/);
    await waitFor(() => expect(puts()).toHaveLength(2), { timeout: 3000 });
    const second = puts()[1].body;
    expect(second.base).toBe(8);
    expect(second.data.shifts['2026-11-12']).toEqual([{ staffId: 's1', kind: 'full' }]);
    expect(second.data.shifts['2026-11-20']).toEqual([{ staffId: 's1', kind: 'half' }]);
    expect(await screen.findByRole('button', { name: '20 ноября: Анна · утро' })).toBeInTheDocument();
  });

  it('выгрузка списком без сумм', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Выгрузить' }));
    await user.click(screen.getByRole('tab', { name: /Список текстом/ }));
    const text = await screen.findByText(/График: Ленина, 14/);
    expect(text.textContent).not.toContain('2500');
    expect(text.textContent).toContain('Пн 16: никого нет');
  });

  it('список у дня: нажатие на имя ставит смену, на другое — заменяет, «Убрать всех» очищает день', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^10 ноября:/ }));
    const menu = screen.getByRole('menu', { name: 'Кто работает 10 ноября' });
    expect(menu).toBeInTheDocument();
    await user.click(screen.getByRole('menuitemradio', { name: 'Марина Ким' }));
    // один человек в день — список закрывается сам, смена стоит
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '10 ноября: Марина' })).toBeInTheDocument();
    // другое имя — замена без вопросов
    await user.click(screen.getByRole('button', { name: '10 ноября: Марина' }));
    expect(screen.getByRole('menuitemradio', { name: 'Марина Ким' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('menuitemradio', { name: 'Анна Соколова' }));
    expect(await screen.findByRole('button', { name: '10 ноября: Анна' })).toBeInTheDocument();
    await waitFor(() => expect(puts().length).toBeGreaterThan(0), { timeout: 3000 });
    await waitFor(() => expect(puts()[puts().length - 1].body.data.shifts['2026-11-10']).toEqual([{ staffId: 's1', kind: 'full' }]), { timeout: 3000 });
    // «Я сам» и «Убрать всех»
    await user.click(screen.getByRole('button', { name: '10 ноября: Анна' }));
    await user.click(screen.getByRole('menuitem', { name: 'Убрать всех' }));
    expect(await screen.findByRole('button', { name: '10 ноября: никого нет' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '10 ноября: никого нет' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Я сам' }));
    expect(await screen.findByRole('button', { name: '10 ноября: владелец' })).toBeInTheDocument();
  });

  it('людей больше, чем в настройках: день помечен, в панели дня кнопки «Оставить только», в списке дел — прошедший день', async () => {
    schedule = { ...scheduleDoc, shifts: { '2026-11-02': [{ staffId: 's1', kind: 'full' }, { staffId: 's2', kind: 'full' }] } };
    const user = userEvent.setup();
    renderPage();
    const cell = await screen.findByRole('button', { name: '2 ноября: Анна, Марина, людей больше, чем разрешено: 2' });
    expect(cell.textContent).toContain('2 чел.');
    expect(screen.getByText(/Людей больше, чем разрешено в настройках \(один человек в день\): 2 ноября/)).toBeInTheDocument();
    await user.click(cell);
    const warn = await screen.findByRole('alert');
    expect(warn.textContent).toContain('В этот день в пункте двое: Анна, Марина');
    await user.click(screen.getByRole('button', { name: 'Оставить только: Марина' }));
    expect(await screen.findByRole('button', { name: '2 ноября: Марина' })).toBeInTheDocument();
    await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    expect(puts()[0].body.data.shifts['2026-11-02']).toEqual([{ staffId: 's2', kind: 'full' }]);
    expect(screen.queryByText(/Людей больше, чем разрешено/)).not.toBeInTheDocument();
  });

  it('оплаченная смена отмечена в календаре', async () => {
    schedule = { ...scheduleDoc, ledgerFrom: '2026-11', shifts: { '2026-11-03': [{ staffId: 's1', kind: 'full' }], '2026-11-05': [{ staffId: 's1', kind: 'full' }] },
      payments: [{ id: 'p1', staffId: 's1', date: '2026-11-10', type: 'salary', amount: 2500, method: 'cash', note: '' }] };
    renderPage();
    expect(await screen.findByRole('button', { name: '3 ноября: Анна · оплачено' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '5 ноября: Анна' })).toBeInTheDocument();
  });

  it('выплата из октября: сумма подставлена сама, записывается за октябрь; «Выплатить всем» тоже работает', async () => {
    schedule = { ...scheduleDoc, ledgerFrom: '2026-11', shifts: { '2026-10-05': [{ staffId: 's1', kind: 'full' }], '2026-10-06': [{ staffId: 's1', kind: 'full' }], '2026-10-07': [{ staffId: 's2', kind: 'full' }] } };
    const user = userEvent.setup();
    renderPage('/cabinet/staff?tab=payroll&month=2026-10');
    const pay = await screen.findAllByRole('button', { name: 'Выплатить' });
    await user.click(pay[0]);
    expect(await screen.findByRole('heading', { name: 'Выплата за октябрь 2026' })).toBeInTheDocument();
    expect(screen.getByLabelText('Сумма, ₽')).toHaveValue('5000');
    expect(screen.getByText(/за октябрь осталось выплатить 5 000 ₽/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Записать выплату 5\s000 ₽$/ }));
    await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    expect(puts()[0].body.data.payments).toHaveLength(1);
    expect(puts()[0].body.data.payments[0]).toMatchObject({ staffId: 's1', date: '2026-10-31', paidAt: '2026-11-16', type: 'salary', amount: 5000 });
    // всем сразу: у Анны уже выплачено, остаётся Марина
    await user.click(screen.getByRole('button', { name: 'Выплатить всем' }));
    expect(await screen.findByRole('heading', { name: 'Выплатить зарплату всем за октябрь 2026' })).toBeInTheDocument();
    expect(screen.getByLabelText('Сумма: Марина Ким')).toHaveValue('2000');
    await user.click(screen.getByRole('button', { name: /^Выплатить 2\s000 ₽$/ }));
    await waitFor(() => expect(puts()).toHaveLength(2), { timeout: 3000 });
    expect(puts()[1].body.data.payments[1]).toMatchObject({ staffId: 's2', date: '2026-10-31', paidAt: '2026-11-16', amount: 2000 });
  });

  it('мастер шаблона: день начала выбирается в мини-месяце, заполняются только отмеченные недели', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole('button', { name: 'Заполнить по шаблону' }))[0]);
    const anna = screen.getByRole('group', { name: 'Режим работы: Анна Соколова' });
    await user.click(within(anna).getByRole('button', { name: '2 через 2' }));
    await user.click(screen.getByRole('button', { name: '16 ноября: выходной' }));
    expect(screen.getByRole('button', { name: '16 ноября: работает, начало смены' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '17 ноября: работает' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '18 ноября: выходной' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Дальше' }));
    // сегодня 16 ноября: по умолчанию — с сегодня до конца месяца
    expect(screen.getByRole('button', { name: 'С сегодня до конца месяца' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Поставить смены: 8' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Заполнить неделю 23 – 29 ноября' }));
    await user.click(screen.getByRole('button', { name: 'Поставить смены: 4' }));
    await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    const data = puts()[0].body.data;
    expect(Object.keys(data.shifts).sort()).toEqual(['2026-11-03', '2026-11-16', '2026-11-17', '2026-11-20', '2026-11-21']);
    expect(data.shifts['2026-11-20']).toEqual([{ staffId: 's1', kind: 'full', auto: true }]);
    expect(data.templates.s1).toMatchObject({ kind: '2/2', start: '2026-10-31' });
  });
});
