import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Input } from '../../../ui';
import {
  addDays,
  brushOf,
  dayMonth,
  hoursOf,
  isActive,
  isClosedDay,
  isOwnerDay,
  maxPerDay,
  paintCell,
  paysShk,
  rateOn,
  removeShift,
  replaceShift,
  rub,
  secondHalf,
  setOwnerDay,
  setShkCount,
  shiftOf,
  shiftValue,
  shiftsOn,
  shkCountOn,
  todayYmd,
  undoReplace,
  weekday,
  type Brush,
  type ScheduleData,
} from '../../../lib/staff-core';
import { Avatar, Dropdown, parseClock } from './parts';
import type { StaffDocs } from './useStaffDocs';
import s from './staff.module.css';

type Kind = 'off' | Exclude<Brush, 'erase'>;
const WD_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const clock = (t: string) => t.replace(/^0(\d)/, '$1');

function kindOptions(data: ScheduleData): { value: Kind; label: string }[] {
  const half = secondHalf(data);
  return [
    { value: 'off', label: 'Не работает' },
    { value: 'full', label: `Смена, ${hoursOf({ staffId: '', kind: 'full' }, data)}` },
    { value: 'am', label: `Полсмены утром, ${hoursOf({ staffId: '', kind: 'half' }, data)}` },
    { value: 'pm', label: `Полсмены вечером, ${clock(half.from)}–${clock(half.to)}` },
    { value: 'hours', label: 'Свои часы' },
  ];
}

/**
 * Один день пункта: кто работает и как. У каждого сотрудника — список «Не работает / Смена / Полсмены / Свои часы»,
 * поэтому сразу видно и что стоит, и как это поменять. Справа от календаря на компьютере, окном — на телефоне.
 *
 * В пункте по умолчанию работает один человек в день (настройка `maxPerDay`): второго поставить нельзя,
 * панель предлагает заменить того, кто уже стоит, или разрешить двоих.
 */
export function DayPanel({ docs, day, onDay }: { docs: StaffDocs; day: string; onDay: (day: string) => void }) {
  const snap = docs.snap!;
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const today = todayYmd();
  const locked = isClosedDay(data, day);
  const owner = isOwnerDay(data, day);
  const working = shiftsOn(data, day);
  const limit = maxPerDay(data);
  const people = staff.filter(p => isActive(p) || shiftOf(data, day, p.id));
  const options = kindOptions(data);
  const [pending, setPending] = useState<{ id: string; kind: Exclude<Kind, 'off'> } | null>(null);
  const [ownerAsk, setOwnerAsk] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [hours, setHours] = useState<Record<string, { from: string; to: string }>>({});
  const nameOf = (id: string) => staff.find(p => p.id === id)?.name || data.removedNames?.[id] || 'сотрудник';
  const short = (id: string) => nameOf(id).split(/\s+/)[0];
  const sched = (fn: (d: ScheduleData) => ScheduleData) => docs.update(sn => ({ ...sn, schedule: fn(sn.schedule) }));

  const hoursFor = (id: string) => {
    const sh = shiftOf(data, day, id);
    const own = sh?.kind === 'custom' && brushOf(sh, data) === 'hours' ? { from: sh.from!, to: sh.to! } : { from: '10:00', to: '18:00' };
    const typed = hours[id];
    const from = typed ? parseClock(typed.from) : null;
    const to = typed ? parseClock(typed.to) : null;
    return from && to && from < to ? { from, to } : own;
  };

  const put = (id: string, kind: Exclude<Kind, 'off'>, before?: (d: ScheduleData) => ScheduleData) =>
    sched(d => paintCell(before ? before(d) : d, id, day, kind, hoursFor(id)));

  const choose = (id: string, kind: Kind) => {
    setPending(null);
    setReplacing(null);
    if (kind === 'off') return sched(d => paintCell(d, id, day, 'erase'));
    const others = working.filter(x => x.staffId !== id);
    if (!shiftOf(data, day, id) && others.length >= limit) return setPending({ id, kind });
    put(id, kind);
  };

  const commitHours = (id: string) => {
    const t = hours[id];
    if (!t) return;
    const from = parseClock(t.from), to = parseClock(t.to);
    if (from && to && from < to) sched(d => paintCell(d, id, day, 'hours', { from, to }));
  };

  const dayMoney = working.reduce((a, sh) => {
    const p = staff.find(x => x.id === sh.staffId);
    return a + (p && !paysShk(p) ? shiftValue(sh, data) * rateOn(p, day) : 0);
  }, 0);

  return (
    <section className={s.dayPanel} aria-label={`Смены ${dayMonth(day)}`}>
      <div className={s.dayHead}>
        <button type="button" className={s.iconBtn} aria-label="Предыдущий день" onClick={() => onDay(addDays(day, -1))}><ChevronLeft size={16} /></button>
        <div className={s.dayTitle}>
          <b>{dayMonth(day)}{day === today ? ', сегодня' : ''}</b>
          <small>{WD_FULL[weekday(day)]}</small>
        </div>
        <button type="button" className={s.iconBtn} aria-label="Следующий день" onClick={() => onDay(addDays(day, 1))}><ChevronRight size={16} /></button>
      </div>

      <p className={`${s.dayState} ${!working.length && !owner ? (day >= today ? s.dayStateBad : '') : s.dayStateOk}`} role="status">
        {owner ? 'Работает владелец'
          : working.length ? `В пункте: ${working.map(x => short(x.staffId)).join(', ')}`
          : day >= today ? 'В пункте никого нет — выберите, кто выйдет' : 'В этот день никто не работал'}
      </p>
      {locked && <p className={s.note}>Месяц закрыт — смены этого дня защищены от правок. Открыть месяц можно во вкладке «Зарплата».</p>}

      <div className={s.dayList}>
        {people.map(p => {
          const sh = shiftOf(data, day, p.id);
          const kind: Kind = brushOf(sh, data) ?? 'off';
          const pay = sh && !paysShk(p) ? Math.round(shiftValue(sh, data) * rateOn(p, day)) : 0;
          const free = staff.filter(x => x.id !== p.id && isActive(x) && !shiftOf(data, day, x.id));
          const typed = hours[p.id] ?? (sh?.kind === 'custom' ? { from: clock(sh.from ?? ''), to: clock(sh.to ?? '') } : { from: '10:00', to: '18:00' });
          const goods = shkCountOn(data, p.id, day)?.n;
          return (
            <div key={p.id} className={s.dayRow}>
              <div className={s.dayPerson}>
                <Avatar person={p} index={staff.indexOf(p)} size={28} />
                <b>{p.name || 'Без имени'}</b>
                {sh && <span className={s.dayPay}>{paysShk(p) ? 'по товарам' : pay ? rub(pay) : 'нет ставки'}</span>}
              </div>
              <Dropdown label={`${p.name}: смена ${dayMonth(day)}`} value={kind} disabled={locked} onChange={v => choose(p.id, v)} options={options} />

              {kind === 'hours' && (
                <div className={s.dayHours}>
                  <label htmlFor={`dh-f-${p.id}`}>с</label>
                  <Input id={`dh-f-${p.id}`} className={s.timeInput} inputMode="numeric" disabled={locked} value={typed.from} onChange={e => setHours(h => ({ ...h, [p.id]: { ...typed, from: e.target.value } }))} onBlur={() => commitHours(p.id)} />
                  <label htmlFor={`dh-t-${p.id}`}>до</label>
                  <Input id={`dh-t-${p.id}`} className={s.timeInput} inputMode="numeric" disabled={locked} value={typed.to} onChange={e => setHours(h => ({ ...h, [p.id]: { ...typed, to: e.target.value } }))} onBlur={() => commitHours(p.id)} />
                </div>
              )}

              {sh?.replaces && (
                <p className={s.daySub}>
                  Вышел(ла) вместо: {nameOf(sh.replaces)}.{' '}
                  {!locked && <button type="button" className={s.linkBtn} onClick={() => sched(d => undoReplace(d, day, sh.replaces!))}>Отменить замену</button>}
                </p>
              )}

              {sh && paysShk(p) && day <= today && (
                <div className={s.dayHours}>
                  <label htmlFor={`dg-${p.id}`}>Принято товаров</label>
                  <Input id={`dg-${p.id}`} className={s.timeInput} inputMode="numeric" disabled={locked} placeholder="0" value={goods == null ? '' : String(goods)}
                    style={goods == null ? { borderColor: 'var(--warning)', background: 'var(--warning-soft)' } : undefined}
                    onChange={e => { const t = e.target.value.replace(/\D/g, ''); sched(d => setShkCount(d, p.id, day, t ? Number(t) : null)); }} />
                </div>
              )}

              {sh && !sh.replaces && !locked && free.length > 0 && (
                replacing === p.id ? (
                  <div className={s.dayReplace}>
                    <Dropdown label={`Кто выйдет вместо: ${p.name}`} value="" onChange={by => { if (by) sched(d => replaceShift(d, day, p.id, by)); setReplacing(null); }}
                      options={[{ value: '', label: 'Кто выйдет вместо?' }, ...free.map(x => ({ value: x.id, label: x.name, hint: `смена перейдёт с пометкой «за ${short(p.id)}»` }))]} />
                    <button type="button" className={s.linkBtn} onClick={() => setReplacing(null)}>Отмена</button>
                  </div>
                ) : (
                  <button type="button" className={s.linkBtn} onClick={() => setReplacing(p.id)}>Не может выйти — найти замену</button>
                )
              )}

              {pending?.id === p.id && (
                <div className={s.dayWarn} role="alert">
                  <p>
                    В этот день уже {working.length === 1 ? 'работает' : 'работают'}: {working.map(x => short(x.staffId)).join(', ')}.
                    В настройках указано, что в пункте {limit === 1 ? 'работает один человек' : `работают не больше ${limit}`} в день.
                  </p>
                  <div className={s.dayWarnActions}>
                    {working.map(x => (
                      <Button key={x.staffId} size="sm" onClick={() => { put(p.id, pending.kind, d => removeShift(d, day, x.staffId)); setPending(null); }}>
                        Поставить вместо: {short(x.staffId)}
                      </Button>
                    ))}
                    <Button size="sm" variant="secondary" onClick={() => { put(p.id, pending.kind, d => ({ ...d, maxPerDay: Math.min(3, working.length + 1) })); setPending(null); }}>
                      Разрешить {working.length + 1 === 2 ? 'двоих' : 'троих'} в день
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Отмена</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <div className={s.dayRow}>
          <div className={s.dayPerson}>
            <span className={s.avatar} aria-hidden="true" style={{ width: 28, height: 28, background: '#e9eaf0', color: '#3a3d52', fontSize: 10 }}>Я</span>
            <b>Владелец</b>
            {owner && <span className={s.dayPay}>без оплаты</span>}
          </div>
          <Dropdown label={`Владелец: ${dayMonth(day)}`} value={owner ? 'on' : 'off'} disabled={locked}
            onChange={v => {
              if (v === 'off') return sched(d => setOwnerDay(d, day, false));
              if (working.length) setOwnerAsk(true);
              else sched(d => setOwnerDay(d, day, true));
            }}
            options={[{ value: 'off', label: 'Не работаю' }, { value: 'on', label: 'Работаю сам' }]} />
          {ownerAsk && (
            <div className={s.dayWarn} role="alert">
              <p>Если в этот день работаете вы, смены сотрудников ({working.map(x => short(x.staffId)).join(', ')}) будут сняты: за день владельца зарплата не начисляется.</p>
              <div className={s.dayWarnActions}>
                <Button size="sm" onClick={() => { sched(d => setOwnerDay(d, day, true)); setOwnerAsk(false); }}>Да, работаю сам</Button>
                <Button size="sm" variant="ghost" onClick={() => setOwnerAsk(false)}>Отмена</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {people.length === 0 && <p className={s.note}>В пункте пока нет сотрудников. Добавьте их во вкладке «Люди».</p>}
      {dayMoney > 0 && <p className={s.dayTotal}><span>Зарплата за день</span><b>{rub(dayMoney)}</b></p>}
    </section>
  );
}
