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
  getLicensePack,
  iterationWord,
  LICENSE_PACK_LIST,
  POPULAR_LICENSE_PACK,
} from '../lib/pricing';
import { PROGRAM_DOWNLOAD_URL } from '../lib/downloads';
import { useDocumentMeta } from '../lib/seo';
import s from './ProgramPage.module.css';
import { useMoney } from '../lib/currency';
import { RubChargeNote } from '../components/CurrencySwitch';
import { type T, useLocale, useLocalePath, useT } from '../i18n';

type Payment = { confirmationUrl: string };

const features = (t: T) => [
  {
    Icon: Search,
    title: t('Поиск кода клиента', 'Клиент кодын іздеу'),
    text: t('Подбирает код клиента по номеру ячейки на основе доступных рабочих данных — вместо ручного перебора вариантов.', 'Қолжетімді жұмыс деректері негізінде ұяшық нөмірі бойынша клиент кодын іріктейді — нұсқаларды қолмен сұрыптаудың орнына.'),
  },
  {
    Icon: MessagesSquare,
    title: t('Проверка отзывов', 'Пікірлерді тексеру'),
    text: t('Показывает отзывы выбранного пункта выдачи и связанную с ними информацию в одном окне.', 'Таңдалған беру пунктінің пікірлерін және оларға байланысты ақпаратты бір терезеде көрсетеді.'),
  },
  {
    Icon: Package,
    title: t('Товары клиента', 'Клиент тауарлары'),
    text: t('Список товаров в заказе и история — чтобы не переключаться между вкладками во время выдачи.', 'Тапсырыстағы тауарлар тізімі мен тарих — беру кезінде қойындылар арасында ауыспау үшін.'),
  },
  {
    Icon: RefreshCw,
    title: t('Автообновление', 'Автожаңарту'),
    text: t('Программа сама проверяет наличие новой версии и показывает, что именно изменилось.', 'Бағдарлама жаңа нұсқаның бар-жоғын өзі тексеріп, нақты не өзгергенін көрсетеді.'),
  },
];

const steps = (t: T) => [
  {
    title: t('Скачайте установщик', 'Орнатқышты жүктеп алыңыз'),
    text: t('Бесплатно и без регистрации: кнопка на этой странице сразу отдаёт файл.', 'Тегін және тіркелусіз: осы беттегі батырма файлды бірден береді.'),
  },
  {
    title: t('Установите программу', 'Бағдарламаны орнатыңыз'),
    text: t('Обычный установщик для Windows: ярлык на рабочем столе и пункт в меню «Пуск».', 'Windows үшін кәдімгі орнатқыш: жұмыс үстеліндегі белгіше және «Пуск» мәзіріндегі пункт.'),
  },
  {
    title: t('Купите итерации и активируйте ключ', 'Итерацияларды сатып алып, кілтті белсендіріңіз'),
    text: t('Введите ключ в программе — и можно искать. Платите только за успешные подборы.', 'Кілтті бағдарламаға енгізіңіз — іздей беруге болады. Тек сәтті іріктеулер үшін төлейсіз.'),
  },
];

const specs = (t: T) => [
  {
    term: t('Операционная система', 'Операциялық жүйе'),
    value: t('Windows 10 и Windows 11. Для Windows 7 собирается отдельная версия.', 'Windows 10 және Windows 11. Windows 7 үшін бөлек нұсқа жиналады.'),
  },
  {
    term: t('Размер установщика', 'Орнатқыш көлемі'),
    value: t('Около 16 МБ для Windows 10/11, около 19 МБ для сборки под Windows 7.', 'Windows 10/11 үшін шамамен 16 МБ, Windows 7 жинағы үшін шамамен 19 МБ.'),
  },
  {
    term: t('Установка', 'Орнату'),
    value: t('Обычный установщик: ярлык на рабочем столе и пункт в меню «Пуск», удаление — штатное.', 'Кәдімгі орнатқыш: жұмыс үстеліндегі белгіше және «Пуск» мәзіріндегі пункт, жою — стандартты.'),
  },
  {
    term: t('Интернет', 'Интернет'),
    value: t('Нужен для активации ключа, списания итераций и проверки обновлений.', 'Кілтті белсендіру, итерацияларды есептен шығару және жаңартуларды тексеру үшін қажет.'),
  },
  {
    term: t('Хранение данных', 'Деректерді сақтау'),
    value: t('Настройки и локальные данные хранятся на вашем компьютере в папке профиля.', 'Баптаулар мен жергілікті деректер компьютеріңіздегі профиль қалтасында сақталады.'),
  },
  {
    term: t('Текущая версия', 'Ағымдағы нұсқа'),
    value: t('1.3.4 — устаревшие ежедневные коды больше не показываются и не списывают итерацию.', '1.3.4 — ескірген күнделікті кодтар енді көрсетілмейді және итерацияны есептен шығармайды.'),
  },
];

const faq = (t: T) => [
  {
    q: t('Что такое итерация?', 'Итерация деген не?'),
    a: t('Итерация — это один успешный подбор кода. Программа списывает её только тогда, когда код действительно найден.', 'Итерация — бұл кодты бір рет сәтті іріктеу. Бағдарлама оны код шынымен табылғанда ғана есептен шығарады.'),
  },
  {
    q: t('Списывается ли итерация, если код не найден?', 'Код табылмаса, итерация есептен шығарыла ма?'),
    a: t('Нет. Если подбор не дал результата, итерация остаётся на ключе. Вы платите только за результат.', 'Жоқ. Іріктеу нәтиже бермесе, итерация кілтте қалады. Сіз тек нәтиже үшін төлейсіз.'),
  },
  {
    q: t('Сгорает ли ключ по времени?', 'Кілттің мерзімі өте ме?'),
    a: t('Нет. Ключ действует до полного использования купленных итераций и не имеет срока годности.', 'Жоқ. Кілт сатып алынған итерациялар толық пайдаланылғанша жарамды және жарамдылық мерзімі жоқ.'),
  },
  {
    q: t('Работает ли программа на Windows 7?', 'Бағдарлама Windows 7-де жұмыс істей ме?'),
    a: t('Да. Кроме основной сборки для Windows 10 и 11 есть отдельная сборка для Windows 7 — напишите в поддержку, если нужна именно она.', 'Иә. Windows 10 және 11-ге арналған негізгі жинақтан бөлек Windows 7-ге арналған жинақ бар — дәл сол керек болса, қолдау қызметіне жазыңыз.'),
  },
  {
    q: t('Как скачать программу?', 'Бағдарламаны қалай жүктеп алуға болады?'),
    a: t('Кнопка «Скачать бесплатно» на этой странице сразу отдаёт установщик — оплата и регистрация для скачивания не нужны. Платными остаются только итерации подбора.', 'Осы беттегі «Тегін жүктеп алу» батырмасы орнатқышты бірден береді — жүктеу үшін төлем мен тіркелу қажет емес. Тек іріктеу итерациялары ақылы.'),
  },
  {
    q: t('Можно ли перенести программу на другой компьютер?', 'Бағдарламаны басқа компьютерге ауыстыруға бола ма?'),
    a: t('Да. Установите программу на другом компьютере и введите тот же ключ — остаток итераций хранится на сервере, а не на конкретном ПК.', 'Иә. Бағдарламаны басқа компьютерге орнатып, сол кілтті енгізіңіз — итерациялар қалдығы нақты ДК-де емес, серверде сақталады.'),
  },
  {
    q: t('Почему антивирус может ругаться на установщик?', 'Неліктен антивирус орнатқышқа ескерту беруі мүмкін?'),
    a: t('Установщик собран из Python-кода и не имеет платной цифровой подписи, поэтому отдельные антивирусы показывают предупреждение о неизвестном издателе. Скачивайте файл только с этой страницы.', 'Орнатқыш Python кодынан жиналған және ақылы цифрлық қолтаңбасы жоқ, сондықтан кейбір антивирустар белгісіз баспагер туралы ескерту көрсетеді. Файлды тек осы беттен жүктеп алыңыз.'),
  },
  {
    q: t('Куда писать, если что-то не работает?', 'Бірдеңе жұмыс істемесе, қайда жазу керек?'),
    a: t('В Telegram @roma_denosov — поможем с установкой, активацией ключа и обновлением.', 'Telegram-да @roma_denosov — орнатуға, кілтті белсендіруге және жаңартуға көмектесеміз.'),
  },
];

function goToIterations() {
  document.getElementById('iterations')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function ProgramPage() {
  const { formatTotal, formatPerUnit } = useMoney();
  const t = useT();
  const locale = useLocale();
  const lp = useLocalePath();
  useDocumentMeta(
    t('Подбор кодов — программа для ПВЗ Wildberries на Windows', 'Кодтарды іріктеу — Windows-қа арналған Wildberries БП бағдарламасы'),
    t(
      'Программа находит код клиента по номеру ячейки, показывает товары заказа и отзывы ПВЗ. Скачивание бесплатное, списание только за успешный подбор.',
      'Бағдарлама ұяшық нөмірі бойынша клиент кодын табады, тапсырыс тауарлары мен БП пікірлерін көрсетеді. Жүктеу тегін, тек сәтті іріктеу үшін ақы алынады.',
    ),
  );
  const iterations$ = (n: number) => `${n} ${iterationWord(n, locale)}`;

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
        eyebrow={t('Программа для Windows · версия 1.3.4', 'Windows бағдарламасы · 1.3.4 нұсқасы')}
        title={
          <>
            {t('Подбор', 'Ұяшық нөмірі бойынша')} <em>{t('кодов клиента', 'клиент кодтарын')}</em> {t('по номеру ячейки', 'іріктеу')}
          </>
        }
        copy={
          <>
            {t(
              'Находит код клиента по номеру ячейки, показывает товары заказа и отзывы — без ручного перебора.',
              'Ұяшық нөмірі бойынша клиент кодын табады, тапсырыс тауарлары мен пікірлерді көрсетеді — қолмен сұрыптаусыз.',
            )}{' '}
            <strong>{t('Программа скачивается бесплатно', 'Бағдарлама тегін жүктеледі')}</strong>
            {t(', вы платите только за успешные подборы.', ', сіз тек сәтті іріктеулер үшін төлейсіз.')}
          </>
        }
        trust={[
          t('Скачивание без оплаты и регистрации', 'Төлемсіз және тіркелусіз жүктеу'),
          t('Windows 7, 10 и 11', 'Windows 7, 10 және 11'),
          t('Списание только за найденный код', 'Тек табылған код үшін ақы алынады'),
          t('Данные остаются на вашем ПК', 'Деректер сіздің ДК-де қалады'),
        ]}
      >
        <div className={s.heroActions}>
          <a href={PROGRAM_DOWNLOAD_URL}>
            <Button size="lg">
              <Download size={18} />
              {t('Скачать бесплатно', 'Тегін жүктеп алу')}
            </Button>
          </a>
          <Button size="lg" variant="secondary" onClick={goToIterations}>
            {t('Смотреть тарифы', 'Тарифтерді көру')}
          </Button>
        </div>
      </Hero>

      <div className="page">
        <div className="grid grid-3">
          <Card>
            <Stat
              value={t('Бесплатно', 'Тегін')}
              label={t('скачивание программы', 'бағдарламаны жүктеу')}
              icon={<Download size={20} />}
            />
          </Card>
          <Card>
            <Stat
              value={t(`от ${formatPerUnit(getLicensePack(20).perUnit)}`, `${formatPerUnit(getLicensePack(20).perUnit)} бастап`)}
              label={t('за успешный подбор', 'сәтті іріктеу үшін')}
              icon={<Target size={20} />}
            />
          </Card>
          <Card>
            <Stat
              value={t('Без срока', 'Мерзімсіз')}
              label={t('ключ не сгорает по времени', 'кілттің мерзімі өтпейді')}
              icon={<RefreshCw size={20} />}
            />
          </Card>
        </div>

        <Card accent className="section">
          <div className={s.buy}>
            <div className="stack">
              <Badge tone="accent">{t('Бесплатное скачивание', 'Тегін жүктеу')}</Badge>
              <h2>{t('Программа для Windows', 'Windows бағдарламасы')}</h2>
              <p className="muted" style={{ margin: 0 }}>
                {t(
                  'Установщик отдаётся сразу: оплата и регистрация нужны только для итераций подбора.',
                  'Орнатқыш бірден беріледі: төлем мен тіркелу тек іріктеу итерациялары үшін қажет.',
                )}
              </p>
              <ul className={s.bullets}>
                <li>{t('Установщик для Windows 10 и 11, отдельная сборка для Windows 7', 'Windows 10 және 11 үшін орнатқыш, Windows 7 үшін бөлек жинақ')}</li>
                <li>{t('Все функции программы без урезаний', 'Бағдарламаның барлық функциялары шектеусіз')}</li>
                <li>{t('Бесплатные обновления — программа проверяет их сама', 'Тегін жаңартулар — бағдарлама оларды өзі тексереді')}</li>
                <li>{t('Поддержка в Telegram по установке и запуску', 'Орнату және іске қосу бойынша Telegram-дағы қолдау')}</li>
              </ul>
            </div>

            <div className="stack">
              <div className={s.priceLine}>
                <span className={s.priceValue}>{formatTotal(0)}</span>
                <span className={s.priceLabel}>{t('скачивание', 'жүктеу')}</span>
              </div>

              <a href={PROGRAM_DOWNLOAD_URL}>
                <Button size="lg" block>
                  <Download size={18} />
                  {t('Скачать бесплатно', 'Тегін жүктеп алу')}
                </Button>
              </a>

              <p className={s.note}>
                {t(
                  'Первый успешный подбор возможен без ключа — дальше нужны итерации, они покупаются ниже на этой странице.',
                  'Алғашқы сәтті іріктеу кілтсіз мүмкін — әрі қарай итерациялар қажет, олар осы беттің төменгі жағында сатылады.',
                )}
              </p>
            </div>
          </div>
        </Card>
      </div>

      <Section
        tone="band"
        eyebrow={t('Возможности', 'Мүмкіндіктер')}
        title={t('Что умеет программа', 'Бағдарлама не істей алады')}
        lead={t(
          'Программа работает с теми рабочими данными ПВЗ, к которым у вас уже есть доступ, и ускоряет рутинные операции на выдаче.',
          'Бағдарлама сізде қолжетімділік бар БП жұмыс деректерімен жұмыс істейді және беру кезіндегі күнделікті операцияларды жылдамдатады.',
        )}
      >
        <FeatureGrid items={features(t)} />
        <p className={s.disclaimer}>
          {t(
            'Программа предназначена только для работы с данными, к которым у вас есть законный рабочий доступ.',
            'Бағдарлама тек сізде заңды жұмыс қолжетімділігі бар деректермен жұмыс істеуге арналған.',
          )}
        </p>
      </Section>

      <Section eyebrow={t('Три шага', 'Үш қадам')} title={t('Как начать работу', 'Жұмысты қалай бастау керек')}>
        <Steps steps={steps(t)} />
      </Section>

      <Section
        id="iterations"
        eyebrow={t('Ключи активации', 'Белсендіру кілттері')}
        title={t('Итерации — за что вы платите', 'Итерациялар — сіз не үшін төлейсіз')}
        lead={t(
          'Одна итерация — это один успешно найденный код. Если подбор не дал результата, итерация не списывается: вы платите за результат, а не за попытку. Ключ не сгорает по времени и действует до полного использования купленного лимита.',
          'Бір итерация — бұл сәтті табылған бір код. Іріктеу нәтиже бермесе, итерация есептен шығарылмайды: сіз әрекет үшін емес, нәтиже үшін төлейсіз. Кілттің мерзімі өтпейді және сатып алынған лимит толық пайдаланылғанша жарамды.',
        )}
      >
        <div className={s.packs} role="radiogroup" aria-label={t('Пакеты итераций', 'Итерация пакеттері')}>
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
                {popular && <span className={s.ribbon}>{t('Чаще всего берут', 'Ең жиі алады')}</span>}
                {active && <CircleCheck size={18} className={s.check} aria-hidden="true" />}
                <span className={s.packQty}>
                  {iterations$(pack.quantity)}
                </span>
                <span className={s.packTotal}>{formatTotal(pack.total)}</span>
                <span className={s.packUnit}>{t(`${formatPerUnit(pack.perUnit)} за подбор`, `бір іріктеуге ${formatPerUnit(pack.perUnit)}`)}</span>
              </button>
            );
          })}
        </div>

        <div className={s.checkout}>
          <div className={s.summary}>
            <span className="muted">
              {iterations$(selected.quantity)} {t('по', '×')} {formatPerUnit(selected.perUnit)}
            </span>
            <span className={s.summaryTotal}>{formatTotal(selected.total)}</span>
          </div>

          <Checkbox
            id="iterations-offer"
            checked={acceptedPack}
            onChange={e => setAcceptedPack(e.target.checked)}
          >
{t('Принимаю', 'Мен')}{' '}
            <a className="accent" href={lp('/offer')}>
              {t('оферту', 'офертаны')}
            </a>{' '}
            {t('и', 'және')}{' '}
            <a className="accent" href={lp('/privacy')}>
              {t('политику конфиденциальности', 'құпиялылық саясатын')}
            </a>
            {t('', ' қабылдаймын')}
          </Checkbox>

          <Button
            size="lg"
            disabled={!acceptedPack}
            loading={buyPack.isPending}
            onClick={() => buyPack.mutate()}
          >
            {t(
              `Купить ${iterations$(selected.quantity)} за ${formatTotal(selected.total)}`,
              `${iterations$(selected.quantity)} — ${formatTotal(selected.total)} сатып алу`,
            )}
          </Button>

          <RubChargeNote rub={selected.total} />

          {buyPack.isError && <Alert tone="error">{buyPack.error.message}</Alert>}

          <p className={s.note}>
            {t(
              `Чем больше пакет, тем дешевле итерация: ${formatPerUnit(single.perUnit)} за одну и ${formatPerUnit(getLicensePack(20).perUnit)} при покупке 20 штук.`,
              `Пакет неғұрлым үлкен болса, итерация соғұрлым арзан: біреуі ${formatPerUnit(single.perUnit)}, ал 20 дана алғанда ${formatPerUnit(getLicensePack(20).perUnit)}.`,
            )}
          </p>
        </div>
      </Section>

      <Section eyebrow={t('Перед покупкой', 'Сатып алмас бұрын')} title={t('Системные требования', 'Жүйелік талаптар')}>
        <SpecList items={specs(t)} />
      </Section>

      <Section eyebrow={t('Частые вопросы', 'Жиі қойылатын сұрақтар')} title={t('О покупке, итерациях и установке', 'Сатып алу, итерациялар және орнату туралы')}>
        <Accordion items={faq(t)} />
      </Section>

      <CrossSell
        items={[CROSS_SELL.cellPrint, CROSS_SELL.generator]}
        title={t('Нужна автоматическая печать ячеек?', 'Ұяшықтарды автоматты басып шығару керек пе?')}
        lead={t(
          '«Печать ячеек» работает в фоне вместе с WB_PVZ: находит ячейку после сканирования товара и сразу отправляет этикетку на термопринтер.',
          '«Ұяшық басып шығару» WB_PVZ-мен бірге фондық режимде жұмыс істейді: тауарды сканерлегеннен кейін ұяшықты тауып, заттаңбаны бірден термопринтерге жібереді.',
        )}
      />
    </>
  );
}
