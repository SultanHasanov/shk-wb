import type { ReactElement } from 'react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render,screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import { ToastProvider } from '../../ui';
import { HistoryPage,KeysPage,NotificationsPage,OrdersPage,OverviewPage,PackagesPage,ProfilePage,ReferralsPage,SettingsPage } from '.';

const prefs={thermalPrintSettings:{},notifyOrderStatus:true,notifyKeyExpiry:true,notifyLowBalance:false,notifyProductNews:true,historyImportedAt:null,historyImportedCount:0,historyImportNoticeDismissedAt:null};
const orders=[{id:'11111111-1111-4111-8111-111111111111',publicToken:'token',createdAt:'2026-08-28T10:00:00Z',paidAt:'2026-08-28T10:01:00Z',status:'succeeded',productKind:'stickers',product:'Пакет генераций · 20 шт.',amount:12,grossAmount:12,referralCreditKopecks:0,currency:'RUB',accessCode:'481902',licenseKey:null,renewal:false,receiptUrl:null},{id:'22222222-2222-4222-8222-222222222222',publicToken:'token2',createdAt:'2026-08-27T10:00:00Z',paidAt:null,status:'canceled',productKind:'program',product:'Программа',amount:150,grossAmount:150,referralCreditKopecks:0,currency:'RUB',accessCode:null,licenseKey:null,renewal:false,receiptUrl:null}];
const history=[{id:'1',clientEntryId:'one',mode:'range',createdAt:'2026-08-29T10:00:00Z',category:'product',quantity:10,codes:['100','109']},{id:'2',clientEntryId:'two',mode:'custom',createdAt:'2026-08-29T11:00:00Z',category:'box',quantity:1,code:'42'}];
const bootstrap={profile:{userId:'u',email:'user@example.com',telegramOnly:false,displayName:'Иван',phone:'',payerStatus:'individual',registeredAt:'2026-08-01T00:00:00Z',lastSignInAt:null,telegram:null,preferences:prefs},assets:[],orders:orders.slice(0,1),notifications:[],unreadNotifications:0,referral:{code:'ABCDEF12',link:'https://shk-wb.vercel.app/r/ABCDEF12',availableKopecks:50000,reservedKopecks:0,earnedKopecks:50000,paidKopecks:0,invited:1,events:[],withdrawals:[]},overview:{activeKeys:0,stickersLeft:0,stickersTotal:0,needsAttention:0}};

function response(data:unknown,status=200){return Promise.resolve(new Response(status===204?null:JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}))}
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{const url=String(input);if(url.includes('/api/cabinet/orders'))return response({items:orders,nextCursor:null});if(url.includes('/api/cabinet/history')){const items=url.includes('kind=box')?history.filter(x=>x.category==='box'):url.includes('kind=product')?history.filter(x=>x.category==='product'):history;return response({items,nextCursor:null})}if(url.includes('/api/cabinet/notifications'))return response({items:[],nextCursor:null});return response(bootstrap)}))});

function renderPage(ui:ReactElement){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});return render(<QueryClientProvider client={client}><MemoryRouter><ToastProvider>{ui}</ToastProvider></MemoryRouter></QueryClientProvider>)}

describe('страницы кабинета с серверными данными',()=>{
  const pages:Array<[string,ReactElement]>=[['Обзор',<OverviewPage/>],['Ключи и доступы',<KeysPage/>],['Пакеты и код доступа',<PackagesPage/>],['История генераций',<HistoryPage/>],['Заказы',<OrdersPage/>],['Рефералы',<ReferralsPage/>],['Профиль',<ProfilePage/>],['Настройки',<SettingsPage/>],['Уведомления',<NotificationsPage/>]];
  it.each(pages)('%s загружается через API',async(title,ui)=>{renderPage(ui);expect(await screen.findByRole('heading',{level:1,name:title})).toBeInTheDocument()});
  it('фильтрует серверную историю по типу',async()=>{const user=userEvent.setup();renderPage(<HistoryPage/>);expect(await screen.findByText('10')).toBeInTheDocument();await user.click(screen.getByRole('tab',{name:'QR коробок'}));expect(await screen.findByText('42')).toBeInTheDocument();expect(screen.queryByText('10')).not.toBeInTheDocument()});
  it('фильтрует заказы по статусу',async()=>{const user=userEvent.setup();renderPage(<OrdersPage/>);expect(await screen.findByText('11111111')).toBeInTheDocument();await user.click(screen.getByRole('radio',{name:'Отменены'}));expect(screen.queryByText('11111111')).not.toBeInTheDocument();expect(screen.getByText('22222222')).toBeInTheDocument()});
});
