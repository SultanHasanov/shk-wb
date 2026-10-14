import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Copy, HandCoins, MessageSquareText, Wallet, WalletCards } from 'lucide-react';
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
  Accordion, Alert, Badge, Button, Card, EmptyState, Field, Hint, Input, Modal, Progress, Segmented, Select,
  Stat, Table, Tabs, useToast,
} from '../../ui';
import c from './cabinet.module.css';
import p from './partner.module.css';

const RESOURCES: PartnerResource[] = ['sticker', 'program', 'cell'];
const SCOPES = [
  { value: 'wb', label: 'Wildberries' },
  { value: 'ozon', label: 'Ozon' },
  { value: 'both', label: 'WB + Ozon' },
] as const;
const QUICK_AMOUNTS = [100, 500, 1000];
const HOW_KEY = 'partner-how-collapsed';

function copy(text: string, toast: ReturnType<typeof useToast>, done: string) {
  void navigator.clipboard?.writeText(text);
  toast(done, 'success');
}

function useLabels() {
  return resourceLabels(useLocale());
}

const parseNumber = (value: string) => (value.trim() === '' ? null : Number(value.replace(',', '.')));

/**
 * Панель партнёра. Партнёр выпускает коды и ключи из пула, выданного владельцем,
 * и сразу видит обе суммы: сколько это стоит в рублях (его долг владельцу) и за
 * сколько в тенге он продаёт клиенту (со своей наценкой). Схема работы и подсказки
 * у каждого числа — прямо на странице, чтобы не объяснять её отдельно.
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
  const profitKzt = balance.revenueKzt - balance.issuedRub * kztPerRub;

  return (
    <div className="page stack-lg">
      <header className="page-head">
        <h1>{partner.name}</h1>
        <p>{t('Кабинет партнёра: выпускайте коды и ключи для своих клиентов и следите за расчётами.', 'Серіктес кабинеті: клиенттеріңізге кодтар мен кілттер шығарып, есеп айырысуды бақылаңыз.')}</p>
      </header>

      {!partner.active && (
        <Alert tone="warning">
          {t(
            'Партнёрский доступ приостановлен. Выданные коды работают, но выпускать новые нельзя.',
            'Серіктестік қолжетімділік тоқтатылды. Берілген кодтар жұмыс істейді, бірақ жаңаларын шығаруға болмайды.',
          )}
        </Alert>
      )}

      <HowItWorks kztPerRub={kztPerRub} />

      <div className="stack">
        <div className="grid grid-3">
          <Card>
            <Stat
              value={formatRub(balance.dueRub)}
              label={t('к оплате владельцу', 'иесіне төлеуге')}
              icon={<Wallet size={20} />}
              hint={t(
                'Стоимость всех выпусков по вашей оптовой цене минус то, что вы уже оплатили. Переведите эту сумму владельцу — он отметит оплату, и долг уменьшится.',
                'Барлық шығарылымдардың көтерме бағаңыз бойынша құны, төлегеніңізді шегергенде. Осы соманы иесіне аударыңыз — ол төлемді белгілейді, қарыз азаяды.',
              )}
            />
          </Card>
          <Card>
            <Stat
              value={formatRub(balance.paidRub)}
              label={t('уже оплачено', 'төленіп қойған')}
              icon={<WalletCards size={20} />}
              hint={t(
                'Оплаты, которые отметил владелец. Список — во вкладке «Оплаты владельцу» ниже.',
                'Иесі белгілеген төлемдер. Тізімі — төмендегі «Иесіне төлемдер» қойындысында.',
              )}
            />
          </Card>
          <Card>
            <Stat
              value={formatKzt(balance.revenueKzt)}
              label={t('выставлено клиентам', 'клиенттерге қойылды')}
              icon={<HandCoins size={20} />}
              hint={t(
                'Сумма цен клиентам по всем выпускам. Сервис не принимает эти деньги — вы получаете их от клиента сами.',
                'Барлық шығарылымдар бойынша клиенттерге бағалардың сомасы. Сервис бұл ақшаны қабылдамайды — оны клиенттен өзіңіз аласыз.',
              )}
            />
          </Card>
        </div>
        <p className={p.summaryLine}>
          {t('Ваша прибыль за всё время', 'Барлық уақыттағы пайдаңыз')}: <strong>≈ {formatKzt(profitKzt)}</strong>
          {' '}<Hint>{t(
            'Выставлено клиентам минус выпуски по оптовой цене, переведённые в тенге по текущему курсу. Примерно — курс мог меняться.',
            'Клиенттерге қойылғаны минус көтерме бағадағы шығарылымдар, ағымдағы бағам бойынша теңгеге аударылған. Шамамен — бағам өзгеруі мүмкін.',
          )}</Hint>
        </p>
      </div>

      <section className="stack">
        <h2 className={p.cardTitle}>
          {t('Ваш пул', 'Сіздің пулыңыз')}
          <Hint>{t(
            'Пул — запас, который выдал вам владелец. Каждый выпуск списывает из него объём, а к долгу добавляется оптовая цена. Платите вы только за выпущенное.',
            'Пул — иесі сізге берген қор. Әр шығарылым одан көлемді жұмсайды, ал қарызға көтерме баға қосылады. Тек шығарылғаны үшін төлейсіз.',
          )}</Hint>
        </h2>
        <div className="grid grid-3">
          {RESOURCES.map(resource => {
            const pool = partner.pool[resource];
            const left = poolLeft(pool);
            return (
              <Card key={resource}>
                <h3 className={p.cardTitle}>{labels[resource].title}<Hint>{labels[resource].about}</Hint></h3>
                {pool.granted === 0 ? (
                  <p className={p.poolEmpty}>
                    {t(
                      'Пул пока не выдан. Если клиенты просят этот ключ, попросите владельца выдать пул.',
                      'Пул әлі берілмеген. Клиенттер бұл кілтті сұраса, иесінен пул беруді сұраңыз.',
                    )}
                  </p>
                ) : (
                  <Progress
                    value={pool.used}
                    max={pool.granted}
                    label={
                      <span>
                        {t('Осталось', 'Қалды')} <strong>{left}</strong> {t(`из ${pool.granted}`, `/ ${pool.granted}`)} {labels[resource].unit}
                      </span>
                    }
                  />
                )}
                <p className={p.poolMeta}>
                  {t(
                    `Оптовая цена: ${formatRub(partner.prices[resource])} за ${labels[resource].one}`,
                    `Көтерме баға: ${labels[resource].one} — ${formatRub(partner.prices[resource])}`,
                  )}
                  {pool.granted > 0 && left > 0 && left / pool.granted < 0.1 && (
                    <><br />{t('Пул почти закончился — попросите владельца пополнить.', 'Пул таусылуға жақын — иесінен толықтыруды сұраңыз.')}</>
                  )}
                </p>
              </Card>
            );
          })}
        </div>
      </section>

      <IssueCard me={me.data} onIssued={setIssued} />

      <Tabs
        label={t('Выпуски и расчёты', 'Шығарылымдар мен есеп айырысу')}
        items={[
          { value: 'items', label: t('Выпущенные', 'Шығарылғандар'), content: <ItemsTab me={me.data} onIssued={setIssued} /> },
          { value: 'ledger', label: t('История', 'Тарих'), content: <LedgerTab /> },
          { value: 'payments', label: t('Оплаты владельцу', 'Иесіне төлемдер'), content: <PaymentsTab /> },
        ]}
      />

      <Faq kztPerRub={kztPerRub} />

      <IssuedModal result={issued} onClose={() => setIssued(null)} />
    </div>
  );
}

/** Схема работы в четыре шага. Сворачивается; выбор запоминается в браузере. */
function HowItWorks({ kztPerRub }: { kztPerRub: number }) {
  const t = useT();
  const [open] = useState(() => {
    try { return localStorage.getItem(HOW_KEY) !== '1'; } catch { return true; }
  });
  const steps = [
    {
      title: t('Владелец выдаёт пул', 'Иесі пул береді'),
      text: t('Запас генераций, итераций или дней по вашей оптовой цене. Пока вы ничего не выпустили — вы ничего не должны.', 'Көтерме бағаңыз бойынша генерациялар, итерациялар немесе күндер қоры. Ештеңе шығармасаңыз — ештеңе қарыз емессіз.'),
    },
    {
      title: t('Вы выпускаете код', 'Сіз код шығарасыз'),
      text: t('В блоке «Выпустить для клиента» выберите тип и объём. Объём списывается из пула.', '«Клиентке шығару» блогында түрі мен көлемін таңдаңыз. Көлем пулдан жұмсалады.'),
    },
    {
      title: t('Клиент платит вам в ₸', 'Клиент сізге ₸ төлейді'),
      text: t('Цену задаёте вы: себестоимость в тенге плюс ваша наценка — или любая своя цена.', 'Бағаны сіз белгілейсіз: теңгедегі өзіндік құн плюс үстемеңіз — немесе кез келген өз бағаңыз.'),
    },
    {
      title: t('Вы оплачиваете владельцу в ₽', 'Сіз иесіне ₽ төлейсіз'),
      text: t('Сумма копится в «К оплате владельцу». Владелец отмечает оплату — долг обнуляется.', 'Сома «Иесіне төлеуге» жиналады. Иесі төлемді белгілейді — қарыз нөлденеді.'),
    },
  ];
  return (
    <details
      className={p.how}
      open={open}
      onToggle={e => {
        try { localStorage.setItem(HOW_KEY, (e.currentTarget as HTMLDetailsElement).open ? '0' : '1'); } catch { /* приватный режим */ }
      }}
    >
      <summary className={p.howSummary}>
        {t('Как это работает', 'Бұл қалай жұмыс істейді')}
        <ChevronDown size={18} className={p.howChevron} aria-hidden="true" />
      </summary>
      <div className={p.howBody}>
        <ol className={p.flow}>
          {steps.map((step, i) => (
            <li key={step.title} className={p.flowStep}>
              <span className={p.num}>{i + 1}</span>
              <strong>{step.title}</strong>
              {step.text}
            </li>
          ))}
        </ol>
        <p className={p.rate}>
          {t(
            `Курс для пересчёта: 1 ₽ = ${kztPerRub} ₸. Его задаёт владелец; на уже выпущенные коды смена курса не влияет.`,
            `Қайта есептеу бағамы: 1 ₽ = ${kztPerRub} ₸. Оны иесі белгілейді; бағамның өзгеруі шығарылған кодтарға әсер етпейді.`,
          )}
        </p>
      </div>
    </details>
  );
}

/**
 * Цена клиенту: по наценке (её можно поменять прямо здесь) или своя.
 * priceKzt уходит на сервер, только когда цена отличается от сохранённой наценки —
 * иначе сервер считает её сам, как и раньше.
 */
function usePrice(me: PartnerMe, cost: number) {
  const saved = me.partner.markupPercent;
  const [mode, setMode] = useState<'markup' | 'custom'>('markup');
  const [markup, setMarkup] = useState(String(saved));
  const [custom, setCustom] = useState('');
  useEffect(() => setMarkup(String(saved)), [saved]);

  const markupInput = parseNumber(markup);
  const markupValid = markupInput != null && Number.isFinite(markupInput) && markupInput >= 0 && markupInput <= 10000;
  const markupValue = markupValid ? markupInput : saved;
  const byMarkup = suggestedKzt(cost, me.kztPerRub, markupValue);
  const customInput = parseNumber(custom);
  const customValid = customInput != null && Number.isFinite(customInput) && customInput >= 0;
  const useCustom = mode === 'custom' && customValid;
  const price = useCustom ? customInput : byMarkup;
  const priceKzt = useCustom ? customInput : markupValue !== saved ? byMarkup : null;

  return {
    mode, setMode, markup, setMarkup, markupValid, markupValue, markupChanged: markupValid && markupValue !== saved,
    custom, setCustom, customValid, byMarkup, price, priceKzt,
    reset: () => setCustom(''),
  };
}

type Price = ReturnType<typeof usePrice>;

/** Шаг «Цена клиенту»: способ цены, формула расчёта и три итоговые суммы. */
function PriceStep({ me, cost, unitPrice, units, price, t }: {
  me: PartnerMe; cost: number; unitPrice: number; units: string; price: Price; t: T;
}) {
  const toast = useToast();
  const save = usePartnerMarkup();
  const base = cost * me.kztPerRub;
  const profit = price.price - base;
  return (
    <div className="stack">
      <Segmented
        label={t('Как считать цену', 'Бағаны қалай есептеу')}
        value={price.mode}
        onChange={price.setMode}
        options={[
          { value: 'markup', label: t('По наценке', 'Үстеме бойынша') },
          { value: 'custom', label: t('Своя цена', 'Өз бағам') },
        ]}
      />

      {price.mode === 'markup' ? (
        <div className={p.priceRow}>
          <Field
            label={t('Наценка, %', 'Үстеме, %')}
            hint={t(
              'Сколько процентов добавить к себестоимости. 0% — продаёте по себестоимости, 50% — в полтора раза дороже. Сохраните, чтобы эта наценка подставлялась по умолчанию.',
              'Өзіндік құнға қанша пайыз қосу керек. 0% — өзіндік құнымен сатасыз, 50% — бір жарым есе қымбат. Әдепкі бойынша қойылуы үшін сақтаңыз.',
            )}
            error={price.markupValid ? undefined : t('От 0 до 10000', '0-ден 10000-ға дейін')}
          >
            <Input inputMode="decimal" value={price.markup} onChange={e => price.setMarkup(e.target.value)} />
          </Field>
          {price.markupChanged && (
            <Button
              variant="secondary"
              loading={save.isPending}
              onClick={() => save.mutate({ markupPercent: price.markupValue }, {
                onSuccess: () => toast(t('Наценка сохранена', 'Үстеме сақталды'), 'success'),
                onError: (error: Error) => toast(error.message, 'error'),
              })}
            >
              {t('Сделать наценкой по умолчанию', 'Әдепкі үстеме ету')}
            </Button>
          )}
        </div>
      ) : (
        <Field
          label={t('Цена клиенту, ₸', 'Клиентке баға, ₸')}
          hint={t('Любая сумма, которую вы возьмёте с клиента. Наценка в этом случае не используется.', 'Клиенттен алатын кез келген сома. Бұл жағдайда үстеме қолданылмайды.')}
          help={t(`По наценке было бы ${formatKzt(price.byMarkup)}`, `Үстеме бойынша ${formatKzt(price.byMarkup)} болар еді`)}
        >
          <Input inputMode="decimal" value={price.custom} onChange={e => price.setCustom(e.target.value)} placeholder={String(price.byMarkup)} />
        </Field>
      )}

      <p className={p.formula}>
        <span>{units} × {formatRub(unitPrice)} = <b>{formatRub(cost)}</b></span>
        <span>→ × {me.kztPerRub} ₸/₽ = <b>{formatKzt(base)}</b> {t('себестоимость', 'өзіндік құн')}</span>
        <span>→ {price.mode === 'custom' && price.customValid
          ? t('своя цена', 'өз бағаңыз')
          : `+ ${price.markupValue}%`} = <b>{formatKzt(price.price)}</b> {t('клиенту', 'клиентке')}
        </span>
      </p>

      <div className={`grid grid-3 ${p.totals}`}>
        <Stat
          value={formatRub(cost)}
          label={t('вы должны владельцу', 'иесіне қарызыңыз')}
          hint={t(`${units} по вашей оптовой цене. Добавится к «К оплате владельцу» после выпуска.`, `Көтерме бағаңыз бойынша ${units}. Шығарғаннан кейін «Иесіне төлеуге» қосылады.`)}
        />
        <Stat
          value={formatKzt(price.price)}
          label={t('берёте с клиента', 'клиенттен аласыз')}
          hint={t('Эту сумму вы получаете от клиента сами — сервис её не принимает.', 'Бұл соманы клиенттен өзіңіз аласыз — сервис оны қабылдамайды.')}
        />
        <Stat
          value={formatKzt(profit)}
          label={t('ваша прибыль', 'пайдаңыз')}
          tone={profit < 0 ? 'danger' : profit > 0 ? 'success' : undefined}
          hint={t(`Цена клиенту минус себестоимость ${formatKzt(base)}.`, `Клиентке баға минус өзіндік құн ${formatKzt(base)}.`)}
        />
      </div>

      {profit < 0 && (
        <Alert tone="error">
          {t('Цена ниже себестоимости — вы продаёте в минус.', 'Баға өзіндік құннан төмен — шығынмен сатасыз.')}
        </Alert>
      )}
    </div>
  );
}

function StepTitle({ n, children, hint }: { n: number; children: string; hint?: string }) {
  return (
    <h3 className={p.stepTitle}>
      <span className={p.num}>{n}</span>
      {children}
      {hint && <Hint label={children}>{hint}</Hint>}
    </h3>
  );
}

function AmountChips({ value, left, onPick, t }: { value: string; left: number; onPick: (v: string) => void; t: T }) {
  const options = QUICK_AMOUNTS.filter(a => a <= left);
  if (!left) return null;
  return (
    <div className={p.chips}>
      {options.map(a => (
        <button key={a} type="button" className={p.chip} aria-pressed={value === String(a)} onClick={() => onPick(String(a))}>{a}</button>
      ))}
      {!options.includes(left) && (
        <button type="button" className={p.chip} aria-pressed={value === String(left)} onClick={() => onPick(String(left))}>
          {t(`весь остаток · ${left}`, `бүкіл қалдық · ${left}`)}
        </button>
      )}
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
  const label = labels[kind];

  const blocked = !me.partner.active
    ? t('Партнёрский доступ приостановлен.', 'Серіктестік қолжетімділік тоқтатылды.')
    : left === 0
      ? t('Пул пуст — попросите владельца выдать или пополнить пул.', 'Пул бос — иесінен пул беруді немесе толықтыруды сұраңыз.')
      : units < 1
        ? t('Укажите объём.', 'Көлемді көрсетіңіз.')
        : units > left
          ? t(`В пуле осталось только ${left} ${label.unit} — уменьшите объём или попросите владельца пополнить пул.`, `Пулда тек ${left} ${label.unit} қалды — көлемді азайтыңыз немесе иесінен пулды толықтыруды сұраңыз.`)
          : !price.markupValid && price.mode === 'markup'
            ? t('Исправьте наценку.', 'Үстемені түзетіңіз.')
            : null;

  const submit = () => {
    const priceKzt = price.priceKzt;
    const body = kind === 'cell'
      ? { kind, durationDays: days, deviceLimit: devices, marketplaceScope: scope, note, priceKzt }
      : { kind, amount: units, note, priceKzt };
    issue.mutate(body, {
      onSuccess: result => { onIssued(result); setNote(''); price.reset(); },
      onError: (error: Error) => toast(error.message, 'error'),
    });
  };

  const unitsText = kind === 'cell'
    ? t(`${days} дн. × ${devices} ПК = ${units} ${label.unit}`, `${days} күн × ${devices} ДК = ${units} ${label.unit}`)
    : `${units} ${label.unit}`;

  return (
    <Card accent>
      <div className={p.issueHead}>
        <h2>{t('Выпустить для клиента', 'Клиентке шығару')}</h2>
        <p>{t('Три шага: что выпустить, сколько и за какую цену. Код появится сразу — останется отправить его клиенту.', 'Үш қадам: не шығару, қанша және қандай бағаға. Код бірден пайда болады — оны клиентке жіберу ғана қалады.')}</p>
      </div>
      <div className="stack-lg">
        <div className={p.step}>
          <StepTitle n={1}>{t('Что выпустить', 'Не шығару')}</StepTitle>
          <Segmented
            label={t('Что выпустить', 'Не шығару')}
            value={kind}
            onChange={setKind}
            options={RESOURCES.map(r => ({ value: r, label: labels[r].short }))}
          />
          <p className={p.about}>
            {label.about}{' '}
            <strong>{t(`В пуле: ${left} ${label.unit}.`, `Пулда: ${left} ${label.unit}.`)}</strong>
          </p>
        </div>

        <div className={p.step}>
          <StepTitle n={2}>{t('Объём и клиент', 'Көлем және клиент')}</StepTitle>
          <div className="grid grid-3">
            {kind === 'cell' ? (
              <>
                <Field label={t('Срок, дней', 'Мерзімі, күн')} hint={t('Отсчёт начинается, когда клиент впервые активирует ключ, а не в момент выпуска.', 'Есеп клиент кілтті алғаш белсендірген кезден басталады, шығарған сәттен емес.')}>
                  <Select value={days} onChange={e => setDays(Number(e.target.value))}>
                    {CELL_DURATIONS.map(d => <option key={d} value={d}>{d}</option>)}
                  </Select>
                </Field>
                <Field label={t('Компьютеров', 'Компьютерлер')} hint={t('На скольких компьютерах клиент сможет одновременно пользоваться ключом. Из пула списывается срок × компьютеры.', 'Клиент кілтті қанша компьютерде бір мезгілде пайдалана алады. Пулдан мерзім × компьютерлер жұмсалады.')}>
                  <Select value={devices} onChange={e => setDevices(Number(e.target.value))}>
                    {CELL_DEVICE_LIMITS.map(d => <option key={d} value={d}>{d}</option>)}
                  </Select>
                </Field>
                <Field label={t('Маркетплейс', 'Маркетплейс')} hint={t('Для какого маркетплейса клиент печатает ячейки. На цену не влияет.', 'Клиент қай маркетплейс үшін ұяшықтарды басып шығарады. Бағаға әсер етпейді.')}>
                  <Select value={scope} onChange={e => setScope(e.target.value)}>
                    {SCOPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                </Field>
              </>
            ) : (
              <div className="stack">
                <Field
                  label={kind === 'sticker' ? t('Генераций в коде', 'Кодтағы генерациялар') : t('Итераций в ключе', 'Кілттегі итерациялар')}
                  hint={t('Сколько единиц получит клиент. Потом код можно пополнить во вкладке «Выпущенные» — клиенту ничего менять не придётся.', 'Клиент қанша бірлік алады. Кейін кодты «Шығарылғандар» қойындысында толықтыруға болады — клиентке ештеңе өзгертудің қажеті жоқ.')}
                >
                  <Input type="number" min={1} max={100000} value={amount} onChange={e => setAmount(e.target.value)} />
                </Field>
                <AmountChips value={amount} left={left} onPick={setAmount} t={t} />
              </div>
            )}
            <Field
              label={t('Для кого', 'Кімге')}
              hint={t('Заметка только для вас — клиент её не увидит. По ней удобно искать код в списке выпущенных.', 'Тек сізге арналған белгі — клиент оны көрмейді. Ол арқылы шығарылғандар тізімінен кодты іздеу ыңғайлы.')}
            >
              <Input value={note} onChange={e => setNote(e.target.value)} maxLength={120} placeholder={t('Имя или телефон клиента', 'Клиенттің аты немесе телефоны')} />
            </Field>
          </div>
        </div>

        <div className={p.step}>
          <StepTitle n={3}>{t('Цена клиенту', 'Клиентке баға')}</StepTitle>
          <PriceStep me={me} cost={cost} unitPrice={me.partner.prices[kind]} units={`${units} ${label.unit}`} price={price} t={t} />
          {kind === 'cell' && <p className={p.about}>{unitsText}</p>}
        </div>

        <div className={p.foot}>
          <Button size="lg" loading={issue.isPending} disabled={blocked != null} onClick={submit}>
            {t(`Выпустить за ${formatKzt(price.price)}`, `${formatKzt(price.price)} бағасына шығару`)}
          </Button>
          <p className={p.footNote}>
            {blocked ?? t(
              `После выпуска ${formatRub(cost)} добавится к долгу владельцу, из пула спишется ${units} ${label.unit}.`,
              `Шығарғаннан кейін иесіне қарызға ${formatRub(cost)} қосылады, пулдан ${units} ${label.unit} жұмсалады.`,
            )}
          </p>
        </div>
      </div>
    </Card>
  );
}

function IssuedModal({ result, onClose }: { result: PartnerIssueResult | null; onClose: () => void }) {
  const toast = useToast();
  const t = useT();
  const locale = useLocale();
  const labels = useLabels();
  if (!result) return null;
  const { item, entry } = result;
  const message = clientMessage(item, locale);
  return (
    <Modal open onOpenChange={open => !open && onClose()} title={t('Готово!', 'Дайын!')} description={t('Код создан и уже работает. Осталось передать его клиенту.', 'Код жасалды және жұмыс істеп тұр. Оны клиентке беру ғана қалды.')}>
      <div className="stack">
        <div className={c.code}>
          <span className={c.codeLabel}>{labels[item.kind].short}</span>
          <span className={c.codeValue}>{item.value}</span>
        </div>
        {entry && (
          <div className="grid grid-2">
            <Stat value={formatKzt(entry.priceKzt ?? 0)} label={t('получить с клиента', 'клиенттен алу')} />
            <Stat value={formatRub(entry.costRub ?? 0)} label={t('добавлено к долгу владельцу', 'иесіне қарызға қосылды')} />
          </div>
        )}
        <ol className={p.next}>
          <li><span className={p.num}>1</span>{t('Скопируйте готовое сообщение и отправьте клиенту в мессенджер — в нём код и инструкция.', 'Дайын хабарламаны көшіріп, клиентке мессенджерге жіберіңіз — онда код пен нұсқаулық бар.')}</li>
          <li><span className={p.num}>2</span>{t(`Получите с клиента ${formatKzt(entry?.priceKzt ?? 0)}.`, `Клиенттен ${formatKzt(entry?.priceKzt ?? 0)} алыңыз.`)}</li>
          <li><span className={p.num}>3</span>{t('Код появится во вкладке «Выпущенные» — там его можно пополнить или выключить.', 'Код «Шығарылғандар» қойындысында пайда болады — онда оны толықтыруға немесе өшіруге болады.')}</li>
        </ol>
        <pre className={p.message}>{message}</pre>
        <div className="row">
          <Button onClick={() => copy(message, toast, t('Сообщение скопировано', 'Хабарлама көшірілді'))}>
            <MessageSquareText size={16} />{t('Скопировать сообщение', 'Хабарламаны көшіру')}
          </Button>
          <Button variant="secondary" onClick={() => copy(item.value, toast, t('Код скопирован', 'Код көшірілді'))}>
            <Copy size={16} />{t('Только код', 'Тек код')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ThHint({ children, hint }: { children: string; hint: string }) {
  return <span className={p.thHint}>{children}<Hint label={children}>{hint}</Hint></span>;
}

function ItemsTab({ me, onIssued }: { me: PartnerMe; onIssued: (r: PartnerIssueResult) => void }) {
  const toast = useToast();
  const t = useT();
  const locale = useLocale();
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
    return <Card><EmptyState title={t('Пока ничего не выпущено', 'Әзірге ештеңе шығарылмаған')} text={t('Выпустите первый код в блоке «Выпустить для клиента» выше.', 'Алғашқы кодты жоғарыдағы «Клиентке шығару» блогында шығарыңыз.')} /></Card>;
  }

  return (
    <div className="stack">
      <Field label={t('Поиск по коду или клиенту', 'Код немесе клиент бойынша іздеу')}><Input value={q} onChange={e => setQ(e.target.value)} /></Field>
      <Table>
        <thead>
          <tr>
            <th>{t('Код / ключ', 'Код / кілт')}</th><th>{t('Для кого', 'Кімге')}</th>
            <th>
              <ThHint hint={t('Сколько клиент уже потратил. Неистраченное остаётся у клиента — в пул не возвращается.', 'Клиент қанша жұмсады. Жұмсалмағаны клиентте қалады — пулға қайтарылмайды.')}>
                {t('Объём', 'Көлемі')}
              </ThHint>
            </th>
            <th>{t('Создан', 'Жасалды')}</th><th>{t('Статус', 'Мәртебесі')}</th>
            <th>
              <ThHint hint={t('«Пополнить» добавляет объём в тот же код — клиенту ничего менять не нужно. «Выключить» — код перестаёт работать, пул не возвращается. Включить обратно можно в любой момент.', '«Толықтыру» сол кодқа көлем қосады — клиентке ештеңе өзгертудің қажеті жоқ. «Өшіру» — код жұмысын тоқтатады, пул қайтарылмайды. Кез келген уақытта қайта қосуға болады.')}>
                {t('Действия', 'Әрекеттер')}
              </ThHint>
            </th>
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
              <td className={p.volume}>
                {item.kind === 'cell'
                  ? t(
                    `${item.durationDays} дн. × ${item.deviceLimit} ПК${item.expiresAt ? `, до ${dateTime(item.expiresAt)}` : ', ещё не активирован'}`,
                    `${item.durationDays} күн × ${item.deviceLimit} ДК${item.expiresAt ? `, ${dateTime(item.expiresAt)} дейін` : ', әлі белсендірілмеген'}`,
                  )
                  : (
                    <Progress
                      value={item.used ?? 0}
                      max={item.limit ?? 0}
                      label={t(`потрачено ${item.used} из ${item.limit}`, `${item.limit} ішінен ${item.used} жұмсалды`)}
                    />
                  )}
              </td>
              <td>{dateTime(item.createdAt)}</td>
              <td><Badge tone={item.active ? 'success' : 'error'}>{item.active ? t('Активен', 'Белсенді') : t('Выключен', 'Өшірілген')}</Badge></td>
              <td>
                <div className={c.rowActions}>
                  <Button variant="ghost" size="sm" aria-label={t('Скопировать сообщение клиенту', 'Клиентке хабарламаны көшіру')} onClick={() => copy(clientMessage(item, locale), toast, t('Сообщение для клиента скопировано', 'Клиентке хабарлама көшірілді'))}><Copy size={16} /></Button>
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
  const unitsText = `${units} ${labels[item.kind].unit}`;
  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title={t(`Пополнить ${item.value}`, `${item.value} толықтыру`)}
      description={t(
        `${item.note ? `${item.note} · ` : ''}Объём добавится в этот же код — клиенту ничего менять не нужно.`,
        `${item.note ? `${item.note} · ` : ''}Көлем осы кодқа қосылады — клиентке ештеңе өзгертудің қажеті жоқ.`,
      )}
    >
      <div className="stack">
        <Field
          label={item.kind === 'sticker' ? t('Добавить генераций', 'Генерация қосу') : t('Добавить итераций', 'Итерация қосу')}
          help={t(`В пуле: ${left} ${labels[item.kind].unit}`, `Пулда: ${left} ${labels[item.kind].unit}`)}
        >
          <Input type="number" min={1} value={amount} onChange={e => setAmount(e.target.value)} />
        </Field>
        <AmountChips value={amount} left={left} onPick={setAmount} t={t} />
        <PriceStep me={me} cost={cost} unitPrice={me.partner.prices[item.kind]} units={unitsText} price={price} t={t} />
        <Button
          loading={topup.isPending}
          disabled={units < 1 || units > left || (price.mode === 'markup' && !price.markupValid)}
          onClick={() => topup.mutate({ kind: item.kind, id: item.id, amount: units, priceKzt: price.priceKzt }, {
            onSuccess: result => { onClose(); onDone({ item: { ...item, ...result.item }, entry: result.entry }); },
            onError: (error: Error) => toast(error.message, 'error'),
          })}
        >
          {t(`Пополнить за ${formatKzt(price.price)}`, `${formatKzt(price.price)} бағасына толықтыру`)}
        </Button>
      </div>
    </Modal>
  );
}

function LedgerTab() {
  const t = useT();
  const labels = useLabels();
  const ledger = usePartnerLedger();
  const kindLabel = { grant: t('Пул от владельца', 'Иесінен пул'), issue: t('Выпуск', 'Шығару'), topup: t('Пополнение кода', 'Кодты толықтыру') };
  if (ledger.isPending) return <CabinetLoading />;
  if (ledger.isError) return <CabinetError error={ledger.error} retry={() => ledger.refetch()} />;
  if (!ledger.data.length) {
    return <Card><EmptyState title={t('Пока пусто', 'Әзірге бос')} text={t('Здесь появятся пулы от владельца, выпуски и пополнения кодов.', 'Мұнда иесінен пулдар, шығарылымдар және кодтарды толықтыру пайда болады.')} /></Card>;
  }
  return (
    <Table>
      <thead>
        <tr>
          <th>{t('Дата', 'Күні')}</th>
          <th>
            <ThHint hint={t('«Пул от владельца» — вам добавили запас, это бесплатно. «Выпуск» и «Пополнение кода» — списание из пула, к долгу добавляется оптовая цена.', '«Иесінен пул» — сізге қор қосылды, бұл тегін. «Шығару» мен «Кодты толықтыру» — пулдан жұмсау, қарызға көтерме баға қосылады.')}>
              {t('Операция', 'Операция')}
            </ThHint>
          </th>
          <th>{t('Количество', 'Саны')}</th>
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
            <td>{entry.costRub == null ? <span className="muted">{entry.kind === 'grant' ? t('бесплатно', 'тегін') : '—'}</span> : formatRub(entry.costRub)}</td>
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
    return (
      <Card>
        <EmptyState
          title={t('Оплат пока нет', 'Әзірге төлемдер жоқ')}
          text={t(
            'Переведите сумму «К оплате владельцу» владельцу сервиса удобным для вас способом. Он отметит оплату — она появится здесь, а долг уменьшится.',
            '«Иесіне төлеуге» сомасын сервис иесіне ыңғайлы тәсілмен аударыңыз. Ол төлемді белгілейді — төлем осында пайда болады, қарыз азаяды.',
          )}
        />
      </Card>
    );
  }
  return (
    <Table>
      <thead><tr><th>{t('Дата', 'Күні')}</th><th>{t('Сумма', 'Сомасы')}</th><th>{t('Комментарий', 'Түсініктеме')}</th></tr></thead>
      <tbody>
        {payments.data.map(pay => (
          <tr key={pay.id}><td>{dateTime(pay.createdAt)}</td><td>{formatRub(pay.amountRub)}</td><td>{pay.note || '—'}</td></tr>
        ))}
      </tbody>
    </Table>
  );
}

function Faq({ kztPerRub }: { kztPerRub: number }) {
  const t = useT();
  const items = [
    {
      q: t('За что я плачу владельцу?', 'Иесіне не үшін төлеймін?'),
      a: t('Только за выпущенное: объём каждого кода или ключа по вашей оптовой цене. Выданный, но не потраченный пул ничего не стоит.', 'Тек шығарылғаны үшін: әр код немесе кілт көлемі көтерме бағаңыз бойынша. Берілген, бірақ жұмсалмаған пул ештеңе тұрмайды.'),
    },
    {
      q: t('Чем «По наценке» отличается от «Своей цены»?', '«Үстеме бойынша» мен «Өз бағам» айырмашылығы неде?'),
      a: t(`По наценке цена считается сама: себестоимость в рублях × ${kztPerRub} ₸ + ваш процент. «Своя цена» — любая сумма в тенге, например круглая. На долг владельцу это не влияет.`, `Үстеме бойынша баға өзі есептеледі: рубльдегі өзіндік құн × ${kztPerRub} ₸ + сіздің пайызыңыз. «Өз бағам» — теңгедегі кез келген сома, мысалы, дөңгелек. Иесіне қарызға әсер етпейді.`),
    },
    {
      q: t('Клиент не потратил весь код. Вернётся ли остаток в пул?', 'Клиент кодты толық жұмсамады. Қалдық пулға қайта ма?'),
      a: t('Нет. Остаток остаётся у клиента в этом коде, и выключение кода тоже не возвращает пул.', 'Жоқ. Қалдық осы кодта клиентте қалады, кодты өшіру де пулды қайтармайды.'),
    },
    {
      q: t('У клиента закончились генерации. Нужен новый код?', 'Клиенттің генерациялары таусылды. Жаңа код керек пе?'),
      a: t('Не обязательно: во вкладке «Выпущенные» нажмите «Пополнить» — объём добавится в тот же код, клиент продолжит работать без изменений.', 'Міндетті емес: «Шығарылғандар» қойындысында «Толықтыру» басыңыз — көлем сол кодқа қосылады, клиент өзгеріссіз жұмысын жалғастырады.'),
    },
    {
      q: t('Что видит клиент?', 'Клиент не көреді?'),
      a: t('Только код и свой остаток. Ваши цены, наценку, заметку «Для кого» и долг владельцу клиент не видит.', 'Тек код пен өз қалдығын. Сіздің бағаларыңызды, үстемеңізді, «Кімге» белгісін және иесіне қарызды клиент көрмейді.'),
    },
    {
      q: t('Пул закончился. Что делать?', 'Пул таусылды. Не істеу керек?'),
      a: t('Напишите владельцу сервиса — он пополнит пул, и остаток сразу обновится на этой странице.', 'Сервис иесіне жазыңыз — ол пулды толықтырады, қалдық осы бетте бірден жаңарады.'),
    },
  ];
  return (
    <section className="stack">
      <h2>{t('Частые вопросы', 'Жиі қойылатын сұрақтар')}</h2>
      <Accordion items={items} />
    </section>
  );
}
