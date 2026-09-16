import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { api } from '../api/client';
import { useStores } from '../stores/root-store';
import { Alert, Button, Card, Field, Input, Spinner } from '../ui';

type AccountStatus = 'loading' | 'unlinked' | 'empty_technical' | 'linked' | 'has_data' | 'error';

export const TelegramAccountPage = observer(() => {
  const { auth } = useStores();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState<AccountStatus>('loading');
  const [canRelink, setCanRelink] = useState(false);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) {
      setStatus('error');
      setError('Откройте эту страницу кнопкой «Аккаунт» в Telegram-боте.');
      return;
    }
    webApp.ready();
    webApp.expand();
    api<{ state: Exclude<AccountStatus, 'loading' | 'error'>; canRelink: boolean }>('/api/auth/telegram', {
      method: 'POST',
      body: JSON.stringify({ webAppData: webApp.initData, mode: 'status' }),
    }).then(result => {
      setStatus(result.state);
      setCanRelink(result.canRelink);
    }).catch(reason => {
      setStatus('error');
      setError(reason instanceof Error ? reason.message : 'Не удалось проверить кабинет');
    });
  }, []);

  const connect = async () => {
    setError('');
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) {
      setError('Откройте эту страницу кнопкой «Аккаунт» в Telegram-боте.');
      return;
    }
    setBusy(true);
    try {
      webApp.ready();
      webApp.expand();
      await auth.signIn(email.trim(), password, true);
      await api('/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ webAppData: webApp.initData, mode: 'relink' }),
      });
      setDone(true);
      window.setTimeout(() => webApp.close(), 900);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось подключить кабинет');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="stack">
        <div>
          <h1 style={{ fontSize: 'var(--fs-24)', marginBottom: 'var(--sp-2)' }}>Аккаунт Telegram-бота</h1>
          {canRelink && <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
            Войдите в кабинет, где покупали генерации. Telegram будет подключён к нему, а пустой случайно созданный кабинет удалится автоматически.
          </p>}
        </div>
        {status === 'loading' ? (
          <><Spinner /><p className="muted">Проверяем текущий кабинет…</p></>
        ) : done ? (
          <Alert tone="success">Готово. Кабинет подключён — возвращаем вас в бот.</Alert>
        ) : status === 'error' ? (
          <Alert tone="error">{error}</Alert>
        ) : !canRelink ? (
          <>
            <Alert tone="info">
              {status === 'has_data'
                ? 'В этом Telegram-кабинете уже есть покупки или история генераций. Автоматическая смена недоступна, чтобы не потерять данные.'
                : 'Этот Telegram уже связан с постоянным кабинетом. Для объединения с другим кабинетом обратитесь в поддержку.'}
            </Alert>
            <Button type="button" block onClick={() => window.Telegram?.WebApp?.close()}>Вернуться в бот</Button>
            <Button type="button" variant="secondary" block onClick={() => {
              const webApp = window.Telegram?.WebApp;
              const url = 'https://t.me/roma_denosov';
              if (webApp?.openTelegramLink) webApp.openTelegramLink(url);
              else webApp?.openLink(url);
            }}>Объединить кабинеты через поддержку</Button>
          </>
        ) : (
          <>
            {error && <Alert tone="error">{error}</Alert>}
            <form
              className="stack"
              onSubmit={event => {
                event.preventDefault();
                void connect();
              }}
            >
              <Field label="Электронная почта">
                <Input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} />
              </Field>
              <Field label="Пароль">
                <Input type="password" autoComplete="current-password" minLength={8} required value={password} onChange={event => setPassword(event.target.value)} />
              </Field>
              <Button type="submit" size="lg" block loading={busy} disabled={!email.trim() || password.length < 8}>
                Подключить этот кабинет
              </Button>
            </form>
            <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-12)' }}>
              Пароль проверяет система авторизации сайта. Бот не получает и не сохраняет его.
            </p>
          </>
        )}
      </div>
    </Card>
  );
});
