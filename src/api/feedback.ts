import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';
import type { FeedbackDesign } from '../lib/feedback-card';

export type FeedbackKind = 'thanks' | 'idea' | 'complaint';
export type FeedbackFilter = 'all' | 'new' | FeedbackKind;

export type FeedbackBoard = {
  id: string;
  slug: string;
  url: string;
  label: string;
  place: string;
  address: string;
  headline: string;
  note: string;
  design: FeedbackDesign;
  notifyTelegram: boolean;
  notifyEmail: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  stats: { total30: number; unread: number };
};
export type FeedbackBoardInput = Pick<FeedbackBoard, 'label' | 'place' | 'address' | 'headline' | 'note' | 'design' | 'notifyTelegram' | 'notifyEmail' | 'isActive'>;
export type FeedbackSummary = {
  count30: number;
  avg30: number | null;
  unread: number;
  kinds30: Record<FeedbackKind, number>;
  ratings30: [number, number, number, number, number];
};
export type FeedbackEntry = {
  id: string;
  boardId: string;
  rating: number;
  kind: FeedbackKind;
  comment: string;
  photos: { id: string; url: string }[];
  isRead: boolean;
  createdAt: string;
};
export type PublicFeedbackBoard = {
  slug: string;
  place: string;
  address: string;
  headline: string;
  isActive: boolean;
  design: FeedbackDesign;
};

const boardsKey = ['cabinet', 'feedback', 'boards'] as const;

export function useFeedbackBoards() {
  return useQuery({
    queryKey: boardsKey,
    queryFn: () => api<{ items: FeedbackBoard[]; summary: FeedbackSummary; limit: number }>('/api/cabinet/feedback/boards'),
  });
}

export function useFeedbackEntries(filter: FeedbackFilter, board: string) {
  return useInfiniteQuery({
    queryKey: ['cabinet', 'feedback', 'entries', filter, board],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ filter, limit: '20' });
      if (board) params.set('board', board);
      if (pageParam) params.set('before', pageParam);
      return api<{ items: FeedbackEntry[]; nextCursor: string | null }>(`/api/cabinet/feedback/entries?${params}`);
    },
    getNextPageParam: last => last.nextCursor ?? undefined,
  });
}

function useFeedbackMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    // ['cabinet'] — и список QR, и отзывы, и бейдж в меню (bootstrap).
    onSuccess: () => client.invalidateQueries({ queryKey: ['cabinet'] }),
  });
}

export function useSaveFeedbackBoard() {
  return useFeedbackMutation(({ id, input }: { id: string | null; input: FeedbackBoardInput }) =>
    api<FeedbackBoard>(id ? `/api/cabinet/feedback/boards/${id}` : '/api/cabinet/feedback/boards', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(input),
    }));
}

export function useDeleteFeedbackBoard() {
  return useFeedbackMutation((id: string) => api<void>(`/api/cabinet/feedback/boards/${id}`, { method: 'DELETE' }));
}

export function useReadFeedback() {
  return useFeedbackMutation((body: { id: string } | { all: true; boardId?: string }) =>
    api<{ updated: number }>('/api/cabinet/feedback/entries', { method: 'PATCH', body: JSON.stringify(body) }));
}

export function useDeleteFeedback() {
  return useFeedbackMutation((id: string) => api<void>(`/api/cabinet/feedback/entries?id=${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

// ── страница клиента (без входа) ──
// Голый fetch, а не api(): тот приложил бы токен входа, если клиент вдруг сам вошёл на сайт. Отзыв анонимный.

async function publicRequest<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: 'omit' });
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.', 0, 'NETWORK');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || fallback, response.status, body.code);
  return body as T;
}

export function usePublicFeedbackBoard(slug: string) {
  return useQuery({
    queryKey: ['feedback-public', slug],
    queryFn: () => publicRequest<PublicFeedbackBoard>(`/api/feedback/public/${encodeURIComponent(slug)}`, {}, 'Не удалось открыть страницу'),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
    staleTime: 60_000,
  });
}

export function uploadFeedbackPhoto(slug: string, blob: Blob) {
  return publicRequest<{ id: string; token: string }>(`/api/feedback/public/${encodeURIComponent(slug)}/photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  }, 'Не удалось загрузить фото');
}

export function submitFeedback(slug: string, body: { rating: number; kind: FeedbackKind; comment: string; photos: { id: string; token: string }[]; website: string }) {
  return publicRequest<{ ok: true }>(`/api/feedback/public/${encodeURIComponent(slug)}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'Не удалось отправить отзыв');
}
