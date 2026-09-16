import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { Link, useLocation } from 'react-router-dom';
import { CircleCheck } from 'lucide-react';
import { Alert, Button, Checkbox, Modal } from '../ui';
import {
  formatPerUnit,
  formatTotal,
  getPack,
  HEADLINE_PACK_LIST,
  POPULAR_PACK,
} from '../lib/pricing';
import { Section } from './Section';
import s from './PricingPacks.module.css';
import { api } from '../api/client';
import { rememberPendingOrder } from '../lib/pending-orders';
import { useStores } from '../stores/root-store';
import { useCabinet } from '../api/cabinet';

/** Блок покупки пакетов через действующий серверный платёжный API. */

/** Пул генераций на коде общий: одна генерация — это один стикер товара или один
 *  QR коробки, пачкой или по номеру, всё тратится из одного остатка. Поэтому
 *  покупка спрашивает только количество; тип и режим в генераторе выбирают, что
 *  печатать, а не за что платить. */
function PackGrid({ value, onChange }: { value: number; onChange: (quantity: number) => void }) {
  return (
    <div className={s.grid} role="radiogroup" aria-label="Пакеты генераций">
      {HEADLINE_PACK_LIST.map(pack => {
        const active = pack.quantity === value;
        const popular = pack.quantity === POPULAR_PACK;

        return (
          <button
            key={pack.quantity}
            type="button"
            role="radio"
            aria-checked={active}
            className={[s.pack, active && s.packActive, popular && !active && s.popular]
              .filter(Boolean)
              .join(' ')}
            onClick={() => onChange(pack.quantity)}
          >
            {popular && <span className={s.ribbon}>Чаще всего берут</span>}
            {active && <CircleCheck size={20} className={s.check} aria-hidden="true" />}

            <span className={s.qty}>
              {pack.quantity} {pack.quantity === 1 ? 'генерация' : 'генераций'}
            </span>
            <span className={s.perUnit}>{formatPerUnit(pack.perUnit)}</span>
            <span className={s.perUnitLabel}>за генерацию</span>

            <span className={s.total}>
              {formatTotal(pack.total)} <span className={s.totalLabel}>за пакет</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Полная форма покупки: количество → сумма → оплата. */
export const PackPurchase = observer(() => {
  const [quantity, setQuantity] = useState<number>(POPULAR_PACK);
  const [accepted, setAccepted] = useState(false);
  const [useBalance, setUseBalance] = useState(false);
  // Оплата уводит на ЮKassa, поэтому состав заказа показываем до ухода со страницы.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { auth } = useStores();
  const cabinet = useCabinet(auth.isAuthenticated);
  const { pathname } = useLocation();
  // Этот же блок показывает кабинет, поэтому «откуда покупали» знает только клиент:
  // сервер строит return_url по этому признаку и возвращает человека туда же.
  const inCabinet = pathname.startsWith('/cabinet');
  const selected = getPack(quantity);
  const availableKopecks = cabinet.data?.referral.availableKopecks ?? 0;
  const totalKopecks = Math.round(selected.total * 100);
  const appliedKopecks = useBalance ? Math.min(totalKopecks, availableKopecks) : 0;
  const payableTotal = (totalKopecks - appliedKopecks) / 100;

  const checkout = useMutation({
    mutationFn: () =>
      api<{ confirmationUrl: string; token: string }>('/api/payments/create', {
        method: 'POST',
        body: JSON.stringify({
          productKind: 'stickers',
          quantity,
          accepted,
          referralCreditKopecks: useBalance ? Number.MAX_SAFE_INTEGER : 0,
          returnTo: inCabinet ? 'cabinet' : 'public',
        }),
      }),
    // Заказ запоминаем до ухода на ЮKassa: у покупки без входа других следов не
    // остаётся, и при регистрации кабинету нечего было бы забирать, вернись
    // человек на сайт мимо страницы результата оплаты.
    onSuccess: data => {
      rememberPendingOrder(localStorage, data.token);
      location.assign(data.confirmationUrl);
    },
  });

  return (
    <>
      <PackGrid value={quantity} onChange={setQuantity} />

      <div className={s.checkout}>
        <div className={s.summary}>
          <span className={s.summaryText}>
            {selected.quantity} {selected.quantity === 1 ? 'генерация' : 'генераций'} по{' '}
            {formatPerUnit(selected.perUnit)}
          </span>
          <span className={s.summaryTotal}>{formatTotal(payableTotal)}</span>
        </div>

        <Checkbox
          checked={accepted}
          onChange={e => setAccepted(e.target.checked)}
          id="packages-offer"
        >
          Принимаю{' '}
          <a className="accent" href="/offer">
            оферту
          </a>{' '}
          и{' '}
          <a className="accent" href="/privacy">
            политику конфиденциальности
          </a>
        </Checkbox>

        {auth.isAuthenticated && (
          <Checkbox
            checked={useBalance}
            disabled={cabinet.isPending || availableKopecks <= 0}
            onChange={e => setUseBalance(e.target.checked)}
          >
            Использовать доступный реферальный баланс — доступно{' '}
            {cabinet.isPending ? '…' : formatTotal(availableKopecks / 100)}
          </Checkbox>
        )}

        {/* Покупку намеренно не блокируем: код доступа работает и без учётной записи.
            Но вошедшему он сразу привяжется к кабинету — вместе с уже созданными
            в этом браузере стикерами, — поэтому предлагаем войти до оплаты. */}
        {!auth.isAuthenticated && (
          <Alert tone="info">
            Купить можно без регистрации — код доступа выдадим сразу.{' '}
            <Link className="accent" to="/login">
              Войдите
            </Link>
            , и пакет вместе с уже созданными в этом браузере стикерами появится в личном кабинете.
          </Alert>
        )}

        <Button
          size="lg"
          disabled={!accepted}
          loading={checkout.isPending}
          onClick={() => setConfirmOpen(true)}
        >
          {payableTotal > 0 ? 'Перейти к оплате' : 'Оплатить балансом'}
        </Button>

        {checkout.isError && <Alert tone="error">{checkout.error.message}</Alert>}

        <Modal
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Проверьте заказ"
          description="После подтверждения откроется страница оплаты ЮKassa."
        >
          <div className="stack">
            <div className={s.confirmRow}>
              <span className="muted">Что покупаете</span>
              <strong>Пакет генераций</strong>
            </div>
            <div className={s.confirmRow}>
              <span className="muted">Количество</span>
              <strong>
                {selected.quantity} {selected.quantity === 1 ? 'генерация' : 'генераций'}
              </strong>
            </div>
            <div className={s.confirmRow}>
              <span className="muted">Цена за генерацию</span>
              <strong>{formatPerUnit(selected.perUnit)}</strong>
            </div>
            <div className={s.confirmRow}>
              <span className="muted">К оплате</span>
              <span className={s.confirmTotal}>{formatTotal(payableTotal)}</span>
            </div>

            {auth.isAuthenticated && useBalance && (
              <Alert tone="info">
                Из реферального баланса спишется {formatTotal(appliedKopecks / 100)}. К оплате
                останется {formatTotal(payableTotal)}.
              </Alert>
            )}

            {!auth.isAuthenticated && (
              <Alert tone="info">
                Код доступа выдадим сразу после оплаты. Без входа он останется только в этом
                браузере.
              </Alert>
            )}

            <div className="row">
              <Button loading={checkout.isPending} onClick={() => checkout.mutate()}>
                {payableTotal > 0 ? 'Перейти к оплате' : 'Оплатить балансом'}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
                Отмена
              </Button>
            </div>

            {checkout.isError && <Alert tone="error">{checkout.error.message}</Alert>}
          </div>
        </Modal>
      </div>
    </>
  );
});

export function PricingPacks() {
  return (
    <Section
      id="packages"
      align="center"
      eyebrow="Тарифы"
      title="Пакеты генераций"
      lead="Оплата разовая, срок действия не ограничен. Пакет — это просто число генераций: тратьте их на стикеры товаров или на QR возвратных коробок, пачкой или по одному номеру."
    >
      <PackPurchase />
    </Section>
  );
}
