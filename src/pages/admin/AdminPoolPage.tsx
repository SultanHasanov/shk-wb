import { useState } from 'react';
import { useAdminPool, useAdminPoolRange } from '../../api/admin';
import { Alert, Button, Card, Field, Input, Pagination, Skeleton, Stat, Table, useToast } from '../../ui';
import s from '../../layout/AdminShell.module.css';

/**
 * Пулы номеров стикеров и коробок устроены одинаково — в старой админке это были
 * два почти дословно совпадающих скрипта (sticker-pool-admin.js и box-pool-admin.js).
 */
export function AdminPoolPage({ kind, title }: { kind: 'stickerPool' | 'boxPool'; title: string }) {
  const [page, setPage] = useState(0);
  const toast = useToast();
  const pool = useAdminPool(kind, page);
  const range = useAdminPoolRange(kind);
  const pages = Math.max(1, Math.ceil((pool.data?.used ?? 0) / (pool.data?.pageSize || 100)));

  return (
    <div className="page stack-lg">
      <h2>{title}</h2>

      {pool.isPending ? (
        <Skeleton height={96} />
      ) : pool.data ? (
        <div className={s.tiles}>
          <Stat value={pool.data.start && pool.data.end ? `${pool.data.start} — ${pool.data.end}` : '—'} label="доступный диапазон" />
          <Stat value={pool.data.available} label="свободно номеров" />
          <Stat value={pool.data.used} label="использовано" />
        </div>
      ) : null}

      <Card>
        <h3>Задать диапазон</h3>
        <p className={s.mutedNote}>
          Свободные номера вне нового диапазона будут удалены, уже выданные сохранятся.
          За один раз не больше 100 001 номера.
        </p>
        <form
          className={s.toolbar}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const start = String(form.get('start') || '');
            const end = String(form.get('end') || '');
            if (!window.confirm(`Применить диапазон ${start} — ${end}?`)) return;
            range.mutate({ start, end }, {
              onSuccess: result => toast(`Добавлено номеров: ${result.inserted}`, 'success'),
              onError: (error: Error) => toast(error.message, 'error'),
            });
          }}
        >
          <Field label="Первый номер"><Input name="start" inputMode="numeric" defaultValue={pool.data?.start ?? ''} required /></Field>
          <Field label="Последний номер"><Input name="end" inputMode="numeric" defaultValue={pool.data?.end ?? ''} required /></Field>
          <Button type="submit" loading={range.isPending}>Применить диапазон</Button>
        </form>
        {range.isError && <Alert tone="error">{range.error.message}</Alert>}
      </Card>

      <section className="stack">
        <h3>Последние использованные</h3>
        {pool.data?.recentUsed.length ? (
          <>
            <Table>
              <thead><tr><th>Номер</th><th>Дата выдачи</th><th>Партия</th></tr></thead>
              <tbody>
                {pool.data.recentUsed.map(row => (
                  <tr key={row.code}>
                    <td className="mono">{row.code}</td>
                    <td>{new Date(row.allocatedAt).toLocaleString('ru-RU')}</td>
                    <td className="mono">{row.batchId?.slice(0, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page + 1} pages={pages} onChange={next => setPage(next - 1)} />
          </>
        ) : (
          <Card>Выданных номеров пока нет.</Card>
        )}
      </section>
    </div>
  );
}
