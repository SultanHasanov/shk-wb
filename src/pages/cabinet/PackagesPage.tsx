import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { WalletCards } from 'lucide-react';
import { api } from '../../api/client';
import { useCabinet } from '../../api/cabinet';
import { rememberPendingOrder } from '../../lib/pending-orders';
import { useDocumentMeta } from '../../lib/seo';
import { Alert, Button, Card, EmptyState, Input } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { useT } from '../../i18n';
import c from './cabinet.module.css';

const rub = (kopecks: number) => `${(kopecks / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;

// Пресеты пополнения и бонус — ровно как считает сервер: +5% от 500 ₽, +10% от 1000 ₽.
const PRESETS: ReadonlyArray<{ sum: number; bonus?: string }> = [
  { sum: 100 },
  { sum: 300 },
  { sum: 500, bonus: '+5%' },
  { sum: 1000, bonus: '+10%' },
];

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
  const opLabel = (entry: { kind: string; note?: string | null }) =>
    entry.note === 'legacy_stickers_conversion'
      ? t('Конвертация старого пакета', 'Ескі пакетті айырбастау')
      : ({ topup: t('Пополнение', 'Толықтыру'), bonus: t('Бонус', 'Бонус'), spend: t('Списание', 'Есептен шығару'), refund: t('Возврат', 'Қайтару'), admin: t('Корректировка', 'Түзету') }[entry.kind] ?? entry.kind);

  return <div className="page">
    <header className="page-head">
      <h1>{t('Баланс генератора', 'Генератор балансы')}</h1>
      <p>{t('Один баланс для сайта и Telegram-бота. По номеру — 7,50 ₽, пачка из 50 кодов одним PDF — 20 ₽.', 'Сайт пен Telegram-ботқа ортақ баланс. Нөмір бойынша — 7,50 ₽, 50 кодтан тұратын PDF — 20 ₽.')}</p>
    </header>

    <div className={c.balance}>
      {/* LEFT: баланс и пополнение */}
      <Card className={c.balanceCard}>
        <div className={c.balanceLead}>{t('Текущий баланс', 'Ағымдағы баланс')}</div>
        <div className={c.balanceBig}>{rub(wallet.balanceKopecks)}</div>
        <div className={c.amts} role="group" aria-label={t('Сумма пополнения', 'Толықтыру сомасы')}>
          {PRESETS.map(({ sum, bonus }) => (
            <button
              key={sum}
              type="button"
              className={`${c.amt} ${amount === String(sum) ? c.amtSel : ''}`}
              aria-pressed={amount === String(sum)}
              onClick={() => setAmount(String(sum))}
            >
              <div className={c.amtValue}>{sum} ₽</div>
              {bonus && <div className={c.amtBonus}>{t(`${bonus} бонус`, `${bonus} бонус`)}</div>}
            </button>
          ))}
        </div>
        <div className={c.topup}>
          <Input
            inputMode="decimal"
            aria-label={t('Сумма пополнения, ₽', 'Толықтыру сомасы, ₽')}
            placeholder={t('Своя сумма, ₽', 'Өз сомасы, ₽')}
            value={amount}
            onChange={event => setAmount(event.target.value.replace(/[^0-9.,]/g, ''))}
          />
          <Button variant="secondary" disabled={!valid} loading={checkout.isPending} onClick={() => checkout.mutate()}>{t('Пополнить баланс', 'Балансты толықтыру')}</Button>
        </div>
        <p className={c.balanceNote}>{t('Бонус начисляется от 500 ₽. Баланс тратится на генерации и покупки с баланса. От 20 до 50 000 ₽.', 'Бонус 500 ₽-ден бастап есептеледі. Баланс генерациялар мен сатып алуларға жұмсалады. 20-дан 50 000 ₽-ге дейін.')}</p>
      </Card>

      {/* RIGHT: последние операции */}
      <Card>
        <h3 className={c.cardTitle}>{t('Последние операции', 'Соңғы операциялар')}</h3>
        {wallet.ledger.length ? (
          <div className={c.ops}>
            {wallet.ledger.map((entry, index) => (
              <div className={c.op} key={`${entry.createdAt}-${index}`}>
                <div>
                  <div className={c.opName}>{opLabel(entry)}</div>
                  <div className={c.opDate}>{new Date(entry.createdAt).toLocaleString('ru-RU')}</div>
                </div>
                <div className={`${c.opAmt} ${entry.amountKopecks > 0 ? c.plus : c.minus}`}>{entry.amountKopecks > 0 ? '+' : ''}{rub(entry.amountKopecks)}</div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={<WalletCards />} title={t('Операций пока нет', 'Әзірге операциялар жоқ')} text={t('После пополнения или генерации запись появится здесь.', 'Толықтырудан немесе генерациядан кейін жазба осында пайда болады.')} />
        )}
      </Card>
    </div>

    {wallet.discountAvailable && <Alert tone="success">{t('Ваша следующая генерация получит разовую скидку 20%: 6 ₽ по номеру или 16 ₽ за пачку.', 'Келесі генерацияңызға бір реттік 20% жеңілдік беріледі: нөмір бойынша 6 ₽ немесе пакетке 16 ₽.')}</Alert>}
    {!valid && <Alert tone="warning">{t('Введите сумму от 20 до 50 000 ₽, не более двух знаков после запятой.', '20-дан 50 000 ₽-ге дейінгі соманы енгізіңіз, үтірден кейін екі таңбадан аспасын.')}</Alert>}
    {checkout.isError && <Alert tone="error">{checkout.error.message}</Alert>}
  </div>;
}
