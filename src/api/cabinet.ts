import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type NotificationKind = 'order' | 'key_expiry' | 'low_balance' | 'product_news' | 'system';
export type UserPreferences = {
  thermalPrintSettings: Record<string, unknown>;
  notifyOrderStatus: boolean;
  notifyKeyExpiry: boolean;
  notifyLowBalance: boolean;
  notifyProductNews: boolean;
  historyImportedAt: string | null;
  historyImportedCount: number;
  historyImportNoticeDismissedAt: string | null;
};
export type UserProfile = {
  userId: string;
  email: string | null;
  telegramOnly: boolean;
  displayName: string;
  phone: string;
  payerStatus: 'individual' | 'self_employed' | 'entrepreneur';
  registeredAt: string;
  lastSignInAt: string | null;
  telegram: {
    username?: string;
    first_name: string;
    last_name?: string;
    photo_url?: string;
  } | null;
  preferences: UserPreferences;
};
export type StickerAsset = {
  type: 'sticker';
  key: string;
  label: string;
  active: boolean;
  createdAt: string;
  /** Пул общий: и товарные стикеры, и QR коробок тратятся из одного остатка. */
  limits: { used: number; total: number };
};
export type ProgramAsset = {
  type: 'program';
  id: number;
  key: string;
  label: string;
  active: boolean;
  createdAt: string;
  used: number;
  total: number;
};
export type CellPrintAsset = {
  type: 'cell_print';
  id: number;
  key: string;
  label: string;
  active: boolean;
  createdAt: string;
  durationDays: number;
  deviceLimit: number;
  activatedAt: string | null;
  expiresAt: string | null;
  devices: Array<{ id: number; name: string; firstSeenAt: string; lastSeenAt: string }>;
};
export type UserAsset = StickerAsset | ProgramAsset | CellPrintAsset;
export type Order = {
  id: string;
  publicToken: string;
  createdAt: string;
  paidAt: string | null;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  productKind: string;
  product: string;
  amount: number;
  grossAmount: number;
  referralCreditKopecks: number;
  currency: string;
  accessCode: string | null;
  licenseKey: string | null;
  renewal: boolean;
  receiptUrl: string | null;
  individualOrderId?: string;
  creditedUnits?: number;
  payable?: boolean;
};
export type GenerationEntry = {
  id: string;
  clientEntryId: string;
  mode: 'range' | 'custom';
  createdAt: string;
  category: 'product' | 'box';
  prefix?: string;
  quantity: number;
  code?: string | null;
  batchId?: string | null;
  codes?: string[];
  imported?: boolean;
  printedCodes?: string[];
};
export type Notification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};
export type ReferralSummary = {
  code: string;
  link: string;
  availableKopecks: number;
  reservedKopecks: number;
  earnedKopecks: number;
  paidKopecks: number;
  invited: number;
  referrals: Array<{
    id: string;
    label: string;
    attributedAt: string;
    purchases: number;
    purchasesKopecks: number;
    earnedKopecks: number;
    lastPurchaseAt: string | null;
  }>;
  events: Array<{ id: string; kind: string; amountKopecks: number; createdAt: string }>;
  withdrawals: Array<{
    id: string;
    amountKopecks: number;
    bank_name: string;
    phone: string;
    status: string;
    created_at: string;
  }>;
};
export type CabinetOverview = {
  activeKeys: number;
  stickersLeft: number;
  stickersTotal: number;
  needsAttention: number;
};
export type CabinetBootstrap = {
  profile: UserProfile;
  assets: UserAsset[];
  orders: Order[];
  notifications: Notification[];
  unreadNotifications: number;
  referral: ReferralSummary;
  overview: CabinetOverview;
};
export type CursorPage<T> = { items: T[]; nextCursor: string | null };

export const cabinetKey = ['cabinet', 'bootstrap'] as const;
export function useCabinet(enabled = true) {
  return useQuery({
    queryKey: cabinetKey,
    queryFn: () => api<CabinetBootstrap>('/api/cabinet/bootstrap'),
    enabled,
  });
}
export function useOrders() {
  return useQuery({
    queryKey: ['cabinet', 'orders'],
    queryFn: () => api<CursorPage<Order>>('/api/cabinet/orders?limit=100'),
  });
}
export function useHistory(kind = 'all') {
  return useQuery({
    queryKey: ['cabinet', 'history', kind],
    queryFn: () =>
      api<CursorPage<GenerationEntry>>(
        `/api/cabinet/history?limit=100${kind === 'all' ? '' : `&kind=${kind}`}`,
      ),
  });
}
export function useNotifications() {
  return useQuery({
    queryKey: ['cabinet', 'notifications'],
    queryFn: () => api<CursorPage<Notification>>('/api/cabinet/notifications?limit=100'),
  });
}
export function useCabinetMutation<TVariables = void, TResult = { ok: boolean }>(
  path: string,
  method = 'POST',
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (variables: TVariables) =>
      api<TResult>(path, {
        method,
        body: variables === undefined ? undefined : JSON.stringify(variables),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['cabinet'] }),
  });
}

export const money = (kopecks: number) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
  }).format(kopecks / 100);
export const dateTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';
