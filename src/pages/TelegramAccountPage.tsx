import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { api } from '../api/client';
import { useStores } from '../stores/root-store';
import { Alert, Button, Card, Field, Input } from '../ui';

export const TelegramAccountPage = observer(() => {
  const { auth } = useStores();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

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
          <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
            Войдите в кабинет, где покупали генерации. Telegram будет подключён к нему, а пустой случайно созданный кабинет удалится автоматически.
          </p>
        </div>
        {done ? (
          <Alert tone="success">Готово. Кабинет подключён — возвращаем вас в бот.</Alert>
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
