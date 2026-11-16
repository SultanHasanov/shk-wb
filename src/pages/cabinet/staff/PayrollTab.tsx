import { useMemo, useState, type ClipboardEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { Button, Input, Modal, Table, useToast } from '../../../ui';
import {
  DEDUCTION_KINDS,
  PAY_METHOD,
  addAdjust,
  addDays,
  addPayment,
  cancelAdjust,
  cancelPayment,
  closeMonth,
  dayMonth,
  dueFor,
  isActive,
  journal,
  monthCalc,
  monthEnd,
  monthGen,
  monthKey,
  monthStart,
  monthTitle,
  newId,
  paidOn,
  payDate,
  paysShk,
  payrollPeople,
  range,
  removeDeduction,
  reopenMonth,
  rub,
  saveDeduction,
  setShkCount,
  shiftMonth,
  shiftOf,
  shiftsOn,
  shkCountOn,
  shkPriceOn,
  todayYmd,
  undecided,
  unitsText,
  type Deduction,
  type Due,
  type MonthCalc,
  type Payment,
  type ScheduleData,
  type StaffEntry,
} from '../../../lib/staff-core';
import { Avatar, Dropdown, copyText, escapeHtml, moneyInput, parseMoney, printHtml } from './parts';
import type { Snap, StaffDocs } from './useStaffDocs';
import s from './staff.module.css';

type View = 'people' | 'journal' | 'deductions' | 'reports';
type Dlg =
  | { kind: 'pay'; staffId?: string; type?: Payment['type'] }
  | { kind: 'mass' }
  | { kind: 'adj'; staffId?: string; t: 'bonus' | 'fine' | 'correction' }
  | { kind: 'cancel'; what: 'payment' | 'adjust'; id: string }
  | { kind: 'deduction'; id?: string }
  | { kind: 'close' }
  | { kind: 'sheet'; staffId: string }
  | { kind: 'goods' };

/** «октябрь» из ключа месяца — для «зарплата за октябрь». */
const monthNom = (m: string) => monthTitle(m).split(' ')[0].toLowerCase();
const signed = (n: number) => (n > 0 ? `+${rub(n)}` : n < 0 ? `−${rub(-n)}` : rub(0));
const METHOD_LABEL: Record<Payment['method'], string> = { cash: 'Наличными', card: 'Переводом на карту', other: 'Другим способом' };
const TYPE_LABEL: Record<Payment['type'], string> = { advance: 'Аванс', salary: 'Зарплата', other: 'В счёт зарплаты' };

/**
 * Учёт выплат ведётся с месяца ledgerFrom: раньше выплаты не записывались, и прошлые месяцы иначе выглядели бы
 * долгами. Программа ставит его один раз при переходе (migrateLedger); сайт ставит, если запись о деньгах
 * появилась раньше, чем документ открыла программа.
 */
function withLedger(d: ScheduleData): ScheduleData {
  if (d.ledgerFrom) return d;
  const paidAdvances = Object.values(d.advances ?? {}).some(list => Object.values(list).some(a => a.paid));
  return paidAdvances ? d : { ...d, ledgerFrom: monthKey(todayYmd()) };
}

export function PayrollTab({ docs, month, setMonth, initialView, initialGoods }: { docs: StaffDocs; month: string; setMonth: (m: string) => void; initialView?: View; initialGoods?: boolean }) {
  const snap = docs.snap!;
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const [view, setView] = useState<View>(initialView ?? 'people');
  const [dlg, setDlg] = useState<Dlg | null>(initialGoods ? { kind: 'goods' } : null);
  const closed = Boolean(data.closed[month]);
  const people = useMemo(() => payrollPeople(staff, data, month), [staff, data, month]);
  const rows = useMemo(() => people.map(p => ({ p, c: monthCalc(p, data, month) })), [people, data, month]);
  const sum = (f: (c: MonthCalc) => number) => rows.reduce((a, r) => a + f(r.c), 0);
  const open = undecided(data, month);
  const pay = (fn: (d: ScheduleData) => ScheduleData) => docs.update(sn => ({ ...sn, schedule: fn(withLedger(sn.schedule)) }));
  const today = todayYmd();
  const isCurrent = month === monthKey(today);
  // выплатить можно за любой открытый месяц, кроме будущих: за них ещё ничего не начислено
  // на ПК, где владелец закрыл правку, зарплата только читается: кнопки правок скрыты, как в закрытом месяце
  const readOnly = docs.caps?.edit === false;
  const locked = closed || readOnly;
  const payable = !locked && month <= monthKey(today);
  const advanceDay = Math.min(data.advanceRule.day, Number(monthEnd(month).slice(8)));
  const payDay = Math.min(data.payDay, Number(monthEnd(month).slice(8)));

  return (
    <>
      <div className={s.payBar}>
        <div className={s.monthNav}>
          <button type="button" className={s.iconBtn} aria-label="Предыдущий месяц" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={16} /></button>
          <div className={s.monthTitle}>{monthTitle(month)}</div>
          <button type="button" className={s.iconBtn} aria-label="Следующий месяц" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={16} /></button>
        </div>
        <span className={s.muted}>Аванс {advanceDay} {dayMonth(monthStart(month)).replace(/^\d+ /, '')}, зарплата {payDay}</span>
        <span className={s.muted} style={{ fontWeight: 600, color: closed ? 'var(--text-muted)' : 'var(--success)' }}>{closed ? 'Месяц закрыт' : 'Месяц открыт'}</span>
        <div className={s.toolbarEnd}>
          {payable && rows.length > 0 && <Button size="sm" variant="secondary" onClick={() => setDlg({ kind: 'mass' })}>Выплатить всем</Button>}
          {readOnly ? null : closed
            ? <Button size="sm" variant="secondary" onClick={() => docs.update(sn => ({ ...sn, schedule: reopenMonth(sn.schedule, month) }))}>Открыть месяц снова</Button>
            : <Button size="sm" onClick={() => setDlg({ kind: 'close' })} disabled={!rows.length}>Закрыть месяц</Button>}
        </div>
      </div>

      <div className={s.stats}>
        <div className={s.statBox}><span>Начислено, за отработанные дни</span><b>{rub(sum(c => c.earned + c.bonus + c.creditSum))}</b></div>
        <div className={s.statBox}><span>Штрафы и удержания WB</span><b>{rub(sum(c => c.fine + c.heldSum))}</b></div>
        <div className={s.statBox}><span>Выплачено</span><b>{rub(sum(c => c.paid))}</b></div>
        <div className={`${s.statBox} ${s.statAccent}`}><span>Осталось выплатить{isCurrent ? ' на сегодня' : ''}</span><b>{rub(sum(c => c.left))}</b></div>
      </div>

      <div className={s.subTabs} role="tablist" aria-label="Зарплата">
        {([['people', 'По людям'], ['journal', 'Все операции'], ['deductions', 'Удержания WB'], ['reports', 'Отчёты']] as const).map(([v, l]) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={`${s.subTab} ${view === v ? s.subTabOn : ''}`} onClick={() => setView(v)}>
            {l}{v === 'deductions' && open.length > 0 && <span className={s.count}>{open.length}</span>}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {staff.some(p => isActive(p) && paysShk(p)) && <Button size="sm" variant="secondary" onClick={() => setDlg({ kind: 'goods' })}>Принятые товары</Button>}
        <Button size="sm" variant="secondary" onClick={() => printPayout(rows, month, data)} disabled={!rows.length}>Печать ведомости</Button>
      </div>

      {view === 'people' && (
        rows.length === 0 ? <p className={s.note}>В этом месяце нет сотрудников и начислений.</p> : (
          <section className={s.block} style={{ padding: 0 }}>
            <Table>
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th className={s.num}>Перешло с {monthGen(shiftMonth(month, -1))}</th>
                  <th className={s.num}>Начислено</th>
                  <th className={s.num}>Премии и штрафы</th>
                  <th className={s.num}>Удержания WB</th>
                  <th className={s.num}>Выплачено</th>
                  <th className={s.num}>Осталось</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, c }) => (
                  <tr key={p.id} className={s.clickRow} onClick={() => setDlg({ kind: 'sheet', staffId: p.id })}>
                    <td>
                      <span className={s.rowName}>
                        <Avatar person={p} index={staff.indexOf(p)} size={28} />
                        <span>
                          <b>{p.name}</b>
                          <small className={c.noRate ? s.gWarn : ''}>
                            {paysShk(p) ? `${c.shk} товаров` : `${unitsText(c.units)} смен`}
                            {c.planUnits ? `, ещё ${unitsText(c.planUnits)} по графику` : ''}
                            {c.noRate ? ', ставка не указана' : ''}
                          </small>
                        </span>
                      </span>
                    </td>
                    <td className={s.num}>{c.beforeLedger ? '—' : rub(c.opening)}</td>
                    <td className={s.num}>{rub(c.earned)}</td>
                    <td className={s.num}>{signed(c.bonus + c.creditSum - c.fine)}</td>
                    <td className={s.num}>{c.heldSum ? `−${rub(c.heldSum)}` : rub(0)}</td>
                    <td className={s.num}>{rub(c.paid)}</td>
                    <td className={`${s.num} ${s.strong} ${c.left < 0 ? s.minus : ''}`}>{rub(c.left)}</td>
                    <td className={s.num} onClick={e => e.stopPropagation()}>
                      {payable && (isActive(p) || c.left > 0) && <Button size="sm" variant="secondary" onClick={() => setDlg({ kind: 'pay', staffId: p.id })}>Выплатить</Button>}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td><b>Всего по пункту</b></td>
                  <td className={`${s.num} ${s.strong}`}>{rub(sum(c => (c.beforeLedger ? 0 : c.opening)))}</td>
                  <td className={`${s.num} ${s.strong}`}>{rub(sum(c => c.earned))}</td>
                  <td className={`${s.num} ${s.strong}`}>{signed(sum(c => c.bonus + c.creditSum - c.fine))}</td>
                  <td className={`${s.num} ${s.strong}`}>{rub(sum(c => c.heldSum))}</td>
                  <td className={`${s.num} ${s.strong}`}>{rub(sum(c => c.paid))}</td>
                  <td className={`${s.num} ${s.strong}`}>{rub(sum(c => c.left))}</td>
                  <td />
                </tr>
              </tbody>
            </Table>
            <p className={s.muted} style={{ padding: '10px 16px 14px' }}>
              Начислено считается только за уже отработанные дни. Щёлкните по строке, чтобы открыть листок сотрудника. Когда рассчитаетесь со всеми, закройте месяц: невыплаченные остатки перейдут на следующий, а смены будут защищены от случайных правок.
            </p>
          </section>
        )
      )}

      {view === 'journal' && <Journal snap={snap} month={month} onCancel={(what, id) => setDlg({ kind: 'cancel', what, id })} onAdj={t => setDlg({ kind: 'adj', t })} onPay={() => setDlg({ kind: 'pay' })} closed={locked} payable={payable} />}
      {view === 'deductions' && <Deductions docs={docs} month={month} onEdit={id => setDlg({ kind: 'deduction', id })} />}
      {view === 'reports' && <Reports snap={snap} month={month} />}

      {dlg?.kind === 'pay' && <PayDialog snap={snap} month={month} staffId={dlg.staffId} type={dlg.type} onClose={() => setDlg(null)} onSave={p => pay(d => addPayment(d, p))} />}
      {dlg?.kind === 'mass' && <MassPayDialog snap={snap} month={month} onClose={() => setDlg(null)} onSave={list => pay(d => list.reduce((acc, p) => addPayment(acc, p), d))} />}
      {dlg?.kind === 'adj' && <AdjDialog snap={snap} staffId={dlg.staffId} t={dlg.t} onClose={() => setDlg(null)} onSave={(a, parts) => pay(d => addAdjust(d, a, parts))} />}
      {dlg?.kind === 'cancel' && <CancelDialog snap={snap} what={dlg.what} id={dlg.id} onClose={() => setDlg(null)} onSave={why => pay(d => (dlg.what === 'payment' ? cancelPayment(d, dlg.id, why) : cancelAdjust(d, dlg.id, why)))} />}
      {dlg?.kind === 'deduction' && <DeductionDialog snap={snap} id={dlg.id} onClose={() => setDlg(null)} onSave={d => pay(x => saveDeduction(x, d))} onRemove={id => pay(x => removeDeduction(x, id))} />}
      {dlg?.kind === 'close' && <CloseDialog snap={snap} month={month} onClose={() => setDlg(null)} onSave={() => pay(d => closeMonth(d, staff, month))} onGo={next => { setDlg(null); if (next === 'deductions') setView('deductions'); else setDlg(next); }} />}
      {dlg?.kind === 'sheet' && <SheetDialog snap={snap} staffId={dlg.staffId} month={month} readOnly={readOnly} onClose={() => setDlg(null)} onDlg={setDlg} />}
      {dlg?.kind === 'goods' && <GoodsDialog docs={docs} month={month} onClose={() => setDlg(null)} />}
    </>
  );
}

// ───────── журнал ─────────

function Journal({ snap, month, onCancel, onAdj, onPay, closed, payable }: { snap: Snap; month: string; onCancel: (what: 'payment' | 'adjust', id: string) => void; onAdj: (t: 'bonus' | 'fine' | 'correction') => void; onPay: () => void; closed: boolean; payable: boolean }) {
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const [person, setPerson] = useState('');
  const [filter, setFilter] = useState<'all' | 'pay' | 'adj' | 'wb' | 'dead'>('all');
  const nameOf = (id: string) => staff.find(p => p.id === id)?.name || data.removedNames?.[id] || 'сотрудник';
  const items = journal(data).filter(i => monthKey(i.date) === month);
  const shown = items.filter(i => {
    const ids = i.kind === 'deduction' ? i.staffIds : [i.staffId];
    if (person && !ids.includes(person)) return false;
    const dead = i.kind === 'payment' ? Boolean(i.p.cancelled) : i.kind === 'adjust' ? Boolean(i.a.cancelled) : false;
    if (filter === 'dead') return dead;
    if (filter === 'pay') return i.kind === 'payment';
    if (filter === 'adj') return i.kind === 'adjust';
    if (filter === 'wb') return i.kind === 'deduction';
    return true;
  });
  const filters = [['all', 'Все'], ['pay', 'Выплаты'], ['adj', 'Премии и штрафы'], ['wb', 'Удержания WB'], ['dead', 'Отменённые']] as const;

  return (
    <section className={s.block}>
      <div className={s.toolbar}>
        <div style={{ width: 230 }}>
          <Dropdown label="Чьи операции показать" value={person} onChange={setPerson} options={[{ value: '', label: 'Все сотрудники' }, ...staff.map(p => ({ value: p.id, label: p.name }))]} />
        </div>
        <div className={s.pills} role="group" aria-label="Какие операции показать">
          {filters.map(([v, l]) => <button key={v} type="button" className={s.pill} aria-pressed={filter === v} onClick={() => setFilter(v)}>{l}</button>)}
        </div>
        {!closed && (
          <div className={s.toolbarEnd}>
            <Button size="sm" variant="secondary" onClick={() => onAdj('bonus')}>Премия</Button>
            <Button size="sm" variant="secondary" onClick={() => onAdj('fine')}>Штраф</Button>
            <Button size="sm" variant="secondary" onClick={() => onAdj('correction')}>Исправление</Button>
            {payable && <Button size="sm" onClick={onPay}>Записать выплату</Button>}
          </div>
        )}
      </div>
      {shown.length === 0 ? (
        <p className={s.muted} style={{ padding: '24px 0', textAlign: 'center' }}>Таких операций за {monthTitle(month).toLowerCase()} нет. Измените отбор выше.</p>
      ) : (
        <Table>
          <thead><tr><th>Дата</th><th>Сотрудник</th><th>Что произошло</th><th className={s.num}>Меняет зарплату</th><th className={s.num}>Выдано на руки</th><th>Примечание</th><th /></tr></thead>
          <tbody>
            {shown.map(i => {
              if (i.kind === 'payment') {
                const p = i.p;
                return (
                  <tr key={`p${p.id}`} className={p.cancelled ? s.cancelled : ''}>
                    <td>{dayMonth(paidOn(p))}</td><td>{nameOf(p.staffId)}</td><td>{TYPE_LABEL[p.type]}{p.paidAt ? ` за ${monthNom(month)}` : ''}, {METHOD_LABEL[p.method].toLowerCase()}</td>
                    <td /><td className={`${s.num} ${s.strong}`}>{rub(p.amount)}</td>
                    <td>{p.cancelled ? `отменено: ${p.cancelled.why}` : p.note}</td>
                    <td className={s.num}>{!p.cancelled && !closed && <Button size="sm" variant="secondary" onClick={() => onCancel('payment', p.id)}>Отменить</Button>}</td>
                  </tr>
                );
              }
              if (i.kind === 'adjust') {
                const a = i.a;
                return (
                  <tr key={`a${a.id}`} className={a.cancelled ? s.cancelled : ''}>
                    <td>{dayMonth(a.date)}</td><td>{nameOf(a.staffId)}</td><td>{a.kind === 'correction' ? 'Исправление' : a.amount > 0 ? 'Премия' : 'Штраф'}</td>
                    <td className={`${s.num} ${s.strong} ${a.cancelled ? '' : a.amount < 0 ? s.minus : s.plus}`}>{signed(a.amount)}</td><td />
                    <td>{a.cancelled ? `отменено: ${a.cancelled.why}` : a.reason}</td>
                    <td className={s.num}>{!a.cancelled && !closed && <Button size="sm" variant="secondary" onClick={() => onCancel('adjust', a.id)}>Отменить</Button>}</td>
                  </tr>
                );
              }
              const d = i.d;
              return (
                <tr key={`d${d.id}`}>
                  <td>{dayMonth(d.date)}</td><td>{i.staffIds.map(nameOf).join(', ') || (d.assign?.type === 'skip' ? 'пункт' : 'не решено')}</td>
                  <td>Удержание WB, {d.kind.toLowerCase()}</td>
                  <td className={`${s.num} ${s.strong} ${s.minus}`}>{d.assign && d.assign.type !== 'skip' ? `−${rub(d.amount)}` : ''}</td><td />
                  <td>{d.status === 'disputed' ? 'оспаривается' : d.status === 'returned' ? 'WB вернул' : d.note ?? ''}</td><td />
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <p className={s.note} style={{ marginTop: 12 }}>Записи из журнала не удаляются. Отменённая остаётся зачёркнутой с причиной, поэтому всегда видно, что и когда происходило. Ошибку в закрытом месяце исправляют записью «Исправление» в текущем.</p>
    </section>
  );
}

// ───────── удержания WB ─────────

function assignValue(d: Deduction): string {
  if (!d.assign) return '';
  if (d.assign.type === 'staff') return d.assign.id;
  return d.assign.type;
}

function assignFrom(v: string, d: Deduction, data: ScheduleData): Deduction['assign'] {
  if (v === '') return null;
  if (v === 'skip') return { type: 'skip' };
  if (v === 'split') {
    const ids = shiftsOn(data, d.date).map(x => x.staffId);
    return ids.length ? { type: 'split', ids } : null;
  }
  return { type: 'staff', id: v };
}

function Deductions({ docs, month, onEdit }: { docs: StaffDocs; month: string; onEdit: (id?: string) => void }) {
  const data = docs.snap!.schedule;
  const staff = docs.snap!.staff.staff_list;
  const list = (data.deductions ?? []).filter(d => monthKey(d.date) === month).sort((a, b) => Number(Boolean(a.assign)) - Number(Boolean(b.assign)) || a.date.localeCompare(b.date));
  const nameOf = (id: string) => staff.find(p => p.id === id)?.name || 'сотрудник';
  const short = (id: string) => nameOf(id).split(/\s+/)[0];
  const closed = Boolean(data.closed[month]) || docs.caps?.edit === false;

  return (
    <section className={s.block}>
      <div className={s.blockHead}>
        <h2>Удержания WB за {monthTitle(month).toLowerCase()}</h2>
        {!closed && <Button size="sm" variant="secondary" onClick={() => onEdit()} style={{ marginLeft: 'auto' }}><Plus size={16} />Добавить удержание</Button>}
      </div>
      <p className={s.muted} style={{ marginBottom: 12 }}>WB удержал деньги с пункта — решите по каждому случаю, перекладывать ли сумму на сотрудников. Пока не решено, из зарплаты ничего не вычитается. Удержания вы вносите сами по уведомлению из кабинета WB.</p>
      {!data.deductWb && <p className={`${s.note} ${s.noteWarn}`} style={{ marginBottom: 12 }}>В настройках выключено «Вычитать удержания WB»: они только записываются, зарплата не уменьшается.</p>}
      {list.length === 0 ? <p className={s.muted}>В этом месяце удержаний нет.</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map(d => {
            const onShift = shiftsOn(data, d.date).map(x => x.staffId);
            const v = assignValue(d);
            const share = d.assign?.type === 'split' ? Math.round(d.amount / d.assign.ids.length) : d.amount;
            const result = !d.assign ? 'Ещё не решено: из зарплаты ничего не вычитается.'
              : d.assign.type === 'skip' ? 'Сумму берёт на себя пункт, зарплата сотрудников не меняется.'
              : d.assign.type === 'split' ? `Из зарплаты вычтется по ${rub(share)}: ${d.assign.ids.map(short).join(', ')}.`
              : `Из зарплаты вычтется ${rub(d.amount)}: ${nameOf(d.assign.id)}.`;
            return (
              <div key={d.id} className={`${s.deduction} ${!d.assign ? s.deductionOpen : ''}`}>
                <div className={s.deductionHead}>
                  <span>
                    <b>{d.kind}{d.status === 'disputed' ? ' · оспариваю' : d.status === 'returned' ? ' · WB вернул' : ''}</b>
                    <small>{dayMonth(d.date)}{onShift.length ? `, на смене: ${onShift.map(short).join(', ')}` : ', на смене никого'}{d.shk ? `, ШК ${d.shk}` : ''}</small>
                  </span>
                  <b className={s.num}>{rub(d.amount)}</b>
                  {!closed && <Button size="sm" variant="ghost" onClick={() => onEdit(d.id)}>Изменить</Button>}
                </div>
                <Dropdown
                  label={`С кого удержать: ${d.kind}, ${dayMonth(d.date)}`}
                  value={v}
                  disabled={closed}
                  onChange={next => docs.update(sn => ({ ...sn, schedule: saveDeduction(withLedger(sn.schedule), { ...d, assign: assignFrom(next, d, sn.schedule) }) }))}
                  options={[
                    { value: '', label: 'Выберите, с кого удержать' },
                    ...(onShift.length > 1 ? [{ value: 'split', label: `Поровну: ${onShift.map(short).join(' и ')}`, hint: 'были на смене в этот день' }] : []),
                    ...staff.filter(p => isActive(p) || p.id === v).map(p => ({ value: p.id, label: p.name, hint: onShift.includes(p.id) ? 'был(а) на смене' : undefined })),
                    { value: 'skip', label: 'Не удерживать с сотрудников' },
                  ]}
                />
                <span className={s.muted} style={{ color: d.assign ? 'var(--text)' : 'var(--warning)' }}>{result}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DeductionDialog({ snap, id, onClose, onSave, onRemove }: { snap: Snap; id?: string; onClose: () => void; onSave: (d: Deduction) => void; onRemove: (id: string) => void }) {
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const old = id ? (data.deductions ?? []).find(x => x.id === id) : undefined;
  const [kind, setKind] = useState(old?.kind ?? DEDUCTION_KINDS[0]);
  const [amount, setAmount] = useState(old ? moneyInput(old.amount) : '');
  const [date, setDate] = useState(old?.date ?? todayYmd());
  const [shk, setShk] = useState(old?.shk ?? '');
  const [who, setWho] = useState(old ? assignValue(old) : '');
  const [status, setStatus] = useState<Deduction['status']>(old?.status ?? 'held');
  const [returnedAt, setReturnedAt] = useState(old?.returnedAt ?? todayYmd());
  const [note, setNote] = useState(old?.note ?? '');
  const [err, setErr] = useState('');
  const onShift = shiftsOn(data, date).map(x => x.staffId);
  const short = (i: string) => (staff.find(p => p.id === i)?.name ?? '?').split(/\s+/)[0];

  const save = () => {
    const a = Math.round(parseMoney(amount) ?? 0);
    if (!(a > 0)) return setErr('Укажите сумму удержания');
    if (who === 'split' && !onShift.length) return setErr(`На смене ${dayMonth(date)} никого — выберите сотрудника`);
    if (data.closed[monthKey(date)] && !old) return setErr('Этот месяц закрыт — выберите дату в открытом месяце');
    const base: Deduction = { id: old?.id ?? newId(), kind, amount: a, date, assign: null, status };
    const d: Deduction = { ...base, assign: assignFrom(who, base, data) };
    if (shk.trim()) d.shk = shk.trim();
    if (status === 'returned') d.returnedAt = returnedAt;
    if (note.trim()) d.note = note.trim();
    onSave(d);
    onClose();
  };

  return (
    <Modal open onOpenChange={o => !o && onClose()} title={old ? 'Изменить удержание' : 'Добавить удержание'} description="Перепишите данные из уведомления в кабинете ПВЗ.">
      <div className={s.form}>
        <div className={s.formGrid}>
          <div><label className={s.label} htmlFor="dd-k">За что</label><div style={{ marginTop: 6 }}><Dropdown id="dd-k" label="За что" value={kind} onChange={setKind} options={DEDUCTION_KINDS.map(k => ({ value: k, label: k }))} /></div></div>
          <div><label className={s.label} htmlFor="dd-a">Сумма, ₽</label><Input id="dd-a" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} style={{ marginTop: 6 }} /></div>
          <div><label className={s.label} htmlFor="dd-d">Дата удержания</label><Input id="dd-d" type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} style={{ marginTop: 6 }} /></div>
          <div><label className={s.label} htmlFor="dd-s">ШК товара, если есть</label><Input id="dd-s" value={shk} onChange={e => setShk(e.target.value)} style={{ marginTop: 6 }} /></div>
        </div>
        <div>
          <label className={s.label} htmlFor="dd-w">С кого удержать</label>
          <div style={{ marginTop: 6 }}>
            <Dropdown id="dd-w" label="С кого удержать" value={who} onChange={setWho} options={[
              ...staff.filter(p => isActive(p) || p.id === who).map(p => ({ value: p.id, label: p.name })),
              { value: 'split', label: `Поровну на тех, кто был на смене ${dayMonth(date)}` },
              { value: '', label: 'Пока не знаю — решу позже' },
              { value: 'skip', label: 'Не удерживать с сотрудников' },
            ]} />
          </div>
          <p className={s.muted} style={{ marginTop: 6 }}>{who === 'split' ? `На смене ${dayMonth(date)}: ${onShift.map(short).join(', ') || 'никого — выберите сотрудника'}` : who === '' ? 'Сумма ни у кого не вычтется, пока вы не решите.' : ''}</p>
        </div>
        <div>
          <div className={s.label} style={{ marginBottom: 6 }}>Статус</div>
          <div className={s.choiceGrid} role="group" aria-label="Статус">
            {([['held', 'Удержано'], ['disputed', 'Оспариваю'], ['returned', 'WB вернул']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}>{l}</button>)}
          </div>
          <p className={s.muted} style={{ marginTop: 6 }}>{status === 'disputed' ? 'Пока идёт спор, сумма не вычитается.' : status === 'returned' ? 'Если месяц удержания уже закрыт, возврат придёт доплатой в месяце возврата.' : 'Вычтется из зарплаты в месяце удержания.'}</p>
          {status === 'returned' && <Input type="date" aria-label="Когда вернули" value={returnedAt} onChange={e => e.target.value && setReturnedAt(e.target.value)} style={{ width: 200, marginTop: 6 }} />}
        </div>
        <div><label className={s.label} htmlFor="dd-n">Комментарий</label><Input id="dd-n" placeholder="Например: выдала не тот товар" value={note} onChange={e => setNote(e.target.value)} style={{ marginTop: 6 }} /></div>
        {err && <p className={`${s.note} ${s.noteWarn}`} role="alert">{err}</p>}
        <div className={s.dialogActions}>
          {old && <Button variant="ghost" className={s.grow} onClick={() => { onRemove(old.id); onClose(); }}>Удалить</Button>}
          <Button variant="secondary" onClick={onClose}>Отмена</Button>
          <Button onClick={save}>{old ? 'Сохранить' : 'Добавить удержание'}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ───────── выплаты, премии, отмена ─────────

function PayDialog({ snap, month, staffId, type, onClose, onSave }: { snap: Snap; month: string; staffId?: string; type?: Payment['type']; onClose: () => void; onSave: (p: Omit<Payment, 'id'>) => void }) {
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const today = todayYmd();
  const current = month === monthKey(today);
  const people = staff.filter(p => isActive(p) || p.id === staffId);
  const [id, setId] = useState(staffId ?? people[0]?.id ?? '');
  const person = staff.find(x => x.id === id);
  // считаем за месяц, который открыт во вкладке: выплата из октября — это зарплата за октябрь
  const dueOf = (pid: string): Due | null => { const p = staff.find(x => x.id === pid); return p ? dueFor(p, data, month) : null; };
  const d = dueOf(id);
  const def: Payment['type'] = type ?? (current && d && d.advanceDue > 0 && Number(today.slice(8)) < data.payDay ? 'advance' : 'salary');
  const [t, setT] = useState<Payment['type']>(def);
  const suggest = (tt: Payment['type'], x: Due | null) => (!x ? '' : tt === 'advance' ? moneyInput(x.advanceDue || null) : tt === 'salary' ? moneyInput(x.due || null) : '');
  const [amount, setAmount] = useState(suggest(def, d));
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState<Payment['method']>('cash');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const paid = Math.round(parseMoney(amount) ?? 0);
  const short = person?.name.split(/\s+/)[0] ?? '';
  const forMonth = monthNom(month);
  const left = d ? (d.settledLater ? d.due : d.calc.left) : 0;

  const save = () => {
    if (!person) return setErr('Выберите сотрудника');
    if (!(paid > 0)) return setErr('Укажите сумму больше нуля');
    if (data.closed[month]) return setErr('Этот месяц закрыт — откройте его снова или запишите выплату в открытом месяце');
    const acc = payDate(month, date);
    onSave({ staffId: person.id, date: acc, ...(acc !== date ? { paidAt: date } : {}), type: t, amount: paid, method, note: note.trim() || TYPE_LABEL[t] });
    onClose();
  };

  const hint = !d ? ''
    : t === 'salary' && d.due <= 0 ? (d.settledLater
      ? `Остаток за ${forMonth} перешёл на следующий месяц и уже выплачен там — платить второй раз не нужно.`
      : `${short} за ${forMonth} выплачено всё. Выплату можно записать — она уйдёт в счёт будущей зарплаты.`)
    : t === 'salary' ? `${short}: за ${forMonth} осталось выплатить ${rub(d.due)} — сумма подставлена. Можно выдать часть: остальное останется за пунктом и перейдёт на следующий месяц.`
    : t === 'advance' ? (d.calc.advancePaid ? `Аванс за ${forMonth} уже выдан: ${rub(d.calc.advancePaid)}. Если выдаёте ещё раз, сумма вычтется из зарплаты.` : `Сумма посчитана по правилу аванса из настроек: ${rub(d.calc.advance)}. Её можно изменить.`)
    : 'Деньги в любой день по просьбе сотрудника. Сумма вычтется из того, что осталось выплатить.';

  return (
    <Modal open onOpenChange={o => !o && onClose()} title={`Выплата за ${monthTitle(month).toLowerCase()}`} description="Отметьте деньги, которые вы отдали сотруднику. Сайт сам ничего не переводит, он только ведёт счёт.">
      <div className={s.form}>
        <div><label className={s.label} htmlFor="pd-s">Кому</label><div style={{ marginTop: 6 }}><Dropdown id="pd-s" label="Кому" value={id} onChange={v => { setId(v); setAmount(suggest(t, dueOf(v))); }} options={people.map(p => ({ value: p.id, label: p.name }))} /></div></div>
        <div>
          <div className={s.label} style={{ marginBottom: 6 }}>Что это за выплата</div>
          <div className={s.choiceGrid} role="group" aria-label="Что это за выплата">
            {(['advance', 'salary', 'other'] as const).map(k => <button key={k} type="button" aria-pressed={t === k} onClick={() => { setT(k); setAmount(suggest(k, d)); }}>{TYPE_LABEL[k]}</button>)}
          </div>
          <p className={s.note} style={{ marginTop: 8 }}>{hint}</p>
        </div>
        <div className={s.formGrid}>
          <div><label className={s.label} htmlFor="pd-a">Сумма, ₽</label><Input id="pd-a" inputMode="decimal" value={amount} placeholder="впишите сумму" onChange={e => setAmount(e.target.value)} style={{ marginTop: 6, fontWeight: 600 }} /></div>
          <div><label className={s.label} htmlFor="pd-d">Когда выдали</label><Input id="pd-d" type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} style={{ marginTop: 6 }} /></div>
        </div>
        {d && d.due > 0 && (
          <div className={s.pills}>
            <button type="button" className={s.pill} onClick={() => setAmount(moneyInput(d.due))}>Весь остаток, {rub(d.due)}</button>
            <button type="button" className={s.pill} onClick={() => setAmount(moneyInput(Math.round(d.due / 2)))}>Половина, {rub(d.due / 2)}</button>
          </div>
        )}
        <div className={s.formGrid}>
          <div><label className={s.label} htmlFor="pd-m">Как выдали</label><div style={{ marginTop: 6 }}><Dropdown id="pd-m" label="Как выдали" value={method} onChange={setMethod} options={(Object.keys(PAY_METHOD) as Payment['method'][]).map(k => ({ value: k, label: METHOD_LABEL[k] }))} /></div></div>
          <div><label className={s.label} htmlFor="pd-n">Заметка, если нужна</label><Input id="pd-n" placeholder="например, попросила раньше" value={note} onChange={e => setNote(e.target.value)} style={{ marginTop: 6 }} /></div>
        </div>
        {d && <div className={s.total}><span>После этой выплаты останется получить за {forMonth}</span><b>{rub(left - paid)}</b></div>}
        {err && <p className={`${s.note} ${s.noteWarn}`} role="alert">{err}</p>}
        <div className={s.dialogActions}>
          <span className={`${s.muted} ${s.grow}`}>Ошиблись? Запись можно отменить в журнале.</span>
          <Button variant="secondary" onClick={onClose}>Отмена</Button>
          <Button onClick={save}>{paid ? `Записать выплату ${rub(paid)}` : 'Записать выплату'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function MassPayDialog({ snap, month, onClose, onSave }: { snap: Snap; month: string; onClose: () => void; onSave: (list: Omit<Payment, 'id'>[]) => void }) {
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const today = todayYmd();
  const current = month === monthKey(today);
  const rows = payrollPeople(staff, data, month).map(p => ({ p, d: dueFor(p, data, month) })).filter(r => isActive(r.p) || r.d.due > 0);
  const [kind, setKind] = useState<'advance' | 'salary'>(current && Number(today.slice(8)) < data.payDay ? 'advance' : 'salary');
  const auto = (d: Due) => (kind === 'advance' ? d.advanceDue : d.due);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [off, setOff] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState<Payment['method']>('card');
  const [date, setDate] = useState(today);
  const value = (p: StaffEntry, d: Due) => (amounts[`${kind}:${p.id}`] !== undefined ? Math.round(parseMoney(amounts[`${kind}:${p.id}`]) ?? 0) : auto(d));
  const chosen = rows.filter(r => !off.has(r.p.id) && value(r.p, r.d) > 0);
  const total = chosen.reduce((a, r) => a + value(r.p, r.d), 0);
  const forMonth = monthTitle(month).toLowerCase();

  return (
    <Modal open onOpenChange={o => !o && onClose()} size="lg" title={kind === 'advance' ? `Выплатить аванс всем за ${forMonth}` : `Выплатить зарплату всем за ${forMonth}`} description="Суммы подставлены сами — в каждой строке их можно поправить. В журнал попадёт отдельная запись на каждого.">
      <div className={s.form}>
        <div className={s.choiceGrid} role="group" aria-label="Что выплачиваем">
          <button type="button" aria-pressed={kind === 'advance'} onClick={() => setKind('advance')}>Аванс по правилу</button>
          <button type="button" aria-pressed={kind === 'salary'} onClick={() => setKind('salary')}>Зарплата — весь остаток</button>
        </div>
        <Table>
          <thead><tr><th /><th>Сотрудник</th><th className={s.num}>{kind === 'advance' ? 'Аванс по правилу' : 'Осталось'}</th><th>Выдаём, ₽</th></tr></thead>
          <tbody>
            {rows.map(({ p, d }) => {
              const a = auto(d);
              const key = `${kind}:${p.id}`;
              return (
                <tr key={p.id}>
                  <td><input type="checkbox" aria-label={`Выплатить: ${p.name}`} checked={!off.has(p.id)} onChange={e => setOff(x => { const n = new Set(x); if (e.target.checked) n.delete(p.id); else n.add(p.id); return n; })} style={{ width: 20, height: 20, accentColor: 'var(--accent)' }} /></td>
                  <td>{p.name}{d.calc.noRate && <small className={s.gWarn}> · ставка не указана</small>}</td>
                  <td className={s.num}>{a ? rub(a) : <span className={s.muted}>{kind === 'salary' && d.settledLater ? 'уже выплачено позже' : 'нечего выплачивать'}</span>}</td>
                  <td style={{ width: 140 }}><Input aria-label={`Сумма: ${p.name}`} inputMode="decimal" value={amounts[key] ?? moneyInput(a || null)} disabled={off.has(p.id)} onChange={e => setAmounts(m => ({ ...m, [key]: e.target.value }))} /></td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <div className={s.formGrid}>
          <div><label className={s.label} htmlFor="mp-m">Как выдали</label><div style={{ marginTop: 6 }}><Dropdown id="mp-m" label="Как выдали" value={method} onChange={setMethod} options={(Object.keys(PAY_METHOD) as Payment['method'][]).map(k => ({ value: k, label: METHOD_LABEL[k] }))} /></div></div>
          <div><label className={s.label} htmlFor="mp-d">Когда выдали</label><Input id="mp-d" type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} style={{ marginTop: 6 }} /></div>
        </div>
        <div className={s.total}><span>Выбрано сотрудников: {chosen.length} из {rows.length}</span><b>{rub(total)}</b></div>
        <div className={s.dialogActions}>
          <Button variant="secondary" onClick={onClose}>Отмена</Button>
          <Button disabled={!total} onClick={() => {
            const acc = payDate(month, date);
            onSave(chosen.map(r => ({ staffId: r.p.id, date: acc, ...(acc !== date ? { paidAt: date } : {}), type: kind, amount: value(r.p, r.d), method, note: kind === 'advance' ? 'Аванс' : 'Зарплата' })));
            onClose();
          }}>{total ? `Выплатить ${rub(total)}` : 'Никто не выбран'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function AdjDialog({ snap, staffId, t, onClose, onSave }: { snap: Snap; staffId?: string; t: 'bonus' | 'fine' | 'correction'; onClose: () => void; onSave: (a: { staffId: string; date: string; amount: number; reason: string; kind?: 'correction' }, parts: number) => void }) {
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const people = staff.filter(isActive);
  const [id, setId] = useState(staffId ?? people[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayYmd());
  const [reason, setReason] = useState('');
  const [parts, setParts] = useState('1');
  const [err, setErr] = useState('');
  const T = {
    bonus: ['Премия', 'Добавится к начислениям.', 'Например: помогла разобрать большую приёмку'],
    fine: ['Штраф', 'Вычтется из зарплаты. Удержания WB вводятся на вкладке «Удержания WB».', 'Например: опоздание на 40 минут'],
    correction: ['Исправление', 'Исправляет закрытый месяц, не меняя его сумм. Плюс — доплатить, минус — удержать.', 'Например: в октябре не учли половину смены 14-го'],
  }[t];

  const save = () => {
    let a = Math.round(parseMoney(amount.replace(/^[+−-]/, m => (m === '+' ? '' : '-')).replace('−', '-')) ?? 0);
    if (!id) return setErr('Выберите сотрудника');
    if (!a || (t !== 'correction' && a < 0)) return setErr('Укажите сумму');
    if (!reason.trim()) return setErr('Напишите причину — она попадёт в листок сотрудника');
    if (data.closed[monthKey(date)]) return setErr('Этот месяц закрыт — выберите дату в открытом месяце');
    if (t === 'fine') a = -a;
    onSave({ staffId: id, date, amount: a, reason: reason.trim(), kind: t === 'correction' ? 'correction' : undefined }, t === 'fine' ? Number(parts) : 1);
    onClose();
  };

  return (
    <Modal open onOpenChange={o => !o && onClose()} title={T[0]} description={T[1]}>
      <div className={s.form}>
        <div><label className={s.label} htmlFor="ad-s">Сотрудник</label><div style={{ marginTop: 6 }}><Dropdown id="ad-s" label="Сотрудник" value={id} onChange={setId} options={people.map(p => ({ value: p.id, label: p.name }))} /></div></div>
        <div className={s.formGrid}>
          <div><label className={s.label} htmlFor="ad-a">Сумма, ₽{t === 'correction' ? ' (со знаком)' : ''}</label><Input id="ad-a" inputMode="decimal" placeholder={t === 'correction' ? '+600 или −600' : '500'} value={amount} onChange={e => setAmount(e.target.value)} style={{ marginTop: 6 }} /></div>
          <div><label className={s.label} htmlFor="ad-d">Дата</label><Input id="ad-d" type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} style={{ marginTop: 6 }} /></div>
        </div>
        <div><label className={s.label} htmlFor="ad-r">Причина</label><Input id="ad-r" placeholder={T[2]} value={reason} onChange={e => setReason(e.target.value)} style={{ marginTop: 6 }} /><p className={s.muted} style={{ marginTop: 6 }}>Сотрудник увидит её в листке.</p></div>
        {t === 'fine' && (
          <div><label className={s.label} htmlFor="ad-p">Как удержать</label><div style={{ marginTop: 6 }}>
            <Dropdown id="ad-p" label="Как удержать" value={parts} onChange={setParts} options={[{ value: '1', label: 'Сразу, в этом месяце' }, { value: '2', label: 'Частями за 2 месяца' }, { value: '3', label: 'Частями за 3 месяца' }]} />
          </div></div>
        )}
        {err && <p className={`${s.note} ${s.noteWarn}`} role="alert">{err}</p>}
        <div className={s.dialogActions}><Button variant="secondary" onClick={onClose}>Отмена</Button><Button onClick={save}>Добавить: {T[0].toLowerCase()}</Button></div>
      </div>
    </Modal>
  );
}

function CancelDialog({ snap, what, id, onClose, onSave }: { snap: Snap; what: 'payment' | 'adjust'; id: string; onClose: () => void; onSave: (why: string) => void }) {
  const data = snap.schedule;
  const [why, setWhy] = useState('');
  const p = what === 'payment' ? (data.payments ?? []).find(x => x.id === id) : undefined;
  const a = what === 'adjust' ? data.adjustments.find(x => x.id === id) : undefined;
  const rec = p ?? a;
  if (!rec) return null;
  const who = snap.staff.staff_list.find(x => x.id === rec.staffId)?.name ?? 'сотрудник';
  const label = p ? TYPE_LABEL[p.type] : a!.kind === 'correction' ? 'Исправление' : a!.amount > 0 ? 'Премия' : 'Штраф';
  return (
    <Modal open onOpenChange={o => !o && onClose()} title="Отменить запись?" description={`${label}, ${who}, ${rub(Math.abs(rec.amount))}, ${dayMonth(rec.date)}`}>
      <div className={s.form}>
        <p className={s.muted}>Запись останется в журнале зачёркнутой, а суммы пересчитаются без неё.</p>
        <div><label className={s.label} htmlFor="cn-w">Почему отменяете</label><Input id="cn-w" placeholder="Например: записал два раза" value={why} onChange={e => setWhy(e.target.value)} style={{ marginTop: 6 }} /></div>
        <div className={s.dialogActions}><Button variant="secondary" onClick={onClose}>Не отменять</Button><Button variant="danger" onClick={() => { onSave(why.trim() || 'без причины'); onClose(); }}>Отменить запись</Button></div>
      </div>
    </Modal>
  );
}

// ───────── закрытие месяца ─────────

function CloseDialog({ snap, month, onClose, onSave, onGo }: { snap: Snap; month: string; onClose: () => void; onSave: () => void; onGo: (to: Dlg | 'deductions') => void }) {
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const today = todayYmd();
  const rows = payrollPeople(staff, data, month).map(p => ({ p, c: monthCalc(p, data, month) }));
  const und = undecided(data, month);
  const noRate = rows.filter(r => r.c.noRate);
  const goodsMissing = rows.filter(r => paysShk(r.p) && range(monthStart(month), month === monthKey(today) ? today : monthEnd(month)).some(d => shiftOf(data, d, r.p.id) && !shkCountOn(data, r.p.id, d)));
  const future = month === monthKey(today) ? range(addDays(today, 1), monthEnd(month)).filter(d => shiftsOn(data, d).length).length : 0;
  const debts = rows.filter(r => r.c.left !== 0);
  const next = monthTitle(shiftMonth(month, 1)).split(' ')[0].toLowerCase();
  const sum = (f: (c: MonthCalc) => number) => rows.reduce((a, r) => a + f(r.c), 0);
  const Check = ({ ok, warn, children, action }: { ok: boolean; warn?: boolean; children: ReactNode; action?: ReactNode }) => (
    <div className={`${s.check} ${ok ? '' : warn ? s.checkWarn : s.checkBad}`}>
      <span aria-hidden="true" style={{ fontWeight: 700 }}>{ok ? '✓' : '!'}</span>
      <span style={{ flex: 1 }}>{children}</span>
      {!ok && action}
    </div>
  );
  return (
    <Modal open onOpenChange={o => !o && onClose()} size="lg" title={`Закрыть ${monthTitle(month).toLowerCase()}`} description="Закрытие подводит итог месяца. Делайте его, когда со всеми рассчитались.">
      <div className={s.form}>
        <div className={s.checks}>
          <div className={s.label}>Проверка перед закрытием</div>
          <Check ok={!und.length} action={<Button size="sm" variant="secondary" onClick={() => onGo('deductions')}>Решить</Button>}>{und.length ? `Не решено, с кого удержать: ${und.length}` : 'Все удержания WB распределены'}</Check>
          <Check ok={!noRate.length}>{noRate.length ? `Без ставки: ${noRate.map(r => r.p.name).join(', ')} — их смены оплачиваются по 0 ₽` : 'У всех, кто работал, указана ставка'}</Check>
          <Check ok={!goodsMissing.length} warn action={<Button size="sm" variant="secondary" onClick={() => onGo({ kind: 'goods' })}>Ввести</Button>}>{goodsMissing.length ? `Не введены принятые товары: ${goodsMissing.map(r => r.p.name).join(', ')}` : 'Принятые товары введены за все рабочие дни'}</Check>
          <Check ok={!future} warn>{future ? `Впереди ещё дней со сменами: ${future}. Обычно месяц закрывают после ${dayMonth(monthEnd(month))}.` : 'Все смены месяца прошли'}</Check>
          {debts.map(r => (
            <Check key={r.p.id} ok={false} warn>{r.c.left > 0 ? `${r.p.name}: не выплачено ${rub(r.c.left)}. Это не мешает закрытию — остаток перейдёт на ${next}.` : `${r.p.name}: выплачено больше на ${rub(-r.c.left)} — разница вычтется в следующем месяце.`}</Check>
          ))}
        </div>
        <div className={s.stats}>
          <div className={s.statBox}><span>Начислено</span><b>{rub(sum(c => c.earned + c.bonus + c.creditSum))}</b></div>
          <div className={s.statBox}><span>Удержано</span><b>{rub(sum(c => c.fine + c.heldSum))}</b></div>
          <div className={s.statBox}><span>Выплачено</span><b>{rub(sum(c => c.paid))}</b></div>
          <div className={`${s.statBox} ${s.statAccent}`}><span>Перейдёт на {next}</span><b>{rub(sum(c => c.left))}</b></div>
        </div>
        <ul className={s.muted} style={{ paddingLeft: 18 }}>
          <li>остатки появятся у сотрудников в следующем месяце в столбце «Перешло»</li>
          <li>смены и выплаты месяца нельзя будет изменить случайно</li>
          <li>если нашлась ошибка, месяц можно открыть снова или внести исправление в следующем</li>
        </ul>
        <div className={s.dialogActions}><Button variant="secondary" onClick={onClose}>Отмена</Button><Button onClick={() => { onSave(); onClose(); }}>Закрыть {monthTitle(month).toLowerCase()}</Button></div>
      </div>
    </Modal>
  );
}

// ───────── листок сотрудника ─────────

function SheetDialog({ snap, staffId, month, readOnly, onClose, onDlg }: { snap: Snap; staffId: string; month: string; readOnly: boolean; onClose: () => void; onDlg: (d: Dlg) => void }) {
  const data = snap.schedule;
  const person = snap.staff.staff_list.find(p => p.id === staffId);
  if (!person) return null;
  const c = monthCalc(person, data, month);
  const lines = sheetLines(c, person, data, month);
  const closed = Boolean(data.closed[month]) || readOnly;
  return (
    <Modal open onOpenChange={o => !o && onClose()} title={person.name} description={`Листок за ${monthTitle(month).toLowerCase()}`}>
      <div className={s.lines}>
        {lines.map((l, i) => (
          <div key={i} className={s.line}><span>{l.name}{l.note && <small>{l.note}</small>}</span><b className={l.sum < 0 ? s.minus : ''}>{signed(l.sum)}</b></div>
        ))}
      </div>
      <div className={s.total}><span>Осталось выплатить</span><b>{rub(c.left)}</b></div>
      {c.planUnits > 0 && <p className={s.muted} style={{ marginTop: 10 }}>По графику до конца месяца ещё {unitsText(c.planUnits)} смен{c.planEarned ? `, это ${rub(c.planEarned)}` : ''}. К зарплате выйдет примерно {rub(c.forecast)}.</p>}
      <div className={s.dialogActions} style={{ marginTop: 16 }}>
        <Button variant="secondary" onClick={() => printSlip(person, c, lines, month)}>Печать</Button>
        {!closed && isActive(person) && (
          <>
            <Button variant="secondary" onClick={() => onDlg({ kind: 'adj', staffId, t: 'fine' })}>Штраф</Button>
            <Button variant="secondary" onClick={() => onDlg({ kind: 'adj', staffId, t: 'bonus' })}>Премия</Button>
            <Button onClick={() => onDlg({ kind: 'pay', staffId })}>Выплатить{c.left > 0 ? ` ${rub(c.left)}` : ''}</Button>
          </>
        )}
      </div>
    </Modal>
  );
}

type Line = { name: string; note?: string; sum: number };

function sheetLines(c: MonthCalc, p: StaffEntry, data: ScheduleData, month: string): Line[] {
  const out: Line[] = [];
  if (!c.beforeLedger) out.push({ name: `Перешло с ${monthGen(shiftMonth(month, -1))}`, note: c.opening ? undefined : 'долга нет', sum: c.opening });
  if (paysShk(p)) out.push({ name: 'Принятые товары', note: `${c.shk} шт.${c.shkDays[0] ? ` по ${rub(c.shkDays[0].rate)}` : ''}`, sum: c.earned });
  else out.push({ name: 'Смены', note: `${unitsText(c.units)} смен`, sum: c.earned });
  for (const a of c.bonuses) out.push({ name: a.kind === 'correction' ? 'Исправление' : 'Премия', note: `${dayMonth(a.date)}, ${a.reason}`, sum: a.amount });
  for (const a of c.fines) out.push({ name: a.kind === 'correction' ? 'Исправление' : 'Штраф', note: `${dayMonth(a.date)}, ${a.reason}`, sum: a.amount });
  for (const h of c.held) out.push({ name: 'Удержание WB', note: `${dayMonth(h.d.date)}, ${h.d.kind.toLowerCase()}${h.d.assign?.type === 'split' ? ', поровну' : ''}`, sum: -h.amount });
  for (const h of c.credits) out.push({ name: 'WB вернул удержание', note: dayMonth(h.d.date), sum: h.amount });
  for (const pay of c.payments) out.push({ name: TYPE_LABEL[pay.type], note: `${dayMonth(paidOn(pay))}, ${METHOD_LABEL[pay.method].toLowerCase()}`, sum: -pay.amount });
  void data;
  return out;
}

function slipHtml(p: StaffEntry, c: MonthCalc, lines: Line[], month: string): string {
  return `<section><h1>${escapeHtml(p.name)}</h1><p>Листок за ${escapeHtml(monthTitle(month).toLowerCase())}</p>
    <table><tbody>${lines.map(l => `<tr><td>${escapeHtml(l.name)}${l.note ? `<br><small>${escapeHtml(l.note)}</small>` : ''}</td><td class="n">${escapeHtml(signed(l.sum))}</td></tr>`).join('')}
    <tr><th>${c.left < 0 ? 'Сотрудник должен пункту' : 'Осталось выплатить'}</th><th class="n">${escapeHtml(rub(Math.abs(c.left)))}</th></tr></tbody></table></section>`;
}

function printSlip(p: StaffEntry, c: MonthCalc, lines: Line[], month: string) {
  printHtml(`Листок ${p.name}`, slipHtml(p, c, lines, month));
}

// ───────── отчёты ─────────

/** Печать всех листков, свод для Excel и расходы на зарплату по месяцам. */
function Reports({ snap, month }: { snap: Snap; month: string }) {
  const data = snap.schedule;
  const staff = snap.staff.staff_list;
  const toast = useToast();
  const rows = payrollPeople(staff, data, month).map(p => ({ p, c: monthCalc(p, data, month) }));
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
  const [from, setFrom] = useState(shiftMonth(month, -2));
  const totals = months.map(m => payrollPeople(staff, data, m).reduce((a, p) => { const c = monthCalc(p, data, m); return a + c.earned + c.bonus + c.creditSum - c.fine - c.heldSum; }, 0));
  const max = Math.max(1, ...totals) * 1.15;

  const sheets = () => printHtml(`Расчётные листки — ${monthTitle(month)}`, rows.map(({ p, c }) => slipHtml(p, c, sheetLines(c, p, data, month), month)).join(''));
  const copySummary = async () => {
    const lines = [['Месяц', 'Сотрудник', 'Остаток на начало', 'Начислено', 'Премии', 'Штрафы', 'Удержания WB', 'Выплачено', 'Остаток'].join('\t')];
    for (const m of months.filter(x => x >= from && x <= month)) {
      for (const p of payrollPeople(staff, data, m)) {
        const c = monthCalc(p, data, m);
        lines.push([monthTitle(m), p.name, c.opening, c.earned, c.bonus + c.creditSum, c.fine, c.heldSum, c.paid, c.left].join('\t'));
      }
    }
    const ok = await copyText(lines.join('\n'));
    toast(ok ? `Скопировано строк: ${lines.length - 1}. Вставьте в Excel` : 'Не удалось скопировать — разрешите доступ к буферу обмена', ok ? 'success' : 'error');
  };

  const W = 520, H = 200, pl = 56, pb = 26, bw = 44, step = (W - pl - 16) / months.length;
  const ticks = [0, 0.5, 1].map(x => Math.round((max * x) / 1000) * 1000);
  return (
    <div className={s.reports}>
      <section className={s.block}>
        <div className={s.blockHead}><h2>Ведомость на выплату</h2></div>
        <p className={s.muted} style={{ marginBottom: 12 }}>{monthTitle(month)}, с колонкой для подписи. Суммы — сколько осталось выплатить.</p>
        <Button variant="secondary" disabled={!rows.length} onClick={() => printPayout(rows, month, data)}>Печать ведомости</Button>
      </section>
      <section className={s.block}>
        <div className={s.blockHead}><h2>Расчётные листки</h2></div>
        <p className={s.muted} style={{ marginBottom: 12 }}>На каждого сотрудника: что перешло с прошлого месяца, начисления, удержания, выплаты и остаток.</p>
        <Button variant="secondary" disabled={!rows.length} onClick={sheets}>Печать всех листков</Button>
      </section>
      <section className={s.block}>
        <div className={s.blockHead}><h2>Свод за период</h2></div>
        <p className={s.muted} style={{ marginBottom: 12 }}>Все суммы по людям и месяцам — для бухгалтера или проверки. Копируется таблицей и вставляется в Excel.</p>
        <div className={s.toolbar} style={{ marginBottom: 0 }}>
          <div style={{ width: 190 }}><Dropdown label="С какого месяца" value={from} onChange={setFrom} options={months.map(m => ({ value: m, label: monthTitle(m) }))} /></div>
          <span className={s.muted}>по {monthTitle(month).toLowerCase()}</span>
          <Button variant="secondary" onClick={copySummary}>Скопировать для Excel</Button>
        </div>
      </section>
      <section className={s.block}>
        <div className={s.blockHead}><h2>Расходы на зарплату</h2></div>
        <p className={s.muted} style={{ marginBottom: 8 }}>Начислено за вычетом штрафов и удержаний, по месяцам.</p>
        <svg viewBox={`0 0 ${W} ${H}`} className={s.chart} role="img" aria-label={`Расходы на зарплату по месяцам: ${months.map((m, i) => `${monthTitle(m)} — ${rub(Math.max(0, totals[i]))}`).join(', ')}`}>
          {ticks.map(x => { const y = H - pb - (x / max) * (H - pb - 14); return <g key={x}><line x1={pl} x2={W - 8} y1={y} y2={y} stroke="var(--border)" /><text x={pl - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">{Math.round(x / 1000)} тыс</text></g>; })}
          {months.map((m, i) => {
            const v = Math.max(0, totals[i]); const h = (v / max) * (H - pb - 14); const x = pl + step * i + (step - bw) / 2;
            return (
              <g key={m}>
                <rect x={x} y={H - pb - h} width={bw} height={h} rx={4} fill="var(--accent)" />
                {v > 0 && <text x={x + bw / 2} y={H - pb - h - 6} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text)">{Math.round(v / 1000)} тыс</text>}
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="11.5" fill="var(--text-muted)">{monthTitle(m).slice(0, 3)}</text>
              </g>
            );
          })}
        </svg>
      </section>
    </div>
  );
}

function printPayout(rows: { p: StaffEntry; c: MonthCalc }[], month: string, data: ScheduleData) {
  void data;
  printHtml(`Ведомость ${monthTitle(month)}`, `<h1>Ведомость за ${escapeHtml(monthTitle(month).toLowerCase())}</h1><p>Начислено — за отработанные дни.</p>
    <table><thead><tr><th>Сотрудник</th><th>Начислено</th><th>Удержано</th><th>Выплачено</th><th>К выплате</th><th>Подпись</th></tr></thead><tbody>
    ${rows.map(({ p, c }) => `<tr><td>${escapeHtml(p.name)}</td><td class="n">${escapeHtml(rub(c.earned + c.bonus + c.creditSum))}</td><td class="n">${escapeHtml(rub(c.fine + c.heldSum))}</td><td class="n">${escapeHtml(rub(c.paid))}</td><td class="n"><b>${escapeHtml(rub(c.left))}</b></td><td class="sign"></td></tr>`).join('')}
    </tbody></table>`);
}

// ───────── принятые товары ─────────

export function GoodsDialog({ docs, month, onClose }: { docs: StaffDocs; month: string; onClose: () => void }) {
  const snap = docs.snap!;
  const data = snap.schedule;
  const people = snap.staff.staff_list.filter(p => paysShk(p) && (isActive(p) || range(monthStart(month), monthEnd(month)).some(d => shkCountOn(data, p.id, d))));
  const [who, setWho] = useState(people[0]?.id ?? '');
  const person = people.find(p => p.id === who);
  const days = range(monthStart(month), monthEnd(month));
  const today = todayYmd();
  const closed = Boolean(data.closed[month]) || docs.caps?.edit === false;
  const set = (day: string, text: string) => {
    const t = text.replace(/\D/g, '');
    docs.update(sn => ({ ...sn, schedule: setShkCount(sn.schedule, who, day, t ? Number(t) : null) }));
  };
  const paste = (e: ClipboardEvent<HTMLInputElement>, day: string) => {
    const lines = e.clipboardData.getData('text').split(/\r?\n/).map(x => x.trim()).filter((x, i, a) => x || i < a.length - 1);
    if (lines.length < 2) return;
    e.preventDefault();
    const from = days.indexOf(day);
    docs.update(sn => {
      let next = sn.schedule;
      lines.forEach((l, i) => {
        const d = days[from + i];
        if (!d) return;
        const n = l.split(/\t/)[0].replace(/\D/g, '');
        next = setShkCount(next, who, d, n ? Number(n) : null);
      });
      return { ...sn, schedule: next };
    });
  };
  const total = person ? days.reduce((a, d) => a + (shkCountOn(data, who, d)?.n ?? 0), 0) : 0;
  const money = person ? days.reduce((a, d) => a + (shkCountOn(data, who, d)?.n ?? 0) * shkPriceOn(person, data, d), 0) : 0;

  return (
    <Modal open onOpenChange={o => !o && onClose()} size="lg" title="Принятые товары" description={`${monthTitle(month)}. Введите, сколько товаров сотрудник принял за день — зарплата посчитается сама: количество умножается на цену.`}>
      {people.length === 0 ? <p className={s.note}>Никому не платят за принятые товары. Это меняется в карточке сотрудника во вкладке «Люди».</p> : (
        <div className={s.form}>
          {people.length > 1 && <div style={{ maxWidth: 320 }}><Dropdown label="Сотрудник" value={who} onChange={setWho} options={people.map(p => ({ value: p.id, label: p.name }))} /></div>}
          {person && <p className={s.muted}>{person.name}: {rub(shkPriceOn(person, data, today))} за каждый принятый товар. Скопируйте столбец чисел из Excel или кабинета WB, щёлкните по первому дню и нажмите Ctrl+V — числа встанут по дням сверху вниз.</p>}
          <div className={s.goods}>
            {days.map(d => {
              const shift = shiftOf(data, d, who);
              const missing = Boolean(shift) && d <= today && !shkCountOn(data, who, d);
              return (
                <label key={d} className={s.goodsDay}>
                  <span style={{ color: missing ? 'var(--warning)' : undefined, fontWeight: shift ? 600 : 400 }}>{Number(d.slice(8))} {['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'][(new Date(d).getDay() + 6) % 7]}</span>
                  <Input inputMode="numeric" aria-label={`Принято товаров ${dayMonth(d)}`} disabled={closed} value={String(shkCountOn(data, who, d)?.n ?? '')} onChange={e => set(d, e.target.value)} onPaste={e => paste(e, d)} style={missing ? { borderColor: 'var(--warning)', background: 'var(--warning-soft)' } : undefined} />
                </label>
              );
            })}
          </div>
          <div className={s.stats}>
            <div className={s.statBox}><span>Принято за месяц</span><b>{total}</b></div>
            <div className={`${s.statBox} ${s.statAccent}`}><span>Начислено</span><b>{rub(money)}</b></div>
          </div>
          <p className={s.muted}>Выделенные дни — у сотрудника стоит смена, а количество ещё не введено.</p>
        </div>
      )}
      <div className={s.dialogActions} style={{ marginTop: 16 }}><Button onClick={onClose}>Готово</Button></div>
    </Modal>
  );
}
