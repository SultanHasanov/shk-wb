import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../../../ui';
import { CabinetError, CabinetLoading } from '../../../components/CabinetState';
import { useStaffAll } from '../../../api/staff';
import {
  PALETTE,
  WEEKDAYS,
  addDays,
  buildOverview,
  dayMonth,
  hoursOf,
  monthKey,
  monthTitle,
  normalizeSchedule,
  pointMoney,
  rub,
  todayYmd,
  unitsText,
  weekStart,
  weekday,
  type PointDocs,
} from '../../../lib/staff-core';
import { normalizeStaff } from './useStaffDocs';
import s from './staff.module.css';

/** «Все пункты»: только просмотр. Щелчок по пункту или дню — переход в график пункта. */
export function AllPoints({ onOpen }: { onOpen: (pointId: string, day?: string) => void }) {
  const all = useStaffAll(true);
  const [start, setStart] = useState(() => weekStart(todayYmd()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);
  const month = monthKey(days[3]);
  const points: PointDocs[] = useMemo(() => (all.data?.points ?? []).map(p => ({
    id: p.point.id,
    name: p.point.name,
    staff: normalizeStaff(p.staff?.data).staff_list,
    schedule: normalizeSchedule(p.schedule?.data),
  })), [all.data]);
  const overview = useMemo(() => buildOverview(points, days), [points, days]);
  const money = useMemo(() => points.map(p => pointMoney(p, month)), [points, month]);
  const look = (pointId: string) => PALETTE[(points.findIndex(p => p.id === pointId) * 3 + 1) % PALETTE.length];
  const nameOf = (pointId: string) => points.find(p => p.id === pointId)?.name ?? 'пункт';

  if (all.isPending) return <CabinetLoading />;
  if (all.isError) return <CabinetError error={all.error} retry={() => all.refetch()} />;

  const empty = points.flatMap(p => days.filter(d => overview.cover[d]?.[p.id] === 0 && d >= todayYmd()).map(d => ({ p, d })));
  const total = money.reduce((a, m) => ({ earned: a.earned + m.earned, paid: a.paid + m.paid, left: a.left + m.left }), { earned: 0, paid: 0, left: 0 });
  const cols = `200px repeat(7, minmax(90px, 1fr)) 80px`;

  return (
    <>
      <div className={s.toolbar}>
        <div className={s.monthNav}>
          <button type="button" className={s.iconBtn} aria-label="Предыдущая неделя" onClick={() => setStart(addDays(start, -7))}><ChevronLeft size={16} /></button>
          <div className={s.monthTitle} style={{ minWidth: 200 }}>{dayMonth(days[0])} – {dayMonth(days[6])}</div>
          <button type="button" className={s.iconBtn} aria-label="Следующая неделя" onClick={() => setStart(addDays(start, 7))}><ChevronRight size={16} /></button>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setStart(weekStart(todayYmd()))}>Эта неделя</Button>
        <span className={s.muted} style={{ marginLeft: 'auto' }}>Здесь только просмотр: чтобы изменить смену, откройте пункт.</span>
      </div>

      <div className={s.stats} style={{ marginBottom: 16 }}>
        {points.map((p, i) => {
          const m = money[i];
          const c = look(p.id);
          return (
            <button key={p.id} type="button" className={s.statBox} onClick={() => onOpen(p.id)} style={{ textAlign: 'left', border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', font: 'inherit' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)', fontWeight: 600, fontSize: 15 }}>
                <i aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 4, background: c.solid }} />{p.name}
              </span>
              <span>{m.people} сотрудников, за {monthTitle(month).toLowerCase()}</span>
              <span>Начислено <b style={{ color: 'var(--text)', fontSize: 14 }}>{rub(m.earned)}</b> · выплачено {rub(m.paid)}</span>
              <span>Осталось <b style={{ color: 'var(--text)', fontSize: 16 }}>{rub(m.left)}</b></span>
            </button>
          );
        })}
        {points.length > 1 && (
          <div className={`${s.statBox} ${s.statAccent}`}>
            <span style={{ color: 'var(--text)', fontWeight: 600, fontSize: 15 }}>Всего за {monthTitle(month).toLowerCase()}</span>
            <span>Начислено <b style={{ color: 'var(--text)', fontSize: 14 }}>{rub(total.earned)}</b> · выплачено {rub(total.paid)}</span>
            <span>Осталось <b style={{ color: 'var(--text)', fontSize: 16 }}>{rub(total.left)}</b></span>
          </div>
        )}
      </div>

      {(overview.conflicts.length > 0 || empty.length > 0) && (
        <div className={s.todo} style={{ marginBottom: 16 }}>
          {overview.conflicts.map(c => (
            <div key={`${c.key}-${c.day}`} className={`${s.todoItem} ${s.todoRed}`}>
              <span className={s.dot} aria-hidden="true" />
              <span>{dayMonth(c.day)} {c.name} стоит сразу в нескольких пунктах: {c.pointIds.map(nameOf).join(' и ')}.</span>
              <button type="button" onClick={() => onOpen(c.pointIds[0], c.day)}>Открыть {dayMonth(c.day)}</button>
            </div>
          ))}
          {points.map(p => {
            const ds = empty.filter(e => e.p.id === p.id).map(e => e.d);
            if (!ds.length) return null;
            return (
              <div key={`e-${p.id}`} className={`${s.todoItem} ${s.todoRed}`}>
                <span className={s.dot} aria-hidden="true" />
                <span>В пункте «{p.name}» никого нет: {ds.map(d => Number(d.slice(8))).join(', ')} {dayMonth(ds[ds.length - 1]).replace(/^\d+ /, '')}.</span>
                <button type="button" onClick={() => onOpen(p.id, ds[0])}>Открыть график пункта</button>
              </div>
            );
          })}
        </div>
      )}

      <section className={s.block}>
        <div className={s.blockHead}><h2>Кто где работает</h2></div>
        {overview.rows.length === 0 ? <p className={s.muted}>На этой неделе смен нет.</p> : (
          <div className={s.gridWrap}>
            <div style={{ minWidth: 960 }}>
              <div className={`${s.gRow} ${s.gHead}`} style={{ gridTemplateColumns: cols, gap: '0 6px' }}>
                <span className={s.muted}>Сотрудник</span>
                {days.map(d => <span key={d} className={s.label} style={{ color: weekday(d) >= 5 ? 'var(--accent-dark)' : undefined }}>{WEEKDAYS[weekday(d)].toLowerCase()}, {Number(d.slice(8))}</span>)}
                <span className={s.muted} style={{ textAlign: 'right' }}>Смен</span>
              </div>
              {overview.rows.map(r => (
                <div key={r.key} className={s.gRow} style={{ gridTemplateColumns: cols, gap: '0 6px', minHeight: 50 }}>
                  <span className={s.gNameText}><b>{r.name}</b><small>{r.points.length > 1 ? 'несколько пунктов' : nameOf(r.points[0])}</small></span>
                  {days.map(d => {
                    const cells = r.cells[d] ?? [];
                    const conflict = new Set(cells.map(c => c.pointId)).size > 1;
                    return (
                      <span key={d} className={`${s.ovCell} ${conflict ? s.ovConflict : ''}`}>
                        {cells.map((c, i) => {
                          const k = look(c.pointId);
                          const p = points.find(x => x.id === c.pointId)!;
                          return <span key={i} className={s.chip} style={{ background: k.bg, color: k.fg, borderColor: k.solid }}>{p.name.split(/[ ,]/)[0]}, {hoursOf(c.shift, p.schedule)}</span>;
                        })}
                      </span>
                    );
                  })}
                  <span className={s.num} style={{ fontWeight: 600 }}>{unitsText(r.units)}</span>
                </div>
              ))}
              {points.map((p, i) => (
                <div key={p.id} className={`${s.gRow} ${i === 0 ? s.gFoot : ''}`} style={{ gridTemplateColumns: cols, gap: '0 6px', minHeight: 34 }}>
                  <span className={s.label}>В пункте: {p.name}</span>
                  {days.map(d => { const n = overview.cover[d]?.[p.id] ?? 0; return <span key={d} className={`${s.cover} ${n ? '' : s.coverZero}`} style={{ justifySelf: 'start' }}>{n}</span>; })}
                  <span />
                </div>
              ))}
            </div>
          </div>
        )}
        <p className={s.muted} style={{ marginTop: 10 }}>Один человек в разных пунктах показан одной строкой, если в карточках совпадает телефон или номер WB.</p>
      </section>
    </>
  );
}
