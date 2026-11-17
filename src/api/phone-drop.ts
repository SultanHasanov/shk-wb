import { ApiError } from './client';

// Страница телефона «Файлы на компьютер» (/t/<токен>, server/_phone-drop.js). Без входа:
// голый fetch без cookie — токен входа сайта сюда не нужен.

export type PhoneLimits = { chunkBytes: number; fileBytes: number; sessionBytes: number; sessionFiles: number };
export type PhoneFileState = { id: string; name: string; size: number; chunks: number; received: number; delivered: number; done: boolean; canceled: boolean };
export type PhoneInfo = { pcName: string; limits: PhoneLimits; files: PhoneFileState[]; secret?: string };

async function request<T>(token: string, op: string, init: RequestInit & { secret?: string; query?: string } = {}): Promise<T> {
  const { secret, query, headers, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`/api/phone/${encodeURIComponent(token)}/${op}${query ? `?${query}` : ''}`, {
      ...rest,
      credentials: 'omit',
      headers: { ...(secret ? { 'X-Phone-Secret': secret } : {}), ...(headers || {}) },
    });
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте интернет.', 0, 'NETWORK');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || `Ошибка сервера (${response.status})`, response.status, body.code);
  return body as T;
}

export function openLink(token: string, secret: string | null) {
  return request<PhoneInfo>(token, 'open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(secret ? { secret } : {}),
  });
}

export function linkState(token: string, secret: string) {
  return request<PhoneInfo>(token, 'state', { secret });
}

export function startFile(token: string, secret: string, file: { name: string; size: number; mime: string }) {
  return request<{ file: string; chunkBytes: number }>(token, 'file', {
    method: 'POST',
    secret,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(file),
  });
}

export function sendChunk(token: string, secret: string, fileId: string, idx: number, blob: Blob, signal?: AbortSignal) {
  return request<{ ok: true }>(token, 'chunk', {
    method: 'POST',
    secret,
    query: `file=${fileId}&idx=${idx}`,
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
    signal,
  });
}

export function cancelFile(token: string, secret: string, fileId: string) {
  return request<{ ok: true }>(token, 'cancel', { method: 'POST', secret, query: `file=${fileId}` });
}
