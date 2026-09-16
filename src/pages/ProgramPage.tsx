import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  CircleCheck,
  Download,
  MessagesSquare,
  Package,
  RefreshCw,
  Search,
  Target,
} from 'lucide-react';
import { api } from '../api/client';
import { Hero } from '../components/Hero';
import { Section } from '../components/Section';
import { Steps } from '../components/Steps';
import { FeatureGrid } from '../components/FeatureGrid';
import { SpecList } from '../components/SpecList';
import { CROSS_SELL, CrossSell } from '../components/CrossSell';
import { Accordion, Alert, Badge, Button, Card, Checkbox, Stat } from '../ui';
import {
  formatPerUnit,
  formatTotal,
  getLicensePack,
  iterationWord,
  LICENSE_PACK_LIST,
  POPULAR_LICENSE_PACK,
} from '../lib/pricing';
import { PROGRAM_DOWNLOAD_URL } from '../lib/downloads';
import { useDocumentMeta } from '../lib/seo';
import s from './ProgramPage.module.css';

type Payment = { confirmationUrl: string };

const FEATURES = [
  {
    Icon: Search,
    title: 'Поиск кода клиента',
    text: 'Подбирает код клиента по номеру ячейки на основе доступных рабочих данных — вместо ручного перебора вариантов.',
  },
  {
    Icon: MessagesSquare,
    title: 'Проверка отзывов',
    text: 'Показывает отзывы выбранного пункта выдачи и связанную с ними информацию в одном окне.',
  },
  {
    Icon: Package,
    title: 'Товары клиента',
    text: 'Список товаров в заказе и история — чтобы не переключаться между вкладками во время выдачи.',
  },
  {
    Icon: RefreshCw,
    title: 'Автообновление',
    text: 'Программа сама проверяет наличие новой версии и показывает, что именно изменилось.',
  },
] as const;

const STEPS = [
  {
    title: 'Скачайте установщик',
    text: 'Бесплатно и без регистрации: кнопка на этой странице сразу отдаёт файл.',
  },
  {
    title: 'Установите программу',
    text: 'Обычный установщик для Windows: ярлык на рабочем столе и пункт в меню «Пуск».',
  },
  {
    title: 'Купите итерации и активируйте ключ',
    text: 'Введите ключ в программе — и можно искать. Платите только за успешные подборы.',
  },
] as const;

const SPECS = [
  {
    term: 'Операционная система',
    value: 'Windows 10 и Windows 11. Для Windows 7 собирается отдельная версия.',
  },
  {
    term: 'Размер установщика',
    value: 'Около 16 МБ для Windows 10/11, около 19 МБ для сборки под Windows 7.',
  },
  {
    term: 'Установка',
    value: 'Обычный установщик: ярлык на рабочем столе и пункт в меню «Пуск», удаление — штатное.',
  },
  {
    term: 'Интернет',
    value: 'Нужен для активации ключа, списания итераций и проверки обновлений.',
  },
  {
    term: 'Хранение данных',
    value: 'Настройки и локальные данные хранятся на вашем компьютере в папке профиля.',
  },
  {
    term: 'Текущая версия',
    value: '1.3.3 — починена кнопка обновления и добавлена поддержка обязательных обновлений.',
  },
] as const;

const FAQ = [
  {
    q: 'Что такое итерация?',
    a: 'Итерация — это один успешный подбор кода. Программа списывает её только тогда, когда код действительно найден.',
  },
  {
    q: 'Списывается ли итерация, если код не найден?',
    a: 'Нет. Если подбор не дал результата, итерация остаётся на ключе. Вы платите только за результат.',
  },
  {
    q: 'Сгорает ли ключ по времени?',
    a: 'Нет. Ключ действует до полного использования купленных итераций и не имеет срока годности.',
  },
  {
    q: 'Работает ли программа на Windows 7?',
    a: 'Да. Кроме основной сборки для Windows 10 и 11 есть отдельная сборка для Windows 7 — напишите в поддержку, если нужна именно она.',
  },
  {
    q: 'Как скачать программу?',
    a: 'Кнопка «Скачать бесплатно» на этой странице сразу отдаёт установщик — оплата и регистрация для скачивания не нужны. Платными остаются только итерации подбора.',
  },
  {
    q: 'Можно ли перенести программу на другой компьютер?',
    a: 'Да. Установите программу на другом компьютере и введите тот же ключ — остаток итераций хранится на сервере, а не на конкретном ПК.',
  },
  {
    q: 'Почему антивирус может ругаться на установщик?',
    a: 'Установщик собран из Python-кода и не имеет платной цифровой подписи, поэтому отдельные антивирусы показывают предупреждение о неизвестном издателе. Скачивайте файл только с этой страницы.',
  },
  {
    q: 'Куда писать, если что-то не работает?',
    a: 'В Telegram @roma_denosov — поможем с установкой, активацией ключа и обновлением.',
  },
] as const;

function goToIterations() {
  document.getElementById('iterations')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function ProgramPage() {
  useDocumentMeta(
    'Подбор кодов — программа для ПВЗ Wildberries на Windows',
    'Программа находит код клиента по номеру ячейки, показывает товары заказа и отзывы ПВЗ. Скачивание бесплатное, списание только за успешный подбор.',
  );

  const [acceptedPack, setAcceptedPack] = useState(false);
  const [iterations, setIterations] = useState<number>(POPULAR_LICENSE_PACK);

  const selected = getLicensePack(iterations);
  const single = getLicensePack(1);

  const buyPack = useMutation({
    mutationFn: () =>
      api<Payment>('/api/payments/create', {
        method: 'POST',
        body: JSON.stringify({
          productKind: 'program_license',
          licenseIterations: iterations,
          accepted: acceptedPack,
        }),
      }),
    onSuccess: d => location.assign(d.confirmationUrl),
  });

  return (
    <>
      <Hero
        eyebrow="Программа для Windows · версия 1.3.3"
        title={
          <>
            Подбор <em>кодов клиента</em> по номеру ячейки
          </>
        }
        copy={
          <>
            Находит код клиента по номеру ячейки, показывает товары заказа и отзывы — без ручного
            перебора. <strong>Программа скачивается бесплатно</strong>, вы платите только за
            успешные подборы.
          </>
        }
        trust={[
          'Скачивание без оплаты и регистрации',
          'Windows 7, 10 и 11',
          'Списание только за найденный код',
          'Данные остаются на вашем ПК',
        ]}
      >
        <div className={s.heroActions}>
          <a href={PROGRAM_DOWNLOAD_URL}>
            <Button size="lg">
              <Download size={18} />
              Скачать бесплатно
            </Button>
          </a>
          <Button size="lg" variant="secondary" onClick={goToIterations}>
            Смотреть тарифы
          </Button>
        </div>
      </Hero>

      <div className="page">
        <div className="grid grid-3">
          <Card>
            <Stat
              value="Бесплатно"
              label="скачивание программы"
              icon={<Download size={20} />}
            />
          </Card>
          <Card>
            <Stat
              value={`от ${formatPerUnit(getLicensePack(20).perUnit)}`}
              label="за успешный подбор"
              icon={<Target size={20} />}
            />
          </Card>
          <Card>
            <Stat
              value="Без срока"
              label="ключ не сгорает по времени"
              icon={<RefreshCw size={20} />}
            />
          </Card>
        </div>

        <Card accent className="section">
          <div className={s.buy}>
            <div className="stack">
              <Badge tone="accent">Бесплатное скачивание</Badge>
              <h2>Программа для Windows</h2>
              <p className="muted" style={{ margin: 0 }}>
                Установщик отдаётся сразу: оплата и регистрация нужны только для итераций подбора.
              </p>
              <ul className={s.bullets}>
                <li>Установщик для Windows 10 и 11, отдельная сборка для Windows 7</li>
                <li>Все функции программы без урезаний</li>
                <li>Бесплатные обновления — программа проверяет их сама</li>
                <li>Поддержка в Telegram по установке и запуску</li>
              </ul>
            </div>

            <div className="stack">
              <div className={s.priceLine}>
                <span className={s.priceValue}>0 ₽</span>
                <span className={s.priceLabel}>скачивание</span>
              </div>

              <a href={PROGRAM_DOWNLOAD_URL}>
                <Button size="lg" block>
                  <Download size={18} />
                  Скачать бесплатно
                </Button>
              </a>

              <p className={s.note}>
                Первый успешный подбор возможен без ключа — дальше нужны итерации, они покупаются
                ниже на этой странице.
              </p>
            </div>
          </div>
        </Card>
      </div>

      <Section
        tone="band"
        eyebrow="Возможности"
        title="Что умеет программа"
        lead="Программа работает с теми рабочими данными ПВЗ, к которым у вас уже есть доступ, и ускоряет рутинные операции на выдаче."
      >
        <FeatureGrid items={FEATURES} />
        <p className={s.disclaimer}>
          Программа предназначена только для работы с данными, к которым у вас есть законный рабочий
          доступ.
        </p>
      </Section>

      <Section eyebrow="Три шага" title="Как начать работу">
        <Steps steps={STEPS} />
      </Section>

      <Section
        id="iterations"
        eyebrow="Ключи активации"
        title="Итерации — за что вы платите"
        lead="Одна итерация — это один успешно найденный код. Если подбор не дал результата, итерация не списывается: вы платите за результат, а не за попытку. Ключ не сгорает по времени и действует до полного использования купленного лимита."
      >
        <div className={s.packs} role="radiogroup" aria-label="Пакеты итераций">
          {LICENSE_PACK_LIST.map(pack => {
            const active = pack.quantity === iterations;
            const popular = pack.quantity === POPULAR_LICENSE_PACK;

            return (
              <button
                key={pack.quantity}
                type="button"
                role="radio"
                aria-checked={active}
                className={`${s.pack} ${active ? s.packActive : ''}`}
                onClick={() => setIterations(pack.quantity)}
              >
                {popular && <span className={s.ribbon}>Чаще всего берут</span>}
                {active && <CircleCheck size={18} className={s.check} aria-hidden="true" />}
                <span className={s.packQty}>
                  {pack.quantity} {iterationWord(pack.quantity)}
                </span>
                <span className={s.packTotal}>{formatTotal(pack.total)}</span>
                <span className={s.packUnit}>{formatPerUnit(pack.perUnit)} за подбор</span>
              </button>
            );
          })}
        </div>

        <div className={s.checkout}>
          <div className={s.summary}>
            <span className="muted">
              {selected.quantity} {iterationWord(selected.quantity)} по{' '}
              {formatPerUnit(selected.perUnit)}
            </span>
            <span className={s.summaryTotal}>{formatTotal(selected.total)}</span>
          </div>

          <Checkbox
            id="iterations-offer"
            checked={acceptedPack}
            onChange={e => setAcceptedPack(e.target.checked)}
          >
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
            disabled={!acceptedPack}
            loading={buyPack.isPending}
            onClick={() => buyPack.mutate()}
          >
            Купить {selected.quantity} {iterationWord(selected.quantity)} за{' '}
            {formatTotal(selected.total)}
          </Button>

          {buyPack.isError && <Alert tone="error">{buyPack.error.message}</Alert>}

          <p className={s.note}>
            Чем больше пакет, тем дешевле итерация: {formatPerUnit(single.perUnit)} за одну и{' '}
            {formatPerUnit(getLicensePack(20).perUnit)} при покупке 20 штук.
          </p>
        </div>
      </Section>

      <Section eyebrow="Перед покупкой" title="Системные требования">
        <SpecList items={SPECS} />
      </Section>

      <Section eyebrow="Частые вопросы" title="О покупке, итерациях и установке">
        <Accordion items={FAQ} />
      </Section>

      <CrossSell
        items={[CROSS_SELL.cellPrint, CROSS_SELL.generator]}
        title="Нужна автоматическая печать ячеек?"
        lead="«Печать ячеек» работает в фоне вместе с WB_PVZ: находит ячейку после сканирования товара и сразу отправляет этикетку на термопринтер."
      />
    </>
  );
}
