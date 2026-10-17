import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, Download, Laptop, Minus, Unlink } from 'lucide-react';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Modal, Progress, Segmented, useToast } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { api } from '../../api/client';
import { useCabinet } from '../../api/cabinet';
import { type AppAccount, type AppPlan, type AppPlanId, type AppPlans, daysLeft, useAppAccount, useAppPlans, useRevokeAppDevice } from '../../api/app';
import { PROGRAM_DOWNLOAD_URL } from '../../lib/downloads';
import { useMoney } from '../../lib/currency';
import { formatTotal as formatRub } from '../../lib/pricing';
import { useDocumentMeta } from '../../lib/seo';
import { intlLocale, type T, useLocale, useLocalePath, useT } from '../../i18n';
import s from './SubscriptionPage.module.css';

const RANK: Record<AppPlanId, number> = { basic: 0, standard: 1, pro: 2 };

function useDate() {
  const locale = useLocale();
  return (iso: string) => new Date(iso).toLocaleDateString(intlLocale(locale), { day: 'numeric', month: 'long', year: 'numeric' });
}

function monthsWord(n: number, t: T) {
  if (n === 1) return t('1 месяц', '1 ай');
  if (n < 5) return t(`${n} месяца`, `${n} ай`);
  return t(`${n} месяцев`, `${n} ай`);
}

type Checkout = { plan: AppPlan; months: number };

function CheckoutModal({ checkout, account, availableKopecks, onClose }: { checkout: Checkout; account: AppAccount; availableKopecks: number; onClose: () => void }) {
  const t = useT();
  const lp = useLocalePath();
  const { formatTotal } = useMoney();
  const date = useDate();
  const [accepted, setAccepted] = useState(false);
  const [useBalance, setUseBalance] = useState(false);
  const total = checkout.plan.prices[String(checkout.months)];
  const totalKopecks = Math.round(total * 100);
  const appliedKopecks = useBalance ? Math.min(totalKopecks, availableKopecks) : 0;
  const payable = (totalKopecks - appliedKopecks) / 100;
  const current = account.subscription;
  const mode = !current ? 'new' : current.plan === checkout.plan.id ? 'extend' : RANK[checkout.plan.id] > RANK[current.plan] ? 'upgrade' : 'downgrade';

  const payment = useMutation({
    mutationFn: () => api<{ confirmationUrl: string }>('/api/payments/create', {
      method: 'POST',
      body: JSON.stringify({
        productKind: 'app_subscription',
        appPlan: checkout.plan.id,
        appTermMonths: checkout.months,
        accepted,
        returnTo: 'cabinet',
        referralCreditKopecks: useBalance ? Number.MAX_SAFE_INTEGER : 0,
      }),
    }),
    onSuccess: data => location.assign(data.confirmationUrl),
  });

  return (
    <Modal open onOpenChange={open => !open && onClose()} title={t(`Тариф «${checkout.plan.title}» на ${monthsWord(checkout.months, t)}`, `«${checkout.plan.title}» тарифі, ${monthsWord(checkout.months, t)}`)} description={t('После подтверждения откроется защищённая страница оплаты ЮKassa.', 'Растағаннан кейін ЮKassa-ның қорғалған төлем беті ашылады.')}>
      <div className="stack">
        {mode === 'extend' && current && <Alert tone="info">{t(`Срок добавится к текущему: подписка будет действовать на ${monthsWord(checkout.months, t)} дольше ${date(current.paidUntil)}.`, `Мерзім ағымдағыға қосылады: жазылым ${date(current.paidUntil)} күнінен ${monthsWord(checkout.months, t)} ұзағырақ жұмыс істейді.`)}</Alert>}
        {mode === 'upgrade' && <Alert tone="info">{t('Новый тариф начнёт работать сразу. Неиспользованные дни текущего тарифа не сгорят: мы пересчитаем их по стоимости и добавим к новому сроку.', 'Жаңа тариф бірден іске қосылады. Ағымдағы тарифтің пайдаланылмаған күндері жанбайды: оларды құны бойынша қайта есептеп, жаңа мерзімге қосамыз.')}</Alert>}
        {mode === 'downgrade' && current && <Alert tone="warning">{t(`Тариф «${checkout.plan.title}» начнёт действовать после окончания оплаченного срока — ${date(current.paidUntil)}.`, `«${checkout.plan.title}» тарифі төленген мерзім аяқталғаннан кейін — ${date(current.paidUntil)} күні күшіне енеді.`)}</Alert>}
        <div className="row">
          <span className="muted">{t('К оплате', 'Төлеуге')}</span>
          <strong style={{ fontSize: 'var(--fs-24)' }}>{formatTotal(payable)}</strong>
        </div>
        <Checkbox checked={accepted} onChange={e => setAccepted(e.target.checked)}>
          {t('Принимаю', 'Мен')}{' '}
          <a className="accent" href={lp('/offer')} target="_blank" rel="noreferrer">{t('оферту', 'офертаны')}</a>{' '}
          {t('и', 'және')}{' '}
          <a className="accent" href={lp('/privacy')} target="_blank" rel="noreferrer">{t('политику конфиденциальности', 'құпиялылық саясатын')}</a>
          {t('', ' қабылдаймын')}
        </Checkbox>
        {availableKopecks > 0 && (
          <Checkbox checked={useBalance} onChange={e => setUseBalance(e.target.checked)}>
            {t('Использовать реферальный баланс — доступно', 'Реферал балансын пайдалану — қолжетімді')} {formatRub(availableKopecks / 100)}
          </Checkbox>
        )}
        {payment.isError && <Alert tone="error">{payment.error.message}</Alert>}
        <div className="row">
          <Button disabled={!accepted} loading={payment.isPending} onClick={() => payment.mutate()}>
            {payable > 0 ? t('Перейти к оплате', 'Төлемге өту') : t('Оплатить балансом', 'Баланспен төлеу')}
          </Button>
          <Button variant="secondary" onClick={onClose}>{t('Отмена', 'Болдырмау')}</Button>
        </div>
      </div>
    </Modal>
  );
}

function CurrentPlan({ account, onExtend }: { account: AppAccount; onExtend: () => void }) {
  const t = useT();
  const date = useDate();
  const sub = account.subscription;
  if (!sub) {
    return (
      <Card accent>
        <div className="stack">
          <h2 style={{ margin: 0 }}>{t('Подписки пока нет', 'Әзірге жазылым жоқ')}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {account.packsLeft > 0
              ? t(`Программа работает в режиме подбора кода по пакетам: осталось ${account.packsLeft}. Ячейки, «В пути», досье и остальные разделы откроются с тарифом.`, `Бағдарлама пакеттер бойынша код іріктеу режимінде жұмыс істейді: ${account.packsLeft} қалды. Ұяшықтар, «Жолда», досье және басқа бөлімдер тарифпен ашылады.`)
              : t('Выберите тариф ниже — он заработает в программе сразу после оплаты, достаточно войти тем же логином и паролем.', 'Төменде тарифті таңдаңыз — ол төлемнен кейін бірден бағдарламада іске қосылады, сол логин мен құпиясөзбен кіру жеткілікті.')}
          </p>
        </div>
      </Card>
    );
  }
  const total = new Date(sub.endsAt).getTime() - new Date(sub.startsAt).getTime();
  const passed = Date.now() - new Date(sub.startsAt).getTime();
  const left = daysLeft(sub.paidUntil);
  return (
    <Card accent>
      <div className="stack">
        <div className={s.planHead}>
          <div>
            <span className="muted">{t('Ваш тариф', 'Сіздің тарифіңіз')}</span>
            <h2 className={s.planName}>{sub.title}</h2>
          </div>
          <Badge tone={left <= 3 ? 'warning' : 'success'}>{left <= 3 ? t('Скоро закончится', 'Жақында аяқталады') : t('Активна', 'Белсенді')}</Badge>
        </div>
        <div className={s.term}><div className={s.termFill} style={{ width: `${Math.min(100, Math.max(2, (passed / total) * 100))}%` }} /></div>
        <p style={{ margin: 0 }}>
          {t(`Оплачено до ${date(sub.paidUntil)} · осталось ${left} дн.`, `${date(sub.paidUntil)} дейін төленген · ${left} күн қалды`)}
        </p>
        {sub.nextPlan && <p className="muted" style={{ margin: 0 }}>{t(`С ${date(sub.endsAt)} — тариф «${sub.nextPlan === 'basic' ? 'Базовый' : sub.nextPlan === 'standard' ? 'Стандарт' : 'Про'}».`, `${date(sub.endsAt)} бастап — «${sub.nextPlan}» тарифі.`)}</p>}
        <div className="row">
          <Button onClick={onExtend}>{t('Продлить', 'Ұзарту')}</Button>
          <a href="#plans"><Button variant="secondary">{t('Сменить тариф', 'Тарифті ауыстыру')}</Button></a>
        </div>
      </div>
    </Card>
  );
}

function Limits({ account }: { account: AppAccount }) {
  const t = useT();
  const date = useDate();
  const q = account.quota;
  return (
    <Card>
      <div className="stack">
        <h2 style={{ margin: 0 }}>{t('Лимиты этого месяца', 'Осы айдың лимиттері')}</h2>
        {q ? (
          <>
            <Progress value={q.codes.used} max={q.codes.limit} tone={q.codes.used >= q.codes.limit ? 'danger' : 'accent'} label={t(`Подборы кода: ${q.codes.used} из ${q.codes.limit}`, `Код іріктеу: ${q.codes.limit} ішінен ${q.codes.used}`)} />
            {q.stickers.limit > 0 && <Progress value={q.stickers.used} max={q.stickers.limit} label={t(`Стикеры: ${q.stickers.used} из ${q.stickers.limit}`, `Стикерлер: ${q.stickers.limit} ішінен ${q.stickers.used}`)} />}
            <p className="muted" style={{ margin: 0 }}>{t(`Обновятся ${date(q.resetAt)}. Неизрасходованное не переносится.`, `${date(q.resetAt)} жаңарады. Жұмсалмағаны келесі айға ауыспайды.`)}</p>
          </>
        ) : <p className="muted" style={{ margin: 0 }}>{t('Месячные лимиты появятся с подпиской.', 'Айлық лимиттер жазылыммен пайда болады.')}</p>}
        <p style={{ margin: 0 }}>
          {t('Пакеты подборов сверх лимита:', 'Лимиттен тыс іріктеу пакеттері:')} <strong>{account.packsLeft}</strong>
          {account.stickerPacksLeft > 0 && <> · {t('стикеры в пакетах:', 'пакеттердегі стикерлер:')} <strong>{account.stickerPacksLeft}</strong></>}
        </p>
        <p className="muted" style={{ margin: 0 }}>{t('Когда месячный лимит закончится, подборы спишутся из пакетов. Пакеты покупаются в разделе «Ключи и доступы».', 'Айлық лимит біткенде, іріктеулер пакеттерден алынады. Пакеттер «Кілттер мен қолжетімділік» бөлімінде сатылады.')}</p>
      </div>
    </Card>
  );
}

function Devices({ account }: { account: AppAccount }) {
  const t = useT();
  const toast = useToast();
  const revoke = useRevokeAppDevice();
  return (
    <Card>
      <div className="stack">
        <div className="row"><h2 style={{ margin: 0 }}>{t('Компьютеры', 'Компьютерлер')}</h2><Badge>{account.devices.length} / {account.deviceLimit}</Badge></div>
        {account.devices.length === 0
          ? <EmptyState icon={<Laptop />} title={t('Программа ещё не подключена', 'Бағдарлама әлі қосылмаған')} text={t('Установите «Помощник ПВЗ» и войдите тем же логином и паролем, что на сайте.', '«ПВЗ көмекшісін» орнатып, сайттағы логин мен құпиясөзбен кіріңіз.')} />
          : <div>{account.devices.map(device => (
              <div key={device.id} className={s.device}>
                <div>
                  <strong>{device.name}</strong>
                  <div className="muted" style={{ fontSize: 'var(--fs-13)' }}>{t('Был в сети', 'Желіде болды')} {new Date(device.lastSeenAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{device.appVersion ? ` · v${device.appVersion}` : ''}</div>
                </div>
                <Button variant="ghost" size="sm" loading={revoke.isPending && revoke.variables === device.id} onClick={() => revoke.mutate(device.id, { onSuccess: () => toast(t('Компьютер отключён', 'Компьютер ажыратылды'), 'success') })}><Unlink size={15} />{t('Отключить', 'Ажырату')}</Button>
              </div>
            ))}</div>}
        <p className="muted" style={{ margin: 0 }}>{t('Отключённый компьютер выйдет из аккаунта при следующем обращении к серверу.', 'Ажыратылған компьютер серверге келесі жүгінгенде аккаунттан шығады.')}</p>
      </div>
    </Card>
  );
}

function PlanCards({ plans, account, onChoose }: { plans: AppPlans; account: AppAccount; onChoose: (c: Checkout) => void }) {
  const t = useT();
  const { formatTotal } = useMoney();
  const [months, setMonths] = useState(1);
  const current = account.subscription?.plan;
  return (
    <div className="stack" id="plans">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('Тарифы', 'Тарифтер')}</h2>
        <Segmented
          label={t('Срок подписки', 'Жазылым мерзімі')}
          value={String(months)}
          onChange={v => setMonths(Number(v))}
          options={plans.terms.map(term => ({ value: String(term.months), label: term.discountPercent ? `${monthsWord(term.months, t)} −${term.discountPercent}%` : monthsWord(term.months, t) }))}
        />
      </div>
      <div className={s.plans}>
        {plans.plans.map(plan => {
          const price = plan.prices[String(months)];
          const isCurrent = current === plan.id;
          const action = !current ? t('Оформить', 'Рәсімдеу') : isCurrent ? t('Продлить', 'Ұзарту') : RANK[plan.id] > RANK[current] ? t('Перейти', 'Ауысу') : t('Перейти после окончания', 'Аяқталғаннан кейін ауысу');
          return (
            <div key={plan.id} className={`${s.plan} ${isCurrent ? s.planCurrent : ''}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0 }}>{plan.title}</h3>
                {isCurrent && <Badge tone="accent">{t('Текущий', 'Ағымдағы')}</Badge>}
              </div>
              <p className="muted" style={{ margin: 0 }}>{plan.summary}</p>
              <div>
                <div className={s.price}>{formatTotal(price)}</div>
                <div className="muted" style={{ fontSize: 'var(--fs-13)' }}>
                  {months > 1 ? t(`за ${monthsWord(months, t)} · ${formatTotal(Math.round(price / months))} в месяц`, `${monthsWord(months, t)} · айына ${formatTotal(Math.round(price / months))}`) : t('в месяц', 'айына')}
                </div>
              </div>
              <ul className={s.limits}>
                <li>{t(`${plan.codes} подборов кода в месяц`, `Айына ${plan.codes} код іріктеу`)}</li>
                {plan.stickers > 0 && <li>{t(`${plan.stickers} стикеров в месяц`, `Айына ${plan.stickers} стикер`)}</li>}
                <li>{plan.devices === 1 ? t('1 компьютер', '1 компьютер') : t(`До ${plan.devices} компьютеров`, `${plan.devices} компьютерге дейін`)}</li>
              </ul>
              <ul className={s.features}>
                {Object.entries(plans.features).map(([id, title]) => {
                  const on = plan.features.includes(id);
                  return <li key={id} className={on ? '' : s.off}>{on ? <Check size={16} className={s.check} /> : <Minus size={16} />}{title}</li>;
                })}
              </ul>
              <Button variant={isCurrent || !current ? 'primary' : 'secondary'} onClick={() => onChoose({ plan, months })}>{action}</Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SubscriptionPage() {
  const t = useT();
  useDocumentMeta(t('Подписка «Помощник ПВЗ» — кабинет', '«ПВЗ көмекшісі» жазылымы — кабинет'));
  const account = useAppAccount();
  const plans = useAppPlans();
  const cabinet = useCabinet();
  const [checkout, setCheckout] = useState<Checkout | null>(null);

  if (account.isPending || plans.isPending) return <div className="page"><CabinetLoading /></div>;
  if (account.isError) return <div className="page"><CabinetError error={account.error} retry={() => account.refetch()} /></div>;
  if (plans.isError) return <div className="page"><CabinetError error={plans.error} retry={() => plans.refetch()} /></div>;

  const extend = () => {
    const plan = plans.data.plans.find(p => p.id === account.data.subscription?.plan);
    if (plan) setCheckout({ plan, months: 1 });
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('Подписка «Помощник ПВЗ»', '«ПВЗ көмекшісі» жазылымы')}</h1>
        <p>{t('Тариф, лимиты и компьютеры программы. Войти в программу можно тем же логином и паролем, что на сайте.', 'Бағдарламаның тарифі, лимиттері және компьютерлері. Бағдарламаға сайттағы логин мен құпиясөзбен кіруге болады.')}</p>
      </header>
      <div className="grid grid-2">
        <CurrentPlan account={account.data} onExtend={extend} />
        <Limits account={account.data} />
      </div>
      <Devices account={account.data} />
      <PlanCards plans={plans.data} account={account.data} onChoose={setCheckout} />
      <div className="row">
        <a href={PROGRAM_DOWNLOAD_URL}><Button variant="secondary"><Download size={16} />{t('Скачать программу', 'Бағдарламаны жүктеп алу')}</Button></a>
      </div>
      {checkout && <CheckoutModal checkout={checkout} account={account.data} availableKopecks={cabinet.data?.referral.availableKopecks ?? 0} onClose={() => setCheckout(null)} />}
    </div>
  );
}
