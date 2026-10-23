import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { CircleCheck, Laptop } from 'lucide-react';
import { api } from '../api/client';
import { useStores } from '../stores/root-store';
import { Alert, Button, Card, Spinner } from '../ui';
import { useDocumentMeta } from '../lib/seo';

// Куда можно вернуть после входа по ссылке из программы — только в кабинет.
const SAFE_NEXT = /^\/cabinet(\/[a-z-]+)?(\?[a-z0-9=&_-]{0,80})?$/i;

/** «Открыть кабинет» из программы: одноразовая ссылка сразу входит на сайт. */
const SiteLinkLogin = observer(({ tokenHash, next }: { tokenHash: string; next: string }) => {
  const { auth } = useStores();
  const navigate = useNavigate();
  const started = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    auth.acceptTelegramToken(tokenHash)
      .then(() => navigate(SAFE_NEXT.test(next) ? next : '/cabinet/subscription', { replace: true }))
      .catch(() => setError('Ссылка устарела или уже использована. Откройте кабинет из программы ещё раз или войдите вручную.'));
  }, [auth, navigate, next, tokenHash]);
  return (
    <Card>
      <div className="stack" style={{ textAlign: 'center' }}>
        {error ? <><Alert tone="error">{error}</Alert><Link to="/login"><Button>Войти</Button></Link></> : <><Spinner /><p className="muted">Входим в кабинет…</p></>}
      </div>
    </Card>
  );
});

/** Вход в программу через сайт: программа показала код, человек подтверждает его здесь. */
const ApproveProgramLogin = observer(({ code }: { code: string }) => {
  const { auth } = useStores();
  const location = useLocation();
  const request = useQuery({
    queryKey: ['app-login-request', code],
    queryFn: () => api<{ deviceName: string; status: string; program?: string }>(`/api/app/login/request?code=${encodeURIComponent(code)}`),
    retry: false,
  });
  const approve = useMutation({
    mutationFn: () => api<{ deviceName: string }>('/api/app/login/approve', { method: 'POST', body: JSON.stringify({ code }) }),
  });

  let body;
  if (request.isPending || auth.status === 'initializing') body = <><Spinner /><p className="muted">Проверяем код…</p></>;
  else if (request.isError) body = <Alert tone="error">{request.error.message}</Alert>;
  else if (approve.isSuccess) body = (
    <>
      <CircleCheck size={40} color="var(--success)" style={{ margin: '0 auto' }} />
      <h1 style={{ margin: 0 }}>Готово</h1>
      <p className="muted" style={{ margin: 0 }}>Вернитесь в программу — вход выполнится автоматически через несколько секунд.</p>
    </>
  );
  else if (request.data.status !== 'pending') body = <Alert tone="warning">Этот код уже использован. Если вы не входили в программу, смените пароль в профиле.</Alert>;
  else if (!auth.user) body = (
    <>
      <h1 style={{ margin: 0 }}>Вход в «{request.data.program || 'Помощник ПВЗ'}»</h1>
      <p className="muted" style={{ margin: 0 }}>Чтобы подключить программу на компьютере «{request.data.deviceName}», войдите в аккаунт сайта.</p>
      <Link to="/login" state={{ from: `${location.pathname}${location.search}` }}><Button block>Войти в аккаунт</Button></Link>
    </>
  );
  else body = (
    <>
      <Laptop size={40} color="var(--accent)" style={{ margin: '0 auto' }} />
      <h1 style={{ margin: 0 }}>Войти в «{request.data.program || 'Помощник ПВЗ'}»?</h1>
      <p style={{ margin: 0 }}>Компьютер: <strong>{request.data.deviceName}</strong></p>
      <p className="muted" style={{ margin: 0 }}>Аккаунт: {auth.user.email?.endsWith('@users.invalid') ? 'вход через Telegram' : auth.user.email}. Подтверждайте, только если сами нажали «Войти через сайт» в программе.</p>
      <p className="muted mono" style={{ margin: 0 }}>Код: {code.slice(0, 4)}-{code.slice(4)}</p>
      {approve.isError && <Alert tone="error">{approve.error.message}</Alert>}
      <Button block loading={approve.isPending} onClick={() => approve.mutate()}>Подтвердить вход</Button>
    </>
  );
  return <Card><div className="stack" style={{ textAlign: 'center' }}>{body}</div></Card>;
});

export function AppLoginPage() {
  useDocumentMeta('Вход в программу «Помощник ПВЗ»');
  const [params] = useSearchParams();
  const tokenHash = params.get('th');
  const code = String(params.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (tokenHash) return <SiteLinkLogin tokenHash={tokenHash} next={params.get('next') || '/cabinet/subscription'} />;
  if (/^[A-Z2-9]{8}$/.test(code)) return <ApproveProgramLogin code={code} />;
  // ссылка из письма после регистрации в программе: программа сама ждёт подтверждения
  if (params.get('confirmed') === '1') {
    return (
      <Card>
        <Alert tone="success">Почта подтверждена. Вернитесь в программу «Помощник ПВЗ» — она войдёт в аккаунт сама в течение нескольких секунд.</Alert>
      </Card>
    );
  }
  return <Card><Alert tone="error">Ссылка неполная. Нажмите «Войти через сайт» в программе ещё раз.</Alert></Card>;
}
