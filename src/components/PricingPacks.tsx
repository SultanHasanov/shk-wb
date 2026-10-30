import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { Link, useLocation } from 'react-router-dom';
import { CircleCheck } from 'lucide-react';
import { Alert, Button, Card, Checkbox, Field, Input, Modal } from '../ui';
import {
  CUSTOM_GENERATION_PACKAGES,
  formatTotal as formatRub,
  getPack,
  HEADLINE_PACK_LIST,
  POPULAR_PACK,
} from '../lib/pricing';
import { Section } from './Section';
import { RubChargeNote } from './CurrencySwitch';
import s from './PricingPacks.module.css';
import { api } from '../api/client';
import { rememberPendingOrder } from '../lib/pending-orders';
import { useStores } from '../stores/root-store';
import { useCabinet } from '../api/cabinet';
import { useMoney } from '../lib/currency';
import { useLocalePath, useT } from '../i18n';

function formatCheckoutRub(value: number) {
  const fractionDigits = Number.isInteger(value) ? 0 : 2;
  return `${value.toLocaleString('ru-RU', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })} ₽`;
}

/** Блок покупки пакетов через действующий серверный платёжный API. */

/** Пул генераций на коде общий: одна генерация — это один стикер товара или один
 *  QR коробки, пачкой или по номеру, всё тратится из одного остатка. Поэтому
 *  покупка спрашивает только количество; тип и режим в генераторе выбирают, что
 *  печатать, а не за что платить. */
function PackGrid({ value, onChange }: { value: number; onChange: (quantity: number) => void }) {
  const { formatTotal, formatPerUnit } = useMoney();
  const t = useT();
  return (
    <div className={s.grid} role="radiogroup" aria-label={t('Пакеты генераций', 'Генерация пакеттері')}>
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
            {popular && <span className={s.ribbon}>{t('Чаще всего берут', 'Ең жиі алады')}</span>}
            {active && <CircleCheck size={20} className={s.check} aria-hidden="true" />}

            <span className={s.qty}>
              {pack.quantity} {pack.quantity === 1 ? t('генерация', 'генерация') : t('генераций', 'генерация')}
            </span>
            <span className={s.perUnit}>{formatPerUnit(pack.perUnit)}</span>
            <span className={s.perUnitLabel}>{t('за генерацию', 'бір генерация')}</span>

            <span className={s.total}>
              {formatTotal(pack.total)} <span className={s.totalLabel}>{t('за пакет', 'пакет үшін')}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Полная форма покупки: количество → сумма → оплата. */
export const PackPurchase = observer(() => {
  const { formatTotal, formatPerUnit } = useMoney();
  const t = useT();
  const lp = useLocalePath();
  const [quantity, setQuantity] = useState<number>(POPULAR_PACK);
  const [accepted, setAccepted] = useState(false);
  const [useBalance, setUseBalance] = useState(false);
  const [email, setEmail] = useState('');
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
          email: auth.isAuthenticated ? undefined : email.trim() || undefined,
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
            {selected.quantity} {selected.quantity === 1 ? t('генерация', 'генерация') : t('генераций', 'генерация')} {t('по', '×')}{' '}
            {formatPerUnit(selected.perUnit)}
          </span>
          <span className={s.summaryTotal}>{formatTotal(payableTotal)}</span>
        </div>

        <Checkbox
          checked={accepted}
          onChange={e => setAccepted(e.target.checked)}
          id="packages-offer"
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

        {auth.isAuthenticated && (
          <Checkbox
            checked={useBalance}
            disabled={cabinet.isPending || availableKopecks <= 0}
            onChange={e => setUseBalance(e.target.checked)}
          >
            {t('Использовать доступный реферальный баланс — доступно', 'Қолжетімді реферал балансын пайдалану — қолжетімді')}{' '}
            {cabinet.isPending ? '…' : formatRub(availableKopecks / 100)}
          </Checkbox>
        )}

        {/* Покупку намеренно не блокируем: код доступа работает и без учётной записи.
            Но вошедшему он сразу привяжется к кабинету — вместе с уже созданными
            в этом браузере стикерами, — поэтому предлагаем войти до оплаты. */}
        {!auth.isAuthenticated && (
          <Alert tone="info">
            {t('Купить можно без регистрации — код доступа выдадим сразу.', 'Тіркелусіз сатып алуға болады — қолжетімділік кодын бірден береміз.')}{' '}
            <Link className="accent" to="/login">
              {t('Войдите', 'Кіріңіз')}
            </Link>
            {t(
              ', и пакет вместе с уже созданными в этом браузере стикерами появится в личном кабинете.',
              ' — пакет осы браузерде жасалған стикерлермен бірге жеке кабинетте пайда болады.',
            )}
          </Alert>
        )}

        <Button
          size="lg"
          disabled={!accepted}
          loading={checkout.isPending}
          onClick={() => setConfirmOpen(true)}
        >
          {payableTotal > 0 ? t('Перейти к оплате', 'Төлемге өту') : t('Оплатить балансом', 'Баланспен төлеу')}
        </Button>

        {checkout.isError && <Alert tone="error">{checkout.error.message}</Alert>}

        <Modal
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={t('Проверьте заказ', 'Тапсырысты тексеріңіз')}
          description={t('После подтверждения откроется страница оплаты ЮKassa.', 'Растағаннан кейін ЮKassa төлем беті ашылады.')}
        >
          <div className="stack">
            <div className={s.confirmRow}>
              <span className="muted">{t('Что покупаете', 'Не сатып аласыз')}</span>
              <strong>{t('Пакет генераций', 'Генерация пакеті')}</strong>
            </div>
            <div className={s.confirmRow}>
              <span className="muted">{t('Количество', 'Саны')}</span>
              <strong>
                {selected.quantity} {selected.quantity === 1 ? t('генерация', 'генерация') : t('генераций', 'генерация')}
              </strong>
            </div>
            <div className={s.confirmRow}>
              <span className="muted">{t('Цена за генерацию', 'Бір генерация бағасы')}</span>
              <strong>{formatPerUnit(selected.perUnit)}</strong>
            </div>
            <div className={s.confirmRow}>
              <span className="muted">{t('К оплате', 'Төлеуге')}</span>
              <span className={s.confirmTotal}>{formatTotal(payableTotal)}</span>
            </div>

            {auth.isAuthenticated && useBalance && (
              <Alert tone="info">
                {t(
                  `Из реферального баланса спишется ${formatRub(appliedKopecks / 100)}. К оплате останется ${formatRub(payableTotal)}.`,
                  `Реферал балансынан ${formatRub(appliedKopecks / 100)} есептен шығарылады. Төлеуге ${formatRub(payableTotal)} қалады.`,
                )}
              </Alert>
            )}

            {!auth.isAuthenticated && (
              <>
                <Alert tone="info">
                  {t(
                    'Код доступа появится на этой странице сразу после оплаты и автоматически применится для генерации.',
                    'Қолжетімділік коды төлемнен кейін бірден осы бетте пайда болады және генерация үшін автоматты түрде қолданылады.',
                  )}
                </Alert>
                <Field
                  label={t('Электронная почта (необязательно)', 'Электрондық пошта (міндетті емес)')}
                  help={t(
                    'Если хотите получить код на почту и получать уведомления о генерациях — укажите её.',
                    'Кодты поштаға алғыңыз және генерациялар туралы хабарлама алғыңыз келсе — оны көрсетіңіз.',
                  )}
                >
                  <Input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} />
                </Field>
              </>
            )}

            <RubChargeNote rub={payableTotal} />

            <div className="row">
              <Button
                loading={checkout.isPending}
                disabled={!auth.isAuthenticated && email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())}
                onClick={() => checkout.mutate()}
              >
                {payableTotal > 0 ? t('Перейти к оплате', 'Төлемге өту') : t('Оплатить балансом', 'Баланспен төлеу')}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
                {t('Отмена', 'Болдырмау')}
              </Button>
            </div>

            {checkout.isError && <Alert tone="error">{checkout.error.message}</Alert>}
          </div>
        </Modal>
      </div>
    </>
  );
});

export const PricingPacks = observer(() => {
  const t = useT();
  const lp = useLocalePath();
  const { auth, generator } = useStores();
  const [selectedMode, setSelectedMode] = useState<'custom' | 'batch' | null>(null);
  const [selectedQuantity, setSelectedQuantity] = useState(1);
  const [accepted, setAccepted] = useState(false);
  const selectedPrice = selectedMode === 'batch' ? 20 : CUSTOM_GENERATION_PACKAGES[selectedQuantity];
  const checkout = useMutation({
    mutationFn: () => api<{ confirmationUrl: string; token: string }>('/api/payments/create', {
      method: 'POST',
      body: JSON.stringify({
        productKind: 'stickers',
        guestGenerationMode: selectedMode,
        guestGenerationQuantity: selectedMode === 'custom' ? selectedQuantity : undefined,
        accepted,
        returnTo: 'public',
      }),
    }),
    onSuccess: data => {
      rememberPendingOrder(localStorage, data.token);
      window.location.assign(data.confirmationUrl);
    },
  });

  const choose = (mode: 'custom' | 'batch') => {
    generator.setMode(mode === 'batch' ? 'range' : 'custom');
    if (mode === 'custom') setSelectedQuantity(1);
    setAccepted(false);
    setSelectedMode(mode);
  };

  return (
    <Section
      id="packages"
      align="center"
      eyebrow={t('Тарифы', 'Тарифтер')}
      title={t('Сколько стоит сгенерировать ШК ВБ', 'ШК ВБ генерациялау қанша тұрады')}
      lead={t(
        'Поштучная генерация по конкретному номеру — от 3 ₽. Чем больше пакет, тем ниже цена одной генерации.',
        'Нақты нөмір бойынша генерация — 3 ₽-ден. Пакет неғұрлым үлкен болса, бір генерация соғұрлым арзан.',
      )}
    >
      <div className={s.packRow}>
        <button type="button" className={s.pack} onClick={() => choose('custom')}><strong>{t('от 3 ₽', '3 ₽-ден')}</strong><span>{t('По конкретному номеру · пакеты до 100', 'Нақты нөмір бойынша · 100-ге дейін')}</span></button>
        <button type="button" className={`${s.pack} ${s.packPop}`} onClick={() => choose('batch')}><strong>20 ₽</strong><span>{t('Пачка из 50 кодов · один PDF', '50 кодтан тұратын пакет · бір PDF')}</span></button>
      </div>

      {/* Лесенка пакетов по номеру: чем больше, тем дешевле генерация. Клик по
          ступени открывает оплату с выбранным количеством. */}
      <div className={s.ladder}>
        {Object.entries(CUSTOM_GENERATION_PACKAGES).map(([quantityText, total]) => {
          const quantity = Number(quantityText);
          const perUnit = total / quantity;
          const discount = Math.round((1 - total / (7.5 * quantity)) * 100);
          return (
            <button
              key={quantity}
              type="button"
              className={s.lad}
              onClick={() => {
                generator.setMode('custom');
                setSelectedQuantity(quantity);
                setAccepted(false);
                setSelectedMode('custom');
              }}
            >
              <span className={s.ladQ}>{quantity} {t('шт', 'дана')}</span>
              <span className={s.ladP}>{formatCheckoutRub(total)}</span>
              <span className={s.ladU}>
                {formatCheckoutRub(perUnit)} / {t('шт', 'дана')}
                {discount > 0 && <> · <b>−{discount}%</b></>}
              </span>
            </button>
          );
        })}
      </div>

      {auth.isAuthenticated && <div className={s.checkout}><Link to="/cabinet/packages"><Button size="lg">{t('Пополнить баланс', 'Балансты толықтыру')}</Button></Link></div>}

      <Modal
        open={selectedMode !== null}
        onOpenChange={open => { if (!open) setSelectedMode(null); }}
        title={t('Способ оплаты', 'Төлем тәсілі')}
        description={selectedMode === 'batch'
          ? t('50 кодов одним PDF за 20 ₽', '50 код бір PDF-те 20 ₽')
          : t(`${selectedQuantity} генераций по конкретным номерам`, `Нақты нөмірлер бойынша ${selectedQuantity} генерация`)}
      >
        <div className="stack">
          {selectedMode === 'custom' && (
            <div className={s.packageTable} role="radiogroup" aria-label={t('Количество генераций', 'Генерациялар саны')}>
              {Object.entries(CUSTOM_GENERATION_PACKAGES).map(([quantityText, total]) => {
                const quantity = Number(quantityText);
                const perUnit = total / quantity;
                const discount = Math.round((1 - total / (7.5 * quantity)) * 100);
                return (
                  <button
                    key={quantity}
                    type="button"
                    role="radio"
                    aria-checked={selectedQuantity === quantity}
                    className={[s.packageOption, selectedQuantity === quantity && s.packageOptionActive].filter(Boolean).join(' ')}
                    onClick={() => setSelectedQuantity(quantity)}
                  >
                    <strong>{quantity} шт.</strong>
                    <span>{formatCheckoutRub(total)}</span>
                    <small>{formatCheckoutRub(perUnit)} / шт.{discount > 0 ? ` · −${discount}%` : ''}</small>
                  </button>
                );
              })}
            </div>
          )}
          <div className={s.confirmRow}>
            <span className="muted">{t('К оплате', 'Төлеуге')}</span>
            <span className={s.confirmTotal}>{formatCheckoutRub(selectedPrice)}</span>
          </div>

          <>
              <Card>
                <strong>{t('Банковская карта или СБП', 'Банк картасы немесе СБП')}</strong>
                <span className="muted">{t('Безопасная оплата через ЮKassa', 'ЮKassa арқылы қауіпсіз төлем')}</span>
              </Card>
              <Checkbox checked={accepted} onChange={event => setAccepted(event.target.checked)}>
                {t('Принимаю', 'Қабылдаймын')}{' '}
                <Link className="accent" to={lp('/offer')}>{t('оферту', 'офертаны')}</Link>{' '}
                {t('и', 'және')}{' '}
                <Link className="accent" to={lp('/privacy')}>{t('политику конфиденциальности', 'құпиялылық саясатын')}</Link>
              </Checkbox>
              <Button disabled={!accepted} loading={checkout.isPending} onClick={() => checkout.mutate()}>
                {t('Перейти к оплате', 'Төлемге өту')}
              </Button>
              {checkout.isError && <Alert tone="error">{checkout.error.message}</Alert>}
          </>
        </div>
      </Modal>
    </Section>
  );
});
