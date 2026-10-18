import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** Тарифы программы «Помощник ПВЗ» — с сервера (server/_app-plans.js), без копий цен на фронте. */
export type AppPlanId = 'basic' | 'standard' | 'pro';
export type AppPlan = {
  id: AppPlanId;
  title: string;
  summary: string;
  monthlyPrice: number;
  codes: number;
  stickers: number;
  devices: number;
  features: string[];
  prices: Record<string, number>;
};
export type AppPlans = {
  order: AppPlanId[];
  terms: Array<{ months: number; discountPercent: number }>;
  features: Record<string, string>;
  plans: AppPlan[];
  /** Бесплатный режим из админки: всем вошедшим — Про без лимитов. */
  freeMode?: boolean;
};
export type AppDevice = { id: string; name: string; appVersion: string; lastSeenAt: string; createdAt: string; current: boolean };
export type AppAccount = {
  freeMode?: boolean;
  user: { id: string; email: string | null; name: string | null; phone: string | null; telegram: { username: string | null } | null };
  effectivePlan: AppPlanId | null;
  subscription: { plan: AppPlanId; title: string; startsAt: string; endsAt: string; paidUntil: string; nextPlan: AppPlanId | null } | null;
  quota: {
    windowStart: string;
    resetAt: string;
    codes: { used: number; limit: number };
    stickers: { used: number; limit: number };
  } | null;
  packs: Array<{ key: string; total: number; left: number }>;
  packsLeft: number;
  stickerPacksLeft: number;
  deviceLimit: number;
  devices: AppDevice[];
};

export const appAccountKey = ['app-account'] as const;

export function useAppPlans() {
  return useQuery({ queryKey: ['app-plans'], queryFn: () => api<AppPlans>('/api/app/plans'), staleTime: 5 * 60 * 1000 });
}

export function useAppAccount() {
  return useQuery({ queryKey: appAccountKey, queryFn: () => api<AppAccount>('/api/app/me') });
}

export function useRevokeAppDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/app/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: appAccountKey }),
  });
}

/** Сколько полных дней осталось до даты (0, если уже прошла). */
export function daysLeft(iso: string, now = Date.now()) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 86400000));
}
