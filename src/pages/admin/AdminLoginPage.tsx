import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { useAdminLogin } from '../../api/admin';
import { Alert, Button, Card, Field, Input } from '../../ui';

/**
 * Пароль и одноразовый код вводятся одной строкой через двоеточие — так устроен
 * серверный handleLogin: он режет строку по последнему двоеточию и только когда
 * задан ADMIN_TOTP_SECRET. Отдельного поля для OTP нет намеренно, иначе форма
 * выдавала бы, включена ли на сервере двухфакторная защита.
 */
export function AdminLoginPage() {
  const [password, setPassword] = useState('');
  const login = useAdminLogin();

  return (
    <div className="page" style={{ maxWidth: 420, margin: '0 auto' }}>
      <Card>
        <div className="stack">
          <h1 style={{ margin: 0, fontSize: 20 }}>
            <LockKeyhole size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />
            Панель управления
          </h1>

          <form
            className="stack"
            onSubmit={event => {
              event.preventDefault();
              login.mutate(password);
            }}
          >
            <Field label="Пароль" help="Если включена двухфакторная защита: пароль:123456">
              <Input
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={event => setPassword(event.target.value)}
              />
            </Field>

            {login.isError && <Alert tone="error">{login.error.message}</Alert>}

            <Button type="submit" block loading={login.isPending} disabled={!password}>
              Войти
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
