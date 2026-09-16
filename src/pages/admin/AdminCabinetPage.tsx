import { Link } from 'react-router-dom';
import { useAdminNews, useAdminWithdrawals, useAdminWithdrawalUpdate } from '../../api/admin';
import { dateTime, money } from '../../api/cabinet';
import {
  Alert, Badge, Button, Card, EmptyState, Field, Input, Skeleton, Table, Textarea, useToast,
} from '../../ui';
import s from '../../layout/AdminShell.module.css';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'error' | 'default'> = {
  paid: 'success', approved: 'warning', pending: 'default', rejected: 'error', canceled: 'error',
};

/**
 * Реферальные выплаты и рассылка новости.
 * В старой админке этот блок лежал внутри формы логина и грузился до входа,
 * получая 401; здесь он на своей странице за проверкой сессии.
 */
export function AdminCabinetPage() {
  const toast = useToast();
  const withdrawals = useAdminWithdrawals();
  const update = useAdminWithdrawalUpdate();
  const news = useAdminNews();

  const act = (id: string, status: 'approved' | 'paid' | 'rejected') =>
    update.mutate({ id, status }, {
      onSuccess: () => toast('Статус заявки обновлён', 'success'),
      onError: (error: Error) => toast(error.message, 'error'),
    });

  return (
    <div className="page stack-lg">
      <section className="stack">
        <h3>Заявки на выплату</h3>
        {withdrawals.isPending ? (
          <Skeleton height={200} />
        ) : withdrawals.data?.length ? (
          <Table>
            <thead>
              <tr><th>Дата</th><th>Сумма</th><th>Куда</th><th>Пользователь</th><th>Статус</th><th /></tr>
            </thead>
            <tbody>
              {withdrawals.data.map(item => (
                <tr key={item.id}>
                  <td>{dateTime(item.created_at)}</td>
                  <td>{money(item.amount_kopecks)}</td>
                  <td>{item.bank_name}<div className={s.mutedNote}>{item.sbp_phone}</div></td>
                  <td>
                    {item.user_id ? (
                      <Link to={`/panel/users/${item.user_id}`} className="mono">{item.user_id.slice(0, 8)}</Link>
                    ) : '—'}
                  </td>
                  <td><Badge tone={STATUS_TONE[item.status] ?? 'default'}>{item.status}</Badge></td>
                  <td>
                    {item.status === 'pending' || item.status === 'approved' ? (
                      <div className={s.row}>
                        {item.status === 'pending' && (
                          <Button variant="ghost" size="sm" onClick={() => act(item.id, 'approved')}>Одобрить</Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => act(item.id, 'paid')}>Выплачено</Button>
                        <Button variant="ghost" size="sm" onClick={() => act(item.id, 'rejected')}>Отклонить</Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Card><EmptyState title="Заявок нет" text="Здесь появятся запросы на вывод реферального баланса." /></Card>
        )}
      </section>

      <Card>
        <h3>Новость пользователям кабинета</h3>
        <p className={s.mutedNote}>
          Уйдёт всем, кто не отключил новости о продукте: уведомлением в кабинете и письмом.
        </p>
        <form
          className="stack"
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            news.mutate({
              title: String(form.get('title') || ''),
              body: String(form.get('body') || ''),
              link: String(form.get('link') || ''),
            }, {
              onSuccess: result => toast(`Отправлено: ${result.sent}`, 'success'),
              onError: (error: Error) => toast(error.message, 'error'),
            });
          }}
        >
          <Field label="Заголовок"><Input name="title" maxLength={160} required /></Field>
          <Field label="Текст"><Textarea name="body" rows={4} maxLength={2000} required /></Field>
          <Field label="Ссылка"><Input name="link" /></Field>
          <Button type="submit" loading={news.isPending}>Отправить всем</Button>
        </form>
        {news.isError && <Alert tone="error">{news.error.message}</Alert>}
      </Card>
    </div>
  );
}
