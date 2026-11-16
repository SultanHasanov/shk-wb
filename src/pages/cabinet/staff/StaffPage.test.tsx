import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
let putStatus = 200;
const calls: { url: string; method: string; body: any }[] = [];

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
  allowed = true;
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
      return json({ point: { id: POINT, name: 'Ленина, 14', wbPointId: '317162' }, staff: { version: 3, data: staffDoc, updatedAt: '', fromSite: false }, schedule: { version: 7, data: scheduleDoc, updatedAt: '', fromSite: false } });
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
});
