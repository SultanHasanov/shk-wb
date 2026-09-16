import { useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { useAdminResource, useAdminResourceMutation } from '../../api/admin';
import { shortDate } from '../../lib/admin-users';
import { BOT_URL } from '../../lib/telegram';
import { Badge, Button, Card, Field, Input, Skeleton, Table, Textarea, useToast } from '../../ui';
import s from '../../layout/AdminShell.module.css';

/** Плашку про бота включают и снимают чаще остальных — заполняем форму за раз. */
const BOT_TEMPLATE = {
  text: 'Генерировать ШК теперь можно прямо в Telegram: товарные стикеры и QR коробок, до 500 штук за раз, готовый PDF в чат.',
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
          <div className={s.toolbar}>
            <Field label="Ссылка"><Input name="url" /></Field>
            <Field label="Подпись кнопки"><Input name="button" defaultValue="Подробнее" /></Field>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                const fields = form.current?.elements as never as Record<string, HTMLInputElement | undefined>;
                if (fields.text) fields.text.value = BOT_TEMPLATE.text;
                if (fields.url) fields.url.value = BOT_TEMPLATE.url;
                if (fields.button) fields.button.value = BOT_TEMPLATE.button;
              }}
            >
              Шаблон: бот
            </Button>
            <Button type="submit" loading={mutation.create.isPending}>Опубликовать</Button>
          </div>
        </form>
      </Card>

      {items.isPending ? (
        <Skeleton height={160} />
      ) : items.data?.length ? (
        <Table>
          <thead><tr><th>Текст</th><th>Создано</th><th>Статус</th><th /></tr></thead>
          <tbody>
            {items.data.map(item => (
              <tr key={item.id}>
                <td>{item.text}</td>
                <td>{shortDate(item.createdAt)}</td>
                <td><Badge tone={item.active ? 'success' : 'error'}>{item.active ? 'Показывается' : 'Скрыто'}</Badge></td>
                <td>
                  <div className={s.row}>
                    <Button variant="ghost" size="sm" onClick={() => mutation.update.mutate({ id: item.id, active: !item.active } as never)}>
                      {item.active ? 'Скрыть' : 'Показать'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { if (window.confirm('Удалить объявление?')) mutation.remove.mutate(item.id); }}>
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <Card>Объявлений пока нет.</Card>
      )}
    </div>
  );
}
