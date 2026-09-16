import { useState } from 'react';
import { Copy, Users } from 'lucide-react';
import { Alert, Badge, Button, Card, Field, Input, Stat, Table, useToast } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, money, useCabinet, useCabinetMutation } from '../../api/cabinet';
import { useDocumentMeta } from '../../lib/seo';
import c from './cabinet.module.css';

export function ReferralsPage() {
  useDocumentMeta('Рефералы — кабинет');
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
          toast('Заявка отправлена', 'success');
        },
      },
    );

  return (
    <div className="page">
      <header className="page-head">
        <h1>Рефералы</h1>
        <p>10% от денежной части всех успешных покупок приглашённых пользователей.</p>
      </header>

      <div className="grid grid-4">
        <Card>
          <Stat value={r.invited} label="приглашено" icon={<Users size={20} />} />
        </Card>
        <Card>
          <Stat value={money(r.availableKopecks)} label="доступно к выводу" />
        </Card>
        <Card>
          <Stat value={money(r.earnedKopecks)} label="заработано всего" />
        </Card>
        <Card>
          <Stat value={money(r.paidKopecks)} label="выплачено" />
        </Card>
      </div>

      {/* «Заработано» — сумма всех начислений за всё время, «доступно» — то, что
          прямо сейчас можно вывести. Пока это не объясняли, нули в «доступно»
          при ненулевом «заработано» выглядели ошибкой. */}
      {r.reservedKopecks > 0 && (
        <Card className="section">
          <Stat value={money(r.reservedKopecks)} label="в резерве" />
          <p className={c.hint}>
            Эти деньги удержаны под уже созданную заявку на выплату или под неоплаченный заказ, где
            вы применили баланс. Они вернутся в «доступно», если заявку отклонят или заказ
            отменится.
          </p>
        </Card>
      )}

      <Card className="section">
        <Field label="Персональная ссылка">
          <div className={c.refLink}>
            <Input value={r.link} readOnly />
            <Button
              variant="secondary"
              onClick={() => {
                navigator.clipboard?.writeText(r.link);
                toast('Ссылка скопирована', 'success');
              }}
            >
              <Copy size={16} />
              Копировать
            </Button>
          </div>
        </Field>

        <Alert tone="info">
          Отправьте ссылку кому угодно: она открывает обычный сайт, где можно сразу создавать
          стикеры и покупать пакеты. Приглашение запоминается в браузере человека на 30 дней и
          закрепляется за вами в момент, когда он создаст аккаунт. После этого вы получаете 10% от
          каждой его оплаты. Приглашение не сработает, если у человека уже есть аккаунт или он
          зарегистрируется позже 30 дней.
        </Alert>
      </Card>

      <Card className="section">
        <h2>Приглашённые пользователи</h2>
        {referrals.length ? (
          <Table>
            <thead>
              <tr>
                <th>Реферал</th>
                <th>Дата приглашения</th>
                <th>Покупки</th>
                <th>Сумма покупок</th>
                <th>Заработано</th>
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
          <p className="muted">Приглашённых пользователей пока нет.</p>
        )}
      </Card>

      <div className="grid grid-2 section">
        <Card>
          <h2>Запросить выплату</h2>
          <div className="stack">
            <Field label="Сумма, ₽" help="Минимум 500 ₽">
              <Input
                type="number"
                min="500"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Телефон СБП">
              <Input value={phone} onChange={e => setPhone(e.target.value)} />
            </Field>
            <Field label="Банк">
              <Input value={bank} onChange={e => setBank(e.target.value)} />
            </Field>
            <Button
              disabled={Number(amount) < 500 || !phone || !bank}
              loading={withdraw.isPending}
              onClick={submit}
            >
              Создать заявку
            </Button>
            {withdraw.isError && <Alert tone="error">{withdraw.error.message}</Alert>}
          </div>
        </Card>

        <Card>
          <h2>Заявки</h2>
          {r.withdrawals.length ? (
            <Table>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Сумма</th>
                  <th>Статус</th>
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
            <p className="muted">Заявок пока нет.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
