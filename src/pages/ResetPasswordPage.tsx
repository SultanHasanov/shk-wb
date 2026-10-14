import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { useStores } from '../stores/root-store';
import { useDocumentMeta } from '../lib/seo';
import { type T, useT } from '../i18n';
import { Alert, Button, Card, Field, Input, useToast } from '../ui';

function makeSchema(t: T) {
  return z.object({
    password: z.string().min(8, t('Минимум 8 символов', 'Кемінде 8 таңба')),
    confirmPassword: z.string(),
  }).refine(value => value.password === value.confirmPassword, {
    message: t('Пароли не совпадают', 'Құпиясөздер сәйкес келмейді'), path: ['confirmPassword'],
  });
}

type Values = z.infer<ReturnType<typeof makeSchema>>;

export function ResetPasswordPage() {
  const t = useT();
  useDocumentMeta(t('Смена пароля', 'Құпиясөзді өзгерту'), t('Задайте новый пароль для входа в кабинет.', 'Кабинетке кіру үшін жаңа құпиясөз орнатыңыз.'));

  const { auth } = useStores();
  const navigate = useNavigate();
  const toast = useToast();
  const schema = useMemo(() => makeSchema(t), [t]);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema) });

  const submit = handleSubmit(async values => {
    try {
      await auth.updatePassword(values.password);
      toast(t('Пароль успешно изменён', 'Құпиясөз сәтті өзгертілді'), 'success');
      navigate('/cabinet', { replace: true });
    } catch (error) {
      toast(error instanceof Error ? error.message : t('Не удалось изменить пароль', 'Құпиясөзді өзгерту мүмкін болмады'), 'error');
    }
  });

  return <Card><div className="stack">
    <div><h1 style={{ fontSize: 'var(--fs-24)' }}>{t('Новый пароль', 'Жаңа құпиясөз')}</h1><p className="muted">{t('Придумайте новый пароль для аккаунта.', 'Аккаунт үшін жаңа құпиясөз ойлап табыңыз.')}</p></div>
    {(!auth.recoveryMode || auth.status !== 'authenticated') && <Alert tone="error">{t('Ссылка недействительна или устарела. Запросите новую ссылку восстановления.', 'Сілтеме жарамсыз немесе ескірген. Қалпына келтірудің жаңа сілтемесін сұраңыз.')}</Alert>}
    <form className="stack" onSubmit={submit}>
      <Field label={t('Новый пароль', 'Жаңа құпиясөз')} error={errors.password?.message}><Input type="password" autoComplete="new-password" {...register('password')} /></Field>
      <Field label={t('Повторите пароль', 'Құпиясөзді қайталаңыз')} error={errors.confirmPassword?.message}><Input type="password" autoComplete="new-password" {...register('confirmPassword')} /></Field>
      <Button size="lg" block loading={isSubmitting} disabled={auth.status !== 'authenticated' || !auth.recoveryMode}>{t('Сохранить пароль', 'Құпиясөзді сақтау')}</Button>
    </form>
  </div></Card>;
}
