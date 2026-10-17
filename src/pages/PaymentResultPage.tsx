import { useEffect } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { ArrowRight, Copy, Download, KeyRound } from 'lucide-react';
import { api } from '../api/client';
import { useStores } from '../stores/root-store';
import { Hero } from '../components/Hero';
import { Alert, Button, Card, EmptyState, Skeleton, Spinner, useToast } from '../ui';
import { formatTotal } from '../lib/pricing';
import { useDocumentMeta } from '../lib/seo';
import { BOT_URL, SUPPORT_URL, SUPPORT_USERNAME } from '../lib/telegram';
import { cabinetKey } from '../api/cabinet';
import { forgetPendingOrder } from '../lib/pending-orders';
import { type Text, useLocale, useLocalePath, useT } from '../i18n';
import s from './PaymentResultPage.module.css';

type Order = {
  status: 'pending' | 'succeeded' | 'canceled' | string;
  productKind: string;
  /** Сколько генераций в пакете — они общие на все виды стикеров. */
  quantity?: number;
  amount: number;
  accessCode?: string | null;
  licenseKey?: string | null;
  licenseIterations?: number | null;
  durationDays?: number | null;
  deviceLimit?: number | null;
  renewal?: boolean;
  downloadUrl?: string | null;
};

const PRODUCT_NAMES: Record<string, Text> = {
  stickers: { ru: 'Пакет генераций', kk: 'Генерация пакеті' },
  program: { ru: 'Программа «Подбор кодов»', kk: '«Кодтарды іріктеу» бағдарламасы' },
  program_license: { ru: 'Итерации «Подбора кодов»', kk: '«Кодтарды іріктеу» итерациялары' },
  cell_print_license: { ru: 'Ключ «Печати ячеек»', kk: '«Ұяшық басып шығару» кілті' },
  cell_print_program: { ru: 'Пробный доступ «Печати ячеек»', kk: '«Ұяшық басып шығару» сынақ қолжетімділігі' },
  cell_print_bundle: { ru: 'Программа и ключ «Печати ячеек»', kk: '«Ұяшық басып шығару» бағдарламасы мен кілті' },
  app_subscription: { ru: 'Подписка «Помощник ПВЗ»', kk: '«ПВЗ көмекшісі» жазылымы' },
};

/** Строка с кодом или ключом и кнопкой копирования. */
function SecretRow({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  const t = useT();

  return (
    <div className={s.secret}>
      <div>
        <span className={s.secretLabel}>{label}</span>
        <strong className={`mono ${s.secretValue}`}>{value}</strong>
      </div>
      <Button
        variant="secondary"
        onClick={() => {
          navigator.clipboard?.writeText(value);
          toast(t('Скопировано', 'Көшірілді'), 'success');
        }}
      >
        <Copy size={16} />
        {t('Копировать', 'Көшіру')}
      </Button>
    </div>
  );
}

export const PaymentResultPage = observer(() => {
  const t = useT();
  const locale = useLocale();
  const lp = useLocalePath();
  useDocumentMeta(
    t('Результат оплаты', 'Төлем нәтижесі'),
    t('Статус заказа, код доступа, ключ активации и ссылка на установщик.', 'Тапсырыс мәртебесі, қолжетімділік коды, белсендіру кілті және орнатқыш сілтемесі.'),
  );

  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const fromTelegram = params.get('from') === 'telegram';
  // Без start-параметра: Telegram просто открывает уже существующий чат и не
  // отправляет от имени пользователя видимую команду /start.
  const botUrl = BOT_URL;
  const { auth } = useStores();
  const queryClient = useQueryClient();
  // Тот же экран показывается и в кабинете: там свой заголовок и свои выходы,
  // чтобы покупка из кабинета не выбрасывала человека на публичную главную.
  const inCabinet = useLocation().pathname.startsWith('/cabinet');

  const order = useQuery({
    queryKey: ['order', token],
    queryFn: () => api<Order>(`/api/payments/status?token=${encodeURIComponent(token)}`),
    enabled: Boolean(token),
    // ЮKassa подтверждает платёж не мгновенно: пока заказ висит в pending,
    // опрашиваем статус, но не бесконечно — 40 попыток по 3 секунды ≈ 2 минуты.
    refetchInterval: query =>
      query.state.data?.status === 'pending' && query.state.dataUpdateCount < 40 ? 3000 : false,
    retry: false,
  });

  const data = order.data;
  const productName = data
    ? data.renewal
      ? data.productKind === 'stickers'
        ? t('Пополнение кода доступа', 'Қолжетімділік кодын толықтыру')
        : data.productKind === 'program_license'
          ? t('Пополнение ключа «Подбора кодов»', '«Кодтарды іріктеу» кілтін толықтыру')
          : t('Продление ключа «Печати ячеек»', '«Ұяшық басып шығару» кілтін ұзарту')
      : data.productKind === 'stickers'
        ? `${t('Пакет генераций', 'Генерация пакеті')}${data.quantity ? ` · ${data.quantity} ${t('шт.', 'дана')}` : ''}`
        : (PRODUCT_NAMES[data.productKind]?.[locale] ?? t('Заказ', 'Тапсырыс'))
    : t('Заказ', 'Тапсырыс');

  // Код оплаченного пакета кладём в браузер сразу. Без этого покупка без входа
  // никуда не попадала: генератор просил вводить код руками, а при регистрации
  // кабинету было нечего забирать — вместе с пакетом терялось и реферальное
  // вознаграждение пригласившего, ведь заказ так и оставался ничьим.
  useEffect(() => {
    if (data?.status !== 'succeeded' || !data.accessCode) return;
    try {
      localStorage.setItem('sticker_access_code', data.accessCode);
    } catch {
      // Приватный режим и запрет на хранение не должны ломать страницу оплаты.
    }
  }, [data?.status, data?.accessCode]);

  // Кабинет держит купленное в общем bootstrap-запросе с 30-секундным кэшем:
  // без сброса свежий пакет не появлялся ни в «Пакетах», ни в поле кода доступа
  // генератора, пока человек не перезагрузит страницу руками. Заказ вошедшего
  // уже привязан к нему на сервере, поэтому токен просто убираем из ожидающих.
  useEffect(() => {
    if (data?.status !== 'succeeded') return;
    if (token) forgetPendingOrder(localStorage, token);
    if (auth.isAuthenticated) void queryClient.invalidateQueries({ queryKey: cabinetKey });
  }, [data?.status, token, auth.isAuthenticated, queryClient]);

  // После оплаты из бота пробуем вернуть пользователя в Telegram сами.
  // Кнопка ниже остаётся запасным вариантом для браузеров, запрещающих
  // автоматическое открытие внешних приложений.
  useEffect(() => {
    if (data?.status !== 'succeeded' || !fromTelegram || !botUrl) return;
    const marker = `telegram-payment-return:${token}`;
    try {
      if (sessionStorage.getItem(marker)) return;
      sessionStorage.setItem(marker, '1');
    } catch {
      // При запрещённом sessionStorage один повторный переход безопасен.
    }
    const timeout = window.setTimeout(() => location.replace(botUrl), 1200);
    return () => window.clearTimeout(timeout);
  }, [data?.status, fromTelegram, botUrl, token]);

  return (
    <>
      {/* В кабинете заголовок рисует его собственная шапка */}
      {!inCabinet && <Hero compact eyebrow={t('Оплата', 'Төлем')} title={t('Результат оплаты', 'Төлем нәтижесі')} />}

      <div className="page">
        <div className={s.wrap}>
          {!token && (
            <Card>
              <EmptyState
                title={t('Заказ не найден', 'Тапсырыс табылмады')}
                text={t(
                  'В ссылке нет номера заказа. Откройте страницу по ссылке из письма или из окна оплаты.',
                  'Сілтемеде тапсырыс нөмірі жоқ. Бетті хаттағы немесе төлем терезесіндегі сілтеме арқылы ашыңыз.',
                )}
                action={
                  <Link to={lp('/')}>
                    <Button>{t('На главную', 'Басты бетке')}</Button>
                  </Link>
                }
              />
            </Card>
          )}

          {token && order.isLoading && (
            <Card>
              <div className="stack">
                <div className="row">
                  <Spinner />
                  <strong>{t('Проверяем оплату…', 'Төлемді тексеріп жатырмыз…')}</strong>
                </div>
                <Skeleton width="60%" />
                <Skeleton width="40%" />
              </div>
            </Card>
          )}

          {token && order.isError && (
            <Card>
              <div className="stack">
                <Alert tone="error">{order.error.message}</Alert>
                <p className="muted" style={{ margin: 0 }}>
                  {t(
                    'Если деньги списались, а заказ не найден — напишите нам, разберёмся вручную и выдадим доступ.',
                    'Ақша есептен шығарылып, тапсырыс табылмаса — бізге жазыңыз, қолмен анықтап, қолжетімділік береміз.',
                  )}
                </p>
                <div className="row">
                  <Link to={lp('/contacts')}>
                    <Button variant="secondary">{t('Написать в поддержку', 'Қолдау қызметіне жазу')}</Button>
                  </Link>
                </div>
              </div>
            </Card>
          )}

          {data && (
            <Card accent={data.status === 'succeeded'}>
              <div className="stack">
                {data.status === 'pending' && (
                  <>
                    <div className="row">
                      <Spinner />
                      <strong>{t('Ждём подтверждения от банка', 'Банктің растауын күтіп жатырмыз')}</strong>
                    </div>
                    <p className="muted" style={{ margin: 0 }}>
                      {t(
                        'Обычно это занимает несколько секунд. Страницу можно не обновлять — статус обновится сам.',
                        'Әдетте бұл бірнеше секундқа созылады. Бетті жаңартудың қажеті жоқ — мәртебе өзі жаңарады.',
                      )}
                    </p>
                  </>
                )}

                {data.status === 'succeeded' && (
                  <>
                    <h2 className={s.title}>{t('Оплата прошла', 'Төлем өтті')}</h2>
                    <p className="muted" style={{ margin: 0 }}>
                      {productName} · {formatTotal(data.amount)}
                    </p>

                    {fromTelegram && botUrl && (
                      <a
                        href={botUrl}
                        rel="noopener noreferrer"
                        onClick={event => {
                          // Если результат открыт в Mini App, чат уже находится
                          // под этим окном: закрытие надёжнее любых tg:// ссылок.
                          const webApp = window.Telegram?.WebApp;
                          if (webApp?.initData) {
                            event.preventDefault();
                            webApp.close();
                          }
                        }}
                      >
                        <Button>{t('Вернуться в бот', 'Ботқа оралу')}</Button>
                      </a>
                    )}

                    {data.accessCode && (
                      <SecretRow label={t('Код доступа к генерации', 'Генерацияға қолжетімділік коды')} value={data.accessCode} />
                    )}

                    {data.licenseKey && (
                      <SecretRow label={t('Ключ активации', 'Белсендіру кілті')} value={data.licenseKey} />
                    )}

                    {data.productKind === 'app_subscription' ? (
                      <Alert tone="success">
                        {t(
                          'Тариф уже действует. Войдите в программу тем же логином и паролем, что на сайте, — или нажмите «Обновить» в профиле программы, если уже вошли.',
                          'Тариф қазірдің өзінде жұмыс істейді. Бағдарламаға сайттағы логин мен құпиясөзбен кіріңіз немесе бұрын кірген болсаңыз, бағдарлама профилінде «Жаңарту» басыңыз.',
                        )}
                      </Alert>
                    ) : auth.isAuthenticated ? (
                      <Alert tone="info">
                        {t(
                          'Сохраните код или ключ: он также доступен в кабинете в разделе «Ключи и доступы».',
                          'Кодты немесе кілтті сақтаңыз: ол кабинеттегі «Кілттер мен қолжетімділіктер» бөлімінде де бар.',
                        )}
                      </Alert>
                    ) : (
                      <Alert tone="info">
                        {t('Сохраните код — сейчас он есть только в этом браузере.', 'Кодты сақтаңыз — қазір ол тек осы браузерде бар.')}{' '}
                        <Link className="accent" to="/register">
                          {t('Заведите аккаунт', 'Аккаунт ашыңыз')}
                        </Link>
                        {t(
                          ', и покупка вместе с уже созданными стикерами перенесётся в личный кабинет.',
                          ' — сатып алынған пакет жасалған стикерлермен бірге жеке кабинетке ауысады.',
                        )}
                      </Alert>
                    )}

                    <div className="row">
                      {data.downloadUrl && (
                        <a href={data.downloadUrl}>
                          <Button>
                            <Download size={18} />
                            {t('Скачать программу', 'Бағдарламаны жүктеп алу')}
                          </Button>
                        </a>
                      )}
                      <Link to={data.productKind === 'app_subscription' ? '/cabinet/subscription' : '/cabinet/keys'}>
                        <Button variant="secondary">
                          <KeyRound size={18} />
                          {data.productKind === 'app_subscription' ? t('Подписка', 'Жазылым') : t('Ключи и доступы', 'Кілттер мен қолжетімділіктер')}
                        </Button>
                      </Link>
                      {/* Из кабинета логично идти сразу генерировать, а не на главную */}
                      <Link to={inCabinet ? '/cabinet/generator' : lp('/')}>
                        <Button variant="ghost">
                          {inCabinet ? t('К генератору', 'Генераторға') : t('На главную', 'Басты бетке')}
                          <ArrowRight size={16} />
                        </Button>
                      </Link>
                    </div>
                  </>
                )}

                {data.status !== 'pending' && data.status !== 'succeeded' && (
                  <>
                    <h2 className={s.title}>{t('Оплата не прошла', 'Төлем өтпеді')}</h2>
                    <Alert tone="warning">
                      {t(
                        'Заказ отменён или платёж не был завершён. Деньги, если они списались, возвращаются банком автоматически.',
                        'Тапсырыс бас тартылды немесе төлем аяқталмады. Ақша есептен шығарылған болса, банк оны автоматты түрде қайтарады.',
                      )}
                    </Alert>
                    <p className="muted" style={{ margin: 0 }}>
                      {t(
                        'Не получается оплатить? Напишите нам в Telegram и опишите, что пошло не так (карта, СБП, ошибка банка) — поможем завершить покупку.',
                        'Төлей алмай жатырсыз ба? Бізге Telegram-да жазып, не дұрыс болмағанын сипаттаңыз (карта, СБП, банк қатесі) — сатып алуды аяқтауға көмектесеміз.',
                      )}
                    </p>
                    <div className="row">
                      <Link to={lp('/')}>
                        <Button>{t('Попробовать снова', 'Қайта көру')}</Button>
                      </Link>
                      <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
                        <Button variant="secondary">{t('Написать в Telegram', 'Telegram-да жазу')} @{SUPPORT_USERNAME}</Button>
                      </a>
                    </div>
                  </>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
});
