import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CircleDollarSign, Coins, HandCoins, Wallet } from 'lucide-react';
import { type AdminPartnerDetail, useAdminPartner, useAdminPartnerAction } from '../../api/admin';
import { shortDate } from '../../lib/admin-users';
import {
  type PartnerResource, RESOURCE_LABELS, formatKzt, formatRub, poolLeft,
} from '../../lib/partner';
import {
  Alert, Badge, Button, Card, Field, Input, Progress, Skeleton, Stat, Tabs, useToast,
} from '../../ui';
import { ConfirmDialog, EmptyBlock, ResponsiveTable } from './kit';
import type { ResponsiveColumn } from './kit';
import s from '../../layout/AdminShell.module.css';
import p from './admin-pages.module.css';

const RESOURCES: PartnerResource[] = ['sticker', 'program', 'cell'];

export function AdminPartnerPage() {
  const { partnerId = '' } = useParams();
  const detail = useAdminPartner(partnerId);

  if (detail.isPending) return <div className="page"><Skeleton height={320} /></div>;
  if (detail.isError) return <div className="page"><Alert tone="error">{detail.error.message}</Alert></div>;
  const data = detail.data;

  return (
    <div className="page stack-lg">
      <Header data={data} />

      <section className="stack">
        <h2>Расчёты</h2>
        <div className={s.tiles}>
          <Stat value={formatRub(data.balance.dueRub)} label="партнёр должен вам" icon={<Wallet size={20} />} />
          <Stat value={formatRub(data.balance.issuedRub)} label="выпущено на сумму" icon={<Coins size={20} />} />
          <Stat value={formatRub(data.balance.paidRub)} label="оплачено партнёром" icon={<HandCoins size={20} />} />
          <Stat value={formatKzt(data.balance.revenueKzt)} label="выручка партнёра у клиентов" icon={<CircleDollarSign size={20} />} />
        </div>
        <PaymentForm partnerId={data.partner.id} />
      </section>

      <section className="stack">
        <h2>Пул</h2>
        <div className={s.tiles}>
          {RESOURCES.map(resource => <PoolCard key={resource} data={data} resource={resource} />)}
        </div>
      </section>

      <PricesCard data={data} />

      <Tabs
        label="Данные партнёра"
        items={[
          { value: 'items', label: `Выпущено (${data.items.length})`, content: <ItemsTable data={data} /> },
          { value: 'ledger', label: 'История пула', content: <LedgerTable data={data} /> },
          { value: 'payments', label: `Оплаты (${data.payments.length})`, content: <PaymentsTable data={data} /> },
        ]}
      />
    </div>
  );
}

function Header({ data }: { data: AdminPartnerDetail }) {
  const toast = useToast();
  const update = useAdminPartnerAction<{ partnerId: string; active?: boolean }>('update', 'PATCH');
  const [confirmOff, setConfirmOff] = useState(false);
  const { partner } = data;
  return (
    <Card>
      <div className={s.spread}>
        <div className="stack">
          <Link to="/panel/partners" className={s.mutedNote}>← Все партнёры</Link>
          <h2>{partner.name}</h2>
          <div className={s.row}>
            <Badge tone={partner.active ? 'success' : 'error'}>{partner.active ? 'Активен' : 'Отключён'}</Badge>
            <span className={s.mutedNote}>{partner.account || 'аккаунт не найден'} · с {shortDate(partner.createdAt)}</span>
            <span className={s.mutedNote}>Наценка партнёра: {partner.markupPercent}%</span>
          </div>
        </div>
        <Button
          variant={partner.active ? 'secondary' : 'primary'}
          className={p.tap}
          loading={update.isPending}
          onClick={() => {
            if (partner.active) {
              setConfirmOff(true);
              return;
            }
            update.mutate({ partnerId: partner.id, active: true }, {
              onError: (error: Error) => toast(error.message, 'error'),
            });
          }}
        >
          {partner.active ? 'Отключить' : 'Включить'}
        </Button>
      </div>
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title="Отключить партнёра?"
        description="Он не сможет выпускать коды. Уже выданные коды продолжат работать."
        confirmLabel="Отключить"
        tone="danger"
        onConfirm={async () => {
          await update.mutateAsync({ partnerId: partner.id, active: false });
          toast('Партнёр отключён', 'success');
        }}
      />
    </Card>
  );
}

function PoolCard({ data, resource }: { data: AdminPartnerDetail; resource: PartnerResource }) {
  const toast = useToast();
  const grant = useAdminPartnerAction<{ partnerId: string; resource: PartnerResource; amount: number; note: string }>('grant');
  const [amount, setAmount] = useState('');
  const pool = data.partner.pool[resource];
  const label = RESOURCE_LABELS[resource];

  const submit = (sign: 1 | -1) => {
    const value = Number(amount);
    if (!Number.isInteger(value) || value <= 0) return toast('Введите целое число больше 0', 'error');
    grant.mutate({ partnerId: data.partner.id, resource, amount: sign * value, note: '' }, {
      onSuccess: () => { setAmount(''); toast(sign > 0 ? 'Пул пополнен' : 'Пул списан', 'success'); },
      onError: (error: Error) => toast(error.message, 'error'),
    });
  };

  return (
    <Card>
      <h3>{label.title}</h3>
      <Progress value={pool.used} max={Math.max(1, pool.granted)} label={<span>израсходовано {pool.used} из {pool.granted}</span>} />
      <p className={s.mutedNote}>Остаток: <strong>{poolLeft(pool)}</strong> {label.unit}</p>
      <div className={s.toolbar}>
        <Field label="Количество">
          <Input value={amount} onChange={e => setAmount(e.target.value)} type="number" min={1} />
        </Field>
        <Button size="sm" className={p.tap} loading={grant.isPending} onClick={() => submit(1)}>Пополнить</Button>
        <Button size="sm" variant="ghost" className={p.tap} loading={grant.isPending} onClick={() => submit(-1)}>Списать</Button>
      </div>
    </Card>
  );
}

function PricesCard({ data }: { data: AdminPartnerDetail }) {
  const toast = useToast();
  const update = useAdminPartnerAction<Record<string, unknown>>('update', 'PATCH');
  const [prices, setPrices] = useState(() => mapPrices(data));
  useEffect(() => setPrices(mapPrices(data)), [data]);

  return (
    <Card>
      <h3>Оптовые цены партнёра</h3>
      <p className={s.mutedNote}>
        Цена за единицу в рублях — столько партнёр должен вам за каждую выпущенную единицу.
        Новые цены действуют для следующих выпусков; уже выпущенное не пересчитывается.
      </p>
      <form
        className={`${s.toolbar} ${p.formRow}`}
        onSubmit={event => {
          event.preventDefault();
          update.mutate({
            partnerId: data.partner.id,
            priceStickerRub: Number(prices.sticker.replace(',', '.')),
            priceProgramRub: Number(prices.program.replace(',', '.')),
            priceCellRub: Number(prices.cell.replace(',', '.')),
          }, {
            onSuccess: () => toast('Цены сохранены', 'success'),
            onError: (error: Error) => toast(error.message, 'error'),
          });
        }}
      >
        <Field label="₽ за генерацию"><Input inputMode="decimal" value={prices.sticker} onChange={e => setPrices({ ...prices, sticker: e.target.value })} /></Field>
        <Field label="₽ за итерацию программы"><Input inputMode="decimal" value={prices.program} onChange={e => setPrices({ ...prices, program: e.target.value })} /></Field>
        <Field label="₽ за день·ПК печати ячеек"><Input inputMode="decimal" value={prices.cell} onChange={e => setPrices({ ...prices, cell: e.target.value })} /></Field>
        <Button type="submit" className={p.tap} loading={update.isPending}>Сохранить цены</Button>
      </form>
    </Card>
  );
}

function mapPrices(data: AdminPartnerDetail) {
  return {
    sticker: String(data.partner.prices.sticker),
    program: String(data.partner.prices.program),
    cell: String(data.partner.prices.cell),
  };
}

function PaymentForm({ partnerId }: { partnerId: string }) {
  const toast = useToast();
  const pay = useAdminPartnerAction<{ partnerId: string; amountRub: number; note: string }>('payment');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  return (
    <form
      className={`${s.toolbar} ${p.formRow}`}
      onSubmit={event => {
        event.preventDefault();
        pay.mutate({ partnerId, amountRub: Number(amount.replace(',', '.')), note }, {
          onSuccess: () => { setAmount(''); setNote(''); toast('Оплата записана', 'success'); },
          onError: (error: Error) => toast(error.message, 'error'),
        });
      }}
    >
      <Field label="Партнёр оплатил, ₽" help="Отрицательная сумма — исправление ошибочной записи">
        <Input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" required />
      </Field>
      <Field label="Комментарий"><Input value={note} onChange={e => setNote(e.target.value)} maxLength={200} placeholder="Перевод на карту 14.10" /></Field>
      <Button type="submit" className={p.tap} loading={pay.isPending}>Записать оплату</Button>
    </form>
  );
}

type PartnerItem = AdminPartnerDetail['items'][number];
type PartnerLedgerRow = AdminPartnerDetail['ledger'][number];
type PartnerPaymentRow = AdminPartnerDetail['payments'][number];

function ItemsTable({ data }: { data: AdminPartnerDetail }) {
  const toast = useToast();
  const toggle = useAdminPartnerAction<{ partnerId: string; kind: PartnerResource; id: number; active: boolean }>('toggleItem');
  const columns: ResponsiveColumn<PartnerItem>[] = [
    { key: 'value', header: 'Код / ключ', primary: true, cell: item => <span className={p.mono}>{item.value}</span> },
    { key: 'kind', header: 'Вид', cell: item => RESOURCE_LABELS[item.kind].short },
    { key: 'note', header: 'Для кого', cell: item => item.note || '—' },
    {
      key: 'volume',
      header: 'Объём',
      cell: item => (item.kind === 'cell' ? `${item.durationDays} дн. × ${item.deviceLimit} ПК` : `${item.used} из ${item.limit}`),
    },
    { key: 'created', header: 'Создан', cell: item => shortDate(item.createdAt) },
    {
      key: 'status',
      header: 'Статус',
      cell: item => <Badge tone={item.active ? 'success' : 'error'}>{item.active ? 'Активен' : 'Выключен'}</Badge>,
    },
  ];
  return (
    <ResponsiveTable
      rows={data.items}
      columns={columns}
      rowKey={item => `${item.kind}-${item.id}`}
      empty={<EmptyBlock title="Партнёр ещё ничего не выпустил" text="Выпуски появятся здесь." />}
      rowActions={item => (
        <Button
          variant="ghost"
          size="sm"
          className={p.tap}
          onClick={() =>
            toggle.mutate({ partnerId: data.partner.id, kind: item.kind, id: item.id, active: !item.active }, {
              onError: (error: Error) => toast(error.message, 'error'),
            })
          }
        >
          {item.active ? 'Выключить' : 'Включить'}
        </Button>
      )}
    />
  );
}

const LEDGER_KIND = { grant: 'Пул от вас', issue: 'Выпуск', topup: 'Пополнение кода' } as const;

const ledgerColumns: ResponsiveColumn<PartnerLedgerRow>[] = [
  { key: 'kind', header: 'Операция', primary: true, cell: entry => LEDGER_KIND[entry.kind] },
  { key: 'date', header: 'Дата', cell: entry => shortDate(entry.createdAt) },
  { key: 'pool', header: 'Пул', cell: entry => RESOURCE_LABELS[entry.resource].unit },
  {
    key: 'delta',
    header: 'Изменение',
    align: 'end',
    cell: entry => <span className={p.num}>{entry.delta > 0 ? `+${entry.delta}` : entry.delta}</span>,
  },
  { key: 'ref', header: 'Код / ключ', cell: entry => <span className={p.mono}>{entry.refLabel || entry.note || '—'}</span> },
  { key: 'cost', header: 'Должен, ₽', align: 'end', cell: entry => (entry.costRub == null ? '—' : formatRub(entry.costRub)) },
  { key: 'price', header: 'Клиенту, ₸', align: 'end', cell: entry => (entry.priceKzt == null ? '—' : formatKzt(entry.priceKzt)) },
];

function LedgerTable({ data }: { data: AdminPartnerDetail }) {
  return (
    <ResponsiveTable
      rows={data.ledger}
      columns={ledgerColumns}
      rowKey={entry => entry.id}
      empty={<EmptyBlock title="Движений пока нет" text="Пополните пул партнёра выше." />}
    />
  );
}

const paymentColumns: ResponsiveColumn<PartnerPaymentRow>[] = [
  { key: 'amount', header: 'Сумма', primary: true, cell: payment => formatRub(payment.amountRub) },
  { key: 'date', header: 'Дата', cell: payment => shortDate(payment.createdAt) },
  { key: 'note', header: 'Комментарий', cell: payment => payment.note || '—' },
];

function PaymentsTable({ data }: { data: AdminPartnerDetail }) {
  return (
    <ResponsiveTable
      rows={data.payments}
      columns={paymentColumns}
      rowKey={payment => payment.id}
      empty={<EmptyBlock title="Оплат пока нет" text="Записывайте оплаты партнёра в блоке «Расчёты»." />}
    />
  );
}
