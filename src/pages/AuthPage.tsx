import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { TelegramLogin } from '../auth/TelegramLogin';
import { useStores } from '../stores/root-store';
import { useDocumentMeta } from '../lib/seo';
import { Alert, Button, Card, Checkbox, Field, Input, useToast } from '../ui';

type Mode = 'login' | 'register' | 'forgot';
type Values = { email: string; password?: string; accept?: boolean };

const copy: Record<Mode, { title: string; text: string; submit: string }> = {
  login: { title: 'Вход в кабинет', text: 'Управляйте ключами, заказами и настройками из одного места.', submit: 'Войти' },
  register: { title: 'Регистрация', text: 'Создайте аккаунт, чтобы хранить ключи и историю генераций.', submit: 'Создать аккаунт' },
  forgot: { title: 'Восстановление доступа', text: 'Укажите почту — пришлём ссылку для смены пароля.', submit: 'Отправить ссылку' },
};

const email = z.string().email('Введите корректную почту');
const password = z.string().min(8, 'Минимум 8 символов');
/* Согласие с офертой и политикой — обязательное поле формы, а не мелкий текст
   под кнопкой: у аккаунта появляются платежи и персональные данные. */
const accept = z
  .boolean()
  .refine(value => value, 'Подтвердите согласие с офертой и политикой конфиденциальности');
const schemas = {
  login: z.object({ email, password }),
  register: z.object({ email, password, accept }),
  forgot: z.object({ email }),
};

export function AuthPage({ mode = 'login' }: { mode?: Mode }) {
  const { auth } = useStores();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [formError, setFormError] = useState('');
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [isResending, setIsResending] = useState(false);
  // По умолчанию отмечено: подавляющее большинство входит со своего рабочего
  // компьютера на пункте выдачи, и повторный вход каждый день — лишний барьер.
  const [remember, setRemember] = useState(true);
  const c = copy[mode];

  useDocumentMeta(c.title, c.text);
  const from = (location.state as { from?: string } | null)?.from ?? '/cabinet';
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schemas[mode]) });

  const onSubmit = handleSubmit(async values => {
    setFormError('');
    try {
      if (mode === 'forgot') {
        await auth.requestPasswordReset(values.email);
        setResetEmail(values.email);
        return;
      }
      if (mode === 'register') {
        const result = await auth.signUp(values.email, values.password!);
        if (result.confirmationRequired) {
          setConfirmationEmail(values.email);
          return;
        }
      } else await auth.signIn(values.email, values.password!, remember);
      navigate(from, { replace: true });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Не удалось выполнить запрос');
    }
  });

  if (mode === 'forgot' && resetEmail) {
    const resend = async () => {
      setFormError('');
      setIsResending(true);
      try {
        await auth.requestPasswordReset(resetEmail);
        toast('Письмо отправлено повторно', 'success');
      } catch (error) {
        setFormError(error instanceof Error ? error.message : 'Не удалось отправить письмо повторно');
      } finally {
        setIsResending(false);
      }
    };

    return <Card><div className="stack">
      <div>
        <h1 style={{ fontSize: 'var(--fs-24)', marginBottom: 'var(--sp-2)' }}>Проверьте почту</h1>
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
          Если аккаунт с адресом <strong>{resetEmail}</strong> существует, мы отправили ссылку для создания нового пароля.
        </p>
      </div>
      <Alert tone="success">Проверьте папку «Входящие» и «Спам». Доставка письма может занять несколько минут.</Alert>
      {formError && <Alert tone="error">{formError}</Alert>}
      <Button type="button" size="lg" block loading={isResending} onClick={resend}>Отправить письмо повторно</Button>
      <Button type="button" variant="secondary" block onClick={() => setResetEmail('')}>Указать другую почту</Button>
      <Link className="accent" to="/login" style={{ textAlign: 'center' }}>Вернуться ко входу</Link>
    </div></Card>;
  }

  if (mode === 'register' && confirmationEmail) {
    const resend = async () => {
      setFormError('');
      setIsResending(true);
      try {
        await auth.resendSignUpConfirmation(confirmationEmail);
        toast('Письмо отправлено повторно', 'success');
      } catch (error) {
        setFormError(error instanceof Error ? error.message : 'Не удалось отправить письмо повторно');
      } finally {
        setIsResending(false);
      }
    };

    return <Card><div className="stack">
      <div>
        <h1 style={{ fontSize: 'var(--fs-24)', marginBottom: 'var(--sp-2)' }}>Проверьте почту</h1>
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
          Мы отправили ссылку для подтверждения на <strong>{confirmationEmail}</strong>. Перейдите по ней, чтобы завершить регистрацию.
        </p>
      </div>
      {formError && <Alert tone="error">{formError}</Alert>}
      <Button type="button" size="lg" block loading={isResending} onClick={resend}>Отправить письмо повторно</Button>
      <Button type="button" variant="secondary" block onClick={() => setConfirmationEmail('')}>Исправить адрес почты</Button>
      <Link className="accent" to="/login" style={{ textAlign: 'center' }}>Перейти ко входу</Link>
    </div></Card>;
  }

  return <Card><div className="stack">
    <div><h1 style={{ fontSize: 'var(--fs-24)', marginBottom: 'var(--sp-2)' }}>{c.title}</h1><p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>{c.text}</p></div>
    {formError && <Alert tone="error">{formError}</Alert>}
    <form className="stack" onSubmit={onSubmit}>
      <Field label="Электронная почта" error={errors.email?.message}><Input type="email" autoComplete="email" {...register('email')} /></Field>
      {mode !== 'forgot' && <Field label="Пароль" error={errors.password?.message} help={mode === 'register' ? 'Минимум 8 символов' : undefined}>
        <Input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} {...register('password')} />
      </Field>}

      {/* Без галочки сессия живёт в sessionStorage и гаснет с вкладкой —
          на общем компьютере пункта выдачи это единственная защита. */}
      {mode === 'login' && (
        <Checkbox id="remember-device" checked={remember} onChange={e => setRemember(e.target.checked)}>
          Запомнить это устройство
          <span style={{ display: 'block', fontSize: 'var(--fs-12)', color: 'var(--text-tertiary)' }}>
            На чужом компьютере снимите галочку — вход забудется при закрытии браузера.
          </span>
        </Checkbox>
      )}

      {mode === 'register' && (
        <div>
          <Checkbox id="accept-terms" {...register('accept')}>
            Я принимаю <Link to="/offer" target="_blank">условия оферты</Link> и{' '}
            <Link to="/privacy" target="_blank">политику конфиденциальности</Link>
          </Checkbox>
          {errors.accept && (
            <span role="alert" style={{ display: 'block', marginTop: 'var(--sp-2)', fontSize: 'var(--fs-12)', color: 'var(--danger)' }}>
              {errors.accept.message}
            </span>
          )}
        </div>
      )}

      <Button size="lg" block loading={isSubmitting}>{c.submit}</Button>
    </form>
    <div className="row" style={{ justifyContent: 'space-between', fontSize: 'var(--fs-13)' }}>
      {mode === 'login' ? <><Link className="accent" to="/register">Создать аккаунт</Link><Link className="accent" to="/forgot-password">Забыли пароль?</Link></> : <Link className="accent" to="/login">← Вернуться ко входу</Link>}
    </div>
    {mode !== 'forgot' && <><div className="muted" style={{ textAlign: 'center', fontSize: 'var(--fs-13)' }}>или войдите через Telegram</div><TelegramLogin onError={setFormError} /></>}
  </div></Card>;
}
