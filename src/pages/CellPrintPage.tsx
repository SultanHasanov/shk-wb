import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import {
  ClipboardList,
  Download,
  FileSpreadsheet,
  Gauge,
  Layers,
  MonitorCheck,
  Printer,
  RefreshCw,
  ScanBarcode,
  Search,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { api } from '../api/client';
import { useStores } from '../stores/root-store';
import { Hero } from '../components/Hero';
import { Section } from '../components/Section';
import { Steps } from '../components/Steps';
import { FeatureGrid } from '../components/FeatureGrid';
import { SpecList } from '../components/SpecList';
import { CROSS_SELL, CrossSell } from '../components/CrossSell';
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  PriceTable,
  Select,
  Stat,
} from '../ui';
import type { PriceCell } from '../ui';
import {
  CELL_PRINT_DEVICES,
  CELL_PRINT_DURATIONS,
  CELL_PRINT_SCOPE_OPTIONS,
  computerWord,
  formatTotal,
  getCellPrintScopedPrice,
  getCellPrintSavingPercent,
} from '../lib/pricing';
import { useDocumentMeta } from '../lib/seo';
import s from './CellPrintPage.module.css';

type Payment = { confirmationUrl: string };

const HOW_STEPS = [
  {
    title: 'Сотрудник сканирует товар в WB_PVZ',
    text: 'Порядок работы не меняется — программа просто работает рядом в фоне.',
  },
  {
    title: 'Программа ловит скан',
    text: 'Находит номер ячейки в локальной базе на этом же компьютере, без обращения к интернету.',
  },
  {
    title: 'Этикетка уходит на принтер',
    text: 'Задание встаёт в очередь и печатается на выбранном термопринтере.',
  },
] as const;

const INSTALL_STEPS = [
  {
    title: 'Скачайте программу бесплатно',
    text: 'Обычный установщик Windows создаст ярлык на рабочем столе и пункт в меню «Пуск».',
  },
  {
    title: 'Выберите принтер',
    text: 'Проверьте, что программа видит оборудование и локальную базу WB_PVZ.',
  },
  {
    title: 'Купите и активируйте ключ',
    text: 'Он появится сразу после оплаты; срок начнётся только при первой активации.',
  },
] as const;

const FEATURES = [
  {
    Icon: Search,
    title: 'Поиск по ячейке',
    text: 'Быстрый поиск по номеру ячейки: видно, что в ней лежит и к какому заказу это относится.',
  },
  {
    Icon: ScanBarcode,
    title: 'Режим сканера',
    text: 'Программа подхватывает скан штрихкода и сразу подставляет его в поиск.',
  },
  {
    Icon: MonitorCheck,
    title: 'Рабочее состояние',
    text: 'Крупная строка статуса «Готово — сканируйте товар в WB_PVZ», выбранный принтер и переключатель фонового сканирования с кнопкой «Пауза».',
  },
  {
    Icon: Layers,
    title: 'Очередь печати',
    text: 'Счётчик заданий в очереди. Задания не теряются, если принтер занят или временно недоступен.',
  },
  {
    Icon: RefreshCw,
    title: 'Ручная печать и повтор',
    text: 'Поле «Ячейка вручную» с кнопкой «Напечатать» и отдельная кнопка «Повторить последнюю» — если этикетка помялась.',
  },
  {
    Icon: Gauge,
    title: 'Счётчики за период',
    text: 'Отсканировано, напечатано, не найдено, ошибки и повторы — за сегодня или за выбранный период.',
  },
  {
    Icon: ClipboardList,
    title: 'Журнал операций',
    text: 'Последние операции с временем, номером ячейки, результатом и принтером — видно, что именно пошло не так.',
  },
  {
    Icon: FileSpreadsheet,
    title: 'Экспорт CSV',
    text: 'Выгрузка статистики за выбранный период — для отчёта или разбора спорных ситуаций.',
  },
] as const;

const KEY_FEATURES = [
  {
    Icon: ShieldCheck,
    title: 'Никакой двойной оплаты',
    text: 'Не нужно отдельно покупать программу: скачайте установщик и выберите только срок действия ключа.',
  },
  {
    Icon: Printer,
    title: 'Безлимит этикеток',
    text: 'Мы не списываем виртуальные этикетки за каждую печать. В течение срока ключа печатайте столько, сколько нужно ПВЗ.',
  },
  {
    Icon: MonitorCheck,
    title: 'От 1 до 20 компьютеров',
    text: 'Один ключ может работать на нескольких рабочих местах и разных ПВЗ. Для сети стоимость каждого компьютера ниже.',
  },
] as const;

const SPECS = [
  {
    term: 'Через драйвер Windows',
    value:
      'Любой термопринтер, который виден в списке принтеров системы: USB, сетевой или Bluetooth.',
  },
  { term: 'NIIMBOT', value: 'Отдельный прямой режим по Bluetooth для совместимых моделей.' },
  { term: 'Операционная система', value: 'Windows 7, 10 и 11.' },
  {
    term: 'Интернет',
    value: 'Нужен для активации ключа и проверки обновлений. Поиск ячейки идёт по локальной базе.',
  },
  { term: 'Данные', value: 'Статистика и журнал операций хранятся на вашем компьютере.' },
] as const;

const FAQ = [
  {
    q: 'Какой принтер подойдёт?',
    a: 'Любой USB, сетевой или Bluetooth-термопринтер, установленный в Windows и печатающий через системный драйвер. Для NIIMBOT есть отдельный прямой режим по Bluetooth.',
  },
  {
    q: 'Нужно ли отдельно покупать программу?',
    a: 'Нет. Программа скачивается бесплатно, вы платите только за ключ на выбранный период и количество компьютеров.',
  },
  {
    q: 'Есть ли ограничение количества этикеток?',
    a: 'Нет. Пока ключ активен, можно печатать любое количество этикеток.',
  },
  {
    q: 'Когда начинается срок действия ключа?',
    a: 'Срок отсчитывается с первой активации ключа в программе, а не с момента оплаты. Ключ можно купить заранее.',
  },
  {
    q: 'На скольких компьютерах можно работать?',
    a: 'Готовые тарифы рассчитаны на 1, 2, 3, 5, 10 или 20 компьютеров. Один ключ можно распределить между разными ПВЗ. Для сети более чем из 20 компьютеров рассчитаем индивидуальный тариф.',
  },
  {
    q: 'Что будет, если ячейка не найдена?',
    a: 'Программа не печатает этикетку и увеличивает счётчик «Не найдено». Номер ячейки можно ввести вручную в поле «Ячейка вручную» и напечатать отдельно.',
  },
  {
    q: 'Нужен ли постоянный интернет?',
    a: 'Интернет нужен для активации ключа и проверки обновлений. Сам поиск ячейки идёт по локальной базе на вашем компьютере.',
  },
  {
    q: 'Печатается ли одна и та же ячейка дважды?',
    a: 'Нет, в программе есть защита от дублей. Если этикетка помялась, есть кнопка «Повторить последнюю».',
  },
  {
    q: 'Можно ли выгрузить статистику?',
    a: 'Да. Выберите период и нажмите «Экспорт CSV» — файл откроется в Excel или любом табличном редакторе.',
  },
  {
    q: 'Куда писать, если что-то не работает?',
    a: 'В Telegram @roma_denosov — поможем с подключением принтера и активацией ключа.',
  },
] as const;

/** Тарифы для сети: годовой ключ, посчитанный на один компьютер. */
const NETWORK_TIERS = [5, 10, 20] as const;

function goToKey() {
  document.getElementById('key')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export const CellPrintPage = observer(() => {
  useDocumentMeta(
    'Печать ячеек — автопечать этикетки при сканировании в WB_PVZ',
    'Программа для Windows печатает номер ячейки на термопринтере сразу после скана товара в WB_PVZ. Скачивание бесплатно, оплата только за ключ.',
  );

  const { purchase: p } = useStores();
  const [accepted, setAccepted] = useState(false);

  const total = getCellPrintScopedPrice(p.durationDays, p.deviceLimit, p.marketplaceScope);
  const perComputer = Math.round(total / p.deviceLimit);
  const saving = getCellPrintSavingPercent(p.durationDays, p.deviceLimit);

  const pay = useMutation({
    mutationFn: () =>
      api<Payment>('/api/payments/create', {
        method: 'POST',
        body: JSON.stringify({
          productKind: 'cell_print_license',
          durationDays: p.durationDays,
          deviceLimit: p.deviceLimit,
          marketplaceScope: p.marketplaceScope,
          promoCode: p.promoCode,
          accepted,
        }),
      }),
    onSuccess: d => location.assign(d.confirmationUrl),
  });

  return (
    <>
      <Hero
        eyebrow="Программа для Windows"
        title={
          <>
            Печать номера ячейки <em>автоматически</em>
          </>
        }
        copy="Программа работает в фоне рядом с WB_PVZ: ловит скан товара, находит ячейку в локальной базе и сразу отправляет этикетку на термопринтер. Сотруднику не нужно ничего вводить руками — отсканировал и забрал этикетку."
        trust={[
          'Любой термопринтер с драйвером Windows',
          'NIIMBOT напрямую по Bluetooth',
          'Защита от повторной печати',
          'Данные не покидают ПВЗ',
        ]}
      >
        <div className={s.heroActions}>
          <Button size="lg" onClick={goToKey}>
            Выбрать ключ
          </Button>
          <a href="/api/payments/download-cell-print">
            <Button size="lg" variant="secondary">
              <Download size={18} />
              Скачать бесплатно
            </Button>
          </a>
        </div>
      </Hero>

      <div className="page">
        <div className="grid grid-4">
          <Card>
            <Stat value="0 ₽" label="за скачивание программы" icon={<Download size={20} />} />
          </Card>
          <Card>
            <Stat value="Безлимит" label="этикеток в каждом ключе" icon={<Printer size={20} />} />
          </Card>
          <Card>
            <Stat value="< 1 сек" label="от скана до этикетки" icon={<Zap size={20} />} />
          </Card>
          <Card>
            <Stat
              value="Локально"
              label="журнал и рабочие данные"
              icon={<MonitorCheck size={20} />}
            />
          </Card>
        </div>

        {/* ---- Конфигуратор ключа ---- */}
        <div className={`${s.buy} section`} id="key">
          <Card>
            <div className="stack">
              <ScanBarcode size={40} color="var(--accent)" />
              <h2>Быстрее между выдачами</h2>
              <p className="muted">
                Сотрудник сканирует товар — принтер сразу печатает номер ячейки. Не нужно искать
                ячейку глазами и вводить номер руками.
              </p>
              <ul className={s.bullets}>
                <li>Без ограничений по числу этикеток</li>
                <li>Срок ключа начинается при первой активации, а не с даты оплаты</li>
                <li>Установщик и обновления включены</li>
              </ul>
              <div className="row">
                <a href="/api/payments/download-cell-print">
                  <Button variant="secondary">
                    <Download size={18} />
                    Скачать программу
                  </Button>
                </a>
              </div>
            </div>
          </Card>

          <Card accent>
            <div className="stack">
              <h2>Выберите ключ</h2>
              <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-14)' }}>
                Программа бесплатна. Вы платите только за срок работы и количество компьютеров.
              </p>

              <Field label="Период">
                <Select
                  value={p.durationDays}
                  onChange={e => (p.durationDays = Number(e.target.value))}
                >
                  {CELL_PRINT_DURATIONS.map(d => (
                    <option key={d.days} value={d.days}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Для какого маркетплейса">
                <Select
                  value={p.marketplaceScope}
                  onChange={e => (p.marketplaceScope = e.target.value as 'wb' | 'ozon' | 'both')}
                >
                  {CELL_PRINT_SCOPE_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              </Field>

              <Field label="Количество компьютеров">
                <Select
                  value={p.deviceLimit}
                  onChange={e => (p.deviceLimit = Number(e.target.value))}
                >
                  {CELL_PRINT_DEVICES.map(n => (
                    <option key={n} value={n}>
                      {n} {computerWord(n)}
                    </option>
                  ))}
                </Select>
              </Field>

              {/* Итог до оплаты. Раньше сумму человек впервые видел уже в ЮKassa. */}
              <div className={s.total}>
                <div>
                  <span className={s.totalLabel}>Итого</span>
                  {p.deviceLimit > 1 && (
                    <span className={s.perComputer}>{formatTotal(perComputer)} за компьютер</span>
                  )}
                </div>
                <div className={s.totalValueWrap}>
                  <span className={s.totalValue}>{formatTotal(total)}</span>
                  {saving > 0 && <Badge tone="success">−{saving}%</Badge>}
                </div>
              </div>

              <Field label="Промокод" help="Если есть — введите, скидка применится при оплате">
                <Input value={p.promoCode} onChange={e => (p.promoCode = e.target.value)} />
              </Field>

              <Checkbox checked={accepted} onChange={e => setAccepted(e.target.checked)}>
                Принимаю{' '}
                <a className="accent" href="/offer">
                  оферту
                </a>{' '}
                и{' '}
                <a className="accent" href="/privacy">
                  политику конфиденциальности
                </a>
              </Checkbox>

              <Button
                size="lg"
                block
                disabled={!accepted}
                loading={pay.isPending}
                onClick={() => pay.mutate()}
              >
                Купить ключ за {formatTotal(total)}
              </Button>

              <p className={s.note}>
                Платёж проходит на стороне ЮKassa — данные карты не попадают на сайт. Ключ
                появляется сразу после оплаты.
              </p>

              {pay.isError && <Alert tone="error">{pay.error.message}</Alert>}
            </div>
          </Card>
        </div>
      </div>

      <Section
        eyebrow="Как это работает"
        title="Что происходит после сканирования товара"
        lead="Сотрудник продолжает работать в WB_PVZ как обычно. «Печать ячеек» незаметно выполняет остальное в фоне. Фоновое сканирование можно поставить на паузу в один клик — например, на время инвентаризации."
      >
        <Steps steps={HOW_STEPS} />
      </Section>

      <Section
        tone="band"
        eyebrow="Интерфейс"
        title="Что видно в программе"
        lead="Одно окно, в котором сразу понятно рабочее состояние, что напечатано за смену и где возникли проблемы."
      >
        <FeatureGrid items={FEATURES} />
      </Section>

      <Section
        eyebrow="Оборудование"
        title="Совместимость с принтерами"
        lead="Поддерживается любой USB, сетевой или Bluetooth-термопринтер, который установлен в Windows и печатает через системный драйвер — отдельных драйверов ставить не нужно. Для устройств NIIMBOT доступен прямой режим по Bluetooth, без установки принтера в систему."
      >
        <SpecList items={SPECS} />
        <Alert tone="info">
          Не уверены насчёт своей модели? Скачайте программу бесплатно или{' '}
          <a className="accent" href="https://t.me/roma_denosov" target="_blank" rel="noreferrer">
            напишите нам название принтера
          </a>{' '}
          — поможем проверить совместимость.
        </Alert>
      </Section>

      <Section
        id="pricing"
        eyebrow="Тарифы"
        title="Платите только за ключ"
        lead="Программа скачивается бесплатно. Каждый ключ включает неограниченное количество этикеток на выбранный период, обновления и помощь с настройкой."
      >
        <FeatureGrid items={KEY_FEATURES} />

        <div className={s.priceBlock}>
          <PriceTable
            caption="Цена ключа «Печать ячеек» по периодам и количеству компьютеров. Нажмите на цену, чтобы выбрать тариф."
            head={CELL_PRINT_DEVICES.map(n => {
              const discount = getCellPrintSavingPercent(30, n);
              return discount > 0
                ? `${n} ${computerWord(n)} −${discount}%`
                : `${n} ${computerWord(n)}`;
            })}
            rows={CELL_PRINT_DURATIONS.map(d => ({
              label: d.label,
              cells: CELL_PRINT_DEVICES.map<PriceCell>(n => ({
                label: formatTotal(getCellPrintScopedPrice(d.days, n, p.marketplaceScope)),
                active: p.durationDays === d.days && p.deviceLimit === n,
                onSelect: () => {
                  p.durationDays = d.days;
                  p.deviceLimit = n;
                  goToKey();
                },
              })),
            }))}
          />
          <p className={s.priceNote}>
            Это окончательная стоимость: доплачивать за программу или количество напечатанных
            этикеток не нужно. Срок ключа начинается с первой активации, а не с даты оплаты.
          </p>
        </div>
      </Section>

      <Section
        tone="band"
        eyebrow="Для нескольких ПВЗ"
        title="Один ключ на всю сеть"
        lead="Компьютеры можно распределить между любым количеством пунктов. Чем больше рабочих мест подключено, тем ниже цена каждого."
      >
        <div className={s.network}>
          {NETWORK_TIERS.map(devices => {
            const yearly = getCellPrintScopedPrice(365, devices, p.marketplaceScope);
            return (
              <Card key={devices} interactive>
                <div className="stack">
                  <Badge tone="accent">
                    −{getCellPrintSavingPercent(365, devices)}% за компьютер
                  </Badge>
                  <Stat
                    value={formatTotal(yearly)}
                    label={`${devices} ${computerWord(devices)} на год`}
                  />
                  <p className={s.perYear}>
                    {formatTotal(Math.round(yearly / devices))} за компьютер в год
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      p.durationDays = 365;
                      p.deviceLimit = devices;
                      goToKey();
                    }}
                  >
                    Выбрать тариф
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>

        <Alert tone="info">
          Более 20 компьютеров? Рассчитаем тариф для вашей сети и поможем подключить все пункты —{' '}
          <a className="accent" href="https://t.me/roma_denosov" target="_blank" rel="noreferrer">
            напишите нам в Telegram
          </a>
          .
        </Alert>
      </Section>

      <Section eyebrow="Три шага" title="Скачайте, настройте и активируйте">
        <Steps steps={INSTALL_STEPS} />
      </Section>

      <Section eyebrow="Частые вопросы" title="О печати, ключах и оборудовании">
        <Accordion items={FAQ} />
      </Section>

      <CrossSell
        items={[CROSS_SELL.program, CROSS_SELL.generator]}
        title="Нужен поиск кода клиента по ячейке?"
        lead="Кроме «Печати ячеек» у нас есть программа подбора кодов и онлайн-генератор стикеров."
      />
    </>
  );
});
