import { useState } from 'react';
import { Wallet } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { type AdminOrder, type AdminUserDetail, adminKeys, useAdminPaymentOperation } from '../../../../api/admin';
import { useAdminUserSection } from '../../../../api/admin-controls';
import type { UserSectionData } from '../../../../api/admin-controls';
import { formatMskDateTime } from '../../../../lib/admin-audit';
import { formatDateMsk, rub } from '../../../../lib/admin-controls';
import { orderStatusLabel, productLabel } from '../../../../lib/admin-users';
import { Badge, Button, Card, useToast } from '../../../../ui';
import { DataState, EmptyBlock, ResponsiveTable } from '../../kit';
import type { ResponsiveColumn } from '../../kit';
import u from '../user.module.css';

type Ledger = UserSectionData['wallet']['ledger'][number];
type Charge = UserSectionData['charges']['items'][number];
type Referral = AdminUserDetail['referral']['referrals'][number];

const tap = { minHeight: 'var(--tap)' } as const;

function ledgerLabel(row: Ledger): string {
  switch (row.kind) {
    case 'topup':
      return 'Пополнение';
    case 'bonus':
      return 'Бонус';
    case 'spend':
      return 'Оплата';
    case 'refund':
      return 'Возврат';
    case 'referral':
      return 'Перевод реферальных';
    case 'admin':
      return row.amountKopecks < 0 ? 'Списание админом' : 'Начисление админом';
    default:
      return row.kind;
  }
}

function signed(kopecks: number): string {
  return kopecks > 0 ? `+${rub(kopecks)}` : rub(kopecks);
}

function WalletCard({ detail, onWallet }: { detail: AdminUserDetail; onWallet: () => void }) {
  const query = useAdminUserSection(detail.userId, 'wallet');
  const restrictedWithdrawals = detail.restriction && !detail.restriction.expired &&
    (detail.restriction.scopes.includes('all') || detail.restriction.scopes.includes('withdrawals'));
  const restrictedPurchases = detail.restriction && !detail.restriction.expired &&
    (detail.restriction.scopes.includes('all') || detail.restriction.scopes.includes('purchases'));
  const columns: ResponsiveColumn<Ledger>[] = [
    { key: 'at', header: 'Дата', primary: true, cell: row => formatMskDateTime(row.createdAt) },
    { key: 'kind', header: 'Операция', cell: ledgerLabel },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'end',
      cell: row => <span className={row.amountKopecks > 0 ? u.ok : undefined}>{signed(row.amountKopecks)}</span>,
    },
    { key: 'note', header: 'Комментарий', cell: row => (row.note ? `«${row.note}»` : row.orderId ? <span className={u.mono}>{row.orderId}</span> : '—') },
  ];
  const balance = query.data?.balanceKopecks ?? detail.wallet?.balanceKopecks ?? 0;
  const notes: string[] = [];
  if (restrictedPurchases) notes.push('тратить нельзя — покупки ограничены');
  else notes.push('можно тратить на продукты');
  if (restrictedWithdrawals) notes.push(`вывод ограничен${detail.restriction?.until ? ` до ${formatDateMsk(detail.restriction.until).slice(0, 5)}` : ''}`);

  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>
          Кошелёк <span className={u.tileValue}>{rub(balance)}</span>
        </h3>
        <Button size="sm" onClick={onWallet} style={tap}>
          <Wallet size={16} aria-hidden="true" />
          Пополнить / списать
        </Button>
      </div>
      <p className={u.muted} style={{ marginBottom: 'var(--sp-3)' }}>
        {notes.join(', ')}
      </p>
      <DataState
        query={query}
        isEmpty={data => data.ledger.length === 0}
        empty={<EmptyBlock title="Движений по кошельку нет" text="Пополнения, оплаты и начисления появятся здесь." />}
      >
        {data => <ResponsiveTable rows={data.ledger} columns={columns} rowKey={row => row.id} />}
      </DataState>
    </Card>
  );
}

function OrdersCard({ detail }: { detail: AdminUserDetail }) {
  const sync = useAdminPaymentOperation<{ id: string }>('sync');
  const queryClient = useQueryClient();
  const toast = useToast();
  const [syncing, setSyncing] = useState<string | null>(null);
  const orders = detail.orders ?? [];
  const paid = orders.filter(o => o.status === 'succeeded').length;
  const pending = orders.filter(o => o.status === 'pending' || o.status === 'waiting_for_capture').length;
  const refunded = orders.filter(o => o.status === 'refunded' || (o.gross_amount != null && Number(o.amount) < Number(o.gross_amount))).length;

  const check = (order: AdminOrder) => {
    setSyncing(order.id);
    sync.mutate(
      { id: order.id },
      {
        onSuccess: () => {
          toast('Статус проверен в ЮKassa', 'success');
          void queryClient.invalidateQueries({ queryKey: adminKeys.user(detail.userId) });
        },
        onError: error => toast(error.message, 'error'),
        onSettled: () => setSyncing(null),
      },
    );
  };

  const columns: ResponsiveColumn<AdminOrder>[] = [
    { key: 'at', header: 'Дата', primary: true, cell: o => formatMskDateTime(o.created_at) },
    { key: 'product', header: 'Продукт', cell: o => productLabel(o.product_kind) },
    { key: 'amount', header: 'Сумма', align: 'end', cell: o => rub(Math.round(Number(o.amount) * 100)) },
    {
      key: 'status',
      header: 'Статус',
      cell: o => <Badge tone={o.status === 'succeeded' ? 'success' : o.status === 'canceled' ? 'error' : 'warning'}>{orderStatusLabel(o.status)}</Badge>,
    },
    {
      key: 'yk',
      header: 'ID ЮKassa',
      hideOnMobile: true,
      cell: o => (o.yookassa_payment_id ? <span className={u.mono}>{o.yookassa_payment_id}</span> : '—'),
    },
  ];

  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>
          Заказы{' '}
          <span className={u.cardSub}>
            {paid} оплачено · {pending} ожидает{refunded ? ` · ${refunded} возврат` : ''}
          </span>
        </h3>
      </div>
      <ResponsiveTable
        rows={orders}
        columns={columns}
        rowKey={o => o.id}
        empty={<p className={u.muted}>Покупок не было.</p>}
        rowActions={o =>
          o.yookassa_payment_id ? (
            <Button variant="ghost" size="sm" style={tap} loading={syncing === o.id} onClick={() => check(o)}>
              Проверить
            </Button>
          ) : null
        }
      />
    </Card>
  );
}

function ChargesCard({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const query = useAdminUserSection(userId, 'charges', open);
  const columns: ResponsiveColumn<Charge>[] = [
    { key: 'at', header: 'Когда', primary: true, cell: c => formatMskDateTime(c.createdAt) },
    { key: 'what', header: 'Что', cell: c => `${c.category === 'box' ? 'QR коробок' : 'Стикеры товаров'} · ${c.quantity} шт.` },
    { key: 'price', header: 'Сумма', align: 'end', cell: c => rub(c.priceKopecks) },
    { key: 'src', header: 'Откуда', cell: c => (c.paymentSource === 'package' ? 'пакет' : 'кошелёк') },
    { key: 'status', header: 'Статус', cell: c => c.status },
  ];
  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>Оплата генераций стикеров</h3>
        <Button variant="ghost" size="sm" style={tap} aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? 'Скрыть' : 'Показать'}
        </Button>
      </div>
      {open && (
        <DataState query={query} isEmpty={data => data.items.length === 0} empty={<EmptyBlock title="Оплат генераций не было" />}>
          {data => <ResponsiveTable rows={data.items} columns={columns} rowKey={c => c.id} />}
        </DataState>
      )}
    </Card>
  );
}

function ReferralsCard({ detail }: { detail: AdminUserDetail }) {
  const ref = detail.referral;
  const referrals = ref?.referrals ?? [];
  const columns: ResponsiveColumn<Referral>[] = [
    {
      key: 'who',
      header: 'Реферал',
      primary: true,
      cell: r => (
        <span className={u.listMain}>
          <span>{r.displayName || r.email || 'Без имени'}</span>
          {r.displayName && r.email && <small>{r.email}</small>}
          {r.phone && <small>{r.phone}</small>}
        </span>
      ),
    },
    { key: 'at', header: 'Приглашён', cell: r => formatDateMsk(r.attributedAt) },
    {
      key: 'orders',
      header: 'Покупки',
      cell: r =>
        r.orders.length ? (
          <span className={u.listMain}>
            {r.orders.map(order => (
              <small key={order.id}>
                {formatDateMsk(order.createdAt)} · {productLabel(order.productKind)} · {rub(order.amountKopecks)} · {orderStatusLabel(order.status)}
              </small>
            ))}
          </span>
        ) : (
          'нет'
        ),
    },
    { key: 'paid', header: 'Оплачено', align: 'end', cell: r => rub(r.paidKopecks) },
    { key: 'refund', header: 'Возвраты', align: 'end', hideOnMobile: true, cell: r => rub(r.refundedKopecks) },
    { key: 'reward', header: 'Начислено', align: 'end', cell: r => rub(r.rewardedKopecks) },
    { key: 'reversed', header: 'Списано', align: 'end', hideOnMobile: true, cell: r => rub(r.reversedKopecks) },
    { key: 'earned', header: 'Итого заработано', align: 'end', cell: r => rub(r.earnedKopecks) },
  ];
  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>Рефералы</h3>
      </div>
      <dl className={u.kv}>
        <div>
          <dt>Реферальный код</dt>
          <dd className={u.mono}>{ref?.code ?? '—'}</dd>
        </div>
        <div>
          <dt>Приглашено</dt>
          <dd>{ref?.invited ?? 0}</dd>
        </div>
        <div>
          <dt>Заработано</dt>
          <dd>{rub(ref?.earnedKopecks ?? 0)}</dd>
        </div>
        <div>
          <dt>Доступно</dt>
          <dd>{rub(ref?.availableKopecks ?? 0)}</dd>
        </div>
        <div>
          <dt>Выведено</dt>
          <dd>{rub(ref?.paidKopecks ?? 0)}</dd>
        </div>
      </dl>
      {referrals.length > 0 && <ResponsiveTable rows={referrals} columns={columns} rowKey={r => r.userId} />}
    </Card>
  );
}

/** Вкладка «Деньги»: кошелёк, заказы, оплата генераций, рефералы. */
export function MoneyTab({ detail, onWallet }: { detail: AdminUserDetail; onWallet: () => void }) {
  return (
    <div className={u.tabBody}>
      <WalletCard detail={detail} onWallet={onWallet} />
      <OrdersCard detail={detail} />
      <ChargesCard userId={detail.userId} />
      <ReferralsCard detail={detail} />
    </div>
  );
}
