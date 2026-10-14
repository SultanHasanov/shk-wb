import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { TelegramLogin } from '../auth/TelegramLogin';
import { useStores } from '../stores/root-store';
import { useDocumentMeta } from '../lib/seo';
import { type T, useLocalePath, useT } from '../i18n';
import { Alert, Button, Card, Checkbox, Field, Input, useToast } from '../ui';

type Mode = 'login' | 'register' | 'forgot';
type Values = { email: string; password?: string; accept?: boolean };

const copyFor = (t: T): Record<Mode, { title: string; text: string; submit: string }> => ({
  login: {
    title: t('Вход в кабинет', 'Кабинетке кіру'),
    text: t('Управляйте ключами, заказами и настройками из одного места.', 'Кілттерді, тапсырыстарды және баптауларды бір жерден басқарыңыз.'),
    submit: t('Войти', 'Кіру'),
  },
  register: {
    title: t('Регистрация', 'Тіркелу'),
    text: t('Создайте аккаунт, чтобы хранить ключи и историю генераций.', 'Кілттер мен генерациялар тарихын сақтау үшін аккаунт жасаңыз.'),
    submit: t('Создать аккаунт', 'Аккаунт жасау'),
  },
  forgot: {
    title: t('Восстановление доступа', 'Қолжетімділікті қалпына келтіру'),
    text: t('Укажите почту — пришлём ссылку для смены пароля.', 'Поштаңызды көрсетіңіз — құпиясөзді өзгерту сілтемесін жібереміз.'),
    submit: t('Отправить ссылку', 'Сілтеме жіберу'),
  },
});

function schemasFor(t: T) {
  const email = z.string().email(t('Введите корректную почту', 'Дұрыс поштаны енгізіңіз'));
  const password = z.string().min(8, t('Минимум 8 символов', 'Кемінде 8 таңба'));
  /* Согласие с офертой и политикой — обязательное поле формы, а не мелкий текст
     под кнопкой: у аккаунта появляются платежи и персональные данные. */
  const accept = z
    .boolean()
    .refine(value => value, t('Подтвердите согласие с офертой и политикой конфиденциальности', 'Оферта мен құпиялылық саясатына келісіміңізді растаңыз'));
  return {
    login: z.object({ email, password }),
    register: z.object({ email, password, accept }),
    forgot: z.object({ email }),
  };
}

export function AuthPage({ mode = 'login' }: { mode?: Mode }) {
  const { auth } = useStores();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const t = useT();
  const lp = useLocalePath();
  const [formError, setFormError] = useState('');
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [isResending, setIsResending] = useState(false);
  // По умолчанию отмечено: подавляющее большинство входит со своего рабочего
  // компьютера на пункте выдачи, и повторный вход каждый день — лишний барьер.
  const [remember, setRemember] = useState(true);
  const c = copyFor(t)[mode];
  const schema = useMemo(() => schemasFor(t)[mode], [t, mode]);

  useDocumentMeta(c.title, c.text);
  const from = (location.state as { from?: string } | null)?.from ?? '/cabinet';
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema) });

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
      setFormError(error instanceof Error ? error.message : t('Не удалось выполнить запрос', 'Сұранысты орындау мүмкін болмады'));
    }
  });

  const resendError = (error: unknown) =>
    setFormError(error instanceof Error ? error.message : t('Не удалось отправить письмо повторно', 'Хатты қайта жіберу мүмкін болмады'));
  const checkMail = t('Проверьте почту', 'Поштаңызды тексеріңіз');
  const resendLabel = t('Отправить письмо повторно', 'Хатты қайта жіберу');

  if (mode === 'forgot' && resetEmail) {
    const resend = async () => {
      setFormError('');
      setIsResending(true);
      try {
        await auth.requestPasswordReset(resetEmail);
        toast(t('Письмо отправлено повторно', 'Хат қайта жіберілді'), 'success');
      } catch (error) {
        resendError(error);
      } finally {
        setIsResending(false);
      }
    };

    return <Card><div className="stack">
      <div>
        <h1 style={{ fontSize: 'var(--fs-24)', marginBottom: 'var(--sp-2)' }}>{checkMail}</h1>
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
          {t('Если аккаунт с адресом', 'Егер')} <strong>{resetEmail}</strong>{' '}
          {t(
            'существует, мы отправили ссылку для создания нового пароля.',
            'мекенжайы бар аккаунт болса, жаңа құпиясөз жасау сілтемесін жібердік.',
          )}
        </p>
      </div>
      <Alert tone="success">
        {t(
          'Проверьте папку «Входящие» и «Спам». Доставка письма может занять несколько минут.',
          '«Кіріс» және «Спам» қалталарын тексеріңіз. Хаттың жетуі бірнеше минутқа созылуы мүмкін.',
        )}
      </Alert>
      {formError && <Alert tone="error">{formError}</Alert>}
      <Button type="button" size="lg" block loading={isResending} onClick={resend}>{resendLabel}</Button>
      <Button type="button" variant="secondary" block onClick={() => setResetEmail('')}>{t('Указать другую почту', 'Басқа поштаны көрсету')}</Button>
      <Link className="accent" to="/login" style={{ textAlign: 'center' }}>{t('Вернуться ко входу', 'Кіруге оралу')}</Link>
    </div></Card>;
  }

  if (mode === 'register' && confirmationEmail) {
    const resend = async () => {
      setFormError('');
      setIsResending(true);
      try {
        await auth.resendSignUpConfirmation(confirmationEmail);
        toast(t('Письмо отправлено повторно', 'Хат қайта жіберілді'), 'success');
      } catch (error) {
        resendError(error);
      } finally {
        setIsResending(false);
      }
    };

    return <Card><div className="stack">
      <div>
        <h1 style={{ fontSize: 'var(--fs-24)', marginBottom: 'var(--sp-2)' }}>{checkMail}</h1>
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
          {t('Мы отправили ссылку для подтверждения на', 'Растау сілтемесін мына мекенжайға жібердік:')} <strong>{confirmationEmail}</strong>
          {t('. Перейдите по ней, чтобы завершить регистрацию.', '. Тіркелуді аяқтау үшін сол сілтемеге өтіңіз.')}
        </p>
      </div>
      {formError && <Alert tone="error">{formError}</Alert>}
      <Button type="button" size="lg" block loading={isResending} onClick={resend}>{resendLabel}</Button>
      <Button type="button" variant="secondary" block onClick={() => setConfirmationEmail('')}>{t('Исправить адрес почты', 'Пошта мекенжайын түзету')}</Button>
      <Link className="accent" to="/login" style={{ textAlign: 'center' }}>{t('Перейти ко входу', 'Кіруге өту')}</Link>
    </div></Card>;
  }

  return <Card><div className="stack">
    <div><h1 style={{ fontSize: 'var(--fs-24)', marginBottom: 'var(--sp-2)' }}>{c.title}</h1><p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>{c.text}</p></div>
    {formError && <Alert tone="error">{formError}</Alert>}
    <form className="stack" onSubmit={onSubmit}>
      <Field label={t('Электронная почта', 'Электрондық пошта')} error={errors.email?.message}><Input type="email" autoComplete="email" {...register('email')} /></Field>
      {mode !== 'forgot' && <Field label={t('Пароль', 'Құпиясөз')} error={errors.password?.message} help={mode === 'register' ? t('Минимум 8 символов', 'Кемінде 8 таңба') : undefined}>
        <Input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} {...register('password')} />
      </Field>}

      {/* Без галочки сессия живёт в sessionStorage и гаснет с вкладкой —
          на общем компьютере пункта выдачи это единственная защита. */}
      {mode === 'login' && (
        <Checkbox id="remember-device" checked={remember} onChange={e => setRemember(e.target.checked)}>
          {t('Запомнить это устройство', 'Осы құрылғыны есте сақтау')}
          <span style={{ display: 'block', fontSize: 'var(--fs-12)', color: 'var(--text-tertiary)' }}>
            {t(
              'На чужом компьютере снимите галочку — вход забудется при закрытии браузера.',
              'Бөтен компьютерде белгіні алып тастаңыз — браузерді жапқанда кіру ұмытылады.',
            )}
          </span>
        </Checkbox>
      )}

      {mode === 'register' && (
        <div>
          <Checkbox id="accept-terms" {...register('accept')}>
            {t('Я принимаю', 'Мен')} <Link to={lp('/offer')} target="_blank">{t('условия оферты', 'оферта шарттарын')}</Link> {t('и', 'және')}{' '}
            <Link to={lp('/privacy')} target="_blank">{t('политику конфиденциальности', 'құпиялылық саясатын')}</Link>
            {t('', ' қабылдаймын')}
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
      {mode === 'login'
        ? <><Link className="accent" to="/register">{t('Создать аккаунт', 'Аккаунт жасау')}</Link><Link className="accent" to="/forgot-password">{t('Забыли пароль?', 'Құпиясөзді ұмыттыңыз ба?')}</Link></>
        : <Link className="accent" to="/login">{t('← Вернуться ко входу', '← Кіруге оралу')}</Link>}
    </div>
    {mode !== 'forgot' && <><div className="muted" style={{ textAlign: 'center', fontSize: 'var(--fs-13)' }}>{t('или войдите через Telegram', 'немесе Telegram арқылы кіріңіз')}</div><TelegramLogin onError={setFormError} /></>}
  </div></Card>;
}
