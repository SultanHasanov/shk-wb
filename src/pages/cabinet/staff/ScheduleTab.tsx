import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Redo2, Undo2 } from 'lucide-react';
import { Button, Input } from '../../../ui';
import {
  WEEKDAYS,
  addDays,
  brushOf,
  clearDays,
  colorOf,
  coverage,
  dayMonth,
  isActive,
  isClosedDay,
  isOwnerDay,
  monthEnd,
  monthKey,
  monthStart,
  monthTitle,
  paintCell,
  paysShk,
  personTotal,
  range,
  rateOn,
  rub,
  sameAsBrush,
  setOwnerDay,
  shiftMonth,
  shiftOf,
  shkCountOn,
  todayYmd,
  undecided,
  unitsText,
  weekStart,
  weekday,
  type Brush,
  type Hours,
  type ScheduleData,
  type Shift,
  type StaffEntry,
} from '../../../lib/staff-core';
import { hoursOf } from '../../../lib/staff-core';
import { Avatar, parseClock, useIsPhone } from './parts';
import type { StaffDocs } from './useStaffDocs';
import { ShiftDialog } from './ShiftDialog';
import s from './staff.module.css';

type Tool = Brush | 'open';
const OWNER = '__owner';

const TOOLS: { id: Tool; name: string; sub: (d: ScheduleData, h: Hours) => string; swatch: string }[] = [
  { id: 'full', name: 'Смена', sub: d => `${clock(d.dayHours.from)}–${clock(d.dayHours.to)}`, swatch: 'var(--text-muted)' },
  { id: 'am', name: 'Полсмены утром', sub: d => hoursOf({ staffId: '', kind: 'half' }, d), swatch: 'linear-gradient(90deg, var(--text-muted) 50%, #fff 50%)' },
  { id: 'pm', name: 'Полсмены вечером', sub: d => secondHalfLabel(d), swatch: 'linear-gradient(90deg, #fff 50%, var(--text-muted) 50%)' },
  { id: 'hours', name: 'Свои часы', sub: (_d, h) => `${clock(h.from)}–${clock(h.to)}`, swatch: 'var(--surface-sunken)' },
  { id: 'erase', name: 'Стереть', sub: () => 'убрать смену', swatch: '#fff' },
  { id: 'open', name: 'Открыть смену', sub: () => 'часы, замена', swatch: '#fff' },
];

function clock(t: string) {
  return t.replace(/^0(\d)/, '$1');
}
function secondHalfLabel(d: ScheduleData) {
  const a = (Number(d.dayHours.from.slice(0, 2)) * 60 + Number(d.dayHours.from.slice(3))) || 0;
  const b = (Number(d.dayHours.to.slice(0, 2)) * 60 + Number(d.dayHours.to.slice(3))) || 0;
  const mid = a + Math.round((b - a) / 2);
  return `${Math.floor(mid / 60)}:${String(mid % 60).padStart(2, '0')}–${clock(d.dayHours.to)}`;
}

export function cellLook(sh: Shift | undefined, person: StaffEntry, index: number, data: ScheduleData) {
  const c = colorOf(person, index);
  const kind = brushOf(sh, data);
  if (!sh || !kind) return null;
  if (sh.replaces) return { background: c.bg, borderColor: c.solid, color: c.fg, text: 'з' };
  if (kind === 'full') return { background: c.solid, borderColor: c.solid, color: '#fff', text: '' };
  if (kind === 'am') return { background: `linear-gradient(90deg, ${c.solid} 50%, #fff 50%)`, borderColor: c.solid, color: c.fg, text: '' };
  if (kind === 'pm') return { background: `linear-gradient(90deg, #fff 50%, ${c.solid} 50%)`, borderColor: c.solid, color: c.fg, text: '' };
  const h = Math.round(((toMin(sh.to) - toMin(sh.from)) / 60) * 10) / 10;
  return { background: c.bg, borderColor: c.solid, color: c.fg, text: `${String(h).replace('.', ',')}ч` };
}
function toMin(t?: string) {
  const [h, m] = String(t ?? '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function describeShift(sh: Shift | undefined, data: ScheduleData, nameOf: (id: string) => string): string {
  if (!sh) return 'смены нет';
  const kind = brushOf(sh, data);
  const label = kind === 'full' ? 'смена' : kind === 'am' ? 'полсмены утром' : kind === 'pm' ? 'полсмены вечером' : 'свои часы';
  return `${label}, ${hoursOf(sh, data)}${sh.replaces ? `, вышел(ла) за ${nameOf(sh.replaces)}` : ''}`;
}

export type GoTo = { kind: 'replace'; from?: string; day?: string } | { kind: 'template' } | { kind: 'goods' } | { kind: 'people'; personId?: string } | { kind: 'deductions' } | { kind: 'export' } | { kind: 'payroll' };

export function ScheduleTab({ docs, month, setMonth, go }: { docs: StaffDocs; month: string; setMonth: (m: string) => void; go: (to: GoTo) => void }) {
  const snap = docs.snap!;
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const phone = useIsPhone();
  const [tool, setTool] = useState<Tool>('full');
  const [hours, setHours] = useState<Hours>({ from: '10:00', to: '18:00' });
  const [hoursText, setHoursText] = useState({ from: '10:00', to: '18:00' });
  const [picked, setPicked] = useState<{ id: string; day: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; day: string } | null>(null);
  const stroke = useRef<{ mode: 'set' | 'erase' } | null>(null);
  const today = todayYmd();
  const days = useMemo(() => range(monthStart(month), monthEnd(month)), [month]);
  const closed = Boolean(data.closed[month]);
  const people = useMemo(() => staff.filter(p => isActive(p) || days.some(d => shiftOf(data, d, p.id))), [staff, data, days]);
  const nameOf = (id: string) => staff.find(p => p.id === id)?.name || data.removedNames?.[id] || 'сотрудник';
  const indexOf = (p: StaffEntry) => staff.indexOf(p);

  useEffect(() => {
    const stop = () => { stroke.current = null; };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

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

  const apply = (id: string, day: string, mode: 'set' | 'erase') => {
    docs.update(sn => {
      const sched = id === OWNER
        ? setOwnerDay(sn.schedule, day, mode === 'set')
        : paintCell(sn.schedule, id, day, mode === 'erase' ? 'erase' : (tool as Brush), hours);
      return sched === sn.schedule ? sn : { ...sn, schedule: sched };
    }, { undo: false });
  };

  const start = (id: string, day: string) => {
    if (tool === 'open') {
      setPicked({ id, day });
      return;
    }
    if (isClosedDay(data, day)) return;
    const own = id === OWNER ? isOwnerDay(data, day) : undefined;
    const mode: 'set' | 'erase' = id === OWNER
      ? (own || tool === 'erase' ? 'erase' : 'set')
      : tool === 'erase' || sameAsBrush(shiftOf(data, day, id), tool, data, hours) ? 'erase' : 'set';
    docs.checkpoint();
    stroke.current = { mode };
    apply(id, day, mode);
  };

  const drag = (id: string, day: string) => {
    if (stroke.current && tool !== 'open') apply(id, day, stroke.current.mode);
  };

  const commitHours = (which: 'from' | 'to', text: string) => {
    const t = parseClock(text);
    if (!t) {
      setHoursText(h => ({ ...h, [which]: hours[which] }));
      return;
    }
    const next = { ...hours, [which]: t };
    setHours(next);
    setHoursText({ from: clock(next.from), to: clock(next.to) });
  };

  const todo = useTodo(data, staff, people, days, today, month);
  const total = people.reduce((a, p) => a + personTotal(p, data, days).money, 0);
  const cols = `184px repeat(${days.length}, minmax(26px, 1fr)) 104px`;

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
        {month !== monthKey(today) && <Button size="sm" variant="ghost" onClick={() => setMonth(monthKey(today))}>Сегодня</Button>}
        <div className={s.btnRow}>
          <Button size="sm" variant="secondary" disabled={!docs.canUndo} onClick={docs.undo}><Undo2 size={16} />Отменить</Button>
          <Button size="sm" variant="secondary" disabled={!docs.canRedo} onClick={docs.redo}>Вернуть<Redo2 size={16} /></Button>
        </div>
        <div className={s.toolbarEnd}>
          {staff.some(p => isActive(p) && paysShk(p)) && <Button size="sm" variant="secondary" onClick={() => go({ kind: 'goods' })}>Принятые товары</Button>}
          <Button size="sm" variant="secondary" onClick={() => go({ kind: 'template' })}>Заполнить по шаблону</Button>
          <Button size="sm" variant="secondary" onClick={() => go({ kind: 'replace' })}>Замена на период</Button>
          <Button size="sm" onClick={() => go({ kind: 'export' })}>Выгрузить</Button>
        </div>
      </div>

      {closed && (
        <p className={`${s.note} ${s.noteWarn}`} style={{ marginBottom: 12 }}>
          {monthTitle(month)} закрыт: смены и выплаты этого месяца защищены от случайных правок. Открыть месяц снова можно во вкладке «Зарплата».
        </p>
      )}

      {phone ? (
        <PhoneDay docs={docs} days={days} people={people} staff={staff} today={today} />
      ) : (
        <section className={s.block} aria-label="Табель">
          <div className={s.palette} role="group" aria-label="Что делаем">
            <span className={s.paletteLabel}>Что делаем</span>
            {TOOLS.map(t => (
              <button
                key={t.id}
                type="button"
                className={`${s.brush} ${tool === t.id ? s.brushOn : ''} ${t.id === 'open' ? s.brushGap : ''}`}
                aria-pressed={tool === t.id}
                onClick={() => { setTool(t.id); if (t.id !== 'open') setPicked(null); }}
              >
                <span className={s.swatch} aria-hidden="true" style={{ background: t.swatch, borderStyle: t.id === 'erase' ? 'dashed' : 'solid', borderWidth: t.id === 'open' ? 3 : 1, borderColor: t.id === 'open' ? 'var(--accent)' : undefined }} />
                <span className={s.brushText}><b>{t.name}</b><small>{t.sub(data, hours)}</small></span>
              </button>
            ))}
          </div>
          {tool === 'hours' && (
            <div className={s.hoursBar}>
              <label htmlFor="st-h1">Свои часы: с</label>
              <Input id="st-h1" className={s.timeInput} value={hoursText.from} inputMode="numeric" onChange={e => setHoursText(h => ({ ...h, from: e.target.value }))} onBlur={e => commitHours('from', e.target.value)} />
              <label htmlFor="st-h2">до</label>
              <Input id="st-h2" className={s.timeInput} value={hoursText.to} inputMode="numeric" onChange={e => setHoursText(h => ({ ...h, to: e.target.value }))} onBlur={e => commitHours('to', e.target.value)} />
              <span className={s.muted}>{hoursShare(hours, data)} Теперь щёлкайте по дням.</span>
            </div>
          )}
          <p className={s.hint}>
            {tool === 'open'
              ? 'Щёлкните по дню в табеле: ниже появится, что в нём стоит, и кнопки, чтобы поменять часы, найти замену или убрать смену.'
              : 'Выберите, что ставить, и щёлкайте по дням или тяните мышью вдоль строки. Повторный щелчок по такой же смене убирает её. Чтобы поменять часы одной смены или найти замену, выберите «Открыть смену». Любое действие можно отменить.'}
          </p>

          {people.length === 0 ? (
            <p className={s.note}>В пункте пока нет сотрудников. Добавьте их во вкладке «Люди» или через «Заполнить по шаблону».</p>
          ) : (
            <div className={s.gridWrap}>
              <div className={s.grid}>
                <div className={`${s.gRow} ${s.gHead}`} style={{ gridTemplateColumns: cols }}>
                  <span className={s.muted}>Сотрудник</span>
                  {days.map(d => (
                    <span key={d} className={`${s.gDay} ${weekday(d) >= 5 ? s.gWeekend : ''} ${d === today ? s.gToday : ''}`}>
                      <small>{WEEKDAYS[weekday(d)].toLowerCase()}</small>
                      <b>{Number(d.slice(8))}</b>
                    </span>
                  ))}
                  <span className={s.muted} style={{ textAlign: 'right' }}>За месяц</span>
                </div>
                {people.map(p => {
                  const idx = indexOf(p);
                  const tot = personTotal(p, data, days);
                  const rate = rateOn(p, today);
                  return (
                    <div key={p.id} className={s.gRow} style={{ gridTemplateColumns: cols }}>
                      <span className={s.gName}>
                        <Avatar person={p} index={idx} />
                        <span className={s.gNameText}>
                          <b>{p.name || 'Без имени'}</b>
                          <small className={tot.noRate || (!paysShk(p) && !rate) ? s.gWarn : ''}>
                            {!isActive(p) ? 'не работает' : paysShk(p) ? 'за принятые товары' : rate ? `${rub(rate)} за смену` : 'Ставка не указана'}
                          </small>
                        </span>
                      </span>
                      {days.map(d => {
                        const sh = shiftOf(data, d, p.id);
                        const look = cellLook(sh, p, idx, data);
                        const pickedHere = picked?.id === p.id && picked.day === d && tool === 'open';
                        return (
                          <button
                            key={d}
                            type="button"
                            className={`${s.cell} ${weekday(d) >= 5 ? s.cellWeekend : ''} ${pickedHere ? s.cellPicked : ''}`}
                            style={look ?? undefined}
                            disabled={closed && tool !== 'open'}
                            aria-label={`${p.name}, ${dayMonth(d)}: ${describeShift(sh, data, nameOf)}`}
                            onPointerDown={e => { if ((e.button ?? 0) === 0) { e.preventDefault(); start(p.id, d); } }}
                            onPointerEnter={() => drag(p.id, d)}
                            onClick={e => { if (e.detail === 0) { start(p.id, d); stroke.current = null; } }}
                          >
                            {look?.text}
                          </button>
                        );
                      })}
                      <span className={s.gSum}>
                        <b>{tot.byGoods ? 'по товарам' : tot.noRate && !tot.money ? 'нет ставки' : rub(tot.money)}</b>
                        <small>смен {unitsText(tot.units)}</small>
                      </span>
                    </div>
                  );
                })}
                <div className={`${s.gRow} ${s.gOwnerRow}`} style={{ gridTemplateColumns: cols }}>
                  <span className={s.gName}>
                    <span className={s.avatar} aria-hidden="true" style={{ width: 32, height: 32, background: '#e9eaf0', color: '#3a3d52', fontSize: 12 }}>Я</span>
                    <span className={s.gNameText}><b>Владелец</b><small>если работаете сами</small></span>
                  </span>
                  {days.map(d => {
                    const on = isOwnerDay(data, d);
                    return (
                      <button
                        key={d}
                        type="button"
                        className={`${s.cell} ${weekday(d) >= 5 ? s.cellWeekend : ''}`}
                        style={on ? { background: '#6b6f88', borderColor: '#6b6f88' } : undefined}
                        disabled={closed || tool === 'open'}
                        aria-label={`Владелец, ${dayMonth(d)}: ${on ? 'работает сам' : 'не работает'}`}
                        onPointerDown={e => { if ((e.button ?? 0) === 0) { e.preventDefault(); start(OWNER, d); } }}
                        onPointerEnter={() => drag(OWNER, d)}
                        onClick={e => { if (e.detail === 0) { start(OWNER, d); stroke.current = null; } }}
                      />
                    );
                  })}
                  <span className={s.gSum}><b>без оплаты</b><small>дней {days.filter(d => isOwnerDay(data, d)).length}</small></span>
                </div>
                <div className={`${s.gRow} ${s.gFoot}`} style={{ gridTemplateColumns: cols }}>
                  <span className={s.label}>В пункте, человек</span>
                  {days.map(d => {
                    const n = coverage(data, d);
                    return <span key={d} className={`${s.cover} ${n ? '' : s.coverZero}`}>{n}</span>;
                  })}
                  <span className={s.num} style={{ fontWeight: 700 }}>{rub(total)}</span>
                </div>
              </div>
            </div>
          )}

          {picked && tool === 'open' && (() => {
            const p = staff.find(x => x.id === picked.id);
            if (!p) return null;
            const sh = shiftOf(data, picked.day, p.id);
            const locked = isClosedDay(data, picked.day);
            return (
              <div className={s.selPanel}>
                <span><b>{p.name}, {dayMonth(picked.day)}:</b> {describeShift(sh, data, nameOf)}</span>
                {locked ? <span className={s.muted}>Месяц закрыт.</span> : sh ? (
                  <>
                    <Button size="sm" onClick={() => setEditing(picked)}>Изменить часы или найти замену</Button>
                    <Button size="sm" variant="secondary" onClick={() => docs.update(sn => ({ ...sn, schedule: paintCell(sn.schedule, p.id, picked.day, 'erase') }))}>Убрать смену</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" onClick={() => docs.update(sn => ({ ...sn, schedule: paintCell(sn.schedule, p.id, picked.day, 'full') }))}>Поставить смену</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(picked)}>Другие часы</Button>
                  </>
                )}
              </div>
            );
          })()}

          <div className={s.legend}>
            <span>«8ч» — свои часы</span>
            <span>«з» — вышел на замену</span>
            <span>Красный ноль внизу — в этот день в пункте никого нет</span>
            <span>Строка «Владелец» — дни, когда вы работаете сами: смены сотрудников в этот день не оплачиваются</span>
          </div>
        </section>
      )}

      <section className={s.block} aria-label="Что осталось сделать">
        <div className={s.blockHead}><h2>Что осталось сделать</h2></div>
        {todo.length === 0 ? (
          <p className={s.allClear}>До конца месяца все дни закрыты, замечаний нет.</p>
        ) : (
          <div className={s.todo}>
            {todo.map(t => (
              <div key={t.key} className={`${s.todoItem} ${t.tone === 'red' ? s.todoRed : t.tone === 'warn' ? s.todoWarn : ''}`}>
                <span className={s.dot} aria-hidden="true" />
                <span>{t.text}</span>
                <button type="button" onClick={() => go(t.go)}>{t.action}</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <ShiftDialog
          docs={docs}
          staffId={editing.id}
          day={editing.day}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function hoursShare(h: Hours, d: ScheduleData): string {
  const len = toMin(d.dayHours.to) - toMin(d.dayHours.from) || 720;
  const mine = toMin(h.to) - toMin(h.from);
  if (mine <= 0) return 'Время «до» должно быть позже «с».';
  const share = Math.round((mine / len) * 100);
  return `${unitsText(mine / 60)} ч из ${unitsText(len / 60)} — оплата ${share}% ставки.`;
}

type Todo = { key: string; text: string; action: string; tone: 'red' | 'warn' | 'muted'; go: GoTo };

function listDays(ds: string[]): string {
  if (ds.length > 6) return `${ds.length} дней до конца месяца`;
  const nums = ds.map(d => Number(d.slice(8)));
  const tail = dayMonth(ds[ds.length - 1]).replace(/^\d+ /, '');
  return nums.length === 1 ? `${nums[0]} ${tail}` : `${nums.slice(0, -1).join(', ')} и ${nums[nums.length - 1]} ${tail}`;
}

function useTodo(data: ScheduleData, staff: StaffEntry[], people: StaffEntry[], days: string[], today: string, month: string): Todo[] {
  const out: Todo[] = [];
  const future = days.filter(d => d >= today);
  const empty = future.filter(d => coverage(data, d) === 0);
  if (empty.length) {
    out.push({ key: 'empty', tone: 'red', action: 'Найти замену', go: { kind: 'replace', day: empty[0] }, text: `В пункте никого нет: ${listDays(empty)}. Поставьте смену сотруднику или закрасьте день в строке «Владелец», если выйдете сами.` });
  }
  for (const p of people) {
    if (paysShk(p)) continue;
    const noRate = days.some(d => shiftOf(data, d, p.id) && !rateOn(p, d));
    if (noRate) out.push({ key: `rate-${p.id}`, tone: 'warn', action: 'Указать ставку', go: { kind: 'people', personId: p.id }, text: `У сотрудника «${p.name}» не указана ставка, поэтому его смены пока не оплачиваются.` });
  }
  for (const p of people.filter(paysShk)) {
    const miss = days.filter(d => d <= today && shiftOf(data, d, p.id) && !shkCountOn(data, p.id, d));
    if (miss.length) out.push({ key: `goods-${p.id}`, tone: 'warn', action: 'Ввести товары', go: { kind: 'goods' }, text: `У сотрудника «${p.name}» не введены принятые товары: ${listDays(miss).replace(' до конца месяца', '')}.` });
  }
  const open = undecided(data, month);
  if (open.length) out.push({ key: 'wb', tone: 'muted', action: 'Разобрать удержания', go: { kind: 'deductions' }, text: `Удержаний WB, не распределённых между сотрудниками: ${open.length}. Пока не решено, из зарплаты ничего не вычитается.` });
  if (!staff.length) out.push({ key: 'nobody', tone: 'warn', action: 'Добавить сотрудников', go: { kind: 'template' }, text: 'В пункте нет сотрудников.' });
  return out;
}

// ── телефон: неделя полоской и выбранный день ──

function PhoneDay({ docs, days, people, staff, today }: { docs: StaffDocs; days: string[]; people: StaffEntry[]; staff: StaffEntry[]; today: string }) {
  const data = docs.snap!.schedule;
  const initial = days.includes(today) ? today : days[0];
  const [day, setDay] = useState(initial);
  useEffect(() => { if (!days.includes(day)) setDay(days.includes(today) ? today : days[0]); }, [days, day, today]);
  const ws = weekStart(day);
  const week = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const locked = isClosedDay(data, day);
  const owner = isOwnerDay(data, day);
  const n = coverage(data, day);
  const set = (id: string, brush: Brush) => docs.update(sn => ({ ...sn, schedule: paintCell(sn.schedule, id, day, brush) }));
  const nameOf = (id: string) => staff.find(p => p.id === id)?.name || 'сотрудник';

  return (
    <section className={s.block} aria-label="График по дням">
      <div className={s.monthNav} style={{ marginBottom: 10 }}>
        <button type="button" className={s.iconBtn} aria-label="Предыдущая неделя" onClick={() => setDay(addDays(day, -7))}><ChevronLeft size={16} /></button>
        <div className={s.monthTitle} style={{ flex: 1 }}>{dayMonth(week[0])} – {dayMonth(week[6])}</div>
        <button type="button" className={s.iconBtn} aria-label="Следующая неделя" onClick={() => setDay(addDays(day, 7))}><ChevronRight size={16} /></button>
      </div>
      <div className={s.strip} role="group" aria-label="День недели">
        {week.map(d => {
          const c = coverage(data, d);
          return (
            <button key={d} type="button" className={`${s.stripDay} ${d === day ? s.stripOn : ''}`} aria-pressed={d === day} aria-label={`${dayMonth(d)}, в пункте ${c}`} onClick={() => setDay(d)}>
              <small>{WEEKDAYS[weekday(d)].toLowerCase()}</small>
              <b>{Number(d.slice(8))}</b>
              <i className={c ? '' : s.coverZero}>{c}</i>
            </button>
          );
        })}
      </div>
      <h3 style={{ margin: '4px 0 8px', fontSize: 17 }}>{WEEKDAYS[weekday(day)]}, {dayMonth(day)}</h3>
      {!n && <p className={`${s.note} ${s.noteWarn}`}>В пункте никого нет.</p>}
      {locked && <p className={s.note}>Месяц закрыт — изменения недоступны.</p>}
      <div>
        {people.filter(isActive).map(p => {
          const sh = shiftOf(data, day, p.id);
          const kind = brushOf(sh, data);
          const choose = (b: Brush) => set(p.id, b);
          return (
            <div key={p.id} className={s.feedPerson}>
              <div className={s.feedHead}>
                <Avatar person={p} index={staff.indexOf(p)} size={26} />
                {p.name}
                <small>{sh ? describeShift(sh, data, nameOf) : ''}</small>
              </div>
              <div className={s.choice} role="group" aria-label={`Смена ${dayMonth(day)}: ${p.name}`}>
                <button type="button" aria-pressed={!sh} disabled={locked} onClick={() => choose('erase')}>Нет</button>
                <button type="button" aria-pressed={kind === 'full'} disabled={locked} onClick={() => choose('full')}>Смена</button>
                <button type="button" aria-pressed={kind === 'am'} disabled={locked} onClick={() => choose('am')}>Утро</button>
                <button type="button" aria-pressed={kind === 'pm'} disabled={locked} onClick={() => choose('pm')}>Вечер</button>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <input id="st-owner-day" type="checkbox" checked={owner} disabled={locked} onChange={e => docs.update(sn => ({ ...sn, schedule: setOwnerDay(sn.schedule, day, e.target.checked) }))} style={{ width: 22, height: 22, accentColor: 'var(--accent)' }} />
        <label htmlFor="st-owner-day" style={{ fontSize: 14 }}>В этот день работаю сам (смены сотрудников не оплачиваются)</label>
      </div>
      <div className={s.btnRow} style={{ marginTop: 12 }}>
        <Button size="sm" variant="secondary" disabled={!docs.canUndo} onClick={docs.undo}><Undo2 size={16} />Отменить</Button>
      </div>
    </section>
  );
}
