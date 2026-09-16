import { Copy, Trash2 } from 'lucide-react';
import { type AdminAccessCode, useAdminResource, useAdminResourceMutation } from '../../api/admin';
import { shortDate } from '../../lib/admin-users';
import {
  Alert, Badge, Button, Card, EmptyState, Field, Input, Progress, Skeleton, Table, useToast,
} from '../../ui';
import s from '../../layout/AdminShell.module.css';

/** Коды доступа к генератору: шестизначные, генерирует сервер. */
export function AdminAccessCodesPage() {
  const toast = useToast();
  const codes = useAdminResource<AdminAccessCode>('stickerAccess');
  const mutation = useAdminResourceMutation<{ name: string; limit: number }>('stickerAccess');

  return (
    <div className="page stack-lg">
      <Card>
        <h3>Выдать код</h3>
        <form
          className={s.toolbar}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            mutation.create.mutate(
              { name: String(form.get('name') || ''), limit: Number(form.get('limit') || 0) },
              {
                onSuccess: result => toast(`Код ${(result as AdminAccessCode).code} создан`, 'success'),
                onError: (error: Error) => toast(error.message, 'error'),
              },
            );
            event.currentTarget.reset();
          }}
        >
          <Field label="Имя"><Input name="name" required maxLength={120} /></Field>
          <Field label="Генераций"><Input name="limit" type="number" min={0} max={100000} defaultValue={100} required /></Field>
          <Button type="submit" loading={mutation.create.isPending}>Сгенерировать код</Button>
        </form>
        {mutation.create.isError && <Alert tone="error">{mutation.create.error.message}</Alert>}
      </Card>

      {codes.isPending ? (
        <Skeleton height={200} />
      ) : codes.data?.length ? (
        <Table>
          <thead>
            <tr><th>Код</th><th>Имя</th><th>Генерации</th><th>Создан</th><th>Статус</th><th /></tr>
          </thead>
          <tbody>
            {codes.data.map(code => (
              <tr key={code.id}>
                <td className="mono">{code.code}</td>
                <td>{code.name || '—'}</td>
                <td className={s.actionsCell}>
                  <Progress value={code.used} max={Math.max(1, code.limit)} label={<span>{code.used} из {code.limit}</span>} />
                </td>
                <td>{shortDate(code.createdAt)}</td>
                <td><Badge tone={code.active ? 'success' : 'error'}>{code.active ? 'Активен' : 'Отключён'}</Badge></td>
                <td>
                  <div className={s.row}>
                    <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard?.writeText(code.code); toast('Код скопирован', 'success'); }}>
                      <Copy size={16} />
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => {
                        const limit = Number(window.prompt('Новый лимит генераций', String(code.limit)));
                        if (Number.isInteger(limit)) {
                          mutation.update.mutate({ id: code.id, limit } as never, {
                            onError: (error: Error) => toast(error.message, 'error'),
                          });
                        }
                      }}
                    >
                      Лимит
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => mutation.update.mutate({ id: code.id, active: !code.active } as never)}>
                      {code.active ? 'Отключить' : 'Включить'}
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => { if (window.confirm(`Удалить код ${code.code}?`)) mutation.remove.mutate(code.id); }}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <Card><EmptyState title="Кодов пока нет" text="Выдайте первый код доступа выше." /></Card>
      )}
    </div>
  );
}
