import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export type OAuthProviderId = 'yandex' | 'mailru';
export type OAuthProvider = { id: OAuthProviderId; title: string };

/** Яндекс ID и Mail.ru подключаются в .env сервера; без ключей список пуст и кнопок нет. */
export function useOAuthProviders() {
  return useQuery({
    queryKey: ['auth', 'oauth-providers'],
    queryFn: () => api<{ providers: OAuthProvider[] }>('/api/auth/oauth/providers'),
    staleTime: 10 * 60_000,
    select: data => data.providers ?? [],
  });
}

export function YandexMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#fc3f1d" />
      <path d="M13.6 19.5h2.4V4.5h-3.5c-3.5 0-5.4 1.8-5.4 4.5 0 2.1 1 3.4 2.8 4.7l-3.2 5.8h2.6l3.6-6.5-1.2-.8c-1.5-1-2.2-1.8-2.2-3.4 0-1.5 1-2.4 2.9-2.4h1.2v13.1z" fill="#fff" />
    </svg>
  );
}

export function MailMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#005ff9" />
      <path d="M12 6.5a5.5 5.5 0 1 0 3.3 9.9l-.9-1.3a3.9 3.9 0 1 1 1.5-3.1v.8a1.2 1.2 0 0 1-2.4 0V12a1.5 1.5 0 1 0-.4 1l.1.1a2.8 2.8 0 0 0 4.3-2.3V12A5.5 5.5 0 0 0 12 6.5z" fill="#fff" />
    </svg>
  );
}

export function ProviderMark({ id, size }: { id: OAuthProviderId; size?: number }) {
  return id === 'yandex' ? <YandexMark size={size} /> : <MailMark size={size} />;
}
