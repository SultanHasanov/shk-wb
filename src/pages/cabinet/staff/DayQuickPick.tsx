import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { Button } from '../../../ui';
import {
  clearDay,
  dayMonth,
  isActive,
  isOwnerDay,
  maxPerDay,
  paintCell,
  quickToggle,
  removeShift,
  setOwnerDay,
  shiftOf,
  shiftsOn,
  type ScheduleData,
} from '../../../lib/staff-core';
import { Avatar } from './parts';
import type { PopPlace } from './MonthCalendar';
import type { StaffDocs } from './useStaffDocs';
import s from './staff.module.css';

type Ask = { kind: 'person'; id: string; working: string[] } | { kind: 'owner' } | null;

/**
 * Быстрый список у дня: кто работает. Нажатие на имя ставит полную смену, повторное — убирает.
 * Если в пункте работает один человек в день, выбор другого имени сразу меняет человека (вернуть — «Отменить»).
 * Полсмены, свои часы и замены остаются в панели дня.
 *
 * На компьютере раскрывается под клеткой календаря; на телефоне встроен в окно дня (`inline`).
 */
export function DayQuickPick({ docs, day, onClose, place, inline = false }: {
  docs: StaffDocs;
  day: string;
  /** focus — вернуть фокус на клетку дня (закрыли с клавиатуры или выбрали) */
  onClose: (focus: boolean) => void;
  place?: PopPlace;
  inline?: boolean;
}) {
  const snap = docs.snap!;
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const limit = maxPerDay(data);
  const single = limit === 1;
  const working = shiftsOn(data, day);
  const owner = isOwnerDay(data, day);
  const people = staff.filter(p => isActive(p) || shiftOf(data, day, p.id));
  const [ask, setAsk] = useState<Ask>(null);
  const root = useRef<HTMLDivElement>(null);
  const nameOf = (id: string) => staff.find(p => p.id === id)?.name || data.removedNames?.[id] || 'сотрудник';
  const short = (id: string) => nameOf(id).split(/\s+/)[0];
  const sched = (fn: (d: ScheduleData) => ScheduleData) => docs.update(sn => ({ ...sn, schedule: fn(sn.schedule) }));
  const done = () => { setAsk(null); if (single && !inline) onClose(true); };

  // закрыть кликом мимо списка и клетки, под которой он раскрыт
  useEffect(() => {
    if (inline) return;
    const onDown = (e: PointerEvent) => {
      const wrap = root.current?.parentElement;
      if (wrap && !wrap.contains(e.target as Node)) onClose(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [inline, onClose]);

  // с клавиатуры: фокус сразу в список, на отмеченного
  useEffect(() => {
    if (inline) return;
    const items = root.current?.querySelectorAll<HTMLButtonElement>('[data-item]');
    const first = [...(items ?? [])].find(x => x.getAttribute('aria-checked') === 'true') ?? items?.[0];
    first?.focus({ preventScroll: true });
  }, [inline, day]);

  const pick = (id: string) => {
    const r = quickToggle(data, id, day);
    if (r.kind === 'ask') return setAsk({ kind: 'person', id, working: r.working });
    sched(d => { const again = quickToggle(d, id, day); return again.kind === 'done' ? again.data : d; });
    done();
  };
  const toggleOwner = () => {
    if (owner) { sched(d => setOwnerDay(d, day, false)); return done(); }
    if (working.length) return setAsk({ kind: 'owner' });
    sched(d => setOwnerDay(d, day, true));
    done();
  };

  const onKey = (e: KeyboardEvent) => {
    if (inline) return;
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-item]:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => { e.preventDefault(); items[Math.max(0, Math.min(items.length - 1, i))]?.focus(); };
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); }
    else if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Tab') onClose(false);
  };

  const cls = inline ? s.quickInline : [s.quick, place?.up && s.quickUp, place?.right && s.quickRight].filter(Boolean).join(' ');
  const more = working.length + 1 === 2 ? 'двоих' : 'троих';

  return (
    <div ref={root} className={cls} role="menu" aria-label={`Кто работает ${dayMonth(day)}`} onKeyDown={onKey}>
      <p className={s.quickHead}>
        <b>{inline ? 'Кто работает' : dayMonth(day)}</b>
        <span>{single ? 'один человек в день' : `до ${limit} человек в день`}</span>
      </p>
      {people.map(p => {
        const on = Boolean(shiftOf(data, day, p.id));
        return (
          <button key={p.id} type="button" data-item role={single ? 'menuitemradio' : 'menuitemcheckbox'} aria-checked={on} className={`${s.quickItem} ${on ? s.quickOn : ''}`} onClick={() => pick(p.id)}>
            <Avatar person={p} index={staff.indexOf(p)} size={24} />
            <span>{p.name || 'Без имени'}</span>
            {on && <Check size={16} aria-hidden="true" />}
          </button>
        );
      })}
      <button type="button" data-item role={single ? 'menuitemradio' : 'menuitemcheckbox'} aria-checked={owner} className={`${s.quickItem} ${owner ? s.quickOn : ''}`} onClick={toggleOwner}>
        <span className={s.avatar} aria-hidden="true" style={{ width: 24, height: 24, background: 'var(--surface-sunken)', color: 'var(--text)', fontSize: 10 }}>Я</span>
        <span>Я сам</span>
        {owner && <Check size={16} aria-hidden="true" />}
      </button>

      {ask?.kind === 'person' && (
        <div className={s.dayWarn} role="alert">
          <p>
            В этот день уже {ask.working.length === 1 ? 'работает' : 'работают'}: {ask.working.map(short).join(', ')}.
            В настройках указано, что в пункте {single ? 'работает один человек' : `работают не больше ${limit}`} в день.
          </p>
          <div className={s.dayWarnActions}>
            {ask.working.map(w => (
              <Button key={w} size="sm" onClick={() => { sched(d => paintCell(removeShift(d, day, w), ask.id, day, 'full')); done(); }}>Поставить вместо: {short(w)}</Button>
            ))}
            {ask.working.length < 3 && (
              <Button size="sm" variant="secondary" onClick={() => { sched(d => paintCell({ ...d, maxPerDay: Math.min(3, ask.working.length + 1) }, ask.id, day, 'full')); setAsk(null); }}>Разрешить {more} в день</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setAsk(null)}>Отмена</Button>
          </div>
        </div>
      )}
      {ask?.kind === 'owner' && (
        <div className={s.dayWarn} role="alert">
          <p>Если в этот день работаете вы, смены сотрудников ({working.map(x => short(x.staffId)).join(', ')}) будут сняты: за день владельца зарплата не начисляется.</p>
          <div className={s.dayWarnActions}>
            <Button size="sm" onClick={() => { sched(d => setOwnerDay(d, day, true)); done(); }}>Да, работаю сам</Button>
            <Button size="sm" variant="ghost" onClick={() => setAsk(null)}>Отмена</Button>
          </div>
        </div>
      )}

      <button type="button" data-item role="menuitem" className={`${s.quickItem} ${s.quickClear}`} disabled={!working.length && !owner} onClick={() => { sched(d => clearDay(d, day)); done(); }}>
        Убрать всех
      </button>
      {!inline && <p className={s.quickFoot}>Полсмены, свои часы и замена — в панели справа.</p>}
    </div>
  );
}
