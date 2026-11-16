import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';

/** Раздел «Сотрудники» (server/_staff.js): документы staff и schedule пунктов — те же, что у «Помощника ПВЗ». */
export type StaffPoint = { id: string; name: string; wbPointId: string };
export type StaffDocRow = { version: number; data: unknown; updatedAt: string; fromSite: boolean } | null;
export type StaffPointDocs = { point: StaffPoint; staff: StaffDocRow; schedule: StaffDocRow };
export type StaffLink = { token: string; url: string; shortNames: boolean; showSubs: boolean; createdAt: string };
export type StaffHistoryItem = { version: number; at: string | null; by: string; current: boolean };

export const staffKey = ['cabinet', 'staff'] as const;

export function useStaffPoints() {
  return useQuery({
    queryKey: [...staffKey, 'points'],
    queryFn: () => api<{ allowed: boolean; points: StaffPoint[] }>('/api/cabinet/staff'),
    staleTime: 60_000,
  });
}

export function fetchPointDocs(pointId: string) {
  return api<StaffPointDocs>(`/api/cabinet/staff?point=${encodeURIComponent(pointId)}`);
}

export function putStaffDoc(body: { key: 'staff' | 'schedule'; point: string; base: number; data: unknown; confirmEmpty?: boolean }) {
  return api<{ version: number }>('/api/cabinet/staff', { method: 'PUT', body: JSON.stringify(body) });
}

/** Тело ответа 409 (VERSION_CONFLICT / EMPTY_GUARD) — сервер кладёт туда текущую версию. */
export function conflictCurrent(error: unknown): StaffDocRow | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  return (error.details?.current as StaffDocRow | undefined) ?? undefined;
}

export function useStaffAll(enabled: boolean) {
  return useQuery({
    queryKey: [...staffKey, 'all'],
    queryFn: () => api<{ points: StaffPointDocs[] }>('/api/cabinet/staff/all'),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useStaffHistory(pointId: string, key: 'staff' | 'schedule') {
  return useQuery({
    queryKey: [...staffKey, 'history', pointId, key],
    queryFn: () => api<{ items: StaffHistoryItem[] }>(`/api/cabinet/staff/history?point=${encodeURIComponent(pointId)}&key=${key}`),
  });
}

export function useRestoreStaffVersion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (b: { point: string; key: 'staff' | 'schedule'; version: number }) =>
      api<{ version: number; data: unknown }>('/api/cabinet/staff/history', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => client.invalidateQueries({ queryKey: staffKey }),
  });
}

export function useStaffLink(pointId: string) {
  return useQuery({
    queryKey: [...staffKey, 'link', pointId],
    queryFn: () => api<{ link: StaffLink | null }>(`/api/cabinet/staff/link?point=${encodeURIComponent(pointId)}`),
  });
}

export function useIssueStaffLink(pointId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (b: { shortNames: boolean; showSubs: boolean } | null) =>
      b
        ? api<{ link: StaffLink | null }>('/api/cabinet/staff/link', { method: 'POST', body: JSON.stringify({ point: pointId, ...b }) })
        : api<{ link: StaffLink | null }>(`/api/cabinet/staff/link?point=${encodeURIComponent(pointId)}`, { method: 'DELETE' }),
    onSuccess: data => client.setQueryData([...staffKey, 'link', pointId], data),
  });
}

// ── страница сотрудника по ссылке (без входа) ──

export type PublicSchedule = {
  point: string;
  months: string[];
  dayHours: { from: string; to: string };
  people: { k: string; name: string }[];
  days: Record<string, { k: string; h: string; sub?: string }[]>;
  owner: string[];
  updatedAt: string | null;
};

export function usePublicSchedule(token: string) {
  return useQuery({
    queryKey: ['staff-public', token],
    queryFn: async () => {
      let response: Response;
      try {
        response = await fetch(`/api/staff/public/${encodeURIComponent(token)}`, { credentials: 'omit' });
      } catch {
        throw new ApiError('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.', 0, 'NETWORK');
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiError(body.error || 'Не удалось открыть график', response.status, body.code);
      return body as PublicSchedule;
    },
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
    refetchInterval: 5 * 60_000,
  });
}
