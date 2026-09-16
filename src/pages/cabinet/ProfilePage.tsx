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

export const ProfilePage=observer(()=>{
  useDocumentMeta('Профиль — кабинет');const query=useCabinet();const {auth}=useStores();const toast=useToast();const update=useCabinetMutation<{displayName:string;phone:string;payerStatus:'individual'|'self_employed'|'entrepreneur'}>('/api/cabinet/profile','PATCH');
  const [name,setName]=useState(''),[phone,setPhone]=useState(''),[payer,setPayer]=useState<'individual'|'self_employed'|'entrepreneur'>('individual'),[email,setEmail]=useState(''),[password,setPassword]=useState('');
  const unlink=useCabinetMutation<void>('/api/cabinet/telegram','DELETE');
  useEffect(()=>{if(query.data){setName(query.data.profile.displayName);setPhone(query.data.profile.phone);setPayer(query.data.profile.payerStatus);setEmail(query.data.profile.email||'')}},[query.data]);
  if(query.isPending)return <div className="page"><CabinetLoading/></div>;if(query.isError)return <div className="page"><CabinetError error={query.error} retry={()=>query.refetch()}/></div>;
  const p=query.data.profile;const save=()=>update.mutate({displayName:name,phone,payerStatus:payer},{onSuccess:()=>toast('Профиль сохранён','success')});
  const saveEmail=async()=>{try{if(p.telegramOnly){await auth.addEmailPassword(email,password)}else if(email!==p.email){const {error}=await getSupabase().auth.updateUser({email});if(error)throw error}toast('Проверьте новую почту для подтверждения','success')}catch(e){toast(e instanceof Error?e.message:'Не удалось изменить почту','error')}};
  return <div className="page"><header className="page-head"><h1>Профиль</h1><p>Личные данные и способы входа.</p></header>
    <Card><div className="row"><Avatar name={name||auth.displayName||'Пользователь'} size={64}/><div><h2>{name||'Пользователь'}</h2><span className="muted">{p.email||p.telegram?.username||'Telegram'}</span></div><Badge tone="success">Аккаунт подтверждён</Badge></div></Card>
    <div className="grid grid-2 section"><Card><h2>Личные данные</h2><div className="stack"><Field label="Имя"><Input value={name} onChange={e=>setName(e.target.value)} autoComplete="name"/></Field><Field label="Телефон"><Input value={phone} onChange={e=>setPhone(e.target.value)} autoComplete="tel"/></Field><Field label="Статус плательщика"><Select value={payer} onChange={e=>setPayer(e.target.value as typeof payer)}><option value="individual">Физическое лицо</option><option value="self_employed">Самозанятый</option><option value="entrepreneur">Индивидуальный предприниматель</option></Select></Field><Button onClick={save} loading={update.isPending}>Сохранить</Button></div></Card>
    <Card><h2>Способы входа</h2><div className="stack"><Field label="Электронная почта"><Input type="email" value={email} onChange={e=>setEmail(e.target.value)}/></Field>{p.telegramOnly&&<Field label="Новый пароль" help="Минимум 8 символов"><Input type="password" minLength={8} value={password} onChange={e=>setPassword(e.target.value)}/></Field>}<Button variant="secondary" disabled={!email||p.telegramOnly&&password.length<8} onClick={saveEmail}>{p.telegramOnly?'Добавить почту и пароль':'Изменить почту'}</Button><hr className="divider"/><div className="row"><Send size={16}/><span>{p.telegram?`@${p.telegram.username||p.telegram.first_name}`:'Telegram не привязан'}</span></div>{p.telegram?<Button variant="ghost" disabled={p.telegramOnly} onClick={()=>unlink.mutate(undefined,{onSuccess:()=>toast('Telegram отвязан','success')})}>Отвязать Telegram</Button>:<TelegramLogin mode="link" onSuccess={()=>query.refetch()} onError={m=>toast(m,'error')}/>} {p.telegramOnly&&p.telegram&&<Alert tone="info">Сначала добавьте почту и пароль — нельзя удалить последний способ входа.</Alert>}</div></Card></div>
  </div>;
});
