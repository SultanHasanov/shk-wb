import { useState } from 'react';
import { Button, Input, Modal } from '../../../ui';
import {
  brushOf,
  dayMonth,
  hoursOf,
  isActive,
  paintCell,
  paysShk,
  rateOn,
  replaceShift,
  rub,
  shiftOf,
  shiftValue,
  undoReplace,
  type Brush,
} from '../../../lib/staff-core';
import { Dropdown, parseClock } from './parts';
import type { StaffDocs } from './useStaffDocs';
import s from './staff.module.css';

/** Карточка одной смены: часы, замена, «вышел вместо» — одна и та же для табеля и телефона. */
export function ShiftDialog({ docs, staffId, day, onClose }: { docs: StaffDocs; staffId: string; day: string; onClose: () => void }) {
  const data = docs.snap!.schedule;
  const staff = docs.snap!.staff.staff_list;
  const person = staff.find(p => p.id === staffId)!;
  const sh = shiftOf(data, day, staffId);
  const initial = brushOf(sh, data) ?? 'full';
  const [kind, setKind] = useState<Exclude<Brush, 'erase'>>(initial);
  const [from, setFrom] = useState(sh?.kind === 'custom' && sh.from ? sh.from : '10:00');
  const [to, setTo] = useState(sh?.kind === 'custom' && sh.to ? sh.to : '18:00');
  const [sub, setSub] = useState('');
  const nameOf = (id: string) => staff.find(p => p.id === id)?.name || data.removedNames?.[id] || 'сотрудник';
  const others = staff.filter(p => p.id !== staffId && isActive(p) && !shiftOf(data, day, p.id));
  const short = (n: string) => n.split(/\s+/)[0] || n;
  const hFrom = parseClock(from);
  const hTo = parseClock(to);
  const badHours = kind === 'hours' && (!hFrom || !hTo || hFrom >= hTo);

  const preview = paintCell(data, staffId, day, kind, { from: hFrom ?? '10:00', to: hTo ?? '18:00' });
  const newShift = shiftOf(preview, day, staffId);
  const pay = newShift && !paysShk(person) ? Math.round(shiftValue(newShift, preview) * rateOn(person, day)) : 0;

  const save = () => {
    docs.update(sn => {
      let next = paintCell(sn.schedule, staffId, day, kind, { from: hFrom ?? '10:00', to: hTo ?? '18:00' });
      if (sub) next = replaceShift(next, day, staffId, sub);
      return { ...sn, schedule: next };
    });
    onClose();
  };

  const kinds: { id: Exclude<Brush, 'erase'>; label: string }[] = [
    { id: 'full', label: 'Вся смена' },
    { id: 'am', label: 'Утро' },
    { id: 'pm', label: 'Вечер' },
    { id: 'hours', label: 'Свои часы' },
  ];

  return (
    <Modal open onOpenChange={o => !o && onClose()} title={`${person.name}, ${dayMonth(day)}`} description={sh ? `Сейчас: ${hoursOf(sh, data)}${sh.replaces ? `, за ${nameOf(sh.replaces)}` : ''}` : 'Смены нет'}>
      <div className={s.form}>
        <div>
          <div className={s.label} style={{ marginBottom: 8 }}>Когда работает</div>
          <div className={s.choiceGrid} role="group" aria-label="Тип смены">
            {kinds.map(k => (
              <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.label}</button>
            ))}
          </div>
          {kind === 'hours' && (
            <div className={s.hoursBar}>
              <label htmlFor="sd-from">С</label>
              <Input id="sd-from" className={s.timeInput} value={from} inputMode="numeric" onChange={e => setFrom(e.target.value)} />
              <label htmlFor="sd-to">до</label>
              <Input id="sd-to" className={s.timeInput} value={to} inputMode="numeric" onChange={e => setTo(e.target.value)} />
            </div>
          )}
          <p className={s.muted} style={{ marginTop: 8 }}>
            {badHours ? 'Укажите время: «до» позже, чем «с».' : newShift ? `${hoursOf(newShift, preview)}${paysShk(person) ? ', оплата за принятые товары' : pay ? `, оплата ${rub(pay)}` : ', ставка не указана'}` : ''}
          </p>
        </div>

        {sh?.replaces ? (
          <p className={s.note}>
            {short(person.name)} вышел(ла) вместо сотрудника «{nameOf(sh.replaces)}».{' '}
            <Button size="sm" variant="ghost" onClick={() => { docs.update(sn => ({ ...sn, schedule: undoReplace(sn.schedule, day, sh.replaces!) })); onClose(); }}>
              Отменить замену и вернуть смену
            </Button>
          </p>
        ) : (
          <div>
            <label className={s.label} htmlFor="sd-sub">Кто выйдет вместо</label>
            <div style={{ marginTop: 8 }}>
              <Dropdown
                id="sd-sub"
                label="Кто выйдет вместо"
                value={sub}
                onChange={setSub}
                options={[{ value: '', label: `Никто, ${short(person.name)} работает сам(а)` }, ...others.map(p => ({ value: p.id, label: p.name }))]}
              />
            </div>
            <p className={s.note} style={{ marginTop: 8 }}>
              {sub
                ? `Смена перейдёт к сотруднику «${nameOf(sub)}» с пометкой «за ${short(person.name)}». Оплату за этот день получит тот, кто вышел.`
                : others.length ? 'Замены нет: смену отработает этот сотрудник.' : 'Все остальные в этот день уже на смене или не работают.'}
            </p>
          </div>
        )}

        <div className={s.dialogActions}>
          {sh && (
            <Button variant="ghost" className={s.grow} onClick={() => { docs.update(sn => ({ ...sn, schedule: paintCell(sn.schedule, staffId, day, 'erase') })); onClose(); }}>
              Убрать смену
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>Отмена</Button>
          <Button onClick={save} disabled={badHours}>Сохранить</Button>
        </div>
      </div>
    </Modal>
  );
}
