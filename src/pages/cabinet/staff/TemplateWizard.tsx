import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button, Input, Modal } from '../../../ui';
import {
  WEEKDAYS,
  addDays,
  applyPlan,
  colorOf,
  coverage,
  diffDays,
  isActive,
  monthEnd,
  monthKey,
  monthStart,
  monthTitle,
  paysShk,
  planAutofill,
  range,
  rateOn,
  rub,
  shiftMonth,
  todayYmd,
  weekday,
  worksOn,
  type StaffEntry,
  type Template,
  type TemplateKind,
} from '../../../lib/staff-core';
import { Avatar, Dropdown, parseMoney } from './parts';
import type { StaffDocs } from './useStaffDocs';
import s from './staff.module.css';

type Draft = { key: string; name: string; pay: 'shift' | 'shk'; amount: string };

const MODES: { id: TemplateKind; label: string }[] = [
  { id: '2/2', label: '2 через 2' },
  { id: '3/3', label: '3 через 3' },
  { id: '1/1', label: 'Через день' },
  { id: '5/2', label: 'Будни' },
  { id: 'weekdays', label: 'По дням недели' },
  { id: 'none', label: 'Расставлю сам' },
];
const CYCLE: Partial<Record<TemplateKind, number>> = { '2/2': 4, '3/3': 6, '1/1': 2 };

export function newStaffId(): string {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  return uuid.replace(/-/g, '').slice(0, 12);
}

/** Начало цикла не позже первого дня месяца: иначе дни до него остались бы пустыми. */
function fitStart(start: string, kind: TemplateKind, first: string): string {
  const c = CYCLE[kind];
  if (!c) return start && start <= first ? start : first;
  let st = start || first;
  const shift = ((diffDays(st, first) % c) + c) % c;
  st = addDays(first, -shift);
  return st;
}

/**
 * Мастер графика. Первый шаг (кто работает) — только когда в пункте ещё никого нет; из «Заполнить по шаблону»
 * мастер открывается сразу со второго. Ставит смены только в пустые дни: ручные смены и замены не трогает.
 */
export function TemplateWizard({ docs, month, onClose }: { docs: StaffDocs; month: string; onClose: () => void }) {
  const snap = docs.snap!;
  const data = snap.schedule;
  const existing = snap.staff.staff_list.filter(isActive);
  const withPeople = existing.length === 0;
  const today = todayYmd();
  const [step, setStep] = useState(withPeople ? 1 : 2);
  const [drafts, setDrafts] = useState<Draft[]>([{ key: 'd0', name: '', pay: 'shift', amount: '' }]);
  const [ids] = useState(() => new Map<string, string>());
  const [period, setPeriod] = useState<'rest' | 'month' | 'next'>(month < monthKey(today) ? 'month' : month === monthKey(today) ? 'rest' : 'month');
  const [extend, setExtend] = useState(data.autoExtend || withPeople);

  const people: StaffEntry[] = useMemo(() => {
    if (!withPeople) return existing;
    return drafts.filter(d => d.name.trim()).map((d, i) => {
      if (!ids.has(d.key)) ids.set(d.key, newStaffId());
      const amount = parseMoney(d.amount);
      const from = monthStart(monthKey(today));
      return {
        id: ids.get(d.key)!,
        name: d.name.trim(),
        last4: '',
        sid: '',
        phone: '',
        color: i % 8,
        ...(d.pay === 'shk' ? { payMode: 'shk' as const, ...(amount ? { shkRates: [{ from, rate: amount }] } : {}) } : amount ? { rates: [{ from, rate: amount }] } : {}),
      };
    });
  }, [withPeople, existing, drafts, ids, today]);

  const target = period === 'next' ? shiftMonth(month, 1) : month;
  const first = monthStart(target);
  const [templates, setTemplates] = useState<Record<string, Template>>(() => {
    const out: Record<string, Template> = {};
    for (const p of existing) {
      const t = data.templates[p.id];
      out[p.id] = t ? { ...t, start: fitStart(t.start, t.kind, monthStart(month)) } : { kind: 'none', start: monthStart(month) };
    }
    return out;
  });
  // новым людям «2 через 2» со сдвигом через одного: двое закрывают все дни
  const tpl = (id: string): Template => templates[id] ?? { kind: withPeople ? '2/2' : 'none', start: addDays(monthStart(month), -2 * (Math.max(0, people.findIndex(p => p.id === id)) % 2)) };
  const setTpl = (id: string, t: Partial<Template>) => setTemplates(m => ({ ...m, [id]: { ...tpl(id), ...t } }));

  const from = period === 'rest' ? (today > first ? today : first) : first;
  const to = monthEnd(target);
  const effective = useMemo(() => {
    const out: Record<string, Template> = {};
    for (const p of people) {
      const t = tpl(p.id);
      out[p.id] = { ...t, start: fitStart(t.start, t.kind, first) };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, templates, first]);
  const plan = useMemo(() => planAutofill(data, people, effective, from, to), [data, people, effective, from, to]);
  const after = useMemo(() => applyPlan(data, plan), [data, plan]);
  const monthDays = range(first, to);
  const empty = range(from, to).filter(d => coverage(after, d) === 0).length;
  const fund = plan.added.reduce((a, x) => {
    const p = people.find(pp => pp.id === x.staffId);
    return a + (p && !paysShk(p) ? rateOn(p, x.day) : 0);
  }, 0);

  const finish = () => {
    docs.update(sn => {
      const list = withPeople ? [...sn.staff.staff_list, ...people] : sn.staff.staff_list;
      const nextTemplates = { ...sn.schedule.templates };
      for (const p of people) nextTemplates[p.id] = effective[p.id];
      let sched = applyPlan({ ...sn.schedule, templates: nextTemplates }, planAutofill(sn.schedule, people, effective, from, to));
      sched = { ...sched, autoExtend: extend, ...(extend ? { filledUntil: !sched.filledUntil || sched.filledUntil < to ? to : sched.filledUntil } : {}) };
      return { staff: { ...sn.staff, staff_list: list }, schedule: sched };
    });
    onClose();
  };

  const stepNames = withPeople ? ['Кто работает', 'Как работают', 'Проверьте месяц'] : ['Как работают', 'Проверьте месяц'];
  const stepIndex = withPeople ? step - 1 : step - 2;
  const canNext = step === 1 ? people.length > 0 : true;

  return (
    <Modal open onOpenChange={o => !o && onClose()} size="lg" sheet title={withPeople ? `Соберём график на ${monthTitle(month).toLowerCase()}` : 'Заполнить по шаблону'}
      description={withPeople ? 'Три шага, около двух минут. Всё, что вы укажете, потом можно поправить.' : 'Выберите обычный режим для каждого. Смены встанут только в пустые дни: ручные смены и замены останутся как есть.'}
      footer={
        <div className={s.dialogActions} style={{ width: '100%' }}>
          {step > (withPeople ? 1 : 2) && <Button variant="secondary" onClick={() => setStep(step - 1)}>Назад</Button>}
          <Button variant="ghost" className={s.grow} onClick={onClose}>{withPeople ? 'Пропустить' : 'Отмена'}</Button>
          {step < 3 ? <Button onClick={() => setStep(step + 1)} disabled={!canNext}>Дальше</Button> : <Button onClick={finish} disabled={!people.length}>{withPeople ? 'Создать график' : `Поставить смены: ${plan.added.length}`}</Button>}
        </div>
      }
    >
      <ol className={s.steps} style={{ gridTemplateColumns: `repeat(${stepNames.length}, minmax(0, 1fr))` }}>
        {stepNames.map((n, i) => (
          <li key={n} className={i === stepIndex ? s.stepOn : i < stepIndex ? s.stepDone : ''}><b>{i < stepIndex ? '✓' : i + 1}</b>{n}</li>
        ))}
      </ol>

      {step === 1 && (
        <div className={s.form}>
          <p className={s.muted}>Достаточно имени и того, сколько вы платите. Телефон и остальное можно добавить позже во вкладке «Люди».</p>
          {drafts.map((d, i) => (
            <div key={d.key} className={s.personRow}>
              <Input aria-label={`Имя и фамилия, сотрудник ${i + 1}`} placeholder="Имя и фамилия" value={d.name} onChange={e => setDrafts(list => list.map(x => (x.key === d.key ? { ...x, name: e.target.value } : x)))} />
              <Dropdown label={`Как платим, сотрудник ${i + 1}`} value={d.pay} onChange={v => setDrafts(list => list.map(x => (x.key === d.key ? { ...x, pay: v } : x)))}
                options={[{ value: 'shift', label: 'За смену' }, { value: 'shk', label: 'За принятые товары' }]} />
              <Input aria-label={`Сколько платим, сотрудник ${i + 1}`} inputMode="decimal" placeholder={d.pay === 'shk' ? '₽ за товар' : '₽ за смену'} value={d.amount} onChange={e => setDrafts(list => list.map(x => (x.key === d.key ? { ...x, amount: e.target.value } : x)))} />
              <button type="button" className={s.iconBtn} style={{ width: 44, height: 44 }} aria-label={`Убрать сотрудника ${i + 1}`} disabled={drafts.length === 1} onClick={() => setDrafts(list => list.filter(x => x.key !== d.key))}><X size={16} /></button>
            </div>
          ))}
          <div><Button variant="secondary" onClick={() => setDrafts(list => [...list, { key: `d${Date.now()}`, name: '', pay: 'shift', amount: '' }])}><Plus size={16} />Добавить сотрудника</Button></div>
          <p className={s.note}>«За смену» — фиксированная сумма за рабочий день, полсмены оплачивается наполовину. «За принятые товары» — сумма за каждый принятый товар; сколько принято, вы вводите сами. Смена длится с {data.dayHours.from} до {data.dayHours.to} — время меняется в настройках.</p>
        </div>
      )}

      {step === 2 && (
        <div>
          {people.map(p => {
            const t = tpl(p.id);
            const eff = effective[p.id];
            const idx = withPeople ? people.indexOf(p) : snap.staff.staff_list.indexOf(p);
            const c = colorOf(p, idx);
            const cyc = CYCLE[t.kind];
            const strip = range(first, addDays(first, 13));
            return (
              <div key={p.id} className={s.modeRow}>
                <div className={s.modeName}><Avatar person={p} index={idx} />{p.name}</div>
                <div className={s.modeBody}>
                  <div className={s.pills} role="group" aria-label={`Режим работы: ${p.name}`}>
                    {MODES.map(m => (
                      <button key={m.id} type="button" className={s.pill} aria-pressed={t.kind === m.id} onClick={() => setTpl(p.id, { kind: m.id, weekdays: m.id === 'weekdays' ? t.weekdays ?? [5, 6] : t.weekdays })}>{m.label}</button>
                    ))}
                  </div>
                  {cyc && (
                    <div className={s.pills} style={{ alignItems: 'center' }}>
                      <span className={s.muted}>Смены выпали не на те дни?</span>
                      <Button size="sm" variant="secondary" onClick={() => setTpl(p.id, { start: addDays(eff.start, -1) })}>Сдвинуть на день раньше</Button>
                      <Button size="sm" variant="secondary" onClick={() => setTpl(p.id, { start: addDays(eff.start, 1) })}>На день позже</Button>
                    </div>
                  )}
                  {t.kind === 'weekdays' && (
                    <div className={s.weekdayChips} role="group" aria-label={`Рабочие дни недели: ${p.name}`}>
                      {WEEKDAYS.map((w, k) => {
                        const on = (t.weekdays ?? []).includes(k);
                        return <button key={w} type="button" aria-pressed={on} onClick={() => setTpl(p.id, { weekdays: on ? (t.weekdays ?? []).filter(x => x !== k) : [...(t.weekdays ?? []), k].sort() })}>{w.toLowerCase()}</button>;
                      })}
                    </div>
                  )}
                  {t.kind !== 'none' && (
                    <div className={s.preview} style={{ gridTemplateColumns: 'repeat(14, minmax(0, 1fr))' }} aria-label="Первые две недели">
                      {strip.map(d => {
                        const on = worksOn(eff, d);
                        return (
                          <div key={d} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                            <small style={{ fontSize: 10, color: 'var(--text-muted)' }}>{WEEKDAYS[weekday(d)].toLowerCase()}</small>
                            <span className={s.previewCell} style={{ width: '100%', ...(on ? { background: c.bg, borderColor: c.solid, color: c.fg } : {}) }}>{Number(d.slice(8))}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <p className={s.muted} style={{ marginTop: 8 }}>«2 через 2» — два дня работает, два отдыхает. «Расставлю сам» ничего не заполняет: смены вы поставите в табеле.</p>
        </div>
      )}

      {step === 3 && (
        <div className={s.form}>
          <div className={s.pills} role="group" aria-label="За какой период">
            {month === monthKey(today) && <button type="button" className={s.pill} aria-pressed={period === 'rest'} onClick={() => setPeriod('rest')}>С сегодня до конца месяца</button>}
            <button type="button" className={s.pill} aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>Весь {monthTitle(month).toLowerCase().split(' ')[0]}</button>
            <button type="button" className={s.pill} aria-pressed={period === 'next'} onClick={() => setPeriod('next')}>{monthTitle(shiftMonth(month, 1))}</button>
          </div>
          <div className={s.gridWrap}>
            <div style={{ minWidth: 640, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {people.map(p => {
                const idx = withPeople ? people.indexOf(p) : snap.staff.staff_list.indexOf(p);
                const c = colorOf(p, idx);
                return (
                  <div key={p.id} style={{ display: 'grid', gridTemplateColumns: `150px repeat(${monthDays.length}, minmax(0, 1fr))`, gap: 2, alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    {monthDays.map(d => {
                      const on = after.shifts[d]?.some(x => x.staffId === p.id);
                      return <span key={d} className={s.previewCell} style={{ height: 22, ...(on ? { background: c.solid, borderColor: c.solid } : weekday(d) >= 5 ? { background: 'var(--surface-muted)' } : {}) }} />;
                    })}
                  </div>
                );
              })}
              <div style={{ display: 'grid', gridTemplateColumns: `150px repeat(${monthDays.length}, minmax(0, 1fr))`, gap: 2, alignItems: 'center', paddingTop: 6, borderTop: '1px solid var(--surface-sunken)' }}>
                <span className={s.muted}>В пункте, человек</span>
                {monthDays.map(d => {
                  const n = coverage(after, d);
                  return <span key={d} className={`${s.cover} ${n ? '' : s.coverZero}`} style={{ minWidth: 0, width: '100%', fontSize: 11 }}>{n}</span>;
                })}
              </div>
            </div>
          </div>
          <div className={s.stats}>
            <div className={s.statBox}><span>Смен добавится</span><b>{plan.added.length}</b></div>
            <div className={`${s.statBox} ${empty ? s.statRed : ''}`}><span>Дней, когда в пункте никого нет</span><b>{empty}</b></div>
            <div className={s.statBox}><span>Зарплата за эти смены, примерно</span><b>{rub(fund)}</b></div>
          </div>
          {plan.kept > 0 && <p className={s.muted}>Ручные смены и замены не тронуты: {plan.kept}.</p>}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <input id="tw-extend" type="checkbox" checked={extend} onChange={e => setExtend(e.target.checked)} style={{ width: 20, height: 20, margin: '1px 0 0', accentColor: 'var(--accent)' }} />
            <label htmlFor="tw-extend" style={{ fontSize: 14, lineHeight: 1.45 }}>Продлевать график на следующий месяц по тем же режимам. Что добавилось, будет видно над табелем, и это можно убрать одним нажатием.</label>
          </div>
        </div>
      )}
    </Modal>
  );
}
