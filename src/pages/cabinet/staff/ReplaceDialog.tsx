import { useMemo, useState } from 'react';
import { Button, Input, Modal } from '../../../ui';
import {
  addDays,
  dayMonth,
  isActive,
  monthEnd,
  monthKey,
  paysShk,
  range,
  rateOn,
  rub,
  shiftOf,
  shiftValue,
  swapShifts,
  todayYmd,
  transferShifts,
  weekStart,
} from '../../../lib/staff-core';
import { Dropdown } from './parts';
import type { StaffDocs } from './useStaffDocs';
import s from './staff.module.css';

/** Замена на период — одно окно вместо трёх инструментов программы: передать смены или поменять местами. */
export function ReplaceDialog({ docs, onClose, from: initialFrom, day }: { docs: StaffDocs; onClose: () => void; from?: string; day?: string }) {
  const data = docs.snap!.schedule;
  const staff = docs.snap!.staff.staff_list;
  const active = staff.filter(isActive);
  const today = todayYmd();
  const start = day ?? today;
  const [mode, setMode] = useState<'transfer' | 'swap'>('transfer');
  const [from, setFrom] = useState(initialFrom ?? active[0]?.id ?? '');
  const [to, setTo] = useState(active.find(p => p.id !== (initialFrom ?? active[0]?.id))?.id ?? '');
  const [d1, setD1] = useState(start);
  const [d2, setD2] = useState(addDays(weekStart(start), 6) < start ? start : addDays(weekStart(start), 6));
  const [mark, setMark] = useState(true);
  const nameOf = (id: string) => staff.find(p => p.id === id)?.name || 'сотрудник';
  const short = (id: string) => nameOf(id).split(/\s+/)[0];

  const days = useMemo(() => (d1 && d2 && d1 <= d2 && range(d1, d2).length <= 400 ? range(d1, d2) : []), [d1, d2]);
  const result = useMemo(() => {
    if (!from || !to || from === to || !days.length) return null;
    return mode === 'transfer' ? transferShifts(data, from, to, days, mark) : swapShifts(data, from, to, days);
  }, [data, from, to, days, mode, mark]);

  const money = (id: string, d: typeof data) => {
    const p = staff.find(x => x.id === id);
    if (!p || paysShk(p)) return 0;
    return days.reduce((a, day) => {
      const sh = shiftOf(d, day, id);
      return a + (sh ? shiftValue(sh, d) * rateOn(p, day) : 0);
    }, 0);
  };
  const diff = result ? Math.round(money(to, result.data) - money(to, data)) : 0;
  const numbers = (list: string[]) => list.map(d => Number(d.slice(8))).join(', ');
  const options = active.map(p => ({ value: p.id, label: p.name }));
  const quick = [
    { label: 'Эта неделя', a: today, b: addDays(weekStart(today), 6) },
    { label: 'Следующая неделя', a: addDays(weekStart(today), 7), b: addDays(weekStart(today), 13) },
    { label: 'До конца месяца', a: today, b: monthEnd(monthKey(today)) },
  ];

  const apply = () => {
    if (!result) return;
    docs.update(sn => ({ ...sn, schedule: mode === 'transfer' ? transferShifts(sn.schedule, from, to, days, mark).data : swapShifts(sn.schedule, from, to, days).data }));
    onClose();
  };

  return (
    <Modal open onOpenChange={o => !o && onClose()} size="lg" title="Замена на период" description="Отпуск, больничный или увольнение: передайте смены за нужные дни одним действием.">
      <div className={s.form}>
        <div className={s.choiceGrid} role="group" aria-label="Что сделать">
          <button type="button" aria-pressed={mode === 'transfer'} onClick={() => setMode('transfer')}>Передать смены — один выходит вместо другого</button>
          <button type="button" aria-pressed={mode === 'swap'} onClick={() => setMode('swap')}>Поменять местами — двое обмениваются сменами</button>
        </div>
        <div className={s.formGrid}>
          <div>
            <label className={s.label} htmlFor="rp-from">{mode === 'transfer' ? 'Чьи смены' : 'Первый сотрудник'}</label>
            <div style={{ marginTop: 6 }}><Dropdown id="rp-from" label="Чьи смены" value={from} onChange={setFrom} options={options} /></div>
          </div>
          <div>
            <label className={s.label} htmlFor="rp-to">{mode === 'transfer' ? 'Кто выйдет вместо' : 'Второй сотрудник'}</label>
            <div style={{ marginTop: 6 }}><Dropdown id="rp-to" label="Кто выйдет вместо" value={to} onChange={setTo} options={options.filter(o => o.value !== from)} /></div>
          </div>
          <div>
            <label className={s.label} htmlFor="rp-d1">С какого дня</label>
            <Input id="rp-d1" type="date" value={d1} onChange={e => setD1(e.target.value)} style={{ marginTop: 6 }} />
          </div>
          <div>
            <label className={s.label} htmlFor="rp-d2">По какой день</label>
            <Input id="rp-d2" type="date" value={d2} min={d1} onChange={e => setD2(e.target.value)} style={{ marginTop: 6 }} />
          </div>
        </div>
        <div className={s.pills}>
          {quick.map(q => (
            <button key={q.label} type="button" className={s.pill} aria-pressed={d1 === q.a && d2 === q.b} onClick={() => { setD1(q.a); setD2(q.b); }}>{q.label}</button>
          ))}
        </div>
        {mode === 'transfer' && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <input id="rp-mark" type="checkbox" checked={mark} onChange={e => setMark(e.target.checked)} style={{ width: 20, height: 20, margin: '1px 0 0', accentColor: 'var(--accent)' }} />
            <label htmlFor="rp-mark" style={{ fontSize: 14, lineHeight: 1.45 }}>Показывать в табеле пометку «за {short(from) || '…'}»</label>
          </div>
        )}
        <p className={`${s.note} ${result && !result.moved.length ? s.noteWarn : ''}`}>
          {!from || !to || from === to ? 'Выберите двух разных сотрудников.'
            : !days.length ? 'Проверьте даты: «по» не раньше «с».'
            : !result?.moved.length ? `У сотрудника «${nameOf(from)}» в эти дни нет смен${mode === 'swap' ? `, как и у «${nameOf(to)}»` : ''}.`
            : mode === 'transfer'
              ? `К сотруднику «${nameOf(to)}» перейдут смены: ${result.moved.length} (${numbers(result.moved)} ${dayMonth(result.moved[result.moved.length - 1]).replace(/^\d+ /, '')}).${diff ? ` Ему начислится на ${rub(diff)} больше.` : ''}`
              : `Поменяются дни: ${numbers(result.moved)}.`}
          {result?.skipped.length ? ` Пропущены: ${numbers(result.skipped)} — у второго уже есть смена или месяц закрыт.` : ''}
        </p>
        <div className={s.dialogActions}>
          <span className={`${s.muted} ${s.grow}`}>Передумали — нажмите «Отменить» над табелем.</span>
          <Button variant="secondary" onClick={onClose}>Отмена</Button>
          <Button onClick={apply} disabled={!result?.moved.length}>
            {mode === 'transfer' ? `Передать смены${result?.moved.length ? `: ${result.moved.length}` : ''}` : 'Поменять местами'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
