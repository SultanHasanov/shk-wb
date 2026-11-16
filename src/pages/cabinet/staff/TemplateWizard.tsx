import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { Button, Input, Modal } from '../../../ui';
import {
  WEEKDAYS,
  addDays,
  applyPlan,
  colorOf,
  coverage,
  crowdedDays,
  dayMonth,
  diffDays,
  isActive,
  maxPerDay,
  monthEnd,
  monthKey,
  monthStart,
  monthTitle,
  monthWeeks,
  paysShk,
  planAutofillDays,
  range,
  rateOn,
  rub,
  shiftMonth,
  todayYmd,
  weekday,
  weeksDays,
  worksOn,
  type StaffEntry,
  type Template,
  type TemplateKind,
} from '../../../lib/staff-core';
import { Avatar, Dropdown, parseMoney, useIsPhone } from './parts';
import { MonthCalendar } from './MonthCalendar';
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

/** Начало цикла не позже первого дня месяца: иначе дни до него остались бы пустыми. Фаза цикла сохраняется. */
function fitStart(start: string, kind: TemplateKind, first: string): string {
  const c = CYCLE[kind];
  if (!c) return start && start <= first ? start : first;
  const st = start || first;
  const shift = ((diffDays(st, first) % c) + c) % c;
  return addDays(first, -shift);
}

/** Какие недели и дни заполнять по умолчанию: в текущем месяце — с сегодняшнего дня, в остальных — весь месяц. */
function defaultPick(month: string, today: string): { weeks: string[]; skipPast: boolean } {
  const all = monthWeeks(month);
  if (month !== monthKey(today)) return { weeks: all.map(w => w.start), skipPast: false };
  return { weeks: all.filter(w => w.days.some(d => d >= today)).map(w => w.start), skipPast: true };
}

/**
 * Мастер графика. Первый шаг (кто работает) — только когда в пункте ещё никого нет; из «Заполнить по шаблону»
 * мастер открывается сразу со второго. Ставит смены только в пустые дни: ручные смены и замены не трогает.
 *
 * Шаг «Как работают»: режим и день, с которого начинается рабочая смена, — день выбирается нажатием в мини-месяце.
 * Шаг «Проверьте месяц»: календарь с результатом; заполнить можно весь месяц или отдельные недели.
 */
export function TemplateWizard({ docs, month, onClose }: { docs: StaffDocs; month: string; onClose: () => void }) {
  const snap = docs.snap!;
  const data = snap.schedule;
  const existing = snap.staff.staff_list.filter(isActive);
  const withPeople = existing.length === 0;
  const today = todayYmd();
  const phone = useIsPhone();
  const [step, setStep] = useState(withPeople ? 1 : 2);
  const [drafts, setDrafts] = useState<Draft[]>([{ key: 'd0', name: '', pay: 'shift', amount: '' }]);
  const [ids] = useState(() => new Map<string, string>());
  // какой месяц заполняем: по умолчанию открытый во вкладке, его можно сменить стрелками в мастере
  const [target, setTargetRaw] = useState(month);
  const [sel, setSel] = useState(() => defaultPick(target, today));
  const setTarget = (m: string) => { setTargetRaw(m); setSel(defaultPick(m, today)); };
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
  // для цветов и имён в календаре: новые люди первого графика ещё не в списке пункта
  const allStaff = withPeople ? [...snap.staff.staff_list, ...people] : snap.staff.staff_list;

  const first = monthStart(target);
  const last = monthEnd(target);
  const [templates, setTemplates] = useState<Record<string, Template>>(() => {
    const out: Record<string, Template> = {};
    for (const p of existing) {
      const t = data.templates[p.id];
      out[p.id] = t ? { ...t } : { kind: 'none', start: first };
    }
    return out;
  });
  // новым людям «2 через 2» со сдвигом через одного: двое закрывают все дни
  const tpl = (id: string): Template => templates[id] ?? { kind: withPeople ? '2/2' : 'none', start: addDays(first, -2 * (Math.max(0, people.findIndex(p => p.id === id)) % 2)) };
  const setTpl = (id: string, t: Partial<Template>) => setTemplates(m => ({ ...m, [id]: { ...tpl(id), ...t } }));

  const effective = useMemo(() => {
    const out: Record<string, Template> = {};
    for (const p of people) {
      const t = tpl(p.id);
      out[p.id] = { ...t, start: fitStart(t.start, t.kind, first) };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, templates, first]);

  const weeks = monthWeeks(target);
  const isPast = (w: { days: string[] }) => sel.skipPast && w.days.every(d => d < today);
  const weeksOn = useMemo(() => new Set(sel.weeks), [sel.weeks]);
  const days = useMemo(() => weeksDays(target, sel.weeks, sel.skipPast ? today : undefined), [target, sel, today]);
  const daySet = useMemo(() => new Set(days), [days]);
  const plan = useMemo(() => planAutofillDays(data, people, effective, days), [data, people, effective, days]);
  const after = useMemo(() => applyPlan(data, plan), [data, plan]);
  const added = useMemo(() => new Set(plan.added.map(a => `${a.day}:${a.staffId}`)), [plan]);
  const empty = days.filter(d => coverage(after, d) === 0).length;
  const fund = plan.added.reduce((a, x) => {
    const p = people.find(pp => pp.id === x.staffId);
    return a + (p && !paysShk(p) ? rateOn(p, x.day) : 0);
  }, 0);

  // Лимит людей в день. Блокируем только то, что испортит само заполнение; то, что уже стояло, — подсказка.
  const [allowMore, setAllowMore] = useState(false);
  const limit = maxPerDay(data);
  const touched = new Set(plan.added.map(a => a.day));
  const crowdNew = crowdedDays(after, days).filter(d => touched.has(d));
  const crowdMax = crowdNew.reduce((a, d) => Math.max(a, after.shifts[d]?.length ?? 0), 0);
  const crowdOld = crowdedDays(data, range(first, last));
  const blocked = crowdNew.length > 0 && (!allowMore || crowdMax > 3);

  const allWeeks = weeks.map(w => w.start);
  const restWeeks = weeks.filter(w => w.days.some(d => d >= today)).map(w => w.start);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));
  const isCurrent = target === monthKey(today);
  const presetRest = isCurrent && sel.skipPast && same(sel.weeks, restWeeks);
  const presetAll = !sel.skipPast && same(sel.weeks, allWeeks);
  // прошедшие недели при «с сегодня» показаны неотмеченными; отметить такую — значит заполнять и прошедшие дни
  const shownWeeks = new Set(weeks.filter(w => weeksOn.has(w.start) && !isPast(w)).map(w => w.start));
  const toggleWeek = (start: string) => {
    const w = weeks.find(x => x.start === start);
    if (w && isPast(w)) return setSel(v => ({ weeks: [...v.weeks.filter(x => x !== start), start], skipPast: false }));
    setSel(v => ({ ...v, weeks: v.weeks.includes(start) ? v.weeks.filter(x => x !== start) : [...v.weeks, start] }));
  };

  const finish = () => {
    docs.update(sn => {
      const nextTemplates = { ...sn.schedule.templates };
      for (const p of people) nextTemplates[p.id] = effective[p.id];
      let sched = applyPlan({ ...sn.schedule, templates: nextTemplates }, planAutofillDays(sn.schedule, people, effective, days));
      if (allowMore && crowdMax > maxPerDay(sched)) sched = { ...sched, maxPerDay: Math.min(3, crowdMax) };
      // выбраны не все недели — автопродление не должно дозаполнить остальные: считаем месяц пройденным целиком
      sched = { ...sched, autoExtend: extend, ...(extend ? { filledUntil: !sched.filledUntil || sched.filledUntil < last ? last : sched.filledUntil } : {}) };
      // список людей меняем, только когда мастер их добавил: иначе документ сотрудников ушёл бы на сервер без правок
      return { staff: withPeople ? { ...sn.staff, staff_list: [...sn.staff.staff_list, ...people] } : sn.staff, schedule: sched };
    });
    onClose();
  };

  const stepNames = withPeople ? ['Кто работает', 'Как работают', 'Проверьте месяц'] : ['Как работают', 'Проверьте месяц'];
  const stepIndex = withPeople ? step - 1 : step - 2;
  const canNext = step === 1 ? people.length > 0 : true;
  const lead = weekday(first);
  const monthDays = range(first, last);

  const monthBar = (
    <div className={s.wizBar}>
      <span className={s.label}>Какой месяц заполняем</span>
      <div className={s.monthNav}>
        <button type="button" className={s.iconBtn} aria-label="Предыдущий месяц" onClick={() => setTarget(shiftMonth(target, -1))}><ChevronLeft size={16} /></button>
        <div className={s.monthTitle}>{monthTitle(target)}</div>
        <button type="button" className={s.iconBtn} aria-label="Следующий месяц" onClick={() => setTarget(shiftMonth(target, 1))}><ChevronRight size={16} /></button>
      </div>
      {data.closed[target] && <span className={s.gWarn} style={{ fontSize: 13 }}>месяц закрыт — смены в него не встанут</span>}
    </div>
  );

  return (
    <Modal open onOpenChange={o => !o && onClose()} size="lg" sheet title={withPeople ? `Соберём график на ${monthTitle(month).toLowerCase()}` : 'Заполнить по шаблону'}
      description={withPeople ? 'Три шага, около двух минут. Всё, что вы укажете, потом можно поправить.' : 'Выберите для каждого обычный режим и день, с которого начинается смена. Смены встанут только в пустые дни: ручные смены и замены останутся как есть.'}
      footer={
        <div className={s.dialogActions} style={{ width: '100%' }}>
          {step > (withPeople ? 1 : 2) && <Button variant="secondary" onClick={() => setStep(step - 1)}>Назад</Button>}
          <Button variant="ghost" className={s.grow} onClick={onClose}>{withPeople ? 'Пропустить' : 'Отмена'}</Button>
          {step < 3 ? <Button onClick={() => setStep(step + 1)} disabled={!canNext}>Дальше</Button> : <Button onClick={finish} disabled={!people.length || blocked}>{withPeople ? 'Создать график' : `Поставить смены: ${plan.added.length}`}</Button>}
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
          {monthBar}
          {people.map(p => {
            const t = tpl(p.id);
            const eff = effective[p.id];
            const idx = allStaff.indexOf(p);
            const c = colorOf(p, idx);
            const cyc = CYCLE[t.kind];
            const clickable = Boolean(cyc) || t.kind === 'weekdays';
            const startDay = cyc && t.start >= first && t.start <= last ? t.start : null;
            return (
              <div key={p.id} className={s.modeRow}>
                <div className={s.modeName}><Avatar person={p} index={idx} />{p.name}</div>
                <div className={s.modeBody}>
                  <div className={s.pills} role="group" aria-label={`Режим работы: ${p.name}`}>
                    {MODES.map(m => (
                      <button key={m.id} type="button" className={s.pill} aria-pressed={t.kind === m.id} onClick={() => setTpl(p.id, { kind: m.id, weekdays: m.id === 'weekdays' ? t.weekdays ?? [5, 6] : t.weekdays })}>{m.label}</button>
                    ))}
                  </div>
                  {t.kind === 'weekdays' && (
                    <div className={s.weekdayChips} role="group" aria-label={`Рабочие дни недели: ${p.name}`}>
                      {WEEKDAYS.map((w, k) => {
                        const on = (t.weekdays ?? []).includes(k);
                        return <button key={w} type="button" aria-pressed={on} onClick={() => setTpl(p.id, { weekdays: on ? (t.weekdays ?? []).filter(x => x !== k) : [...(t.weekdays ?? []), k].sort() })}>{w.toLowerCase()}</button>;
                      })}
                    </div>
                  )}
                  {t.kind !== 'none' && (
                    <>
                      <p className={s.muted}>
                        {cyc ? 'Нажмите на день, с которого начинается рабочая смена, — остальные дни встанут по режиму.'
                          : t.kind === 'weekdays' ? 'Нажмите на день в календаре или на день недели выше, чтобы добавить его или убрать.'
                          : 'Рабочие дни — с понедельника по пятницу.'}
                      </p>
                      <div className={s.mini} role="group" aria-label={`${monthTitle(target)}, рабочие дни: ${p.name}`}>
                        {WEEKDAYS.map(w => <small key={w} aria-hidden="true">{w.toLowerCase()}</small>)}
                        {Array.from({ length: lead }, (_, i) => <span key={`gap-${i}`} />)}
                        {monthDays.map(d => {
                          const on = worksOn(eff, d);
                          return (
                            <button key={d} type="button" disabled={!clickable} aria-pressed={on}
                              aria-label={`${dayMonth(d)}: ${on ? 'работает' : 'выходной'}${d === startDay ? ', начало смены' : ''}`}
                              className={`${s.miniDay} ${d === startDay ? s.miniStart : ''}`}
                              style={on ? { background: c.bg, borderColor: c.solid, color: c.fg } : undefined}
                              onClick={() => {
                                if (cyc) return setTpl(p.id, { start: d });
                                const k = weekday(d);
                                const cur = t.weekdays ?? [];
                                setTpl(p.id, { weekdays: cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k].sort() });
                              }}>
                              {Number(d.slice(8))}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <p className={s.muted} style={{ marginTop: 8 }}>«2 через 2» — два дня работает, два отдыхает. «Расставлю сам» ничего не заполняет: смены вы поставите в календаре.</p>
        </div>
      )}

      {step === 3 && (
        <div className={s.form}>
          <div>
            {monthBar}
            <div className={s.pills} role="group" aria-label="Что заполнить">
              {isCurrent && <button type="button" className={s.pill} aria-pressed={presetRest} onClick={() => setSel({ weeks: restWeeks, skipPast: true })}>С сегодня до конца месяца</button>}
              <button type="button" className={s.pill} aria-pressed={presetAll} onClick={() => setSel({ weeks: allWeeks, skipPast: false })}>Весь месяц</button>
              <span className={s.muted} style={{ alignSelf: 'center' }}>или отметьте галочкой нужные недели слева от календаря</span>
            </div>
          </div>
          <MonthCalendar month={target} data={after} staff={allStaff} phone={phone}
            dim={d => !daySet.has(d)} fresh={(d, id) => added.has(`${d}:${id}`)}
            weeks={{ on: shownWeeks, toggle: toggleWeek }}
            footer={<p className={s.calHint}>Обведённые смены появятся после заполнения. Приглушённые дни не заполняются{sel.skipPast ? ': прошедшие дни пропущены, чтобы за них не начислилась зарплата' : ''}.</p>} />
          <div className={s.stats}>
            <div className={s.statBox}><span>Смен добавится</span><b>{plan.added.length}</b></div>
            <div className={`${s.statBox} ${empty ? s.statRed : ''}`}><span>Дней без людей в выбранном</span><b>{empty}</b></div>
            {docs.caps?.money !== false && <div className={s.statBox}><span>Зарплата за эти смены, примерно</span><b>{rub(fund)}</b></div>}
          </div>
          {!days.length && <p className={`${s.note} ${s.noteWarn}`}>Не выбрано ни одной недели — отметьте недели слева от календаря или нажмите «Весь месяц».</p>}
          {crowdNew.length > 0 && (
            <div className={s.dayWarn} role="alert">
              <p>После заполнения в {crowdNew.length} {crowdNew.length === 1 ? 'дне' : 'днях'} в пункте получится больше людей, чем разрешено в настройках ({limit === 1 ? 'один человек' : `не больше ${limit}`} в день). Вернитесь и выберите другой день начала смены, чтобы режимы не пересекались, или разрешите работать вместе.</p>
              {crowdMax <= 3 && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <input id="tw-more" type="checkbox" checked={allowMore} onChange={e => setAllowMore(e.target.checked)} style={{ width: 20, height: 20, margin: '1px 0 0', accentColor: 'var(--accent)' }} />
                  <label htmlFor="tw-more" style={{ fontSize: 14, lineHeight: 1.45 }}>Разрешить в этом пункте {crowdMax >= 3 ? 'троих' : 'двоих'} в один день</label>
                </div>
              )}
            </div>
          )}
          {crowdOld.length > 0 && (
            <p className={`${s.note} ${s.noteWarn}`}>
              Уже сейчас людей больше, чем разрешено в настройках: {crowdOld.length > 6 ? `${crowdOld.length} дней` : crowdOld.map(d => Number(d.slice(8))).join(', ')} {dayMonth(crowdOld[0]).replace(/^\d+ /, '')}. Заполнение эти дни не меняет — поправьте их в графике: откройте день и оставьте одного.
            </p>
          )}
          {plan.kept > 0 && <p className={s.muted}>Ручные смены и замены не тронуты: {plan.kept}.</p>}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <input id="tw-extend" type="checkbox" checked={extend} onChange={e => setExtend(e.target.checked)} style={{ width: 20, height: 20, margin: '1px 0 0', accentColor: 'var(--accent)' }} />
            <label htmlFor="tw-extend" style={{ fontSize: 14, lineHeight: 1.45 }}>Продлевать график на следующий месяц по тем же режимам. Что добавилось, будет видно над календарём, и это можно убрать одним нажатием.</label>
          </div>
        </div>
      )}
    </Modal>
  );
}
