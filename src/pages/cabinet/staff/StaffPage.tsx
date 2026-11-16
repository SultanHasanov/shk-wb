import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, CloudOff, Lock, MapPin, Users } from 'lucide-react';
import { Button, Card, EmptyState, Modal, useToast } from '../../../ui';
import { CabinetError, CabinetLoading } from '../../../components/CabinetState';
import { useStaffPoints, type StaffPoint } from '../../../api/staff';
import { useDocumentMeta } from '../../../lib/seo';
import { monthKey, todayYmd } from '../../../lib/staff-core';
import { useStaffDocs } from './useStaffDocs';
import { ScheduleTab, type GoTo } from './ScheduleTab';
import { PayrollTab, GoodsDialog } from './PayrollTab';
import { PeopleTab } from './PeopleTab';
import { SettingsTab } from './SettingsTab';
import { AllPoints } from './AllPoints';
import { ReplaceDialog } from './ReplaceDialog';
import { TemplateWizard } from './TemplateWizard';
import { ExportDialog } from './ExportDialog';
import s from './staff.module.css';

type Tab = 'schedule' | 'payroll' | 'people' | 'settings';
const TABS: { id: Tab; label: string }[] = [
  { id: 'schedule', label: 'График' },
  { id: 'payroll', label: 'Зарплата' },
  { id: 'people', label: 'Люди' },
  { id: 'settings', label: 'Настройки' },
];
const LAST_POINT = 'staff-last-point';

function readLast(): string | null {
  try { return localStorage.getItem(LAST_POINT); } catch { return null; }
}
function writeLast(v: string) {
  try { localStorage.setItem(LAST_POINT, v); } catch { /* приватное окно */ }
}

/** /cabinet/staff — «Сотрудники»: те же графики и зарплата, что в «Помощнике ПВЗ», по пунктам аккаунта. */
export function StaffPage() {
  useDocumentMeta('Сотрудники — кабинет');
  const points = useStaffPoints();
  const [params, setParams] = useSearchParams();
  const list = points.data?.points ?? [];
  const wanted = params.get('point') || readLast();
  const point = wanted === 'all' && list.length > 1 ? 'all' : list.find(p => p.id === wanted)?.id ?? list[0]?.id ?? null;
  const tab = (TABS.some(t => t.id === params.get('tab')) ? params.get('tab') : 'schedule') as Tab;
  const set = (patch: Record<string, string | null>) => setParams(p => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) if (v === null) n.delete(k); else n.set(k, v);
    return n;
  }, { replace: true });

  useEffect(() => { if (point) writeLast(point); }, [point]);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Сотрудники</h1>
        <p>График смен, замены и зарплата по каждому пункту. Всё хранится на сервере и в программе «Помощник ПВЗ» на компьютерах пунктов — правки видны везде.</p>
      </header>
      {points.isPending ? <CabinetLoading /> : points.isError ? <CabinetError error={points.error} retry={() => points.refetch()} /> : !points.data.allowed ? (
        <Card className={s.lock}>
          <EmptyState icon={<Lock size={26} />} title="«Сотрудники» входят в тарифы «Стандарт» и «Про»" text="График смен, замены, зарплата с авансами и удержаниями WB, выгрузка в Excel и ссылка для сотрудников — на сайте и в программе на всех компьютерах."
            action={<Link to="/cabinet/subscription"><Button>Посмотреть тарифы</Button></Link>} />
        </Card>
      ) : !list.length ? (
        <Card>
          <EmptyState icon={<MapPin size={26} />} title="Пока нет ни одного пункта" text="Пункт появляется, когда вы входите в аккаунт в программе «Помощник ПВЗ» на компьютере пункта. После этого его график и сотрудники будут здесь."
            action={<Link to="/cabinet/subscription"><Button variant="secondary">Скачать программу</Button></Link>} />
        </Card>
      ) : (
        <>
          <div className={s.top}>
            <div className={s.points} role="group" aria-label="Пункт выдачи">
              {list.map(p => (
                <button key={p.id} type="button" className={`${s.pointBtn} ${point === p.id ? s.pointOn : ''}`} aria-pressed={point === p.id} onClick={() => set({ point: p.id })}>{p.name}</button>
              ))}
              {list.length > 1 && <button type="button" className={`${s.pointBtn} ${point === 'all' ? s.pointOn : ''}`} aria-pressed={point === 'all'} onClick={() => set({ point: 'all' })}>Все пункты</button>}
            </div>
          </div>
          {point === 'all'
            ? <AllPoints onOpen={(id, day) => set({ point: id, tab: 'schedule', month: day ? day.slice(0, 7) : null })} />
            : point && <Workspace key={point} point={list.find(p => p.id === point)!} tab={tab} setTab={t => set({ tab: t })} initialMonth={params.get('month')} />}
        </>
      )}
    </div>
  );
}

type Dialog = { kind: 'replace'; from?: string; day?: string } | { kind: 'template' } | { kind: 'export' } | { kind: 'goods' } | null;

function Workspace({ point, tab, setTab, initialMonth }: { point: StaffPoint; tab: Tab; setTab: (t: Tab) => void; initialMonth: string | null }) {
  const docs = useStaffDocs(point.id);
  const toast = useToast();
  const [month, setMonth] = useState(initialMonth && /^\d{4}-\d{2}$/.test(initialMonth) ? initialMonth : monthKey(todayYmd()));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [payView, setPayView] = useState<'people' | 'deductions' | undefined>();
  const [focusPerson, setFocusPerson] = useState<string | undefined>();

  useEffect(() => {
    if (docs.merged) toast('Пока вы работали, график изменили на другом компьютере — правки объединены', 'default');
  }, [docs.merged]); // eslint-disable-line react-hooks/exhaustive-deps

  if (docs.status === 'loading') return <CabinetLoading />;
  if (docs.status === 'error' || !docs.snap) return <CabinetError error={docs.error} retry={docs.reload} />;

  const go = (to: GoTo) => {
    if (to.kind === 'replace') setDialog({ kind: 'replace', from: to.from, day: to.day });
    else if (to.kind === 'template') setDialog({ kind: 'template' });
    else if (to.kind === 'export') setDialog({ kind: 'export' });
    else if (to.kind === 'goods') setDialog({ kind: 'goods' });
    else if (to.kind === 'people') { setFocusPerson(to.personId); setTab('people'); }
    else if (to.kind === 'deductions') { setPayView('deductions'); setTab('payroll'); }
    else if (to.kind === 'payroll') setTab('payroll');
    else if (to.kind === 'settings') setTab('settings');
  };
  const empty = docs.snap.staff.staff_list.length === 0;

  return (
    <>
      <div className={s.top} style={{ marginTop: -4 }}>
        <SaveState docs={docs} />
      </div>
      <div className={s.tabBar} role="tablist" aria-label="Разделы">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`${s.tab} ${tab === t.id ? s.tabOn : ''}`} onClick={() => { setTab(t.id); if (t.id !== 'people') setFocusPerson(undefined); }}>{t.label}</button>
        ))}
      </div>

      {empty && tab !== 'settings' ? (
        <Card>
          <EmptyState icon={<Users size={26} />} title={`В пункте «${point.name}» пока нет сотрудников`} text="Соберём первый график за пару минут: кто работает, как работает и проверка месяца. Всё потом можно поправить."
            action={<Button onClick={() => setDialog({ kind: 'template' })}>Собрать первый график</Button>} />
        </Card>
      ) : (
        <>
          {tab === 'schedule' && <ScheduleTab docs={docs} month={month} setMonth={setMonth} go={go} />}
          {tab === 'payroll' && <PayrollTab key={payView} docs={docs} month={month} setMonth={setMonth} initialView={payView} />}
          {tab === 'people' && <PeopleTab docs={docs} pointId={point.id} focusId={focusPerson} onReplace={from => setDialog({ kind: 'replace', from })} />}
          {tab === 'settings' && <SettingsTab docs={docs} pointId={point.id} pointName={point.name} />}
        </>
      )}
      {empty && tab === 'settings' && <SettingsTab docs={docs} pointId={point.id} pointName={point.name} />}

      {dialog?.kind === 'replace' && <ReplaceDialog docs={docs} from={dialog.from} day={dialog.day} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'template' && <TemplateWizard docs={docs} month={month} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'export' && <ExportDialog snap={docs.snap} pointId={point.id} pointName={point.name} month={month} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'goods' && <GoodsDialog docs={docs} month={month} onClose={() => setDialog(null)} />}

      <Modal open={Boolean(docs.emptyGuard)} onOpenChange={o => !o && docs.cancelEmpty()} title={docs.emptyGuard === 'staff' ? 'Удалить всех сотрудников?' : 'Убрать все смены?'}
        description={docs.emptyGuard === 'staff' ? 'В пункте не останется ни одного сотрудника. Если на компьютере пункта список ещё есть, программа вернёт его.' : 'В графике не останется ни одной смены. Если на компьютере пункта смены ещё есть, программа вернёт их.'}>
        <div className={s.dialogActions}>
          <Button variant="secondary" onClick={docs.cancelEmpty}>Не удалять</Button>
          <Button variant="danger" onClick={docs.confirmEmpty}>Да, удалить</Button>
        </div>
      </Modal>
    </>
  );
}

function SaveState({ docs }: { docs: ReturnType<typeof useStaffDocs> }) {
  const time = docs.savedAt?.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (docs.save === 'offline') {
    return <span className={`${s.saveState} ${s.saveErr}`} role="status"><CloudOff size={16} />Нет связи — правки сохранятся, когда она появится. <button type="button" onClick={docs.retry}>Повторить сейчас</button></span>;
  }
  if (docs.save === 'error') {
    return <span className={`${s.saveState} ${s.saveErr}`} role="status">Не удалось сохранить. <button type="button" onClick={docs.retry}>Повторить</button> <button type="button" onClick={docs.reload}>Загрузить с сервера</button></span>;
  }
  if (docs.save === 'saving' || docs.save === 'pending') return <span className={`${s.saveState} ${s.saveWait}`} role="status">Сохраняем…</span>;
  return <span className={s.saveState} role="status"><Check size={16} />{time ? `Сохранено в ${time}` : 'Сохранено на сервере'}</span>;
}
