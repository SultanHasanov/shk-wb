import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { useStores } from '../stores/root-store';
import { useDocumentMeta } from '../lib/seo';
import { Alert, Button, Card, Field, Input, useToast } from '../ui';

const schema = z.object({
  password: z.string().min(8, 'Минимум 8 символов'),
  confirmPassword: z.string(),
}).refine(value => value.password === value.confirmPassword, {
  message: 'Пароли не совпадают', path: ['confirmPassword'],
});

type Values = z.infer<typeof schema>;

export function ResetPasswordPage() {
  useDocumentMeta('Смена пароля', 'Задайте новый пароль для входа в кабинет.');

  const { auth } = useStores();
  const navigate = useNavigate();
  const toast = useToast();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema) });

  const submit = handleSubmit(async values => {
    try {
      await auth.updatePassword(values.password);
      toast('Пароль успешно изменён', 'success');
      navigate('/cabinet', { replace: true });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Не удалось изменить пароль', 'error');
    }
  });

  return <Card><div className="stack">
    <div><h1 style={{ fontSize: 'var(--fs-24)' }}>Новый пароль</h1><p className="muted">Придумайте новый пароль для аккаунта.</p></div>
    {(!auth.recoveryMode || auth.status !== 'authenticated') && <Alert tone="error">Ссылка недействительна или устарела. Запросите новую ссылку восстановления.</Alert>}
    <form className="stack" onSubmit={submit}>
      <Field label="Новый пароль" error={errors.password?.message}><Input type="password" autoComplete="new-password" {...register('password')} /></Field>
      <Field label="Повторите пароль" error={errors.confirmPassword?.message}><Input type="password" autoComplete="new-password" {...register('confirmPassword')} /></Field>
      <Button size="lg" block loading={isSubmitting} disabled={auth.status !== 'authenticated' || !auth.recoveryMode}>Сохранить пароль</Button>
    </form>
  </div></Card>;
}
