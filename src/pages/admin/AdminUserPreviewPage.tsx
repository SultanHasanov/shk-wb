import { ArrowLeft, Eye, History, KeyRound, PackageCheck, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useAdminUser } from '../../api/admin';
import { dateTime, money } from '../../api/cabinet';
import { Badge, Button, Card, Skeleton, Stat } from '../../ui';

const statusLabel = (status: string) => {
  if (status === 'paid') return 'Оплачен';
  if (status === 'cancelled') return 'Отменён';
  return 'Ожидает оплаты';
};

export function AdminUserPreviewPage() {
  const { userId = '' } = useParams();
  const query = useAdminUser(userId);

  if (query.isPending) return <div className="page"><Skeleton height={360} /></div>;
  if (query.isError) return <div className="page"><Card><p className="error">{query.error.message}</p></Card></div>;

  const user = query.data;
  const customOrders = user.customOrders ?? [];
  const activeKeys = user.codes.filter(item => item.active).length +
    user.programKeys.filter(item => item.active).length +
    user.cellLicenses.filter(item => item.active).length;
  const stickersTotal = user.codes.reduce((sum, item) => sum + item.limit, 0);
  const stickersLeft = user.codes.reduce((sum, item) => sum + Math.max(0, item.limit - item.used), 0);

  return (
    <div className="page stack-lg">
      <Card accent>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="row">
            <Eye size={20} />
            <div>
              <strong>Предпросмотр кабинета пользователя</strong>
              <div className="muted">Только просмотр — действия, оплата и скачивание отключены.</div>
            </div>
          </div>
          <Link to={`/panel/users/${userId}`}><Button variant="secondary" size="sm"><ArrowLeft size={16} />К карточке</Button></Link>
        </div>
      </Card>

      <header className="page-head">
        <h1>Здравствуйте, {user.profile?.display_name || user.telegram?.first_name || user.email || 'пользователь'}</h1>
        <p>Здесь собраны покупки, ключи и созданные стикеры.</p>
      </header>

      <div className="grid grid-3">
        <Card><Stat value={activeKeys} label="активных ключей" icon={<KeyRound size={20} />} /></Card>
        <Card><Stat value={stickersLeft} label={`генераций осталось из ${stickersTotal}`} icon={<PackageCheck size={20} />} /></Card>
        <Card><Stat value={user.historyEntries} label="созданных наборов" icon={<History size={20} />} /></Card>
      </div>

      <Card>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div><h2 style={{ marginBottom: 4 }}>Мои заказы</h2><p className="muted" style={{ margin: 0 }}>История покупок и индивидуальные заказы.</p></div>
          <ShieldCheck size={24} color="var(--accent)" />
        </div>
        <div className="stack section">
          {customOrders.length === 0 && user.orders.length === 0 && <p className="muted">Заказов пока нет.</p>}
          {customOrders.map(order => {
            const pending = order.status === 'pending_payment';
            return (
              <Card key={order.id} accent={pending}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div className="row"><strong>{order.title}</strong><Badge tone={order.status === 'paid' ? 'success' : 'warning'}>{statusLabel(order.status)}</Badge></div>
                    <p className="muted">{dateTime(order.created_at)} · {order.quantity} стикеров</p>
                    <div className="row">
                      <span>Полная стоимость: <strong>{money(Math.round(order.total_amount * 100))}</strong></span>
                      <span>Зачтено из пакета: <strong>{money(Math.round(order.paid_amount * 100))}</strong></span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="muted">К оплате</div>
                    <strong style={{ fontSize: 24 }}>{money(Math.round(order.amount_due * 100))}</strong>
                    <div style={{ marginTop: 10 }}><Button disabled>{pending ? `Оплатить ${money(Math.round(order.amount_due * 100))}` : 'Открыть стикеры'}</Button></div>
                  </div>
                </div>
                {pending && <p className="muted" style={{ marginBottom: 0 }}>Стикеры станут доступны для просмотра и скачивания после оплаты.</p>}
              </Card>
            );
          })}
        </div>
      </Card>

      <Card>
        <h2>Мои ключи и пакеты</h2>
        <div className="stack section">
          {user.codes.map(code => <div className="row" key={`code-${code.id}`}><Badge tone={code.active ? 'success' : 'default'}>{code.active ? 'Активен' : 'Неактивен'}</Badge><strong>{code.name || 'Генерации стикеров'}</strong><span className="muted">Использовано {code.used} из {code.limit}</span></div>)}
          {user.programKeys.map(key => <div className="row" key={`program-${key.id}`}><Badge tone={key.active ? 'success' : 'default'}>{key.active ? 'Активен' : 'Неактивен'}</Badge><strong>Программа</strong></div>)}
          {user.cellLicenses.map(key => <div className="row" key={`cell-${key.id}`}><Badge tone={key.active ? 'success' : 'default'}>{key.active ? 'Активен' : 'Неактивен'}</Badge><strong>Печать ячеек</strong><span className="muted">{key.marketplaceScope}</span></div>)}
          {!activeKeys && <p className="muted">Активных ключей нет.</p>}
        </div>
      </Card>
    </div>
  );
}
