import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';

/** Веб-версия «Помощника ПВЗ» (server/_pvz-web.js): вход в WB по аккаунту сайта, ячейки, поиск клиента, код клиента. */
export type WbPoint = { id: number; name: string };
export type WbState =
  | { state: 'none' }
  | { state: 'await_code'; phoneTail: string }
  | { state: 'await_point'; points: WbPoint[] }
  | { state: 'ready'; points: WbPoint[]; pointId: number | null };
export type PvzWebStatus = { allowed: boolean; wb: WbState; codeViaBot: boolean };

export type PvzGood = { title: string; brand: string; size: string; color: string; nm: number | null; shk: string; price: number | null; days: number | null };
export type PvzCell = { cell: string; sid: string; name: string; tail: string; days: number | null; goods: PvzGood[] };
export type PvzGoods = { pointId: number; loadedAt: string; cells: PvzCell[]; goodsCount: number };

export type MatchReason = 'cell' | 'sid' | 'shk' | 'phone';
export type ClientMatch = { sid: string; cells: string[]; name: string; tail: string; why: MatchReason[] };
export type ChargePreview = { kind: 'free' | 'quota' | 'pack' | 'wallet' | 'unknown'; line: string };
export type ClientQr = { sid: string; cell: string; image: string; spent: string; next: ChargePreview | null };

const BASE = '/api/cabinet/pvz-web';
export const pvzWebKey = ['cabinet', 'pvz-web'] as const;
const statusKey = [...pvzWebKey, 'status'] as const;
const goodsKey = [...pvzWebKey, 'goods'] as const;

const post = <T,>(op: string, body?: unknown) => api<T>(`${BASE}/${op}`, { method: 'POST', body: JSON.stringify(body ?? {}) });

/** Вход в WB закончился (или его ещё не было) — показать экран входа, а не ошибку. */
export function isWbLoginRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'WB_LOGIN_REQUIRED';
}

export function usePvzWebStatus() {
  return useQuery({ queryKey: statusKey, queryFn: () => api<PvzWebStatus>(`${BASE}/status`), staleTime: 30_000 });
}

export function usePvzGoods(enabled: boolean) {
  return useQuery({
    queryKey: goodsKey,
    queryFn: () => api<PvzGoods>(`${BASE}/goods`),
    enabled,
    staleTime: 120_000,
    // вход в WB слетел — повтор не поможет, нужен экран входа
    retry: (count, error) => !isWbLoginRequired(error) && count < 1,
  });
}

/** Действия со входом в WB: ответ сервера сразу кладём в статус, товары прежнего пункта забываем. */
export function useWbAction<Body>(op: 'wb-login' | 'wb-code' | 'wb-point' | 'wb-logout') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Body) => post<{ wb: WbState }>(op, body),
    onSuccess: ({ wb }) => {
      client.setQueryData<PvzWebStatus>(statusKey, prev => (prev ? { ...prev, wb } : prev));
      client.removeQueries({ queryKey: goodsKey });
    },
  });
}

/** «Обновить»: список товаров мимо памяти сервера. */
export function useRefreshGoods() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<PvzGoods>(`${BASE}/goods?fresh=1`),
    onSuccess: data => client.setQueryData(goodsKey, data),
  });
}

export function searchClients(q: string) {
  return post<{ q: string; matches: ClientMatch[] }>('search', { q });
}

export function searchClientsByPhoto(image: string) {
  return post<{ codes: string[]; matches: ClientMatch[] }>('search-photo', { image });
}

export function useChargePreview(enabled: boolean) {
  return useQuery({ queryKey: [...pvzWebKey, 'charge'], queryFn: () => api<ChargePreview>(`${BASE}/charge`), enabled, staleTime: 0, gcTime: 0 });
}

export function issueClientQr(body: { sid: string; cell?: string }) {
  return post<ClientQr>('qr', body);
}
