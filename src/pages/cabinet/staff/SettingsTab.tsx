import { useState } from 'react';
import { Button, Input, Switch, useToast } from '../../../ui';
import { useRestoreStaffVersion, useStaffHistory } from '../../../api/staff';
import { moneyInput, parseClock, parseMoney, Dropdown } from './parts';
import type { DocKey, StaffDocs } from './useStaffDocs';
import { maxPerDay, type ScheduleData } from '../../../lib/staff-core';
import s from './staff.module.css';

const ADV_DAYS = ['5', '10', '12', '15', '20', '25'];
const PAY_DAYS = [{ value: '31', label: 'В последний день месяца' }, { value: '25', label: '25 числа' }, { value: '28', label: '28 числа' }, { value: '30', label: '30 числа' }];

export function SettingsTab({ docs, pointId, pointName }: { docs: StaffDocs; pointId: string; pointName: string }) {
  const data = docs.snap!.schedule;
  const set = (patch: Partial<ScheduleData>) => docs.update(sn => ({ ...sn, schedule: { ...sn.schedule, ...patch } }));
  const [from, setFrom] = useState(data.dayHours.from);
  const [to, setTo] = useState(data.dayHours.to);
  const [value, setValue] = useState(moneyInput(data.advanceRule.value || null));
  const [price, setPrice] = useState(moneyInput(data.shkPrice || null));
  const [hoursErr, setHoursErr] = useState('');
  const mode = data.advanceRule.mode;

  const commitHours = () => {
    const a = parseClock(from), b = parseClock(to);
    if (!a || !b || a >= b) {
      setHoursErr('Время «до» должно быть позже «с». Например: с 9:00 до 21:00.');
      return;
    }
    setHoursErr('');
    setFrom(a);
    setTo(b);
    if (a !== data.dayHours.from || b !== data.dayHours.to) set({ dayHours: { from: a, to: b } });
  };

  const example = mode === 'shifts'
    ? `Пример: к ${data.advanceRule.day} числу сотрудник отработал 7 смен по 2 500 ₽ — предложим выдать 17 500 ₽.`
    : mode === 'fixed' ? `Всем предлагается одинаковый аванс${data.advanceRule.value ? `: ${data.advanceRule.value.toLocaleString('ru-RU')} ₽` : ''}.`
    : `Пример: к ${data.advanceRule.day} числу начислено 17 500 ₽, при ${data.advanceRule.value || 50} % предложим ${Math.round(17500 * (data.advanceRule.value || 50) / 100).toLocaleString('ru-RU')} ₽.`;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 16, alignItems: 'start' }}>
      <section className={s.block}>
        <p className={s.muted} style={{ marginBottom: 12 }}>Настройки действуют только для пункта «{pointName}».</p>
        <div className={s.form}>
          <div>
            <div className={s.blockHead}><h2>Рабочий день</h2></div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, fontSize: 14 }}>
              <label htmlFor="se-from">Смена длится с</label>
              <Input id="se-from" className={s.timeInput} value={from} onChange={e => setFrom(e.target.value)} onBlur={commitHours} />
              <label htmlFor="se-to">до</label>
              <Input id="se-to" className={s.timeInput} value={to} onChange={e => setTo(e.target.value)} onBlur={commitHours} />
            </div>
            <p className={hoursErr ? `${s.note} ${s.noteWarn}` : s.muted} style={{ marginTop: 8 }}>{hoursErr || 'От этого считаются полсмены и свои часы: 6 часов из 12 оплачиваются как половина ставки.'}</p>
          </div>

          <div>
            <div className={s.blockHead}><h2>Сколько человек работает в пункте в один день</h2></div>
            <div style={{ maxWidth: 320 }}>
              <Dropdown label="Сколько человек работает в пункте в один день" value={String(maxPerDay(data))} onChange={v => set({ maxPerDay: Number(v) })}
                options={[{ value: '1', label: 'Один' }, { value: '2', label: 'Двое' }, { value: '3', label: 'Трое' }]} />
            </div>
            <p className={s.muted} style={{ marginTop: 8 }}>Если поставить в день больше людей, график предупредит и предложит заменить того, кто уже стоит. Меньше — можно: день считается закрытым, когда в пункте есть хотя бы один человек.</p>
          </div>

          <div>
            <div className={s.blockHead}><h2>Аванс и зарплата</h2></div>
            <div className={s.formGrid}>
              <div><label className={s.label} htmlFor="se-adv">День аванса</label><div style={{ marginTop: 6 }}><Dropdown id="se-adv" label="День аванса" value={String(data.advanceRule.day)} onChange={v => set({ advanceRule: { ...data.advanceRule, day: Number(v) } })} options={ADV_DAYS.map(d => ({ value: d, label: `${d} числа` }))} /></div></div>
              <div><label className={s.label} htmlFor="se-pay">День зарплаты</label><div style={{ marginTop: 6 }}><Dropdown id="se-pay" label="День зарплаты" value={String(PAY_DAYS.some(p => p.value === String(data.payDay)) ? data.payDay : 31)} onChange={v => set({ payDay: Number(v) })} options={PAY_DAYS} /></div></div>
              <div className={s.wide}><label className={s.label} htmlFor="se-mode">Сколько давать авансом</label><div style={{ marginTop: 6 }}>
                <Dropdown id="se-mode" label="Сколько давать авансом" value={mode} onChange={v => set({ advanceRule: { ...data.advanceRule, mode: v } })} options={[
                  { value: 'shifts', label: 'За смены, отработанные до аванса' },
                  { value: 'fixed', label: 'Фиксированная сумма' },
                  { value: 'percent', label: 'Процент от начисленного до аванса' },
                ]} />
              </div></div>
              {mode !== 'shifts' && (
                <div><label className={s.label} htmlFor="se-val">{mode === 'fixed' ? 'Сумма, ₽' : 'Процент'}</label><Input id="se-val" inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} onBlur={() => { const n = parseMoney(value) ?? 0; if (n !== data.advanceRule.value) set({ advanceRule: { ...data.advanceRule, value: n } }); }} style={{ marginTop: 6 }} /></div>
              )}
            </div>
            <p className={s.muted} style={{ marginTop: 8 }}>{example} Сумму при выплате можно изменить.</p>
          </div>

          <div>
            <div className={s.blockHead}><h2>Оплата за принятые товары</h2></div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, fontSize: 14 }}>
              <label htmlFor="se-price">За один принятый товар платим</label>
              <Input id="se-price" className={s.timeInput} inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} onBlur={() => { const n = parseMoney(price) ?? 0; if (n !== (data.shkPrice ?? 0)) set({ shkPrice: n }); }} />
              <span>₽</span>
            </div>
            <p className={s.muted} style={{ marginTop: 8 }}>Для тех, кому в карточке выбрано «За принятые товары». Отдельному сотруднику можно задать свою цену в его карточке.</p>
          </div>

          <div>
            <div className={s.blockHead}><h2>Удержания WB и продление графика</h2></div>
            <Switch checked={data.deductWb} onChange={e => set({ deductWb: e.target.checked })} description="Без этого удержания только записываются, зарплата не уменьшается.">Вычитать из зарплаты удержания WB, распределённые на сотрудников</Switch>
            <Switch checked={data.autoExtend} onChange={e => set({ autoExtend: e.target.checked })} description="Что добавилось, будет видно над табелем, и это можно убрать одним нажатием.">Продлевать график на следующий месяц по обычным режимам сотрудников</Switch>
          </div>
        </div>
      </section>

      <section className={s.block}>
        <div className={s.blockHead}><h2>История изменений</h2></div>
        <p className={s.muted} style={{ marginBottom: 8 }}>Если график или список людей испортили — верните состояние на нужный момент. Перед возвратом нынешнее тоже сохраняется, поэтому вернуть можно и обратно.</p>
        <History docs={docs} pointId={pointId} docKey="schedule" title="График и зарплата" />
        <History docs={docs} pointId={pointId} docKey="staff" title="Список сотрудников" />
      </section>
    </div>
  );
}

function History({ docs, pointId, docKey, title }: { docs: StaffDocs; pointId: string; docKey: DocKey; title: string }) {
  const history = useStaffHistory(pointId, docKey);
  const restore = useRestoreStaffVersion();
  const toast = useToast();
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : 'время неизвестно');
  return (
    <div style={{ marginTop: 12 }}>
      <div className={s.label}>{title}</div>
      {history.isPending ? <p className={s.muted}>Загружаем…</p> : history.isError ? (
        <p className={`${s.note} ${s.noteWarn}`}>Не удалось загрузить историю. <Button size="sm" variant="ghost" onClick={() => history.refetch()}>Повторить</Button></p>
      ) : !history.data.items.length ? <p className={s.muted}>Изменений пока не было.</p> : (
        <div className={s.lines}>
          {history.data.items.map(h => (
            <div key={h.version} className={s.line}>
              <span><b style={{ fontWeight: 600 }}>{when(h.at)}</b><small>{h.by === 'сайт' ? 'с сайта' : `компьютер «${h.by}»`}</small></span>
              {h.current ? <b style={{ color: 'var(--success)', fontSize: 12 }}>сейчас</b> : (
                <Button size="sm" variant="secondary" loading={restore.isPending && restore.variables?.version === h.version} onClick={() => restore.mutate({ point: pointId, key: docKey, version: h.version }, {
                  onSuccess: r => { docs.applyRestored(docKey, r.version, r.data); toast('Версия возвращена', 'success'); history.refetch(); },
                  onError: e => toast(e.message || 'Не удалось вернуть версию', 'error'),
                })}>Вернуть</Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
