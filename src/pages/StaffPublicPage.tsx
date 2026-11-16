import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ApiError } from '../api/client';
import { usePublicSchedule } from '../api/staff';
import { useDocumentMeta } from '../lib/seo';
import { addDays, dayMonth, monthEnd, monthStart, todayYmd, weekStart, weekday } from '../lib/staff-core';
import s from './cabinet/staff/staff.module.css';

const WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WD_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const PALETTE = ['#7a5ce0', '#3d7fe6', '#e08a3c', '#1f9d92', '#e0517f', '#7fa83a', '#6b6f88', '#c9a227'];

/** /grafik/<token> — график пункта для сотрудников: без входа, без сумм и контактов (server/_staff.js). */
export function StaffPublicPage() {
  const { token = '' } = useParams();
  const q = usePublicSchedule(token);
  useDocumentMeta(q.data ? `График: ${q.data.point}` : 'График пункта');
  // ссылка личная: страница не должна попасть в поиск (robots.txt её тоже закрывает)
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  const [who, setWho] = useState<string>(() => {
    try { return localStorage.getItem(`grafik-who-${token}`) ?? ''; } catch { return ''; }
  });
  const today = todayYmd();
  const [start, setStart] = useState(() => weekStart(today));
  const pick = (k: string) => {
    setWho(k);
    try { localStorage.setItem(`grafik-who-${token}`, k); } catch { /* приватное окно */ }
  };
  const data = q.data;
  const first = data ? monthStart(data.months[0]) : '';
  const last = data ? monthEnd(data.months[data.months.length - 1]) : '';
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const nearest = useMemo(() => {
    if (!data || !who) return null;
    const day = Object.keys(data.days).filter(d => d >= today && data.days[d].some(x => x.k === who)).sort()[0];
    return day ? { day, h: data.days[day].find(x => x.k === who)!.h } : null;
  }, [data, who, today]);
  const name = (k: string) => data?.people.find(p => p.k === k)?.name ?? 'Сотрудник';
  const color = (k: string) => PALETTE[(Math.max(0, data?.people.findIndex(p => p.k === k) ?? 0)) % PALETTE.length];

  const shell = (children: ReactNode) => (
    <main style={{ minHeight: '100vh', background: 'var(--page)', fontFamily: 'var(--font-sans)', color: 'var(--text)' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '0 16px 32px' }}>{children}</div>
    </main>
  );

  if (q.isPending) return shell(<p className={s.muted} style={{ paddingTop: 40 }}>Загружаем график…</p>);
  if (q.isError) {
    const gone = q.error instanceof ApiError && q.error.status === 404;
    return shell(
      <div style={{ paddingTop: 48 }}>
        <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>{gone ? 'Ссылка не работает' : 'Не удалось открыть график'}</h1>
        <p className={s.muted}>{gone ? 'Владелец пункта выпустил новую ссылку или отключил эту. Попросите у него актуальную.' : q.error.message}</p>
        {!gone && <button type="button" className={s.pill} style={{ marginTop: 12 }} onClick={() => q.refetch()}>Попробовать ещё раз</button>}
      </div>,
    );
  }
  const d = data!;

  return shell(
    <>
      <header style={{ padding: '18px 0 12px', borderBottom: '1px solid var(--border)', marginBottom: 14 }}>
        <span className={s.muted}>График пункта выдачи</span>
        <h1 style={{ margin: '4px 0 0', fontSize: 24, letterSpacing: '-0.02em' }}>{d.point}</h1>
      </header>

      <div className={s.label} style={{ marginBottom: 8 }}>Чьи смены показать</div>
      <div className={s.pills} role="group" aria-label="Чьи смены показать" style={{ marginBottom: 14 }}>
        <button type="button" className={s.pill} aria-pressed={!who} onClick={() => pick('')}>Все</button>
        {d.people.map(p => <button key={p.k} type="button" className={s.pill} aria-pressed={who === p.k} onClick={() => pick(p.k)}>{p.name}</button>)}
      </div>

      {who && (
        <div style={{ padding: '14px 16px', borderRadius: 16, background: color(who), color: '#fff', marginBottom: 16 }}>
          <div style={{ fontSize: 13 }}>Ближайшая смена: {name(who)}</div>
          {nearest ? (
            <>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{WD_FULL[weekday(nearest.day)]}, {dayMonth(nearest.day)}</div>
              <div style={{ fontSize: 15 }}>с {nearest.h.replace('–', ' до ')}</div>
            </>
          ) : <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>Смен в ближайшие недели нет</div>}
        </div>
      )}

      <div className={s.monthNav} style={{ marginBottom: 10 }}>
        <button type="button" className={s.iconBtn} style={{ width: 44, height: 44 }} aria-label="Предыдущая неделя" disabled={addDays(start, -1) < first} onClick={() => setStart(addDays(start, -7))}><ChevronLeft size={18} /></button>
        <div className={s.monthTitle} style={{ flex: 1, fontSize: 16 }}>{dayMonth(days[0])} – {dayMonth(days[6])}</div>
        <button type="button" className={s.iconBtn} style={{ width: 44, height: 44 }} aria-label="Следующая неделя" disabled={addDays(start, 7) > last} onClick={() => setStart(addDays(start, 7))}><ChevronRight size={18} /></button>
      </div>

      <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
        {days.map((day, i) => {
          const list = d.days[day] ?? [];
          const owner = d.owner.includes(day);
          const mine = Boolean(who) && list.some(x => x.k === who);
          return (
            <div key={day} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 14px', minHeight: 56, borderTop: i ? '1px solid var(--surface-sunken)' : 0, background: mine ? 'var(--accent-soft)' : day === today ? 'var(--surface-muted)' : undefined }}>
              <span style={{ width: 44, flex: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 12, color: weekday(day) >= 5 ? 'var(--accent-dark)' : 'var(--text-muted)' }}>{WD[weekday(day)]}</span>
                <b style={{ fontSize: 18, lineHeight: 1 }}>{Number(day.slice(8))}</b>
              </span>
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 14 }}>
                {list.map(x => (
                  <span key={x.k} style={{ fontWeight: x.k === who ? 700 : 400 }}>{name(x.k)}, {x.h}{x.sub ? ` (за ${x.sub})` : ''}</span>
                ))}
                {owner && <span>Работает владелец</span>}
                {!list.length && !owner && <span className={s.muted}>В пункте никого нет</span>}
              </span>
            </div>
          );
        })}
      </section>
      <p className={s.muted} style={{ marginTop: 14, fontSize: 12 }}>
        {d.updatedAt ? `Обновлено ${new Date(d.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}. ` : ''}
        Смена с {d.dayHours.from} до {d.dayHours.to}. Если смена стоит неверно, напишите владельцу пункта.
      </p>
    </>,
  );
}
