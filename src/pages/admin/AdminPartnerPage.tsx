import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CircleDollarSign, Coins, HandCoins, Wallet } from 'lucide-react';
import { type AdminPartnerDetail, useAdminPartner, useAdminPartnerAction } from '../../api/admin';
import { shortDate } from '../../lib/admin-users';
import {
  type PartnerResource, RESOURCE_LABELS, formatKzt, formatRub, poolLeft,
} from '../../lib/partner';
import {
  Alert, Badge, Button, Card, EmptyState, Field, Input, Progress, Skeleton, Stat, Table, Tabs, useToast,
} from '../../ui';
import s from '../../layout/AdminShell.module.css';

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
          loading={update.isPending}
          onClick={() => {
            if (partner.active && !window.confirm('Отключить партнёра? Он не сможет выпускать коды. Уже выданные коды продолжат работать.')) return;
            update.mutate({ partnerId: partner.id, active: !partner.active }, {
              onError: (error: Error) => toast(error.message, 'error'),
            });
          }}
        >
          {partner.active ? 'Отключить' : 'Включить'}
        </Button>
      </div>
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
        <Button size="sm" loading={grant.isPending} onClick={() => submit(1)}>Пополнить</Button>
        <Button size="sm" variant="ghost" loading={grant.isPending} onClick={() => submit(-1)}>Списать</Button>
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
        className={s.toolbar}
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
        <Button type="submit" loading={update.isPending}>Сохранить цены</Button>
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
      className={s.toolbar}
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
      <Button type="submit" loading={pay.isPending}>Записать оплату</Button>
    </form>
  );
}

function ItemsTable({ data }: { data: AdminPartnerDetail }) {
  const toast = useToast();
  const toggle = useAdminPartnerAction<{ partnerId: string; kind: PartnerResource; id: number; active: boolean }>('toggleItem');
  if (!data.items.length) return <Card><EmptyState title="Партнёр ещё ничего не выпустил" text="Выпуски появятся здесь." /></Card>;
  return (
    <Table>
      <thead><tr><th>Вид</th><th>Код / ключ</th><th>Для кого</th><th>Объём</th><th>Создан</th><th>Статус</th><th /></tr></thead>
      <tbody>
        {data.items.map(item => (
          <tr key={`${item.kind}-${item.id}`}>
            <td>{RESOURCE_LABELS[item.kind].short}</td>
            <td className="mono">{item.value}</td>
            <td>{item.note || '—'}</td>
            <td>{item.kind === 'cell' ? `${item.durationDays} дн. × ${item.deviceLimit} ПК` : `${item.used} из ${item.limit}`}</td>
            <td>{shortDate(item.createdAt)}</td>
            <td><Badge tone={item.active ? 'success' : 'error'}>{item.active ? 'Активен' : 'Выключен'}</Badge></td>
            <td>
              <Button
                variant="ghost" size="sm"
                onClick={() => toggle.mutate({ partnerId: data.partner.id, kind: item.kind, id: item.id, active: !item.active }, {
                  onError: (error: Error) => toast(error.message, 'error'),
                })}
              >
                {item.active ? 'Выключить' : 'Включить'}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

const LEDGER_KIND = { grant: 'Пул от вас', issue: 'Выпуск', topup: 'Пополнение кода' } as const;

function LedgerTable({ data }: { data: AdminPartnerDetail }) {
  if (!data.ledger.length) return <Card><EmptyState title="Движений пока нет" text="Пополните пул партнёра выше." /></Card>;
  return (
    <Table>
      <thead><tr><th>Дата</th><th>Операция</th><th>Пул</th><th>Изменение</th><th>Код / ключ</th><th>Должен, ₽</th><th>Клиенту, ₸</th></tr></thead>
      <tbody>
        {data.ledger.map(entry => (
          <tr key={entry.id}>
            <td>{shortDate(entry.createdAt)}</td>
            <td>{LEDGER_KIND[entry.kind]}</td>
            <td>{RESOURCE_LABELS[entry.resource].unit}</td>
            <td>{entry.delta > 0 ? `+${entry.delta}` : entry.delta}</td>
            <td className="mono">{entry.refLabel || entry.note || '—'}</td>
            <td>{entry.costRub == null ? '—' : formatRub(entry.costRub)}</td>
            <td>{entry.priceKzt == null ? '—' : formatKzt(entry.priceKzt)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function PaymentsTable({ data }: { data: AdminPartnerDetail }) {
  if (!data.payments.length) return <Card><EmptyState title="Оплат пока нет" text="Записывайте оплаты партнёра в блоке «Расчёты»." /></Card>;
  return (
    <Table>
      <thead><tr><th>Дата</th><th>Сумма</th><th>Комментарий</th></tr></thead>
      <tbody>
        {data.payments.map(payment => (
          <tr key={payment.id}>
            <td>{shortDate(payment.createdAt)}</td>
            <td>{formatRub(payment.amountRub)}</td>
            <td>{payment.note || '—'}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
