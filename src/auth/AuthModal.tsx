import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { type AuthMode, useStores } from '../stores/root-store';
import { type T, useLocalePath, useT } from '../i18n';
import { Alert, Button, Checkbox, Field, Input, Modal, useToast } from '../ui';
import { PasswordInput } from './PasswordInput';
import { SocialRow } from './SocialRow';

type Values = { email: string; password?: string; accept?: boolean };

const copyFor = (t: T): Record<AuthMode, { title: string; text: string; submit: string }> => ({
  login: {
    title: t('Вход в кабинет', 'Кабинетке кіру'),
    text: t('Управляйте ключами, заказами и настройками из одного места.', 'Кілттерді, тапсырыстарды және баптауларды бір жерден басқарыңыз.'),
    submit: t('Войти', 'Кіру'),
  },
  register: {
    title: t('Создать аккаунт', 'Аккаунт жасау'),
    text: t('История генераций, ключи и подписки будут храниться в кабинете.', 'Генерациялар тарихы, кілттер мен жазылымдар кабинетте сақталады.'),
    submit: t('Создать аккаунт', 'Аккаунт жасау'),
  },
  forgot: {
    title: t('Восстановление пароля', 'Құпиясөзді қалпына келтіру'),
    text: t('Пришлём ссылку для смены пароля на почту, указанную при регистрации.', 'Тіркелу кезінде көрсетілген поштаға құпиясөзді өзгерту сілтемесін жібереміз.'),
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

/** Сервер возвращает с провайдера OAuth на /?auth=login&oauth=error&reason=… (server/_oauth-login.js). */
export function oauthErrorText(t: T, reason: string) {
  switch (reason) {
    case 'denied': return t('Вход отменён на стороне сервиса. Попробуйте ещё раз или войдите по почте.', 'Кіру сервис жағында тоқтатылды. Қайта көріңіз немесе пошта арқылы кіріңіз.');
    case 'no_email': return t('Сервис не передал адрес почты. Разрешите доступ к почте или войдите по почте с паролем.', 'Сервис пошта мекенжайын бермеді. Поштаға рұқсат беріңіз немесе пошта мен құпиясөзбен кіріңіз.');
    case 'state': return t('Ссылка входа устарела. Нажмите кнопку входа ещё раз.', 'Кіру сілтемесі ескірген. Кіру түймесін қайта басыңыз.');
    case 'provider': return t('Этот способ входа сейчас недоступен. Войдите по почте или через Telegram.', 'Бұл кіру тәсілі қазір қолжетімсіз. Пошта немесе Telegram арқылы кіріңіз.');
    default: return t('Не удалось войти через внешний сервис. Попробуйте ещё раз.', 'Сыртқы сервис арқылы кіру мүмкін болмады. Қайта көріңіз.');
  }
}

const linkButton: React.CSSProperties = { border: 0, background: 'none', padding: 0, font: 'inherit', cursor: 'pointer' };

/**
 * Модалка входа / регистрации / восстановления пароля (вместо страниц /login, /register, /forgot-password).
 * Открывается через ui.openAuth(mode, { from }); после входа ведёт в from, а без него — в кабинет.
 * На телефоне Modal сам становится нижней шторкой. Прототип: https://claude.ai/artifact/B19JQk834z6LA9UfnqwniA
 */
export const AuthModal = observer(() => {
  const { ui } = useStores();
  const t = useT();
  const state = ui.authModal;
  // Экран «Проверьте почту» (после регистрации / запроса ссылки) меняет заголовок модалки.
  const [sent, setSent] = useState(false);
  const copy = copyFor(t)[state?.mode ?? 'login'];
  return (
    <Modal
      open={!!state}
      onOpenChange={open => { if (!open) ui.closeAuth(); }}
      title={sent ? t('Проверьте почту', 'Поштаңызды тексеріңіз') : copy.title}
      description={sent ? t('Письмо уже в пути.', 'Хат жолда.') : copy.text}
    >
      {state && <AuthForm key={state.mode} mode={state.mode} from={state.from} oauthError={state.oauthError} onSent={setSent} />}
    </Modal>
  );
});

const AuthForm = observer(({ mode, from, oauthError, onSent }: { mode: AuthMode; from?: string; oauthError?: string; onSent: (sent: boolean) => void }) => {
  const { auth, ui } = useStores();
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT();
  const lp = useLocalePath();
  const [formError, setFormError] = useState(() => (oauthError ? oauthErrorText(t, oauthError) : ''));
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [isResending, setIsResending] = useState(false);
  // По умолчанию отмечено: подавляющее большинство входит со своего рабочего
  // компьютера на пункте выдачи, и повторный вход каждый день — лишний барьер.
  const [remember, setRemember] = useState(true);
  const c = copyFor(t)[mode];
  const schema = useMemo(() => schemasFor(t)[mode], [t, mode]);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema) });

  // Из шапки from не передаётся → кабинет; из контекстных ссылок на лендинге → остаёмся где были.
  const target = from ?? '/cabinet';
  const finish = useCallback(() => {
    ui.closeAuth();
    navigate(target, { replace: true });
  }, [navigate, target, ui]);

  // Открыли модалку уже вошедшим (старая ссылка /login с живой сессией) — просто ведём дальше.
  useEffect(() => {
    if (auth.isAuthenticated) finish();
  }, [auth.isAuthenticated, finish]);

  const sent = Boolean((mode === 'forgot' && resetEmail) || (mode === 'register' && confirmationEmail));
  useEffect(() => { onSent(sent); return () => onSent(false); }, [onSent, sent]);

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
      finish();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t('Не удалось выполнить запрос', 'Сұранысты орындау мүмкін болмады'));
    }
  });

  const resendError = (error: unknown) =>
    setFormError(error instanceof Error ? error.message : t('Не удалось отправить письмо повторно', 'Хатты қайта жіберу мүмкін болмады'));
  const resendLabel = t('Отправить письмо повторно', 'Хатты қайта жіберу');
  const socialError = useCallback((message: string) => setFormError(message), []);

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
    return <div className="stack">
      <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
        {t('Если аккаунт с адресом', 'Егер')} <strong>{resetEmail}</strong>{' '}
        {t('существует, мы отправили ссылку для создания нового пароля.', 'мекенжайы бар аккаунт болса, жаңа құпиясөз жасау сілтемесін жібердік.')}
      </p>
      <Alert tone="success">
        {t('Проверьте папку «Входящие» и «Спам». Доставка письма может занять несколько минут.', '«Кіріс» және «Спам» қалталарын тексеріңіз. Хаттың жетуі бірнеше минутқа созылуы мүмкін.')}
      </Alert>
      {formError && <Alert tone="error">{formError}</Alert>}
      <Button type="button" size="lg" block loading={isResending} onClick={resend}>{resendLabel}</Button>
      <Button type="button" variant="secondary" block onClick={() => setResetEmail('')}>{t('Указать другую почту', 'Басқа поштаны көрсету')}</Button>
      <button type="button" className="accent" style={{ ...linkButton, textAlign: 'center' }} onClick={() => ui.setAuthMode('login')}>{t('Вернуться ко входу', 'Кіруге оралу')}</button>
    </div>;
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
    return <div className="stack">
      <Alert tone="success">
        {t('Мы отправили ссылку для подтверждения на', 'Растау сілтемесін мына мекенжайға жібердік:')} <strong>{confirmationEmail}</strong>
        {t('. Перейдите по ней, чтобы завершить регистрацию.', '. Тіркелуді аяқтау үшін сол сілтемеге өтіңіз.')}
      </Alert>
      <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-13)' }}>
        {t('Письма нет? Проверьте папку «Спам» или отправьте ещё раз через минуту.', 'Хат жоқ па? «Спам» қалтасын тексеріңіз немесе бір минуттан кейін қайта жіберіңіз.')}
      </p>
      {formError && <Alert tone="error">{formError}</Alert>}
      <Button type="button" size="lg" block loading={isResending} onClick={resend}>{resendLabel}</Button>
      <Button type="button" variant="secondary" block onClick={() => setConfirmationEmail('')}>{t('Исправить адрес почты', 'Пошта мекенжайын түзету')}</Button>
      <button type="button" className="accent" style={{ ...linkButton, textAlign: 'center' }} onClick={() => ui.setAuthMode('login')}>{t('Перейти ко входу', 'Кіруге өту')}</button>
    </div>;
  }

  return <div className="stack">
    {formError && <Alert tone="error">{formError}</Alert>}
    <form className="stack" onSubmit={onSubmit}>
      <Field label={t('Электронная почта', 'Электрондық пошта')} error={errors.email?.message}><Input type="email" autoComplete="email" {...register('email')} /></Field>
      {mode !== 'forgot' && <Field label={t('Пароль', 'Құпиясөз')} error={errors.password?.message} help={mode === 'register' ? t('Минимум 8 символов', 'Кемінде 8 таңба') : undefined}>
        <PasswordInput autoComplete={mode === 'register' ? 'new-password' : 'current-password'} {...register('password')} />
      </Field>}

      {/* Без галочки сессия живёт в sessionStorage и гаснет с вкладкой —
          на общем компьютере пункта выдачи это единственная защита. */}
      {mode === 'login' && (
        <Checkbox id="remember-device" checked={remember} onChange={e => setRemember(e.target.checked)}>
          {t('Запомнить это устройство', 'Осы құрылғыны есте сақтау')}
          <span style={{ display: 'block', fontSize: 'var(--fs-12)', color: 'var(--text-tertiary)' }}>
            {t('На чужом компьютере снимите галочку — вход забудется при закрытии браузера.', 'Бөтен компьютерде белгіні алып тастаңыз — браузерді жапқанда кіру ұмытылады.')}
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

    <div className="row" style={{ justifyContent: mode === 'login' ? 'space-between' : 'center', fontSize: 'var(--fs-13)' }}>
      {mode === 'login'
        ? <>
            <button type="button" className="accent" style={linkButton} onClick={() => ui.setAuthMode('register')}>{t('Создать аккаунт', 'Аккаунт жасау')}</button>
            <button type="button" className="accent" style={linkButton} onClick={() => ui.setAuthMode('forgot')}>{t('Забыли пароль?', 'Құпиясөзді ұмыттыңыз ба?')}</button>
          </>
        : <button type="button" className="accent" style={linkButton} onClick={() => ui.setAuthMode('login')}>{t('← Вернуться ко входу', '← Кіруге оралу')}</button>}
    </div>

    {mode !== 'forgot' && <SocialRow next={target} onError={socialError} onTelegramSuccess={finish} />}
  </div>;
});
