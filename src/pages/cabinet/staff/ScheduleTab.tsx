import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, Contrast, Redo2, Undo2 } from 'lucide-react';
import { Button, Modal } from '../../../ui';
import {
  addDays,
  clearDays,
  coverage,
  crowdedDays,
  dayMonth,
  isActive,
  maxPerDay,
  monthEnd,
  monthKey,
  monthStart,
  monthTitle,
  paidDays,
  paysShk,
  personTotal,
  range,
  rateOn,
  rub,
  shiftMonth,
  shiftOf,
  shiftsOn,
  shkCountOn,
  todayYmd,
  undecided,
  unitsText,
  type PaidMarks,
  type ScheduleData,
  type StaffEntry,
} from '../../../lib/staff-core';
import { Avatar, useIsPhone } from './parts';
import { DayPanel } from './DayPanel';
import { DayQuickPick } from './DayQuickPick';
import { MonthCalendar } from './MonthCalendar';
import type { StaffDocs } from './useStaffDocs';
import s from './staff.module.css';

export type GoTo = { kind: 'replace'; from?: string; day?: string } | { kind: 'template' } | { kind: 'goods' } | { kind: 'people'; personId?: string } | { kind: 'deductions' } | { kind: 'export' } | { kind: 'payroll' } | { kind: 'settings' };

export type Todo = {
  key: string; text: string; action: string; tone: 'red' | 'warn' | 'muted'; go?: GoTo; day?: string; run?: () => void; allow?: number;
  /** ещё действия у того же пункта (программа: «Скрыть» у подсказки о выдачах без смены) */
  more?: { label: string; run: () => void }[];
};

/** Чем раздел дополняет график там, где он встроен (программа: выдачи WB без смены, очистка периода). */
export interface ScheduleExt {
  toolbar?: ReactNode;
  todo?: Todo[];
  dayBadge?: (day: string) => ReactNode;
}

/**
 * График — календарь месяца, как на стене: неделя в строке, в клетке — кто работает.
 * Нажатие на день раскрывает рядом список сотрудников (поставить или убрать одним нажатием)
 * и открывает день справа (на телефоне — окном), где меняется всё остальное.
 */
export function ScheduleTab({ docs, month, setMonth, go, ext }: { docs: StaffDocs; month: string; setMonth: (m: string) => void; go: (to: GoTo) => void; ext?: ScheduleExt }) {
  const snap = docs.snap!;
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const phone = useIsPhone();
  const today = todayYmd();
  const canEdit = docs.caps?.edit !== false;
  const money = docs.caps?.money !== false;
  const [picked, setPicked] = useState(() => (month === monthKey(today) ? today : monthStart(month)));
  const [sheet, setSheet] = useState(false);
  const [quick, setQuick] = useState<string | null>(null);
  const calRef = useRef<HTMLDivElement>(null);
  const days = useMemo(() => range(monthStart(month), monthEnd(month)), [month]);
  const closed = Boolean(data.closed[month]);
  const people = useMemo(() => staff.filter(p => isActive(p) || days.some(d => shiftOf(data, d, p.id))), [staff, data, days]);
  // выплаты закрывают дни по порядку — считаем один раз на человека, а не в каждой клетке
  const paid = useMemo(() => {
    if (!money) return undefined;
    const out: Record<string, PaidMarks> = {};
    for (const p of people) out[p.id] = paidDays(p, data, month);
    return out;
  }, [money, people, data, month]);

  useEffect(() => {
    if (monthKey(picked) !== month) setPicked(month === monthKey(today) ? today : monthStart(month));
    setQuick(null);
  }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+Z / Ctrl+Y, пока фокус не в поле ввода
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if ((k === 'z' || k === 'я') && !e.shiftKey) { e.preventDefault(); docs.undo(); }
      else if (k === 'y' || k === 'н' || ((k === 'z' || k === 'я') && e.shiftKey)) { e.preventDefault(); docs.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docs]);

  const pick = (day: string) => {
    if (monthKey(day) !== month) setMonth(monthKey(day));
    setPicked(day);
    setQuick(null);
  };
  const openDay = (day: string) => {
    if (monthKey(day) !== month) setMonth(monthKey(day));
    setPicked(day);
    if (phone) return setSheet(true);
    // список у дня — только там, где смены можно менять
    setQuick(q => (q === day || data.closed[monthKey(day)] || !canEdit ? null : day));
  };
  const closeQuick = (focus: boolean) => {
    const day = quick;
    setQuick(null);
    if (focus && day) calRef.current?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus();
  };

  const todo = [...buildTodo(data, staff, people, days, today, month), ...(ext?.todo ?? [])];
  const total = people.reduce((a, p) => a + personTotal(p, data, days).money, 0);
  const allow = (n: number) => docs.update(sn => ({ ...sn, schedule: { ...sn.schedule, maxPerDay: n } }));

  const calendar = (
    <div ref={calRef}>
      <MonthCalendar month={month} data={data} staff={staff} phone={phone} onDay={openDay} picked={picked} paid={paid} badge={ext?.dayBadge}
        popover={quick ? { day: quick, node: place => <DayQuickPick docs={docs} day={quick} place={place} onClose={closeQuick} /> } : undefined}
        footer={
          <>
            <p className={s.calHint}>
              {canEdit && !closed ? `Нажмите на день — ${phone ? '' : 'рядом '}откроется список сотрудников: нажатие на имя ставит смену, повторное убирает.` : 'Нажмите на день, чтобы посмотреть, кто работает.'}
            </p>
            <div className={s.legend}>
              <span><i className={`${s.swatch} ${s.swatchNobody}`} aria-hidden="true" />в пункте никого нет</span>
              <span><i className={`${s.swatch} ${s.swatchOver}`} aria-hidden="true" />людей больше, чем разрешено в настройках</span>
              {money && <span><Check size={13} strokeWidth={3} aria-hidden="true" />смена оплачена</span>}
              {money && <span><Contrast size={13} aria-hidden="true" />оплачена частично</span>}
            </div>
          </>
        } />
    </div>
  );

  return (
    <>
      {docs.extended && (
        <div className={s.banner} role="status">
          <span>«Продлевать автоматически» добавило смен: {docs.extended.count}, до {dayMonth(docs.extended.until)}. Они поставлены по обычному графику сотрудников.</span>
          <Button size="sm" variant="secondary" onClick={() => {
            docs.update(sn => ({ ...sn, schedule: clearDays(sn.schedule, range(addDays(today, 1), docs.extended!.until), true).data }));
            docs.dismissExtended();
          }}>Убрать добавленные</Button>
          <Button size="sm" variant="ghost" onClick={() => { docs.update(sn => ({ ...sn, schedule: { ...sn.schedule, autoExtend: false } })); docs.dismissExtended(); }}>Больше не продлевать</Button>
          <Button size="sm" variant="ghost" onClick={docs.dismissExtended}>Понятно</Button>
        </div>
      )}

      <div className={s.toolbar}>
        <div className={s.monthNav}>
          <button type="button" className={s.iconBtn} aria-label="Предыдущий месяц" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={16} /></button>
          <div className={s.monthTitle}>{monthTitle(month)}</div>
          <button type="button" className={s.iconBtn} aria-label="Следующий месяц" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={16} /></button>
        </div>
        {month !== monthKey(today) && <Button size="sm" variant="ghost" onClick={() => pick(today)}>Сегодня</Button>}
        {canEdit && (
          <div className={s.btnRow}>
            <Button size="sm" variant="secondary" disabled={!docs.canUndo} onClick={docs.undo}><Undo2 size={16} />Отменить</Button>
            <Button size="sm" variant="secondary" disabled={!docs.canRedo} onClick={docs.redo}>Вернуть<Redo2 size={16} /></Button>
          </div>
        )}
        <div className={s.toolbarEnd}>
          {canEdit && <Button size="sm" onClick={() => go({ kind: 'template' })}>Заполнить по шаблону</Button>}
          {canEdit && <Button size="sm" variant="secondary" onClick={() => go({ kind: 'replace' })}>Замена на период</Button>}
          {ext?.toolbar}
          {docs.caps?.export !== false && <Button size="sm" variant="secondary" onClick={() => go({ kind: 'export' })}>Выгрузить</Button>}
        </div>
      </div>

      {closed && (
        <p className={`${s.note} ${s.noteWarn}`} style={{ marginBottom: 12 }}>
          {monthTitle(month)} закрыт: смены и выплаты этого месяца защищены от случайных правок. Открыть месяц снова можно во вкладке «Зарплата».
        </p>
      )}

      <div className={s.schedLayout}>
        <div>{calendar}</div>
        {!phone && (
          <aside className={s.side}>
            <DayPanel key={picked} docs={docs} day={picked} onDay={pick} />
            {people.length > 0 && (
              <section className={s.block} style={{ marginBottom: 0 }} aria-label="Итоги месяца">
                <div className={s.blockHead}><h2>Итого за {monthTitle(month).toLowerCase()}</h2></div>
                {people.map(p => {
                  const tot = personTotal(p, data, days);
                  return (
                    <div key={p.id} className={s.line}>
                      <span className={s.rowName} style={{ flexDirection: 'row' }}>
                        <Avatar person={p} index={staff.indexOf(p)} size={28} />
                        <span><b>{p.name || 'Без имени'}</b><small>смен {unitsText(tot.units)}</small></span>
                      </span>
                      {money && <b className={tot.noRate && !tot.byGoods ? s.gWarn : ''}>{tot.byGoods ? 'по товарам' : tot.noRate && !tot.money ? 'нет ставки' : rub(tot.money)}</b>}
                    </div>
                  );
                })}
                {money && total > 0 && <div className={s.line}><span><b>Всего по сменам</b></span><b>{rub(total)}</b></div>}
              </section>
            )}
          </aside>
        )}
      </div>

      <section className={s.block} style={{ marginTop: 16 }} aria-label="Что осталось сделать">
        <div className={s.blockHead}><h2>Что осталось сделать</h2></div>
        {todo.length === 0 ? (
          <p className={s.allClear}>До конца месяца все дни закрыты, замечаний нет.</p>
        ) : (
          <div className={s.todo}>
            {todo.map(t => (
              <div key={t.key} className={`${s.todoItem} ${t.tone === 'red' ? s.todoRed : t.tone === 'warn' ? s.todoWarn : ''}`}>
                <span className={s.dot} aria-hidden="true" />
                <span>{t.text}</span>
                <button type="button" onClick={() => (t.run ? t.run() : t.day ? openDay(t.day) : t.go && go(t.go))}>{t.action}</button>
                {t.allow && canEdit && <button type="button" onClick={() => allow(t.allow!)}>Разрешить {t.allow === 2 ? 'двоих' : 'троих'} в день</button>}
                {t.more?.map(m => <button key={m.label} type="button" onClick={m.run}>{m.label}</button>)}
              </div>
            ))}
          </div>
        )}
      </section>

      {phone && (
        <Modal open={sheet} onOpenChange={setSheet} sheet title="Смены дня" description="Нажмите на имя, чтобы поставить или убрать смену. Полсмены, свои часы и замена — ниже.">
          <DayPanel key={picked} docs={docs} day={picked} onDay={pick} quick />
          <div className={s.dialogActions} style={{ marginTop: 16 }}><Button onClick={() => setSheet(false)}>Готово</Button></div>
        </Modal>
      )}
    </>
  );
}

function listDays(ds: string[]): string {
  if (ds.length > 6) return `${ds.length} дней`;
  const nums = ds.map(d => Number(d.slice(8)));
  const tail = dayMonth(ds[ds.length - 1]).replace(/^\d+ /, '');
  return nums.length === 1 ? `${nums[0]} ${tail}` : `${nums.slice(0, -1).join(', ')} и ${nums[nums.length - 1]} ${tail}`;
}

function buildTodo(data: ScheduleData, staff: StaffEntry[], people: StaffEntry[], days: string[], today: string, month: string): Todo[] {
  const out: Todo[] = [];
  if (!staff.length) return [{ key: 'nobody', tone: 'warn', action: 'Добавить сотрудников', go: { kind: 'template' }, text: 'В пункте нет сотрудников.' }];
  const open = !data.closed[month];
  const future = days.filter(d => d >= today);
  const empty = future.filter(d => coverage(data, d) === 0);
  if (empty.length && open) {
    out.push({ key: 'empty', tone: 'red', action: empty.length > 3 ? 'Заполнить по шаблону' : 'Открыть день', ...(empty.length > 3 ? { go: { kind: 'template' } as GoTo } : { day: empty[0] }), text: `В пункте никого нет: ${listDays(empty)}. Откройте день и выберите, кто выйдет, или отметьте, что работаете сами.` });
  }
  // прошедшие дни тоже: за них начисляется зарплата обоим
  const crowded = open ? crowdedDays(data, days) : [];
  if (crowded.length) {
    const limit = maxPerDay(data);
    const most = crowded.reduce((a, d) => Math.max(a, shiftsOn(data, d).length), 0);
    out.push({
      key: 'crowded', tone: 'warn', action: 'Открыть день', day: crowded[0], ...(most <= 3 ? { allow: most } : {}),
      text: `Людей больше, чем разрешено в настройках (${limit === 1 ? 'один человек' : `не больше ${limit}`} в день): ${listDays(crowded)}. Откройте день и оставьте одного или разрешите работать вместе.`,
    });
  }
  for (const p of people) {
    if (paysShk(p)) continue;
    if (days.some(d => shiftOf(data, d, p.id) && !rateOn(p, d))) out.push({ key: `rate-${p.id}`, tone: 'warn', action: 'Указать ставку', go: { kind: 'people', personId: p.id }, text: `У сотрудника «${p.name}» не указана ставка, поэтому его смены пока не оплачиваются.` });
  }
  for (const p of people.filter(paysShk)) {
    const miss = days.filter(d => d <= today && shiftOf(data, d, p.id) && !shkCountOn(data, p.id, d));
    if (miss.length) out.push({ key: `goods-${p.id}`, tone: 'warn', action: 'Ввести товары', go: { kind: 'goods' }, text: `У сотрудника «${p.name}» не введены принятые товары: ${listDays(miss)}. Без них зарплата за эти дни не считается.` });
  }
  const und = undecided(data, month);
  if (und.length) out.push({ key: 'wb', tone: 'muted', action: 'Разобрать удержания', go: { kind: 'deductions' }, text: `Удержаний WB, не распределённых между сотрудниками: ${und.length}. Пока не решено, из зарплаты ничего не вычитается.` });
  return out;
}
