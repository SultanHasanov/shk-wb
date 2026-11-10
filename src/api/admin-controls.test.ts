import { createElement } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAccountAction,
  useAdminUserSection,
  useClearOverrides,
  useLiftRestriction,
  useMessageTargets,
  useRestrict,
  useSendMessage,
  useSetOverrides,
  useUpdateRestriction,
  useWalletAdjust,
} from './admin-controls';

const USER = '11111111-1111-4111-8111-111111111111';
const KEY = '0f1e2d3c-4b5a-4968-8776-655443322110';

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let reply: unknown = {};
let status = 200;

beforeEach(() => {
  calls = [];
  reply = {};
  status = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Promise.resolve(new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } }));
    }),
  );
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, invalidate, wrapper };
}

function invalidatedKeys(spy: ReturnType<typeof setup>['invalidate']) {
  return spy.mock.calls.map(call => JSON.stringify((call[0] as { queryKey: unknown }).queryKey));
}

const EXPECTED_INVALIDATION = [
  JSON.stringify(['admin', 'users', 'detail', USER]),
  JSON.stringify(['admin', 'users']),
  JSON.stringify(['admin', 'audit']),
  JSON.stringify(['admin', 'attention']),
];

describe('мутации карточки: адрес, метод, тело и что освежают', () => {
  const cases: Array<{ name: string; action: string; hook: () => { mutateAsync: (body: never) => Promise<unknown> }; body: Record<string, unknown> }> = [
    {
      name: 'setOverrides',
      action: 'setOverrides',
      hook: useSetOverrides,
      body: { userId: USER, reason: 'второй пункт', idempotencyKey: KEY, slots: { devices: 2, points: 0, mirror: 0, until: null } },
    },
    { name: 'clearOverrides', action: 'clearOverrides', hook: useClearOverrides, body: { userId: USER, reason: 'сняли', idempotencyKey: KEY } },
    {
      name: 'walletAdjust',
      action: 'walletAdjust',
      hook: useWalletAdjust,
      body: { userId: USER, direction: 'credit', amountKopecks: 50000, comment: 'Компенсация', reason: 'сбой', notify: true, idempotencyKey: KEY },
    },
    {
      name: 'restrict',
      action: 'restrict',
      hook: useRestrict,
      body: { userId: USER, scopes: ['purchases', 'withdrawals'], until: '2026-11-17T18:00:00+03:00', reason: 'спор', notify: false, idempotencyKey: KEY },
    },
    {
      name: 'updateRestriction',
      action: 'updateRestriction',
      hook: useUpdateRestriction,
      body: { userId: USER, restrictionId: 'r-1', reason: 'продлили', until: null, idempotencyKey: KEY },
    },
    {
      name: 'liftRestriction',
      action: 'liftRestriction',
      hook: useLiftRestriction,
      body: { userId: USER, restrictionId: 'r-1', reason: 'решено', notify: true, idempotencyKey: KEY },
    },
    {
      name: 'message',
      action: 'message',
      hook: useSendMessage,
      body: { userId: USER, channels: ['cabinet', 'pc'], subject: 'Тема', body: 'Текст', deviceIds: ['d1'], idempotencyKey: KEY },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const { wrapper, invalidate } = setup();
      const { result } = renderHook(() => testCase.hook(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync(testCase.body as never);
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ url: `/api/admin/data?resource=users&action=${testCase.action}`, method: 'POST', body: testCase.body });
      expect(invalidatedKeys(invalidate)).toEqual(EXPECTED_INVALIDATION);
    });
  }

  it('useAccountAction шлёт POST users&action=<имя>', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () => ({ logout: useAccountAction('logoutAll'), role: useAccountAction('setDeviceRole'), oauth: useAccountAction('unlinkOAuth') }),
      { wrapper },
    );
    await act(async () => {
      await result.current.logout.mutateAsync({ userId: USER, reason: 'утечка пароля' });
      await result.current.role.mutateAsync({ userId: USER, deviceId: 'd1', role: 'work' });
      await result.current.oauth.mutateAsync({ userId: USER, provider: 'yandex', reason: 'просьба' });
    });
    expect(calls.map(c => [c.url, c.method])).toEqual([
      ['/api/admin/data?resource=users&action=logoutAll', 'POST'],
      ['/api/admin/data?resource=users&action=setDeviceRole', 'POST'],
      ['/api/admin/data?resource=users&action=unlinkOAuth', 'POST'],
    ]);
    expect(calls[1].body).toEqual({ userId: USER, deviceId: 'd1', role: 'work' });
  });

  it('ошибка сервера доходит с кодом, без инвалидации', async () => {
    status = 409;
    reply = { error: 'Уже ограничен', code: 'ALREADY_RESTRICTED', restrictionId: 'r-1' };
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useRestrict(), { wrapper });
    await expect(
      result.current.mutateAsync({ userId: USER, scopes: ['all'], until: null, reason: 'x', idempotencyKey: KEY }),
    ).rejects.toMatchObject({ status: 409, code: 'ALREADY_RESTRICTED', message: 'Уже ограничен' });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('запросы карточки', () => {
  it('раздел по вкладке: GET detailSection', async () => {
    reply = { balanceKopecks: 32000, ledger: [] };
    const { wrapper } = setup();
    const { result } = renderHook(() => useAdminUserSection(USER, 'wallet'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls).toEqual([
      { url: `/api/admin/data?resource=users&action=detailSection&userId=${USER}&section=wallet`, method: 'GET', body: undefined },
    ]);
    expect(result.current.data).toEqual({ balanceKopecks: 32000, ledger: [] });
  });

  it('раздел не грузится, пока вкладка закрыта', async () => {
    const { wrapper } = setup();
    renderHook(() => useAdminUserSection(USER, 'usage', false), { wrapper });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);
  });

  it('каналы сообщения: GET messageTargets только при открытом окне', async () => {
    reply = { cabinet: { available: true } };
    const { wrapper } = setup();
    const { rerender, result } = renderHook(({ open }) => useMessageTargets(USER, open), { wrapper, initialProps: { open: false } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);
    rerender({ open: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toEqual({ url: `/api/admin/data?resource=users&action=messageTargets&userId=${USER}`, method: 'GET', body: undefined });
  });
});
