import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { api } from '../api/client';
import { useStores } from '../stores/root-store';
import { Alert, Button, Card, Field, Input, Spinner } from '../ui';

type AccountStatus = 'loading' | 'unlinked' | 'empty_technical' | 'linked' | 'has_data' | 'error';
type MergePreview = {
  action: 'merge' | 'relink';
  targetEmail: string;
  summary: { orders: number; history: number; licenses: number; codes: number; generations: number };
};

export const TelegramAccountPage = observer(() => {
  const { auth } = useStores();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState<AccountStatus>('loading');
  const [canConnect, setCanConnect] = useState(false);
  const [preview, setPreview] = useState<MergePreview | null>(null);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) {
      setStatus('error');
      setError('Откройте эту страницу кнопкой «Аккаунт» в Telegram-боте.');
      return;
    }
    webApp.ready();
    webApp.expand();
    api<{ state: Exclude<AccountStatus, 'loading' | 'error'>; canConnect: boolean }>('/api/auth/telegram', {
      method: 'POST',
      body: JSON.stringify({ webAppData: webApp.initData, mode: 'status' }),
    }).then(result => {
      setStatus(result.state);
      setCanConnect(result.canConnect);
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
      const result = await api<MergePreview>('/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ webAppData: webApp.initData, mode: 'prepare_merge' }),
      });
      setPreview(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось подключить кабинет');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData || !preview) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ webAppData: webApp.initData, mode: preview.action }),
      });
      setDone(true);
      window.setTimeout(() => webApp.close(), 1100);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось объединить кабинеты');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="stack">
        <div>
          <h1 style={{ fontSize: 'var(--fs-24)', marginBottom: 'var(--sp-2)' }}>Аккаунт Telegram-бота</h1>
          {canConnect && !preview && <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
            Войдите в основной кабинет. Перед объединением мы покажем, какие данные будут перенесены.
          </p>}
        </div>
        {status === 'loading' ? (
          <><Spinner /><p className="muted">Проверяем текущий кабинет…</p></>
        ) : done ? (
          <Alert tone="success">Готово. Кабинет подключён — возвращаем вас в бот.</Alert>
        ) : status === 'error' ? (
          <Alert tone="error">{error}</Alert>
        ) : preview ? (
          <>
            <Alert tone="info">
              {preview.action === 'merge'
                ? `Текущий Telegram-кабинет будет объединён с ${preview.targetEmail}. Пакеты и история сохранятся, а технический дубликат удалится.`
                : `Telegram будет подключён к ${preview.targetEmail}.`}
            </Alert>
            {preview.action === 'merge' && <div className="stack" style={{ gap: 'var(--sp-2)', fontSize: 'var(--fs-14)' }}>
              <div>Остаток генераций: <strong>{preview.summary.generations}</strong></div>
              <div>Пакеты: <strong>{preview.summary.codes}</strong></div>
              <div>Успешные заказы: <strong>{preview.summary.orders}</strong></div>
              <div>Записи истории: <strong>{preview.summary.history}</strong></div>
              <div>Лицензии: <strong>{preview.summary.licenses}</strong></div>
            </div>}
            {error && <Alert tone="error">{error}</Alert>}
            <Button type="button" size="lg" block loading={busy} onClick={() => void confirm()}>
              {preview.action === 'merge' ? 'Объединить кабинеты' : 'Подключить кабинет'}
            </Button>
            <Button type="button" variant="secondary" block disabled={busy} onClick={() => setPreview(null)}>Назад</Button>
          </>
        ) : !canConnect ? (
          <>
            <Alert tone="info">
              Этот Telegram уже связан с постоянным кабинетом. Продолжайте пользоваться им в боте.
            </Alert>
            <Button type="button" block onClick={() => window.Telegram?.WebApp?.close()}>Вернуться в бот</Button>
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
                Продолжить
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
