import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * Клиент админки.
 *
 * Отдельный от `src/api/client.ts` намеренно: тот подмешивает Bearer-токен
 * пользователя кабинета, а здесь авторизация — HttpOnly-кука `wb_admin_session`,
 * которую JS не видит вовсе. Плюс 401 тут не ошибка, а «покажи форму входа»,
 * и его надо отличать от остальных отказов.
 */
export class AdminUnauthorized extends Error {
  constructor() {
    super('Требуется вход');
    this.name = 'AdminUnauthorized';
  }
}

export async function adminApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (response.status === 401) throw new AdminUnauthorized();
  // Именно null, а не undefined: undefined из queryFn react-query считает
  // сбоем запроса, и проверка сессии падала с «data is undefined».
  if (response.status === 204) return null as T;
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error || 'Не удалось выполнить запрос';
    throw new Error(message);
  }
  return data as T;
}

const RESOURCE = '/api/admin/data?resource=';
const USERS = `${RESOURCE}users`;

export const adminKeys = {
  session: ['admin', 'session'] as const,
  stats: ['admin', 'stats'] as const,
  freeGenerations: ['admin', 'free-generations'] as const,
  summary: ['admin', 'users', 'summary'] as const,
  users: (params: AdminUsersQuery) => ['admin', 'users', 'list', params] as const,
  user: (userId: string) => ['admin', 'users', 'detail', userId] as const,
  resource: (resource: string) => ['admin', 'resource', resource] as const,
  pool: (kind: 'stickerPool' | 'boxPool', page: number) => ['admin', kind, page] as const,
  payments: ['admin', 'payments'] as const,
  withdrawals: ['admin', 'withdrawals'] as const,
};

/* ============ Общие типы ============ */

export type AdminUsersQuery = {
  q: string;
  page: number;
  pageSize: number;
  sort: 'created_at' | 'last_sign_in_at' | 'revenue' | 'generation_used';
  filter: 'all' | 'paying' | 'free' | 'telegram' | 'banned' | 'inactive';
};

export type AdminUserRow = {
  userId: string;
  email: string | null;
  emailConfirmed: boolean;
  telegramOnly: boolean;
  banned: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  displayName: string | null;
  phone: string | null;
  payerStatus: string | null;
  telegramUsername: string | null;
  codes: number;
  generationLimit: number;
  generationUsed: number;
  programKeys: number;
  cellLicenses: number;
  cellActive: number;
  ordersPaid: number;
  revenueKopecks: number;
  refundedKopecks: number;
  lastOrderAt: string | null;
  referralCode: string | null;
  referralEarnedKopecks: number;
  referralAvailableKopecks: number;
  invited: number;
};

export type AdminUsersPage = {
  items: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
};

export type AdminSummary = {
  totals: {
    users: number;
    confirmed: number;
    telegramOnly: number;
    banned: number;
    new7: number;
    new30: number;
    active7: number;
    active30: number;
  };
  registrations: {
    days: { day: string; count: number }[];
    weeks: { week: string; count: number }[];
  };
  revenue: {
    paidOrders: number;
    payingUsers: number;
    amountKopecks: number;
    grossKopecks: number;
    refundedKopecks: number;
    referralCreditKopecks: number;
    last30Kopecks: number;
    // Появились в 20260916; старый ответ базы их не отдаёт, пока миграция не накачена.
    todayKopecks?: number;
    todayOrders?: number;
    yesterdayKopecks?: number;
    byKind: { kind: string; orders: number; amountKopecks: number }[];
  };
  generations: { codes: number; owned: number; limit: number; used: number };
  assets: { programKeys: number; cellLicenses: number; cellActive: number; cellDevices: number };
  referrals: {
    accounts: number;
    attributions: number;
    earnedKopecks: number;
    availableKopecks: number;
    paidKopecks: number;
    pendingWithdrawals: number;
  };
};

export type AdminAccessCode = {
  id: number;
  code: string;
  name: string | null;
  active: boolean;
  limit: number;
  used: number;
  ownerUserId?: string | null;
  createdAt: string;
};
export type AdminProgramKey = {
  id: number;
  key: string;
  limit: number;
  used: number;
  active: boolean;
  note: string | null;
  createdAt: string;
};
export type AdminCellDevice = {
  id: number;
  licenseId: number;
  deviceHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
};
export type AdminCellLicense = {
  id: number;
  key: string;
  durationDays: number;
  deviceLimit: number;
  active: boolean;
  activatedAt: string | null;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
  devices?: AdminCellDevice[];
};
export type AdminOrder = {
  id: string;
  created_at: string;
  paid_at: string | null;
  status: string;
  product_kind: string;
  amount: number;
  gross_amount: number | null;
  access_code: string | null;
  program_license_key: string | null;
  cell_print_license_key: string | null;
  yookassa_payment_id: string | null;
  fulfillment_status?: string | null;
};
export type AdminAction = {
  id: number;
  created_at: string;
  action: string;
  target_user_id: string | null;
  payload: Record<string, unknown>;
  admin_fingerprint: string | null;
};

export type AdminUserDetail = {
  userId: string;
  email: string | null;
  telegramOnly: boolean;
  emailConfirmed: boolean;
  banned: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  confirmValue: string;
  profile: {
    display_name: string | null;
    phone: string | null;
    payer_status: string | null;
  } | null;
  telegram: { username: string | null; first_name: string | null } | null;
  codes: AdminAccessCode[];
  programKeys: AdminProgramKey[];
  cellLicenses: AdminCellLicense[];
  orders: AdminOrder[];
  referral: {
    code: string | null;
    availableKopecks: number;
    earnedKopecks: number;
    paidKopecks: number;
    invited: number;
    referrals: Array<{
      userId: string;
      email: string | null;
      displayName: string | null;
      phone: string | null;
      registeredAt: string | null;
      attributedAt: string;
      paidOrders: number;
      paidKopecks: number;
      refundedKopecks: number;
      rewardedKopecks: number;
      reversedKopecks: number;
      earnedKopecks: number;
      orders: Array<{
        id: string;
        status: string;
        productKind: string;
        amountKopecks: number;
        grossKopecks: number;
        refundedKopecks: number;
        createdAt: string;
        paidAt: string | null;
      }>;
    }>;
  };
  notifications: {
    id: number;
    kind: string;
    title: string;
    created_at: string;
    read_at: string | null;
  }[];
  historyEntries: number;
  actions: AdminAction[];
};

export type AdminStats = {
  totals: { siteVisits: number; uniqueVisitors: number; appLaunches: number };
  days: { day: string; siteVisits: number; uniqueVisitors: number; appLaunches: number }[];
};

/* ============ Сессия ============ */

export function useAdminSession() {
  return useQuery({
    queryKey: adminKeys.session,
    // Ответ у ручки пустой (204/401), поэтому наличие сессии выражаем явным
    // значением: пустой результат query-функции считался бы ошибкой.
    queryFn: async () => {
      await adminApi<null>('/api/admin/session');
      return true as const;
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function useAdminLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (password: string) =>
      adminApi<void>('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.session }),
  });
}

export function useAdminLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => adminApi<void>('/api/admin/logout', { method: 'POST' }),
    onSuccess: () => queryClient.clear(),
  });
}

/* ============ Пользователи ============ */

export function useAdminSummary() {
  return useQuery({
    queryKey: adminKeys.summary,
    queryFn: () => adminApi<AdminSummary>(`${USERS}&action=summary`),
    staleTime: 60_000,
  });
}

export function useAdminUsers(params: AdminUsersQuery) {
  return useQuery({
    queryKey: adminKeys.users(params),
    queryFn: () =>
      adminApi<AdminUsersPage>(
        `${USERS}&action=list&q=${encodeURIComponent(params.q)}&page=${params.page}` +
          `&pageSize=${params.pageSize}&sort=${params.sort}&filter=${params.filter}`,
      ),
    placeholderData: previous => previous,
  });
}

export function useAdminUser(userId: string) {
  return useQuery({
    queryKey: adminKeys.user(userId),
    queryFn: () =>
      adminApi<AdminUserDetail>(`${USERS}&action=detail&userId=${encodeURIComponent(userId)}`),
    enabled: Boolean(userId),
  });
}

/** Любое действие над пользователем освежает и карточку, и список со сводкой. */
export function useAdminUserAction<TBody extends { userId?: string }, TResult = unknown>(
  action: string,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) =>
      adminApi<TResult>(`${USERS}&action=${action}`, { method, body: JSON.stringify(body) }),
    onSuccess: (_result, body) => {
      if (body.userId)
        void queryClient.invalidateQueries({ queryKey: adminKeys.user(body.userId) });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

/* ============ Типовые CRUD-ресурсы ============ */

export function useAdminResource<T>(resource: string) {
  return useQuery({
    queryKey: adminKeys.resource(resource),
    queryFn: () => adminApi<T[]>(`${RESOURCE}${resource}`),
  });
}

export function useAdminResourceMutation<TBody>(resource: string) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: adminKeys.resource(resource) });
  return {
    create: useMutation({
      mutationFn: (body: TBody) =>
        adminApi(`${RESOURCE}${resource}`, { method: 'POST', body: JSON.stringify(body) }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: TBody & { id: number | string }) =>
        adminApi(`${RESOURCE}${resource}&id=${id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: number | string) =>
        adminApi(`${RESOURCE}${resource}&id=${id}`, { method: 'DELETE' }),
      onSuccess: invalidate,
    }),
  };
}

/* ============ Статистика посещений и пулы ============ */

export function useAdminStats() {
  return useQuery({
    queryKey: adminKeys.stats,
    queryFn: () => adminApi<AdminStats>('/api/admin/stats'),
  });
}

/**
 * Бесплатные первые генерации. Считаются по партиям без кода доступа, поэтому
 * «посетители» — это уникальные requester_hash, то есть уникальные IP, а не люди.
 * Бесплатная квота проверяется отдельно на каждую пару «категория × режим», так
 * что один IP может получить до четырёх бесплатных кодов — codes и visitors
 * расходятся законно.
 */
export type AdminFreeGenerations = {
  totals: {
    codes: number;
    batches: number;
    visitors: number;
    last24h: number;
    last7d: number;
    last30d: number;
    newVisitors30d: number;
    lastAt: string | null;
  };
  byKind: {
    category: 'product' | 'box';
    mode: 'range' | 'custom';
    codes: number;
    visitors: number;
  }[];
  days: { day: string; codes: number; visitors: number }[];
  conversion: { freeVisitors: number; converted: number };
};

export function useAdminFreeGenerations() {
  return useQuery({
    queryKey: adminKeys.freeGenerations,
    queryFn: () => adminApi<AdminFreeGenerations>(`${RESOURCE}freeGenerations`),
    staleTime: 60_000,
  });
}

export type AdminPool = {
  total: number;
  available: number;
  used: number;
  start: string | null;
  end: string | null;
  recentUsed: { code: string; batchId: string; allocatedAt: string }[];
  page: number;
  pageSize: number;
};

export function useAdminPool(kind: 'stickerPool' | 'boxPool', page: number) {
  return useQuery({
    queryKey: adminKeys.pool(kind, page),
    queryFn: () => adminApi<AdminPool>(`${RESOURCE}${kind}&page=${page}`),
    placeholderData: previous => previous,
  });
}

export function useAdminPoolRange(kind: 'stickerPool' | 'boxPool') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { start: string; end: string }) =>
      adminApi<{ inserted: number }>(`${RESOURCE}${kind}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', kind] }),
  });
}

/* ============ Оплата ============ */

export type AdminPayments = {
  enabled: boolean;
  readiness: { yookassa: boolean; testMode: boolean };
  tiers: { id: number; kind: string; min_quantity: number; unit_price: number; active: boolean }[];
  orders: AdminOrder[];
};

export function useAdminPayments() {
  return useQuery({
    queryKey: adminKeys.payments,
    queryFn: () => adminApi<AdminPayments>(`${RESOURCE}paymentAdmin`),
  });
}

export function useAdminPaymentOperation<TBody>(operation: 'settings' | 'sync' | 'tier') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) =>
      adminApi(`${RESOURCE}paymentAdmin&operation=${operation}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.payments }),
  });
}

export function useAdminTierDelete() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      adminApi(`${RESOURCE}paymentAdmin&operation=tier&id=${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.payments }),
  });
}

/* ============ Кабинет: выплаты и рассылка ============ */

export type AdminWithdrawal = {
  id: string;
  amount_kopecks: number;
  bank_name: string;
  sbp_phone: string;
  status: string;
  admin_note: string | null;
  created_at: string;
  user_id: string | null;
};

export function useAdminWithdrawals() {
  return useQuery({
    queryKey: adminKeys.withdrawals,
    queryFn: () => adminApi<AdminWithdrawal[]>('/api/admin/cabinet/withdrawals'),
  });
}

export function useAdminWithdrawalUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { id: string; status: 'approved' | 'paid' | 'rejected'; note?: string }) =>
      adminApi('/api/admin/cabinet/withdrawal', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.withdrawals }),
  });
}

export function useAdminNews() {
  return useMutation({
    mutationFn: (body: { title: string; body: string; link?: string }) =>
      adminApi<{ sent: number }>('/api/admin/cabinet/news', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}
