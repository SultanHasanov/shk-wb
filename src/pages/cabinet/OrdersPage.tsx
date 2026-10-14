import { useMemo, useState } from 'react';
import { FileText, Receipt } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, Modal, Segmented, Table } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, money, type Order, useOrders } from '../../api/cabinet';
import { api } from '../../api/client';
import { SpecList } from '../../components/SpecList';
import { useDocumentMeta } from '../../lib/seo';
import { type T, useT } from '../../i18n';

type Filter = 'all' | 'succeeded' | 'pending' | 'canceled';
const tone = (status: string): 'success' | 'warning' | 'error' =>
  status === 'succeeded' ? 'success' : status === 'canceled' ? 'error' : 'warning';
const label = (status: string, t: T) =>
  status === 'succeeded' ? t('Оплачен', 'Төленді') : status === 'canceled' ? t('Отменён', 'Бас тартылды') : t('В ожидании', 'Күтуде');

export function OrdersPage() {
  const t = useT();
  useDocumentMeta(t('Заказы — кабинет', 'Тапсырыстар — кабинет'));
  const query = useOrders();
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Order | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');
  const [paymentUrl, setPaymentUrl] = useState('');

  const payIndividual = async (order: Order) => {
    setPayError('');
    setPaymentUrl('');
    setPaying(true);
    try {
      const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
      const result = await api<{ confirmationUrl: string }>('/api/payments?action=create', {
        method: 'POST',
        body: JSON.stringify({
          productKind: 'individual_stickers',
          individualOrderId: order.individualOrderId,
          accepted: true,
          returnTo: inTelegram ? 'telegram' : 'cabinet',
        }),
      });
      if (inTelegram && typeof window.Telegram?.WebApp?.openLink === 'function') {
        // Отдельное нажатие надёжно открывает браузер вне Mini App. Иначе ссылка
        // приложения банка для СБП остаётся внутри Telegram и даёт UNKNOWN_URL_SCHEME.
        setPaymentUrl(result.confirmationUrl);
        setPaying(false);
        return;
      }
      window.location.assign(result.confirmationUrl);
    } catch (error) {
      setPayError(error instanceof Error ? error.message : t('Не удалось открыть оплату', 'Төлемді ашу мүмкін болмады'));
      setPaying(false);
    }
  };

  const openExternalPayment = () => {
    if (!paymentUrl) return;
    const webApp = window.Telegram?.WebApp;
    if (webApp?.initData && typeof webApp.openLink === 'function') {
      webApp.openLink(paymentUrl);
      window.setTimeout(() => webApp.close(), 400);
      return;
    }
    window.location.assign(paymentUrl);
  };

  const rows = useMemo(
    () =>
      query.data?.items.filter(
        order =>
          filter === 'all' || order.status === filter ||
          (filter === 'pending' && order.status === 'waiting_for_capture'),
      ) || [],
    [query.data, filter],
  );

  if (query.isPending) return <div className="page"><CabinetLoading /></div>;
  if (query.isError) return <div className="page"><CabinetError error={query.error} retry={() => query.refetch()} /></div>;

  const closeOrder = (visible: boolean) => {
    if (visible) return;
    setOpen(null);
    setPaymentUrl('');
    setPayError('');
    setPaying(false);
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('Заказы', 'Тапсырыстар')}</h1>
        <p>{t('Покупки программ, ключей и пакетов генераций.', 'Бағдарламаларды, кілттерді және генерация пакеттерін сатып алу.')}</p>
      </header>
      <Segmented label={t('Статус заказа', 'Тапсырыс мәртебесі')} value={filter} onChange={setFilter} options={[
        { value: 'all', label: t('Все', 'Барлығы') }, { value: 'succeeded', label: t('Оплачены', 'Төленгендер') },
        { value: 'pending', label: t('В ожидании', 'Күтуде') }, { value: 'canceled', label: t('Отменены', 'Бас тартылғандар') },
      ]} />
      <div className="section">
        {rows.length ? <Table>
          <thead><tr><th>{t('Номер', 'Нөмірі')}</th><th>{t('Дата', 'Күні')}</th><th>{t('Покупка', 'Сатып алу')}</th><th>{t('Сумма', 'Сомасы')}</th><th>{t('Статус', 'Мәртебесі')}</th><th /></tr></thead>
          <tbody>{rows.map(order => <tr key={order.id}>
            <td className="mono">{order.id.slice(0, 8)}</td><td>{dateTime(order.createdAt)}</td>
            <td>{order.product}</td><td>{money(Math.round(order.amount * 100))}</td>
            <td><Badge tone={tone(order.status)}>{label(order.status, t)}</Badge></td>
            <td><Button variant="ghost" size="sm" onClick={() => setOpen(order)}>{t('Подробнее', 'Толығырақ')}</Button></td>
          </tr>)}</tbody>
        </Table> : <Card><EmptyState icon={<Receipt />} title={t('Заказов с таким статусом нет', 'Мұндай мәртебедегі тапсырыстар жоқ')} text={t('Выберите другой фильтр.', 'Басқа сүзгіні таңдаңыз.')} /></Card>}
      </div>

      <Modal open={Boolean(open)} onOpenChange={closeOrder} title={open ? t(`Заказ ${open.id.slice(0, 8)}`, `${open.id.slice(0, 8)} тапсырысы`) : t('Заказ', 'Тапсырыс')}>
        {open && <div className="stack">
          <Badge tone={tone(open.status)}>{label(open.status, t)}</Badge>
          <SpecList flush items={[
            { term: t('Покупка', 'Сатып алу'), value: open.product },
            { term: t('Полная стоимость', 'Толық құны'), value: money(Math.round(open.grossAmount * 100)) },
            { term: open.productKind === 'individual_stickers' ? t('Зачтено из пакета', 'Пакеттен есептелді') : t('Оплачено балансом', 'Баланспен төленді'), value: money(open.referralCreditKopecks) },
            { term: t('К оплате', 'Төлеуге'), value: money(Math.round(open.amount * 100)) },
            ...(open.creditedUnits ? [{ term: t('Зачтено генераций', 'Есептелген генерациялар'), value: String(open.creditedUnits) }] : []),
            ...(open.accessCode ? [{ term: t('Код доступа', 'Қолжетімділік коды'), value: open.accessCode }] : []),
            ...(open.licenseKey ? [{ term: t('Лицензионный ключ', 'Лицензиялық кілт'), value: open.licenseKey }] : []),
          ]} />
          {open.payable && !paymentUrl && <Button loading={paying} onClick={() => void payIndividual(open)}>
            {t('Оплатить', 'Төлеу')} {money(Math.round(open.amount * 100))}
          </Button>}
          {paymentUrl && <>
            <Alert tone="warning">{t('Для оплаты через СБП откройте ЮKassa во внешнем браузере. Тогда Telegram сможет запустить приложение банка.', 'СБП арқылы төлеу үшін ЮKassa-ны сыртқы браузерде ашыңыз. Сонда Telegram банк қосымшасын іске қоса алады.')}</Alert>
            <Button onClick={openExternalPayment}>{t('Открыть оплату во внешнем браузере', 'Төлемді сыртқы браузерде ашу')}</Button>
          </>}
          {payError && <p className="error">{payError}</p>}
          {open.receiptUrl && <a href={open.receiptUrl} target="_blank" rel="noreferrer">
            <Button variant="secondary"><FileText size={16} />{t('Чек ЮKassa', 'ЮKassa чегі')}</Button>
          </a>}
        </div>}
      </Modal>
    </div>
  );
}
