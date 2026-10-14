import { useEffect, useMemo, useState } from 'react';
import { Copy, HandCoins, Wallet } from 'lucide-react';
import {
  type PartnerIssueResult, type PartnerMe, usePartnerIssue, usePartnerItems, usePartnerLedger,
  usePartnerMarkup, usePartnerMe, usePartnerPayments, usePartnerToggle, usePartnerTopup,
} from '../../api/partner';
import { dateTime } from '../../api/cabinet';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import {
  CELL_DEVICE_LIMITS, CELL_DURATIONS, type PartnerItem, type PartnerResource, RESOURCE_LABELS,
  clientMessage, costRub, formatKzt, formatRub, poolLeft, suggestedKzt,
} from '../../lib/partner';
import { useDocumentMeta } from '../../lib/seo';
import {
  Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Progress, Segmented, Select, Stat, Table,
  Tabs, useToast,
} from '../../ui';
import c from './cabinet.module.css';

const RESOURCES: PartnerResource[] = ['sticker', 'program', 'cell'];
const SCOPES = [
  { value: 'wb', label: 'Wildberries' },
  { value: 'ozon', label: 'Ozon' },
  { value: 'both', label: 'WB + Ozon' },
] as const;

function copy(text: string, toast: ReturnType<typeof useToast>, done = 'Скопировано') {
  void navigator.clipboard?.writeText(text);
  toast(done, 'success');
}

/**
 * Панель партнёра. Партнёр выпускает коды и ключи из пула, выданного владельцем,
 * и сразу видит обе суммы: сколько это стоит в рублях (его долг владельцу) и за
 * сколько в тенге он продаёт клиенту (со своей наценкой).
 */
export function PartnerPage() {
  useDocumentMeta('Партнёр — кабинет');
  const me = usePartnerMe();
  const [issued, setIssued] = useState<PartnerIssueResult | null>(null);

  if (me.isPending) return <div className="page"><CabinetLoading /></div>;
  if (me.isError) return <div className="page"><CabinetError error={me.error} retry={() => me.refetch()} /></div>;
  const { partner, balance, kztPerRub } = me.data;

  return (
    <div className="page stack-lg">
      <header className="page-head">
        <h1>{partner.name}</h1>
        <p>
          Выпускайте коды и ключи для своих клиентов. Рубли — ваш долг владельцу сервиса, тенге — цена для клиента.
          Курс: 1 ₽ = {kztPerRub} ₸.
        </p>
      </header>

      {!partner.active && (
        <Alert tone="warning">Партнёрский доступ приостановлен. Выданные коды работают, но выпускать новые нельзя.</Alert>
      )}

      <div className="grid grid-3">
        <Card><Stat value={formatRub(balance.dueRub)} label="к оплате владельцу" icon={<Wallet size={20} />} /></Card>
        <Card><Stat value={formatRub(balance.paidRub)} label="уже оплачено" /></Card>
        <Card><Stat value={formatKzt(balance.revenueKzt)} label="выставлено клиентам" icon={<HandCoins size={20} />} /></Card>
      </div>

      <div className="grid grid-3">
        {RESOURCES.map(resource => {
          const pool = partner.pool[resource];
          return (
            <Card key={resource}>
              <h3>{RESOURCE_LABELS[resource].title}</h3>
              <Progress value={pool.used} max={Math.max(1, pool.granted)} label={<span>использовано {pool.used} из {pool.granted}</span>} />
              <p className="muted">
                Осталось <strong>{poolLeft(pool)}</strong> {RESOURCE_LABELS[resource].unit} · {formatRub(partner.prices[resource])} за единицу
              </p>
            </Card>
          );
        })}
      </div>

      <IssueCard me={me.data} onIssued={setIssued} />

      <Tabs
        label="Выпуски и расчёты"
        items={[
          { value: 'items', label: 'Выпущенные', content: <ItemsTab me={me.data} onIssued={setIssued} /> },
          { value: 'ledger', label: 'История', content: <LedgerTab /> },
          { value: 'payments', label: 'Оплаты владельцу', content: <PaymentsTab /> },
        ]}
      />

      <IssuedModal result={issued} onClose={() => setIssued(null)} />
    </div>
  );
}

/** Цена клиенту: по наценке или своя. Пустое поле — цена по наценке. */
function usePrice(me: PartnerMe, cost: number) {
  const [custom, setCustom] = useState('');
  const suggested = suggestedKzt(cost, me.kztPerRub, me.partner.markupPercent);
  const customValue = custom.trim() === '' ? null : Number(custom.replace(',', '.'));
  const price = customValue != null && Number.isFinite(customValue) && customValue >= 0 ? customValue : suggested;
  return { custom, setCustom, suggested, price, priceKzt: customValue != null && Number.isFinite(customValue) ? customValue : null };
}

function MoneyBox({ me, cost, price }: { me: PartnerMe; cost: number; price: ReturnType<typeof usePrice> }) {
  const base = cost * me.kztPerRub;
  const profit = price.price - base;
  return (
    <div className="stack">
      <div className="grid grid-3">
        <Stat value={formatRub(cost)} label="ваш долг владельцу" />
        <Stat value={formatKzt(price.price)} label="цена клиенту" />
        <Stat value={formatKzt(profit)} label={`ваша прибыль (себестоимость ${formatKzt(base)})`} />
      </div>
      <Field label="Своя цена клиенту, ₸" help={`Оставьте пустым — будет ${formatKzt(price.suggested)} по вашей наценке ${me.partner.markupPercent}%`}>
        <Input inputMode="decimal" value={price.custom} onChange={e => price.setCustom(e.target.value)} placeholder={String(price.suggested)} />
      </Field>
    </div>
  );
}

function IssueCard({ me, onIssued }: { me: PartnerMe; onIssued: (r: PartnerIssueResult) => void }) {
  const toast = useToast();
  const issue = usePartnerIssue();
  const [kind, setKind] = useState<PartnerResource>('sticker');
  const [amount, setAmount] = useState('100');
  const [days, setDays] = useState<number>(30);
  const [devices, setDevices] = useState<number>(1);
  const [scope, setScope] = useState('wb');
  const [note, setNote] = useState('');

  const units = kind === 'cell' ? days * devices : Math.max(0, Math.floor(Number(amount) || 0));
  const cost = costRub(units, me.partner.prices[kind]);
  const price = usePrice(me, cost);
  const left = poolLeft(me.partner.pool[kind]);

  const submit = () => {
    const priceKzt = price.priceKzt;
    const body = kind === 'cell'
      ? { kind, durationDays: days, deviceLimit: devices, marketplaceScope: scope, note, priceKzt }
      : { kind, amount: units, note, priceKzt };
    issue.mutate(body, {
      onSuccess: result => { onIssued(result); setNote(''); price.setCustom(''); },
      onError: (error: Error) => toast(error.message, 'error'),
    });
  };

  return (
    <Card accent>
      <div className={c.sectionHead}>
        <h2>Выпустить для клиента</h2>
        <MarkupEditor me={me} />
      </div>
      <div className="stack">
        <Segmented
          label="Что выпустить"
          value={kind}
          onChange={setKind}
          options={RESOURCES.map(r => ({ value: r, label: RESOURCE_LABELS[r].short }))}
        />
        <div className="grid grid-3">
          {kind === 'cell' ? (
            <>
              <Field label="Срок, дней">
                <Select value={days} onChange={e => setDays(Number(e.target.value))}>
                  {CELL_DURATIONS.map(d => <option key={d} value={d}>{d}</option>)}
                </Select>
              </Field>
              <Field label="Компьютеров">
                <Select value={devices} onChange={e => setDevices(Number(e.target.value))}>
                  {CELL_DEVICE_LIMITS.map(d => <option key={d} value={d}>{d}</option>)}
                </Select>
              </Field>
              <Field label="Маркетплейс">
                <Select value={scope} onChange={e => setScope(e.target.value)}>
                  {SCOPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
            </>
          ) : (
            <Field label={kind === 'sticker' ? 'Генераций в коде' : 'Итераций в ключе'}>
              <Input type="number" min={1} max={100000} value={amount} onChange={e => setAmount(e.target.value)} />
            </Field>
          )}
          <Field label="Для кого (видно только вам)">
            <Input value={note} onChange={e => setNote(e.target.value)} maxLength={120} placeholder="Имя или телефон клиента" />
          </Field>
        </div>

        <MoneyBox me={me} cost={cost} price={price} />

        {units > left && <Alert tone="warning">В пуле осталось {left} {RESOURCE_LABELS[kind].unit}. Попросите владельца пополнить пул.</Alert>}
        <div className="row">
          <Button size="lg" loading={issue.isPending} disabled={!me.partner.active || units < 1 || units > left} onClick={submit}>
            Выпустить
          </Button>
        </div>
      </div>
    </Card>
  );
}

function MarkupEditor({ me }: { me: PartnerMe }) {
  const toast = useToast();
  const save = usePartnerMarkup();
  const [value, setValue] = useState(String(me.partner.markupPercent));
  useEffect(() => setValue(String(me.partner.markupPercent)), [me.partner.markupPercent]);
  return (
    <form
      className="row"
      onSubmit={event => {
        event.preventDefault();
        save.mutate({ markupPercent: Number(value.replace(',', '.')) }, {
          onSuccess: () => toast('Наценка сохранена', 'success'),
          onError: (error: Error) => toast(error.message, 'error'),
        });
      }}
    >
      <Field label="Моя наценка, %">
        <Input inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} style={{ maxWidth: 110 }} />
      </Field>
      <Button type="submit" variant="secondary" size="sm" loading={save.isPending}>Сохранить</Button>
    </form>
  );
}

function IssuedModal({ result, onClose }: { result: PartnerIssueResult | null; onClose: () => void }) {
  const toast = useToast();
  if (!result) return null;
  const { item, entry } = result;
  return (
    <Modal open onOpenChange={open => !open && onClose()} title="Готово" description="Передайте код или ключ клиенту.">
      <div className="stack">
        <div className={c.code}>
          <span className={c.codeLabel}>{RESOURCE_LABELS[item.kind].short}</span>
          <span className={c.codeValue}>{item.value}</span>
        </div>
        {entry && (
          <div className="grid grid-2">
            <Stat value={formatRub(entry.costRub ?? 0)} label="долг владельцу" />
            <Stat value={formatKzt(entry.priceKzt ?? 0)} label="получить с клиента" />
          </div>
        )}
        <div className="row">
          <Button onClick={() => copy(item.value, toast, 'Код скопирован')}><Copy size={16} />Скопировать код</Button>
          <Button variant="secondary" onClick={() => copy(clientMessage(item), toast, 'Сообщение скопировано')}>
            Скопировать сообщение клиенту
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ItemsTab({ me, onIssued }: { me: PartnerMe; onIssued: (r: PartnerIssueResult) => void }) {
  const toast = useToast();
  const items = usePartnerItems();
  const toggle = usePartnerToggle();
  const [q, setQ] = useState('');
  const [topupItem, setTopupItem] = useState<PartnerItem | null>(null);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items.data ?? []).filter(i => !needle || i.value.toLowerCase().includes(needle) || i.note.toLowerCase().includes(needle));
  }, [items.data, q]);

  if (items.isPending) return <CabinetLoading />;
  if (items.isError) return <CabinetError error={items.error} retry={() => items.refetch()} />;
  if (!items.data.length) return <Card><EmptyState title="Пока ничего не выпущено" text="Выпустите первый код в блоке выше." /></Card>;

  return (
    <div className="stack">
      <Field label="Поиск по коду или клиенту"><Input value={q} onChange={e => setQ(e.target.value)} /></Field>
      <Table>
        <thead><tr><th>Код / ключ</th><th>Для кого</th><th>Объём</th><th>Создан</th><th>Статус</th><th /></tr></thead>
        <tbody>
          {filtered.map(item => (
            <tr key={`${item.kind}-${item.id}`}>
              <td>
                <div className="mono">{item.value}</div>
                <div className="muted">{RESOURCE_LABELS[item.kind].short}</div>
              </td>
              <td>{item.note || '—'}</td>
              <td>
                {item.kind === 'cell'
                  ? `${item.durationDays} дн. × ${item.deviceLimit} ПК${item.expiresAt ? `, до ${dateTime(item.expiresAt)}` : ', не активирован'}`
                  : `израсходовано ${item.used} из ${item.limit}`}
              </td>
              <td>{dateTime(item.createdAt)}</td>
              <td><Badge tone={item.active ? 'success' : 'error'}>{item.active ? 'Активен' : 'Выключен'}</Badge></td>
              <td>
                <div className={c.rowActions}>
                  <Button variant="ghost" size="sm" aria-label="Скопировать" onClick={() => copy(item.value, toast)}><Copy size={16} /></Button>
                  {item.kind !== 'cell' && me.partner.active && (
                    <Button variant="ghost" size="sm" onClick={() => setTopupItem(item)}>Пополнить</Button>
                  )}
                  {me.partner.active && (
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => {
                        if (item.active && !window.confirm(`Выключить ${item.value}? Клиент не сможет им пользоваться. Пул не возвращается.`)) return;
                        toggle.mutate({ kind: item.kind, id: item.id, active: !item.active }, {
                          onError: (error: Error) => toast(error.message, 'error'),
                        });
                      }}
                    >
                      {item.active ? 'Выключить' : 'Включить'}
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {topupItem && <TopupModal me={me} item={topupItem} onClose={() => setTopupItem(null)} onDone={onIssued} />}
    </div>
  );
}

function TopupModal({ me, item, onClose, onDone }: { me: PartnerMe; item: PartnerItem; onClose: () => void; onDone: (r: PartnerIssueResult) => void }) {
  const toast = useToast();
  const topup = usePartnerTopup();
  const [amount, setAmount] = useState('100');
  const units = Math.max(0, Math.floor(Number(amount) || 0));
  const cost = costRub(units, me.partner.prices[item.kind]);
  const price = usePrice(me, cost);
  const left = poolLeft(me.partner.pool[item.kind]);
  return (
    <Modal open onOpenChange={open => !open && onClose()} title={`Пополнить ${item.value}`} description={item.note || RESOURCE_LABELS[item.kind].short}>
      <div className="stack">
        <Field label={item.kind === 'sticker' ? 'Добавить генераций' : 'Добавить итераций'} help={`В пуле: ${left}`}>
          <Input type="number" min={1} value={amount} onChange={e => setAmount(e.target.value)} />
        </Field>
        <MoneyBox me={me} cost={cost} price={price} />
        <Button
          loading={topup.isPending}
          disabled={units < 1 || units > left}
          onClick={() => topup.mutate({ kind: item.kind, id: item.id, amount: units, priceKzt: price.priceKzt }, {
            onSuccess: result => { onClose(); onDone({ item: { ...item, ...result.item }, entry: result.entry }); },
            onError: (error: Error) => toast(error.message, 'error'),
          })}
        >
          Пополнить
        </Button>
      </div>
    </Modal>
  );
}

const LEDGER_KIND = { grant: 'Пул от владельца', issue: 'Выпуск', topup: 'Пополнение' } as const;

function LedgerTab() {
  const ledger = usePartnerLedger();
  if (ledger.isPending) return <CabinetLoading />;
  if (ledger.isError) return <CabinetError error={ledger.error} retry={() => ledger.refetch()} />;
  if (!ledger.data.length) return <Card><EmptyState title="Пока пусто" text="Здесь появятся пополнения пула и выпуски." /></Card>;
  return (
    <Table>
      <thead><tr><th>Дата</th><th>Операция</th><th>Количество</th><th>Код / ключ</th><th>Долг, ₽</th><th>Клиенту, ₸</th></tr></thead>
      <tbody>
        {ledger.data.map(entry => (
          <tr key={entry.id}>
            <td>{dateTime(entry.createdAt)}</td>
            <td>{LEDGER_KIND[entry.kind]}</td>
            <td>{entry.delta > 0 ? `+${entry.delta}` : entry.delta} {RESOURCE_LABELS[entry.resource].unit}</td>
            <td className="mono">{entry.refLabel || '—'}</td>
            <td>{entry.costRub == null ? '—' : formatRub(entry.costRub)}</td>
            <td>{entry.priceKzt == null ? '—' : formatKzt(entry.priceKzt)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function PaymentsTab() {
  const payments = usePartnerPayments();
  if (payments.isPending) return <CabinetLoading />;
  if (payments.isError) return <CabinetError error={payments.error} retry={() => payments.refetch()} />;
  if (!payments.data.length) return <Card><EmptyState title="Оплат пока нет" text="Оплаты, которые отметит владелец, появятся здесь." /></Card>;
  return (
    <Table>
      <thead><tr><th>Дата</th><th>Сумма</th><th>Комментарий</th></tr></thead>
      <tbody>
        {payments.data.map(p => (
          <tr key={p.id}><td>{dateTime(p.createdAt)}</td><td>{formatRub(p.amountRub)}</td><td>{p.note || '—'}</td></tr>
        ))}
      </tbody>
    </Table>
  );
}
