import { useMemo,useState } from 'react';
import { FileText,Receipt } from 'lucide-react';
import { Badge,Button,Card,EmptyState,Modal,Segmented,Table } from '../../ui';
import { CabinetError,CabinetLoading } from '../../components/CabinetState';
import { dateTime,money,type Order,useOrders } from '../../api/cabinet';
import { SpecList } from '../../components/SpecList';
import { useDocumentMeta } from '../../lib/seo';

type Filter='all'|'succeeded'|'pending'|'canceled';
const tone=(s:string):'success'|'warning'|'error'=>s==='succeeded'?'success':s==='canceled'?'error':'warning';
const label=(s:string)=>s==='succeeded'?'Оплачен':s==='canceled'?'Отменён':'В ожидании';
export function OrdersPage(){
  useDocumentMeta('Заказы — кабинет');const query=useOrders();const [filter,setFilter]=useState<Filter>('all');const [open,setOpen]=useState<Order|null>(null);
  const rows=useMemo(()=>query.data?.items.filter(o=>filter==='all'||o.status===filter||(filter==='pending'&&o.status==='waiting_for_capture'))||[],[query.data,filter]);
  if(query.isPending)return <div className="page"><CabinetLoading/></div>;if(query.isError)return <div className="page"><CabinetError error={query.error} retry={()=>query.refetch()}/></div>;
  return <div className="page"><header className="page-head"><h1>Заказы</h1><p>Покупки программ, ключей и пакетов генераций.</p></header>
    <Segmented label="Статус заказа" value={filter} onChange={setFilter} options={[{value:'all',label:'Все'},{value:'succeeded',label:'Оплачены'},{value:'pending',label:'В ожидании'},{value:'canceled',label:'Отменены'}]}/>
    <div className="section">{rows.length?<Table><thead><tr><th>Номер</th><th>Дата</th><th>Покупка</th><th>Сумма</th><th>Статус</th><th/></tr></thead><tbody>{rows.map(o=><tr key={o.id}><td className="mono">{o.id.slice(0,8)}</td><td>{dateTime(o.createdAt)}</td><td>{o.product}</td><td>{money(Math.round(o.amount*100))}</td><td><Badge tone={tone(o.status)}>{label(o.status)}</Badge></td><td><Button variant="ghost" size="sm" onClick={()=>setOpen(o)}>Подробнее</Button></td></tr>)}</tbody></Table>:<Card><EmptyState icon={<Receipt/>} title="Заказов с таким статусом нет" text="Выберите другой фильтр."/></Card>}</div>
    <Modal open={!!open} onOpenChange={v=>!v&&setOpen(null)} title={open?`Заказ ${open.id.slice(0,8)}`:'Заказ'}>{open&&<div className="stack"><Badge tone={tone(open.status)}>{label(open.status)}</Badge><SpecList flush items={[{term:'Покупка',value:open.product},{term:'Сумма до скидок',value:money(Math.round(open.grossAmount*100))},{term:'Оплачено балансом',value:money(open.referralCreditKopecks)},{term:'К оплате',value:money(Math.round(open.amount*100))},...(open.accessCode?[{term:'Код доступа',value:open.accessCode}]:[]),...(open.licenseKey?[{term:'Лицензионный ключ',value:open.licenseKey}]:[])]}/>{open.receiptUrl&&<a href={open.receiptUrl} target="_blank" rel="noreferrer"><Button variant="secondary"><FileText size={16}/>Чек ЮKassa</Button></a>}</div>}</Modal>
  </div>;
}
