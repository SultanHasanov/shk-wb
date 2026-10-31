import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Minus } from 'lucide-react';
import { Hero } from '../components/Hero';
import { Section } from '../components/Section';
import { Alert, Badge, Button, Card, Skeleton, Table } from '../ui';
import { type AppPlan, useAppPlans } from '../api/app';
import { ANALOG_LABEL_PRICE, getCellPrintPrice } from '../lib/pricing';
import { useMoney } from '../lib/currency';
import { useDocumentMeta } from '../lib/seo';
import { type T, useLocalePath, useT } from '../i18n';
import s from './landing.module.css';
import c from './ComparePage.module.css';

/** Сроки, за которые у аналога есть цена (на 12 месяцев он не продаёт). */
const COMPARE_TERMS = [1, 3, 6] as const;

/** Объёмы для расчёта «Печати ячеек»: приёмок в день у небольшого, среднего и крупного пункта. */
const DAILY_LABELS = [300, 600, 1000] as const;
const TYPICAL_DAILY = 600;

/**
 * Строки сравнения функций. Наши колонки — из features тарифа с сервера, колонка аналога —
 * по описанию его тарифов (null = в описании нет).
 */
const featureRows = (t: T): ReadonlyArray<{ id: string; title: string; analog: string | null }> => [
  {
    id: 'cells',
    title: t('Ячейки и карточка клиента', 'Ұяшықтар және клиент картасы'),
    analog: t('есть', 'бар'),
  },
  {
    id: 'goods',
    title: t('Товар по ШК: история статусов', 'ШК бойынша тауар: мәртебелер тарихы'),
    analog: t('есть', 'бар'),
  },
  {
    id: 'search',
    title: t('Поиск клиента по SID и телефону', 'Клиентті SID және телефон бойынша іздеу'),
    analog: t('поиск товаров клиента', 'клиент тауарларын іздеу'),
  },
  {
    id: 'notes',
    title: t('Заметки о клиентах', 'Клиенттер туралы жазбалар'),
    analog: t('есть', 'бар'),
  },
  { id: 'way', title: t('Товары «В пути»', '«Жолдағы» тауарлар'), analog: null },
  {
    id: 'boxes',
    title: t('Коробки возвратов на склад', 'Қоймаға қайтару қораптары'),
    analog: null,
  },
  {
    id: 'tryon',
    title: t('Окно примерки поверх всех окон', 'Барлық терезелердің үстіндегі өлшеу терезесі'),
    analog: null,
  },
  {
    id: 'code',
    title: t('Код клиента: QR и копирование', 'Клиент коды: QR және көшіру'),
    analog: t('10 в месяц, в расширенном', 'айына 10, кеңейтілгенде'),
  },
  {
    id: 'stickers',
    title: t('Стикеры по ШК', 'ШК бойынша стикерлер'),
    analog: t('50 QR в месяц, в расширенном', 'айына 50 QR, кеңейтілгенде'),
  },
  {
    id: 'expensive',
    title: t('Дорогие товары на контроле', 'Қымбат тауарлар бақылауда'),
    analog: null,
  },
  { id: 'reviews', title: t('Отзывы WB с авторами', 'Авторлары бар WB пікірлері'), analog: null },
  { id: 'telegram', title: t('Уведомления в Telegram', 'Telegram хабарламалары'), analog: null },
  {
    id: 'dossier',
    title: t('Досье клиента: отказы и возвраты', 'Клиент досьесі: бас тарту және қайтару'),
    analog: null,
  },
  {
    id: 'risky',
    title: t(
      'Предупреждение о клиентах с частыми отказами',
      'Жиі бас тартатын клиенттер туралы ескерту',
    ),
    analog: null,
  },
  {
    id: 'staff',
    title: t(
      'Сотрудники: график, зарплата, удержания WB',
      'Қызметкерлер: кесте, жалақы, WB ұстаулары',
    ),
    analog: null,
  },
];

function monthsWord(n: number, t: T) {
  if (n === 1) return t('1 месяц', '1 ай');
  if (n < 5) return t(`${n} месяца`, `${n} ай`);
  return t(`${n} месяцев`, `${n} ай`);
}

const savePercent = (ours: number, theirs: number) => Math.round((1 - ours / theirs) * 100);

function Yes({ label }: { label?: string }) {
  return (
    <span className={c.mark}>
      <Check size={16} color="var(--accent)" aria-hidden="true" />
      {label}
    </span>
  );
}

function No() {
  const t = useT();
  return <Minus size={16} color="var(--text-tertiary)" aria-label={t('нет', 'жоқ')} />;
}

/** Цена за срок: наш тариф против аналога. */
function PlanPrices({ plans }: { plans: AppPlan[] }) {
  const t = useT();
  const { formatTotal } = useMoney();
  return (
    <>
      <Table className={c.cmp}>
        <thead>
          <tr>
            <th scope="col">{t('Срок', 'Мерзім')}</th>
            {plans.map(plan => (
              <th key={plan.id} scope="col">
                {plan.title} {t('и аналог', 'және аналог')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARE_TERMS.map(months => (
            <tr key={months}>
              <th scope="row" className={c.rowHead}>
                {monthsWord(months, t)}
              </th>
              {plans.map(plan => {
                const ours = plan.prices[String(months)];
                const theirs = plan.comparePrices?.[String(months)];
                return (
                  <td key={plan.id}>
                    <strong>{formatTotal(ours)}</strong>
                    {theirs ? (
                      <>
                        {' '}
                        <s className="muted">{formatTotal(theirs)}</s>{' '}
                        <Badge tone="success">−{savePercent(ours, theirs)}%</Badge>
                      </>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Table>
      <p className={c.note}>
        {t(
          'Цена за весь срок. На 12 месяцев аналог подписку не продаёт.',
          'Бүкіл мерзімге баға. Аналог 12 айға жазылым сатпайды.',
        )}
      </p>
    </>
  );
}

/** Что входит в тариф: наши тарифы по features с сервера, аналог — по описанию. */
function PlanFeatures({ plans }: { plans: AppPlan[] }) {
  const t = useT();
  const limit = (plan: AppPlan, id: string) =>
    id === 'code' && plan.codes > 0
      ? t(`${plan.codes} в месяц`, `айына ${plan.codes}`)
      : id === 'stickers' && plan.stickers > 0
        ? t(`${plan.stickers} в месяц`, `айына ${plan.stickers}`)
        : undefined;
  return (
    <Table className={c.cmp}>
      <thead>
        <tr>
          <th scope="col">{t('Возможность', 'Мүмкіндік')}</th>
          {plans.map(plan => (
            <th key={plan.id} scope="col">
              {plan.title}
            </th>
          ))}
          <th scope="col">{t('Аналог', 'Аналог')}</th>
        </tr>
      </thead>
      <tbody>
        {featureRows(t).map(row => (
          <tr key={row.id}>
            <th scope="row" className={c.rowHead}>
              {row.title}
            </th>
            {plans.map(plan => (
              <td key={plan.id}>
                {plan.features.includes(row.id) ? <Yes label={limit(plan, row.id)} /> : <No />}
              </td>
            ))}
            <td>{row.analog ? <span className="muted">{row.analog}</span> : <No />}</td>
          </tr>
        ))}
        <tr>
          <th scope="row" className={c.rowHead}>
            {t('Компьютеры и пункты', 'Компьютерлер мен пункттер')}
          </th>
          {plans.map(plan => (
            <td key={plan.id}>
              {t(
                `${plan.devices} ПК, ${plan.points ?? 1} ${(plan.points ?? 1) === 1 ? 'пункт' : 'пункта'}`,
                `${plan.devices} ДК, ${plan.points ?? 1} пункт`,
              )}
            </td>
          ))}
          <td>
            <No />
          </td>
        </tr>
      </tbody>
    </Table>
  );
}

/** Печать ячеек: фиксированная цена за ПК против оплаты за каждую этикетку. */
function CellPrintCalc() {
  const t = useT();
  const { formatTotal } = useMoney();
  const ours = getCellPrintPrice(30, 1);
  return (
    <>
      <Table className={c.cmp}>
        <thead>
          <tr>
            <th scope="col">{t('Приёмок в день', 'Күніне қабылдау')}</th>
            <th scope="col">{t('Этикеток в месяц', 'Айына жапсырма')}</th>
            <th scope="col">{t('Аналог', 'Аналог')}</th>
            <th scope="col">{t('Печать ячеек', 'Ұяшық басып шығару')}</th>
          </tr>
        </thead>
        <tbody>
          {DAILY_LABELS.map(daily => {
            const labels = daily * 30;
            const theirs = Math.round(labels * ANALOG_LABEL_PRICE);
            return (
              <tr key={daily}>
                <th scope="row" className={c.rowHead}>
                  {daily.toLocaleString('ru-RU')}
                </th>
                <td>{labels.toLocaleString('ru-RU')}</td>
                <td>{t(`≈ ${formatTotal(theirs)}`, `≈ ${formatTotal(theirs)}`)}</td>
                <td>
                  <strong>{formatTotal(ours)}</strong>{' '}
                  <Badge tone="success">−{savePercent(ours, theirs)}%</Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <p className={c.note}>
        {t(
          `Один компьютер, 30 дней, одна этикетка на приёмку. У аналога — около ${String(ANALOG_LABEL_PRICE).replace('.', ',')} ₽ за этикетку.`,
          `Бір компьютер, 30 күн, бір қабылдауға бір жапсырма. Аналогта — бір жапсырмаға шамамен ${String(ANALOG_LABEL_PRICE).replace('.', ',')} ₽.`,
        )}
      </p>
    </>
  );
}

/** Обе программы на один пункт в месяц. */
function Bundle({ plans }: { plans: AppPlan[] }) {
  const t = useT();
  const { formatTotal } = useMoney();
  const print = getCellPrintPrice(30, 1);
  const theirsPrint = Math.round(TYPICAL_DAILY * 30 * ANALOG_LABEL_PRICE);
  return (
    <div className="grid grid-2">
      {plans.map(plan => {
        const ours = plan.prices['1'] + print;
        const compare = plan.comparePrices?.['1'];
        if (!compare) return null;
        const theirs = compare + theirsPrint;
        return (
          <Card key={plan.id}>
            <h3 style={{ marginTop: 0 }}>
              {t(`${plan.title} + Печать ячеек`, `${plan.title} + Ұяшық басып шығару`)}
            </h3>
            <div className="metric">{formatTotal(ours)}</div>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              {t('в месяц, у аналогов', 'айына, аналогтарда')} <s>{formatTotal(theirs)}</s>
            </p>
            <p style={{ margin: '12px 0 0' }}>
              {t(
                `Экономия ${formatTotal((theirs - ours) * 12)} в год`,
                `Жылына ${formatTotal((theirs - ours) * 12)} үнем`,
              )}
            </p>
          </Card>
        );
      })}
    </div>
  );
}

export function ComparePage() {
  const t = useT();
  const lp = useLocalePath();
  const plans = useAppPlans();
  useDocumentMeta(
    t(
      'Сравнение с аналогами: программы для ПВЗ на 20% дешевле',
      'Аналогтармен салыстыру: ПВЗ бағдарламалары 20% арзан',
    ),
    t(
      '«Помощник ПВЗ» и «Печать ячеек» против аналогов: цены за каждый срок, функции тарифов и расчёт печати этикеток для пункта выдачи Wildberries.',
      '«ПВЗ көмекшісі» және «Ұяшық басып шығару» аналогтарға қарсы: әр мерзімнің бағасы, тариф мүмкіндіктері және жапсырма басып шығару есебі.',
    ),
  );
  const list = plans.data?.plans ?? [];

  const loading = <Skeleton height={220} />;
  const failed = (
    <Alert tone="error">
      {t(
        'Не удалось загрузить тарифы. Обновите страницу или посмотрите цены на странице «Тарифы».',
        'Тарифтерді жүктеу мүмкін болмады. Бетті жаңартыңыз немесе «Тарифтер» бетінен қараңыз.',
      )}
    </Alert>
  );
  const plansBlock = (node: ReactNode) =>
    plans.isPending ? loading : plans.isError || !list.length ? failed : node;

  return (
    <>
      <Hero
        compact
        eyebrow={t('Сравнение', 'Салыстыру')}
        title={t(
          'На 20% дешевле аналогов — и больше функций',
          'Аналогтардан 20% арзан — және мүмкіндіктер көбірек',
        )}
        copy={t(
          '«Помощник ПВЗ» стоит на 20–25% меньше ближайшего аналога за любой срок, а «Печать ячеек» берёт фиксированную плату за компьютер вместо оплаты за каждую этикетку.',
          '«ПВЗ көмекшісі» кез келген мерзімге жақын аналогтан 20–25% арзан, ал «Ұяшық басып шығару» әр жапсырма үшін емес, компьютерге тұрақты төлем алады.',
        )}
      >
        <div className={s.heroActions}>
          <Link to={lp('/tarify')}>
            <Button size="lg">
              {t('Все тарифы', 'Барлық тарифтер')}
              <ArrowRight size={18} />
            </Button>
          </Link>
          <Link to={lp('/program')}>
            <Button size="lg" variant="secondary">
              {t('Скачать Помощник ПВЗ', 'ПВЗ көмекшісін жүктеу')}
            </Button>
          </Link>
        </div>
      </Hero>

      <Section
        eyebrow={t('Помощник ПВЗ', 'ПВЗ көмекшісі')}
        title={t('Цена за каждый срок', 'Әр мерзімнің бағасы')}
        lead={t(
          'Стандарт сравниваем с базовым тарифом аналога, Про — с расширенным.',
          'Стандартты аналогтың базалық тарифімен, Про-ны кеңейтілгенімен салыстырамыз.',
        )}
      >
        {plansBlock(<PlanPrices plans={list} />)}
      </Section>

      <Section
        tone="band"
        eyebrow={t('Помощник ПВЗ', 'ПВЗ көмекшісі')}
        title={t('Что входит в тариф', 'Тарифке кіретіндер')}
        lead={t(
          'Прочерк у аналога — этого нет в описании его тарифов. Компьютеры, пункты и архив клиентов можно докупить пакетами.',
          'Аналогтағы сызықша — бұл оның тариф сипаттамасында жоқ. Компьютерлерді, пункттерді және клиенттер мұрағатын пакетпен сатып алуға болады.',
        )}
      >
        {plansBlock(<PlanFeatures plans={list} />)}
      </Section>

      <Section
        eyebrow={t('Печать ячеек', 'Ұяшық басып шығару')}
        title={t(
          'Фиксированная цена вместо оплаты за этикетку',
          'Жапсырма үшін төлемнің орнына тұрақты баға',
        )}
        lead={t(
          'Чем больше приёмок, тем больше счёт у аналога. У нас цена за компьютер не зависит от числа этикеток. Работает с Wildberries и Ozon.',
          'Қабылдау көп болған сайын аналогтағы шот та өседі. Бізде компьютер бағасы жапсырма санына байланысты емес. Wildberries және Ozon-мен жұмыс істейді.',
        )}
      >
        <CellPrintCalc />
      </Section>

      <Section
        tone="band"
        eyebrow={t('Комплект', 'Жиынтық')}
        title={t(
          `Пункт на ${TYPICAL_DAILY} приёмок в день`,
          `Күніне ${TYPICAL_DAILY} қабылдайтын пункт`,
        )}
        lead={t(
          'Обе программы на одном компьютере за месяц.',
          'Екі бағдарлама бір компьютерде бір айға.',
        )}
      >
        {plansBlock(<Bundle plans={list} />)}
      </Section>

      <Section>
        <Card accent>
          <div className={s.cta}>
            <div>
              <h2>{t('Попробуйте у себя в пункте', 'Өз пунктіңізде байқап көріңіз')}</h2>
              <p className="muted" style={{ margin: 0 }}>
                {t(
                  'Скачивание бесплатное. Оплата по QR-коду СБП в программе или картой на сайте, без автосписаний.',
                  'Жүктеу тегін. Бағдарламада СБП QR-коды арқылы немесе сайтта картамен төлеу, автоматты түрде алынбайды.',
                )}
              </p>
            </div>
            <Link to={lp('/tarify')}>
              <Button size="lg">
                {t('Выбрать тариф', 'Тариф таңдау')}
                <ArrowRight size={18} />
              </Button>
            </Link>
          </div>
        </Card>
      </Section>
    </>
  );
}
