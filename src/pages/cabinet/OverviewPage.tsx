import { Link } from 'react-router-dom';
import { KeyRound, Package, TriangleAlert } from 'lucide-react';
import { Card, Progress, Stat, Table } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, money, useCabinet } from '../../api/cabinet';
import { useDocumentMeta } from '../../lib/seo';

export function OverviewPage(){
  useDocumentMeta('Обзор — кабинет');const query=useCabinet();
  if(query.isPending)return <div className="page"><CabinetLoading/></div>;
  if(query.isError)return <div className="page"><CabinetError error={query.error} retry={()=>query.refetch()}/></div>;
  const {overview,orders}=query.data;const used=Math.max(0,overview.stickersTotal-overview.stickersLeft);
  return <div className="page">
    <header className="page-head"><h1>Обзор</h1><p>Ключи, лимиты, уведомления и последние заказы.</p></header>
    {overview.needsAttention>0&&<Card accent><div className="row"><TriangleAlert color="var(--accent)"/><strong>Есть ключи, срок которых скоро закончится</strong><Link className="accent" to="/cabinet/keys">Проверить →</Link></div></Card>}
    <div className="grid grid-3 section">
      <Card><Stat value={overview.activeKeys} label="активных ключей" icon={<KeyRound size={20}/>}/><Link className="accent" to="/cabinet/keys">Смотреть ключи →</Link></Card>
      <Card><Stat value={overview.stickersLeft} label="генераций осталось" icon={<Package size={20}/>}/><Progress value={used} max={Math.max(1,overview.stickersTotal)} label={<><span>Использовано</span><strong>{used} из {overview.stickersTotal}</strong></>}/></Card>
      <Card><Stat value={overview.needsAttention} label="требуют внимания" icon={<TriangleAlert size={20}/>}/><Link className="accent" to="/cabinet/notifications">Открыть уведомления →</Link></Card>
    </div>
    <section className="section"><h2>Последние заказы</h2>{orders.length?<Table><thead><tr><th>Дата</th><th>Покупка</th><th>Сумма</th><th>Статус</th></tr></thead><tbody>{orders.map(o=><tr key={o.id}><td>{dateTime(o.createdAt)}</td><td>{o.product}</td><td>{money(Math.round(o.amount*100))}</td><td>{o.status==='succeeded'?'Оплачен':o.status==='canceled'?'Отменён':'Ожидает оплаты'}</td></tr>)}</tbody></Table>:<Card>Покупок пока нет.</Card>}</section>
  </div>;
}
