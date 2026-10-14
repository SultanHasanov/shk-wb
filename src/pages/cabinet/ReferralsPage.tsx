import { useState } from 'react';
import { Copy, Users } from 'lucide-react';
import { Alert, Badge, Button, Card, Field, Input, Stat, Table, useToast } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, money, useCabinet, useCabinetMutation } from '../../api/cabinet';
import { useDocumentMeta } from '../../lib/seo';
import { useT } from '../../i18n';
import c from './cabinet.module.css';

export function ReferralsPage() {
  const t = useT();
  useDocumentMeta(t('Рефералы — кабинет', 'Рефералдар — кабинет'));
  const query = useCabinet();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [bank, setBank] = useState('');
  const withdraw = useCabinetMutation<{ amountKopecks: number; phone: string; bank: string }>(
    '/api/cabinet/referrals/withdraw',
  );

  if (query.isPending)
    return (
      <div className="page">
        <CabinetLoading />
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <CabinetError error={query.error} retry={() => query.refetch()} />
      </div>
    );

  const r = query.data.referral;
  const referrals = r.referrals || [];
  const submit = () =>
    withdraw.mutate(
      { amountKopecks: Math.round(Number(amount) * 100), phone, bank },
      {
        onSuccess: () => {
          setAmount('');
          toast(t('Заявка отправлена', 'Өтінім жіберілді'), 'success');
        },
      },
    );

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('Рефералы', 'Рефералдар')}</h1>
        <p>{t('10% от денежной части всех успешных покупок приглашённых пользователей.', 'Шақырылған пайдаланушылардың барлық сәтті сатып алуларының ақшалай бөлігінен 10%.')}</p>
      </header>

      <div className="grid grid-4">
        <Card>
          <Stat value={r.invited} label={t('приглашено', 'шақырылды')} icon={<Users size={20} />} />
        </Card>
        <Card>
          <Stat value={money(r.availableKopecks)} label={t('доступно к выводу', 'шығаруға қолжетімді')} />
        </Card>
        <Card>
          <Stat value={money(r.earnedKopecks)} label={t('заработано всего', 'барлығы табылды')} />
        </Card>
        <Card>
          <Stat value={money(r.paidKopecks)} label={t('выплачено', 'төленді')} />
        </Card>
      </div>

      {/* «Заработано» — сумма всех начислений за всё время, «доступно» — то, что
          прямо сейчас можно вывести. Пока это не объясняли, нули в «доступно»
          при ненулевом «заработано» выглядели ошибкой. */}
      {r.reservedKopecks > 0 && (
        <Card className="section">
          <Stat value={money(r.reservedKopecks)} label={t('в резерве', 'резервте')} />
          <p className={c.hint}>
            {t(
              'Эти деньги удержаны под уже созданную заявку на выплату или под неоплаченный заказ, где вы применили баланс. Они вернутся в «доступно», если заявку отклонят или заказ отменится.',
              'Бұл ақша жасалған төлем өтініміне немесе балансты қолданған төленбеген тапсырысқа ұсталған. Өтінім қабылданбаса немесе тапсырыстан бас тартылса, ол «қолжетімдіге» қайтарылады.',
            )}
          </p>
        </Card>
      )}

      <Card className="section">
        <Field label={t('Персональная ссылка', 'Жеке сілтеме')}>
          <div className={c.refLink}>
            <Input value={r.link} readOnly />
            <Button
              variant="secondary"
              onClick={() => {
                navigator.clipboard?.writeText(r.link);
                toast(t('Ссылка скопирована', 'Сілтеме көшірілді'), 'success');
              }}
            >
              <Copy size={16} />
              {t('Копировать', 'Көшіру')}
            </Button>
          </div>
        </Field>

        <Alert tone="info">
          {t(
            'Отправьте ссылку кому угодно: она открывает обычный сайт, где можно сразу создавать стикеры и покупать пакеты. Приглашение запоминается в браузере человека на 30 дней и закрепляется за вами в момент, когда он создаст аккаунт. После этого вы получаете 10% от каждой его оплаты. Приглашение не сработает, если у человека уже есть аккаунт или он зарегистрируется позже 30 дней.',
            'Сілтемені кез келген адамға жіберіңіз: ол бірден стикер жасауға және пакет сатып алуға болатын кәдімгі сайтты ашады. Шақыру адамның браузерінде 30 күн сақталады және ол аккаунт жасаған сәтте сізге бекітіледі. Содан кейін сіз оның әр төлемінен 10% аласыз. Адамның аккаунты бұрыннан болса немесе ол 30 күннен кейін тіркелсе, шақыру жұмыс істемейді.',
          )}
        </Alert>
      </Card>

      <Card className="section">
        <h2>{t('Приглашённые пользователи', 'Шақырылған пайдаланушылар')}</h2>
        {referrals.length ? (
          <Table>
            <thead>
              <tr>
                <th>{t('Реферал', 'Реферал')}</th>
                <th>{t('Дата приглашения', 'Шақыру күні')}</th>
                <th>{t('Покупки', 'Сатып алулар')}</th>
                <th>{t('Сумма покупок', 'Сатып алулар сомасы')}</th>
                <th>{t('Заработано', 'Табылды')}</th>
              </tr>
            </thead>
            <tbody>
              {referrals.map(referral => (
                <tr key={referral.id}>
                  <td>{referral.label}</td>
                  <td>{dateTime(referral.attributedAt)}</td>
                  <td>{referral.purchases}</td>
                  <td>{money(referral.purchasesKopecks)}</td>
                  <td>{money(referral.earnedKopecks)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="muted">{t('Приглашённых пользователей пока нет.', 'Әзірге шақырылған пайдаланушылар жоқ.')}</p>
        )}
      </Card>

      <div className="grid grid-2 section">
        <Card>
          <h2>{t('Запросить выплату', 'Төлемді сұрау')}</h2>
          <div className="stack">
            <Field label={t('Сумма, ₽', 'Сомасы, ₽')} help={t('Минимум 500 ₽', 'Кемінде 500 ₽')}>
              <Input
                type="number"
                min="500"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </Field>
            <Field label={t('Телефон СБП', 'СБП телефоны')}>
              <Input value={phone} onChange={e => setPhone(e.target.value)} />
            </Field>
            <Field label={t('Банк', 'Банк')}>
              <Input value={bank} onChange={e => setBank(e.target.value)} />
            </Field>
            <Button
              disabled={Number(amount) < 500 || !phone || !bank}
              loading={withdraw.isPending}
              onClick={submit}
            >
              {t('Создать заявку', 'Өтінім жасау')}
            </Button>
            {withdraw.isError && <Alert tone="error">{withdraw.error.message}</Alert>}
          </div>
        </Card>

        <Card>
          <h2>{t('Заявки', 'Өтінімдер')}</h2>
          {r.withdrawals.length ? (
            <Table>
              <thead>
                <tr>
                  <th>{t('Дата', 'Күні')}</th>
                  <th>{t('Сумма', 'Сомасы')}</th>
                  <th>{t('Статус', 'Мәртебесі')}</th>
                </tr>
              </thead>
              <tbody>
                {r.withdrawals.map(w => (
                  <tr key={w.id}>
                    <td>{dateTime(w.created_at)}</td>
                    <td>{money(w.amountKopecks)}</td>
                    <td>
                      <Badge>{w.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="muted">{t('Заявок пока нет.', 'Әзірге өтінімдер жоқ.')}</p>
          )}
        </Card>
      </div>
    </div>
  );
}
