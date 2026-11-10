import { useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import {
  type AdminOrder, type AdminPayments, useAdminPaymentOperation, useAdminPayments, useAdminTierDelete,
} from '../../api/admin';
import { dateTime, money } from '../../api/cabinet';
import { orderStatusLabel, productLabel, shortDate } from '../../lib/admin-users';
import {
  Badge, Button, Card, Field, Input, Select, Skeleton, Stat, Switch, useToast,
} from '../../ui';
import { ConfirmDialog, DataState, EmptyBlock, ResponsiveTable } from './kit';
import type { ResponsiveColumn } from './kit';
import s from '../../layout/AdminShell.module.css';
import p from './admin-pages.module.css';

type Tier = AdminPayments['tiers'][number];

const tierKindLabel = (kind: string) => (kind === 'range' ? 'Массово' : 'По номеру');

export function AdminPaymentsPage() {
  const toast = useToast();
  const payments = useAdminPayments();
  const settings = useAdminPaymentOperation<{ enabled: boolean; reason?: string }>('settings');
  const sync = useAdminPaymentOperation<{ id: string }>('sync');
  const tier = useAdminPaymentOperation<{ kind: string; minQuantity: number; unitPrice: number }>('tier');
  const removeTier = useAdminTierDelete();
  const [toggleTo, setToggleTo] = useState<boolean | null>(null);
  const [deleteTier, setDeleteTier] = useState<Tier | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const tierColumns: ResponsiveColumn<Tier>[] = [
    { key: 'kind', header: 'Вид', primary: true, cell: row => tierKindLabel(row.kind) },
    { key: 'min', header: 'От количества', cell: row => row.min_quantity },
    { key: 'price', header: 'Цена за штуку', align: 'end', cell: row => <span className={p.num}>{row.unit_price} ₽</span> },
  ];

  const orderColumns: ResponsiveColumn<AdminOrder>[] = [
    { key: 'product', header: 'Покупка', primary: true, cell: order => productLabel(order.product_kind) },
    { key: 'date', header: 'Дата', cell: order => dateTime(order.created_at) },
    { key: 'amount', header: 'Сумма', align: 'end', cell: order => <span className={p.num}>{money(Math.round(Number(order.amount) * 100))}</span> },
    {
      key: 'status',
      header: 'Статус',
      cell: order => (
        <span>
          <Badge tone={order.status === 'succeeded' ? 'success' : order.status === 'canceled' ? 'error' : 'warning'}>
            {orderStatusLabel(order.status)}
          </Badge>
          {order.paid_at && <div className={s.mutedNote}>оплачен {shortDate(order.paid_at)}</div>}
        </span>
      ),
    },
    {
      key: 'issued',
      header: 'Выдано',
      cell: order => (
        <span className={p.mono}>{order.access_code || order.program_license_key || order.cell_print_license_key || '—'}</span>
      ),
    },
  ];

  return (
    <div className="page stack-lg">
      <DataState query={payments} skeleton={<Skeleton height={280} />} empty={null}>
        {data => (
          <>
            <div className={s.tiles}>
              <Stat value={data.readiness.yookassa ? 'Подключена' : 'Нет реквизитов'} label="ЮKassa" />
              <Stat value={data.readiness.testMode ? 'Тестовый' : 'Боевой'} label="режим магазина" />
              <Stat value={data.orders.filter(order => order.status === 'succeeded').length} label="оплачено из последних 100" />
            </div>

            <Card>
              <Switch
                checked={data.enabled}
                disabled={settings.isPending}
                description={data.readiness.yookassa ? undefined : 'Сначала добавьте реквизиты ЮKassa в переменные окружения'}
                onChange={event => setToggleTo(event.target.checked)}
              >
                Принимать оплату на сайте
              </Switch>
            </Card>

            <Card>
              {/* Ступени цен серверный API умел всегда, а интерфейса к ним не было —
                  цены правились только правкой констант в коде. */}
              <h3>Ступени цены за штуку</h3>
              <form
                className={`${s.toolbar} ${p.formRow}`}
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
                <Button type="submit" variant="secondary" className={p.tap} loading={tier.isPending}>Сохранить ступень</Button>
              </form>

              {data.tiers.length > 0 && (
                <div className="section">
                  <ResponsiveTable
                    rows={data.tiers}
                    columns={tierColumns}
                    rowKey={row => row.id}
                    rowActions={row => (
                      <Button
                        variant="ghost"
                        size="sm"
                        className={p.iconButton}
                        aria-label={`Удалить ступень от ${row.min_quantity} шт.`}
                        onClick={() => setDeleteTier(row)}
                      >
                        <Trash2 size={16} />
                      </Button>
                    )}
                  />
                </div>
              )}
            </Card>

            <section className="stack">
              <h3>Последние заказы</h3>
              <ResponsiveTable
                rows={data.orders}
                columns={orderColumns}
                rowKey={order => order.id}
                empty={<EmptyBlock title="Заказов пока нет" text="Здесь появятся последние 100 заказов." />}
                rowActions={order =>
                  order.yookassa_payment_id ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={p.tap}
                      loading={sync.isPending && syncing === order.id}
                      onClick={() => {
                        setSyncing(order.id);
                        sync.mutate({ id: order.id }, {
                          onSuccess: () => toast('Статус обновлён', 'success'),
                          onError: (error: Error) => toast(error.message, 'error'),
                        });
                      }}
                    >
                      <RefreshCw size={16} />Проверить
                    </Button>
                  ) : null
                }
              />
            </section>
          </>
        )}
      </DataState>

      <ConfirmDialog
        open={toggleTo !== null}
        onOpenChange={open => !open && setToggleTo(null)}
        title={toggleTo ? 'Включить оплату на сайте?' : 'Выключить оплату на сайте?'}
        description={
          toggleTo
            ? 'Покупки на сайте снова можно будет оплатить через ЮKassa.'
            : 'Новые заказы оплатить будет нельзя. Уже оплаченные и выданные покупки не затрагиваются.'
        }
        confirmLabel={toggleTo ? 'Включить оплату' : 'Выключить оплату'}
        tone="danger"
        requireReason
        onConfirm={async ({ reason }) => {
          if (toggleTo === null) return;
          await settings.mutateAsync({ enabled: toggleTo, reason });
          toast('Настройка сохранена', 'success');
        }}
      />

      <ConfirmDialog
        open={deleteTier !== null}
        onOpenChange={open => !open && setDeleteTier(null)}
        title="Удалить ступень цены?"
        description={
          deleteTier
            ? `${tierKindLabel(deleteTier.kind)}, от ${deleteTier.min_quantity} шт. — ${deleteTier.unit_price} ₽ за штуку. Цены пересчитаются по оставшимся ступеням.`
            : undefined
        }
        confirmLabel="Удалить ступень"
        tone="danger"
        onConfirm={async () => {
          if (!deleteTier) return;
          await removeTier.mutateAsync(deleteTier.id);
          toast('Ступень удалена', 'success');
        }}
      />
    </div>
  );
}
