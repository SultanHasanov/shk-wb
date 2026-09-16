export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /**
     * Машиночитаемый код из ответа бэкенда: ACCESS_CODE_REQUIRED,
     * ACCESS_CODE_LIMIT, INVALID_ACCESS_CODE и т.п. Раньше терялся, и отличить
     * исчерпанную квоту от настоящей ошибки можно было только по русскому тексту.
     */
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let accessToken: string | undefined;
  if (url.startsWith('/api/')) {
    try {
      accessToken = (await getSupabase().auth.getSession()).data.session?.access_token;
    } catch {
      // Public API requests remain available when no auth session exists.
    }
  }
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(body.error || 'Не удалось выполнить запрос', response.status, body.code);
  return body as T;
}

export async function apiBlob(url: string, init?: RequestInit): Promise<Blob> {
  const accessToken = (await getSupabase().auth.getSession()).data.session?.access_token;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error || 'Не удалось подготовить файл', response.status, body.code);
  }
  return response.blob();
}

/** Ошибка означает, что генерации кончились — это повод предложить пакет, а не ругаться. */
export function isQuotaError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'ACCESS_CODE_REQUIRED' || error.code === 'ACCESS_CODE_LIMIT')
  );
}

/** Код куплен другим аккаунтом: помогает не текст ошибки, а кнопка входа. */
export function isOwnerError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'ACCESS_CODE_OWNER_REQUIRED';
}
import { getSupabase } from '../auth/supabase';
