import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Input, Modal, Table } from '../../../ui';
import { useStaffAll } from '../../../api/staff';
import {
  PALETTE,
  TEMPLATE_LABEL,
  WEEKDAYS,
  addDays,
  dayMonth,
  isActive,
  monthKey,
  monthStart,
  paysShk,
  rateOn,
  removeShift,
  rub,
  shiftOf,
  shkRateOn,
  todayYmd,
  type ScheduleData,
  type StaffEntry,
  type Template,
  type TemplateKind,
} from '../../../lib/staff-core';
import { Avatar, Dropdown, moneyInput, parseMoney } from './parts';
import { normalizeStaff, type StaffDocs } from './useStaffDocs';
import { newStaffId } from './TemplateWizard';
import s from './staff.module.css';

const MODE_OPTIONS: { value: TemplateKind; label: string }[] = [
  { value: 'none', label: 'Расставляю сам' },
  { value: '2/2', label: '2 через 2' },
  { value: '3/3', label: '3 через 3' },
  { value: '1/1', label: 'Через день' },
  { value: '5/2', label: 'Будни' },
  { value: 'weekdays', label: 'По дням недели' },
];

function templateText(t: Template | undefined): string {
  if (!t || t.kind === 'none') return 'расставляю сам';
  if (t.kind === 'weekdays') return `по дням: ${(t.weekdays ?? []).map(i => WEEKDAYS[i].toLowerCase()).join(', ') || 'не выбраны'}`;
  return MODE_OPTIONS.find(m => m.value === t.kind)?.label.toLowerCase() ?? TEMPLATE_LABEL[t.kind];
}

function futureShifts(data: ScheduleData, id: string, from: string): string[] {
  return Object.keys(data.shifts).filter(d => d >= from && shiftOf(data, d, id) && !data.closed[monthKey(d)]).sort();
}

export function PeopleTab({ docs, pointId, onReplace, focusId }: { docs: StaffDocs; pointId: string; onReplace: (from: string) => void; focusId?: string }) {
  const snap = docs.snap!;
  const staff = snap.staff.staff_list;
  const data = snap.schedule;
  const today = todayYmd();
  const [edit, setEdit] = useState<string | 'new' | null>(focusId ?? null);
  const [leaving, setLeaving] = useState<StaffEntry | null>(null);
  const [copying, setCopying] = useState(false);
  const active = staff.filter(isActive);
  const gone = staff.filter(p => !isActive(p));

  const setActive = (p: StaffEntry, on: boolean) => {
    if (!on && futureShifts(data, p.id, addDays(today, 1)).length) {
      setLeaving(p);
      return;
    }
    docs.update(sn => ({ ...sn, staff: { ...sn.staff, staff_list: sn.staff.staff_list.map(x => (x.id === p.id ? { ...x, active: on } : x)) } }));
  };

  return (
    <>
      <div className={s.toolbar}>
        <p className={s.muted} style={{ flex: '1 1 320px' }}>Список сотрудников этого пункта. Человека, который работает в двух пунктах, добавьте в каждый — в «Все пункты» он покажется одной строкой, если совпадает телефон или номер WB.</p>
        <div className={s.toolbarEnd}>
          <Button size="sm" variant="secondary" onClick={() => setCopying(true)}>Взять из другого пункта</Button>
          <Button size="sm" onClick={() => setEdit('new')}><Plus size={16} />Добавить сотрудника</Button>
        </div>
      </div>
      <section className={s.block} style={{ padding: 0 }}>
        {active.length === 0 ? <p className={s.muted} style={{ padding: 16 }}>Работающих сотрудников нет. Добавьте первого.</p> : (
          <Table>
            <thead><tr><th>Сотрудник</th><th>Телефон</th><th>Как платим</th><th>Обычный график</th><th>Работает</th><th /></tr></thead>
            <tbody>
              {active.map(p => {
                const rate = paysShk(p) ? shkRateOn(p, today) || data.shkPrice || 0 : rateOn(p, today);
                return (
                  <tr key={p.id}>
                    <td><span className={s.rowName}><Avatar person={p} index={staff.indexOf(p)} size={28} /><b>{p.name || 'Без имени'}</b></span></td>
                    <td>{p.phone || <span className={s.muted}>—</span>}</td>
                    <td className={!rate ? s.gWarn : ''}>{rate ? `${rub(rate)} ${paysShk(p) ? 'за принятый товар' : 'за смену'}` : 'Ставка не указана'}</td>
                    <td>{templateText(data.templates[p.id])}</td>
                    <td><input type="checkbox" role="switch" aria-label={`${p.name} работает`} checked onChange={e => setActive(p, e.target.checked)} style={{ width: 22, height: 22, accentColor: 'var(--success)' }} /></td>
                    <td className={s.num}><Button size="sm" variant="secondary" onClick={() => setEdit(p.id)}>Изменить</Button></td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>
      {gone.length > 0 && (
        <section className={s.block}>
          <div className={s.blockHead}><h2>Больше не работают</h2></div>
          {gone.map(p => (
            <div key={p.id} className={s.line}>
              <span className={s.rowName} style={{ flexDirection: 'row' }}><Avatar person={p} index={staff.indexOf(p)} size={28} /><span><b>{p.name}</b><small>Прошлые смены и выплаты сохранены.</small></span></span>
              <Button size="sm" variant="secondary" onClick={() => setActive(p, true)}>Вернуть в работу</Button>
            </div>
          ))}
        </section>
      )}
      {edit && <PersonDialog docs={docs} id={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {leaving && (
        <LeaveDialog docs={docs} person={leaving} onClose={() => setLeaving(null)} onReplace={() => { const id = leaving.id; setLeaving(null); onReplace(id); }} />
      )}
      {copying && <CopyDialog docs={docs} pointId={pointId} onClose={() => setCopying(false)} />}
    </>
  );
}

function LeaveDialog({ docs, person, onClose, onReplace }: { docs: StaffDocs; person: StaffEntry; onClose: () => void; onReplace: () => void }) {
  const data = docs.snap!.schedule;
  const days = futureShifts(data, person.id, addDays(todayYmd(), 1));
  const off = (removeFuture: boolean) => {
    docs.update(sn => {
      let sched = sn.schedule;
      if (removeFuture) for (const d of days) sched = removeShift(sched, d, person.id);
      const templates = { ...sched.templates };
      delete templates[person.id];
      return { staff: { ...sn.staff, staff_list: sn.staff.staff_list.map(x => (x.id === person.id ? { ...x, active: false } : x)) }, schedule: { ...sched, templates } };
    });
    onClose();
  };
  return (
    <Modal open onOpenChange={o => !o && onClose()} title={`${person.name} больше не работает?`} description={`Впереди у сотрудника смен: ${days.length} (первая — ${dayMonth(days[0])}). Что с ними сделать?`}>
      <div className={s.form}>
        <p className={s.muted}>Прошлые смены и выплаты останутся. Вернуть сотрудника в работу можно в любой момент.</p>
        <div className={s.dialogActions}>
          <Button variant="secondary" onClick={onClose} className={s.grow}>Отмена</Button>
          <Button variant="secondary" onClick={() => off(true)}>Убрать смены</Button>
          <Button onClick={onReplace}>Передать смены другому</Button>
        </div>
      </div>
    </Modal>
  );
}

function PersonDialog({ docs, id, onClose }: { docs: StaffDocs; id: string | null; onClose: () => void }) {
  const snap = docs.snap!;
  const staff = snap.staff.staff_list;
  const data = snap.schedule;
  const today = todayYmd();
  const old = id ? staff.find(p => p.id === id) : undefined;
  const [name, setName] = useState(old?.name ?? '');
  const [phone, setPhone] = useState(old?.phone ?? '');
  const [sid, setSid] = useState(old?.sid ?? '');
  const [payMode, setPayMode] = useState<'shift' | 'shk'>(old?.payMode === 'shk' ? 'shk' : 'shift');
  const [rates, setRates] = useState(old?.rates ?? []);
  const [shkRates, setShkRates] = useState(old?.shkRates ?? []);
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(old ? today : monthStart(monthKey(today)));
  const [color, setColor] = useState(old?.color ?? staff.length % PALETTE.length);
  const [tpl, setTpl] = useState<Template>(old ? data.templates[old.id] ?? { kind: 'none', start: monthStart(monthKey(today)) } : { kind: 'none', start: monthStart(monthKey(today)) });
  const [err, setErr] = useState('');
  const list = payMode === 'shk' ? shkRates : rates;
  const current = list.length ? [...list].sort((a, b) => a.from.localeCompare(b.from)).filter(r => r.from <= today).pop() ?? null : null;
  const hasRecords = old ? (data.payments ?? []).some(x => x.staffId === old.id) || data.adjustments.some(x => x.staffId === old.id) || (data.deductions ?? []).some(d => d.assign?.type === 'staff' ? d.assign.id === old.id : d.assign?.type === 'split' ? d.assign.ids.includes(old.id) : false) : false;
  const shiftsCount = old ? Object.values(data.shifts).filter(l => l.some(x => x.staffId === old.id)).length : 0;

  const addRate = () => {
    const a = parseMoney(amount);
    if (!a || a <= 0) return setErr('Укажите сумму');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return setErr('Укажите дату');
    const next = [...list.filter(r => r.from !== from), { from, rate: a }].sort((x, y) => x.from.localeCompare(y.from));
    if (payMode === 'shk') setShkRates(next); else setRates(next);
    setAmount('');
    setErr('');
  };

  const save = () => {
    if (!name.trim()) return setErr('Напишите имя');
    let r = rates, sr = shkRates;
    const a = parseMoney(amount);
    if (a && a > 0) {
      const next = [...list.filter(x => x.from !== from), { from, rate: a }].sort((x, y) => x.from.localeCompare(y.from));
      if (payMode === 'shk') sr = next; else r = next;
    }
    const entry: StaffEntry = {
      ...(old ?? { id: newStaffId(), last4: '', sid: '', phone: '', name: '' }),
      name: name.trim(),
      phone: phone.trim(),
      sid: sid.replace(/\D/g, ''),
      color,
      payMode,
    };
    if (r.length) entry.rates = r; else delete entry.rates;
    if (sr.length) entry.shkRates = sr; else delete entry.shkRates;
    docs.update(sn => {
      const listNow = sn.staff.staff_list;
      const staffList = old ? listNow.map(x => (x.id === old.id ? entry : x)) : [...listNow, entry];
      const templates = { ...sn.schedule.templates };
      if (tpl.kind === 'none') delete templates[entry.id]; else templates[entry.id] = tpl;
      return { staff: { ...sn.staff, staff_list: staffList }, schedule: { ...sn.schedule, templates } };
    });
    onClose();
  };

  const remove = () => {
    if (!old) return;
    docs.update(sn => {
      const templates = { ...sn.schedule.templates };
      delete templates[old.id];
      // прошлые смены остаются с именем — как в программе
      return {
        staff: { ...sn.staff, staff_list: sn.staff.staff_list.filter(x => x.id !== old.id) },
        schedule: { ...sn.schedule, templates, removedNames: { ...(sn.schedule.removedNames ?? {}), [old.id]: old.name } },
      };
    });
    onClose();
  };

  return (
    <Modal open onOpenChange={o => !o && onClose()} size="lg" title={old ? old.name || 'Сотрудник' : 'Новый сотрудник'} description={old ? 'Изменения сохранятся на сервере и дойдут до программы на компьютере пункта.' : 'Достаточно имени и ставки, остальное можно добавить позже.'}>
      <div className={s.form}>
        <div className={s.formGrid}>
          <div className={s.wide}><label className={s.label} htmlFor="pp-name">Имя и фамилия</label><Input id="pp-name" value={name} onChange={e => setName(e.target.value)} style={{ marginTop: 6 }} /></div>
          <div><label className={s.label} htmlFor="pp-phone">Телефон</label><Input id="pp-phone" type="tel" value={phone} onChange={e => setPhone(e.target.value)} style={{ marginTop: 6 }} /></div>
          <div><label className={s.label} htmlFor="pp-sid">Номер в WB, если есть</label><Input id="pp-sid" inputMode="numeric" placeholder="не указан" value={sid} onChange={e => setSid(e.target.value)} style={{ marginTop: 6 }} /></div>
        </div>
        <p className={s.muted}>Номер в WB нужен программе, чтобы отличать товары самого сотрудника от клиентских. Можно не заполнять.</p>

        <div>
          <div className={s.label} style={{ marginBottom: 6 }}>Как платим</div>
          <div className={s.choiceGrid} role="group" aria-label="Как платим">
            <button type="button" aria-pressed={payMode === 'shift'} onClick={() => setPayMode('shift')}>За смену</button>
            <button type="button" aria-pressed={payMode === 'shk'} onClick={() => setPayMode('shk')}>За принятые товары</button>
          </div>
        </div>
        <div className={s.formGrid}>
          <div><label className={s.label} htmlFor="pp-rate">{payMode === 'shk' ? 'Цена за принятый товар, ₽' : 'Ставка за смену, ₽'}</label><Input id="pp-rate" inputMode="decimal" placeholder={current ? `сейчас ${moneyInput(current.rate)}` : payMode === 'shk' && data.shkPrice ? `общая цена ${moneyInput(data.shkPrice)}` : 'например, 2 000'} value={amount} onChange={e => setAmount(e.target.value)} style={{ marginTop: 6 }} /></div>
          <div><label className={s.label} htmlFor="pp-from">Действует с</label><Input id="pp-from" type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ marginTop: 6 }} /></div>
        </div>
        {amount && <div><Button size="sm" variant="secondary" onClick={addRate}>Добавить в историю ставок</Button></div>}
        {list.length > 0 && (
          <div className={s.lines}>
            {[...list].sort((a, b) => b.from.localeCompare(a.from)).map(r => (
              <div key={r.from} className={s.line}>
                <span>с {dayMonth(r.from)} {r.from.slice(0, 4)}{current?.from === r.from && <small>действует сейчас</small>}</span>
                <b>{rub(r.rate)}</b>
                <button type="button" className={s.iconBtn} aria-label={`Удалить ставку с ${dayMonth(r.from)}`} onClick={() => (payMode === 'shk' ? setShkRates(list.filter(x => x.from !== r.from)) : setRates(list.filter(x => x.from !== r.from)))}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        )}
        <p className={`${s.note} ${!current && !amount && !(payMode === 'shk' && data.shkPrice) ? s.noteWarn : ''}`}>
          {!current && !amount && !(payMode === 'shk' && data.shkPrice)
            ? 'Ставка не указана, поэтому смены этого сотрудника пока не оплачиваются.'
            : 'Когда ставка меняется, добавьте новую с нужной даты: прошлые смены посчитаются по прежней.'}
        </p>

        <div>
          <label className={s.label} htmlFor="pp-tpl">Обычный график</label>
          <div style={{ marginTop: 6 }}><Dropdown id="pp-tpl" label="Обычный график" value={tpl.kind} onChange={k => setTpl(t => ({ ...t, kind: k, weekdays: k === 'weekdays' ? t.weekdays ?? [5, 6] : t.weekdays }))} options={MODE_OPTIONS} up /></div>
          {tpl.kind === 'weekdays' && (
            <div className={s.weekdayChips} style={{ marginTop: 8 }} role="group" aria-label="Рабочие дни недели">
              {WEEKDAYS.map((w, k) => {
                const on = (tpl.weekdays ?? []).includes(k);
                return <button key={w} type="button" aria-pressed={on} onClick={() => setTpl(t => ({ ...t, weekdays: on ? (t.weekdays ?? []).filter(x => x !== k) : [...(t.weekdays ?? []), k].sort() }))}>{w.toLowerCase()}</button>;
              })}
            </div>
          )}
          {['2/2', '3/3', '1/1'].includes(tpl.kind) && (
            <div style={{ marginTop: 8 }}><label className={s.label} htmlFor="pp-start">Первый рабочий день цикла</label><Input id="pp-start" type="date" value={tpl.start} onChange={e => setTpl(t => ({ ...t, start: e.target.value }))} style={{ marginTop: 6, maxWidth: 220 }} /></div>
          )}
          <p className={s.muted} style={{ marginTop: 6 }}>По обычному графику работает «Заполнить по шаблону» и автопродление на следующий месяц.</p>
        </div>

        <div>
          <div className={s.label} style={{ marginBottom: 6 }}>Цвет в табеле</div>
          <div className={s.pills} role="radiogroup" aria-label="Цвет в табеле">
            {PALETTE.map((c, i) => (
              <button key={i} type="button" role="radio" aria-checked={color === i} aria-label={`Цвет ${i + 1}`} onClick={() => setColor(i)} style={{ width: 36, height: 36, borderRadius: 999, background: c.solid, border: color === i ? '3px solid var(--text)' : '3px solid transparent', cursor: 'pointer' }} />
            ))}
          </div>
        </div>

        {err && <p className={`${s.note} ${s.noteWarn}`} role="alert">{err}</p>}
        <div className={s.dialogActions}>
          {old && (hasRecords
            ? <span className={`${s.muted} ${s.grow}`}>Удалить нельзя: у сотрудника есть выплаты или удержания. Снимите галочку «Работает».</span>
            : <Button variant="ghost" className={s.grow} onClick={remove}>Удалить{shiftsCount ? ` (смены останутся с именем)` : ''}</Button>)}
          <Button variant="secondary" onClick={onClose}>Отмена</Button>
          <Button onClick={save}>{old ? 'Сохранить' : 'Добавить сотрудника'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function CopyDialog({ docs, pointId, onClose }: { docs: StaffDocs; pointId: string; onClose: () => void }) {
  const all = useStaffAll(true);
  const mine = docs.snap!.staff.staff_list;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const digits = (v: string) => v.replace(/\D/g, '');
  const others = useMemo(() => (all.data?.points ?? []).filter(p => p.point.id !== pointId).map(p => ({ point: p.point, staff: normalizeStaff(p.staff?.data).staff_list.filter(isActive) })).filter(p => p.staff.length), [all.data, pointId]);
  const already = (p: StaffEntry) => mine.some(m => (digits(m.phone).length >= 10 && digits(m.phone).slice(-10) === digits(p.phone).slice(-10)) || (digits(m.sid) && digits(m.sid) === digits(p.sid)) || m.name.trim().toLowerCase() === p.name.trim().toLowerCase());

  const copy = () => {
    const chosen = others.flatMap(o => o.staff.map(p => ({ key: `${o.point.id}:${p.id}`, p }))).filter(x => picked.has(x.key));
    docs.update(sn => ({
      ...sn,
      staff: {
        ...sn.staff,
        staff_list: [
          ...sn.staff.staff_list,
          // своя запись в этом пункте: ставка может отличаться, смены и выплаты ведутся отдельно
          ...chosen.map(({ p }, i) => ({ id: newStaffId(), name: p.name, last4: p.last4 ?? '', sid: p.sid ?? '', phone: p.phone ?? '', color: (sn.staff.staff_list.length + i) % PALETTE.length, ...(p.payMode ? { payMode: p.payMode } : {}), ...(p.rates ? { rates: p.rates } : {}), ...(p.shkRates ? { shkRates: p.shkRates } : {}) })),
        ],
      },
    }));
    onClose();
  };

  return (
    <Modal open onOpenChange={o => !o && onClose()} title="Взять людей из другого пункта" description="В этом пункте появится своя запись сотрудника с той же ставкой. Смены и выплаты пунктов ведутся отдельно.">
      <div className={s.form}>
        {all.isPending ? <p className={s.muted}>Загружаем другие пункты…</p> : all.isError ? <p className={`${s.note} ${s.noteWarn}`}>Не удалось загрузить другие пункты. <Button size="sm" variant="ghost" onClick={() => all.refetch()}>Повторить</Button></p> : !others.length ? <p className={s.note}>В других пунктах нет работающих сотрудников.</p> : (
          others.map(o => (
            <div key={o.point.id}>
              <div className={s.label} style={{ marginBottom: 6 }}>{o.point.name}</div>
              {o.staff.map(p => {
                const key = `${o.point.id}:${p.id}`;
                const dup = already(p);
                return (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                    <input id={`cp-${key}`} type="checkbox" disabled={dup} checked={picked.has(key)} onChange={e => setPicked(x => { const n = new Set(x); if (e.target.checked) n.add(key); else n.delete(key); return n; })} style={{ width: 20, height: 20, accentColor: 'var(--accent)' }} />
                    <label htmlFor={`cp-${key}`} style={{ fontSize: 14 }}>{p.name}{dup && <span className={s.muted}> — уже есть в этом пункте</span>}</label>
                  </div>
                );
              })}
            </div>
          ))
        )}
        <div className={s.dialogActions}><Button variant="secondary" onClick={onClose}>Отмена</Button><Button disabled={!picked.size} onClick={copy}>Добавить: {picked.size}</Button></div>
      </div>
    </Modal>
  );
}
