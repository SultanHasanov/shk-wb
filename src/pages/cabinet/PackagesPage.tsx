import { useState } from 'react';
import { Copy,Package,RefreshCw } from 'lucide-react';
import { PackPurchase } from '../../components/PricingPacks';
import { LicenseCheckoutModal } from './LicenseCheckoutModal';
import { Badge,Button,Card,EmptyState,Field,Input,Progress,Stat,useToast } from '../../ui';
import { CabinetError,CabinetLoading } from '../../components/CabinetState';
import { useCabinet,useCabinetMutation } from '../../api/cabinet';
import { useDocumentMeta } from '../../lib/seo';
import { useT } from '../../i18n';

/* Счётчик на коде один на все виды генерации. Раньше здесь была разбивка по
   четырём лимитам — она существовала только потому, что пакет нельзя было
   потратить не на свой тип стикера. */
export function PackagesPage(){
  const t=useT();
  useDocumentMeta(t('Пакеты и код доступа — кабинет','Пакеттер мен қолжетімділік коды — кабинет'));const query=useCabinet();const toast=useToast();const [claim,setClaim]=useState('');const [topUp,setTopUp]=useState<string|null>(null);const mutation=useCabinetMutation<{kind:'sticker';value:string}>('/api/cabinet/assets/claim');
  if(query.isPending)return <div className="page"><CabinetLoading/></div>;if(query.isError)return <div className="page"><CabinetError error={query.error} retry={()=>query.refetch()}/></div>;
  const codes=query.data.assets.filter(a=>a.type==='sticker');
  return <div className="page"><header className="page-head"><h1>{t('Пакеты и код доступа','Пакеттер мен қолжетімділік коды')}</h1><p>{t('Все принадлежащие вам пакеты генераций. Генерация — это один стикер товара или один QR коробки.','Сізге тиесілі барлық генерация пакеттері. Бір генерация — бұл бір тауар стикері немесе бір қорап QR-коды.')}</p></header>
    <Card><div className="row"><Field label={t('Добавить старый шестизначный код','Ескі алты таңбалы кодты қосу')}><Input inputMode="numeric" maxLength={6} value={claim} onChange={e=>setClaim(e.target.value.replace(/\D/g,''))}/></Field><Button variant="secondary" disabled={claim.length!==6} onClick={()=>mutation.mutate({kind:'sticker',value:claim},{onSuccess:()=>{setClaim('');toast(t('Пакет добавлен','Пакет қосылды'),'success')}})}>{t('Добавить','Қосу')}</Button></div></Card>
    <div className="stack-lg section">{codes.length?codes.map(c=>{const {used,total}=c.limits;return <Card key={c.key} accent>
      <div className="row"><div><div className="muted">{t('Код доступа','Қолжетімділік коды')}</div><strong className="mono">{c.key}</strong></div><Button variant="ghost" onClick={()=>{navigator.clipboard?.writeText(c.key);toast(t('Код скопирован','Код көшірілді'),'success')}}><Copy size={16}/>{t('Копировать','Көшіру')}</Button>{c.active&&<Button variant="secondary" onClick={()=>setTopUp(c.key)}><RefreshCw size={16}/>{t('Пополнить','Толықтыру')}</Button>}<Badge tone={c.active?'success':'error'}>{c.active?t('Активен','Белсенді'):t('Отключён','Өшірілген')}</Badge></div>
      <div className="grid grid-2 section"><Stat value={Math.max(0,total-used)} label={t('генераций осталось','генерация қалды')} icon={<Package size={20}/>}/><Progress value={used} max={Math.max(1,total)} label={<><span>{t('Использовано','Пайдаланылды')}</span><strong>{t(`${used} из ${total}`,`${total} ішінен ${used}`)}</strong></>}/></div>
    </Card>}):<Card><EmptyState icon={<Package/>} title={t('Пакетов пока нет','Әзірге пакеттер жоқ')} text={t('Купите пакет или добавьте ранее приобретённый код.','Пакет сатып алыңыз немесе бұрын алынған кодты қосыңыз.')}/></Card>}</div>
    <section className="section"><h2>{t('Купить новый пакет','Жаңа пакет сатып алу')}</h2><PackPurchase/></section>
    {/* key сбрасывает состояние модалки между разными кодами. */}
    {topUp&&<LicenseCheckoutModal key={topUp} checkout={{kind:'stickers',targetKey:topUp}} availableKopecks={query.data.referral.availableKopecks} onClose={()=>setTopUp(null)}/>}
  </div>;
}
