import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useAdminResource, useAdminResourceMutation } from '../../api/admin';
import { shortDate } from '../../lib/admin-users';
import { BOT_URL } from '../../lib/telegram';
import { Badge, Button, Card, Field, Input, Textarea, useToast } from '../../ui';
import { ConfirmDialog, DataState, EmptyBlock, ResponsiveTable } from './kit';
import type { ResponsiveColumn } from './kit';
import { useRemoveWithReason } from './usePageActions';
import s from '../../layout/AdminShell.module.css';
import p from './admin-pages.module.css';

/** Плашку про бота включают и снимают чаще остальных — заполняем форму за раз. */
const BOT_TEMPLATE = {
  text: 'Генерировать ШК теперь можно прямо в Telegram: по номеру за 7,50 ₽ или пачкой 50 штук за 20 ₽, готовый PDF в чат.',
  url: BOT_URL,
  button: 'Открыть бота',
};

type Announcement = {
  id: number; text: string; url: string | null; button: string | null; active: boolean; createdAt: string;
};

/** Объявления: полоса над шапкой сайта и всплывающее сообщение в десктопной
 *  программе «Подбор кодов» — обе поверхности читают один и тот же список. */
export function AdminAnnouncementsPage() {
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const items = useAdminResource<Announcement>('message');
  const mutation = useAdminResourceMutation<{ text: string; url: string; button: string; active: boolean; createdAt: string }>('message');
  const remove = useRemoveWithReason('message');
  const [deleteFor, setDeleteFor] = useState<Announcement | null>(null);

  const columns: ResponsiveColumn<Announcement>[] = [
    { key: 'text', header: 'Текст', primary: true, cell: item => <span className={p.cellText}>{item.text}</span> },
    { key: 'created', header: 'Создано', cell: item => shortDate(item.createdAt) },
    {
      key: 'status',
      header: 'Статус',
      cell: item => <Badge tone={item.active ? 'success' : 'error'}>{item.active ? 'Показывается' : 'Скрыто'}</Badge>,
    },
  ];

  return (
    <div className="page stack-lg">
      <Card>
        <h3>Новое объявление</h3>
        <form
          className="stack"
          ref={form}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            mutation.create.mutate({
              text: String(form.get('text') || ''),
              url: String(form.get('url') || ''),
              button: String(form.get('button') || 'Подробнее'),
              active: true,
              createdAt: new Date().toISOString(),
            }, {
              onSuccess: () => toast('Опубликовано', 'success'),
              onError: (error: Error) => toast(error.message, 'error'),
            });
          }}
        >
          <Field label="Текст"><Textarea name="text" rows={3} required /></Field>
          <div className={`${s.toolbar} ${p.formRow}`}>
            <Field label="Ссылка"><Input name="url" /></Field>
            <Field label="Подпись кнопки"><Input name="button" defaultValue="Подробнее" /></Field>
            <Button
              type="button"
              variant="secondary"
              className={p.tap}
              onClick={() => {
                const fields = form.current?.elements as never as Record<string, HTMLInputElement | undefined>;
                if (fields.text) fields.text.value = BOT_TEMPLATE.text;
                if (fields.url) fields.url.value = BOT_TEMPLATE.url;
                if (fields.button) fields.button.value = BOT_TEMPLATE.button;
              }}
            >
              Шаблон: бот
            </Button>
            <Button type="submit" className={p.tap} loading={mutation.create.isPending}>Опубликовать</Button>
          </div>
        </form>
      </Card>

      <DataState
        query={items}
        isEmpty={rows => rows.length === 0}
        empty={<EmptyBlock title="Объявлений пока нет" text="Опубликуйте первое объявление выше." />}
      >
        {rows => (
          <ResponsiveTable
            rows={rows}
            columns={columns}
            rowKey={item => item.id}
            rowActions={item => (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className={p.tap}
                  onClick={() =>
                    mutation.update.mutate({ id: item.id, active: !item.active } as never, {
                      onError: (error: Error) => toast(error.message, 'error'),
                    })
                  }
                >
                  {item.active ? 'Скрыть' : 'Показать'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={p.iconButton}
                  aria-label="Удалить объявление"
                  onClick={() => setDeleteFor(item)}
                >
                  <Trash2 size={16} />
                </Button>
              </>
            )}
          />
        )}
      </DataState>

      <ConfirmDialog
        open={deleteFor !== null}
        onOpenChange={open => !open && setDeleteFor(null)}
        title="Удалить объявление?"
        description={deleteFor ? `«${deleteFor.text.slice(0, 140)}${deleteFor.text.length > 140 ? '…' : ''}» пропадёт с сайта и из программы. Чтобы только убрать на время, нажмите «Скрыть».` : undefined}
        confirmLabel="Удалить"
        tone="danger"
        requireReason
        onConfirm={async ({ reason }) => {
          if (!deleteFor) return;
          await remove.mutateAsync({ id: deleteFor.id, reason });
          toast('Объявление удалено', 'success');
        }}
      />
    </div>
  );
}
