import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, Camera } from 'lucide-react';
import { Alert, Button, EmptyState, Modal, Spinner } from '../../ui';
import { type T, useT } from '../../i18n';
import { ApiError } from '../../api/client';
import { wbImageUrls } from '../../lib/wb-image';
import {
  type ClientMatch,
  type ClientQr,
  type GoodMark,
  type MatchReason,
  type PvzEvent,
  type PvzGood,
  type PvzGoodBase,
  type PvzGoods,
  issueClientQr,
  isWbLoginRequired,
  searchClients,
  searchClientsByPhoto,
  useChargePreview,
} from '../../api/pvz-web';
import s from './PvzWebApp.module.css';

/** Кому показываем QR: клиент и, если известна, его ячейка. */
export type QrTarget = { sid: string; cell: string; name: string };
/** Переходы между страницами веб-версии: путь после /cabinet/pvz-web. */
export type Go = (path: string) => void;

const LONG_DAYS = 7;

function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10, mod100 = n % 100;
  return mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
}
const daysText = (t: T, n: number) => t(`${n} ${plural(n, 'день', 'дня', 'дней')}`, `${n} күн`);
const goodsText = (t: T, n: number) => t(`${n} ${plural(n, 'товар', 'товара', 'товаров')}`, `${n} тауар`);
const money = (value: number) => `${Math.round(value).toLocaleString('ru-RU')} ₽`;
const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const clientLabel = (t: T, name: string, tail: string) => name || (tail ? `${t('Тел.', 'Тел.')} …${tail}` : t('Клиент', 'Клиент'));

/** День события по местному времени: ключ для группировки и подпись. */
function dayOf(iso: string) {
  const d = new Date(iso);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { key, label: d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }), time: d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) };
}

function DaysBadge({ days }: { days: number | null }) {
  const t = useT();
  if (days == null) return null;
  return <span className={`${s.days} ${days > LONG_DAYS ? s.daysLong : ''}`}>{daysText(t, days)}</span>;
}

/** Фото товара с серверов WB. Не открылось на расчётном сервере — пробуем соседние, потом оставляем пустую рамку. */
function GoodThumb({ nm, small = false }: { nm: number | null; small?: boolean }) {
  const urls = useMemo(() => (nm ? wbImageUrls(nm) : []), [nm]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [nm]);
  return (
    <span className={`${s.thumb} ${small ? s.thumbSmall : ''}`} aria-hidden="true">
      {attempt < urls.length && <img src={urls[attempt]} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setAttempt(attempt + 1)} />}
    </span>
  );
}

function Marks({ marks }: { marks: GoodMark[] }) {
  const t = useT();
  if (!marks.length) return null;
  const names: Record<GoodMark, string> = {
    declined: t('отказ', 'бас тарту'),
    utilization: t('утилизация', 'кәдеге жарату'),
    unpaid: t('не оплачен', 'төленбеген'),
    tryon: t('примерка', 'киіп көру'),
    defect: t('брак', 'ақау'),
    repack: t('переупаковать', 'қайта орау'),
    to_seller: t('возврат продавцу', 'сатушыға қайтару'),
  };
  const alert: GoodMark[] = ['declined', 'defect', 'repack', 'utilization'];
  return <span className={s.marks}>{marks.map(m => <span key={m} className={`${s.mark} ${alert.includes(m) ? s.markAlert : ''}`}>{names[m]}</span>)}</span>;
}

const goodDetails = (g: PvzGoodBase) => [g.brand, g.size, g.color].filter(Boolean).join(' · ');

function GoodCard({ good, children }: { good: PvzGoodBase & { marks?: GoodMark[] }; children?: ReactNode }) {
  const t = useT();
  return (
    <div className={s.good}>
      <GoodThumb nm={good.nm} />
      <div className={s.goodBody}>
        <div className={s.goodTitle}>{good.title || t('Товар', 'Тауар')}</div>
        {goodDetails(good) && <div className={s.goodMeta}>{goodDetails(good)}</div>}
        <div className={s.goodMeta}>{[good.shk && `${t('ШК', 'ШК')} ${good.shk}`, good.nm && `${t('арт.', 'арт.')} ${good.nm}`].filter(Boolean).join(' · ')}</div>
        {good.marks && <Marks marks={good.marks} />}
        <div className={s.goodFoot}>
          {good.price != null && <span className={s.goodPrice}>{money(good.price)}</span>}
          {children}
        </div>
      </div>
    </div>
  );
}

function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return <button type="button" className={s.back} onClick={onClick}><ArrowLeft size={18} aria-hidden="true" />{label}</button>;
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return <div className={s.stat}><div className={s.statLabel}>{label}</div><div className={s.statValue}>{value}</div></div>;
}

// ---------- история: группы «клиент · день · ячейка · что сделал» ----------

type EventGroup = { key: string; kind: PvzEvent['kind']; sid: string; tail: string; cell: string; at: string; items: PvzEvent[]; sum: number };

function groupEvents(events: PvzEvent[]): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const e of events) {
    const key = `${dayOf(e.at).key}|${e.sid}|${e.cell}|${e.kind}`;
    const g = groups.get(key) ?? { key, kind: e.kind, sid: e.sid, tail: e.tail, cell: e.cell, at: e.at, items: [], sum: 0 };
    g.items.push(e);
    g.sum += e.price ?? 0;
    groups.set(key, g);
  }
  return [...groups.values()];
}

function HistoryList({ groups, show, go }: { groups: EventGroup[]; show: 'client' | 'cell'; go: Go }) {
  const t = useT();
  return (
    <div className={s.history}>
      {groups.map(g => {
        const day = dayOf(g.at);
        const what = g.kind === 'received'
          ? t(`забрал ${goodsText(t, g.items.length)} на ${money(g.sum)}`, `${goodsText(t, g.items.length)} алды, ${money(g.sum)}`)
          : t(`отказ: ${goodsText(t, g.items.length)} на ${money(g.sum)}`, `бас тарту: ${goodsText(t, g.items.length)}, ${money(g.sum)}`);
        return (
          <div key={g.key} className={s.historyItem}>
            <div className={s.historyHead}>
              <span className={s.historyDate}>{day.label}, {day.time}</span>
              {show === 'client'
                ? <button type="button" className={s.inlineLink} onClick={() => go(`client/${g.sid}`)}>{clientLabel(t, '', g.tail)}</button>
                : g.cell && <button type="button" className={s.inlineLink} onClick={() => go(`cell/${encodeURIComponent(g.cell)}`)}>{t('ячейка', 'ұяшық')} {g.cell}</button>}
              <span className={`${s.mark} ${g.kind === 'returned' ? s.markAlert : s.markOk}`}>{what}</span>
            </div>
            <ul className={s.historyGoods}>
              {g.items.map((e, i) => <li key={`${e.shk}-${i}`}>{e.title || t('Товар', 'Тауар')}{e.brand ? ` · ${e.brand}` : ''}{e.price != null ? ` · ${money(e.price)}` : ''}</li>)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

const depthNote = (t: T) => t('WB отдаёт выдачи и возвраты примерно за последние две недели — более ранней истории в веб-версии нет.', 'WB беру мен қайтаруларды шамамен соңғы екі аптаға береді — одан ертерек тарих веб-нұсқада жоқ.');

// ---------- Ячейки ----------

export function CellsScreen({ data, go }: { data: PvzGoods; go: Go }) {
  const t = useT();
  const stats = useMemo(() => ({
    cells: new Set(data.cells.map(c => c.cell)).size,
    clients: new Set(data.cells.map(c => c.sid)).size,
    long: data.cells.filter(c => (c.days ?? 0) > LONG_DAYS).length,
  }), [data.cells]);

  if (!data.cells.length) {
    return <EmptyState title={t('В пункте сейчас нет товаров', 'Пунктте қазір тауар жоқ')} text={t('WB не вернул ни одного товара в ячейках. Если это не так — нажмите «Обновить».', 'WB ұяшықтарда бірде-бір тауар қайтармады. Олай болмаса — «Жаңарту» түймесін басыңыз.')} />;
  }
  return (
    <>
      <div className={s.titleRow}><h1 className={s.h1}>{t('Ячейки', 'Ұяшықтар')}</h1></div>
      <div className={s.stats}>
        <Stat label={t('Занято ячеек', 'Бос емес ұяшықтар')} value={stats.cells} />
        <Stat label={t('Клиентов', 'Клиенттер')} value={stats.clients} />
        <Stat label={t('Товаров в пункте', 'Пункттегі тауарлар')} value={data.goodsCount} />
        <Stat label={t('Лежат дольше 7 дней', '7 күннен артық жатыр')} value={stats.long} />
      </div>
      <div className={s.cellGrid}>
        {data.cells.map(c => (
          <button key={`${c.cell}|${c.sid}`} type="button" className={s.cellCard} onClick={() => go(`cell/${encodeURIComponent(c.cell)}`)}>
            <span className={s.cellTop}><span className={s.cellNum}>{c.cell}</span><DaysBadge days={c.days} /></span>
            <span className={s.cellBody}>
              <span className={s.cellName}>{clientLabel(t, c.name, c.tail)}</span>
              <span className={s.cellMeta}>{goodsText(t, c.goods.length)}{c.name && c.tail ? ` · ${t('тел.', 'тел.')} …${c.tail}` : ''}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

// ---------- страница ячейки ----------

export function CellPage({ data, cell, go, onQr }: { data: PvzGoods; cell: string; go: Go; onQr: (target: QrTarget) => void }) {
  const t = useT();
  const current = data.cells.filter(c => c.cell === cell);
  const history = useMemo(() => groupEvents(data.events.filter(e => e.cell === cell)), [data.events, cell]);
  return (
    <>
      <BackButton onClick={() => go('')} label={t('Все ячейки', 'Барлық ұяшықтар')} />
      <div className={s.titleRow}><h1 className={s.pageTitle}>{t('Ячейка', 'Ұяшық')} {cell}</h1></div>
      {!current.length && <div className={s.hintBox}>{t('Сейчас в этой ячейке ничего не лежит.', 'Қазір бұл ұяшықта ештеңе жоқ.')}</div>}
      {current.map(c => (
        <section key={c.sid} className={s.card}>
          <div className={s.cardHead}>
            <div>
              <div className={s.h2}>{clientLabel(t, c.name, c.tail)}</div>
              <div className={s.cellMeta}>{t('ID клиента', 'Клиент ID')} <span className={s.mono}>{c.sid}</span> · {goodsText(t, c.goods.length)}{c.goods.some(g => g.price != null) ? ` · ${money(c.goods.reduce((sum, g) => sum + (g.price ?? 0), 0))}` : ''}</div>
            </div>
            <DaysBadge days={c.days} />
          </div>
          <div className={s.actions}>
            <Button onClick={() => onQr({ sid: c.sid, cell: c.cell, name: c.name })}>{t('QR-код клиента', 'Клиенттің QR-коды')}</Button>
            <Button variant="secondary" onClick={() => go(`client/${c.sid}`)}>{t('Досье клиента', 'Клиент досьесі')}</Button>
          </div>
          <div className={s.goodGrid}>{c.goods.map((g, i) => <GoodCard key={`${g.shk}-${i}`} good={g}><DaysBadge days={g.days} /></GoodCard>)}</div>
        </section>
      ))}
      <section className={s.card}>
        <div className={s.h2}>{t('Кто был в ячейке раньше', 'Ұяшықта бұрын кім болды')}</div>
        {history.length ? <HistoryList groups={history} show="client" go={go} />
          : <p className={s.muted}>{t('За последние недели из этой ячейки ничего не выдавали и не возвращали.', 'Соңғы апталарда бұл ұяшықтан ештеңе берілмеген және қайтарылмаған.')}</p>}
        <p className={s.note}>{depthNote(t)}</p>
      </section>
    </>
  );
}

// ---------- досье клиента ----------

export function ClientPage({ data, sid, go, onQr }: { data: PvzGoods; sid: string; go: Go; onQr: (target: QrTarget) => void }) {
  const t = useT();
  const current = data.cells.filter(c => c.sid === sid);
  const events = useMemo(() => data.events.filter(e => e.sid === sid), [data.events, sid]);
  const history = useMemo(() => groupEvents(events), [events]);
  const received = events.filter(e => e.kind === 'received');
  const returned = events.filter(e => e.kind === 'returned');
  const tail = current[0]?.tail || events[0]?.tail || '';
  const name = current[0]?.name || '';
  const total = received.length + returned.length;
  const sum = (list: PvzEvent[]) => list.reduce((acc, e) => acc + (e.price ?? 0), 0);
  const inPoint = current.reduce((acc, c) => acc + c.goods.length, 0);

  return (
    <>
      <BackButton onClick={() => window.history.back()} label={t('Назад', 'Артқа')} />
      <div className={s.titleRow}>
        <h1 className={s.pageTitle}>{clientLabel(t, name, tail)}</h1>
        <span className={s.muted}>{t('ID клиента', 'Клиент ID')} <span className={s.mono}>{sid}</span></span>
      </div>
      {!current.length && !events.length ? (
        <EmptyState title={t('По этому клиенту ничего нет', 'Бұл клиент бойынша ештеңе жоқ')} text={depthNote(t)} />
      ) : (
        <>
          <div className={s.stats}>
            <Stat label={t('Сейчас в пункте', 'Қазір пунктте')} value={goodsText(t, inPoint)} />
            <Stat label={t('Забрал', 'Алды')} value={<>{received.length} <span className={s.statSub}>{money(sum(received))}</span></>} />
            <Stat label={t('Отказался', 'Бас тартты')} value={<>{returned.length} <span className={s.statSub}>{money(sum(returned))}</span></>} />
            <Stat label={t('Выкуп', 'Сатып алу')} value={total ? `${Math.round((received.length / total) * 100)}%` : '—'} />
          </div>
          <div className={s.actions}>
            <Button onClick={() => onQr({ sid, cell: current.length === 1 ? current[0].cell : '', name })}>{t('QR-код клиента', 'Клиенттің QR-коды')}</Button>
          </div>
          {current.map(c => (
            <section key={c.cell} className={s.card}>
              <div className={s.cardHead}>
                <button type="button" className={`${s.h2} ${s.inlineLink}`} onClick={() => go(`cell/${encodeURIComponent(c.cell)}`)}>{t('Ячейка', 'Ұяшық')} {c.cell}</button>
                <DaysBadge days={c.days} />
              </div>
              <div className={s.goodGrid}>{c.goods.map((g, i) => <GoodCard key={`${g.shk}-${i}`} good={g}><DaysBadge days={g.days} /></GoodCard>)}</div>
            </section>
          ))}
          <section className={s.card}>
            <div className={s.h2}>{t('Получения и отказы', 'Алулар мен бас тартулар')}</div>
            {history.length ? <HistoryList groups={history} show="cell" go={go} /> : <p className={s.muted}>{t('За последние недели клиент ничего не забирал и не возвращал.', 'Соңғы апталарда клиент ештеңе алмаған және қайтармаған.')}</p>}
            <p className={s.note}>{depthNote(t)}</p>
          </section>
        </>
      )}
    </>
  );
}

// ---------- Все товары / Залежавшиеся / Дорогие ----------

const PAGE = 200;
export type GoodsMode = 'all' | 'stale' | 'expensive';
const THRESHOLDS: Record<Exclude<GoodsMode, 'all'>, number[]> = { stale: [7, 10, 14], expensive: [3000, 5000, 10000] };

export function GoodsScreen({ data, mode, go }: { data: PvzGoods; mode: GoodsMode; go: Go }) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [threshold, setThreshold] = useState(mode === 'all' ? 0 : THRESHOLDS[mode][0]);
  useEffect(() => { setThreshold(mode === 'all' ? 0 : THRESHOLDS[mode][0]); setFilter(''); }, [mode]);
  const rows = useMemo(() => {
    const all: (PvzGood & { cell: string; sid: string; client: string; tail: string })[] = data.cells.flatMap(c => c.goods.map(g => ({ ...g, cell: c.cell, sid: c.sid, client: c.name, tail: c.tail })));
    if (mode === 'stale') return all.filter(r => (r.days ?? 0) > threshold).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
    if (mode === 'expensive') return all.filter(r => (r.price ?? 0) >= threshold).sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    return all;
  }, [data.cells, mode, threshold]);
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(() => (needle
    ? rows.filter(r => r.cell.toLowerCase() === needle || r.shk.includes(needle) || String(r.nm ?? '') === needle || r.title.toLowerCase().includes(needle) || r.brand.toLowerCase().includes(needle))
    : rows), [rows, needle]);
  useEffect(() => setLimit(PAGE), [needle, mode, threshold]);
  const title = mode === 'stale' ? t('Залежавшиеся', 'Ұзақ жатқандар') : mode === 'expensive' ? t('Дорогие', 'Қымбаттар') : t('Все товары', 'Барлық тауарлар');
  const total = rows.reduce((acc, r) => acc + (r.price ?? 0), 0);

  return (
    <>
      <div className={s.titleRow}>
        <h1 className={s.h1}>{title}</h1>
        <span className={s.muted}>{goodsText(t, rows.length)} · {money(total)}</span>
      </div>
      <div className={s.toolbar}>
        {mode !== 'all' && (
          <div className={s.segments} role="group" aria-label={mode === 'stale' ? t('Сколько дней лежит', 'Неше күн жатыр') : t('Цена от', 'Бағасы бастап')}>
            {THRESHOLDS[mode].map(v => (
              <button key={v} type="button" className={`${s.segment} ${threshold === v ? s.segmentActive : ''}`} aria-pressed={threshold === v} onClick={() => setThreshold(v)}>
                {mode === 'stale' ? t(`дольше ${v} дней`, `${v} күннен артық`) : t(`от ${money(v)}`, `${money(v)} бастап`)}
              </button>
            ))}
          </div>
        )}
        <input className={s.filterInput} value={filter} onChange={e => setFilter(e.target.value)} placeholder={t('Ячейка, ШК, артикул, название или бренд', 'Ұяшық, ШК, артикул, атауы немесе бренд')} aria-label={t('Фильтр товаров', 'Тауарлар сүзгісі')} />
      </div>
      {!shown.length ? (
        <EmptyState title={t('Таких товаров нет', 'Мұндай тауар жоқ')} text={needle ? t('Попробуйте другой запрос.', 'Басқа сұраныс жасап көріңіз.') : mode === 'stale' ? t('Залежавшихся товаров нет — отлично.', 'Ұзақ жатқан тауар жоқ — тамаша.') : t('В пункте нет товаров под это условие.', 'Пунктте бұл шартқа сай тауар жоқ.')} />
      ) : (
        <div className={s.table}>
          <div className={s.rowHead}>
            <span>{t('Ячейка', 'Ұяшық')}</span><span /><span>{t('Товар', 'Тауар')}</span><span>{t('Цена', 'Бағасы')}</span>
            <span>{t('ШК', 'ШК')}</span><span>{t('Клиент', 'Клиент')}</span><span>{t('В пункте', 'Пунктте')}</span>
          </div>
          {shown.slice(0, limit).map((r, i) => (
            <div key={`${r.cell}-${r.shk}-${i}`} className={s.row}>
              <button type="button" className={`${s.rowCell} ${s.inlineLink}`} onClick={() => go(`cell/${encodeURIComponent(r.cell)}`)} aria-label={`${t('Ячейка', 'Ұяшық')} ${r.cell}`}>{r.cell}</button>
              <span className={s.rowThumb}><GoodThumb nm={r.nm} small /></span>
              <span className={s.rowTitle}>{r.title || t('Товар', 'Тауар')}{goodDetails(r) && <span className={s.rowSub}>{goodDetails(r)}</span>}<Marks marks={r.marks} /></span>
              <span className={s.rowBrand}>{r.price != null ? money(r.price) : ''}</span>
              <span className={`${s.rowShk} ${s.mono}`}>{r.shk}</span>
              <button type="button" className={`${s.rowClient} ${s.inlineLink}`} onClick={() => go(`client/${r.sid}`)}>{clientLabel(t, r.client, r.tail)}</button>
              <span className={s.rowDays}><DaysBadge days={r.days} /></span>
            </div>
          ))}
        </div>
      )}
      {shown.length > limit && <Button variant="secondary" className={s.more} onClick={() => setLimit(limit + PAGE)}>{t('Показать ещё', 'Тағы көрсету')}</Button>}
    </>
  );
}

// ---------- Операции по дням ----------

const OPS_DAYS = 31;

export function OpsScreen({ data }: { data: PvzGoods }) {
  const t = useT();
  const { days, staff } = useMemo(() => {
    const byDay = new Map<string, { key: string; label: string; received: number; sum: number; returned: number; returnedSum: number; clients: Set<string> }>();
    const byStaff = new Map<string, { id: string; received: number; sum: number; returned: number }>();
    for (const e of data.events) {
      const day = dayOf(e.at);
      const d = byDay.get(day.key) ?? { key: day.key, label: day.label, received: 0, sum: 0, returned: 0, returnedSum: 0, clients: new Set<string>() };
      const who = byStaff.get(e.employee) ?? { id: e.employee, received: 0, sum: 0, returned: 0 };
      if (e.kind === 'received') { d.received += 1; d.sum += e.price ?? 0; d.clients.add(e.sid); who.received += 1; who.sum += e.price ?? 0; }
      else { d.returned += 1; d.returnedSum += e.price ?? 0; who.returned += 1; }
      byDay.set(day.key, d);
      byStaff.set(e.employee, who);
    }
    return {
      days: [...byDay.values()].sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, OPS_DAYS),
      staff: [...byStaff.values()].sort((a, b) => b.received - a.received),
    };
  }, [data.events]);

  if (!days.length) return <EmptyState title={t('Операций пока нет', 'Әзірге операция жоқ')} text={depthNote(t)} />;
  const totals = days.reduce((acc, d) => ({ received: acc.received + d.received, sum: acc.sum + d.sum, returned: acc.returned + d.returned }), { received: 0, sum: 0, returned: 0 });
  return (
    <>
      <div className={s.titleRow}><h1 className={s.h1}>{t('Операции по дням', 'Күндер бойынша операциялар')}</h1></div>
      <div className={s.stats}>
        <Stat label={t('Выдано товаров', 'Берілген тауарлар')} value={totals.received} />
        <Stat label={t('Оборот', 'Айналым')} value={money(totals.sum)} />
        <Stat label={t('Возвратов', 'Қайтарулар')} value={totals.returned} />
        <Stat label={t('Выкуп', 'Сатып алу')} value={totals.received + totals.returned ? `${Math.round((totals.received / (totals.received + totals.returned)) * 100)}%` : '—'} />
      </div>
      <div className={s.table}>
        <div className={`${s.opsRow} ${s.opsHead}`}>
          <span>{t('День', 'Күн')}</span><span>{t('Клиентов', 'Клиенттер')}</span><span>{t('Выдано', 'Берілді')}</span><span>{t('Оборот', 'Айналым')}</span><span>{t('Возвратов', 'Қайтарулар')}</span>
        </div>
        {days.map(d => (
          <div key={d.key} className={s.opsRow}>
            <span className={s.rowTitle}>{d.label}</span><span>{d.clients.size}</span><span>{d.received}</span><span>{money(d.sum)}</span><span>{d.returned}</span>
          </div>
        ))}
      </div>
      <div className={s.h2}>{t('По сотрудникам', 'Қызметкерлер бойынша')}</div>
      <div className={s.table}>
        <div className={`${s.opsRow} ${s.opsHead}`}>
          <span>{t('Сотрудник WB', 'WB қызметкері')}</span><span /><span>{t('Выдано', 'Берілді')}</span><span>{t('Оборот', 'Айналым')}</span><span>{t('Возвратов', 'Қайтарулар')}</span>
        </div>
        {staff.map(w => (
          <div key={w.id || 'none'} className={s.opsRow}>
            <span className={s.rowTitle}>{w.id ? `№ ${w.id}` : t('не указан', 'көрсетілмеген')}</span><span /><span>{w.received}</span><span>{money(w.sum)}</span><span>{w.returned}</span>
          </div>
        ))}
      </div>
      <p className={s.note}>{depthNote(t)} {t('Имён сотрудников WB здесь не отдаёт — показан номер сотрудника в WB. Приёмки, переупаковок и разбивки по часам в веб-версии нет — они есть в программе на ПК.', 'WB мұнда қызметкерлердің атын бермейді — WB-дегі қызметкер нөмірі көрсетілген. Қабылдау, қайта орау және сағат бойынша бөлу веб-нұсқада жоқ — олар ДК-дағы бағдарламада бар.')}</p>
    </>
  );
}

// ---------- Код клиента ----------

/** Фото этикетки уменьшаем в браузере: серверу для чтения ШК хватает 1600 px, а оригинал с телефона — 5–10 МБ. */
async function photoToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

function whyText(t: T, why: MatchReason[]) {
  const names: Record<MatchReason, string> = {
    cell: t('номер ячейки', 'ұяшық нөмірі'),
    sid: t('ID клиента', 'клиент ID'),
    shk: t('ШК товара', 'тауар ШК'),
    phone: t('телефон', 'телефон'),
  };
  return why.map(w => names[w]).join(', ');
}

type SearchResult = { matches: ClientMatch[]; note: string | null };

export function CodeScreen({ go, onQr, onWbLost }: { go: Go; onQr: (target: QrTarget) => void; onWbLost: () => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const failed = (error: unknown) => { if (isWbLoginRequired(error)) onWbLost(); };

  const textSearch = useMutation({
    mutationFn: async (q: string): Promise<SearchResult> => ({ matches: (await searchClients(q)).matches, note: null }),
    onError: failed,
  });
  const photoSearch = useMutation({
    mutationFn: async (file: File): Promise<SearchResult> => {
      const out = await searchClientsByPhoto(await photoToDataUrl(file));
      return {
        matches: out.matches,
        note: out.codes.length
          ? t(`На фото распознан ШК ${out.codes.join(', ')}`, `Фотодан ШК танылды: ${out.codes.join(', ')}`)
          : t('На фото не нашли ШК. Сфотографируйте этикетку ближе и ровнее или введите ШК цифрами.', 'Фотодан ШК табылмады. Затбелгіні жақынырақ және түзу түсіріңіз немесе ШК-ны сандармен енгізіңіз.'),
      };
    },
    onError: failed,
  });
  // показываем результат того поиска, который запускали последним
  const [last, setLast] = useState<'text' | 'photo'>('text');
  const active = last === 'text' ? textSearch : photoSearch;
  const digits = query.replace(/\D/g, '');

  const runText = textSearch.mutate;
  useEffect(() => {
    if (digits.length < 2) return undefined;
    const timer = window.setTimeout(() => { setLast('text'); runText(digits); }, 400);
    return () => window.clearTimeout(timer);
  }, [digits, runText]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!digits) return;
    setLast('text');
    textSearch.mutate(digits);
  };
  const onFile = (file: File | undefined) => {
    if (!file) return;
    setQuery('');
    setLast('photo');
    photoSearch.mutate(file);
  };
  const idle = last === 'text' && digits.length < 2;

  return (
    <>
      <div className={s.titleRow}><h1 className={s.h1}>{t('Код клиента', 'Клиент коды')}</h1></div>
      <div className={s.codeColumn}>
        <form className={s.searchRow} onSubmit={submit}>
          <input
            className={s.searchInput} inputMode="numeric" autoFocus value={query} onChange={e => setQuery(e.target.value)}
            placeholder={t('Ячейка, конец телефона, ШК или ID клиента', 'Ұяшық, телефонның соңы, ШК немесе клиент ID')}
            aria-label={t('Ячейка, телефон, ШК или ID клиента', 'Ұяшық, телефон, ШК немесе клиент ID')}
          />
          <label className={s.photoButton} aria-disabled={photoSearch.isPending}>
            {photoSearch.isPending ? <Spinner size={18} /> : <Camera size={18} aria-hidden="true" />}
            {t('Фото этикетки', 'Затбелгі фотосы')}
            <input ref={fileRef} className={s.hiddenInput} type="file" accept="image/*" capture="environment" disabled={photoSearch.isPending}
              onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </form>

        {idle ? (
          <div className={s.hintBox}>
            {t('Введите номер ячейки, последние цифры телефона (от трёх), ШК товара или ID клиента. Или сфотографируйте этикетку — ШК распознаётся сам.',
              'Ұяшық нөмірін, телефонның соңғы сандарын (үштен бастап), тауар ШК-сын немесе клиент ID-ін енгізіңіз. Не затбелгіні суретке түсіріңіз — ШК өзі танылады.')}
          </div>
        ) : active.isPending ? (
          <div className={s.hintBox} role="status">{last === 'photo' ? t('Читаем ШК с фото…', 'Фотодан ШК оқып жатырмыз…') : t('Ищем клиента…', 'Клиентті іздеп жатырмыз…')}</div>
        ) : active.isError ? (
          <Alert tone="error">{errorText(active.error, t('Не удалось выполнить поиск', 'Іздеу орындалмады'))}</Alert>
        ) : active.data ? (
          <>
            {active.data.note && <Alert tone={active.data.matches.length ? 'success' : 'info'}>{active.data.note}</Alert>}
            {!active.data.matches.length && !(last === 'photo' && active.data.note) && (
              <EmptyState title={t('Никого не нашли', 'Ешкім табылмады')} text={t('В пункте нет клиента с таким номером. Проверьте цифры или обновите данные WB.', 'Пунктте мұндай нөмірлі клиент жоқ. Сандарды тексеріңіз немесе WB деректерін жаңартыңыз.')} />
            )}
            {active.data.matches.map(m => (
              <div key={m.sid} className={s.match}>
                <div className={s.matchCell}>{m.cells.join(', ') || '—'}</div>
                <div className={s.matchBody}>
                  <div><strong>{clientLabel(t, m.name, m.tail)}</strong><span className={s.why}>{t('совпал', 'сәйкес келді')}: {whyText(t, m.why)}</span></div>
                  <div className={s.cellMeta}>ID {m.sid}</div>
                </div>
                <Button variant="secondary" onClick={() => go(`client/${m.sid}`)}>{t('Досье', 'Досье')}</Button>
                <Button onClick={() => onQr({ sid: m.sid, cell: m.cells.length === 1 ? m.cells[0] : '', name: m.name })}>{t('Показать QR', 'QR көрсету')}</Button>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}

// ---------- QR клиента ----------

export function QrDialog({ target, onClose }: { target: QrTarget | null; onClose: () => void }) {
  const t = useT();
  const open = target !== null;
  const preview = useChargePreview(open);
  const issue = useMutation<ClientQr, unknown, QrTarget>({ mutationFn: tg => issueClientQr({ sid: tg.sid, cell: tg.cell || undefined }) });
  const reset = issue.reset;
  useEffect(() => { reset(); }, [target?.sid, reset]);

  if (!target) return null;
  const error = issue.error;
  const walletShort = error instanceof ApiError && error.code === 'WALLET_SHORT';
  const title = [target.name || t('Клиент', 'Клиент'), target.cell && `${t('ячейка', 'ұяшық')} ${target.cell}`].filter(Boolean).join(' · ');

  return (
    <Modal open={open} onOpenChange={v => { if (!v) onClose(); }} title={title} description={`${t('ID клиента', 'Клиент ID')} ${target.sid}`} sheet>
      <div className={s.qr}>
        {issue.data ? (
          <>
            <img className={s.qrImage} src={issue.data.image} alt={t('QR-код клиента', 'Клиенттің QR-коды')} />
            <div className={s.muted}>{issue.data.spent}</div>
            <div className={s.cellMeta}>{t('Код действует сегодня. Повторный показ этого клиента сегодня — без списания.', 'Код бүгін жарамды. Осы клиентті бүгін қайта көрсету — есептен шығарусыз.')}</div>
          </>
        ) : (
          <>
            <div className={s.qrPlaceholder}>{t('QR появится после нажатия кнопки', 'QR түймені басқаннан кейін пайда болады')}</div>
            {preview.isPending ? <div className={s.muted} role="status">{t('Проверяем, что спишется…', 'Не есептен шығатынын тексеріп жатырмыз…')}</div>
              : preview.data ? <div className={s.muted}>{preview.data.line}</div>
              : <div className={s.muted}>{t('Спишется 1 код из тарифа или пакета, если они есть.', 'Тарифтен немесе пакеттен 1 код есептен шығады, егер олар бар болса.')}</div>}
            {error != null && (
              <Alert tone="error">
                {errorText(error, t('Не удалось выдать код', 'Код берілмеді'))}
                {walletShort && <> <Link to="/cabinet/packages">{t('Пополнить баланс', 'Балансты толтыру')}</Link></>}
              </Alert>
            )}
            <Button block loading={issue.isPending} onClick={() => issue.mutate(target)}>{t('Показать QR-код', 'QR-кодты көрсету')}</Button>
          </>
        )}
      </div>
    </Modal>
  );
}
