import { Link } from 'react-router-dom';
import { KeyRound, Package, TriangleAlert } from 'lucide-react';
import { Card, Progress, Stat, Table } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, money, useCabinet } from '../../api/cabinet';
import { useDocumentMeta } from '../../lib/seo';
import { useT } from '../../i18n';

export function OverviewPage(){
  const t=useT();
  useDocumentMeta(t('Обзор — кабинет','Шолу — кабинет'));const query=useCabinet();
  if(query.isPending)return <div className="page"><CabinetLoading/></div>;
  if(query.isError)return <div className="page"><CabinetError error={query.error} retry={()=>query.refetch()}/></div>;
  const {overview,orders}=query.data;const used=Math.max(0,overview.stickersTotal-overview.stickersLeft);
  const status=(s:string)=>s==='succeeded'?t('Оплачен','Төленді'):s==='canceled'?t('Отменён','Бас тартылды'):t('Ожидает оплаты','Төлемді күтуде');
  return <div className="page">
    <header className="page-head"><h1>{t('Обзор','Шолу')}</h1><p>{t('Ключи, лимиты, уведомления и последние заказы.','Кілттер, лимиттер, хабарламалар және соңғы тапсырыстар.')}</p></header>
    {overview.needsAttention>0&&<Card accent><div className="row"><TriangleAlert color="var(--accent)"/><strong>{t('Есть ключи, срок которых скоро закончится','Мерзімі жақында бітетін кілттер бар')}</strong><Link className="accent" to="/cabinet/keys">{t('Проверить →','Тексеру →')}</Link></div></Card>}
    <div className="grid grid-3 section">
      <Card><Stat value={overview.activeKeys} label={t('активных ключей','белсенді кілт')} icon={<KeyRound size={20}/>}/><Link className="accent" to="/cabinet/keys">{t('Смотреть ключи →','Кілттерді көру →')}</Link></Card>
      <Card><Stat value={overview.stickersLeft} label={t('генераций осталось','генерация қалды')} icon={<Package size={20}/>}/><Progress value={used} max={Math.max(1,overview.stickersTotal)} label={<><span>{t('Использовано','Пайдаланылды')}</span><strong>{t(`${used} из ${overview.stickersTotal}`,`${overview.stickersTotal} ішінен ${used}`)}</strong></>}/></Card>
      <Card><Stat value={overview.needsAttention} label={t('требуют внимания','назар аударуды қажет етеді')} icon={<TriangleAlert size={20}/>}/><Link className="accent" to="/cabinet/notifications">{t('Открыть уведомления →','Хабарламаларды ашу →')}</Link></Card>
    </div>
    <section className="section"><h2>{t('Последние заказы','Соңғы тапсырыстар')}</h2>{orders.length?<Table><thead><tr><th>{t('Дата','Күні')}</th><th>{t('Покупка','Сатып алу')}</th><th>{t('Сумма','Сомасы')}</th><th>{t('Статус','Мәртебесі')}</th></tr></thead><tbody>{orders.map(o=><tr key={o.id}><td>{dateTime(o.createdAt)}</td><td>{o.product}</td><td>{money(Math.round(o.amount*100))}</td><td>{status(o.status)}</td></tr>)}</tbody></Table>:<Card>{t('Покупок пока нет.','Әзірге сатып алулар жоқ.')}</Card>}</section>
  </div>;
}
