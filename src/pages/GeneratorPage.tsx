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
  Field,
  Input,
  Modal,
  Segmented,
  Skeleton,
} from '../ui';
import { formatPerUnit, MIN_PER_UNIT } from '../lib/pricing';
import { useDocumentMeta } from '../lib/seo';
import s from './GeneratorPage.module.css';
import type { CabinetBootstrap, StickerAsset } from '../api/cabinet';

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

const TRUST = [
  'От 0,27 ₽ за штуку',
  'Оплата через ЮKassa',
  'Готовый PDF для печати',
  'Без регистрации',
] as const;

const QUANTITY_PRESETS = [10, 50, 100] as const;

/** Снимки реальных наклеек — те же, что на боевом сайте. */
const KIND_OPTIONS = [
  { value: 'product', label: 'Стикеры для товаров', image: '/images/tab-products.png' },
  { value: 'box', label: 'QR для возвратных коробок', image: '/images/tab-return-boxes.png' },
] as const;

/**
 * Три шага перед формой. Помимо очевидного, снимает главный вопрос новичка —
 * «что за код доступа и где его взять»: из шага 1 видно, что код нужен сразу и
 * приходит вместе с пакетом.
 */
const STEPS = [
  {
    title: 'Выберите, что печатать',
    text: 'Товарные стикеры или QR-коды возвратных коробок. Массово — пачкой по количеству, либо по конкретному номеру ШК.',
  },
  {
    title: 'Укажите данные',
    text: 'Для массовой печати — количество, для одиночной — номер. Для коробок можно задать свой префикс. Всё проверяется на лету.',
  },
  {
    title: 'Скачайте или напечатайте',
    text: 'Готовый PDF формата A4 для обычного принтера или прямая отправка на термопринтер. Файл остаётся у вас.',
  },
] as const;

const FAQ = [
  {
    q: 'Что такое возвратный ШК и зачем он нужен?',
    a: 'ШК — сокращение от «штрих-код». Так помечают товар, возвращаемый на склад Wildberries: без корректной этикетки возврат может не пройти приёмку, поэтому стикер печатают заранее, на пункте выдачи.',
  },
  {
    q: 'Подойдёт ли обычный принтер?',
    a: 'Да. Результат отдаётся готовым PDF формата A4 — его печатает любой офисный принтер. Термопринтер нужен только если вы хотите печатать по одной этикетке без раскроя листа.',
  },
  {
    q: 'Нужна ли регистрация?',
    a: 'Нет. Достаточно кода доступа — он выдаётся сразу после оплаты пакета, и его можно ввести в форме без учётной записи. Аккаунт нужен только чтобы хранить историю генераций и коды в кабинете.',
  },
  {
    q: 'Сколько действует купленный пакет?',
    a: 'Срок не ограничен. Пакет общий: генерации тратятся и на стикеры товаров, и на QR коробок, массово и по номеру. Остаток виден рядом с полем кода доступа и в кабинете.',
  },
  {
    q: 'Что с возвратом денег?',
    a: 'Если пакет не подошёл и генерации не расходовались, напишите в поддержку — вернём оплату. Условия описаны в оферте.',
  },
] as const;

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
          alt={kind === 'box' ? 'Образец QR-кода возвратной коробки' : 'Образец стикера товара'}
        />
      </div>
      <div>
        <p className={s.sampleTitle}>Так будет выглядеть результат</p>
        <p className={s.sampleText}>
          Образец с демонстрационным номером. Укажите данные, введите код доступа и запустите
          генерацию.
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
  const { generator: g, auth } = useStores();
  const queryClient = useQueryClient();
  const location = useLocation();
  // Постоянные клиенты приходят с кодом в localStorage — им поле показываем сразу.
  // Подсказка о потолке пачки показывается, только когда его действительно задели.
  const [quantityCapped, setQuantityCapped] = useState(false);
  // Генерация расходует оплаченные штуки и выдаёт номера безвозвратно, поэтому
  // подтверждаем состав пачки до запуска, а не показываем результат постфактум.
  const [confirmOpen, setConfirmOpen] = useState(false);
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
    enabled: /^(?:\d{6}|STK-[A-F0-9]{32})$/.test(g.accessCode),
  });

  const mutation = useMutation({
    mutationFn: () => {
      const box = g.kind === 'box';
      const body =
        g.mode === 'range'
          ? {
              mode: box ? 'box_range' : 'range',
              quantity: g.quantity,
              prefix: box ? g.prefix : undefined,
              accessCode: g.accessCode,
            }
          : {
              mode: box ? 'box_custom' : 'custom',
              code: g.code,
              prefix: box ? g.prefix : undefined,
              accessCode: g.accessCode,
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
      if (data.access) queryClient.setQueryData(['access', g.accessCode], { access: data.access });
    },
  });

  const remaining = access.data?.access?.remaining;

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

  const outOfQuota = remaining === 0;
  const lowQuota = remaining !== undefined && remaining > 0 && remaining <= 5;
  const quotaBlocked = mutation.isError && isQuotaError(mutation.error);
  // Чужой код виден и до нажатия «Сгенерировать» — проверка владельца стоит и в
  // запросе остатка, но раньше его ошибка нигде не показывалась.
  const ownerBlocked = isOwnerError(mutation.error) || isOwnerError(access.error);
  const codeLength = CUSTOM_CODE_LENGTH[g.kind];
  const invalidCustomCode = g.mode === 'custom' && g.code.length !== codeLength;
  // Пустое поле количества — это 0 в сторе: нажатие ловило бы 400 от API.
  const invalidQuantity = g.mode === 'range' && g.quantity < 1;
  const bulkCustomMode =
    g.kind === 'product' && g.mode === 'custom' && customInputMode === 'list';

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

  const kindLabel = g.kind === 'box' ? 'QR-коды возвратных коробок' : 'стикеры товаров';
  const plannedCount = g.mode === 'range' ? Math.max(1, Number(g.quantity) || 1) : 1;
  const leftAfter = remaining === undefined ? undefined : Math.max(0, remaining - plannedCount);
  const notEnough = remaining !== undefined && remaining < plannedCount;

  return (
    <div className={s.layout}>
      <Card className={s.form}>
        <div className="stack">
          {/* Фотографии вместо иконок: по картинке сразу видно, что печатается —
              наклейка на пакет с товаром или QR на возвратную коробку. */}
          <div className={s.kindPicker} role="radiogroup" aria-label="Тип стикера">
            {KIND_OPTIONS.map(option => (
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
            label="Режим генерации"
            value={g.mode}
            onChange={v => g.setMode(v)}
            options={[
              { value: 'range', label: 'Массово' },
              { value: 'custom', label: 'По номеру' },
            ]}
          />

          {g.kind === 'product' && g.mode === 'custom' && (
            <Segmented
              label="Количество своих номеров"
              value={customInputMode}
              onChange={value => setCustomInputMode(value as 'single' | 'list')}
              options={[
                { value: 'single', label: 'Один номер' },
                { value: 'list', label: 'Список номеров' },
              ]}
            />
          )}

          {g.mode === 'range' ? (
            <div>
              <Field
                label={g.kind === 'box' ? 'Количество QR' : 'Количество стикеров'}
                help={
                  quantityCapped
                    ? `За раз выдаём не больше ${MAX_BATCH_QUANTITY} — оставили ${MAX_BATCH_QUANTITY}.`
                    : `От 1 до ${MAX_BATCH_QUANTITY} за один раз.`
                }
              >
                {/* Не type="number": браузер отдаёт пустую строку на «1e5» и
                    «--», и перехватить ввод надёжно нельзя. */}
                <Input
                  inputMode="numeric"
                  value={g.quantity ? String(g.quantity) : ''}
                  onChange={e => {
                    const digits = e.target.value.replace(/\D/g, '').replace(/^0+/, '');
                    const typed = Number(digits || 0);
                    setQuantityCapped(typed > MAX_BATCH_QUANTITY);
                    g.quantity = Math.min(typed, MAX_BATCH_QUANTITY);
                    // MobX не перерисует поле, когда число не изменилось: «0500»
                    // и «500» дают одно значение, а в DOM оставался ведущий ноль.
                    e.target.value = g.quantity ? String(g.quantity) : '';
                  }}
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
                    {n} шт
                  </button>
                ))}
              </div>
            </div>
          ) : bulkCustomMode ? (
            <BulkCustomStickerEditor authenticated={auth.isAuthenticated} onNeedPackages={onNeedPackages} />
          ) : (
            <Field
              label={g.kind === 'box' ? 'Номер коробки' : 'Номер ШК'}
              help={`Введите ровно ${codeLength} цифр. Введено: ${g.code.length} из ${codeLength}.`}
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

          {g.kind === 'box' && (
            <Field label="Префикс">
              <Input
                value={g.prefix}
                maxLength={12}
                onChange={e => (g.prefix = e.target.value.toUpperCase())}
              />
            </Field>
          )}

          {/* Код доступа обязателен: генерация без него не проходит на сервере,
              поэтому поле показывается сразу, а не прячется за ссылкой. */}
          {!bulkCustomMode && <><Field label="Код доступа" help="Код из личного кабинета или со страницы оплаты">
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
                Осталось генераций: {remaining}
              </Badge>
            )}
            {(lowQuota || !g.accessCode) && (
              <button type="button" className={s.codeToggle} onClick={onNeedPackages}>
                {g.accessCode ? 'Пополнить' : 'Купить пакет генераций'}
              </button>
            )}
          </div>

          {/* Квота кончилась — предлагаем пакет ДО нажатия, а не после. */}
          {outOfQuota && (
            <Alert tone="warning">
              Генерации по этому коду закончились.{' '}
              <button type="button" className={s.codeToggle} onClick={onNeedPackages}>
                Выбрать пакет
              </button>
            </Alert>
          )}

          <Button
            size="lg"
            block
            loading={mutation.isPending}
            disabled={!g.accessCode || invalidCustomCode || invalidQuantity}
            onClick={() => setConfirmOpen(true)}
          >
            {mutation.isPending ? 'Генерируем…' : 'Сгенерировать'}
          </Button></>}

          <p className={s.historyNote}>
            {auth.isAuthenticated ? (
              <>
                История сгенерированных стикеров сохраняется в{' '}
                <Link to="/cabinet/history">личном кабинете</Link>.
              </>
            ) : (
              <>
                После{' '}
                <Link to="/login" state={{ from: location.pathname + location.search }}>
                  авторизации
                </Link>{' '}
                история ранее сгенерированных стикеров появится в личном кабинете.
              </>
            )}
          </p>

          {/* Исчерпание лимита — не ошибка, а самый горячий момент воронки. */}
          {quotaBlocked ? (
            <Alert tone="warning">
              {mutation.error.message}{' '}
              <button type="button" className={s.codeToggle} onClick={onNeedPackages}>
                Выбрать пакет
              </button>
            </Alert>
          ) : ownerBlocked ? (
            /* Текст ошибки сервера кончается словами «Войдите под владельцем
               кода», но пойти туда было не по чему: собираем ту же фразу с
               кнопкой и возвратом на эту же страницу после входа. */
            <Alert tone="error">
              Этот код привязан к другому аккаунту.{' '}
              <Link
                className={s.alertLogin}
                to="/login"
                state={{ from: location.pathname + location.search }}
              >
                Войдите
              </Link>{' '}
              под владельцем кода.
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
              <h2>Готово</h2>
            </div>

            {previewItems.length > 0 && (
              <div className={s.previewSection}>
                <div className={s.previewControls}>
                  <strong>Сгенерированные стикеры</strong>
                  {previewCount < previewItems.length && (
                    <>
                      <Button variant="ghost" onClick={() => setPreviewCount(Math.min(previewCount + 4, previewItems.length))}>
                        Показать ещё 4
                      </Button>
                      <Button variant="ghost" onClick={() => setPreviewCount(previewItems.length)}>
                        Показать все
                      </Button>
                    </>
                  )}
                  <span className={s.count}>Показано {shown.length} из {previewItems.length}</span>
                </div>
                <div className={s.tiles}>
                  {shown.map(item => (
                    <div key={item.code || item.imageUrl} className={`${s.tile} ${previewItems.length === 1 ? s.single : ''}`}>
                      <img src={item.imageUrl} alt={`QR-код ${item.code}`} loading="lazy" />
                      <div className={s.tileActions}>
                        <button type="button" className={s.tileAction} title="Скачать изображение" aria-label={`Скачать стикер ${item.code} как изображение`} onClick={() => void downloadSticker(item)}>
                          <Download size={19} />
                        </button>
                        <button type="button" className={s.tileAction} title="Поделиться" aria-label={`Поделиться стикером ${item.code}`} onClick={() => void shareSticker(item)}>
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
                      <strong>Настройка листа</strong>
                      <p className={s.printHelp}>
                        Выберите, сколько QR-кодов или стикеров должно помещаться в одной строке листа A4.
                      </p>
                    </div>
                    <Segmented
                      label="Количество колонок на листе"
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
                    label="Сколько печатать"
                    help={`В пачке ${items.length}. Пусто — вся пачка.`}
                  >
                    <Input
                      type="number"
                      min={1}
                      max={items.length}
                      placeholder={`Все ${items.length}`}
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
                      Скачать PDF A4
                    </Button>
                  </a>
                  <a href={printUrl(true)} target="_blank" rel="noopener noreferrer">
                    <Button variant="secondary">
                      <PrinterIcon size={18} />
                      Печать
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
                <span>Осталось генераций: {remaining}</span>
              ) : (
                <span>Нужно больше стикеров?</span>
              )}
              <Button variant="ghost" size="sm" onClick={onNeedPackages}>
                Пакеты от {formatPerUnit(MIN_PER_UNIT)}
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
        title="Проверьте, что создаём"
        description="Генерации спишутся сразу после запуска, а выданные номера повторно не выдаются."
      >
        <div className="stack">
          <div className={s.confirmRow}>
            <span className="muted">Что создаём</span>
            <strong>{kindLabel}</strong>
          </div>
          <div className={s.confirmRow}>
            <span className="muted">Режим</span>
            <strong>{g.mode === 'range' ? 'Массово' : 'По номеру'}</strong>
          </div>

          {g.mode === 'range' ? (
            <div className={s.confirmRow}>
              <span className="muted">Количество</span>
              <strong>{plannedCount} шт</strong>
            </div>
          ) : (
            <div className={s.confirmRow}>
              <span className="muted">{g.kind === 'box' ? 'Номер коробки' : 'Номер ШК'}</span>
              <strong className="mono">{g.code || '—'}</strong>
            </div>
          )}

          {g.kind === 'box' && g.prefix && (
            <div className={s.confirmRow}>
              <span className="muted">Префикс</span>
              <strong className="mono">{g.prefix}</strong>
            </div>
          )}

          {remaining !== undefined && (
            <div className={s.confirmRow}>
              <span className="muted">Останется по коду</span>
              <strong>
                {leftAfter} из {remaining}
              </strong>
            </div>
          )}

          {notEnough && (
            <Alert tone="warning">
              По коду доступа осталось {remaining}, а запрошено {plannedCount}. Уменьшите количество
              или возьмите пакет.
            </Alert>
          )}

          <div className="row">
            <Button
              loading={mutation.isPending}
              disabled={!g.accessCode || notEnough || invalidCustomCode || invalidQuantity}
              onClick={() => {
                setConfirmOpen(false);
                mutation.mutate();
              }}
            >
              Создать
            </Button>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Отмена
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
});

/** Публичная главная: лендинг вокруг той же рабочей части генератора. */
export const GeneratorPage = observer(() => {
  // Ключ идёт неразорванным и слева: «Генератор возвратных ШК» разбивал фразу
  // словом посередине, и по запросу «генератор ШК» страница не находилась вовсе.
  useDocumentMeta(
    'Генератор ШК ВБ — возвратные стикеры и QR коробок',
    'Генератор ШК Wildberries: возвратные стикеры товаров и QR-коды коробок онлайн. Готовый PDF для печати, пакеты генераций от 0,27 ₽ за штуку.',
  );

  return (
    <>
      <Hero
        eyebrow="Онлайн-инструмент"
        title={
          <>
            <em>Генератор ШК ВБ</em>: возвратные стикеры и QR-коды коробок
          </>
        }
        copy={
          <>
            Создавайте возвратные ШК (штрихкоды) Wildberries для товаров и QR-коды коробок по
            номеру. Скачивайте готовый PDF либо сразу отправляйте этикетки на обычный или
            термопринтер. Генерации покупаются пакетами — <strong>от{' '}
            {formatPerUnit(MIN_PER_UNIT)}</strong> за штуку.
          </>
        }
        trust={TRUST}
      />

      <Section id="how" eyebrow="Три шага" title="Как это работает">
        <Steps steps={STEPS} />
      </Section>

      <div className="page">
        <GeneratorWorkspace onNeedPackages={goToPackages} />
        <div className="section">
          <TelegramBotPromo />
        </div>
      </div>

      <GeneratedCounter />
      <PricingPacks />

      <Section id="faq" eyebrow="Частые вопросы" title="Вопросы о генераторе">
        <Accordion items={FAQ} />
      </Section>

      <CrossSell items={[CROSS_SELL.cellPrint, CROSS_SELL.program]} />
    </>
  );
});
