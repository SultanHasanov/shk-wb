import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import {
  Check,
  CircleCheck,
  Download,
  KeyRound,
  LayoutGrid,
  Laptop,
  MessagesSquare,
  Minus,
  Printer,
  Search,
  Send,
  Truck,
  UserRound,
  Users,
} from 'lucide-react';
import { api } from '../api/client';
import { type AppPlans, useAppPlans } from '../api/app';
import { Hero } from '../components/Hero';
import { Section } from '../components/Section';
import { Steps } from '../components/Steps';
import { FeatureGrid } from '../components/FeatureGrid';
import { SpecList } from '../components/SpecList';
import { CROSS_SELL, CrossSell } from '../components/CrossSell';
import { Accordion, Alert, Button, Card, Checkbox, Segmented, Stat } from '../ui';
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

/** Версия на странице — держать в согласии с downloads/version.json. */
const APP_VERSION = '1.4.2';

const features = (t: T) => [
  {
    Icon: KeyRound,
    title: t('Подбор кода клиента', 'Клиент кодын іріктеу'),
    text: t('Находит код выдачи по номеру ячейки, показывает QR и копирует в один клик. Найденный код запоминается до конца дня.', 'Ұяшық нөмірі бойынша беру кодын табады, QR көрсетеді және бір басумен көшіреді. Табылған код күн соңына дейін сақталады.'),
  },
  {
    Icon: LayoutGrid,
    title: t('Ячейки и карточка клиента', 'Ұяшықтар және клиент картасы'),
    text: t('Все ячейки пункта с товарами и фото, поиск по SID и телефону — без переключения между окнами.', 'Пункттің барлық ұяшықтары тауарлар мен фотосуреттермен, SID және телефон бойынша іздеу — терезелер арасында ауыспай.'),
  },
  {
    Icon: Truck,
    title: t('Товары «В пути»', '«Жолдағы» тауарлар'),
    text: t('Что едет на пункт и кому — таблица с SID, телефоном и составом заказа.', 'Пунктке не және кімге келе жатыр — SID, телефон және тапсырыс құрамы бар кесте.'),
  },
  {
    Icon: MessagesSquare,
    title: t('Отзывы WB', 'WB пікірлері'),
    text: t('Отзывы о пункте выдачи прямо в программе, со сводкой по клиенту.', 'Беру пункті туралы пікірлер тікелей бағдарламада, клиент бойынша жиынтықпен.'),
  },
  {
    Icon: UserRound,
    title: t('Досье клиента', 'Клиент досьесі'),
    text: t('История клиента: отказы, возвраты и категории товаров — чтобы видеть картину до выдачи.', 'Клиент тарихы: бас тартулар, қайтарулар және тауар санаттары — беруге дейін жағдайды көру үшін.'),
  },
  {
    Icon: Printer,
    title: t('Стикеры товаров и коробок', 'Тауар мен қорап стикерлері'),
    text: t('Генерация и печать стикеров из программы на термопринтер или в PDF.', 'Бағдарламадан стикерлерді жасау және термопринтерге немесе PDF-ке басып шығару.'),
  },
  {
    Icon: Users,
    title: t('Сотрудники и зарплата', 'Қызметкерлер және жалақы'),
    text: t('Список сотрудников, календарь смен, ставка и расчёт зарплаты за месяц.', 'Қызметкерлер тізімі, ауысымдар күнтізбесі, мөлшерлеме және айлық жалақыны есептеу.'),
  },
  {
    Icon: Send,
    title: t('Уведомления в Telegram', 'Telegram хабарламалары'),
    text: t('Свой бот присылает сообщения о важных событиях на пункте.', 'Өз ботыңыз пункттегі маңызды оқиғалар туралы хабарлама жібереді.'),
  },
];

const steps = (t: T) => [
  {
    title: t('Скачайте установщик', 'Орнатқышты жүктеп алыңыз'),
    text: t('Бесплатно и без регистрации: кнопка на этой странице сразу отдаёт файл.', 'Тегін және тіркелусіз: осы беттегі батырма файлды бірден береді.'),
  },
  {
    title: t('Войдите аккаунтом сайта', 'Сайт аккаунтымен кіріңіз'),
    text: t('Тот же логин и пароль, что на shk-wb.ru, или подтверждение входа через сайт.', 'shk-wb.ru сайтындағы логин мен құпиясөз немесе сайт арқылы кіруді растау.'),
  },
  {
    title: t('Выберите тариф', 'Тарифті таңдаңыз'),
    text: t('Оформите подписку в кабинете — тариф включится в программе сразу после оплаты.', 'Кабинетте жазылымды рәсімдеңіз — тариф төлемнен кейін бағдарламада бірден қосылады.'),
  },
];

const specs = (t: T) => [
  {
    term: t('Операционная система', 'Операциялық жүйе'),
    value: t('Windows 10 и Windows 11, 64 бит.', 'Windows 10 және Windows 11, 64 бит.'),
  },
  {
    term: t('Размер установщика', 'Орнатқыш көлемі'),
    value: t('Около 4 МБ.', 'Шамамен 4 МБ.'),
  },
  {
    term: t('Установка', 'Орнату'),
    value: t('Обычный установщик: ярлык на рабочем столе и пункт в меню «Пуск». Прежняя программа «Подбор кодов» заменяется автоматически.', 'Кәдімгі орнатқыш: жұмыс үстеліндегі белгіше және «Пуск» мәзіріндегі пункт. Бұрынғы «Кодтарды іріктеу» бағдарламасы автоматты түрде ауыстырылады.'),
  },
  {
    term: t('Интернет', 'Интернет'),
    value: t('Нужен для входа, проверки тарифа и обновлений. Без связи программа работает до часа.', 'Кіру, тарифті және жаңартуларды тексеру үшін қажет. Байланыссыз бағдарлама бір сағатқа дейін жұмыс істейді.'),
  },
  {
    term: t('Хранение данных', 'Деректерді сақтау'),
    value: t('База пункта читается только для просмотра и не покидает ваш компьютер.', 'Пункт базасы тек қарау үшін оқылады және компьютеріңізден шықпайды.'),
  },
  {
    term: t('Текущая версия', 'Ағымдағы нұсқа'),
    value: APP_VERSION,
  },
];

const faq = (t: T) => [
  {
    q: t('Чем отличаются тарифы?', 'Тарифтер немен ерекшеленеді?'),
    a: t('Базовый — только подбор кода. Стандарт добавляет ячейки, товары «В пути», поиск, отзывы и дорогие товары. Про — ещё досье клиента, стикеры, сотрудников и до двух компьютеров.', 'Базалық — тек код іріктеу. Стандарт ұяшықтарды, «Жолдағы» тауарларды, іздеуді, пікірлер мен қымбат тауарларды қосады. Про — бұған қоса клиент досьесі, стикерлер, қызметкерлер және екі компьютерге дейін.'),
  },
  {
    q: t('Что будет, если подборы в месяце закончились?', 'Айдағы іріктеулер біткенде не болады?'),
    a: t('Программа продолжит подбирать коды за счёт пакетов подборов. Пакеты не сгорают и покупаются ниже на этой странице.', 'Бағдарлама іріктеу пакеттері есебінен кодтарды іріктеуді жалғастырады. Пакеттердің мерзімі өтпейді және осы беттің төменгі жағында сатылады.'),
  },
  {
    q: t('Списывается ли подбор, если код не найден?', 'Код табылмаса, іріктеу есептен шығарыла ма?'),
    a: t('Нет. Подбор списывается только за найденный код. Если поиск остановить, лимит тоже не тратится.', 'Жоқ. Іріктеу тек табылған код үшін есептен шығарылады. Іздеуді тоқтатсаңыз, лимит те жұмсалмайды.'),
  },
  {
    q: t('У меня был ключ «Подбора кодов». Он пропадёт?', 'Менде «Кодтарды іріктеу» кілті болған. Ол жоғала ма?'),
    a: t('Нет. Остаток ключа становится пакетом подборов: после входа в программу ключ с этого компьютера сам привяжется к аккаунту.', 'Жоқ. Кілт қалдығы іріктеу пакетіне айналады: бағдарламаға кіргеннен кейін осы компьютердегі кілт аккаунтқа өзі байланады.'),
  },
  {
    q: t('Можно ли работать на нескольких компьютерах?', 'Бірнеше компьютерде жұмыс істеуге бола ма?'),
    a: t('На тарифах Базовый и Стандарт — один компьютер, на Про — до двух. Отключить старый компьютер можно в кабинете в разделе «Подписка».', 'Базалық және Стандарт тарифтерінде — бір компьютер, Про-да — екіге дейін. Ескі компьютерді кабинеттегі «Жазылым» бөлімінде ажыратуға болады.'),
  },
  {
    q: t('Как скачать программу?', 'Бағдарламаны қалай жүктеп алуға болады?'),
    a: t('Кнопка «Скачать бесплатно» на этой странице сразу отдаёт установщик — оплата и регистрация для скачивания не нужны.', 'Осы беттегі «Тегін жүктеп алу» батырмасы орнатқышты бірден береді — жүктеу үшін төлем мен тіркелу қажет емес.'),
  },
  {
    q: t('Куда писать, если что-то не работает?', 'Бірдеңе жұмыс істемесе, қайда жазу керек?'),
    a: t('В Telegram @roma_denosov — поможем с установкой, входом и оплатой.', 'Telegram-да @roma_denosov — орнатуға, кіруге және төлеуге көмектесеміз.'),
  },
];

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function monthsWord(n: number, t: T) {
  if (n === 1) return t('1 месяц', '1 ай');
  if (n < 5) return t(`${n} месяца`, `${n} ай`);
  return t(`${n} месяцев`, `${n} ай`);
}

function PlanCards({ plans }: { plans: AppPlans }) {
  const t = useT();
  const lp = useLocalePath();
  const { formatTotal } = useMoney();
  const [months, setMonths] = useState(1);

  return (
    <>
      <div className={s.plansHead}>
        <Segmented
          label={t('Срок подписки', 'Жазылым мерзімі')}
          value={String(months)}
          onChange={v => setMonths(Number(v))}
          options={plans.terms.map(term => ({
            value: String(term.months),
            label: term.discountPercent ? `${monthsWord(term.months, t)} −${term.discountPercent}%` : monthsWord(term.months, t),
          }))}
        />
      </div>
      <div className={s.plans}>
        {plans.plans.map(plan => {
          const price = plan.prices[String(months)];
          const popular = plan.id === 'standard';
          return (
            <div key={plan.id} className={`${s.plan} ${popular ? s.planPopular : ''}`}>
              {popular && <span className={s.ribbon}>{t('Чаще всего берут', 'Ең жиі алады')}</span>}
              <h3 className={s.planName}>{plan.title}</h3>
              <p className="muted" style={{ margin: 0 }}>{plan.summary}</p>
              <div>
                <div className={s.planPrice}>{formatTotal(price)}</div>
                <div className={s.planPer}>
                  {months > 1
                    ? t(`за ${monthsWord(months, t)} · ${formatTotal(Math.round(price / months))} в месяц`, `${monthsWord(months, t)} · айына ${formatTotal(Math.round(price / months))}`)
                    : t('в месяц', 'айына')}
                </div>
              </div>
              <ul className={s.limits}>
                <li>{t(`${plan.codes} подборов кода в месяц`, `Айына ${plan.codes} код іріктеу`)}</li>
                {plan.stickers > 0 && <li>{t(`${plan.stickers} стикеров в месяц`, `Айына ${plan.stickers} стикер`)}</li>}
                <li>{plan.devices === 1 ? t('1 компьютер', '1 компьютер') : t(`До ${plan.devices} компьютеров`, `${plan.devices} компьютерге дейін`)}</li>
              </ul>
              <ul className={s.planFeatures}>
                {Object.entries(plans.features).map(([id, title]) => {
                  const on = plan.features.includes(id);
                  return (
                    <li key={id} className={on ? '' : s.off}>
                      {on ? <Check size={16} className={s.featureCheck} /> : <Minus size={16} />}
                      {title}
                    </li>
                  );
                })}
              </ul>
              <Link className={s.planAction} to={lp('/cabinet/subscription')}>
                <Button variant={popular ? 'primary' : 'secondary'}>{t('Оформить', 'Рәсімдеу')}</Button>
              </Link>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function ProgramPage() {
  const { formatTotal, formatPerUnit } = useMoney();
  const t = useT();
  const locale = useLocale();
  const lp = useLocalePath();
  const plans = useAppPlans();
  useDocumentMeta(
    t('Помощник ПВЗ — программа для ПВЗ Wildberries на Windows', '«ПВЗ көмекшісі» — Windows-қа арналған Wildberries БП бағдарламасы'),
    t(
      'Подбор кода клиента по номеру ячейки, ячейки и товары «В пути», отзывы, досье клиента, стикеры и сотрудники. Скачивание бесплатное, тарифы от месяца.',
      'Ұяшық нөмірі бойынша клиент кодын іріктеу, ұяшықтар мен «Жолдағы» тауарлар, пікірлер, клиент досьесі, стикерлер және қызметкерлер. Жүктеу тегін, тарифтер бір айдан.',
    ),
  );
  const iterations$ = (n: number) => `${n} ${iterationWord(n, locale)}`;

  const [acceptedPack, setAcceptedPack] = useState(false);
  const [iterations, setIterations] = useState<number>(POPULAR_LICENSE_PACK);

  const selected = getLicensePack(iterations);
  const minPrice = plans.data ? Math.min(...plans.data.plans.map(p => p.monthlyPrice)) : null;

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
        eyebrow={t(`Программа для Windows · версия ${APP_VERSION}`, `Windows бағдарламасы · ${APP_VERSION} нұсқасы`)}
        title={
          <>
            {t('«Помощник ПВЗ» —', '«ПВЗ көмекшісі» —')} <em>{t('вся выдача', 'бүкіл беру')}</em> {t('в одном окне', 'бір терезеде')}
          </>
        }
        copy={
          <>
            {t(
              'Подбор кода клиента по номеру ячейки, ячейки и товары «В пути», отзывы, досье клиента, стикеры и сотрудники.',
              'Ұяшық нөмірі бойынша клиент кодын іріктеу, ұяшықтар мен «Жолдағы» тауарлар, пікірлер, клиент досьесі, стикерлер және қызметкерлер.',
            )}{' '}
            <strong>{t('Программа скачивается бесплатно', 'Бағдарлама тегін жүктеледі')}</strong>
            {t(', вход — тем же аккаунтом, что на сайте.', ', кіру — сайттағы аккаунтпен.')}
          </>
        }
        trust={[
          t('Скачивание без оплаты и регистрации', 'Төлемсіз және тіркелусіз жүктеу'),
          t('Windows 10 и 11', 'Windows 10 және 11'),
          t('Подбор списывается только за найденный код', 'Іріктеу тек табылған код үшін есептеледі'),
          t('Данные пункта остаются на вашем ПК', 'Пункт деректері сіздің ДК-де қалады'),
        ]}
      >
        <div className={s.heroActions}>
          <a href={PROGRAM_DOWNLOAD_URL}>
            <Button size="lg">
              <Download size={18} />
              {t('Скачать бесплатно', 'Тегін жүктеп алу')}
            </Button>
          </a>
          <Button size="lg" variant="secondary" onClick={() => scrollTo('plans')}>
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
              value={minPrice != null ? t(`от ${formatTotal(minPrice)}`, `${formatTotal(minPrice)} бастап`) : t('3 тарифа', '3 тариф')}
              label={t('в месяц, скидка до 25% за срок', 'айына, мерзім үшін 25%-ға дейін жеңілдік')}
              icon={<Search size={20} />}
            />
          </Card>
          <Card>
            <Stat
              value={t('До 2 ПК', '2 ДК-ге дейін')}
              label={t('на одном аккаунте', 'бір аккаунтта')}
              icon={<Laptop size={20} />}
            />
          </Card>
        </div>
      </div>

      <Section
        tone="band"
        eyebrow={t('Возможности', 'Мүмкіндіктер')}
        title={t('Что умеет программа', 'Бағдарлама не істей алады')}
        lead={t(
          'Программа читает базу пункта выдачи на вашем компьютере и собирает в одном окне то, что обычно ищут по разным вкладкам.',
          'Бағдарлама компьютеріңіздегі беру пунктінің базасын оқып, әдетте әртүрлі қойындылардан ізделетін нәрсені бір терезеге жинайды.',
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
        id="plans"
        eyebrow={t('Тарифы', 'Тарифтер')}
        title={t('Подписка на «Помощник ПВЗ»', '«ПВЗ көмекшісіне» жазылым')}
        lead={t(
          'Лимиты обновляются каждый месяц, даже при оплате на несколько месяцев вперёд. Повысить тариф можно в любой момент — оставшиеся дни пересчитаются.',
          'Лимиттер ай сайын жаңарады, бірнеше айға алдын ала төлегенде де. Тарифті кез келген уақытта көтеруге болады — қалған күндер қайта есептеледі.',
        )}
      >
        {plans.data?.freeMode && (
          <Alert tone="success">
            {t(
              'Сейчас все функции программы бесплатны: скачайте её и войдите аккаунтом сайта — тариф Про включится сам, подборы не списываются.',
              'Қазір бағдарламаның барлық функциялары тегін: оны жүктеп алып, сайт аккаунтымен кіріңіз — Про тарифі өзі қосылады, іріктеулер есептелмейді.',
            )}
          </Alert>
        )}
        {plans.data ? (
          <PlanCards plans={plans.data} />
        ) : plans.isError ? (
          <Alert tone="error">
            {t('Не удалось загрузить тарифы. Их можно посмотреть в ', 'Тарифтерді жүктеу мүмкін болмады. Оларды ')}
            <Link className="accent" to={lp('/cabinet/subscription')}>{t('кабинете', 'кабинеттен')}</Link>
            {t('.', ' көруге болады.')}
          </Alert>
        ) : (
          <p className="muted">{t('Загружаем тарифы…', 'Тарифтер жүктелуде…')}</p>
        )}
      </Section>

      <Section
        id="iterations"
        eyebrow={t('Сверх лимита', 'Лимиттен тыс')}
        title={t('Пакеты подборов', 'Іріктеу пакеттері')}
        lead={t(
          'Если подборов в месяце не хватило, программа берёт их из пакетов. Пакет не сгорает по времени, а подбор списывается только за найденный код. Без подписки пакеты работают в режиме «только подбор кода».',
          'Айдағы іріктеулер жетпесе, бағдарлама оларды пакеттерден алады. Пакеттің мерзімі өтпейді, ал іріктеу тек табылған код үшін есептеледі. Жазылымсыз пакеттер «тек код іріктеу» режимінде жұмыс істейді.',
        )}
      >
        <div className={s.packs} role="radiogroup" aria-label={t('Пакеты подборов', 'Іріктеу пакеттері')}>
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
              'После оплаты выдаётся ключ пакета. Войдите в программу аккаунтом сайта — пакет привяжется к нему сам.',
              'Төлемнен кейін пакет кілті беріледі. Бағдарламаға сайт аккаунтымен кіріңіз — пакет оған өзі байланады.',
            )}
          </p>
        </div>
      </Section>

      <Section eyebrow={t('Перед установкой', 'Орнатпас бұрын')} title={t('Системные требования', 'Жүйелік талаптар')}>
        <SpecList items={specs(t)} />
      </Section>

      <Section eyebrow={t('Частые вопросы', 'Жиі қойылатын сұрақтар')} title={t('О тарифах, подборах и установке', 'Тарифтер, іріктеулер және орнату туралы')}>
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
