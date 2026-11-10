import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAdminPool, useAdminPoolRange } from '../../api/admin';
import { Button, Card, Field, Input, Pagination, Skeleton, Stat, useToast } from '../../ui';
import { ConfirmDialog, DataState, EmptyBlock, ResponsiveTable } from './kit';
import type { ResponsiveColumn } from './kit';
import s from '../../layout/AdminShell.module.css';
import p from './admin-pages.module.css';

type PoolKind = 'stickerPool' | 'boxPool';
type UsedRow = { code: string; batchId: string; allocatedAt: string };

const POOLS: ReadonlyArray<{ kind: PoolKind; label: string; to: string }> = [
  { kind: 'stickerPool', label: 'Стикеры', to: '/panel/sticker-pool' },
  { kind: 'boxPool', label: 'Коробки', to: '/panel/box-pool' },
];

const usedColumns: ResponsiveColumn<UsedRow>[] = [
  { key: 'code', header: 'Номер', primary: true, cell: row => <span className={p.mono}>{row.code}</span> },
  { key: 'at', header: 'Дата выдачи', cell: row => new Date(row.allocatedAt).toLocaleString('ru-RU') },
  { key: 'batch', header: 'Партия', cell: row => <span className={p.mono}>{row.batchId?.slice(0, 8) || '—'}</span> },
];

/**
 * Пулы номеров стикеров и коробок устроены одинаково — в старой админке это были
 * два почти дословно совпадающих скрипта. Заголовок раздела рисует оболочка
 * админки, поэтому здесь только переключатель между двумя пулами.
 */
export function AdminPoolPage({ kind, title }: { kind: PoolKind; title?: string }) {
  // Оба маршрута рисуют этот компонент в одном месте, и без ключа React оставил бы
  // прежний экземпляр: номер страницы и «прошлые данные» запроса (placeholderData)
  // перешли бы в другой пул, а форма диапазона заполнилась бы чужими номерами.
  return <PoolView key={kind} kind={kind} title={title} />;
}

function PoolView({ kind, title }: { kind: PoolKind; title?: string }) {
  const [page, setPage] = useState(0);
  const toast = useToast();
  const pool = useAdminPool(kind, page);
  const range = useAdminPoolRange(kind);
  const [draft, setDraft] = useState<{ start: string; end: string } | null>(null);
  const pages = Math.max(1, Math.ceil((pool.data?.used ?? 0) / (pool.data?.pageSize || 100)));
  const current = pool.data?.start && pool.data?.end ? `${pool.data.start} — ${pool.data.end}` : '—';

  return (
    <div className="page stack-lg">
      <nav className={p.switcher} aria-label={title ? `${title}: выбор пула` : 'Выбор пула номеров'}>
        {POOLS.map(item => (
          <Link
            key={item.kind}
            to={item.to}
            className={p.switcherLink}
            aria-current={item.kind === kind ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {pool.isPending ? (
        <Skeleton height={96} />
      ) : pool.data ? (
        <div className={s.tiles}>
          <Stat value={current} label="доступный диапазон" />
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
          // key — чтобы поля подхватили текущий диапазон, когда он загрузится или сменится пул
          key={`${kind}-${pool.data?.start ?? ''}-${pool.data?.end ?? ''}`}
          className={`${s.toolbar} ${p.formRow}`}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setDraft({ start: String(form.get('start') || '').trim(), end: String(form.get('end') || '').trim() });
          }}
        >
          <Field label="Первый номер"><Input name="start" inputMode="numeric" defaultValue={pool.data?.start ?? ''} required /></Field>
          <Field label="Последний номер"><Input name="end" inputMode="numeric" defaultValue={pool.data?.end ?? ''} required /></Field>
          <Button type="submit" className={p.tap} loading={range.isPending} disabled={pool.isPlaceholderData}>
            Применить диапазон
          </Button>
        </form>
      </Card>

      <section className="stack">
        <h3>Последние использованные</h3>
        <DataState
          query={pool}
          isEmpty={data => data.recentUsed.length === 0}
          empty={<EmptyBlock title="Выданных номеров пока нет" text="Здесь появятся номера, ушедшие в партии." />}
        >
          {data => (
            <>
              <ResponsiveTable rows={data.recentUsed} columns={usedColumns} rowKey={row => row.code} />
              <Pagination page={page + 1} pages={pages} onChange={next => setPage(next - 1)} />
            </>
          )}
        </DataState>
      </section>

      <ConfirmDialog
        open={draft !== null}
        onOpenChange={open => !open && setDraft(null)}
        title="Применить новый диапазон?"
        confirmLabel="Применить диапазон"
        tone="danger"
        requireReason
        onConfirm={async ({ reason }) => {
          if (!draft) return;
          // reason — для журнала: сервер читает её из тела запроса.
          const body = { start: draft.start, end: draft.end, reason };
          const result = await range.mutateAsync(body);
          toast(`Добавлено номеров: ${result.inserted}`, 'success');
        }}
      >
        <dl className={p.dialogFacts}>
          <dt>Сейчас</dt>
          <dd>{current}</dd>
          <dt>Станет</dt>
          <dd>{draft ? `${draft.start} — ${draft.end}` : '—'}</dd>
        </dl>
        <p className={s.mutedNote}>Свободные номера вне нового диапазона удалятся. Выданные останутся.</p>
      </ConfirmDialog>
    </div>
  );
}
