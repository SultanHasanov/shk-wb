import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { WalletCards } from 'lucide-react';
import { api } from '../../api/client';
import { useCabinet } from '../../api/cabinet';
import { rememberPendingOrder } from '../../lib/pending-orders';
import { useDocumentMeta } from '../../lib/seo';
import { Alert, Button, Card, EmptyState, Field, Input, Stat, Table } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { useT } from '../../i18n';

const rub = (kopecks: number) => `${(kopecks / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;

export function PackagesPage() {
  const t = useT();
  useDocumentMeta(t('Баланс генератора — кабинет', 'Генератор балансы — кабинет'));
  const query = useCabinet();
  const [amount, setAmount] = useState('20');
  const value = Number(amount.replace(',', '.'));
  const kopecks = Math.round(value * 100);
  const valid = Number.isFinite(value) && value >= 20 && value <= 50000 && Math.abs(kopecks - value * 100) < 1e-6;
  const checkout = useMutation({
    mutationFn: () => api<{ confirmationUrl: string; token: string }>('/api/payments/create', {
      method: 'POST',
      body: JSON.stringify({ productKind: 'wallet_topup', walletAmount: value, accepted: true, returnTo: 'cabinet' }),
    }),
    onSuccess: data => {
      rememberPendingOrder(localStorage, data.token);
      location.assign(data.confirmationUrl);
    },
  });

  if (query.isPending) return <div className="page"><CabinetLoading /></div>;
  if (query.isError) return <div className="page"><CabinetError error={query.error} retry={() => query.refetch()} /></div>;
  const wallet = query.data.wallet ?? { balanceKopecks: 0, discountAvailable: false, ledger: [] };

  return <div className="page">
    <header className="page-head">
      <h1>{t('Баланс генератора', 'Генератор балансы')}</h1>
      <p>{t('Один баланс для сайта и Telegram-бота. По номеру — 7,50 ₽, пачка из 50 кодов одним PDF — 20 ₽.', 'Сайт пен Telegram-ботқа ортақ баланс. Нөмір бойынша — 7,50 ₽, 50 кодтан тұратын PDF — 20 ₽.')}</p>
    </header>

    <Card accent>
      <div className="grid grid-2">
        <Stat icon={<WalletCards size={20} />} value={rub(wallet.balanceKopecks)} label={t('доступно', 'қолжетімді')} />
        <div className="stack">
          <Field label={t('Сумма пополнения, ₽', 'Толықтыру сомасы, ₽')} help={t('От 20 до 50 000 ₽, можно указать копейки.', '20-дан 50 000 ₽-ге дейін, тиындарды көрсетуге болады.')}>
            <Input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value.replace(/[^0-9.,]/g, ''))} />
          </Field>
          <div className="row">
            {[20, 100, 300, 500, 1000].map(sum => <Button key={sum} type="button" size="sm" variant="secondary" onClick={() => setAmount(String(sum))}>{sum} ₽</Button>)}
          </div>
          <Button disabled={!valid} loading={checkout.isPending} onClick={() => checkout.mutate()}>{t('Пополнить баланс', 'Балансты толықтыру')}</Button>
          {!valid && <Alert tone="warning">{t('Введите сумму от 20 до 50 000 ₽, не более двух знаков после запятой.', '20-дан 50 000 ₽-ге дейінгі соманы енгізіңіз, үтірден кейін екі таңбадан аспасын.')}</Alert>}
          {checkout.isError && <Alert tone="error">{checkout.error.message}</Alert>}
        </div>
      </div>
    </Card>

    {wallet.discountAvailable && <Alert tone="success">{t('Ваша следующая генерация получит разовую скидку 20%: 6 ₽ по номеру или 16 ₽ за пачку.', 'Келесі генерацияңызға бір реттік 20% жеңілдік беріледі: нөмір бойынша 6 ₽ немесе пакетке 16 ₽.')}</Alert>}

    <section className="section stack">
      <h2>{t('История баланса', 'Баланс тарихы')}</h2>
      {wallet.ledger.length ? <Table>
        <thead><tr><th>{t('Дата', 'Күні')}</th><th>{t('Операция', 'Операция')}</th><th>{t('Сумма', 'Сома')}</th></tr></thead>
        <tbody>{wallet.ledger.map((entry, index) => <tr key={`${entry.createdAt}-${index}`}>
          <td>{new Date(entry.createdAt).toLocaleString('ru-RU')}</td>
          <td>{entry.note === 'legacy_stickers_conversion' ? t('Конвертация старого пакета', 'Ескі пакетті айырбастау') : ({ topup: t('Пополнение', 'Толықтыру'), bonus: t('Бонус', 'Бонус'), spend: t('Списание', 'Есептен шығару'), refund: t('Возврат', 'Қайтару'), admin: t('Корректировка', 'Түзету') }[entry.kind])}</td>
          <td><strong>{entry.amountKopecks > 0 ? '+' : ''}{rub(entry.amountKopecks)}</strong></td>
        </tr>)}</tbody>
      </Table> : <Card><EmptyState icon={<WalletCards />} title={t('Операций пока нет', 'Әзірге операциялар жоқ')} text={t('После пополнения или генерации запись появится здесь.', 'Толықтырудан немесе генерациядан кейін жазба осында пайда болады.')} /></Card>}
    </section>
  </div>;
}
