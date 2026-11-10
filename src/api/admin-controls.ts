import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  adminApi,
  adminKeys,
  type AdminDelivery,
  type AdminLoginMethods,
  type AdminMessageResult,
  type AdminMessageTargets,
  type AdminOverrides,
  type AdminRestriction,
  type AdminSentMessage,
  type MessageChannel,
  type RestrictionScope,
} from './admin';

/**
 * Хуки карточки пользователя: ручные лимиты, кошелёк, ограничения, сообщения,
 * разделы по вкладкам. Контракт — раздел 5.4 («src/api/admin-controls.ts»).
 * Каждая мутация освежает карточку, список, журнал и «Требует внимания».
 */

const USERS = '/api/admin/data?resource=users';

/* ============ Тела запросов ============ */

export type SetOverridesBody = {
  userId: string;
  reason: string;
  idempotencyKey: string;
  codes?: { mode: 'tariff' | 'add' | 'set'; monthly: number; until: string | null };
  slots?: { devices: number; points: number; mirror: number; until: string | null };
  unlimited?: { enabled: boolean; until: string | null };
  note?: string;
};
export type ClearOverridesBody = { userId: string; reason: string; idempotencyKey: string };
export type WalletAdjustBody = {
  userId: string;
  direction: 'credit' | 'debit';
  amountKopecks: number;
  comment: string;
  reason: string;
  notify: boolean;
  idempotencyKey: string;
};
export type RestrictBody = {
  userId: string;
  scopes: RestrictionScope[];
  until: string | null;
  reason: string;
  publicMessage?: string;
  notify?: boolean;
  force?: boolean;
  idempotencyKey: string;
};
export type UpdateRestrictionBody = {
  userId: string;
  restrictionId: string;
  reason: string;
  until?: string | null;
  publicMessage?: string | null;
  scopes?: RestrictionScope[];
  idempotencyKey: string;
};
export type LiftRestrictionBody = { userId: string; restrictionId: string; reason: string; notify: boolean; idempotencyKey: string };
export type SendMessageBody = {
  userId: string;
  channels: MessageChannel[];
  subject: string;
  body: string;
  link?: string;
  deviceIds?: string[];
  idempotencyKey: string;
};

/* ============ Ответы ============ */

export type SetOverridesResult = { overrides: AdminOverrides | null; entitlements?: Record<string, unknown>; replayed?: true };
export type WalletAdjustResult = { beforeKopecks: number; balanceKopecks: number; duplicate: boolean; replayed?: true };
export type RestrictResult = { restriction: AdminRestriction; authBan?: 'failed'; replayed?: true };
export type LiftRestrictionResult = {
  restored: { stickerCodes: number; programKeys: number; cellLicenses: number };
  restriction: AdminRestriction;
  replayed?: true;
};

export type WalletLedgerKind = 'topup' | 'bonus' | 'spend' | 'refund' | 'admin' | 'referral';

export type UserSectionData = {
  wallet: {
    balanceKopecks: number;
    ledger: Array<{ id: number; kind: WalletLedgerKind; amountKopecks: number; orderId: string | null; note: string | null; createdAt: string }>;
  };
  usage: {
    items: Array<{ id: number; kind: 'code' | 'sticker'; amount: number; source: 'quota' | 'pack'; deviceName: string | null; via: string | null; createdAt: string }>;
  };
  charges: {
    items: Array<{
      id: string; mode: 'custom' | 'batch'; category: 'product' | 'box'; quantity: number; priceKopecks: number;
      paymentSource: 'wallet' | 'package'; status: string; createdAt: string;
    }>;
  };
  cellDevices: {
    items: Array<{ id: number; name: string; appVersion: string; firstSeenAt: string; lastSeenAt: string; revokedAt: string | null }>;
  };
  logins: AdminLoginMethods;
  messages: { items: AdminSentMessage[] };
  deliveries: { items: AdminDelivery[] };
  pcMessages: {
    items: Array<{
      id: string; deviceId: string; deviceName: string | null; text: string; createdBy: 'owner' | 'admin';
      status: 'pending' | 'delivered' | 'read' | 'answered' | 'expired';
      createdAt: string; deliveredAt: string | null; readAt: string | null; answeredAt: string | null;
      answer: string | null; answerLabel: string | null; reply: string | null;
    }>;
  };
};
export type UserSection = keyof UserSectionData;

export type AccountActionName = 'logoutAll' | 'unlinkTelegram' | 'unlinkOAuth' | 'setDeviceRole';
export type AccountActionBodies = {
  logoutAll: { userId: string; reason: string };
  unlinkTelegram: { userId: string; reason: string };
  unlinkOAuth: { userId: string; provider: 'yandex' | 'mailru' | 'vkid'; reason: string };
  setDeviceRole: { userId: string; deviceId: string; role: 'owner' | 'work'; reason?: string };
};
export type AccountActionResults = {
  logoutAll: { ok: true; devicesRevoked: number };
  unlinkTelegram: { ok: true };
  unlinkOAuth: { ok: true };
  setDeviceRole: { id: string; role: 'owner' | 'work'; denied: string[] };
};

/* ============ Адреса (вынесены ради тестов) ============ */

export const controlUrls = {
  section: (userId: string, section: UserSection) =>
    `${USERS}&action=detailSection&userId=${encodeURIComponent(userId)}&section=${section}`,
  messageTargets: (userId: string) => `${USERS}&action=messageTargets&userId=${encodeURIComponent(userId)}`,
  action: (action: string) => `${USERS}&action=${action}`,
};

export const messageTargetsKey = (userId: string) => ['admin', 'users', 'message-targets', userId] as const;

/* ============ Запросы ============ */

/** Тяжёлый раздел карточки — по вкладке, а не в detail (трафик Supabase). */
export function useAdminUserSection<S extends UserSection>(
  userId: string,
  section: S,
  enabled = true,
): UseQueryResult<UserSectionData[S]> {
  return useQuery({
    queryKey: adminKeys.userSection(userId, section),
    queryFn: () => adminApi<UserSectionData[S]>(controlUrls.section(userId, section)),
    enabled: Boolean(userId) && enabled,
  });
}

/** Доступность каналов: всегда свежая при открытии окна «Написать». */
export function useMessageTargets(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: messageTargetsKey(userId),
    queryFn: () => adminApi<AdminMessageTargets>(controlUrls.messageTargets(userId)),
    enabled: Boolean(userId) && enabled,
    staleTime: 0,
  });
}

/* ============ Мутации ============ */

function useControlMutation<TBody extends { userId: string }, TResult>(action: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => adminApi<TResult>(controlUrls.action(action), { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (_result, body) => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.user(body.userId) });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'attention'] });
    },
  });
}

export function useSetOverrides() {
  return useControlMutation<SetOverridesBody, SetOverridesResult>('setOverrides');
}

export function useClearOverrides() {
  return useControlMutation<ClearOverridesBody, { overrides: null; replayed?: true }>('clearOverrides');
}

export function useWalletAdjust() {
  return useControlMutation<WalletAdjustBody, WalletAdjustResult>('walletAdjust');
}

export function useRestrict() {
  return useControlMutation<RestrictBody, RestrictResult>('restrict');
}

export function useUpdateRestriction() {
  return useControlMutation<UpdateRestrictionBody, { restriction: AdminRestriction; replayed?: true }>('updateRestriction');
}

export function useLiftRestriction() {
  return useControlMutation<LiftRestrictionBody, LiftRestrictionResult>('liftRestriction');
}

export function useSendMessage() {
  return useControlMutation<SendMessageBody, AdminMessageResult>('message');
}

/** Тонкая обёртка над POST users&action=: выход везде, отвязка входа, роль ПК. */
export function useAccountAction<A extends AccountActionName>(action: A) {
  return useControlMutation<AccountActionBodies[A], AccountActionResults[A]>(action);
}
