import { observer } from 'mobx-react-lite';
import { useEffect,useState } from 'react';
import { Send } from 'lucide-react';
import { Alert,Avatar,Badge,Button,Card,Field,Input,Select,useToast } from '../../ui';
import { CabinetError,CabinetLoading } from '../../components/CabinetState';
import { useCabinet,useCabinetMutation } from '../../api/cabinet';
import { useStores } from '../../stores/root-store';
import { getSupabase } from '../../auth/supabase';
import { TelegramLogin } from '../../auth/TelegramLogin';
import { useDocumentMeta } from '../../lib/seo';
import { useT } from '../../i18n';

export const ProfilePage=observer(()=>{
  const t=useT();
  useDocumentMeta(t('Профиль — кабинет','Профиль — кабинет'));const query=useCabinet();const {auth}=useStores();const toast=useToast();const update=useCabinetMutation<{displayName:string;phone:string;payerStatus:'individual'|'self_employed'|'entrepreneur'}>('/api/cabinet/profile','PATCH');
  const [name,setName]=useState(''),[phone,setPhone]=useState(''),[payer,setPayer]=useState<'individual'|'self_employed'|'entrepreneur'>('individual'),[email,setEmail]=useState(''),[password,setPassword]=useState('');
  const unlink=useCabinetMutation<void>('/api/cabinet/telegram','DELETE');
  useEffect(()=>{if(query.data){setName(query.data.profile.displayName);setPhone(query.data.profile.phone);setPayer(query.data.profile.payerStatus);setEmail(query.data.profile.email||'')}},[query.data]);
  if(query.isPending)return <div className="page"><CabinetLoading/></div>;if(query.isError)return <div className="page"><CabinetError error={query.error} retry={()=>query.refetch()}/></div>;
  const userWord=t('Пользователь','Пайдаланушы');
  const p=query.data.profile;const save=()=>update.mutate({displayName:name,phone,payerStatus:payer},{onSuccess:()=>toast(t('Профиль сохранён','Профиль сақталды'),'success')});
  const saveEmail=async()=>{try{if(p.telegramOnly){await auth.addEmailPassword(email,password)}else if(email!==p.email){const {error}=await getSupabase().auth.updateUser({email});if(error)throw error}toast(t('Проверьте новую почту для подтверждения','Растау үшін жаңа поштаңызды тексеріңіз'),'success')}catch(e){toast(e instanceof Error?e.message:t('Не удалось изменить почту','Поштаны өзгерту мүмкін болмады'),'error')}};
  return <div className="page"><header className="page-head"><h1>{t('Профиль','Профиль')}</h1><p>{t('Личные данные и способы входа.','Жеке деректер және кіру тәсілдері.')}</p></header>
    <Card><div className="row"><Avatar name={name||auth.displayName||userWord} size={64}/><div><h2>{name||userWord}</h2><span className="muted">{p.email||p.telegram?.username||'Telegram'}</span></div><Badge tone="success">{t('Аккаунт подтверждён','Аккаунт расталған')}</Badge></div></Card>
    <div className="grid grid-2 section"><Card><h2>{t('Личные данные','Жеке деректер')}</h2><div className="stack"><Field label={t('Имя','Аты')}><Input value={name} onChange={e=>setName(e.target.value)} autoComplete="name"/></Field><Field label={t('Телефон','Телефон')}><Input value={phone} onChange={e=>setPhone(e.target.value)} autoComplete="tel"/></Field><Field label={t('Статус плательщика','Төлеуші мәртебесі')}><Select value={payer} onChange={e=>setPayer(e.target.value as typeof payer)}><option value="individual">{t('Физическое лицо','Жеке тұлға')}</option><option value="self_employed">{t('Самозанятый','Өзін-өзі жұмыспен қамтыған')}</option><option value="entrepreneur">{t('Индивидуальный предприниматель','Жеке кәсіпкер')}</option></Select></Field><Button onClick={save} loading={update.isPending}>{t('Сохранить','Сақтау')}</Button></div></Card>
    <Card><h2>{t('Способы входа','Кіру тәсілдері')}</h2><div className="stack"><Field label={t('Электронная почта','Электрондық пошта')}><Input type="email" value={email} onChange={e=>setEmail(e.target.value)}/></Field>{p.telegramOnly&&<Field label={t('Новый пароль','Жаңа құпиясөз')} help={t('Минимум 8 символов','Кемінде 8 таңба')}><Input type="password" minLength={8} value={password} onChange={e=>setPassword(e.target.value)}/></Field>}<Button variant="secondary" disabled={!email||p.telegramOnly&&password.length<8} onClick={saveEmail}>{p.telegramOnly?t('Добавить почту и пароль','Пошта мен құпиясөз қосу'):t('Изменить почту','Поштаны өзгерту')}</Button><hr className="divider"/><div className="row"><Send size={16}/><span>{p.telegram?`@${p.telegram.username||p.telegram.first_name}`:t('Telegram не привязан','Telegram байланбаған')}</span></div>{p.telegram?<Button variant="ghost" disabled={p.telegramOnly} onClick={()=>unlink.mutate(undefined,{onSuccess:()=>toast(t('Telegram отвязан','Telegram ажыратылды'),'success')})}>{t('Отвязать Telegram','Telegram-ды ажырату')}</Button>:<TelegramLogin mode="link" onSuccess={()=>query.refetch()} onError={m=>toast(m,'error')}/>} {p.telegramOnly&&p.telegram&&<Alert tone="info">{t('Сначала добавьте почту и пароль — нельзя удалить последний способ входа.','Алдымен пошта мен құпиясөз қосыңыз — соңғы кіру тәсілін жоюға болмайды.')}</Alert>}</div></Card></div>
  </div>;
});
