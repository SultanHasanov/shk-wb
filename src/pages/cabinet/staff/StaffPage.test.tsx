import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../ui';
import { StaffPage } from './StaffPage';

const POINT = '33333333-3333-4333-8333-333333333333';
const staffDoc = { staff_list: [{ id: 's1', name: 'Анна Соколова', last4: '', sid: '', phone: '', rates: [{ from: '2026-01-01', rate: 2500 }] }], staff: {} };
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

  it('щелчок по дню ставит смену и сохраняет график со сверкой версии', async () => {
    const user = userEvent.setup();
    renderPage();
    const cell = await screen.findByRole('button', { name: 'Анна Соколова, 10 ноября: смены нет' });
    expect(screen.getByRole('button', { name: /Анна Соколова, 3 ноября: смена, 9:00–21:00/ })).toBeInTheDocument();
    fireEvent.pointerDown(cell, { button: 0 });
    fireEvent.pointerUp(window);
    expect(await screen.findByRole('button', { name: /Анна Соколова, 10 ноября: смена/ })).toBeInTheDocument();
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

  it('правку с компьютера пункта не затирает: сливает и сохраняет обе', async () => {
    putStatus = 409;
    renderPage();
    const cell = await screen.findByRole('button', { name: 'Анна Соколова, 12 ноября: смены нет' });
    fireEvent.pointerDown(cell, { button: 0 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(puts()).toHaveLength(2), { timeout: 3000 });
    const second = puts()[1].body;
    expect(second.base).toBe(8);
    expect(second.data.shifts['2026-11-12']).toEqual([{ staffId: 's1', kind: 'full' }]);
    expect(second.data.shifts['2026-11-20']).toEqual([{ staffId: 's1', kind: 'half' }]);
    expect(await screen.findByRole('button', { name: /Анна Соколова, 20 ноября: полсмены утром/ })).toBeInTheDocument();
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
