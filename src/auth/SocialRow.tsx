import { useT } from '../i18n';
import { TelegramLogin } from './TelegramLogin';
import { ProviderMark, useOAuthProviders } from './OAuthButtons';

/**
 * Внешние входы одним рядом (по прототипу): виджет Telegram (medium) + круглые кнопки Яндекс ID и Mail.ru.
 * Яндекс и Mail.ru уводят на /api/auth/oauth/<id>/start и возвращаются на /auth/oauth → next.
 */
export function SocialRow({ next, onError, onTelegramSuccess }: { next: string; onError: (message: string) => void; onTelegramSuccess: () => void }) {
  const t = useT();
  const providers = useOAuthProviders();
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--text-tertiary)', fontSize: 'var(--fs-13)' }}>
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        {t('или войдите через', 'немесе мына арқылы кіріңіз')}
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
        <TelegramLogin size="medium" navigateAfterLogin={false} onError={onError} onSuccess={onTelegramSuccess} />
        {providers.data?.map(provider => (
          <a
            key={provider.id}
            href={`/api/auth/oauth/${provider.id}/start?next=${encodeURIComponent(next)}`}
            aria-label={t(`Войти через ${provider.title}`, `${provider.title} арқылы кіру`)}
            title={provider.title}
            style={{
              width: 44, height: 44, borderRadius: 22, border: '1px solid var(--border-strong)', background: 'var(--surface)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
            }}
          >
            <ProviderMark id={provider.id} />
          </a>
        ))}
      </div>
    </div>
  );
}
