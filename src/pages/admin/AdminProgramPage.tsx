import { Trash2 } from 'lucide-react';
import { type AdminProgramKey, useAdminResource, useAdminResourceMutation } from '../../api/admin';
import { shortDate } from '../../lib/admin-users';
import { Alert, Badge, Button, Card, Field, Input, Skeleton, Table, useToast } from '../../ui';
import s from '../../layout/AdminShell.module.css';

type Promo = { id: number; code: string; limit: number; used: number; active: boolean; note: string | null };

/** Ключ программы вводится вручную: так было и в старой админке, формат хранит бизнес. */
export function AdminProgramPage() {
  const toast = useToast();
  const keys = useAdminResource<AdminProgramKey>('key');
  const keyMutation = useAdminResourceMutation<{ key: string; limit: number; note: string; used: number; active: boolean; createdAt: string }>('key');
  const promos = useAdminResource<Promo>('programPromo');
  const promoMutation = useAdminResourceMutation<{ code: string; limit: number; note: string; active: boolean }>('programPromo');

  return (
    <div className="page stack-lg">
      <Card>
        <h3>Создать лицензионный ключ</h3>
        <form
          className={s.toolbar}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            keyMutation.create.mutate({
              key: String(form.get('key') || '').trim().toUpperCase(),
              limit: Number(form.get('limit') || 0),
              note: String(form.get('note') || ''),
              used: 0, active: true, createdAt: new Date().toISOString(),
            }, {
              onSuccess: () => toast('Ключ создан', 'success'),
              onError: (error: Error) => toast(error.message, 'error'),
            });
          }}
        >
          <Field label="Ключ"><Input name="key" defaultValue="WBPK-" required /></Field>
          <Field label="Лимит итераций"><Input name="limit" type="number" min={1} defaultValue={1000} required /></Field>
          <Field label="Пометка"><Input name="note" /></Field>
          <Button type="submit" loading={keyMutation.create.isPending}>Создать</Button>
        </form>
        {keyMutation.create.isError && <Alert tone="error">{keyMutation.create.error.message}</Alert>}
      </Card>

      <section className="stack">
        <h3>Ключи</h3>
        {keys.isPending ? <Skeleton height={160} /> : keys.data?.length ? (
          <Table>
            <thead><tr><th>Ключ</th><th>Использовано</th><th>Создан</th><th>Статус</th><th>Пометка</th><th /></tr></thead>
            <tbody>
              {keys.data.map(key => (
                <tr key={key.id}>
                  <td className="mono">{key.key}</td>
                  <td>{key.used} из {key.limit}</td>
                  <td>{shortDate(key.createdAt)}</td>
                  <td><Badge tone={key.active ? 'success' : 'error'}>{key.active ? 'Активен' : 'Отозван'}</Badge></td>
                  <td>{key.note || '—'}</td>
                  <td>
                    <div className={s.row}>
                      <Button variant="ghost" size="sm" onClick={() => keyMutation.update.mutate({ id: key.id, active: !key.active } as never)}>
                        {key.active ? 'Отозвать' : 'Вернуть'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { if (window.confirm(`Удалить ключ ${key.key}?`)) keyMutation.remove.mutate(key.id); }}>
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <Card>Ключей пока нет.</Card>}
      </section>

      <Card>
        <h3>Промокоды на скачивание программы</h3>
        <form
          className={s.toolbar}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            promoMutation.create.mutate({
              code: String(form.get('code') || '').trim().toUpperCase(),
              limit: Number(form.get('limit') || 1),
              note: String(form.get('note') || ''),
              active: true,
            }, {
              onSuccess: () => toast('Промокод создан', 'success'),
              onError: (error: Error) => toast(error.message, 'error'),
            });
          }}
        >
          <Field label="Код" help="3–32 латинские буквы, цифры, _ или -"><Input name="code" required /></Field>
          <Field label="Лимит"><Input name="limit" type="number" min={1} defaultValue={1} required /></Field>
          <Field label="Пометка"><Input name="note" /></Field>
          <Button type="submit" variant="secondary" loading={promoMutation.create.isPending}>Создать</Button>
        </form>

        {promos.data?.length ? (
          <Table>
            <thead><tr><th>Код</th><th>Использовано</th><th>Статус</th><th>Пометка</th><th /></tr></thead>
            <tbody>
              {promos.data.map(promo => (
                <tr key={promo.id}>
                  <td className="mono">{promo.code}</td>
                  <td>{promo.used} из {promo.limit}</td>
                  <td><Badge tone={promo.active ? 'success' : 'error'}>{promo.active ? 'Активен' : 'Отключён'}</Badge></td>
                  <td>{promo.note || '—'}</td>
                  <td>
                    <div className={s.row}>
                      <Button variant="ghost" size="sm" onClick={() => promoMutation.update.mutate({ id: promo.id, active: !promo.active } as never)}>
                        {promo.active ? 'Отключить' : 'Включить'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { if (window.confirm(`Удалить промокод ${promo.code}?`)) promoMutation.remove.mutate(promo.id); }}>
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
