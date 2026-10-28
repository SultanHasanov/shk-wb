import { Link } from 'react-router-dom';
import { AppWindow, KeyRound, Package, Printer, TriangleAlert } from 'lucide-react';
import { Card, Progress, Stat, Table } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, money, useCabinet, type CellPrintAsset } from '../../api/cabinet';
import { daysLeft, useAppAccount } from '../../api/app';
import { useDocumentMeta } from '../../lib/seo';
import { type T, useT } from '../../i18n';

/** Сводка по тарифу «Помощника ПВЗ»: берём живые данные из /api/app/me (как на
 *  странице подписки), а не копируем логику тарифов. Страница Обзора мягко
 *  переживает недоступность этого запроса — карточка просто показывает заглушку. */
function HelperSummary({ t }: { t: T }) {
  const account = useAppAccount();
  const acc = account.data;
  let value = t('Загрузка…', 'Жүктелуде…');
  let hint = '';
  if (account.isError) value = t('Нет данных', 'Дерек жоқ');
  else if (acc) {
    if (acc.unlimited) value = t('Безлимитный доступ', 'Шексіз қолжетімділік');
    else if (acc.freeMode) { value = t('Бесплатный период', 'Тегін кезең'); hint = acc.freeUntil ? t(`до ${dateTime(acc.freeUntil)}`, `${dateTime(acc.freeUntil)} дейін`) : ''; }
    else if (acc.subscription) {
      value = acc.subscription.title;
      const until = acc.subscription.paidUntil || acc.subscription.endsAt;
      const days = daysLeft(until);
      hint = t(`ещё ${days} дн.`, `тағы ${days} күн`);
    } else if (acc.packsLeft > 0) { value = t('Базовый · пакеты', 'Негізгі · пакеттер'); hint = t(`${acc.packsLeft} подборов`, `${acc.packsLeft} іріктеу`); }
    else { value = t('Тариф не оформлен', 'Тариф рәсімделмеген'); }
  }
  return <Card><div className="stack">
    <div className="row"><AppWindow size={18} color="var(--accent)" /><strong>{t('Помощник ПВЗ', 'ПВЗ көмекшісі')}</strong></div>
    <div><strong>{value}</strong>{hint && <span className="muted"> · {hint}</span>}</div>
    <Link className="accent" to="/cabinet/subscription">{t('Подписка и устройства →', 'Жазылым және құрылғылар →')}</Link>
  </div></Card>;
}

export function OverviewPage(){
  const t=useT();
  useDocumentMeta(t('Обзор — кабинет','Шолу — кабинет'));const query=useCabinet();
  if(query.isPending)return <div className="page"><CabinetLoading/></div>;
  if(query.isError)return <div className="page"><CabinetError error={query.error} retry={()=>query.refetch()}/></div>;
  const {overview,orders}=query.data;const used=Math.max(0,overview.stickersTotal-overview.stickersLeft);
  const cellLicenses=query.data.assets.filter((a):a is CellPrintAsset=>a.type==='cell_print');
  const cellActive=cellLicenses.filter(a=>a.active&&!(a.expiresAt&&new Date(a.expiresAt)<new Date())).length;
  const status=(s:string)=>s==='succeeded'?t('Оплачен','Төленді'):s==='canceled'?t('Отменён','Бас тартылды'):t('Ожидает оплаты','Төлемді күтуде');
  return <div className="page">
    <header className="page-head"><h1>{t('Обзор','Шолу')}</h1><p>{t('Ключи, лимиты, уведомления и последние заказы.','Кілттер, лимиттер, хабарламалар және соңғы тапсырыстар.')}</p></header>
    {overview.needsAttention>0&&<Card accent><div className="row"><TriangleAlert color="var(--accent)"/><strong>{t('Есть ключи, срок которых скоро закончится','Мерзімі жақында бітетін кілттер бар')}</strong><Link className="accent" to="/cabinet/keys">{t('Проверить →','Тексеру →')}</Link></div></Card>}
    <div className="grid grid-3 section">
      <Card><Stat value={overview.activeKeys} label={t('активных ключей','белсенді кілт')} icon={<KeyRound size={20}/>}/><Link className="accent" to="/cabinet/keys">{t('Смотреть ключи →','Кілттерді көру →')}</Link></Card>
      <Card><Stat value={overview.stickersLeft} label={t('генераций осталось','генерация қалды')} icon={<Package size={20}/>}/><Progress value={used} max={Math.max(1,overview.stickersTotal)} label={<><span>{t('Использовано','Пайдаланылды')}</span><strong>{t(`${used} из ${overview.stickersTotal}`,`${overview.stickersTotal} ішінен ${used}`)}</strong></>}/></Card>
      <Card><Stat value={overview.needsAttention} label={t('требуют внимания','назар аударуды қажет етеді')} icon={<TriangleAlert size={20}/>}/><Link className="accent" to="/cabinet/notifications">{t('Открыть уведомления →','Хабарламаларды ашу →')}</Link></Card>
    </div>
    <section className="section"><h2>{t('Программы','Бағдарламалар')}</h2>
      <div className="grid grid-2">
        <HelperSummary t={t}/>
        <Card><div className="stack">
          <div className="row"><Printer size={18} color="var(--accent)"/><strong>{t('Печать ячеек','Ұяшық басып шығару')}</strong></div>
          <div><strong>{cellActive?t(`${cellActive} активных лицензий`,`${cellActive} белсенді лицензия`):t('Нет лицензий','Лицензиялар жоқ')}</strong>{cellLicenses.length>cellActive&&<span className="muted"> · {t(`всего ${cellLicenses.length}`,`барлығы ${cellLicenses.length}`)}</span>}</div>
          <Link className="accent" to="/cabinet/keys">{t('Ключи и устройства →','Кілттер мен құрылғылар →')}</Link>
        </div></Card>
      </div>
    </section>
    <section className="section"><h2>{t('Последние заказы','Соңғы тапсырыстар')}</h2>{orders.length?<Table><thead><tr><th>{t('Дата','Күні')}</th><th>{t('Покупка','Сатып алу')}</th><th>{t('Сумма','Сомасы')}</th><th>{t('Статус','Мәртебесі')}</th></tr></thead><tbody>{orders.map(o=><tr key={o.id}><td>{dateTime(o.createdAt)}</td><td>{o.product}</td><td>{money(Math.round(o.amount*100))}</td><td>{status(o.status)}</td></tr>)}</tbody></Table>:<Card>{t('Покупок пока нет.','Әзірге сатып алулар жоқ.')}</Card>}</section>
  </div>;
}
