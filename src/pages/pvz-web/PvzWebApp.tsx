import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Boxes, CalendarDays, ClipboardCheck, Gem, Grid2X2, Hourglass, LineChart, Lock, LogOut, MessageSquare,
  MoreHorizontal, Package, QrCode, RefreshCw, ScanLine, Search, Tag, Truck,
} from 'lucide-react';
import { Alert, Button, EmptyState } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { type T, useLocalePath, useT } from '../../i18n';
import { useDocumentMeta } from '../../lib/seo';
import { markOpened } from '../../lib/whats-new';
import { useWhatsNewState } from '../../components/WhatsNew';
import { useStores } from '../../stores/root-store';
import { type WbState, isWbLoginRequired, usePvzGoods, usePvzWebStatus, useRefreshGoods, useWbAction } from '../../api/pvz-web';
import { CellPage, CellsScreen, ClientPage, CodeScreen, GoodsScreen, OpsScreen, QrDialog, type Go, type QrTarget } from './screens';
import s from './PvzWebApp.module.css';

type Icon = typeof Grid2X2;
/** Страницы веб-версии — путь после /cabinet/pvz-web: '' (ячейки), goods, stale, expensive, ops, code, more, locked/N, cell/N, client/SID. */
type Section = { path: string; label: string; Icon: Icon };

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** Разделы программы, которым нужна база WB с компьютера пункта: в браузере их нет, показываем с замком. */
const lockedSections = (t: T): { label: string; Icon: Icon }[] => [
  { label: t('В пути', 'Жолда'), Icon: Truck },
  { label: t('Коробки', 'Қораптар'), Icon: Boxes },
  { label: t('Контроль пункта', 'Пунктті бақылау'), Icon: ClipboardCheck },
  { label: t('Инвентаризация', 'Түгендеу'), Icon: ScanLine },
];

/** То, что уже есть в кабинете: не дублируем, а открываем готовую страницу. */
const cabinetLinks = (t: T): { to: string; label: string; Icon: Icon }[] => [
  { to: '/cabinet/generator', label: t('Стикеры', 'Стикерлер'), Icon: Tag },
  { to: '/cabinet/staff', label: t('Сотрудники и график', 'Қызметкерлер мен кесте'), Icon: CalendarDays },
  { to: '/cabinet/pc-messages', label: t('Сообщения на ПК', 'ДК-ға хабарламалар'), Icon: MessageSquare },
];

function Frame({ children }: { children: ReactNode }) {
  const t = useT();
  const lp = useLocalePath();
  return (
    <div className={s.app}>
      <div className={s.main}>
        <header className={s.header}>
          <Link to={lp('/cabinet')} className={s.navItem}><ArrowLeft size={18} aria-hidden="true" />{t('В личный кабинет', 'Жеке кабинетке')}</Link>
        </header>
        <div className={s.content}>{children}</div>
      </div>
    </div>
  );
}

// ---------- вход в WB ----------

function WbLogin({ wb }: { wb: WbState }) {
  const t = useT();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const login = useWbAction<{ phone?: string; resend?: boolean }>('wb-login');
  const confirm = useWbAction<{ code: string }>('wb-code');
  const choose = useWbAction<{ pointId: number }>('wb-point');
  const cancel = useWbAction<Record<string, never>>('wb-logout');
  const step = wb.state === 'await_code' ? 2 : wb.state === 'await_point' ? 3 : 1;
  const error = [login, confirm, choose].find(m => m.isError)?.error;

  const sendPhone = (event: FormEvent) => { event.preventDefault(); confirm.reset(); login.mutate({ phone }); };
  const sendCode = (event: FormEvent) => { event.preventDefault(); login.reset(); confirm.mutate({ code }); };

  return (
    <div className={s.login}>
      <div className={s.step}>{t(`Шаг ${step} из 3`, `${step}-қадам, барлығы 3`)}</div>
      {step === 1 && (
        <form onSubmit={sendPhone} style={{ display: 'contents' }}>
          <h1 className={s.h2}>{t('Вход в WB', 'WB-ге кіру')}</h1>
          <p>{t('Чтобы показать ячейки и клиентов, веб-версия входит в WB под вашим номером — так же, как бот. WB пришлёт код.', 'Ұяшықтар мен клиенттерді көрсету үшін веб-нұсқа WB-ге сіздің нөміріңізбен кіреді — бот сияқты. WB код жібереді.')}</p>
          <label className={s.label} htmlFor="pvz-wb-phone">{t('Телефон, с которым вы входите в WB на пункте', 'Пунктте WB-ге кіретін телефон')}</label>
          <input id="pvz-wb-phone" className={s.bigInput} type="tel" inputMode="tel" autoComplete="tel" placeholder="+7 900 000-00-00" value={phone} onChange={e => setPhone(e.target.value)} />
          <Button type="submit" loading={login.isPending} disabled={phone.replace(/\D/g, '').length < 10}>{t('Получить код', 'Код алу')}</Button>
        </form>
      )}
      {step === 2 && wb.state === 'await_code' && (
        <form onSubmit={sendCode} style={{ display: 'contents' }}>
          <h1 className={s.h2}>{t('Код от WB', 'WB коды')}</h1>
          <p>{t(`WB отправил код на номер …${wb.phoneTail} — в приложение WB Point или по СМС.`, `WB кодты …${wb.phoneTail} нөміріне жіберді — WB Point қосымшасына немесе СМС арқылы.`)}</p>
          <label className={s.label} htmlFor="pvz-wb-code">{t('Код подтверждения', 'Растау коды')}</label>
          <input id="pvz-wb-code" className={`${s.bigInput} ${s.codeInput}`} inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))} />
          <Button type="submit" loading={confirm.isPending} disabled={code.length < 4}>{t('Войти', 'Кіру')}</Button>
          <button type="button" className={s.linkButton} disabled={login.isPending} onClick={() => { confirm.reset(); login.mutate({ resend: true }); }}>{t('Выслать код заново', 'Кодты қайта жіберу')}</button>
          <button type="button" className={s.linkButton} onClick={() => { setCode(''); cancel.mutate({}); }}>{t('Войти другим номером', 'Басқа нөмірмен кіру')}</button>
        </form>
      )}
      {step === 3 && wb.state === 'await_point' && (
        <>
          <h1 className={s.h2}>{t('Выберите пункт', 'Пунктті таңдаңыз')}</h1>
          <p>{t('К этому номеру привязано несколько пунктов. Сменить пункт потом можно в шапке.', 'Бұл нөмірге бірнеше пункт байланған. Пунктті кейін жоғарғы жолақта ауыстыруға болады.')}</p>
          {wb.points.map(p => (
            <button key={p.id} type="button" className={s.pointButton} disabled={choose.isPending} onClick={() => choose.mutate({ pointId: p.id })}>{p.name}</button>
          ))}
        </>
      )}
      {error != null && <Alert tone="error">{errorText(error, t('Не удалось войти в WB', 'WB-ге кіру мүмкін болмады'))}</Alert>}
    </div>
  );
}

// ---------- раздел с замком ----------

function LockedScreen({ title }: { title: string }) {
  const t = useT();
  const lp = useLocalePath();
  return (
    <div className={s.center}>
      <div className={s.lockIcon} aria-hidden="true"><Lock size={26} /></div>
      <h1 className={s.h2}>{t(`«${title}» — только в программе на ПК`, `«${title}» — тек ДК-дағы бағдарламада`)}</h1>
      <p>{t('Этому разделу нужна база WB с компьютера пункта. На сервере мы её не храним, поэтому в браузере раздел не открывается.', 'Бұл бөлімге пункт компьютеріндегі WB базасы керек. Серверде оны сақтамаймыз, сондықтан браузерде бөлім ашылмайды.')}</p>
      <p>{t('В веб-версии работают: ячейки с историей, товары, залежавшиеся и дорогие, операции по дням и код клиента.', 'Веб-нұсқада жұмыс істейді: тарихы бар ұяшықтар, тауарлар, ұзақ жатқандар мен қымбаттар, күндер бойынша операциялар және клиент коды.')}</p>
      <Link to={lp('/program')}><Button>{t('Скачать программу', 'Бағдарламаны жүктеу')}</Button></Link>
    </div>
  );
}

// ---------- приложение ----------

export default function PvzWebApp() {
  const t = useT();
  const lp = useLocalePath();
  const navigate = useNavigate();
  useDocumentMeta(t('Помощник ПВЗ — веб-версия', 'ПВЗ көмекшісі — веб-нұсқа'));
  // Страница живёт вне оболочки кабинета, поэтому метку «new» у своего пункта меню снимает сама.
  const { auth } = useStores();
  const [, updateNews] = useWhatsNewState(auth.user?.id ?? null);
  useEffect(() => { updateNews(state => markOpened(state, '/cabinet/pvz-web')); }, [updateNews]);

  // Каждая страница — свой адрес: кнопка «Назад» в браузере и на телефоне возвращает к списку, а не в кабинет.
  const route = (useParams()['*'] ?? '').replace(/\/+$/, '');
  const [page, rawArg = ''] = route.split('/');
  const arg = decodeURIComponent(rawArg);
  const go = useCallback<Go>(path => { navigate(lp(`/cabinet/pvz-web${path ? `/${path}` : ''}`)); window.scrollTo(0, 0); }, [navigate, lp]);

  const status = usePvzWebStatus();
  const wb = status.data?.wb;
  const ready = Boolean(status.data?.allowed) && wb?.state === 'ready';
  const goods = usePvzGoods(ready);
  const refresh = useRefreshGoods();
  const switchPoint = useWbAction<{ pointId: number }>('wb-point');
  const logout = useWbAction<Record<string, never>>('wb-logout');
  const [qrTarget, setQrTarget] = useState<QrTarget | null>(null);

  // Вход в WB слетел посреди работы — перечитываем статус: он покажет экран входа вместо ошибки.
  const refetchStatus = status.refetch;
  const wbLost = isWbLoginRequired(goods.error) || isWbLoginRequired(refresh.error);
  useEffect(() => { if (wbLost) void refetchStatus(); }, [wbLost, refetchStatus]);

  if (status.isPending) return <Frame><CabinetLoading /></Frame>;
  if (status.isError) return <Frame><CabinetError error={status.error} retry={() => void status.refetch()} /></Frame>;
  if (!status.data.allowed) {
    return (
      <Frame>
        <EmptyState
          icon={<Lock size={26} />}
          title={t('Веб-версия входит в тарифы «Помощника ПВЗ»', 'Веб-нұсқа «ПВЗ көмекшісі» тарифтеріне кіреді')}
          text={t('Подключите любой тариф — и ячейки, товары и код клиента откроются в браузере, в том числе с телефона.', 'Кез келген тарифті қосыңыз — ұяшықтар, тауарлар және клиент коды браузерде, соның ішінде телефоннан ашылады.')}
          action={<Link to={lp('/cabinet/subscription')}><Button>{t('Выбрать тариф', 'Тариф таңдау')}</Button></Link>}
        />
      </Frame>
    );
  }
  if (!wb || wb.state !== 'ready') return <Frame><WbLogin wb={wb ?? { state: 'none' }} /></Frame>;

  const locked = lockedSections(t);
  const lockTitle = page === 'locked' ? locked[Number(arg)]?.label ?? locked[0].label : '';
  const point = wb.points.find(p => p.id === wb.pointId);
  const sections: Section[] = [
    { path: '', label: t('Ячейки', 'Ұяшықтар'), Icon: Grid2X2 },
    { path: 'goods', label: t('Все товары', 'Барлық тауарлар'), Icon: Package },
    { path: 'code', label: t('Код клиента', 'Клиент коды'), Icon: QrCode },
  ];
  const extra: Section[] = [
    { path: 'stale', label: t('Залежавшиеся', 'Ұзақ жатқандар'), Icon: Hourglass },
    { path: 'expensive', label: t('Дорогие', 'Қымбаттар'), Icon: Gem },
    { path: 'ops', label: t('Операции по дням', 'Күндер бойынша операциялар'), Icon: LineChart },
  ];
  // страница ячейки подсвечивает «Ячейки», досье клиента — тоже: туда приходят из ячеек
  const activePath = page === 'cell' || page === 'client' ? '' : page;
  const title = page === 'cell' ? `${t('Ячейка', 'Ұяшық')} ${arg}` : page === 'client' ? t('Досье клиента', 'Клиент досьесі')
    : page === 'locked' ? lockTitle : page === 'more' ? t('Ещё', 'Тағы')
    : [...sections, ...extra].find(x => x.path === page)?.label ?? t('Ячейки', 'Ұяшықтар');
  const updatedAt = goods.data ? new Date(goods.data.loadedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : null;
  const refreshing = refresh.isPending || goods.isFetching;
  const pointSelect = wb.points.length > 1 && (
    <select className={s.pointSelect} aria-label={t('Пункт', 'Пункт')} value={wb.pointId ?? ''} disabled={switchPoint.isPending}
      onChange={e => switchPoint.mutate({ pointId: Number(e.target.value) })}>
      {wb.points.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );

  const data = goods.data;
  let body: ReactNode;
  if (page === 'locked') body = <LockedScreen title={lockTitle} />;
  else if (page === 'more') {
    body = (
      <>
        {pointSelect}
        <div className={s.moreList}>
          {extra.map(item => (
            <button key={item.path} type="button" className={s.moreItem} onClick={() => go(item.path)}><item.Icon size={18} aria-hidden="true" /><span className={s.navLabel}>{item.label}</span></button>
          ))}
        </div>
        <div className={s.navTitle}>{t('Нужен компьютер пункта', 'Пункт компьютері қажет')}</div>
        <div className={s.moreList}>
          {locked.map((item, i) => (
            <button key={item.label} type="button" className={`${s.moreItem} ${s.navMuted}`} onClick={() => go(`locked/${i}`)}>
              <item.Icon size={18} aria-hidden="true" /><span className={s.navLabel}>{item.label}</span><Lock size={14} aria-label={t('только в программе на ПК', 'тек ДК-дағы бағдарламада')} />
            </button>
          ))}
        </div>
        <div className={s.navTitle}>{t('В кабинете', 'Кабинетте')}</div>
        <div className={s.moreList}>
          {cabinetLinks(t).map(item => (
            <Link key={item.to} to={lp(item.to)} className={s.moreItem}><item.Icon size={18} aria-hidden="true" /><span className={s.navLabel}>{item.label}</span></Link>
          ))}
          <Link to={lp('/cabinet')} className={s.moreItem}><ArrowLeft size={18} aria-hidden="true" /><span className={s.navLabel}>{t('В личный кабинет', 'Жеке кабинетке')}</span></Link>
        </div>
        <div className={s.moreList}>
          <button type="button" className={s.moreItem} disabled={logout.isPending} onClick={() => logout.mutate({})}><LogOut size={18} aria-hidden="true" /><span className={s.navLabel}>{t('Выйти из WB', 'WB-ден шығу')}</span></button>
        </div>
      </>
    );
  } else if (page === 'code') body = <CodeScreen go={go} onQr={setQrTarget} onWbLost={() => void status.refetch()} />;
  else if (goods.isPending) body = <CabinetLoading />;
  else if (goods.isError || !data) body = <CabinetError error={goods.error} retry={() => void goods.refetch()} />;
  else if (page === 'cell') body = <CellPage data={data} cell={arg} go={go} onQr={setQrTarget} />;
  else if (page === 'client') body = <ClientPage data={data} sid={arg} go={go} onQr={setQrTarget} />;
  else if (page === 'goods' || page === 'stale' || page === 'expensive') body = <GoodsScreen data={data} mode={page === 'goods' ? 'all' : page} go={go} />;
  else if (page === 'ops') body = <OpsScreen data={data} />;
  else body = <CellsScreen data={data} go={go} />;

  const navButton = (item: Section) => (
    <button key={item.path} type="button" className={`${s.navItem} ${activePath === item.path ? s.navActive : ''}`} aria-current={activePath === item.path ? 'page' : undefined} onClick={() => go(item.path)}>
      <item.Icon size={18} aria-hidden="true" /><span className={s.navLabel}>{item.label}</span>
    </button>
  );

  return (
    <div className={s.app}>
      <nav className={s.sidebar} aria-label={t('Разделы', 'Бөлімдер')}>
        <div className={s.brand}>
          <div className={s.brandMark} aria-hidden="true">П</div>
          <div><div className={s.brandName}>{t('Помощник ПВЗ', 'ПВЗ көмекшісі')}</div><div className={s.brandSub}>{t('веб-версия', 'веб-нұсқа')}</div></div>
        </div>
        <div className={s.navGroup}>
          <div className={s.navTitle}>{t('Пункт', 'Пункт')}</div>
          {sections.map(navButton)}
          {extra.map(navButton)}
        </div>
        <div className={s.navGroup}>
          <div className={s.navTitle}>{t('Нужен компьютер пункта', 'Пункт компьютері қажет')}</div>
          {locked.map((item, i) => (
            <button key={item.label} type="button" className={`${s.navItem} ${page === 'locked' && lockTitle === item.label ? s.navActive : s.navMuted}`} onClick={() => go(`locked/${i}`)}>
              <item.Icon size={18} aria-hidden="true" /><span className={s.navLabel}>{item.label}</span><Lock size={14} aria-label={t('только в программе на ПК', 'тек ДК-дағы бағдарламада')} />
            </button>
          ))}
        </div>
        <div className={s.navGroup}>
          <div className={s.navTitle}>{t('Команда и печать', 'Команда және басып шығару')}</div>
          {cabinetLinks(t).map(item => (
            <Link key={item.to} to={lp(item.to)} className={s.navItem}><item.Icon size={18} aria-hidden="true" /><span className={s.navLabel}>{item.label}</span><span className={s.navHint}>{t('кабинет', 'кабинет')}</span></Link>
          ))}
        </div>
        <div className={s.sidebarFoot}>
          <button type="button" className={`${s.navItem} ${s.navMuted}`} disabled={logout.isPending} onClick={() => logout.mutate({})}><LogOut size={18} aria-hidden="true" />{t('Выйти из WB', 'WB-ден шығу')}</button>
          <Link to={lp('/cabinet')} className={`${s.navItem} ${s.navMuted}`}><ArrowLeft size={18} aria-hidden="true" />{t('В личный кабинет', 'Жеке кабинетке')}</Link>
        </div>
      </nav>

      <div className={s.main}>
        <header className={s.header}>
          <div className={s.mobileHead}>
            <div className={s.mobileTitle}>{title}</div>
            <div className={s.mobilePoint}>{point?.name}</div>
          </div>
          <div className={s.desktopPoint}>{pointSelect || <span className={s.pointName}>{point?.name}</span>}</div>
          <button type="button" className={s.headerSearch} onClick={() => go('code')}>
            <Search size={16} aria-hidden="true" />{t('Поиск клиента: ячейка, телефон, ШК', 'Клиентті іздеу: ұяшық, телефон, ШК')}
          </button>
          {updatedAt && <span className={s.updated}>{t(`Данные WB на ${updatedAt}`, `WB деректері: ${updatedAt}`)}</span>}
          <Button variant="secondary" size="sm" loading={refreshing} onClick={() => refresh.mutate()} aria-label={t('Обновить данные WB', 'WB деректерін жаңарту')}>
            {!refreshing && <RefreshCw size={16} aria-hidden="true" />}<span className={s.refreshLabel}>{t('Обновить', 'Жаңарту')}</span>
          </Button>
        </header>
        <div className={s.content}>
          {switchPoint.isError && <Alert tone="error">{errorText(switchPoint.error, t('Не удалось сменить пункт', 'Пунктті ауыстыру мүмкін болмады'))}</Alert>}
          {refresh.isError && !wbLost && <Alert tone="error">{errorText(refresh.error, t('Не удалось обновить данные WB', 'WB деректерін жаңарту мүмкін болмады'))}</Alert>}
          {body}
        </div>
      </div>

      <nav className={s.tabbar} aria-label={t('Разделы', 'Бөлімдер')}>
        {sections.map(item => (
          <button key={item.path} type="button" className={`${s.tab} ${activePath === item.path ? s.tabActive : ''}`} aria-current={activePath === item.path ? 'page' : undefined} onClick={() => go(item.path)}>
            <item.Icon size={22} aria-hidden="true" />{item.label}
          </button>
        ))}
        <button type="button" className={`${s.tab} ${!sections.some(x => x.path === activePath) ? s.tabActive : ''}`} onClick={() => go('more')}>
          <MoreHorizontal size={22} aria-hidden="true" />{t('Ещё', 'Тағы')}
        </button>
      </nav>

      <QrDialog target={qrTarget} onClose={() => setQrTarget(null)} />
    </div>
  );
}
