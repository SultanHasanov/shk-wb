import { useState } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import { type AdminAccessCode, useAdminResource, useAdminResourceMutation } from '../../api/admin';
import { shortDate } from '../../lib/admin-users';
import { Alert, Badge, Button, Card, Field, Input, Progress, useToast } from '../../ui';
import { ConfirmDialog, DataState, EmptyBlock, NumberDialog, ResponsiveTable } from './kit';
import type { ResponsiveColumn } from './kit';
import { useRemoveWithReason } from './usePageActions';
import s from '../../layout/AdminShell.module.css';
import p from './admin-pages.module.css';

/** Коды доступа к генератору: шестизначные, генерирует сервер. */
export function AdminAccessCodesPage() {
  const toast = useToast();
  const codes = useAdminResource<AdminAccessCode>('stickerAccess');
  const mutation = useAdminResourceMutation<{ name: string; limit: number }>('stickerAccess');
  const remove = useRemoveWithReason('stickerAccess');
  const [limitFor, setLimitFor] = useState<AdminAccessCode | null>(null);
  const [deleteFor, setDeleteFor] = useState<AdminAccessCode | null>(null);

  const columns: ResponsiveColumn<AdminAccessCode>[] = [
    { key: 'code', header: 'Код', primary: true, cell: code => <span className={p.mono}>{code.code}</span> },
    { key: 'name', header: 'Имя', cell: code => code.name || '—' },
    {
      key: 'usage',
      header: 'Генерации',
      cell: code => (
        <div className={s.actionsCell}>
          <Progress value={code.used} max={Math.max(1, code.limit)} label={<span>{code.used} из {code.limit}</span>} />
        </div>
      ),
    },
    { key: 'created', header: 'Создан', cell: code => shortDate(code.createdAt) },
    {
      key: 'status',
      header: 'Статус',
      cell: code => <Badge tone={code.active ? 'success' : 'error'}>{code.active ? 'Активен' : 'Отключён'}</Badge>,
    },
  ];

  return (
    <div className="page stack-lg">
      <Card>
        <h3>Выдать код</h3>
        <form
          className={`${s.toolbar} ${p.formRow}`}
          onSubmit={event => {
            event.preventDefault();
            const formElement = event.currentTarget;
            const form = new FormData(formElement);
            mutation.create.mutate(
              { name: String(form.get('name') || ''), limit: Number(form.get('limit') || 0) },
              {
                onSuccess: result => {
                  toast(`Код ${(result as AdminAccessCode).code} создан`, 'success');
                  formElement.reset();
                },
                onError: (error: Error) => toast(error.message, 'error'),
              },
            );
          }}
        >
          <Field label="Имя"><Input name="name" required maxLength={120} /></Field>
          <Field label="Генераций"><Input name="limit" type="number" min={0} max={100000} defaultValue={100} required /></Field>
          <Button type="submit" className={p.tap} loading={mutation.create.isPending}>Сгенерировать код</Button>
        </form>
        {mutation.create.isError && <Alert tone="error">{mutation.create.error.message}</Alert>}
      </Card>

      <DataState
        query={codes}
        isEmpty={rows => rows.length === 0}
        empty={<EmptyBlock title="Кодов пока нет" text="Выдайте первый код доступа выше." />}
      >
        {rows => (
          <ResponsiveTable
            rows={rows}
            columns={columns}
            rowKey={code => code.id}
            rowActions={code => (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className={p.iconButton}
                  aria-label={`Скопировать код ${code.code}`}
                  onClick={() => {
                    void navigator.clipboard?.writeText(code.code);
                    toast('Код скопирован', 'success');
                  }}
                >
                  <Copy size={16} />
                </Button>
                <Button variant="ghost" size="sm" className={p.tap} onClick={() => setLimitFor(code)}>
                  Лимит
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={p.tap}
                  onClick={() =>
                    mutation.update.mutate({ id: code.id, active: !code.active } as never, {
                      onError: (error: Error) => toast(error.message, 'error'),
                    })
                  }
                >
                  {code.active ? 'Отключить' : 'Включить'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={p.iconButton}
                  aria-label={`Удалить код ${code.code}`}
                  onClick={() => setDeleteFor(code)}
                >
                  <Trash2 size={16} />
                </Button>
              </>
            )}
          />
        )}
      </DataState>

      <NumberDialog
        open={limitFor !== null}
        onOpenChange={open => !open && setLimitFor(null)}
        title={`Лимит кода ${limitFor?.code ?? ''}`}
        subtitle={limitFor ? `Сейчас: ${limitFor.limit}, израсходовано ${limitFor.used}` : undefined}
        label="Генераций всего"
        min={0}
        max={100000}
        initial={limitFor?.limit}
        preview={value =>
          limitFor && value < limitFor.used ? (
            <span>Меньше уже израсходованного ({limitFor.used}) — новые генерации по коду станут недоступны</span>
          ) : (
            <span>
              Останется: <b>{Math.max(0, value - (limitFor?.used ?? 0))}</b>
            </span>
          )
        }
        confirmLabel="Сохранить лимит"
        onConfirm={async limit => {
          if (!limitFor) return;
          await mutation.update.mutateAsync({ id: limitFor.id, limit } as never);
          toast('Лимит сохранён', 'success');
        }}
      />

      <ConfirmDialog
        open={deleteFor !== null}
        onOpenChange={open => !open && setDeleteFor(null)}
        title={`Удалить код ${deleteFor?.code ?? ''}?`}
        description="Код перестанет работать в генераторе. Это нельзя отменить — чтобы только приостановить, нажмите «Отключить»."
        confirmLabel="Удалить код"
        tone="danger"
        requireReason
        onConfirm={async ({ reason }) => {
          if (!deleteFor) return;
          await remove.mutateAsync({ id: deleteFor.id, reason });
          toast('Код удалён', 'success');
        }}
      />
    </div>
  );
}
