import { useMemo, useState } from 'react';
import { Button, Input, Modal, useToast } from '../../../ui';
import { useIssueStaffLink, useStaffLink } from '../../../api/staff';
import {
  WEEKDAYS,
  addDays,
  exportSheets,
  fileName,
  monthEnd,
  monthKey,
  monthStart,
  monthTitle,
  range,
  scheduleText,
  shiftCode,
  shiftOf,
  todayYmd,
  weekStart,
  weekday,
  writeXlsx,
  isActive,
} from '../../../lib/staff-core';
import { copyText, downloadBlob, escapeHtml, printHtml, Dropdown } from './parts';
import type { Snap } from './useStaffDocs';
import s from './staff.module.css';

type Tab = 'excel' | 'list' | 'link';

export function ExportDialog({ snap, pointId, pointName, month, onClose, initial = 'excel' }: { snap: Snap; pointId: string; pointName: string; month: string; onClose: () => void; initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  const tabs: { id: Tab; name: string; sub: string }[] = [
    { id: 'excel', name: 'Таблица Excel', sub: 'Файл .xlsx: открыть, поправить, напечатать' },
    { id: 'list', name: 'Список текстом', sub: 'Вставить в мессенджер или сохранить' },
    { id: 'link', name: 'Ссылка для сотрудников', sub: 'График только для просмотра, без сумм' },
  ];
  return (
    <Modal open onOpenChange={o => !o && onClose()} size="lg" sheet title="Выгрузить график" description={`${pointName}, ${monthTitle(month).toLowerCase()}`}>
      <div className={s.choiceGrid} role="tablist" aria-label="Способ выгрузки" style={{ marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)} style={{ textAlign: 'left', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <b>{t.name}</b><small className={s.muted} style={{ fontWeight: 400 }}>{t.sub}</small>
          </button>
        ))}
      </div>
      {tab === 'excel' && <ExcelPart snap={snap} pointName={pointName} month={month} />}
      {tab === 'list' && <TextPart snap={snap} pointName={pointName} month={month} />}
      {tab === 'link' && <LinkPart pointId={pointId} />}
    </Modal>
  );
}

function ExcelPart({ snap, pointName, month }: { snap: Snap; pointName: string; month: string }) {
  const toast = useToast();
  const [timesheet, setTimesheet] = useState(true);
  const [list, setList] = useState(true);
  const [payroll, setPayroll] = useState(false);
  const staff = snap.staff.staff_list;
  const data = snap.schedule;
  const days = range(monthStart(month), monthEnd(month));
  const people = staff.filter(p => isActive(p) || days.some(d => shiftOf(data, d, p.id)));

  const download = () => {
    const sheets = exportSheets(staff, data, { pointName, month, timesheet, list, payroll });
    if (!sheets.length) return toast('Отметьте хотя бы один лист', 'error');
    const bytes = writeXlsx(sheets);
    downloadBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName(pointName, month, 'xlsx'));
  };

  const print = () => {
    const head = days.map(d => `<th style="text-align:center;padding:4px 2px">${Number(d.slice(8))}<br><small>${WEEKDAYS[weekday(d)].toLowerCase()}</small></th>`).join('');
    const rows = people.map(p => `<tr><td>${escapeHtml(p.name)}</td>${days.map(d => { const sh = shiftOf(data, d, p.id); return `<td style="text-align:center;padding:4px 2px">${sh ? escapeHtml(shiftCode(sh, data)) : ''}</td>`; }).join('')}</tr>`).join('');
    printHtml(`График ${pointName}`, `<h1>График: ${escapeHtml(pointName)}, ${escapeHtml(monthTitle(month).toLowerCase())}</h1><p>С — смена, У — утро, В — вечер, З — замена, «ч» — свои часы.</p><table style="font-size:11px"><thead><tr><th>Сотрудник</th>${head}</tr></thead><tbody>${rows}</tbody></table>`);
  };

  return (
    <div className={s.form}>
      <div className={s.label}>Что положить в файл</div>
      {[
        [timesheet, setTimesheet, 'st-x1', 'Табель: люди и дни месяца'],
        [list, setList, 'st-x2', 'Список по дням с часами'],
        [payroll, setPayroll, 'st-x3', 'Зарплата: начислено, выплачено, осталось'],
      ].map(([v, set, id, label]) => (
        <div key={id as string} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <input id={id as string} type="checkbox" checked={v as boolean} onChange={e => (set as (b: boolean) => void)(e.target.checked)} style={{ width: 20, height: 20, margin: 0, accentColor: 'var(--accent)' }} />
          <label htmlFor={id as string} style={{ fontSize: 14 }}>{label as string}</label>
        </div>
      ))}
      <p className={`${s.note} ${payroll ? s.noteWarn : ''}`}>{payroll ? 'В файле будут ставки и суммы — не отправляйте его сотрудникам.' : 'Без листа «Зарплата» в файле нет ни ставок, ни сумм. Такой файл можно спокойно отправлять сотрудникам.'}</p>
      <div className={s.dialogActions}>
        <Button variant="secondary" onClick={print}>Напечатать</Button>
        <Button onClick={download}>Скачать Excel</Button>
      </div>
    </div>
  );
}

function TextPart({ snap, pointName, month }: { snap: Snap; pointName: string; month: string }) {
  const toast = useToast();
  const today = todayYmd();
  const thisWeek = weekStart(month === monthKey(today) ? today : monthStart(month));
  const periods = {
    week: { label: `Неделя ${range(thisWeek, addDays(thisWeek, 6)).map(d => Number(d.slice(8)))[0]}–${Number(addDays(thisWeek, 6).slice(8))}`, days: range(thisWeek, addDays(thisWeek, 6)) },
    next: { label: 'Следующая неделя', days: range(addDays(thisWeek, 7), addDays(thisWeek, 13)) },
    month: { label: `Весь ${monthTitle(month).toLowerCase().split(' ')[0]}`, days: range(monthStart(month), monthEnd(month)) },
  };
  const [period, setPeriod] = useState<keyof typeof periods>('week');
  const [group, setGroup] = useState<'days' | 'people'>('days');
  const [shortNames, setShortNames] = useState(true);
  const text = useMemo(() => scheduleText(snap.staff.staff_list, snap.schedule, { pointName, days: periods[period].days, group, shortNames }), [snap, pointName, period, group, shortNames]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={s.form}>
      <div className={s.formGrid}>
        <div><label className={s.label} htmlFor="tx-p">За какой период</label><div style={{ marginTop: 6 }}><Dropdown id="tx-p" label="За какой период" value={period} onChange={setPeriod} options={(Object.keys(periods) as (keyof typeof periods)[]).map(k => ({ value: k, label: periods[k].label }))} /></div></div>
        <div>
          <div className={s.label} style={{ marginBottom: 6 }}>Как сгруппировать</div>
          <div className={s.choiceGrid} role="group" aria-label="Как сгруппировать">
            <button type="button" aria-pressed={group === 'days'} onClick={() => setGroup('days')}>По дням</button>
            <button type="button" aria-pressed={group === 'people'} onClick={() => setGroup('people')}>По людям</button>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input id="tx-short" type="checkbox" checked={shortNames} onChange={e => setShortNames(e.target.checked)} style={{ width: 20, height: 20, margin: 0, accentColor: 'var(--accent)' }} />
        <label htmlFor="tx-short" style={{ fontSize: 14 }}>Только имена, без фамилий</label>
      </div>
      <pre style={{ margin: 0, padding: 16, borderRadius: 10, background: 'var(--surface-muted)', border: '1px solid var(--border)', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{text}</pre>
      <div className={s.dialogActions}>
        <Button variant="secondary" onClick={() => downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), fileName(pointName, month, 'txt'))}>Сохранить как файл</Button>
        <Button onClick={async () => toast((await copyText(text)) ? 'Текст скопирован' : 'Не удалось скопировать — выделите текст вручную', 'success')}>Скопировать текст</Button>
      </div>
    </div>
  );
}

function LinkPart({ pointId }: { pointId: string }) {
  const toast = useToast();
  const link = useStaffLink(pointId);
  const issue = useIssueStaffLink(pointId);
  const [shortNames, setShortNames] = useState(true);
  const [showSubs, setShowSubs] = useState(true);
  if (link.isPending) return <p className={s.muted}>Загружаем…</p>;
  if (link.isError) return <p className={`${s.note} ${s.noteWarn}`}>Не удалось загрузить ссылку. <Button size="sm" variant="ghost" onClick={() => link.refetch()}>Повторить</Button></p>;
  const current = link.data.link;
  const make = (opts = { shortNames, showSubs }) => issue.mutate(opts, { onError: e => toast(e.message || 'Не удалось создать ссылку', 'error') });

  return (
    <div className={s.form}>
      {current ? (
        <>
          <div>
            <label className={s.label} htmlFor="ln-url">Ссылка на график пункта</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <Input id="ln-url" readOnly value={current.url} onFocus={e => e.target.select()} />
              <Button onClick={async () => toast((await copyText(current.url)) ? 'Ссылка скопирована' : 'Не удалось скопировать', 'success')}>Скопировать</Button>
            </div>
            <p className={s.muted} style={{ marginTop: 6, color: 'var(--success)' }}>Ссылка работает. Сотрудники всегда видят свежий график{current.shortNames ? ', только имена без фамилий' : ''}.</p>
          </div>
        </>
      ) : (
        <>
          <p className={s.muted}>Ссылка открывается без входа на сайт. Сотрудник видит график пункта на телефоне и может отфильтровать свои смены.</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input id="ln-short" type="checkbox" checked={shortNames} onChange={e => setShortNames(e.target.checked)} style={{ width: 20, height: 20, margin: 0, accentColor: 'var(--accent)' }} />
            <label htmlFor="ln-short" style={{ fontSize: 14 }}>Только имена, без фамилий</label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input id="ln-subs" type="checkbox" checked={showSubs} onChange={e => setShowSubs(e.target.checked)} style={{ width: 20, height: 20, margin: 0, accentColor: 'var(--accent)' }} />
            <label htmlFor="ln-subs" style={{ fontSize: 14 }}>Показывать, кто вышел на замену</label>
          </div>
        </>
      )}
      <div className={s.stats}>
        <div className={s.statBox}><span style={{ fontWeight: 600, color: 'var(--text)' }}>Сотрудник увидит</span><span>имена и смены всех, кто работает в пункте, часы и замены за прошлый, этот и следующий месяц</span></div>
        <div className={s.statBox}><span style={{ fontWeight: 600, color: 'var(--text)' }}>Сотрудник не увидит</span><span>ставки, начисления и выплаты, телефоны, номера WB и другие ваши пункты</span></div>
      </div>
      <div className={s.dialogActions}>
        {current ? (
          <>
            <Button variant="ghost" className={s.grow} loading={issue.isPending && issue.variables === null} onClick={() => issue.mutate(null)}>Отключить ссылку</Button>
            <Button variant="secondary" loading={issue.isPending && issue.variables !== null} onClick={() => make({ shortNames: current.shortNames, showSubs: current.showSubs })}>Выпустить новую</Button>
          </>
        ) : <Button loading={issue.isPending} onClick={() => make()}>Создать ссылку</Button>}
      </div>
      {current && <p className={s.muted}>Если ссылка попала не к тем людям, выпустите новую: старая сразу перестанет открываться.</p>}
    </div>
  );
}
