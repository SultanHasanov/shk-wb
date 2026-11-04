import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Link2 } from 'lucide-react';
import { api } from '../api/client';
import type { UserProfile } from '../api/cabinet';
import { useT } from '../i18n';
import { Button, useToast } from '../ui';
import { useOAuthProviders } from './OAuthButtons';

type ProviderId = 'yandex' | 'mailru';

/**
 * Профиль → «Способы входа»: привязать или отвязать Яндекс ID / Mail.ru у текущего кабинета.
 * Привязка: GET /api/auth/oauth/<p>/start?mode=link с Bearer → { url } → переход к провайдеру; сервер
 * возвращает на /cabinet/profile?oauth=linked|error (server/_oauth-login.js).
 */
export function OAuthLinks({ profile, onChanged }: { profile: UserProfile; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const providers = useOAuthProviders();
  const [starting, setStarting] = useState<ProviderId | null>(null);
  const [unlinking, setUnlinking] = useState<ProviderId | null>(null);
  const handled = useRef(false);

  // Результат привязки приходит в адресе после возврата от провайдера.
  useEffect(() => {
    if (handled.current) return;
    const params = new URLSearchParams(location.search);
    const result = params.get('oauth');
    if (!result) return;
    handled.current = true;
    if (result === 'linked') toast(t('Способ входа привязан', 'Кіру тәсілі байланды'), 'success');
    else if (params.get('reason') === 'taken') toast(t('Этот аккаунт уже привязан к другому кабинету', 'Бұл аккаунт басқа кабинетке байланған'), 'error');
    else toast(t('Не удалось привязать. Попробуйте ещё раз', 'Байлау мүмкін болмады. Қайта көріңіз'), 'error');
    onChanged();
    navigate(location.pathname, { replace: true });
  }, [location.pathname, location.search, navigate, onChanged, t, toast]);

  if (!providers.data?.length) return null;
  const linked = new Map(profile.oauth.map(row => [row.provider, row]));
  const title = (id: ProviderId) => providers.data?.find(p => p.id === id)?.title ?? id;

  const start = async (id: ProviderId) => {
    setStarting(id);
    try {
      const { url } = await api<{ url: string }>(`/api/auth/oauth/${id}/start?mode=link`);
      window.location.href = url;
    } catch (e) {
      setStarting(null);
      toast(e instanceof Error ? e.message : t('Не удалось начать привязку', 'Байлауды бастау мүмкін болмады'), 'error');
    }
  };

  const remove = async (id: ProviderId) => {
    setUnlinking(id);
    try {
      await api<void>(`/api/cabinet/oauth?provider=${id}`, { method: 'DELETE' });
      toast(t('Отвязано', 'Ажыратылды'), 'success');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : t('Не удалось отвязать', 'Ажырату мүмкін болмады'), 'error');
    } finally {
      setUnlinking(null);
    }
  };

  return (
    <>
      {providers.data.map(provider => {
        const row = linked.get(provider.id);
        return (
          <div key={provider.id} className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 8 }}>
              <Link2 size={16} />
              <span>{title(provider.id)}{row ? `: ${row.email || row.displayName || t('привязан', 'байланған')}` : ` ${t('не привязан', 'байланбаған')}`}</span>
            </span>
            {row
              ? <Button variant="ghost" size="sm" loading={unlinking === provider.id} onClick={() => remove(provider.id)}>{t('Отвязать', 'Ажырату')}</Button>
              : <Button variant="secondary" size="sm" loading={starting === provider.id} onClick={() => start(provider.id)}>{t('Привязать', 'Байлау')}</Button>}
          </div>
        );
      })}
    </>
  );
}
