import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { ArrowRight, Download, Printer as PrinterIcon, Share2 } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { api, isOwnerError, isQuotaError } from '../api/client';
import { CUSTOM_CODE_LENGTH, MAX_BATCH_QUANTITY, useStores } from '../stores/root-store';
import { ThermalPrint } from '../components/ThermalPrint';
import { Hero } from '../components/Hero';
import { Section } from '../components/Section';
import { Steps } from '../components/Steps';
import { PricingPacks } from '../components/PricingPacks';
import { GeneratedCounter } from '../components/GeneratedCounter';
import { CROSS_SELL, CrossSell } from '../components/CrossSell';
import { TelegramBotPromo } from '../components/TelegramBotPromo';
import { BulkCustomStickerEditor } from '../components/BulkCustomStickerEditor';
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Modal,
  Segmented,
  Skeleton,
} from '../ui';
import { MIN_PER_UNIT } from '../lib/pricing';
import { useDocumentMeta } from '../lib/seo';
import s from './GeneratorPage.module.css';
import type { CabinetBootstrap, StickerAsset } from '../api/cabinet';
import { useMoney } from '../lib/currency';
import { type T, useT } from '../i18n';
import { rememberPendingOrder } from '../lib/pending-orders';

/** Остаток по коду один на все виды генерации: тип и режим ниже выбирают, что
 *  печатать, а не из какого лимита списывать. */
type Access = {
  access?: { used: number; total: number; remaining: number };
};

type Generated = {
  items?: Array<{ code: string; imageUrl: string }>;
  stickers?: Array<{ code: string; imageUrl: string }>;
  pdfUrl?: string;
  imageUrl?: string;
  access?: Access['access'];
  priceKopecks?: number;
  discountApplied?: boolean;
  balanceKopecks?: number;
};

function stickerFileName(code: string) {
  const safeCode = code.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `wb-sticker-${safeCode || 'generated'}.png`;
}

async function stickerFile(item: { code: string; imageUrl: string }) {
  const pngUrl = item.imageUrl + (item.imageUrl.includes('?') ? '&' : '?') + 'format=png';
  const response = await fetch(pngUrl);
  if (!response.ok) throw new Error('Не удалось загрузить изображение');
  const blob = await response.blob();
  return new File([blob], stickerFileName(item.code), { type: 'image/png' });
}

async function downloadSticker(item: { code: string; imageUrl: string }) {
  const file = await stickerFile(item);
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function shareSticker(item: { code: string; imageUrl: string }) {
  const file = await stickerFile(item);
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    await navigator.share({ files: [file], title: `Стикер WB ${item.code}` });
    return;
  }
  await downloadSticker(item);
}

const trustItems = (t: T, _perUnit: string) => [
  t('По номеру — 7,50 ₽', 'Нөмір бойынша — 7,50 ₽'),
  t('Оплата через ЮKassa', 'ЮKassa арқылы төлем'),
  t('Готовый PDF для печати', 'Басып шығаруға дайын PDF'),
  t('Без регистрации', 'Тіркелусіз'),
];

const QUANTITY_PRESETS = [50] as const;

/** Снимки реальных наклеек — те же, что на боевом сайте. */
const kindOptions = (t: T) => [
  { value: 'product' as const, label: t('Стикеры для товаров', 'Тауарларға арналған стикерлер'), image: '/images/tab-products-v2.webp' },
  { value: 'box' as const, label: t('QR для возвратных коробок', 'Қайтару қораптарына арналған QR'), image: '/images/tab-return-boxes-v2.webp' },
];

/**
 * Три шага перед формой. Помимо очевидного, снимает главный вопрос новичка —
 * «что за код доступа и где его взять»: из шага 1 видно, что код нужен сразу и
 * приходит вместе с пакетом.
 */
const steps = (t: T) => [
  {
    title: t('Выберите, что печатать', 'Не басып шығаратыныңызды таңдаңыз'),
    text: t(
      'Товарные стикеры или QR-коды возвратных коробок. Массово — пачкой по количеству, либо по конкретному номеру ШК.',
      'Тауар стикерлері немесе қайтару қораптарының QR-кодтары. Көптеп — санына қарай бумамен, не нақты ШК нөмірі бойынша.',
    ),
  },
  {
    title: t('Укажите данные', 'Деректерді көрсетіңіз'),
    text: t(
      'Для массовой печати — количество, для одиночной — номер. Для коробок можно задать свой префикс. Всё проверяется на лету.',
      'Көптеп басу үшін — саны, жеке басу үшін — нөмірі. Қораптар үшін өз префиксіңізді беруге болады. Бәрі бірден тексеріледі.',
    ),
  },
  {
    title: t('Скачайте или напечатайте', 'Жүктеп алыңыз немесе басып шығарыңыз'),
    text: t(
      'Готовый PDF формата A4 для обычного принтера или прямая отправка на термопринтер. Файл остаётся у вас.',
      'Кәдімгі принтерге арналған дайын A4 PDF немесе термопринтерге тікелей жіберу. Файл өзіңізде қалады.',
    ),
  },
];

const faq = (t: T) => [
  {
    q: t('Что такое возвратный ШК и зачем он нужен?', 'Қайтару ШК деген не және ол не үшін қажет?'),
    a: t(
      'ШК — сокращение от «штрих-код». Так помечают товар, возвращаемый на склад Wildberries: без корректной этикетки возврат может не пройти приёмку, поэтому стикер печатают заранее, на пункте выдачи.',
      'ШК — «штрих-код» сөзінің қысқартылуы. Wildberries қоймасына қайтарылатын тауар осылай белгіленеді: дұрыс заттаңбасыз қайтару қабылдаудан өтпеуі мүмкін, сондықтан стикерді беру пунктінде алдын ала басып шығарады.',
    ),
  },
  {
    q: t('Подойдёт ли обычный принтер?', 'Кәдімгі принтер жарай ма?'),
    a: t(
      'Да. Результат отдаётся готовым PDF формата A4 — его печатает любой офисный принтер. Термопринтер нужен только если вы хотите печатать по одной этикетке без раскроя листа.',
      'Иә. Нәтиже дайын A4 PDF түрінде беріледі — оны кез келген кеңсе принтері басып шығарады. Термопринтер парақты кеспей, заттаңбаларды бір-бірден басқыңыз келсе ғана қажет.',
    ),
  },
  {
    q: t('Нужна ли регистрация?', 'Тіркелу қажет пе?'),
    a: t(
      'Нет. Достаточно кода доступа — он выдаётся сразу после оплаты пакета, и его можно ввести в форме без учётной записи. Аккаунт нужен только чтобы хранить историю генераций и коды в кабинете.',
      'Жоқ. Қолжетімділік коды жеткілікті — ол пакетті төлегеннен кейін бірден беріледі және оны есептік жазбасыз формаға енгізуге болады. Аккаунт генерациялар тарихы мен кодтарды кабинетте сақтау үшін ғана керек.',
    ),
  },
  {
    q: t('Сколько действует купленный пакет?', 'Сатып алынған пакет қанша уақыт жарамды?'),
    a: t(
      'Срок не ограничен. Пакет общий: генерации тратятся и на стикеры товаров, и на QR коробок, массово и по номеру. Остаток виден рядом с полем кода доступа и в кабинете.',
      'Мерзімі шектелмеген. Пакет ортақ: генерациялар тауар стикерлеріне де, қорап QR-кодтарына да, көптеп те, нөмір бойынша да жұмсалады. Қалдық қолжетімділік коды өрісінің жанында және кабинетте көрінеді.',
    ),
  },
  {
    q: t('Что с возвратом денег?', 'Ақшаны қайтару қалай болады?'),
    a: t(
      'Если пакет не подошёл и генерации не расходовались, напишите в поддержку — вернём оплату. Условия описаны в оферте.',
      'Егер пакет сәйкес келмесе және генерациялар жұмсалмаса, қолдау қызметіне жазыңыз — төлемді қайтарамыз. Шарттары офертада сипатталған.',
    ),
  },
];

/** Прокрутка к блоку пакетов — общая точка выхода из всех состояний «кончилось». */
function goToPackages() {
  document.getElementById('packages')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Пустое состояние показывает не рисунок штрихкода, а настоящий образец: тот же
 * серверный шаблон, что и оплаченные стикеры, только с демонстрационным номером
 * и без списания генераций. Раньше здесь стоял декоративный набор полосок — по
 * нему нельзя было понять, что именно получишь, особенно на вкладке коробок,
 * где печатается QR, а не штрихкод.
 */
function SampleSticker({ kind, prefix }: { kind: 'product' | 'box'; prefix: string }) {
  const t = useT();
  const src =
    kind === 'box'
      ? `/api/stickers/image?example=1&variant=box&prefix=${encodeURIComponent(prefix || 'TRBX')}`
      : '/api/stickers/image?example=1';
  // Живой шаблон доступен не всегда: в локальной разработке без запущенного API
  // и при редком сбое эндпоинта. Подменяем его не фотографией вкладки, а теми же
  // стикерами, снятыми с боевого шаблона и уложенными в статику: человеку нужен
  // пример того, что он получит, а не изображение упаковки.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const fallback =
    kind === 'box' ? '/images/sample-box-sticker.svg' : '/images/sample-product-sticker.svg';

  return (
    <div className={s.sample}>
      <div className={s.sampleFrame}>
        <img
          className={s.sampleImage}
          src={failed ? fallback : src}
          onError={() => setFailed(true)}
          alt={kind === 'box' ? t('Образец QR-кода возвратной коробки', 'Қайтару қорабы QR-кодының үлгісі') : t('Образец стикера товара', 'Тауар стикерінің үлгісі')}
        />
      </div>
      <div>
        <p className={s.sampleTitle}>{t('Так будет выглядеть результат', 'Нәтиже осылай көрінеді')}</p>
        <p className={s.sampleText}>
          {t(
            'Образец с демонстрационным номером. Укажите данные, введите код доступа и запустите генерацию.',
            'Демонстрациялық нөмірі бар үлгі. Деректерді көрсетіп, қолжетімділік кодын енгізіп, генерацияны іске қосыңыз.',
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Рабочая часть генератора — форма и результат без лендинговой обвязки.
 * Вынесена, чтобы кабинет генерировал стикеры у себя и не отправлял человека
 * на публичную главную. Куда вести за пакетами, решает вызывающая страница:
 * на главной это скролл к блоку тарифов, в кабинете — переход на свою страницу.
 */
export const GeneratorWorkspace = observer(({ onNeedPackages }: { onNeedPackages: () => void }) => {
  const { formatPerUnit } = useMoney();
  const t = useT();
  const { generator: g, auth } = useStores();
  const queryClient = useQueryClient();
  const location = useLocation();
  // Постоянные клиенты приходят с кодом в localStorage — им поле показываем сразу.
  // Подсказка о потолке пачки показывается, только когда его действительно задели.
  const [quantityCapped, setQuantityCapped] = useState(false);
  // Генерация расходует оплаченные штуки и выдаёт номера безвозвратно, поэтому
  // подтверждаем состав пачки до запуска, а не показываем результат постфактум.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [guestAccepted, setGuestAccepted] = useState(false);
  // Термопринтер печатает по одному стикеру в ряд, обычный принтер — сеткой.
  const [printColumns, setPrintColumns] = useState(4);
  // Пусто — печатаем всю пачку; иначе первые N из неё.
  const [printCount, setPrintCount] = useState<number | ''>('');
  const [previewCount, setPreviewCount] = useState(0);
  // Одиночная генерация сохраняет прежнюю форму и серверный маршрут. Редактор очереди
  // включается явно, чтобы быстрый сценарий по одному номеру не стал сложнее.
  const [customInputMode, setCustomInputMode] = useState<'single' | 'list'>('single');
  const cabinet = useQuery({
    queryKey: ['cabinet', 'bootstrap'],
    queryFn: () => api<CabinetBootstrap>('/api/cabinet/bootstrap'),
    enabled: auth.isAuthenticated,
  });
  useEffect(() => {
    if (g.mode === 'range') g.quantity = 50;
  }, [g, g.mode]);
  // Код доступа лежит в localStorage, чтобы аноним не вводил его при каждом заходе.
  // Раньше сохранённый код имел приоритет над кабинетом («if (g.accessCode) return»),
  // и во втором аккаунте того же браузера подставлялся пакет первого — генерация
  // списывалась с чужого пакета. Поэтому у вошедшего всегда выигрывают его пакеты.
  useEffect(() => {
    if (!auth.isAuthenticated || !cabinet.data) return;
    const owned = cabinet.data.assets.filter(
      (asset): asset is StickerAsset => asset.type === 'sticker' && asset.active,
    );
    if (owned.some(asset => asset.key === g.accessCode)) return;
    const next = owned[0]?.key ?? '';
    g.accessCode = next;
    try {
      if (next) localStorage.setItem('sticker_access_code', next);
      else localStorage.removeItem('sticker_access_code');
    } catch {
      // Запрет на хранение не должен мешать подстановке кода в поле.
    }
  }, [cabinet.data, g, auth.isAuthenticated, auth.user?.id]);

  const access = useQuery({
    queryKey: ['access', g.accessCode],
    queryFn: () =>
      api<Access>('/api/stickers/generate?accessCode=' + encodeURIComponent(g.accessCode)),
    enabled: false,
  });

  const mutation = useMutation({
    mutationFn: () => {
      const box = g.kind === 'box';
      const body =
        g.mode === 'range'
          ? {
              mode: box ? 'box_range' : 'range',
              quantity: 50,
              prefix: box ? g.prefix : undefined,
              requestId: crypto.randomUUID(),
              accessCode: auth.isAuthenticated ? undefined : g.accessCode,
            }
          : {
              mode: box ? 'box_custom' : 'custom',
              code: g.code,
              prefix: box ? g.prefix : undefined,
              requestId: crypto.randomUUID(),
              accessCode: auth.isAuthenticated ? undefined : g.accessCode,
            };
      return api<Generated>('/api/stickers/generate', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    // Ответ на генерацию несёт тот же остаток, что и GET, — кладём его в кэш,
    // иначе бейдж до перезагрузки показывает число до списания.
    onSuccess: data => {
      const generatedItems = data.items ?? data.stickers ?? (data.imageUrl ? [data.imageUrl] : []);
      setPreviewCount(Math.min(4, generatedItems.length));
      queryClient.invalidateQueries({ queryKey: ['cabinet', 'bootstrap'] });
    },
  });

  const guestCheckout = useMutation({
    mutationFn: () => api<{ confirmationUrl: string; token: string }>('/api/payments/create', {
      method: 'POST',
      body: JSON.stringify({
        productKind: 'stickers',
        guestGenerationMode: g.mode === 'range' ? 'batch' : 'custom',
        accepted: guestAccepted,
        returnTo: 'public',
      }),
    }),
    onSuccess: data => {
      rememberPendingOrder(localStorage, data.token);
      window.location.assign(data.confirmationUrl);
    },
  });

  const remaining = undefined;

  const items = mutation.data?.items ?? mutation.data?.stickers ?? [];
  const previewItems = items.length
    ? items
    : mutation.data?.imageUrl
      ? [{ code: g.code, imageUrl: mutation.data.imageUrl }]
      : [];
  const shown = previewItems.slice(0, previewCount);

  // Термопечать берёт ту же пачку и то же ограничение «сколько печатать», что и
  // PDF, чтобы человек не получил на плёнке больше этикеток, чем на листе.
  const thermalLimit = Number(printCount);
  const thermalUrls = (
    thermalLimit > 0 && thermalLimit < previewItems.length
      ? previewItems.slice(0, thermalLimit)
      : previewItems
  ).map(item => item.imageUrl);
  // Размер этикетки из настроек кабинета — начальное значение для вошедших.
  const savedThermalSize = String(
    cabinet.data?.profile.preferences.thermalPrintSettings?.size ?? '',
  );

  const outOfQuota = false;
  const lowQuota = false;
  const quotaBlocked = mutation.isError && isQuotaError(mutation.error);
  // Чужой код виден и до нажатия «Сгенерировать» — проверка владельца стоит и в
  // запросе остатка, но раньше его ошибка нигде не показывалась.
  const ownerBlocked = mutation.isError && isOwnerError(mutation.error);
  const codeLength = CUSTOM_CODE_LENGTH[g.kind];
  const invalidCustomCode = g.mode === 'custom' && g.code.length !== codeLength;
  // Пустое поле количества — это 0 в сторе: нажатие ловило бы 400 от API.
  const invalidQuantity = false;
  const bulkCustomMode = false;

  // Печать и скачивание идут одним и тем же PDF: раньше «Печать» звала
  // window.print(), и в кабинете выходил пустой лист — печатные стили прячут
  // header/aside/nav, на которых построена вся оболочка кабинета.
  const printUrl = (inline: boolean) => {
    const base = mutation.data?.pdfUrl;
    if (!base) return '';
    // Одиночный стикер не растягиваем на лист: печатаем его в размере сетки «5 в ряд».
    const params = new URLSearchParams({ columns: String(g.mode === 'custom' ? 5 : printColumns) });
    const limit = Number(printCount);
    if (limit > 0 && limit < items.length) {
      params.set(
        'codes',
        items
          .slice(0, limit)
          .map(item => item.code)
          .join(','),
      );
    }
    if (inline) params.set('inline', '1');
    return `${base}&${params.toString()}`;
  };

  const kindLabel = g.kind === 'box'
    ? t('QR-коды возвратных коробок', 'Қайтару қораптарының QR-кодтары')
    : t('стикеры товаров', 'тауар стикерлері');
  const modeLabel = g.mode === 'range' ? t('Массово', 'Көптеп') : t('По номеру', 'Нөмір бойынша');
  const numberLabel = g.kind === 'box' ? t('Номер коробки', 'Қорап нөмірі') : t('Номер ШК', 'ШК нөмірі');
  const plannedCount = g.mode === 'range' ? 50 : 1;
  const leftAfter = remaining === undefined ? undefined : Math.max(0, remaining - plannedCount);
  const notEnough = remaining !== undefined && remaining < plannedCount;

  return (
    <div className={s.layout}>
      <Card className={s.form}>
        <div className="stack">
          {/* Фотографии вместо иконок: по картинке сразу видно, что печатается —
              наклейка на пакет с товаром или QR на возвратную коробку. */}
          <div className={s.kindPicker} role="radiogroup" aria-label={t('Тип стикера', 'Стикер түрі')}>
            {kindOptions(t).map(option => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={g.kind === option.value}
                className={`${s.kindCard} ${g.kind === option.value ? s.kindActive : ''}`}
                onClick={() => g.setKind(option.value)}
              >
                <img src={option.image} alt="" loading="lazy" />
                <span>{option.label}</span>
              </button>
            ))}
          </div>

          <Segmented
            label={t('Режим генерации', 'Генерация режимі')}
            value={g.mode}
            onChange={v => g.setMode(v)}
            options={[
              { value: 'range', label: t('Массово', 'Көптеп') },
              { value: 'custom', label: t('По номеру', 'Нөмір бойынша') },
            ]}
          />

          <Alert tone={auth.isAuthenticated ? 'info' : 'warning'}>
            {auth.isAuthenticated ? (
              <>
                {t('Стоимость:', 'Бағасы:')} <strong>{g.mode === 'range' ? '20 ₽' : '7,50 ₽'}</strong>
                {' · '}{t('Баланс:', 'Баланс:')} <strong>{((cabinet.data?.wallet.balanceKopecks ?? 0) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</strong>
                {cabinet.data?.wallet.discountAvailable && <> · {t('На эту генерацию доступна разовая скидка 20%.', 'Осы генерацияға бір реттік 20% жеңілдік бар.')}</>}
              </>
            ) : (
              <>{t('Генерацию можно купить без регистрации. Или войдите, чтобы оплатить её с общего баланса.', 'Генерацияны тіркелусіз сатып алуға болады. Немесе ортақ баланстан төлеу үшін кіріңіз.')} <Link to="/login">{t('Войти', 'Кіру')}</Link></>
            )}
          </Alert>

          {false && g.kind === 'product' && g.mode === 'custom' && (
            <Segmented
              label={t('Количество своих номеров', 'Өз нөмірлеріңіздің саны')}
              value={customInputMode}
              onChange={value => setCustomInputMode(value as 'single' | 'list')}
              options={[
                { value: 'single', label: t('Один номер', 'Бір нөмір') },
                { value: 'list', label: t('Список номеров', 'Нөмірлер тізімі') },
              ]}
            />
          )}

          {g.mode === 'range' ? (
            <div>
              <Field
                label={g.kind === 'box' ? t('Количество QR', 'QR саны') : t('Количество стикеров', 'Стикерлер саны')}
                help={t('Фиксированная пачка: ровно 50 кодов одним PDF за 20 ₽.', 'Бекітілген пакет: бір PDF ішінде дәл 50 код, бағасы 20 ₽.')}
              >
                {/* Не type="number": браузер отдаёт пустую строку на «1e5» и
                    «--», и перехватить ввод надёжно нельзя. */}
                <Input
                  inputMode="numeric"
                  value="50"
                  readOnly
                />
              </Field>
              <div className={s.presets}>
                {QUANTITY_PRESETS.map(n => (
                  <button
                    key={n}
                    type="button"
                    className={`${s.preset} ${g.quantity === n ? s.presetActive : ''}`}
                    onClick={() => {
                      setQuantityCapped(false);
                      g.quantity = n;
                    }}
                  >
                    {n} {t('шт', 'дана')}
                  </button>
                ))}
              </div>
            </div>
          ) : bulkCustomMode ? (
            <BulkCustomStickerEditor authenticated={auth.isAuthenticated} onNeedPackages={onNeedPackages} />
          ) : (
            <Field
              label={numberLabel}
              help={t(
                `Введите ровно ${codeLength} цифр. Введено: ${g.code.length} из ${codeLength}.`,
                `Дәл ${codeLength} цифр енгізіңіз. Енгізілді: ${g.code.length} / ${codeLength}.`,
              )}
            >
              <Input
                inputMode="numeric"
                maxLength={codeLength}
                value={g.code}
                onChange={e => (g.code = e.target.value.replace(/\D/g, '').slice(0, codeLength))}
                placeholder={g.kind === 'box' ? '5084472379' : '59874145000'}
              />
            </Field>
          )}

          <div className={s.confirmRow}>
            <span className="muted">{t('К списанию с баланса', 'Баланстан есептен шығару')}</span>
            <strong>{g.mode === 'range' ? (cabinet.data?.wallet.discountAvailable ? '16 ₽' : '20 ₽') : (cabinet.data?.wallet.discountAvailable ? '6 ₽' : '7,50 ₽')}</strong>
          </div>

          {g.kind === 'box' && (
            <Field label={t('Префикс', 'Префикс')}>
              <Input
                value={g.prefix}
                maxLength={12}
                onChange={e => (g.prefix = e.target.value.toUpperCase())}
              />
            </Field>
          )}

          {/* Код доступа обязателен: генерация без него не проходит на сервере,
              поэтому поле показывается сразу, а не прячется за ссылкой. */}
          {false && !bulkCustomMode && <><Field label={t('Код доступа', 'Қолжетімділік коды')} help={t('Код из личного кабинета или со страницы оплаты', 'Жеке кабинеттегі немесе төлем бетіндегі код')}>
            <Input
              maxLength={36}
              value={g.accessCode}
              placeholder="000000"
              onChange={e => {
                g.accessCode = e.target.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
                localStorage.setItem('sticker_access_code', g.accessCode);
              }}
            />
          </Field>

          <div className={s.remaining}>
            {access.isLoading && <Skeleton width="180px" />}
            {remaining !== undefined && (
              <Badge tone={outOfQuota ? 'error' : lowQuota ? 'warning' : 'success'}>
                {t('Осталось генераций:', 'Қалған генерациялар:')} {remaining}
              </Badge>
            )}
            {(lowQuota || !g.accessCode) && (
              <button type="button" className={s.codeToggle} onClick={onNeedPackages}>
                {t('Пополнить баланс', 'Балансты толықтыру')}
              </button>
            )}
          </div>

          {/* Квота кончилась — предлагаем пакет ДО нажатия, а не после. */}
          {outOfQuota && (
            <Alert tone="warning">
              {t('Генерации по этому коду закончились.', 'Бұл код бойынша генерациялар таусылды.')}{' '}
              <button type="button" className={s.codeToggle} onClick={onNeedPackages}>
                {t('Пополнить баланс', 'Балансты толықтыру')}
              </button>
            </Alert>
          )}

          <Button
            size="lg"
            block
            loading={mutation.isPending}
            disabled={invalidCustomCode || invalidQuantity}
            onClick={() => setConfirmOpen(true)}
          >
            {mutation.isPending ? t('Генерируем…', 'Генерациялап жатырмыз…') : t('Сгенерировать', 'Генерациялау')}
          </Button></>}

          <p className={s.historyNote}>
            {auth.isAuthenticated ? (
              <>
                {t('История сгенерированных стикеров сохраняется в', 'Генерацияланған стикерлер тарихы')}{' '}
                <Link to="/cabinet/history">{t('личном кабинете', 'жеке кабинетте сақталады')}</Link>.
              </>
            ) : (
              <>
                <Link to="/login" state={{ from: location.pathname + location.search }}>
                  {t('Войдите', 'Кіріңіз')}
                </Link>
                {t(
                  ', и история ранее сгенерированных стикеров появится в личном кабинете.',
                  ' — бұрын генерацияланған стикерлер тарихы жеке кабинетте пайда болады.',
                )}
              </>
            )}
          </p>

          {/* Исчерпание лимита — не ошибка, а самый горячий момент воронки. */}
          {quotaBlocked ? (
            <Alert tone="warning">
              {t(mutation.error.message, 'Бұл код бойынша генерациялар жеткіліксіз.')}{' '}
              <button type="button" className={s.codeToggle} onClick={onNeedPackages}>
                {t('Пополнить баланс', 'Балансты толықтыру')}
              </button>
            </Alert>
          ) : ownerBlocked ? (
            /* Текст ошибки сервера кончается словами «Войдите под владельцем
               кода», но пойти туда было не по чему: собираем ту же фразу с
               кнопкой и возвратом на эту же страницу после входа. */
            <Alert tone="error">
              {t('Этот код привязан к другому аккаунту.', 'Бұл код басқа аккаунтқа байланған.')}{' '}
              <Link
                className={s.alertLogin}
                to="/login"
                state={{ from: location.pathname + location.search }}
              >
                {t('Войдите', 'Код иесінің')}
              </Link>{' '}
              {t('под владельцем кода.', 'аккаунтымен кіріңіз.')}
            </Alert>
          ) : (
            mutation.isError && <Alert tone="error">{mutation.error.message}</Alert>
          )}
        </div>
      </Card>

      <Card>
        {mutation.data ? (
          <>
            <div className={s.resultHead}>
              <h2>{t('Готово', 'Дайын')}</h2>
            </div>

            {mutation.data.priceKopecks != null && mutation.data.balanceKopecks != null && (
              <Alert tone="success">
                {t('Списано', 'Есептен шығарылды')}: <strong>{(mutation.data.priceKopecks / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</strong>.
                {' '}{t('Остаток', 'Қалдық')}: <strong>{(mutation.data.balanceKopecks / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</strong>.
                {mutation.data.discountApplied && <> {' '}{t('Применена разовая скидка 20%.', 'Бір реттік 20% жеңілдік қолданылды.')}</>}
              </Alert>
            )}

            {g.mode === 'custom' && previewItems.length > 0 && (
              <div className={s.previewSection}>
                <div className={s.previewControls}>
                  <strong>{t('Сгенерированные стикеры', 'Генерацияланған стикерлер')}</strong>
                  {previewCount < previewItems.length && (
                    <>
                      <Button variant="ghost" onClick={() => setPreviewCount(Math.min(previewCount + 4, previewItems.length))}>
                        {t('Показать ещё 4', 'Тағы 4 көрсету')}
                      </Button>
                      <Button variant="ghost" onClick={() => setPreviewCount(previewItems.length)}>
                        {t('Показать все', 'Барлығын көрсету')}
                      </Button>
                    </>
                  )}
                  <span className={s.count}>{t(`Показано ${shown.length} из ${previewItems.length}`, `${previewItems.length} ішінен ${shown.length} көрсетілді`)}</span>
                </div>
                <div className={s.tiles}>
                  {shown.map(item => (
                    <div key={item.code || item.imageUrl} className={`${s.tile} ${previewItems.length === 1 ? s.single : ''}`}>
                      <img src={item.imageUrl} alt={`QR ${item.code}`} loading="lazy" />
                      <div className={s.tileActions}>
                        <button type="button" className={s.tileAction} title={t('Скачать изображение', 'Суретті жүктеп алу')} aria-label={t(`Скачать стикер ${item.code} как изображение`, `${item.code} стикерін сурет ретінде жүктеп алу`)} onClick={() => void downloadSticker(item)}>
                          <Download size={19} />
                        </button>
                        <button type="button" className={s.tileAction} title={t('Поделиться', 'Бөлісу')} aria-label={t(`Поделиться стикером ${item.code}`, `${item.code} стикерімен бөлісу`)} onClick={() => void shareSticker(item)}>
                          <Share2 size={19} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {mutation.data.pdfUrl && (
              <div className={s.printOptions}>
                {g.mode === 'range' && (
                  <>
                    <div>
                      <strong>{t('Настройка листа', 'Парақты баптау')}</strong>
                      <p className={s.printHelp}>
                        {t(
                          'Выберите, сколько QR-кодов или стикеров должно помещаться в одной строке листа A4.',
                          'A4 парағының бір жолына қанша QR-код немесе стикер сыю керектігін таңдаңыз.',
                        )}
                      </p>
                    </div>
                    <Segmented
                      label={t('Количество колонок на листе', 'Парақтағы бағандар саны')}
                      value={String(printColumns)}
                      onChange={value => setPrintColumns(Number(value))}
                      options={[
                        { value: '1', label: '1' },
                        { value: '2', label: '2' },
                        { value: '3', label: '3' },
                        { value: '4', label: '4' },
                        { value: '5', label: '5' },
                      ]}
                    />
                  </>
                )}

                {items.length > 1 && (
                  <Field
                    label={t('Сколько печатать', 'Қанша басып шығару')}
                    help={t(`В пачке ${items.length}. Пусто — вся пачка.`, `Бумада ${items.length}. Бос болса — бүкіл бума.`)}
                  >
                    <Input
                      type="number"
                      min={1}
                      max={items.length}
                      placeholder={t(`Все ${items.length}`, `Барлығы ${items.length}`)}
                      value={printCount}
                      onChange={e =>
                        setPrintCount(e.target.value === '' ? '' : Number(e.target.value))
                      }
                    />
                  </Field>
                )}

                <div className={s.actions}>
                  <a href={printUrl(false)} download>
                    <Button>
                      <Download size={18} />
                      {t('Скачать PDF A4', 'A4 PDF жүктеп алу')}
                    </Button>
                  </a>
                  <a href={printUrl(true)} target="_blank" rel="noopener noreferrer">
                    <Button variant="secondary">
                      <PrinterIcon size={18} />
                      {t('Печать', 'Басып шығару')}
                    </Button>
                  </a>
                </div>

                {thermalUrls.length > 0 && (
                  <ThermalPrint
                    imageUrls={thermalUrls}
                    kind={g.kind}
                    defaultSize={savedThermalSize}
                  />
                )}
              </div>
            )}

            <div className={s.nextStep}>
              {remaining !== undefined ? (
                <span>{t('Осталось генераций:', 'Қалған генерациялар:')} {remaining}</span>
              ) : (
                <span>{t('Нужно больше стикеров?', 'Көбірек стикер керек пе?')}</span>
              )}
              <Button variant="ghost" size="sm" onClick={onNeedPackages}>
                {t('Пачка 50 — 20 ₽', '50 кодтық пакет — 20 ₽')}
                <ArrowRight size={16} />
              </Button>
            </div>
          </>
        ) : (
          <SampleSticker kind={g.kind} prefix={g.prefix} />
        )}
      </Card>

      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('Проверьте, что создаём', 'Не жасайтынымызды тексеріңіз')}
        description={t(
          'Генерации спишутся сразу после запуска, а выданные номера повторно не выдаются.',
          'Генерациялар іске қосылғаннан кейін бірден есептен шығарылады, ал берілген нөмірлер қайта берілмейді.',
        )}
      >
        <div className="stack">
          <div className={s.confirmRow}>
            <span className="muted">{t('Что создаём', 'Не жасаймыз')}</span>
            <strong>{kindLabel}</strong>
          </div>
          <div className={s.confirmRow}>
            <span className="muted">{t('Режим', 'Режим')}</span>
            <strong>{modeLabel}</strong>
          </div>

          {g.mode === 'range' ? (
            <div className={s.confirmRow}>
              <span className="muted">{t('Количество', 'Саны')}</span>
              <strong>{plannedCount} {t('шт', 'дана')}</strong>
            </div>
          ) : (
            <div className={s.confirmRow}>
              <span className="muted">{numberLabel}</span>
              <strong className="mono">{g.code || '—'}</strong>
            </div>
          )}

          {g.kind === 'box' && g.prefix && (
            <div className={s.confirmRow}>
              <span className="muted">{t('Префикс', 'Префикс')}</span>
              <strong className="mono">{g.prefix}</strong>
            </div>
          )}

          {remaining !== undefined && (
            <div className={s.confirmRow}>
              <span className="muted">{t('Останется по коду', 'Кодта қалады')}</span>
              <strong>
                {t(`${leftAfter} из ${remaining}`, `${remaining} ішінен ${leftAfter}`)}
              </strong>
            </div>
          )}

          {notEnough && (
            <Alert tone="warning">
              {t(
                `По коду доступа осталось ${remaining}, а запрошено ${plannedCount}. Уменьшите количество или возьмите пакет.`,
                `Қолжетімділік кодында ${remaining} қалды, ал сұралғаны ${plannedCount}. Санын азайтыңыз немесе пакет алыңыз.`,
              )}
            </Alert>
          )}

          {!auth.isAuthenticated && !g.accessCode && (
            <Checkbox checked={guestAccepted} onChange={event => setGuestAccepted(event.target.checked)}>
              {t('Принимаю', 'Қабылдаймын')}{' '}
              <Link className="accent" to="/offer">{t('оферту', 'офертаны')}</Link>{' '}
              {t('и', 'және')}{' '}
              <Link className="accent" to="/privacy">{t('политику конфиденциальности', 'құпиялылық саясатын')}</Link>
            </Checkbox>
          )}

          <div className="row">
            <Button
              loading={mutation.isPending || guestCheckout.isPending}
              disabled={notEnough || invalidCustomCode || invalidQuantity || (!auth.isAuthenticated && !g.accessCode && !guestAccepted)}
              onClick={() => {
                if (!auth.isAuthenticated && !g.accessCode) guestCheckout.mutate();
                else {
                  setConfirmOpen(false);
                  mutation.mutate();
                }
              }}
            >
              {!auth.isAuthenticated && !g.accessCode
                ? t('Перейти к оплате', 'Төлемге өту')
                : t('Создать', 'Жасау')}
            </Button>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              {t('Отмена', 'Болдырмау')}
            </Button>
          </div>
          {guestCheckout.isError && <Alert tone="error">{guestCheckout.error.message}</Alert>}
        </div>
      </Modal>
    </div>
  );
});

/** Публичная главная: лендинг вокруг той же рабочей части генератора. */
export const GeneratorPage = observer(() => {
  const { formatPerUnit } = useMoney();
  const t = useT();
  // Ключ идёт неразорванным и слева: «Генератор возвратных ШК» разбивал фразу
  // словом посередине, и по запросу «генератор ШК» страница не находилась вовсе.
  useDocumentMeta(
    t('Генератор ШК ВБ — возвратные стикеры и QR коробок', 'ШК ВБ генераторы — WB қайтару стикерлері мен қорап QR-кодтары'),
    t(
      'Генератор ШК Wildberries: по номеру за 7,50 ₽ или пачкой 50 кодов за 20 ₽. Готовый PDF для печати.',
      'Wildberries ШК генераторы: тауарлардың қайтару стикерлері мен қораптардың QR-кодтары онлайн. Басып шығаруға дайын PDF, генерация пакеттері қолжетімді бағамен.',
    ),
  );

  return (
    <>
      <Hero
        eyebrow={t('Онлайн-инструмент', 'Онлайн-құрал')}
        title={
          <>
            <em>{t('Генератор ШК ВБ', 'ШК ВБ генераторы')}</em>
            {t(': возвратные стикеры и QR-коды коробок', ': қайтару стикерлері мен қорап QR-кодтары')}
          </>
        }
        copy={
          <>
            {t(
              'Создавайте возвратные ШК (штрихкоды) Wildberries для товаров и QR-коды коробок по номеру. Скачивайте готовый PDF либо сразу отправляйте этикетки на обычный или термопринтер. Генерации покупаются пакетами —',
              'Тауарларға арналған Wildberries қайтару ШК-ларын (штрихкодтарын) және нөмір бойынша қорап QR-кодтарын жасаңыз. Дайын PDF-ті жүктеп алыңыз немесе заттаңбаларды бірден кәдімгі не термопринтерге жіберіңіз. Генерациялар пакетпен сатылады —',
            )}{' '}
            <strong>{t('7,50 ₽ по номеру', 'Нөмір бойынша 7,50 ₽')}</strong>{' '}
            {t('или 50 кодов за 20 ₽.', 'немесе 50 код 20 ₽.')}
          </>
        }
        trust={trustItems(t, formatPerUnit(MIN_PER_UNIT))}
      />

      <Section id="how" eyebrow={t('Три шага', 'Үш қадам')} title={t('Как это работает', 'Бұл қалай жұмыс істейді')}>
        <Steps steps={steps(t)} />
      </Section>

      <div className="page" id="generator">
        <GeneratorWorkspace onNeedPackages={goToPackages} />
        <div className="section">
          <TelegramBotPromo />
        </div>
      </div>

      <GeneratedCounter />
      <PricingPacks />

      <Section id="faq" eyebrow={t('Частые вопросы', 'Жиі қойылатын сұрақтар')} title={t('Вопросы о генераторе', 'Генератор туралы сұрақтар')}>
        <Accordion items={faq(t)} />
      </Section>

      <CrossSell items={[CROSS_SELL.cellPrint, CROSS_SELL.program]} />
    </>
  );
});
