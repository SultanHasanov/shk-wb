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
  /** сколько пунктов (ПВЗ) можно подключить */
  points?: number;
  features: string[];
  prices: Record<string, number>;
  /** цена аналога за тот же срок (1/3/6 мес) — показываем зачёркнутой */
  comparePrices?: Record<string, number>;
};
/** Доп. услуги: архив клиентов и пакеты ПК/пунктов (kind 'pack'). prices — цена за весь срок по числу месяцев. */
export type AppAddonId = 'archive' | 'devices_1' | 'devices_3' | 'points_1' | 'points_3' | 'mirror_1' | 'mirror_3';
export type AppAddon = {
  id: AppAddonId;
  kind?: 'service' | 'pack';
  title: string;
  summary: string;
  minPlan: AppPlanId;
  prices: Record<string, number>;
  features: string[];
  monthlyPrice?: number;
  devices?: number;
  points?: number;
  /** пунктов, которые можно загружать на другие ПК (пакеты «Загрузка с другого ПК») */
  mirror?: number;
};
export type AppPoint = { id: string; wbPointId: string; name: string; lastSyncAt: string | null; mirrorAt: string | null; createdAt: string };
export type AppPlans = {
  order: AppPlanId[];
  terms: Array<{ months: number; discountPercent: number }>;
  features: Record<string, string>;
  plans: AppPlan[];
  addons?: AppAddon[];
  /** Бесплатный режим из админки: всем вошедшим — Про без лимитов. */
  freeMode?: boolean;
};
export type AppDevice = {
  id: string; name: string; appVersion: string; lastSeenAt: string; createdAt: string; current: boolean;
  /** что владелец закрыл на этом ПК (разделы и действия act.*) */
  denied?: string[];
  /** пункт, чья база WB стоит на этом ПК */
  pointWb?: string | null;
  accessUpdatedAt?: string | null;
  /** owner — компьютер владельца, work — сотрудника, null — роль не назначена (ведёт себя как владельца) */
  role?: 'owner' | 'work' | null;
  /** держит связь с сервером прямо сейчас (окно сообщений появится сразу) */
  online?: boolean;
  /** звук окна «сообщение от владельца» на этом ПК (см. lib/alert-sounds) */
  alertSound?: string | null;
};

/** Сообщение владельца на ПК (api/app.js action=messages, server/_app-messages.js). */
export type PcMessage = {
  id: string;
  deviceId: string;
  text: string;
  createdAt: string;
  expiresAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  answeredAt: string | null;
  answer: 'ok' | 'done' | 'cannot' | 'closed' | 'reply' | null;
  answerLabel: string | null;
  reply: string | null;
  status: 'pending' | 'delivered' | 'read' | 'answered' | 'expired';
};
export type AppAccount = {
  freeMode?: boolean;
  /** дата окончания бесплатного периода (ISO), если задана в админке */
  freeUntil?: string | null;
  /** итоговые разделы программы: тариф + активные услуги */
  features?: string[];
  addons?: Array<{ id: AppAddonId; kind?: 'service' | 'pack'; title: string; endsAt: string | null; active: boolean; needsPlan: AppPlanId | null }>;
  /** безлимитный аккаунт: всё открыто бессрочно */
  unlimited?: boolean;
  /** скидка участника «Клуба вопросов» на тариф «Про», % (0 — нет); сервер применяет её сам при оплате */
  clubDiscountPercent?: number;
  user: { id: string; email: string | null; name: string | null; phone: string | null; telegram: { username: string | null } | null };
  effectivePlan: AppPlanId | null;
  subscription: {
    plan: AppPlanId; title: string; startsAt: string; endsAt: string; paidUntil: string; nextPlan: AppPlanId | null;
    /** в бесплатный период — фактические даты: подписка начнётся после него */
    effective?: { startsAt: string; endsAt: string | null; paidUntil: string | null } | null;
  } | null;
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
  pointLimit?: number;
  mirrorLimit?: number;
  points?: AppPoint[];
};

export const appAccountKey = ['app-account'] as const;

export function useAppPlans() {
  return useQuery({ queryKey: ['app-plans'], queryFn: () => api<AppPlans>('/api/app/plans'), staleTime: 5 * 60 * 1000 });
}

export function useAppAccount({ refetchInterval }: { refetchInterval?: number } = {}) {
  return useQuery({ queryKey: appAccountKey, queryFn: () => api<AppAccount>('/api/app/me'), refetchInterval });
}

export const pcMessagesKey = (deviceId: string) => ['pc-messages', deviceId] as const;

/** Переписка с ПК: пока страница открыта, опрашиваем статусы доставки и ответы. */
export function usePcMessages(deviceId: string) {
  return useQuery({
    queryKey: pcMessagesKey(deviceId),
    queryFn: () => api<{ items: PcMessage[] }>(`/api/app/messages?device=${encodeURIComponent(deviceId)}`),
    refetchInterval: 5000,
  });
}

export function useSendPcMessage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, text }: { deviceId: string; text: string }) =>
      api<PcMessage>('/api/app/messages', { method: 'POST', body: JSON.stringify({ deviceId, text }) }),
    onSuccess: (_m, { deviceId }) => client.invalidateQueries({ queryKey: pcMessagesKey(deviceId) }),
  });
}

/** Звук окна сообщений на ПК; программа подхватит его со следующим опросом (до минуты). */
export function useSetDeviceAlertSound() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, alertSound }: { id: string; alertSound: string }) =>
      api<{ id: string; alertSound: string | null }>(`/api/app/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ alertSound }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: appAccountKey }),
  });
}

export function useRevokeAppDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/app/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: appAccountKey }),
  });
}

/** Переименовать компьютер (название видно в программе и при загрузке данных с другого ПК). */
export function useRenameAppDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<{ id: string; name: string }>(`/api/app/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: appAccountKey }),
  });
}

/** Доступ сотрудников: что закрыто на компьютере. Программа получит это с арендой (до 10 мин). */
export function useSetDeviceAccess() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, denied }: { id: string; denied: string[] }) =>
      api<{ id: string; denied: string[] }>(`/api/app/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ denied }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: appAccountKey }),
  });
}

/** Роль компьютера: владельца (всё видит и загружает) или сотрудника (только свой пункт). Из кабинета без пароля. */
export function useSetDeviceRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'owner' | 'work' }) =>
      api<{ id: string; role: string; denied: string[] }>(`/api/app/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: appAccountKey }),
  });
}

/** Отключить пункт от аккаунта (данные в облаке остаются — подключится снова сам). */
export function useRevokeAppPoint() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/app/points/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: appAccountKey }),
  });
}

/** Сколько полных дней осталось до даты (0, если уже прошла). */
export function daysLeft(iso: string, now = Date.now()) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 86400000));
}
