import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useT } from '../i18n';
import { Button } from '../ui';

type Provider = { id: 'yandex' | 'mailru'; title: string };

/** Яндекс ID и Mail.ru подключаются в .env сервера; без ключей список пуст и кнопок нет. */
export function useOAuthProviders() {
  return useQuery({
    queryKey: ['auth', 'oauth-providers'],
    queryFn: () => api<{ providers: Provider[] }>('/api/auth/oauth/providers'),
    staleTime: 10 * 60_000,
    select: data => data.providers ?? [],
  });
}

function YandexMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#fc3f1d" />
      <path d="M13.6 19.5h2.4V4.5h-3.5c-3.5 0-5.4 1.8-5.4 4.5 0 2.1 1 3.4 2.8 4.7l-3.2 5.8h2.6l3.6-6.5-1.2-.8c-1.5-1-2.2-1.8-2.2-3.4 0-1.5 1-2.4 2.9-2.4h1.2v13.1z" fill="#fff" />
    </svg>
  );
}

function MailMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#005ff9" />
      <path d="M12 6.5a5.5 5.5 0 1 0 3.3 9.9l-.9-1.3a3.9 3.9 0 1 1 1.5-3.1v.8a1.2 1.2 0 0 1-2.4 0V12a1.5 1.5 0 1 0-.4 1l.1.1a2.8 2.8 0 0 0 4.3-2.3V12A5.5 5.5 0 0 0 12 6.5z" fill="#fff" />
    </svg>
  );
}

/**
 * Кнопки входа через Яндекс ID и Mail.ru: переход на /api/auth/oauth/<провайдер>/start, дальше сервер
 * ведёт к провайдеру и возвращает на /auth/oauth с token_hash (см. OAuthCompletePage).
 */
export function OAuthButtons({ next = '/cabinet' }: { next?: string }) {
  const t = useT();
  const providers = useOAuthProviders();
  if (!providers.data?.length) return null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="muted" style={{ textAlign: 'center', fontSize: 'var(--fs-13)' }}>{t('или войдите через', 'немесе мына арқылы кіріңіз')}</div>
      <div className="row" style={{ gap: 8 }}>
        {providers.data.map(provider => (
          <Button
            key={provider.id}
            type="button"
            variant="secondary"
            block
            onClick={() => { window.location.href = `/api/auth/oauth/${provider.id}/start?next=${encodeURIComponent(next)}`; }}
          >
            {provider.id === 'yandex' ? <YandexMark /> : <MailMark />}
            {provider.title}
          </Button>
        ))}
      </div>
    </div>
  );
}
