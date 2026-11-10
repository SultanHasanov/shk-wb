import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { Partner, PartnerBalance, PartnerItem, PartnerLedgerEntry, PartnerPayment } from '../lib/partner';

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

/**
 * Отказ сервера с подробностями: статус, машинный код (`ACCOUNT_RESTRICTED`,
 * `IN_PROGRESS`…), всё тело ответа и адрес. Экран ошибки показывает
 * «HTTP 502 · /api/admin/data?resource=audit», окна действий — текст `error`
 * и разбирают `code` (например, `ALREADY_RESTRICTED` → открыть «Изменить»).
 */
export class AdminApiError extends Error {
  status: number;
  code: string | null;
  data: unknown;
  path: string;

  constructor(message: string, { status, code, data, path }: { status: number; code: string | null; data: unknown; path: string }) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
    this.data = data;
    this.path = path;
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
  let data: unknown = null;
  let parsed = true;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Голый «404: NOT_FOUND» от маршрутизатора или HTML прокси — не JSON.
      // Раньше это падало SyntaxError, и вместо статуса человек видел «Unexpected token».
      parsed = false;
      data = text.slice(0, 300);
    }
  }
  const body = (parsed && data && typeof data === 'object' ? data : null) as { error?: unknown; code?: unknown } | null;
  if (!response.ok) {
    const message = (typeof body?.error === 'string' && body.error) || 'Не удалось выполнить запрос';
    throw new AdminApiError(message, {
      status: response.status,
      code: typeof body?.code === 'string' ? body.code : null,
      data,
      path: url,
    });
  }
  if (!parsed) {
    throw new AdminApiError('Сервер прислал непонятный ответ', { status: response.status, code: null, data, path: url });
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
  telegramAudience: ['admin', 'telegram-audience'] as const,
  audit: (f: AuditFilters) => ['admin', 'audit', f] as const,
  deliveries: (f: DeliveryFilters) => ['admin', 'deliveries', f] as const,
  attention: ['admin', 'attention'] as const,
  system: ['admin', 'system'] as const,
  userCounts: ['admin', 'users', 'counts'] as const,
  userSection: (userId: string, section: string) => ['admin', 'users', 'section', userId, section] as const,
};

/* ============ Общие типы ============ */

export type AdminUsersQuery = {
  q: string;
  page: number;
  pageSize: number;
  sort: AdminUsersSort;
  filter: AdminUsersFilter;
};

export type AdminUsersSort = 'created_at' | 'last_sign_in_at' | 'revenue' | 'generation_used' | 'balance' | 'expiring';
export type AdminUsersFilter =
  | 'all' | 'paying' | 'free' | 'telegram' | 'banned' | 'inactive'
  | 'subscribed' | 'expiring' | 'unlimited' | 'restricted';

/** Области ограничения аккаунта (контракт 3.4). 'all' — «Полностью». */
export type RestrictionScope = 'all' | 'site' | 'app' | 'cell_print' | 'bot' | 'purchases' | 'withdrawals';

export type AdminRestriction = {
  id: string;
  userId: string;
  scopes: RestrictionScope[];
  /** scopes включает 'all' */
  full: boolean;
  until: string | null;
  /** lifted_at пуст, но срок уже прошёл: таймер ещё не снял запись */
  expired: boolean;
  reason: string;
  publicMessage: string | null;
  /** Текст, который видит пользователь (publicMessage или стандартный) */
  message: string;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  liftedAt: string | null;
  liftedBy: string | null;
  liftedReason: string | null;
  disabledItems: { stickerCodes: number[]; programKeys: number[]; cellLicenses: number[]; legacy: boolean };
};

export type AdminOverrides = {
  /** null — подборы по тарифу */
  codes: { mode: 'add' | 'set'; monthly: number; until: string | null; active: boolean } | null;
  /** null — все надбавки нулевые */
  slots: { devices: number; points: number; mirror: number; until: string | null; active: boolean } | null;
  unlimited: { enabled: boolean; until: string | null; active: boolean } | null;
  note: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type AdminLoginMethods = {
  email: { address: string | null; confirmed: boolean; technical: boolean };
  telegram: {
    username: string | null;
    telegramUserId: number;
    linkedAt: string;
    bot: { started: boolean; blockedAt: string | null };
  } | null;
  oauth: Array<{ provider: 'yandex' | 'mailru' | 'vkid'; email: string | null; displayName: string | null; linkedAt: string }>;
};

/** Ответ `users&action=counts`: те же определения, что у фильтров списка. */
export type AdminUserCounts = {
  all: number;
  paying: number;
  subscribed: number;
  expiring: number;
  unlimited: number;
  restricted: number;
  telegram: number;
  inactive: number;
  new30: number;
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
  walletKopecks: number;
  app: { plan: 'basic' | 'standard' | 'pro' | null; endsAt: string | null; paidUntil: string | null; expiresInDays: number | null };
  /** limit null — безлимит (∞) */
  devices: { used: number; limit: number | null };
  points: { used: number; limit: number | null };
  /** Последний сеанс ПК */
  lastSeenAt: string | null;
  restricted: boolean;
  restriction: { scopes: RestrictionScope[]; until: string | null } | null;
  unlimited: boolean;
  unlimitedUntil: string | null;
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
  marketplaceScope: 'wb' | 'ozon' | 'both' | 'legacy_unassigned';
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
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  result?: 'ok' | 'error' | 'partial' | 'pending' | null;
  user_agent?: string | null;
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
    /** Индивидуальное исключение: код клиента напрямую даже при включённом флаге app_code_via_bot. */
    app_code_via_bot_off?: boolean | null;
  } | null;
  telegram: { username: string | null; first_name: string | null } | null;
  codes: AdminAccessCode[];
  programKeys: AdminProgramKey[];
  cellLicenses: AdminCellLicense[];
  orders: AdminOrder[];
  customOrders: Array<{
    id:string; title:string; quantity:number; total_amount:number; paid_amount:number;
    amount_due:number; credited_units:number; status:string; created_at:string;
  }>;
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
  app: {
    entitlements: {
      plan: string | null;
      ends_at: string | null;
      codes_limit: number | null;
      codes_used: number | null;
      stickers_limit: number | null;
      stickers_used: number | null;
      device_limit: number | null;
      packs_left: number | null;
      codes_base?: number;
      device_bonus?: number;
      points_bonus?: number;
      mirror_bonus?: number;
      unlimited?: boolean;
      unlimited_until?: string | null;
      window_start?: string;
      window_end?: string;
      override?: Record<string, unknown> | null;
    } | null;
    subscriptions: Array<{
      id: string; plan: string; startsAt: string; endsAt: string; canceled: boolean;
      source: string; monthlyPrice: number; codes: number; stickers: number;
      deviceLimit: number; createdAt: string;
    }>;
    devices: Array<{
      id: string; name: string; appVersion: string; lastSeenAt: string;
      createdAt: string; revokedAt: string | null;
      role: 'owner' | 'work' | null; online: boolean; pointWb: string | null;
    }>;
    /** null — безлимит; base — без ручных правок */
    limits: {
      devices: number | null; points: number | null; mirror: number | null;
      codesLimit: number; codesUsed: number;
      base: { devices: number; points: number; mirror: number; codes: number };
    };
    usage: Array<{ id: number; kind: string; amount: number; source: string; createdAt: string }>;
    addons?: Array<{
      id: string; addon: string; title: string; startsAt: string; endsAt: string;
      canceled: boolean; source: string; price: number; createdAt: string;
    }>;
    points?: Array<{
      id: string; wbPointId: string; name: string; createdAt: string;
      lastSyncAt: string | null; mirrorAt: string | null; revokedAt: string | null;
    }>;
  };
  overrides: AdminOverrides | null;
  /** app_device_bonuses.devices или 0 (переходный период) */
  legacyDeviceBonus: number;
  /** lifted_at пуст, в т.ч. просроченное (expired: true) */
  restriction: AdminRestriction | null;
  /** env-безлимит владельца или действующий безлимит из user_overrides: ограничение требует force */
  protected: boolean;
  partner: { id: string; name: string; active: boolean } | null;
  unlimited: { active: boolean; source: 'env' | 'override' | null; until: string | null };
  wallet: { balanceKopecks: number; updatedAt: string | null };
  loginMethods: AdminLoginMethods;
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

export function useAdminStats(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: adminKeys.stats,
    queryFn: () => adminApi<AdminStats>('/api/admin/stats'),
    enabled: opts.enabled ?? true,
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

/** Бесплатный режим «Помощника ПВЗ»: всем вошедшим — Про без лимитов. */
export type AdminAppFreeMode = {
  enabled: boolean;
  since: string | null;
  /** дата окончания (ISO) — в неё крон сам выключит режим */
  until: string | null;
  extended?: { users: number; segments: number; addons?: number } | null;
};

export function useAdminAppFreeMode() {
  return useQuery({
    queryKey: ['admin', 'app-free-mode'] as const,
    queryFn: () => adminApi<AdminAppFreeMode>(`${RESOURCE}appFreeMode`),
  });
}

export function useSetAdminAppFreeMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: boolean | { enabled: boolean; until?: string | null }) =>
      adminApi<AdminAppFreeMode>(`${RESOURCE}appFreeMode`, {
        method: 'POST',
        body: JSON.stringify(typeof input === 'boolean' ? { enabled: input } : input),
      }),
    onSuccess: data => {
      queryClient.setQueryData(['admin', 'app-free-mode'], data);
      queryClient.invalidateQueries({ queryKey: ['app-plans'] });
    },
  });
}

/** Резервный подбор кода клиента по хешам (кнопка «Быстрый QR» в программе). */
export type AdminAppCrackFallback = { enabled: boolean };

export function useAdminAppCrackFallback() {
  return useQuery({
    queryKey: ['admin', 'app-crack-fallback'] as const,
    queryFn: () => adminApi<AdminAppCrackFallback>(`${RESOURCE}appCrackFallback`),
  });
}

export function useSetAdminAppCrackFallback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      adminApi<AdminAppCrackFallback>(`${RESOURCE}appCrackFallback`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: data => queryClient.setQueryData(['admin', 'app-crack-fallback'], data),
  });
}

/** Код клиента только с подтверждением владельца в Telegram-боте (server/_code-approvals.js). */
export type AdminAppCodeViaBot = { enabled: boolean };

export function useAdminAppCodeViaBot() {
  return useQuery({
    queryKey: ['admin', 'app-code-via-bot'] as const,
    queryFn: () => adminApi<AdminAppCodeViaBot>(`${RESOURCE}appCodeViaBot`),
  });
}

export function useSetAdminAppCodeViaBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      adminApi<AdminAppCodeViaBot>(`${RESOURCE}appCodeViaBot`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: data => queryClient.setQueryData(['admin', 'app-code-via-bot'], data),
  });
}

/** Статистика «Помощника ПВЗ»: скачивания установщика, новые компьютеры, активные, оплаты. */
export type AdminAppStats = {
  totals: {
    downloads: number;
    downloadVisitors: number;
    devices: number;
    accounts: number;
    active24h: number;
    active7d: number;
    paidUsers: number;
    revenue: number;
    since: string | null;
  };
  days: { day: string; downloads: number; visitors: number; devices: number; payments: number; revenue: number }[];
  sources: { source: string; downloads: number; visitors: number }[];
};

export function useAdminAppStats(days = 30) {
  return useQuery({
    queryKey: ['admin', 'app-stats', days] as const,
    queryFn: () => adminApi<AdminAppStats>(`${RESOURCE}appStats&days=${days}`),
    refetchInterval: 60_000,
  });
}

export function useAdminFreeGenerations(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: adminKeys.freeGenerations,
    queryFn: () => adminApi<AdminFreeGenerations>(`${RESOURCE}freeGenerations`),
    staleTime: 60_000,
    enabled: opts.enabled ?? true,
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
    mutationFn: (body: { title: string; body: string; link?: string; idempotencyKey?: string; reason?: string }) =>
      adminApi<{ sent: number }>('/api/admin/cabinet/news', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

/** legacy — активировали бота до legacyBefore: у них ещё висит старая нижняя клавиатура. */
export type AdminTelegramAudience = { activated: number; available: number; blocked: number; legacy: number; legacyBefore: string };
export type AdminTelegramBroadcastResult = { sent: number; failed: number; blocked: number; total: number };

export function useAdminTelegramAudience() {
  return useQuery({
    queryKey: adminKeys.telegramAudience,
    queryFn: () => adminApi<AdminTelegramAudience>('/api/admin/cabinet/telegram-audience'),
    staleTime: 30_000,
  });
}

export function useAdminTelegramBroadcast() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      text: string; button?: string; url?: string; removeKeyboard?: boolean; onlyLegacy?: boolean;
      idempotencyKey?: string; reason?: string;
    }) =>
      adminApi<AdminTelegramBroadcastResult>('/api/admin/cabinet/telegram-broadcast', {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.telegramAudience }),
  });
}

/* ============ Партнёры ============ */

const PARTNERS = `${RESOURCE}partners`;

export type AdminPartnerRow = Partner & { account: string | null; balance: PartnerBalance };
export type AdminPartnerDetail = {
  partner: Partner & { account: string | null };
  items: PartnerItem[];
  ledger: PartnerLedgerEntry[];
  payments: PartnerPayment[];
  balance: PartnerBalance;
};

export const adminPartnerKeys = {
  all: ['admin', 'partners'] as const,
  list: ['admin', 'partners', 'list'] as const,
  detail: (id: string) => ['admin', 'partners', 'detail', id] as const,
  settings: ['admin', 'partners', 'settings'] as const,
};

export function useAdminPartners() {
  return useQuery({
    queryKey: adminPartnerKeys.list,
    queryFn: () => adminApi<{ items: AdminPartnerRow[] }>(`${PARTNERS}&action=list`).then(r => r.items),
  });
}

export function useAdminPartner(id: string) {
  return useQuery({
    queryKey: adminPartnerKeys.detail(id),
    queryFn: () => adminApi<AdminPartnerDetail>(`${PARTNERS}&action=detail&id=${encodeURIComponent(id)}`),
    enabled: Boolean(id),
  });
}

export function useAdminPartnerSettings() {
  return useQuery({
    queryKey: adminPartnerKeys.settings,
    queryFn: () => adminApi<{ kztPerRub: number }>(`${PARTNERS}&action=settings`),
  });
}

/** Любое действие с партнёром освежает и список, и карточку, и курс. */
export function useAdminPartnerAction<TBody, TResult = unknown>(action: string, method: 'POST' | 'PATCH' = 'POST') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) =>
      adminApi<TResult>(`${PARTNERS}&action=${action}`, { method, body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminPartnerKeys.all }),
  });
}

/* ============ Журнал, доставки, «Требует внимания», система ============ */

export type AuditCategory = 'limits' | 'restrict' | 'messages' | 'money' | 'keys' | 'settings' | 'deletions' | 'other';

export type AdminAuditEntry = {
  id: number;
  createdAt: string;
  action: string;
  category: AuditCategory;
  danger: boolean;
  targetUserId: string | null;
  target: { userId: string; email: string | null; displayName: string | null; telegramUsername: string | null } | null;
  reason: string | null;
  payload: Record<string, unknown>;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  result: 'ok' | 'error' | 'partial' | 'pending' | null;
  adminFingerprint: string | null;
  userAgent: string | null;
};

export type AdminAuditPage = { items: AdminAuditEntry[]; nextCursor: number | null; total: number | null };

export type AuditFilters = {
  category?: AuditCategory;
  action?: string;
  userId?: string;
  q?: string;
  from?: string;
  to?: string;
  danger?: boolean;
  limit?: number;
};

export type DeliveryChannel = 'email' | 'telegram' | 'pc';
export type DeliveryFilters = {
  channel?: DeliveryChannel;
  status?: 'sent' | 'failed' | 'not_configured' | 'pending' | 'blocked' | 'error';
  userId?: string;
};

export type AdminDelivery = {
  id: string;
  createdAt: string;
  channel: DeliveryChannel;
  /** у pc — производный от состояния сообщения на ПК */
  status: 'pending' | 'sent' | 'failed' | 'skipped' | 'not_configured' | 'blocked' | 'expired';
  recipient: string;
  channelRef: string | null;
  subject: string | null;
  source: 'system' | 'admin' | 'broadcast';
  userId: string | null;
  user: { email: string | null; displayName: string | null } | null;
  providerId: string | null;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  adminActionId: number | null;
  canRetry: boolean;
  pc: { deviceName: string | null; deliveredAt: string | null; readAt: string | null; answeredAt: string | null; answer: string | null } | null;
};

export type AdminDeliveriesPage = {
  items: AdminDelivery[];
  /** created_at последней строки */
  nextCursor: string | null;
  stats24h: { sent: number; failed: number; notConfigured: number; waitingPc: number };
};

export type AdminAttention = {
  generatedAt: string;
  withdrawals: { count: number; amountKopecks: number; oldestAt: string | null };
  stuckOrders: { count: number; oldestAt: string | null };
  stickerPool: { available: number; threshold: number; low: boolean };
  boxPool: { available: number; threshold: number; low: boolean };
  failedDeliveries24h: { count: number; byChannel: { email: number; telegram: number; pc: number } };
  restrictionsExpiringToday: { count: number; items: Array<{ userId: string; label: string; until: string }> };
  restrictedTotal: number;
  subscriptions: { active: number; expiring7: number };
  onlinePcs: number;
  usersTotal: number;
  /** число непустых пунктов «Требует внимания» */
  total: number;
};

export type SvcStatus = 'ok' | 'warning' | 'down' | 'unknown';
export type BotAlertKey = 'updates' | 'relay' | 'webhook' | 'bot-node';

export type AdminSystem = {
  generatedAt: string;
  cached: boolean;
  bot: {
    status: SvcStatus;
    processesUpdates: boolean;
    lastUpdateAgoSec: number | null;
    window: { total: number; slow: number; failed: number; worstMs: number } | null;
    alerts: Record<BotAlertKey, { active: boolean; sentAt: number | null }>;
  } | null;
  relay: { status: SvcStatus; base: string; latencyMs: number | null; error: string | null } | null;
  webhook: { status: SvcStatus; url: string | null; pendingUpdates: number; lastErrorAt: string | null; lastErrorMessage: string | null } | null;
  botNode: { status: SvcStatus; url: string | null; latencyMs: number | null; error: string | null; release: string | null } | null;
  site: { status: 'ok'; uptimeSec: number; release: string | null; role: string };
  egress: { status: 'warning' | 'unknown'; note: string | null };
  disk: { status: SvcStatus; totalBytes: number; freeBytes: number; usedPercent: number; alertFreeBytes: number } | null;
  database: { status: SvcStatus; sizeBytes: number; limitBytes: number; alertBytes: number } | null;
  backups: { status: SvcStatus; dir: string; lastAt: string | null; items: Array<{ name: string; sizeBytes: number; modifiedAt: string }> } | null;
  programs: {
    pvzHelper: { latest: string | null; minVersion: string | null; mandatory: boolean; devicesBelowMin: number | null } | null;
    cellPrint: { latest: string | null; signed: boolean } | null;
  };
  /** только признаки («задан/не задан»), никогда значения секретов */
  env: Array<{ name: string; value: string }>;
};

/* ---- Сообщения пользователю (контракт 3.3, 3.5): типы общие для карточки и журнала ---- */

export type MessageChannel = 'cabinet' | 'email' | 'telegram' | 'pc';

export type AdminMessageTargets = {
  cabinet: { available: true };
  email: {
    available: boolean; address: string | null; confirmed: boolean; configured: boolean;
    reason: null | 'no_address' | 'not_confirmed' | 'not_configured';
  };
  telegram: { available: boolean; username: string | null; reason: null | 'not_linked' | 'not_started' | 'blocked'; blockedAt: string | null };
  pc: {
    available: boolean;
    reason: null | 'no_devices';
    devices: Array<{ id: string; name: string; online: boolean; lastSeenAt: string | null; role: 'owner' | 'work' | null; openMessages: number }>;
  };
};

export type ChannelResult =
  | { channel: 'cabinet'; status: 'sent' | 'duplicate' | 'failed'; notificationId?: string; error?: string }
  | {
      channel: 'email';
      status: 'sent' | 'failed' | 'not_configured' | 'no_address' | 'not_confirmed' | 'duplicate';
      recipient: string | null; providerId?: string; deliveryId?: string; error?: string;
    }
  | {
      channel: 'telegram';
      status: 'sent' | 'failed' | 'blocked' | 'not_linked' | 'not_started' | 'duplicate';
      recipient: string | null; providerId?: string; deliveryId?: string; error?: string;
    }
  | {
      channel: 'pc';
      status: 'queued' | 'duplicate' | 'failed' | 'not_found' | 'too_many_open';
      deviceId: string; deviceName: string | null; online: boolean; messageId?: string; error?: string;
    };

export type AdminMessageResult = {
  actionId: number;
  /** `msg_${actionId}` */
  messageRef: string;
  sentAt: string;
  subject: string;
  results: ChannelResult[];
  /** «успешные» — sent, queued, duplicate */
  summary: { ok: number; total: number };
  replayed?: true;
};

export type AdminSentMessage = {
  actionId: number;
  sentAt: string;
  subject: string;
  body: string;
  link: string | null;
  channels: Array<{
    channel: MessageChannel;
    status:
      | 'sent' | 'read' | 'pending' | 'failed' | 'not_configured' | 'blocked'
      | 'not_linked' | 'not_started' | 'no_address' | 'not_confirmed' | 'expired';
    recipient: string | null;
    deviceName?: string | null;
    at: string | null;
  }>;
};

/** Строка запроса из фильтров: пустые и ложные значения не отправляем. */
function filterParams(filters: Record<string, string | number | boolean | undefined>): string {
  let out = '';
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === '' || value === false) continue;
    out += `&${key}=${encodeURIComponent(value === true ? '1' : String(value))}`;
  }
  return out;
}

export function auditUrl(f: AuditFilters, cursor?: number | null): string {
  return (
    `${RESOURCE}audit` +
    filterParams({
      limit: f.limit ?? 50,
      category: f.category,
      action: f.action,
      userId: f.userId,
      q: f.q?.trim(),
      from: f.from,
      to: f.to,
      danger: f.danger,
      cursor: cursor ?? undefined,
    })
  );
}

/** Журнал действий: курсор — id последней строки, следующая страница — id < cursor. */
export function useAdminAudit(f: AuditFilters, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: adminKeys.audit(f),
    queryFn: ({ pageParam }) => adminApi<AdminAuditPage>(auditUrl(f, pageParam)),
    initialPageParam: null as number | null,
    getNextPageParam: last => last.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
  });
}

export function deliveriesUrl(f: DeliveryFilters, before?: string | null): string {
  return (
    `${RESOURCE}deliveries` +
    filterParams({ limit: 50, channel: f.channel, status: f.status, userId: f.userId, before: before ?? undefined })
  );
}

/** Доставки (почта, Telegram, ПК): курсор — created_at последней строки. */
export function useAdminDeliveries(f: DeliveryFilters, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: adminKeys.deliveries(f),
    queryFn: ({ pageParam }) => adminApi<AdminDeliveriesPage>(deliveriesUrl(f, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
  });
}

export function useAdminRetryDelivery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { id: string; idempotencyKey: string }) =>
      adminApi<{ delivery: AdminDelivery }>(`${RESOURCE}deliveries&action=retry`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'deliveries'] });
      void queryClient.invalidateQueries({ queryKey: adminKeys.attention });
    },
  });
}

/** «Требует внимания»: сервер держит кеш 60 с, чаще спрашивать бессмысленно (трафик Supabase). */
export function useAdminAttention() {
  return useQuery({
    queryKey: adminKeys.attention,
    queryFn: () => adminApi<AdminAttention>(`${RESOURCE}attention`),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

export function useAdminSystem(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: adminKeys.system,
    queryFn: () => adminApi<AdminSystem>(`${RESOURCE}system`),
    staleTime: 30_000,
    enabled: opts.enabled ?? true,
  });
}

/**
 * «Обновить» на странице «Система»: мимо серверного кеша (force=1, сервер
 * пускает не чаще раза в 10 с). Результат кладётся в общий кеш запроса.
 */
export async function refreshAdminSystem(queryClient: QueryClient): Promise<AdminSystem> {
  const data = await adminApi<AdminSystem>(`${RESOURCE}system&force=1`);
  queryClient.setQueryData(adminKeys.system, data);
  return data;
}

export function useAdminUserCounts(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: adminKeys.userCounts,
    queryFn: () => adminApi<AdminUserCounts>(`${USERS}&action=counts`),
    staleTime: 60_000,
    enabled: opts.enabled ?? true,
  });
}
