import { RefreshCw, Trash2 } from 'lucide-react';
import {
  useAdminPaymentOperation, useAdminPayments, useAdminTierDelete,
} from '../../api/admin';
import { dateTime, money } from '../../api/cabinet';
import { orderStatusLabel, productLabel, shortDate } from '../../lib/admin-users';
import {
  Alert, Badge, Button, Card, Field, Input, Select, Skeleton, Stat, Switch, Table, useToast,
} from '../../ui';
import s from '../../layout/AdminShell.module.css';

export function AdminPaymentsPage() {
  const toast = useToast();
  const payments = useAdminPayments();
  const settings = useAdminPaymentOperation<{ enabled: boolean }>('settings');
  const sync = useAdminPaymentOperation<{ id: string }>('sync');
  const tier = useAdminPaymentOperation<{ kind: string; minQuantity: number; unitPrice: number }>('tier');
  const removeTier = useAdminTierDelete();

  if (payments.isPending) return <div className="page"><Skeleton height={280} /></div>;
  if (payments.isError) return <div className="page"><Alert tone="error">{payments.error.message}</Alert></div>;

  const data = payments.data;

  return (
    <div className="page stack-lg">
      <div className={s.tiles}>
        <Stat value={data.readiness.yookassa ? 'Подключена' : 'Нет реквизитов'} label="ЮKassa" />
        <Stat value={data.readiness.testMode ? 'Тестовый' : 'Боевой'} label="режим магазина" />
        <Stat value={data.orders.filter(order => order.status === 'succeeded').length} label="оплачено из последних 100" />
      </div>

      <Card>
        <Switch
          checked={data.enabled}
          description={data.readiness.yookassa ? undefined : 'Сначала добавьте реквизиты ЮKassa в переменные окружения'}
          onChange={event =>
            settings.mutate({ enabled: event.target.checked }, {
              onSuccess: () => toast('Настройка сохранена', 'success'),
              onError: (error: Error) => toast(error.message, 'error'),
            })
          }
        >
          Принимать оплату на сайте
        </Switch>
      </Card>

      <Card>
        {/* Ступени цен серверный API умел всегда, а интерфейса к ним не было —
            цены правились только правкой констант в коде. */}
        <h3>Ступени цены за штуку</h3>
        <form
          className={s.toolbar}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            tier.mutate({
              kind: String(form.get('kind') || 'range'),
              minQuantity: Number(form.get('minQuantity') || 1),
              unitPrice: Number(form.get('unitPrice') || 0),
            }, {
              onSuccess: () => toast('Ступень сохранена', 'success'),
              onError: (error: Error) => toast(error.message, 'error'),
            });
          }}
        >
          <Field label="Вид">
            <Select name="kind" defaultValue="range">
              <option value="range">Массово</option>
              <option value="custom">По номеру</option>
            </Select>
          </Field>
          <Field label="От количества"><Input name="minQuantity" type="number" min={1} max={100} defaultValue={1} /></Field>
          <Field label="Цена за штуку, ₽"><Input name="unitPrice" type="number" step="0.01" min={0.01} defaultValue={1} /></Field>
          <Button type="submit" variant="secondary" loading={tier.isPending}>Сохранить ступень</Button>
        </form>

        {data.tiers.length > 0 && (
          <Table>
            <thead><tr><th>Вид</th><th>От количества</th><th>Цена за штуку</th><th /></tr></thead>
            <tbody>
              {data.tiers.map(row => (
                <tr key={row.id}>
                  <td>{row.kind === 'range' ? 'Массово' : 'По номеру'}</td>
                  <td>{row.min_quantity}</td>
                  <td>{row.unit_price} ₽</td>
                  <td>
                    <Button variant="ghost" size="sm" onClick={() => removeTier.mutate(row.id)}>
                      <Trash2 size={16} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <section className="stack">
        <h3>Последние заказы</h3>
        <Table>
          <thead>
            <tr><th>Дата</th><th>Покупка</th><th>Сумма</th><th>Статус</th><th>Выдано</th><th /></tr>
          </thead>
          <tbody>
            {data.orders.map(order => (
              <tr key={order.id}>
                <td>{dateTime(order.created_at)}</td>
                <td>{productLabel(order.product_kind)}</td>
                <td>{money(Math.round(Number(order.amount) * 100))}</td>
                <td>
                  <Badge tone={order.status === 'succeeded' ? 'success' : order.status === 'canceled' ? 'error' : 'warning'}>
                    {orderStatusLabel(order.status)}
                  </Badge>
                </td>
                <td className="mono">
                  {order.access_code || order.program_license_key || order.cell_print_license_key || '—'}
                </td>
                <td>
                  {order.yookassa_payment_id && (
                    <Button
                      variant="ghost" size="sm" loading={sync.isPending}
                      onClick={() => sync.mutate({ id: order.id }, {
                        onSuccess: () => toast('Статус обновлён', 'success'),
                        onError: (error: Error) => toast(error.message, 'error'),
                      })}
                    >
                      <RefreshCw size={16} />Проверить
                    </Button>
                  )}
                  {order.paid_at && <div className={s.mutedNote}>оплачен {shortDate(order.paid_at)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </div>
  );
}
