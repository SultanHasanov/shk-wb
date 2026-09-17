import { useMemo, useState } from 'react';
import { FileText, Receipt } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, Modal, Segmented, Table } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, money, type Order, useOrders } from '../../api/cabinet';
import { api } from '../../api/client';
import { SpecList } from '../../components/SpecList';
import { useDocumentMeta } from '../../lib/seo';

type Filter = 'all' | 'succeeded' | 'pending' | 'canceled';
const tone = (status: string): 'success' | 'warning' | 'error' =>
  status === 'succeeded' ? 'success' : status === 'canceled' ? 'error' : 'warning';
const label = (status: string) =>
  status === 'succeeded' ? 'Оплачен' : status === 'canceled' ? 'Отменён' : 'В ожидании';

export function OrdersPage() {
  useDocumentMeta('Заказы — кабинет');
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
      setPayError(error instanceof Error ? error.message : 'Не удалось открыть оплату');
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
        <h1>Заказы</h1>
        <p>Покупки программ, ключей и пакетов генераций.</p>
      </header>
      <Segmented label="Статус заказа" value={filter} onChange={setFilter} options={[
        { value: 'all', label: 'Все' }, { value: 'succeeded', label: 'Оплачены' },
        { value: 'pending', label: 'В ожидании' }, { value: 'canceled', label: 'Отменены' },
      ]} />
      <div className="section">
        {rows.length ? <Table>
          <thead><tr><th>Номер</th><th>Дата</th><th>Покупка</th><th>Сумма</th><th>Статус</th><th /></tr></thead>
          <tbody>{rows.map(order => <tr key={order.id}>
            <td className="mono">{order.id.slice(0, 8)}</td><td>{dateTime(order.createdAt)}</td>
            <td>{order.product}</td><td>{money(Math.round(order.amount * 100))}</td>
            <td><Badge tone={tone(order.status)}>{label(order.status)}</Badge></td>
            <td><Button variant="ghost" size="sm" onClick={() => setOpen(order)}>Подробнее</Button></td>
          </tr>)}</tbody>
        </Table> : <Card><EmptyState icon={<Receipt />} title="Заказов с таким статусом нет" text="Выберите другой фильтр." /></Card>}
      </div>

      <Modal open={Boolean(open)} onOpenChange={closeOrder} title={open ? `Заказ ${open.id.slice(0, 8)}` : 'Заказ'}>
        {open && <div className="stack">
          <Badge tone={tone(open.status)}>{label(open.status)}</Badge>
          <SpecList flush items={[
            { term: 'Покупка', value: open.product },
            { term: 'Полная стоимость', value: money(Math.round(open.grossAmount * 100)) },
            { term: open.productKind === 'individual_stickers' ? 'Зачтено из пакета' : 'Оплачено балансом', value: money(open.referralCreditKopecks) },
            { term: 'К оплате', value: money(Math.round(open.amount * 100)) },
            ...(open.creditedUnits ? [{ term: 'Зачтено генераций', value: String(open.creditedUnits) }] : []),
            ...(open.accessCode ? [{ term: 'Код доступа', value: open.accessCode }] : []),
            ...(open.licenseKey ? [{ term: 'Лицензионный ключ', value: open.licenseKey }] : []),
          ]} />
          {open.payable && !paymentUrl && <Button loading={paying} onClick={() => void payIndividual(open)}>
            Оплатить {money(Math.round(open.amount * 100))}
          </Button>}
          {paymentUrl && <>
            <Alert tone="warning">Для оплаты через СБП откройте ЮKassa во внешнем браузере. Тогда Telegram сможет запустить приложение банка.</Alert>
            <Button onClick={openExternalPayment}>Открыть оплату во внешнем браузере</Button>
          </>}
          {payError && <p className="error">{payError}</p>}
          {open.receiptUrl && <a href={open.receiptUrl} target="_blank" rel="noreferrer">
            <Button variant="secondary"><FileText size={16} />Чек ЮKassa</Button>
          </a>}
        </div>}
      </Modal>
    </div>
  );
}
