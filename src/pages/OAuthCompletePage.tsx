import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useStores } from '../stores/root-store';
import { useT } from '../i18n';
import { Alert, Button, Card, Spinner } from '../ui';
import { useDocumentMeta } from '../lib/seo';

// Куда можно вернуть после входа через провайдера: только внутренние адреса сайта.
const SAFE_NEXT = /^\/[a-z0-9/_-]{0,80}(\?[a-z0-9=&_-]{0,80})?$/i;

/** Завершение входа через Яндекс ID / Mail.ru: сервер вернул token_hash, обмениваем его на сессию. */
export const OAuthCompletePage = observer(() => {
  const t = useT();
  const { auth } = useStores();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const started = useRef(false);
  const [error, setError] = useState('');
  useDocumentMeta(t('Вход', 'Кіру'));

  const tokenHash = params.get('token_hash') || '';
  const nextParam = params.get('next') || '/cabinet';
  const next = SAFE_NEXT.test(nextParam) && !nextParam.startsWith('//') ? nextParam : '/cabinet';

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!tokenHash) {
      setError(t('Ссылка входа неполная. Попробуйте войти ещё раз.', 'Кіру сілтемесі толық емес. Қайта кіріп көріңіз.'));
      return;
    }
    auth.acceptTelegramToken(tokenHash)
      .then(() => navigate(next, { replace: true }))
      .catch(() => setError(t('Ссылка входа устарела или уже использована. Войдите ещё раз.', 'Кіру сілтемесі ескірген немесе қолданылған. Қайта кіріңіз.')));
  }, [auth, navigate, next, t, tokenHash]);

  return (
    <Card>
      <div className="stack" style={{ textAlign: 'center' }}>
        {error
          ? <><Alert tone="error">{error}</Alert><Link to="/login"><Button>{t('Войти', 'Кіру')}</Button></Link></>
          : <><Spinner /><p className="muted">{t('Входим в кабинет…', 'Кабинетке кіріп жатырмыз…')}</p></>}
      </div>
    </Card>
  );
});
