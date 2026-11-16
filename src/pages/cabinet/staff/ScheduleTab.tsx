import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Redo2, Undo2 } from 'lucide-react';
import { Button, Modal } from '../../../ui';
import {
  WEEKDAYS,
  addDays,
  brushOf,
  clearDays,
  colorOf,
  coverage,
  dayMonth,
  hoursOf,
  isActive,
  isOwnerDay,
  maxPerDay,
  monthEnd,
  monthKey,
  monthStart,
  monthTitle,
  overLimit,
  paysShk,
  personTotal,
  range,
  rateOn,
  rub,
  shiftMonth,
  shiftOf,
  shiftsOn,
  shkCountOn,
  shortName,
  todayYmd,
  undecided,
  unitsText,
  weekday,
  type ScheduleData,
  type Shift,
  type StaffEntry,
} from '../../../lib/staff-core';
import { Avatar, useIsPhone } from './parts';
import { DayPanel } from './DayPanel';
import type { StaffDocs } from './useStaffDocs';
import s from './staff.module.css';

export type GoTo = { kind: 'replace'; from?: string; day?: string } | { kind: 'template' } | { kind: 'goods' } | { kind: 'people'; personId?: string } | { kind: 'deductions' } | { kind: 'export' } | { kind: 'payroll' } | { kind: 'settings' };

/** Что дописать под именем в клетке, если смена неполная или это замена. */
function shiftNote(sh: Shift, data: ScheduleData): string {
  const kind = brushOf(sh, data);
  const part = kind === 'am' ? 'утро' : kind === 'pm' ? 'вечер' : kind === 'hours' ? hoursOf(sh, data) : '';
  return [part, sh.replaces ? 'замена' : ''].filter(Boolean).join(', ');
}

/** Подпись смены для чтения с экрана и поиска в тестах: «Анна · утро». */
function shiftLabel(sh: Shift, name: string, data: ScheduleData): string {
  const note = shiftNote(sh, data);
  return `${shortName(name)}${note ? ` · ${note}` : ''}`;
}

/**
 * График — календарь месяца, как на стене: неделя в строке, в клетке — кто работает.
 * Нажатие на день открывает его справа (на телефоне — окном), и там же всё меняется.
 */
export function ScheduleTab({ docs, month, setMonth, go }: { docs: StaffDocs; month: string; setMonth: (m: string) => void; go: (to: GoTo) => void }) {
  const snap = docs.snap!;
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const phone = useIsPhone();
  const today = todayYmd();
  const [picked, setPicked] = useState(() => (month === monthKey(today) ? today : monthStart(month)));
  const [sheet, setSheet] = useState(false);
  const days = useMemo(() => range(monthStart(month), monthEnd(month)), [month]);
  const closed = Boolean(data.closed[month]);
  const people = useMemo(() => staff.filter(p => isActive(p) || days.some(d => shiftOf(data, d, p.id))), [staff, data, days]);
  const nameOf = (id: string) => staff.find(p => p.id === id)?.name || data.removedNames?.[id] || 'сотрудник';

  useEffect(() => {
    if (monthKey(picked) !== month) setPicked(month === monthKey(today) ? today : monthStart(month));
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
  };
  const openDay = (day: string) => {
    pick(day);
    if (phone) setSheet(true);
  };

  const lead = weekday(days[0]);
  const cells: (string | null)[] = [...Array.from({ length: lead }, () => null), ...days];
  while (cells.length % 7) cells.push(null);
  const maxLines = phone ? 2 : 3;
  const todo = buildTodo(data, staff, people, days, today, month);
  const total = people.reduce((a, p) => a + personTotal(p, data, days).money, 0);

  const calendar = (
    <section className={s.cal} aria-label={`График на ${monthTitle(month).toLowerCase()}`}>
      <div className={s.calWeekdays} aria-hidden="true">
        {WEEKDAYS.map((w, i) => <span key={w} className={i >= 5 ? s.calWeekendName : ''}>{w.toLowerCase()}</span>)}
      </div>
      <div className={s.calGrid}>
        {cells.map((d, i) => {
          if (!d) return <span key={`gap-${i}`} />;
          const list = shiftsOn(data, d);
          const owner = isOwnerDay(data, d);
          const empty = !list.length && !owner;
          const lines = list.slice(0, list.length > maxLines ? maxLines - 1 : maxLines);
          const names = [...list.map(x => shiftLabel(x, nameOf(x.staffId), data)), ...(owner ? ['владелец'] : [])];
          const cls = [
            s.calCell,
            weekday(d) >= 5 && s.calWeekendCell,
            d === today && s.calToday,
            empty && d >= today && !closed && s.calNobody,
            overLimit(data, d) && s.calOver,
            d === picked && !phone && s.calPicked,
          ].filter(Boolean).join(' ');
          return (
            <button key={d} type="button" className={cls} aria-current={d === today ? 'date' : undefined} aria-pressed={d === picked && !phone}
              aria-label={`${dayMonth(d)}: ${names.length ? names.join(', ') : 'никого нет'}`} onClick={() => openDay(d)}>
              <span className={s.calNum}>{Number(d.slice(8))}</span>
              {lines.map(sh => {
                const p = staff.find(x => x.id === sh.staffId);
                const c = p ? colorOf(p, staff.indexOf(p)) : { bg: '#e9eaf0', fg: '#3a3d52', solid: '#6b6f88' };
                const note = shiftNote(sh, data);
                return (
                  <span key={sh.staffId} className={s.calLine} style={{ background: c.bg, color: c.fg }}>
                    {shortName(nameOf(sh.staffId))}
                    {note && <small>{note}</small>}
                  </span>
                );
              })}
              {list.length > lines.length && <span className={s.calMore}>ещё {list.length - lines.length}</span>}
              {owner && <span className={s.calLine} style={{ background: '#e9eaf0', color: '#3a3d52' }}>{phone ? 'Я' : 'Владелец'}</span>}
              {empty && d >= today && !closed && <span className={s.calNone}>{phone ? 'никого' : 'никого нет'}</span>}
            </button>
          );
        })}
      </div>
      <p className={s.calHint}>Нажмите на день, чтобы поставить или изменить смену. Красный пунктир — в этот день в пункте никого нет.</p>
    </section>
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
        <div className={s.btnRow}>
          <Button size="sm" variant="secondary" disabled={!docs.canUndo} onClick={docs.undo}><Undo2 size={16} />Отменить</Button>
          <Button size="sm" variant="secondary" disabled={!docs.canRedo} onClick={docs.redo}>Вернуть<Redo2 size={16} /></Button>
        </div>
        <div className={s.toolbarEnd}>
          <Button size="sm" onClick={() => go({ kind: 'template' })}>Заполнить по шаблону</Button>
          <Button size="sm" variant="secondary" onClick={() => go({ kind: 'replace' })}>Замена на период</Button>
          <Button size="sm" variant="secondary" onClick={() => go({ kind: 'export' })}>Выгрузить</Button>
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
                      <b className={tot.noRate && !tot.byGoods ? s.gWarn : ''}>{tot.byGoods ? 'по товарам' : tot.noRate && !tot.money ? 'нет ставки' : rub(tot.money)}</b>
                    </div>
                  );
                })}
                {total > 0 && <div className={s.line}><span><b>Всего по сменам</b></span><b>{rub(total)}</b></div>}
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
                <button type="button" onClick={() => (t.day ? openDay(t.day) : t.go && go(t.go))}>{t.action}</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {phone && (
        <Modal open={sheet} onOpenChange={setSheet} sheet title="Смены дня" description="Выберите для каждого сотрудника, работает ли он в этот день.">
          <DayPanel key={picked} docs={docs} day={picked} onDay={pick} />
          <div className={s.dialogActions} style={{ marginTop: 16 }}><Button onClick={() => setSheet(false)}>Готово</Button></div>
        </Modal>
      )}
    </>
  );
}

type Todo = { key: string; text: string; action: string; tone: 'red' | 'warn' | 'muted'; go?: GoTo; day?: string };

function listDays(ds: string[]): string {
  if (ds.length > 6) return `${ds.length} дней`;
  const nums = ds.map(d => Number(d.slice(8)));
  const tail = dayMonth(ds[ds.length - 1]).replace(/^\d+ /, '');
  return nums.length === 1 ? `${nums[0]} ${tail}` : `${nums.slice(0, -1).join(', ')} и ${nums[nums.length - 1]} ${tail}`;
}

function buildTodo(data: ScheduleData, staff: StaffEntry[], people: StaffEntry[], days: string[], today: string, month: string): Todo[] {
  const out: Todo[] = [];
  if (!staff.length) return [{ key: 'nobody', tone: 'warn', action: 'Добавить сотрудников', go: { kind: 'template' }, text: 'В пункте нет сотрудников.' }];
  const future = days.filter(d => d >= today);
  const empty = future.filter(d => coverage(data, d) === 0);
  if (empty.length && !data.closed[month]) {
    out.push({ key: 'empty', tone: 'red', action: empty.length > 3 ? 'Заполнить по шаблону' : 'Открыть день', ...(empty.length > 3 ? { go: { kind: 'template' } as GoTo } : { day: empty[0] }), text: `В пункте никого нет: ${listDays(empty)}. Откройте день и выберите, кто выйдет, или отметьте, что работаете сами.` });
  }
  const crowded = future.filter(d => overLimit(data, d));
  if (crowded.length) {
    const limit = maxPerDay(data);
    out.push({ key: 'crowded', tone: 'warn', action: 'Открыть день', day: crowded[0], text: `Людей больше, чем разрешено (${limit === 1 ? 'один человек' : `не больше ${limit}`} в день): ${listDays(crowded)}. Уберите лишнюю смену или разрешите больше людей в настройках.` });
  }
  for (const p of people) {
    if (paysShk(p)) continue;
    if (days.some(d => shiftOf(data, d, p.id) && !rateOn(p, d))) out.push({ key: `rate-${p.id}`, tone: 'warn', action: 'Указать ставку', go: { kind: 'people', personId: p.id }, text: `У сотрудника «${p.name}» не указана ставка, поэтому его смены пока не оплачиваются.` });
  }
  for (const p of people.filter(paysShk)) {
    const miss = days.filter(d => d <= today && shiftOf(data, d, p.id) && !shkCountOn(data, p.id, d));
    if (miss.length) out.push({ key: `goods-${p.id}`, tone: 'warn', action: 'Ввести товары', go: { kind: 'goods' }, text: `У сотрудника «${p.name}» не введены принятые товары: ${listDays(miss)}. Без них зарплата за эти дни не считается.` });
  }
  const open = undecided(data, month);
  if (open.length) out.push({ key: 'wb', tone: 'muted', action: 'Разобрать удержания', go: { kind: 'deductions' }, text: `Удержаний WB, не распределённых между сотрудниками: ${open.length}. Пока не решено, из зарплаты ничего не вычитается.` });
  return out;
}
