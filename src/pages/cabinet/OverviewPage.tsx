import { Link } from 'react-router-dom';
import { AppWindow, KeyRound, Package, PackagePlus, Printer, RefreshCw, TriangleAlert, UserPlus, WalletCards } from 'lucide-react';
import { Card, Progress, Stat, Table } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, money, useCabinet, type CellPrintAsset } from '../../api/cabinet';
import { daysLeft, useAppAccount } from '../../api/app';
import { useDocumentMeta } from '../../lib/seo';
import { type T, useT } from '../../i18n';
import c from './cabinet.module.css';

const walletMoney = (kopecks: number) => `${(kopecks / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

function walletOperation(kind: string, t: T) {
  return ({
    topup: t('Пополнение баланса', 'Балансты толықтыру'),
    bonus: t('Бонус к балансу', 'Баланс бонусы'),
    spend: t('Оплата с баланса', 'Баланстан төлеу'),
    refund: t('Возврат на баланс', 'Балансқа қайтару'),
    admin: t('Корректировка баланса', 'Балансты түзету'),
  } as Record<string, string>)[kind] ?? kind;
}

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
      value = t(`Тариф ${acc.subscription.title}`, `Тариф ${acc.subscription.title}`);
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
  const appAccount=useAppAccount();
  if(query.isPending)return <div className="page"><CabinetLoading/></div>;
  if(query.isError)return <div className="page"><CabinetError error={query.error} retry={()=>query.refetch()}/></div>;
  const {overview,orders}=query.data;const used=Math.max(0,overview.stickersTotal-overview.stickersLeft);
  const cellLicenses=query.data.assets.filter((a):a is CellPrintAsset=>a.type==='cell_print');
  const cellActive=cellLicenses.filter(a=>a.active&&!(a.expiresAt&&new Date(a.expiresAt)<new Date())).length;
  const status=(s:string)=>s==='succeeded'?t('Оплачен','Төленді'):s==='canceled'?t('Отменён','Бас тартылды'):t('Ожидает оплаты','Төлемді күтуде');
  const wallet=query.data.wallet;
  const account=appAccount.data;
  const subscription=account?.subscription;
  const quota=account?.quota?.codes;
  const recentWallet=wallet?.ledger.slice(0,3)??[];
  return <div className={`page ${c.mobilePage}`}>
    <div className={c.overviewMobile}>
      <section className={c.overviewBalance}>
        <span>{t('Баланс','Баланс')}</span>
        <strong>{walletMoney(wallet?.balanceKopecks??0)}</strong>
        <div className={c.overviewBalanceActions}>
          <Link to="/cabinet/packages">{t('Пополнить','Толықтыру')}</Link>
          <Link to="/cabinet/packages">{t('История','Тарих')}</Link>
        </div>
      </section>

      <div className={c.overviewStats}>
        <Link to="/cabinet/subscription" className={c.overviewStat}>
          <span>{t('Подписка','Жазылым')}</span>
          <strong>{subscription?.title??t('Нет тарифа','Тариф жоқ')}</strong>
          <small>{subscription?t(`до ${new Date(subscription.paidUntil||subscription.endsAt).toLocaleDateString('ru-RU')}`,''):t('Выбрать тариф','Тарифті таңдау')}</small>
        </Link>
        <Link to="/cabinet/subscription" className={c.overviewStat}>
          <span>{t('Подборы','Іріктеулер')}</span>
          <strong>{quota?`${quota.used} / ${quota.limit}`:account?.packsLeft??0}</strong>
          <i><b style={{width:quota?`${Math.min(100,(quota.used/Math.max(1,quota.limit))*100)}%`:'0%'}} /></i>
        </Link>
      </div>

      <section className={c.mobileSection}>
        <h2>{t('Быстрые действия','Жылдам әрекеттер')}</h2>
        <div className={c.quickActions}>
          <Link to="/cabinet/generator"><WalletCards size={18}/><span>{t('Сгенерировать','Жасау')}</span></Link>
          <Link to="/cabinet/subscription"><RefreshCw size={18}/><span>{t('Продлить тариф','Тарифті ұзарту')}</span></Link>
          <Link to="/cabinet/keys"><PackagePlus size={18}/><span>{t('Пакеты подборов','Іріктеу пакеттері')}</span></Link>
          <Link to="/cabinet/referrals"><UserPlus size={18}/><span>{t('Пригласить','Шақыру')}</span></Link>
        </div>
      </section>

      <section className={c.mobileSection}>
        <h2>{t('Последние операции','Соңғы операциялар')}</h2>
        <div className={c.overviewOperations}>
          {recentWallet.length?recentWallet.map((entry,index)=><div className={c.overviewOperation} key={`${entry.createdAt}-${index}`}>
            <div><strong>{entry.note&&entry.note!=='legacy_stickers_conversion'?entry.note:walletOperation(entry.kind,t)}</strong><small>{new Date(entry.createdAt).toLocaleDateString('ru-RU',{day:'numeric',month:'short'})}</small></div>
            <b className={entry.amountKopecks>0?c.plus:c.minus}>{entry.amountKopecks>0?'+':''}{walletMoney(entry.amountKopecks)}</b>
          </div>):<div className={c.overviewEmpty}>{t('Операций пока нет','Әзірге операциялар жоқ')}</div>}
        </div>
      </section>
    </div>

    <div className={c.overviewDesktop}>
    <header className="page-head"><h1>{t('Обзор','Шолу')}</h1><p>{t('Ключи, лимиты, уведомления и последние заказы.','Кілттер, лимиттер, хабарламалар және соңғы тапсырыстар.')}</p></header>
    {overview.needsAttention>0&&<Card accent><div className="row"><TriangleAlert color="var(--accent)"/><strong>{t('Есть ключи, срок которых скоро закончится','Мерзімі жақында бітетін кілттер бар')}</strong><Link className="accent" to="/cabinet/keys">{t('Проверить →','Тексеру →')}</Link></div></Card>}
    {/* Плитки и быстрые действия — по прототипу: баланс в рублях первым, дальше подписка, подборы, генерации. */}
    <div className={`grid grid-4 section ${c.dkTiles}`}>
      <Link to="/cabinet/packages" className={c.dkBalance}>
        <span>{t('Баланс','Баланс')}</span>
        <strong>{walletMoney(wallet?.balanceKopecks??0)}</strong>
        <small>{t('для генераций и покупок с баланса','генерациялар мен баланстан сатып алуларға')}</small>
      </Link>
      <Card><Stat value={subscription?.title??t('Нет тарифа','Тариф жоқ')} label={subscription?t(`подписка до ${new Date(subscription.paidUntil||subscription.endsAt).toLocaleDateString('ru-RU')}`,'жазылым'):t('подписка «Помощник ПВЗ»','«ПВЗ көмекшісі» жазылымы')} icon={<AppWindow size={20}/>}/><Link className="accent" to="/cabinet/subscription">{subscription?t('Продлить →','Ұзарту →'):t('Выбрать тариф →','Тарифті таңдау →')}</Link></Card>
      <Card><Stat value={quota?`${quota.used} / ${quota.limit}`:String(account?.packsLeft??0)} label={t('подборов кода в этом месяце','осы айдағы код іріктеулері')} icon={<KeyRound size={20}/>}/>{quota&&<Progress value={quota.used} max={Math.max(1,quota.limit)}/>}</Card>
      <Card><Stat value={overview.stickersLeft} label={t('генераций осталось','генерация қалды')} icon={<Package size={20}/>}/><Progress value={used} max={Math.max(1,overview.stickersTotal)} label={<><span>{t('Использовано','Пайдаланылды')}</span><strong>{t(`${used} из ${overview.stickersTotal}`,`${overview.stickersTotal} ішінен ${used}`)}</strong></>}/></Card>
    </div>
    <div className={c.dkActions}>
      <Link to="/cabinet/generator"><WalletCards size={18}/><span>{t('Сгенерировать код','Код жасау')}</span></Link>
      <Link to="/cabinet/subscription"><RefreshCw size={18}/><span>{t('Продлить подписку','Жазылымды ұзарту')}</span></Link>
      <Link to="/cabinet/packages"><PackagePlus size={18}/><span>{t('Пополнить баланс','Балансты толықтыру')}</span></Link>
      <Link to="/cabinet/referrals"><UserPlus size={18}/><span>{t('Пригласить','Шақыру')}</span></Link>
    </div>
    <div className="grid grid-2 section">
      <section><h2>{t('Программы','Бағдарламалар')}</h2>
        <div className={c.dkStack}>
          <HelperSummary t={t}/>
          <Card><div className="stack">
            <div className="row"><Printer size={18} color="var(--accent)"/><strong>{t('Печать ячеек','Ұяшық басып шығару')}</strong></div>
            <div><strong>{cellActive?t(`${cellActive} активных лицензий`,`${cellActive} белсенді лицензия`):t('Нет лицензий','Лицензиялар жоқ')}</strong>{cellLicenses.length>cellActive&&<span className="muted"> · {t(`всего ${cellLicenses.length}`,`барлығы ${cellLicenses.length}`)}</span>}</div>
            <Link className="accent" to="/cabinet/keys">{t('Ключи и устройства →','Кілттер мен құрылғылар →')}</Link>
          </div></Card>
        </div>
      </section>
      <section><h2>{t('Последние операции','Соңғы операциялар')}</h2>
        <Card>{recentWallet.length?recentWallet.map((entry,index)=><div className={c.dkOperation} key={`${entry.createdAt}-${index}`}>
          <div><strong>{entry.note&&entry.note!=='legacy_stickers_conversion'?entry.note:walletOperation(entry.kind,t)}</strong><small>{dateTime(entry.createdAt)}</small></div>
          <b className={entry.amountKopecks>0?c.plus:c.minus}>{entry.amountKopecks>0?'+':''}{walletMoney(entry.amountKopecks)}</b>
        </div>):<span className="muted">{t('Операций пока нет','Әзірге операциялар жоқ')}</span>}
          <Link className="accent" to="/cabinet/packages">{t('Баланс и история →','Баланс және тарих →')}</Link>
        </Card>
      </section>
    </div>
    <section className="section"><h2>{t('Последние заказы','Соңғы тапсырыстар')}</h2>{orders.length?<Table><thead><tr><th>{t('Дата','Күні')}</th><th>{t('Покупка','Сатып алу')}</th><th>{t('Сумма','Сомасы')}</th><th>{t('Статус','Мәртебесі')}</th></tr></thead><tbody>{orders.map(o=><tr key={o.id}><td>{dateTime(o.createdAt)}</td><td>{o.product}</td><td>{money(Math.round(o.amount*100))}</td><td>{status(o.status)}</td></tr>)}</tbody></Table>:<Card>{t('Покупок пока нет.','Әзірге сатып алулар жоқ.')}</Card>}</section>
    </div>
  </div>;
}
