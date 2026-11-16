import type { ReactNode } from 'react';
import { Check, Contrast } from 'lucide-react';
import {
  WEEKDAYS,
  addDays,
  brushOf,
  colorOf,
  dayMonth,
  hoursOf,
  isOwnerDay,
  monthKey,
  monthTitle,
  monthWeeks,
  overLimit,
  shiftsOn,
  shortName,
  todayYmd,
  weekTitle,
  weekday,
  type PaidMarks,
  type ScheduleData,
  type Shift,
  type StaffEntry,
} from '../../../lib/staff-core';
import s from './staff.module.css';

/** Что дописать под именем в клетке, если смена неполная или это замена. */
function shiftNote(sh: Shift, data: ScheduleData): string {
  const kind = brushOf(sh, data);
  const part = kind === 'am' ? 'утро' : kind === 'pm' ? 'вечер' : kind === 'hours' ? hoursOf(sh, data) : '';
  return [part, sh.replaces ? 'замена' : ''].filter(Boolean).join(', ');
}

const PAID_TEXT = { paid: 'оплачено', part: 'оплачено частично', due: '' } as const;

/** Где раскрыть список у дня: нижние недели — вверх, правые дни — от правого края клетки. */
export interface PopPlace {
  up: boolean;
  right: boolean;
}

/**
 * Календарь месяца, как на стене: неделя в строке, в клетке — кто работает.
 * Один и тот же в графике (дни нажимаются, у дня раскрывается список) и в мастере шаблона
 * (показывает, что получится; недели слева отмечаются галочками).
 */
export function MonthCalendar({
  month,
  data,
  staff,
  phone,
  onDay,
  picked,
  paid,
  dim,
  fresh,
  weeks,
  badge,
  popover,
  flagEmpty = true,
  footer,
}: {
  month: string;
  data: ScheduleData;
  staff: StaffEntry[];
  phone: boolean;
  /** нажатие на день; без него календарь только показывает */
  onDay?: (day: string) => void;
  picked?: string;
  /** отметки оплаты по сотрудникам (нет — не показываем, например на ПК без права видеть зарплату) */
  paid?: Record<string, PaidMarks>;
  /** приглушить день (в мастере — неделя не выбрана) */
  dim?: (day: string) => boolean;
  /** смена появится после заполнения (в мастере) */
  fresh?: (day: string, staffId: string) => boolean;
  /** выбор недель слева от строк (в мастере) */
  weeks?: { on: ReadonlySet<string>; toggle: (start: string) => void };
  /** своя метка в углу дня */
  badge?: (day: string) => ReactNode;
  /** что раскрыть под клеткой выбранного дня */
  popover?: { day: string; node: (place: PopPlace) => ReactNode };
  /** помечать ли будущие дни без людей красным пунктиром */
  flagEmpty?: boolean;
  footer?: ReactNode;
}) {
  const today = todayYmd();
  const closed = Boolean(data.closed[month]);
  const rows = monthWeeks(month);
  const maxLines = phone ? 2 : 3;
  const nameOf = (id: string) => staff.find(p => p.id === id)?.name || data.removedNames?.[id] || 'сотрудник';

  return (
    <section className={s.cal} aria-label={`График на ${monthTitle(month).toLowerCase()}`}>
      <div className={`${s.calWeekdays} ${weeks ? s.calWithWeeks : ''}`} aria-hidden="true">
        {weeks && <span />}
        {WEEKDAYS.map((w, i) => <span key={w} className={i >= 5 ? s.calWeekendName : ''}>{w.toLowerCase()}</span>)}
      </div>
      <div className={`${s.calGrid} ${weeks ? s.calWithWeeks : ''}`}>
        {rows.map((week, wi) => {
          const cells = Array.from({ length: 7 }, (_, i) => addDays(week.start, i));
          return [
            weeks && (
              <label key={`w-${week.start}`} className={s.calWeekPick} title={`Неделя ${weekTitle(week.start)}`}>
                <input type="checkbox" checked={weeks.on.has(week.start)} onChange={() => weeks.toggle(week.start)} aria-label={`Заполнить неделю ${weekTitle(week.start)}`} />
              </label>
            ),
            ...cells.map(d => {
              if (monthKey(d) !== month) return <span key={d} />;
              const list = shiftsOn(data, d);
              const owner = isOwnerDay(data, d);
              const empty = !list.length && !owner;
              const over = overLimit(data, d);
              const off = dim?.(d) ?? false;
              const lines = list.slice(0, list.length > maxLines ? maxLines - 1 : maxLines);
              const names = [
                ...list.map(sh => {
                  const note = shiftNote(sh, data);
                  const mark = paid?.[sh.staffId]?.state[d];
                  return `${shortName(nameOf(sh.staffId))}${note ? ` · ${note}` : ''}${mark && PAID_TEXT[mark] ? ` · ${PAID_TEXT[mark]}` : ''}`;
                }),
                ...(owner ? ['владелец'] : []),
              ];
              const alarm = flagEmpty && empty && d >= today && !closed && !off;
              const cls = [
                s.calCell,
                weekday(d) >= 5 && s.calWeekendCell,
                d === today && s.calToday,
                alarm && s.calNobody,
                over && s.calOver,
                d === picked && !phone && s.calPicked,
                off && s.calDim,
                !onDay && s.calStatic,
              ].filter(Boolean).join(' ');
              const label = `${dayMonth(d)}: ${names.length ? names.join(', ') : 'никого нет'}${over ? `, людей больше, чем разрешено: ${list.length}` : ''}`;
              const inner = (
                <>
                  <span className={s.calTop}>
                    <span className={s.calNum}>{Number(d.slice(8))}</span>
                    {over && <span className={s.calBadge}>{list.length} чел.</span>}
                    {badge?.(d)}
                  </span>
                  {lines.map(sh => {
                    const p = staff.find(x => x.id === sh.staffId);
                    const c = p ? colorOf(p, staff.indexOf(p)) : { bg: 'var(--surface-sunken)', fg: 'var(--text)', solid: 'var(--text-muted)' };
                    const note = shiftNote(sh, data);
                    const mark = paid?.[sh.staffId]?.state[d];
                    const isNew = fresh?.(d, sh.staffId) ?? false;
                    return (
                      <span key={sh.staffId} className={`${s.calLine} ${isNew ? s.calFresh : ''}`} style={{ background: c.bg, color: c.fg, ...(isNew ? { outlineColor: c.solid } : {}) }}>
                        <span className={s.calName}>
                          <span>{shortName(nameOf(sh.staffId))}</span>
                          {mark === 'paid' && <Check size={12} strokeWidth={3} aria-hidden="true" className={s.calPaid} />}
                          {mark === 'part' && <Contrast size={12} aria-hidden="true" className={s.calPaid} />}
                        </span>
                        {note && <small>{note}</small>}
                      </span>
                    );
                  })}
                  {list.length > lines.length && <span className={s.calMore}>ещё {list.length - lines.length}</span>}
                  {owner && <span className={s.calLine} style={{ background: 'var(--surface-sunken)', color: 'var(--text)' }}>{phone ? 'Я' : 'Владелец'}</span>}
                  {alarm && <span className={s.calNone}>{phone ? 'никого' : 'никого нет'}</span>}
                </>
              );
              const open = popover?.day === d;
              return (
                <div key={d} className={s.calWrap}>
                  {onDay ? (
                    <button type="button" data-day={d} className={cls} aria-current={d === today ? 'date' : undefined} aria-pressed={d === picked && !phone}
                      aria-haspopup={popover ? 'menu' : undefined} aria-expanded={popover ? open : undefined} aria-label={label} onClick={() => onDay(d)}>
                      {inner}
                    </button>
                  ) : (
                    <div className={cls} role="img" aria-label={label}>{inner}</div>
                  )}
                  {open && popover!.node({ up: rows.length >= 4 && wi >= rows.length - 2, right: weekday(d) >= 4 })}
                </div>
              );
            }),
          ];
        })}
      </div>
      {footer}
    </section>
  );
}
