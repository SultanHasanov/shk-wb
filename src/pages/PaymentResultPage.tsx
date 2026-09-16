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
import { BOT_URL } from '../lib/telegram';
import { cabinetKey } from '../api/cabinet';
import { forgetPendingOrder } from '../lib/pending-orders';
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

const PRODUCT_NAMES: Record<string, string> = {
  stickers: 'Пакет генераций',
  program: 'Программа «Подбор кодов»',
  program_license: 'Итерации «Подбора кодов»',
  cell_print_license: 'Ключ «Печати ячеек»',
  cell_print_program: 'Пробный доступ «Печати ячеек»',
  cell_print_bundle: 'Программа и ключ «Печати ячеек»',
};

/** Строка с кодом или ключом и кнопкой копирования. */
function SecretRow({ label, value }: { label: string; value: string }) {
  const toast = useToast();

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
          toast('Скопировано', 'success');
        }}
      >
        <Copy size={16} />
        Копировать
      </Button>
    </div>
  );
}

export const PaymentResultPage = observer(() => {
  useDocumentMeta(
    'Результат оплаты',
    'Статус заказа, код доступа, ключ активации и ссылка на установщик.',
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
        ? 'Пополнение кода доступа'
        : data.productKind === 'program_license'
          ? 'Пополнение ключа «Подбора кодов»'
          : 'Продление ключа «Печати ячеек»'
      : data.productKind === 'stickers'
        ? `Пакет генераций${data.quantity ? ` · ${data.quantity} шт.` : ''}`
        : (PRODUCT_NAMES[data.productKind] ?? 'Заказ')
    : 'Заказ';

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
      {!inCabinet && <Hero compact eyebrow="Оплата" title="Результат оплаты" />}

      <div className="page">
        <div className={s.wrap}>
          {!token && (
            <Card>
              <EmptyState
                title="Заказ не найден"
                text="В ссылке нет номера заказа. Откройте страницу по ссылке из письма или из окна оплаты."
                action={
                  <Link to="/">
                    <Button>На главную</Button>
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
                  <strong>Проверяем оплату…</strong>
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
                  Если деньги списались, а заказ не найден — напишите нам, разберёмся вручную и
                  выдадим доступ.
                </p>
                <div className="row">
                  <Link to="/contacts">
                    <Button variant="secondary">Написать в поддержку</Button>
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
                      <strong>Ждём подтверждения от банка</strong>
                    </div>
                    <p className="muted" style={{ margin: 0 }}>
                      Обычно это занимает несколько секунд. Страницу можно не обновлять — статус
                      обновится сам.
                    </p>
                  </>
                )}

                {data.status === 'succeeded' && (
                  <>
                    <h2 className={s.title}>Оплата прошла</h2>
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
                        <Button>Вернуться в бот</Button>
                      </a>
                    )}

                    {data.accessCode && (
                      <SecretRow label="Код доступа к генерации" value={data.accessCode} />
                    )}

                    {data.licenseKey && (
                      <SecretRow label="Ключ активации" value={data.licenseKey} />
                    )}

                    {auth.isAuthenticated ? (
                      <Alert tone="info">
                        Сохраните код или ключ: он также доступен в кабинете в разделе «Ключи и
                        доступы».
                      </Alert>
                    ) : (
                      <Alert tone="info">
                        Сохраните код — сейчас он есть только в этом браузере.{' '}
                        <Link className="accent" to="/register">
                          Заведите аккаунт
                        </Link>
                        , и покупка вместе с уже созданными стикерами перенесётся в личный кабинет.
                      </Alert>
                    )}

                    <div className="row">
                      {data.downloadUrl && (
                        <a href={data.downloadUrl}>
                          <Button>
                            <Download size={18} />
                            Скачать программу
                          </Button>
                        </a>
                      )}
                      <Link to="/cabinet/keys">
                        <Button variant="secondary">
                          <KeyRound size={18} />
                          Ключи и доступы
                        </Button>
                      </Link>
                      {/* Из кабинета логично идти сразу генерировать, а не на главную */}
                      <Link to={inCabinet ? '/cabinet/generator' : '/'}>
                        <Button variant="ghost">
                          {inCabinet ? 'К генератору' : 'На главную'}
                          <ArrowRight size={16} />
                        </Button>
                      </Link>
                    </div>
                  </>
                )}

                {data.status !== 'pending' && data.status !== 'succeeded' && (
                  <>
                    <h2 className={s.title}>Оплата не прошла</h2>
                    <Alert tone="warning">
                      Заказ отменён или платёж не был завершён. Деньги, если они списались,
                      возвращаются банком автоматически.
                    </Alert>
                    <div className="row">
                      <Link to="/">
                        <Button>Попробовать снова</Button>
                      </Link>
                      <Link to="/contacts">
                        <Button variant="secondary">Написать в поддержку</Button>
                      </Link>
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
