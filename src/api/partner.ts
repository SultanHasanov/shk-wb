import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  Partner, PartnerBalance, PartnerItem, PartnerLedgerEntry, PartnerPayment, PartnerResource,
} from '../lib/partner';

/** Панель партнёра: /api/cabinet?action=partner&op=… (см. handlePartner в api/cabinet.js). */
const URL = '/api/cabinet?action=partner&op=';

export type PartnerMe = { partner: Partner; kztPerRub: number; balance: PartnerBalance };

export type PartnerIssueInput =
  | { kind: 'sticker' | 'program'; amount: number; note: string; priceKzt?: number | null }
  | { kind: 'cell'; durationDays: number; deviceLimit: number; marketplaceScope: string; note: string; priceKzt?: number | null };

export type PartnerIssueResult = { item: PartnerItem; entry: PartnerLedgerEntry | null };

export const partnerKeys = {
  all: ['partner'] as const,
  me: ['partner', 'me'] as const,
  items: ['partner', 'items'] as const,
  ledger: ['partner', 'ledger'] as const,
  payments: ['partner', 'payments'] as const,
};

export function usePartnerMe(enabled = true) {
  return useQuery({ queryKey: partnerKeys.me, queryFn: () => api<PartnerMe>(`${URL}me`), enabled });
}

export function usePartnerItems() {
  return useQuery({
    queryKey: partnerKeys.items,
    queryFn: () => api<{ items: PartnerItem[] }>(`${URL}items`).then(r => r.items),
  });
}

export function usePartnerLedger() {
  return useQuery({
    queryKey: partnerKeys.ledger,
    queryFn: () => api<{ items: PartnerLedgerEntry[] }>(`${URL}ledger`).then(r => r.items),
  });
}

export function usePartnerPayments() {
  return useQuery({
    queryKey: partnerKeys.payments,
    queryFn: () => api<{ items: PartnerPayment[] }>(`${URL}payments`).then(r => r.items),
  });
}

function usePartnerWrite<TBody, TResult>(op: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => api<TResult>(`${URL}${op}`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => client.invalidateQueries({ queryKey: partnerKeys.all }),
  });
}

export const usePartnerIssue = () => usePartnerWrite<PartnerIssueInput, PartnerIssueResult>('issue');
export const usePartnerTopup = () =>
  usePartnerWrite<{ kind: PartnerResource; id: number; amount: number; priceKzt?: number | null }, PartnerIssueResult>('topup');
export const usePartnerToggle = () =>
  usePartnerWrite<{ kind: PartnerResource; id: number; active: boolean }, { ok: boolean }>('toggle');
export const usePartnerMarkup = () =>
  usePartnerWrite<{ markupPercent: number }, { partner: Partner }>('markup');
