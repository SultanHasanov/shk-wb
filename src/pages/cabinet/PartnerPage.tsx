import { useEffect, useMemo, useState } from 'react';
import { Copy, HandCoins, Wallet } from 'lucide-react';
import {
  type PartnerIssueResult, type PartnerMe, usePartnerIssue, usePartnerItems, usePartnerLedger,
  usePartnerMarkup, usePartnerMe, usePartnerPayments, usePartnerToggle, usePartnerTopup,
} from '../../api/partner';
import { dateTime } from '../../api/cabinet';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import {
  CELL_DEVICE_LIMITS, CELL_DURATIONS, type PartnerItem, type PartnerResource,
  clientMessage, costRub, formatKzt, formatRub, poolLeft, resourceLabels, suggestedKzt,
} from '../../lib/partner';
import { useDocumentMeta } from '../../lib/seo';
import { type T, useLocale, useT } from '../../i18n';
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

function copy(text: string, toast: ReturnType<typeof useToast>, done: string) {
  void navigator.clipboard?.writeText(text);
  toast(done, 'success');
}

function useLabels() {
  return resourceLabels(useLocale());
}

/**
 * Панель партнёра. Партнёр выпускает коды и ключи из пула, выданного владельцем,
 * и сразу видит обе суммы: сколько это стоит в рублях (его долг владельцу) и за
 * сколько в тенге он продаёт клиенту (со своей наценкой).
 */
export function PartnerPage() {
  const t = useT();
  const labels = useLabels();
  useDocumentMeta(t('Партнёр — кабинет', 'Серіктес — кабинет'));
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
          {t(
            `Выпускайте коды и ключи для своих клиентов. Рубли — ваш долг владельцу сервиса, тенге — цена для клиента. Курс: 1 ₽ = ${kztPerRub} ₸.`,
            `Клиенттеріңізге кодтар мен кілттер шығарыңыз. Рубль — сервис иесіне қарызыңыз, теңге — клиентке арналған баға. Бағам: 1 ₽ = ${kztPerRub} ₸.`,
          )}
        </p>
      </header>

      {!partner.active && (
        <Alert tone="warning">
          {t(
            'Партнёрский доступ приостановлен. Выданные коды работают, но выпускать новые нельзя.',
            'Серіктестік қолжетімділік тоқтатылды. Берілген кодтар жұмыс істейді, бірақ жаңаларын шығаруға болмайды.',
          )}
        </Alert>
      )}

      <div className="grid grid-3">
        <Card><Stat value={formatRub(balance.dueRub)} label={t('к оплате владельцу', 'иесіне төлеуге')} icon={<Wallet size={20} />} /></Card>
        <Card><Stat value={formatRub(balance.paidRub)} label={t('уже оплачено', 'төленіп қойған')} /></Card>
        <Card><Stat value={formatKzt(balance.revenueKzt)} label={t('выставлено клиентам', 'клиенттерге қойылды')} icon={<HandCoins size={20} />} /></Card>
      </div>

      <div className="grid grid-3">
        {RESOURCES.map(resource => {
          const pool = partner.pool[resource];
          return (
            <Card key={resource}>
              <h3>{labels[resource].title}</h3>
              <Progress
                value={pool.used}
                max={Math.max(1, pool.granted)}
                label={<span>{t(`использовано ${pool.used} из ${pool.granted}`, `${pool.granted} ішінен ${pool.used} пайдаланылды`)}</span>}
              />
              <p className="muted">
                {t('Осталось', 'Қалды')} <strong>{poolLeft(pool)}</strong> {labels[resource].unit} ·{' '}
                {t(`${formatRub(partner.prices[resource])} за единицу`, `бірлігі ${formatRub(partner.prices[resource])}`)}
              </p>
            </Card>
          );
        })}
      </div>

      <IssueCard me={me.data} onIssued={setIssued} />

      <Tabs
        label={t('Выпуски и расчёты', 'Шығарылымдар мен есеп айырысу')}
        items={[
          { value: 'items', label: t('Выпущенные', 'Шығарылғандар'), content: <ItemsTab me={me.data} onIssued={setIssued} /> },
          { value: 'ledger', label: t('История', 'Тарих'), content: <LedgerTab /> },
          { value: 'payments', label: t('Оплаты владельцу', 'Иесіне төлемдер'), content: <PaymentsTab /> },
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
  const valid = customValue != null && Number.isFinite(customValue) && customValue >= 0;
  return { custom, setCustom, suggested, price: valid ? customValue : suggested, priceKzt: valid ? customValue : null };
}

function MoneyBox({ me, cost, price, t }: { me: PartnerMe; cost: number; price: ReturnType<typeof usePrice>; t: T }) {
  const base = cost * me.kztPerRub;
  const profit = price.price - base;
  return (
    <div className="stack">
      <div className="grid grid-3">
        <Stat value={formatRub(cost)} label={t('ваш долг владельцу', 'иесіне қарызыңыз')} />
        <Stat value={formatKzt(price.price)} label={t('цена клиенту', 'клиентке баға')} />
        <Stat
          value={formatKzt(profit)}
          label={t(`ваша прибыль (себестоимость ${formatKzt(base)})`, `пайдаңыз (өзіндік құны ${formatKzt(base)})`)}
        />
      </div>
      <Field
        label={t('Своя цена клиенту, ₸', 'Клиентке өз бағаңыз, ₸')}
        help={t(
          `Оставьте пустым — будет ${formatKzt(price.suggested)} по вашей наценке ${me.partner.markupPercent}%`,
          `Бос қалдырсаңыз — ${me.partner.markupPercent}% үстемеңіз бойынша ${formatKzt(price.suggested)} болады`,
        )}
      >
        <Input inputMode="decimal" value={price.custom} onChange={e => price.setCustom(e.target.value)} placeholder={String(price.suggested)} />
      </Field>
    </div>
  );
}

function IssueCard({ me, onIssued }: { me: PartnerMe; onIssued: (r: PartnerIssueResult) => void }) {
  const toast = useToast();
  const t = useT();
  const labels = useLabels();
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
        <h2>{t('Выпустить для клиента', 'Клиентке шығару')}</h2>
        <MarkupEditor me={me} />
      </div>
      <div className="stack">
        <Segmented
          label={t('Что выпустить', 'Не шығару')}
          value={kind}
          onChange={setKind}
          options={RESOURCES.map(r => ({ value: r, label: labels[r].short }))}
        />
        <div className="grid grid-3">
          {kind === 'cell' ? (
            <>
              <Field label={t('Срок, дней', 'Мерзімі, күн')}>
                <Select value={days} onChange={e => setDays(Number(e.target.value))}>
                  {CELL_DURATIONS.map(d => <option key={d} value={d}>{d}</option>)}
                </Select>
              </Field>
              <Field label={t('Компьютеров', 'Компьютерлер')}>
                <Select value={devices} onChange={e => setDevices(Number(e.target.value))}>
                  {CELL_DEVICE_LIMITS.map(d => <option key={d} value={d}>{d}</option>)}
                </Select>
              </Field>
              <Field label={t('Маркетплейс', 'Маркетплейс')}>
                <Select value={scope} onChange={e => setScope(e.target.value)}>
                  {SCOPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
            </>
          ) : (
            <Field label={kind === 'sticker' ? t('Генераций в коде', 'Кодтағы генерациялар') : t('Итераций в ключе', 'Кілттегі итерациялар')}>
              <Input type="number" min={1} max={100000} value={amount} onChange={e => setAmount(e.target.value)} />
            </Field>
          )}
          <Field label={t('Для кого (видно только вам)', 'Кімге (тек сізге көрінеді)')}>
            <Input value={note} onChange={e => setNote(e.target.value)} maxLength={120} placeholder={t('Имя или телефон клиента', 'Клиенттің аты немесе телефоны')} />
          </Field>
        </div>

        <MoneyBox me={me} cost={cost} price={price} t={t} />

        {units > left && (
          <Alert tone="warning">
            {t(
              `В пуле осталось ${left} ${labels[kind].unit}. Попросите владельца пополнить пул.`,
              `Пулда ${left} ${labels[kind].unit} қалды. Иесінен пулды толықтыруды сұраңыз.`,
            )}
          </Alert>
        )}
        <div className="row">
          <Button size="lg" loading={issue.isPending} disabled={!me.partner.active || units < 1 || units > left} onClick={submit}>
            {t('Выпустить', 'Шығару')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function MarkupEditor({ me }: { me: PartnerMe }) {
  const toast = useToast();
  const t = useT();
  const save = usePartnerMarkup();
  const [value, setValue] = useState(String(me.partner.markupPercent));
  useEffect(() => setValue(String(me.partner.markupPercent)), [me.partner.markupPercent]);
  return (
    <form
      className="row"
      onSubmit={event => {
        event.preventDefault();
        save.mutate({ markupPercent: Number(value.replace(',', '.')) }, {
          onSuccess: () => toast(t('Наценка сохранена', 'Үстеме сақталды'), 'success'),
          onError: (error: Error) => toast(error.message, 'error'),
        });
      }}
    >
      <Field label={t('Моя наценка, %', 'Менің үстемем, %')}>
        <Input inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} style={{ maxWidth: 110 }} />
      </Field>
      <Button type="submit" variant="secondary" size="sm" loading={save.isPending}>{t('Сохранить', 'Сақтау')}</Button>
    </form>
  );
}

function IssuedModal({ result, onClose }: { result: PartnerIssueResult | null; onClose: () => void }) {
  const toast = useToast();
  const t = useT();
  const locale = useLocale();
  const labels = useLabels();
  if (!result) return null;
  const { item, entry } = result;
  return (
    <Modal open onOpenChange={open => !open && onClose()} title={t('Готово', 'Дайын')} description={t('Передайте код или ключ клиенту.', 'Кодты немесе кілтті клиентке беріңіз.')}>
      <div className="stack">
        <div className={c.code}>
          <span className={c.codeLabel}>{labels[item.kind].short}</span>
          <span className={c.codeValue}>{item.value}</span>
        </div>
        {entry && (
          <div className="grid grid-2">
            <Stat value={formatRub(entry.costRub ?? 0)} label={t('долг владельцу', 'иесіне қарыз')} />
            <Stat value={formatKzt(entry.priceKzt ?? 0)} label={t('получить с клиента', 'клиенттен алу')} />
          </div>
        )}
        <div className="row">
          <Button onClick={() => copy(item.value, toast, t('Код скопирован', 'Код көшірілді'))}><Copy size={16} />{t('Скопировать код', 'Кодты көшіру')}</Button>
          <Button variant="secondary" onClick={() => copy(clientMessage(item, locale), toast, t('Сообщение скопировано', 'Хабарлама көшірілді'))}>
            {t('Скопировать сообщение клиенту', 'Клиентке хабарламаны көшіру')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ItemsTab({ me, onIssued }: { me: PartnerMe; onIssued: (r: PartnerIssueResult) => void }) {
  const toast = useToast();
  const t = useT();
  const labels = useLabels();
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
  if (!items.data.length) {
    return <Card><EmptyState title={t('Пока ничего не выпущено', 'Әзірге ештеңе шығарылмаған')} text={t('Выпустите первый код в блоке выше.', 'Алғашқы кодты жоғарыдағы блокта шығарыңыз.')} /></Card>;
  }

  return (
    <div className="stack">
      <Field label={t('Поиск по коду или клиенту', 'Код немесе клиент бойынша іздеу')}><Input value={q} onChange={e => setQ(e.target.value)} /></Field>
      <Table>
        <thead>
          <tr>
            <th>{t('Код / ключ', 'Код / кілт')}</th><th>{t('Для кого', 'Кімге')}</th><th>{t('Объём', 'Көлемі')}</th>
            <th>{t('Создан', 'Жасалды')}</th><th>{t('Статус', 'Мәртебесі')}</th><th />
          </tr>
        </thead>
        <tbody>
          {filtered.map(item => (
            <tr key={`${item.kind}-${item.id}`}>
              <td>
                <div className="mono">{item.value}</div>
                <div className="muted">{labels[item.kind].short}</div>
              </td>
              <td>{item.note || '—'}</td>
              <td>
                {item.kind === 'cell'
                  ? t(
                    `${item.durationDays} дн. × ${item.deviceLimit} ПК${item.expiresAt ? `, до ${dateTime(item.expiresAt)}` : ', не активирован'}`,
                    `${item.durationDays} күн × ${item.deviceLimit} ДК${item.expiresAt ? `, ${dateTime(item.expiresAt)} дейін` : ', белсендірілмеген'}`,
                  )
                  : t(`израсходовано ${item.used} из ${item.limit}`, `${item.limit} ішінен ${item.used} жұмсалды`)}
              </td>
              <td>{dateTime(item.createdAt)}</td>
              <td><Badge tone={item.active ? 'success' : 'error'}>{item.active ? t('Активен', 'Белсенді') : t('Выключен', 'Өшірілген')}</Badge></td>
              <td>
                <div className={c.rowActions}>
                  <Button variant="ghost" size="sm" aria-label={t('Скопировать', 'Көшіру')} onClick={() => copy(item.value, toast, t('Скопировано', 'Көшірілді'))}><Copy size={16} /></Button>
                  {item.kind !== 'cell' && me.partner.active && (
                    <Button variant="ghost" size="sm" onClick={() => setTopupItem(item)}>{t('Пополнить', 'Толықтыру')}</Button>
                  )}
                  {me.partner.active && (
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => {
                        if (item.active && !window.confirm(t(
                          `Выключить ${item.value}? Клиент не сможет им пользоваться. Пул не возвращается.`,
                          `${item.value} өшірілсін бе? Клиент оны пайдалана алмайды. Пул қайтарылмайды.`,
                        ))) return;
                        toggle.mutate({ kind: item.kind, id: item.id, active: !item.active }, {
                          onError: (error: Error) => toast(error.message, 'error'),
                        });
                      }}
                    >
                      {item.active ? t('Выключить', 'Өшіру') : t('Включить', 'Қосу')}
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
  const t = useT();
  const labels = useLabels();
  const topup = usePartnerTopup();
  const [amount, setAmount] = useState('100');
  const units = Math.max(0, Math.floor(Number(amount) || 0));
  const cost = costRub(units, me.partner.prices[item.kind]);
  const price = usePrice(me, cost);
  const left = poolLeft(me.partner.pool[item.kind]);
  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title={t(`Пополнить ${item.value}`, `${item.value} толықтыру`)}
      description={item.note || labels[item.kind].short}
    >
      <div className="stack">
        <Field
          label={item.kind === 'sticker' ? t('Добавить генераций', 'Генерация қосу') : t('Добавить итераций', 'Итерация қосу')}
          help={t(`В пуле: ${left}`, `Пулда: ${left}`)}
        >
          <Input type="number" min={1} value={amount} onChange={e => setAmount(e.target.value)} />
        </Field>
        <MoneyBox me={me} cost={cost} price={price} t={t} />
        <Button
          loading={topup.isPending}
          disabled={units < 1 || units > left}
          onClick={() => topup.mutate({ kind: item.kind, id: item.id, amount: units, priceKzt: price.priceKzt }, {
            onSuccess: result => { onClose(); onDone({ item: { ...item, ...result.item }, entry: result.entry }); },
            onError: (error: Error) => toast(error.message, 'error'),
          })}
        >
          {t('Пополнить', 'Толықтыру')}
        </Button>
      </div>
    </Modal>
  );
}

function LedgerTab() {
  const t = useT();
  const labels = useLabels();
  const ledger = usePartnerLedger();
  const kindLabel = { grant: t('Пул от владельца', 'Иесінен пул'), issue: t('Выпуск', 'Шығару'), topup: t('Пополнение', 'Толықтыру') };
  if (ledger.isPending) return <CabinetLoading />;
  if (ledger.isError) return <CabinetError error={ledger.error} retry={() => ledger.refetch()} />;
  if (!ledger.data.length) {
    return <Card><EmptyState title={t('Пока пусто', 'Әзірге бос')} text={t('Здесь появятся пополнения пула и выпуски.', 'Пулды толықтыру мен шығарылымдар осында пайда болады.')} /></Card>;
  }
  return (
    <Table>
      <thead>
        <tr>
          <th>{t('Дата', 'Күні')}</th><th>{t('Операция', 'Операция')}</th><th>{t('Количество', 'Саны')}</th>
          <th>{t('Код / ключ', 'Код / кілт')}</th><th>{t('Долг, ₽', 'Қарыз, ₽')}</th><th>{t('Клиенту, ₸', 'Клиентке, ₸')}</th>
        </tr>
      </thead>
      <tbody>
        {ledger.data.map(entry => (
          <tr key={entry.id}>
            <td>{dateTime(entry.createdAt)}</td>
            <td>{kindLabel[entry.kind]}</td>
            <td>{entry.delta > 0 ? `+${entry.delta}` : entry.delta} {labels[entry.resource].unit}</td>
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
  const t = useT();
  const payments = usePartnerPayments();
  if (payments.isPending) return <CabinetLoading />;
  if (payments.isError) return <CabinetError error={payments.error} retry={() => payments.refetch()} />;
  if (!payments.data.length) {
    return <Card><EmptyState title={t('Оплат пока нет', 'Әзірге төлемдер жоқ')} text={t('Оплаты, которые отметит владелец, появятся здесь.', 'Иесі белгілеген төлемдер осында пайда болады.')} /></Card>;
  }
  return (
    <Table>
      <thead><tr><th>{t('Дата', 'Күні')}</th><th>{t('Сумма', 'Сомасы')}</th><th>{t('Комментарий', 'Түсініктеме')}</th></tr></thead>
      <tbody>
        {payments.data.map(p => (
          <tr key={p.id}><td>{dateTime(p.createdAt)}</td><td>{formatRub(p.amountRub)}</td><td>{p.note || '—'}</td></tr>
        ))}
      </tbody>
    </Table>
  );
}
