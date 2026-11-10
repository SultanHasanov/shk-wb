import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Mail, MessageCircle, Monitor, RotateCw, Search, X } from 'lucide-react';
import { adminApi, auditUrl, useAdminAttention, useAdminAudit, useAdminDeliveries, useAdminRetryDelivery } from '../../api/admin';
import type { AdminAuditEntry, AdminAuditPage, AdminDelivery, AuditCategory, AuditFilters, DeliveryFilters } from '../../api/admin';
import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_ORDER,
  auditToCsv,
  formatMskTime,
  groupByDay,
  mskDayKeyOf,
} from '../../lib/admin-audit';
import { Badge, Button, Checkbox, Input, Select, Skeleton, useToast } from '../../ui';
import { AuditEntry, DataState, EmptyBlock, ResponsiveTable, errorText, newIdempotencyKey } from './kit';
import type { ResponsiveColumn } from './kit';
import s from '../../layout/AdminShell.module.css';

type Tab = 'actions' | 'deliveries';
type Period = 'today' | '7' | '30' | 'all' | 'custom';

const PERIODS: ReadonlyArray<{ value: Period; label: string }> = [
  { value: 'today', label: 'Сегодня' },
  { value: '7', label: '7 дней' },
  { value: '30', label: '30 дней' },
  { value: 'all', label: 'За всё время' },
  { value: 'custom', label: 'Своя дата' },
];

/** Полночь по Москве N дней назад. Москва без перехода на летнее время — смещение всегда +03:00. */
function mskStartOfDay(daysAgo: number, now = new Date()): string {
  const key = mskDayKeyOf(new Date(now.getTime() - daysAgo * 86_400_000));
  return new Date(`${key}T00:00:00+03:00`).toISOString();
}

/**
 * Границы периода для запроса. Считаются от начала суток, а не от «сейчас»:
 * иначе ключ запроса менялся бы каждую секунду и журнал перезагружался бы без конца.
 */
export function periodRange(period: Period, from: string, to: string, now = new Date()): { from?: string; to?: string } {
  if (period === 'today') return { from: mskStartOfDay(0, now) };
  if (period === '7') return { from: mskStartOfDay(6, now) };
  if (period === '30') return { from: mskStartOfDay(29, now) };
  if (period === 'custom') {
    const range: { from?: string; to?: string } = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) range.from = new Date(`${from}T00:00:00+03:00`).toISOString();
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) range.to = new Date(`${to}T23:59:59.999+03:00`).toISOString();
    return range;
  }
  return {};
}

function useDebounced<T>(value: T, ms = 300): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setCurrent(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return current;
}

function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const CATEGORY_SET = new Set<string>(AUDIT_CATEGORY_ORDER);

/* ============ Действия ============ */

function ActionsTab({ params, setParam }: { params: URLSearchParams; setParam: (patch: Record<string, string | null>) => void }) {
  const userId = params.get('userId') || undefined;
  const categoryParam = params.get('category');
  const category = categoryParam && CATEGORY_SET.has(categoryParam) ? (categoryParam as AuditCategory) : undefined;
  const danger = params.get('danger') === '1';
  const periodParam = params.get('period') as Period | null;
  // Из карточки пользователя («Открыть в общем журнале») — вся история, а не неделя.
  const period: Period = periodParam && PERIODS.some(p => p.value === periodParam) ? periodParam : userId ? 'all' : '7';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const debouncedQ = useDebounced(q.trim());

  useEffect(() => {
    if ((params.get('q') ?? '') !== debouncedQ) setParam({ q: debouncedQ || null });
    // Зависим только от введённого: params читаем лишь для сравнения.
  }, [debouncedQ]);

  const dayKey = mskDayKeyOf(new Date());
  const filters: AuditFilters = useMemo(() => {
    const range = periodRange(period, from, to);
    return {
      category,
      danger: danger || undefined,
      userId,
      q: debouncedQ || undefined,
      ...range,
      limit: 50,
    };
    // dayKey — чтобы «Сегодня» переключалось в полночь
  }, [category, danger, userId, debouncedQ, period, from, to, dayKey]);

  const audit = useAdminAudit(filters);
  const entries = useMemo(() => audit.data?.pages.flatMap(page => page.items) ?? [], [audit.data]);
  const total = audit.data?.pages[0]?.total ?? null;
  const groups = useMemo(() => groupByDay(entries), [entries]);
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    // Выгружаем до 10 страниц по 100 текущего фильтра — то, что видно в журнале, и чуть дальше.
    setExporting(true);
    try {
      const all: AdminAuditEntry[] = [];
      let cursor: number | null = null;
      for (let page = 0; page < 10; page += 1) {
        const data: AdminAuditPage = await adminApi<AdminAuditPage>(auditUrl({ ...filters, limit: 100 }, cursor));
        all.push(...data.items);
        if (!data.nextCursor) break;
        cursor = data.nextCursor;
      }
      downloadText(`journal-${dayKey}.csv`, auditToCsv(all));
      toast(`Выгружено записей: ${all.length}`, 'success');
    } catch (error) {
      toast(`Не удалось выгрузить: ${errorText(error)}`, 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="stack">
      <section className={s.auFilters} aria-label="Фильтры действий">
        <div className={s.auField}>
          <label htmlFor="audit-q">Поиск</label>
          <div className={s.auSearch}>
            <Search size={16} aria-hidden="true" />
            <input
              id="audit-q"
              type="search"
              value={q}
              placeholder="Действие, причина или ID пользователя"
              onChange={event => setQ(event.target.value)}
            />
          </div>
        </div>
        <div className={s.auField}>
          <label htmlFor="audit-type">Тип действия</label>
          <Select
            id="audit-type"
            value={category ?? 'all'}
            onChange={event => setParam({ category: event.target.value === 'all' ? null : event.target.value })}
          >
            <option value="all">Все</option>
            {AUDIT_CATEGORY_ORDER.map(value => (
              <option key={value} value={value}>
                {AUDIT_CATEGORIES[value].label}
              </option>
            ))}
          </Select>
        </div>
        <div className={s.auField}>
          <label htmlFor="audit-period">Период</label>
          <Select id="audit-period" value={period} onChange={event => setParam({ period: event.target.value })}>
            {PERIODS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        {period === 'custom' && (
          <>
            <div className={s.auField}>
              <label htmlFor="audit-from">С</label>
              <Input id="audit-from" type="date" value={from} onChange={event => setParam({ from: event.target.value || null })} />
            </div>
            <div className={s.auField}>
              <label htmlFor="audit-to">По</label>
              <Input id="audit-to" type="date" value={to} onChange={event => setParam({ to: event.target.value || null })} />
            </div>
          </>
        )}
        <div className={s.auCheck}>
          <Checkbox checked={danger} onChange={event => setParam({ danger: event.target.checked ? '1' : null })}>
            Только опасные
          </Checkbox>
        </div>
        <Button variant="secondary" className={s.auExport} onClick={() => void exportCsv()} loading={exporting} disabled={!entries.length}>
          <Download size={16} aria-hidden="true" />
          Экспорт CSV
        </Button>
      </section>

      {userId && (
        <div className={s.row}>
          <span className={s.auChip}>
            Пользователь: <Link to={`/panel/users/${userId}`}>{userId.slice(0, 8)}…</Link>
            <button type="button" aria-label="Убрать фильтр по пользователю" onClick={() => setParam({ userId: null })}>
              <X size={14} />
            </button>
          </span>
        </div>
      )}

      <DataState
        query={{ data: audit.data ? entries : undefined, isPending: audit.isPending, isError: audit.isError, error: audit.error, refetch: audit.refetch }}
        isEmpty={items => items.length === 0}
        empty={
          <section className={s.ovCard}>
            <EmptyBlock
              title="Нет действий по этим фильтрам"
              text="Выберите другой тип действия, период или снимите «Только опасные»"
            />
          </section>
        }
        skeleton={
          <section className={s.ovCard}>
            {[0, 1, 2, 3].map(i => (
              <div key={i} className={s.ovRow}>
                <Skeleton width="44px" height={14} />
                <Skeleton width="60%" height={16} />
              </div>
            ))}
          </section>
        }
      >
        {() => (
          <>
            {groups.map(group => (
              <section key={group.key} className={s.ovCard} aria-label={group.label}>
                <div className={s.ovCardHead}>
                  <h2 className={s.ovTitle}>{group.label}</h2>
                  <span className={s.mutedNote}>{group.items.length}</span>
                </div>
                {group.items.map(entry => (
                  <AuditEntry key={entry.id} entry={entry} />
                ))}
              </section>
            ))}
            <div className={s.auMore}>
              <span className={s.mutedNote}>
                Показано {entries.length}
                {total !== null ? ` из ${total}` : ''}
              </span>
              {audit.hasNextPage && (
                <Button variant="secondary" onClick={() => void audit.fetchNextPage()} loading={audit.isFetchingNextPage}>
                  Загрузить ещё
                </Button>
              )}
            </div>
          </>
        )}
      </DataState>
    </div>
  );
}

/* ============ Доставки ============ */

const CHANNEL_META: Record<AdminDelivery['channel'], { label: string; Icon: typeof Mail }> = {
  email: { label: 'Почта', Icon: Mail },
  telegram: { label: 'Telegram', Icon: MessageCircle },
  pc: { label: 'ПК', Icon: Monitor },
};

const STATUS_META: Record<AdminDelivery['status'], { label: string; tone: 'success' | 'error' | 'warning' | 'default' }> = {
  sent: { label: 'Доставлено', tone: 'success' },
  failed: { label: 'Ошибка', tone: 'error' },
  blocked: { label: 'Бот заблокирован', tone: 'error' },
  not_configured: { label: 'Не настроено', tone: 'warning' },
  pending: { label: 'Ожидает', tone: 'default' },
  skipped: { label: 'Пропущено', tone: 'default' },
  expired: { label: 'Истекло', tone: 'default' },
};

export function deliveryStatusLabel(delivery: Pick<AdminDelivery, 'channel' | 'status' | 'pc'>): string {
  if (delivery.channel === 'pc') {
    if (delivery.pc?.answeredAt) return 'Ответили';
    if (delivery.pc?.readAt) return 'Прочитано';
    if (delivery.status === 'pending') return 'Ждёт ПК в сети';
  }
  return STATUS_META[delivery.status]?.label ?? delivery.status;
}

function deliveryDetail(delivery: AdminDelivery): { text: string; mono: boolean } {
  if (delivery.lastError) return { text: delivery.lastError, mono: true };
  if (delivery.channel === 'pc' && delivery.pc) {
    if (delivery.pc.answer) return { text: `Ответ: ${delivery.pc.answer}`, mono: false };
    if (delivery.pc.readAt) return { text: `Прочитано в ${formatMskTime(delivery.pc.readAt)}`, mono: false };
    if (delivery.pc.deliveredAt) return { text: `Показано на ПК в ${formatMskTime(delivery.pc.deliveredAt)}`, mono: false };
    return { text: 'ПК не в сети, покажем при входе', mono: false };
  }
  if (delivery.providerId) return { text: delivery.channel === 'telegram' ? `message_id ${delivery.providerId}` : delivery.providerId, mono: true };
  return { text: delivery.attempts > 1 ? `попыток: ${delivery.attempts}` : '—', mono: false };
}

function dayLabel(iso: string): string {
  const key = mskDayKeyOf(new Date(iso));
  const today = mskDayKeyOf(new Date());
  const yesterday = mskDayKeyOf(new Date(Date.now() - 86_400_000));
  if (key === today) return 'сегодня';
  if (key === yesterday) return 'вчера';
  return `${key.slice(8, 10)}.${key.slice(5, 7)}`;
}

const CHANNEL_SET = new Set(['email', 'telegram', 'pc']);
const STATUS_SET = new Set(['sent', 'failed', 'not_configured', 'pending', 'blocked', 'error']);

function DeliveriesTab({ params, setParam }: { params: URLSearchParams; setParam: (patch: Record<string, string | null>) => void }) {
  const channelParam = params.get('channel');
  const statusParam = params.get('status');
  const userId = params.get('userId') || undefined;
  const filters: DeliveryFilters = useMemo(
    () => ({
      channel: channelParam && CHANNEL_SET.has(channelParam) ? (channelParam as DeliveryFilters['channel']) : undefined,
      status: statusParam && STATUS_SET.has(statusParam) ? (statusParam as DeliveryFilters['status']) : undefined,
      userId,
    }),
    [channelParam, statusParam, userId],
  );
  const deliveries = useAdminDeliveries(filters);
  const retry = useAdminRetryDelivery();
  const toast = useToast();
  // Ключ повтора на строку: двойной клик и повтор после обрыва сети не отправят письмо дважды.
  const retryKeys = useRef(new Map<string, string>());
  const [retrying, setRetrying] = useState<string | null>(null);
  const rows = useMemo(() => deliveries.data?.pages.flatMap(page => page.items) ?? [], [deliveries.data]);
  const stats = deliveries.data?.pages[0]?.stats24h;

  const doRetry = async (delivery: AdminDelivery) => {
    if (retrying) return;
    let key = retryKeys.current.get(delivery.id);
    if (!key) {
      key = newIdempotencyKey();
      retryKeys.current.set(delivery.id, key);
    }
    setRetrying(delivery.id);
    try {
      const result = await retry.mutateAsync({ id: delivery.id, idempotencyKey: key });
      retryKeys.current.delete(delivery.id);
      toast(result.delivery.status === 'sent' ? 'Доставлено повторно' : `Повтор: ${deliveryStatusLabel(result.delivery).toLowerCase()}`, result.delivery.status === 'sent' ? 'success' : 'default');
    } catch (error) {
      toast(`Не удалось повторить: ${errorText(error)}`, 'error');
    } finally {
      setRetrying(null);
    }
  };

  const columns: ResponsiveColumn<AdminDelivery>[] = [
    {
      key: 'time',
      header: 'Время',
      cell: row => (
        <span>
          {formatMskTime(row.createdAt)}
          <br />
          <span className={s.mutedInline}>{dayLabel(row.createdAt)}</span>
        </span>
      ),
    },
    {
      key: 'channel',
      header: 'Канал',
      cell: row => {
        const meta = CHANNEL_META[row.channel];
        return (
          <span className={s.auChannel}>
            <meta.Icon size={15} aria-hidden="true" />
            {meta.label}
          </span>
        );
      },
    },
    {
      key: 'to',
      header: 'Кому',
      primary: true,
      cell: row => {
        const name = row.user?.displayName || row.user?.email || row.recipient;
        const sub = row.channel === 'pc' ? (row.pc?.deviceName ? `ПК «${row.pc.deviceName}»` : row.recipient) : row.channelRef || row.recipient;
        return (
          <span className={s.auTo}>
            {row.userId ? <Link to={`/panel/users/${row.userId}`}>{name}</Link> : <span>{name}</span>}
            {sub && sub !== name && <span className={s.mutedInline}>{sub}</span>}
          </span>
        );
      },
    },
    { key: 'subject', header: 'Тема', cell: row => row.subject || '—' },
    {
      key: 'status',
      header: 'Статус',
      cell: row => <Badge tone={STATUS_META[row.status]?.tone ?? 'default'}>{deliveryStatusLabel(row)}</Badge>,
    },
    {
      key: 'detail',
      header: 'Подробность',
      cell: row => {
        const detail = deliveryDetail(row);
        return <span className={detail.mono ? s.auMono : s.mutedInline}>{detail.text}</span>;
      },
    },
  ];

  const tile = (label: string, value: number | undefined, tone?: string) => (
    <div className={`${s.ovTile} ${tone ?? ''}`}>
      <div>{label}</div>
      <b>{value === undefined ? '—' : value}</b>
    </div>
  );

  return (
    <div className="stack">
      <div className={s.ovTiles}>
        {tile('Доставлено за 24 часа', stats?.sent)}
        {tile('Ошибки', stats?.failed, stats?.failed ? s.tileError : undefined)}
        {tile('Канал не настроен', stats?.notConfigured, stats?.notConfigured ? s.tileWarning : undefined)}
        {tile('Ожидают ПК в сети', stats?.waitingPc)}
      </div>

      <section className={s.auFilters} aria-label="Фильтры доставок">
        <div className={s.auField}>
          <label htmlFor="delivery-channel">Канал</label>
          <Select id="delivery-channel" value={filters.channel ?? 'all'} onChange={event => setParam({ channel: event.target.value === 'all' ? null : event.target.value })}>
            <option value="all">Все</option>
            <option value="email">Почта</option>
            <option value="telegram">Telegram</option>
            <option value="pc">ПК</option>
          </Select>
        </div>
        <div className={s.auField}>
          <label htmlFor="delivery-status">Статус</label>
          <Select id="delivery-status" value={filters.status ?? 'all'} onChange={event => setParam({ status: event.target.value === 'all' ? null : event.target.value })}>
            <option value="all">Все</option>
            <option value="sent">Доставлено</option>
            <option value="error">Ошибка</option>
            <option value="not_configured">Не настроено</option>
            <option value="pending">Ожидает</option>
            <option value="blocked">Бот заблокирован</option>
          </Select>
        </div>
        {userId && (
          <span className={s.auChip}>
            Пользователь: <Link to={`/panel/users/${userId}`}>{userId.slice(0, 8)}…</Link>
            <button type="button" aria-label="Убрать фильтр по пользователю" onClick={() => setParam({ userId: null })}>
              <X size={14} />
            </button>
          </span>
        )}
      </section>

      <DataState
        query={{ data: deliveries.data ? rows : undefined, isPending: deliveries.isPending, isError: deliveries.isError, error: deliveries.error, refetch: deliveries.refetch }}
        isEmpty={items => items.length === 0}
        empty={
          <section className={s.ovCard}>
            <EmptyBlock title="Нет доставок с таким каналом и статусом" text="Измените фильтры или загляните позже." />
          </section>
        }
      >
        {items => (
          <>
            <ResponsiveTable
              rows={items}
              columns={columns}
              rowKey={row => row.id}
              caption="Доставки сообщений"
              rowActions={row =>
                row.canRetry ? (
                  <Button variant="secondary" size="sm" onClick={() => void doRetry(row)} loading={retrying === row.id} disabled={Boolean(retrying)}>
                    <RotateCw size={14} aria-hidden="true" />
                    Повторить
                  </Button>
                ) : row.status === 'not_configured' ? (
                  <Link to="/panel/system" className={s.ovLink}>
                    Настроить
                  </Link>
                ) : null
              }
            />
            <div className={s.auMore}>
              <span className={s.mutedNote}>Показано {items.length}</span>
              {deliveries.hasNextPage && (
                <Button variant="secondary" onClick={() => void deliveries.fetchNextPage()} loading={deliveries.isFetchingNextPage}>
                  Загрузить ещё
                </Button>
              )}
            </div>
          </>
        )}
      </DataState>
    </div>
  );
}

/* ============ Страница ============ */

function TabButton({ active, onClick, children, id, controls }: { active: boolean; onClick: () => void; children: ReactNode; id: string; controls: string }) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls={controls}
      tabIndex={active ? 0 : -1}
      className={`${s.auTab} ${active ? s.auTabActive : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function AdminAuditPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'deliveries' ? 'deliveries' : 'actions';
  // Счётчик на вкладке — из «Требует внимания» (тот же запрос, что у меню, кеш 60 с),
  // а не из ленты доставок: её ради одной цифры грузить незачем.
  const failedCount = useAdminAttention().data?.failedDeliveries24h.count ?? 0;

  const setParam = (patch: Record<string, string | null>) => {
    setParams(
      previous => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  const switchTab = (next: Tab) => {
    // Фильтры у вкладок разные; общий только пользователь.
    const keep = new URLSearchParams();
    if (next !== 'actions') keep.set('tab', next);
    const userId = params.get('userId');
    if (userId) keep.set('userId', userId);
    setParams(keep, { replace: true });
  };

  return (
    <div className="page stack-lg">
      <p className={s.pageSub}>Все действия администратора и доставки сообщений</p>
      <div className={s.auTabs} role="tablist" aria-label="Разделы журнала">
        <TabButton id="audit-tab-actions" controls="audit-panel" active={tab === 'actions'} onClick={() => switchTab('actions')}>
          Действия
        </TabButton>
        <TabButton id="audit-tab-deliveries" controls="audit-panel" active={tab === 'deliveries'} onClick={() => switchTab('deliveries')}>
          Доставки
          {failedCount > 0 && <span className={s.navBadgeAccent} aria-label={`ошибок за сутки: ${failedCount}`}>{failedCount}</span>}
        </TabButton>
      </div>
      <div id="audit-panel" role="tabpanel" aria-labelledby={tab === 'actions' ? 'audit-tab-actions' : 'audit-tab-deliveries'}>
        {tab === 'actions' ? <ActionsTab params={params} setParam={setParam} /> : <DeliveriesTab params={params} setParam={setParam} />}
      </div>
    </div>
  );
}
