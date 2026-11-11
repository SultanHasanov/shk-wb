import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { CircleCheck, Laptop } from 'lucide-react';
import { api } from '../api/client';
import { useStores } from '../stores/root-store';
import { Alert, Button, Card, Spinner } from '../ui';
import { useDocumentMeta } from '../lib/seo';
import { isFinalLoginStatusError, loginStatusInterval, retryLoginStatus } from '../lib/app-login-poll';

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

type LoginRequest = { deviceName: string; status: string; program?: string; telegramUrl?: string | null; telegramQr?: string | null };

// Опрос статуса кода (раз в 3 с): подтверждение может прийти из Telegram-бота, пока страница открыта.

/**
 * Вход в программу: программа открыла страницу с кодом. Без входа на сайт главный путь — подтвердить
 * в Telegram-боте (кнопка или QR с телефона, /start login_<код>), вторичный — войти в аккаунт сайта.
 */
const ApproveProgramLogin = observer(({ code }: { code: string }) => {
  const { auth } = useStores();
  const location = useLocation();
  const request = useQuery({
    queryKey: ['app-login-request', code],
    queryFn: () => api<LoginRequest>(`/api/app/login/request?code=${encodeURIComponent(code)}`),
    retry: false,
    // Снимок на момент открытия: свежий статус — в опросе ниже. Перечитывание при возврате на вкладку
    // (человек подтвердил в Telegram) показало бы «код уже использован» вместо «Готово».
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const approve = useMutation({
    mutationFn: () => api<{ deviceName: string }>('/api/app/login/approve', { method: 'POST', body: JSON.stringify({ code }) }),
  });
  const initiallyPending = request.data?.status === 'pending';
  const status = useQuery({
    queryKey: ['app-login-status', code],
    queryFn: () => api<LoginRequest>(`/api/app/login/request?code=${encodeURIComponent(code)}&poll=1`),
    enabled: initiallyPending && !approve.isSuccess,
    // Временный сбой (сеть, 502 при перезапуске) не ломает экран: повторяем и опрашиваем дальше.
    // Стоп и сообщение — только на окончательном ответе (код устарел или не найден).
    refetchInterval: query => loginStatusInterval(query.state.data, query.state.error),
    retry: retryLoginStatus,
  });
  const statusFinalError = status.isError && isFinalLoginStatusError(status.error) ? status.error : null;
  // Код был свободен при открытии страницы, а теперь занят — его подтвердили (в боте или в другой вкладке).
  const confirmedElsewhere = initiallyPending && Boolean(status.data && status.data.status !== 'pending');
  const program = request.data?.program || 'Помощник ПВЗ';

  let body;
  if (request.isPending || auth.status === 'initializing') body = <><Spinner /><p className="muted">Проверяем код…</p></>;
  else if (request.isError) body = <Alert tone="error">{request.error.message}</Alert>;
  else if (approve.isSuccess || confirmedElsewhere) body = (
    <>
      <CircleCheck size={40} color="var(--success)" style={{ margin: '0 auto' }} />
      <h1 style={{ margin: 0 }}>Готово, вернитесь в программу</h1>
      <p className="muted" style={{ margin: 0 }}>Вход выполнится сам через несколько секунд. Эту вкладку можно закрыть.</p>
    </>
  );
  else if (statusFinalError) body = <Alert tone="error">{statusFinalError.message}</Alert>;
  else if (request.data.status !== 'pending') body = <Alert tone="warning">Этот код уже использован. Если вы не входили в программу, напишите в поддержку.</Alert>;
  else if (!auth.user) body = (
    <>
      <h1 style={{ margin: 0 }}>Вход в «{program}»</h1>
      <p className="muted" style={{ margin: 0 }}>Компьютер: <strong>{request.data.deviceName}</strong>. Код: <span className="mono">{code.slice(0, 4)}-{code.slice(4)}</span></p>
      {request.data.telegramUrl ? (
        <>
          <p style={{ margin: 0 }}>Подтвердите вход в Telegram-боте — аккаунт на сайте не нужен.</p>
          <a href={request.data.telegramUrl} target="_blank" rel="noopener noreferrer"><Button block>Подтвердить в Telegram-боте</Button></a>
          {request.data.telegramQr && (
            <>
              <img src={request.data.telegramQr} alt="QR-код для входа через Telegram-бот" width={200} height={200} style={{ margin: '0 auto', display: 'block' }} />
              <p className="muted" style={{ margin: 0 }}>Нет Telegram на этом компьютере? Наведите камеру телефона на QR.</p>
            </>
          )}
          <Link to="/login" state={{ from: `${location.pathname}${location.search}` }}><Button block variant="secondary">Войти в аккаунт сайта</Button></Link>
        </>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>Чтобы подключить программу, войдите в аккаунт сайта.</p>
          <Link to="/login" state={{ from: `${location.pathname}${location.search}` }}><Button block>Войти в аккаунт сайта</Button></Link>
        </>
      )}
    </>
  );
  else body = (
    <>
      <Laptop size={40} color="var(--accent)" style={{ margin: '0 auto' }} />
      <h1 style={{ margin: 0 }}>Войти в «{program}»?</h1>
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
        <Alert tone="success">Почта подтверждена. Вернитесь в программу («Помощник ПВЗ» или «ПВЗ Принт») — она войдёт в аккаунт сама в течение нескольких секунд. Эту вкладку можно закрыть.</Alert>
      </Card>
    );
  }
  return <Card><Alert tone="error">Ссылка неполная. Нажмите «Войти через сайт» в программе ещё раз.</Alert></Card>;
}
