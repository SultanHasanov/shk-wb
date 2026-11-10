import { useMemo, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Clock, MailX, Package, ShieldOff, TriangleAlert, Wallet } from 'lucide-react';
import {
  useAdminAttention,
  useAdminAudit,
  useAdminFreeGenerations,
  useAdminStats,
  useAdminSummary,
} from '../../api/admin';
import type { AdminAttention } from '../../api/admin';
import { money } from '../../api/cabinet';
import { formatMskTime } from '../../lib/admin-audit';
import { fillDailySeries, productLabel } from '../../lib/admin-users';
import { Segmented, Skeleton, Table } from '../../ui';
import { AuditEntry, DataState, EmptyBlock, ErrorBlock } from './kit';
import s from '../../layout/AdminShell.module.css';

/** Склонение: plural(3, 'заявка', 'заявки', 'заявок') → 'заявки'. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

const integer = new Intl.NumberFormat('ru-RU');

/** «ждёт 2 дня», «ждёт 5 ч», «ждёт 20 мин» — сколько висит самая старая заявка. */
export function waitingFor(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

type AttentionTone = 'accent' | 'warning' | 'error' | 'muted';
export type AttentionItem = {
  key: string;
  tone: AttentionTone;
  Icon: ComponentType<{ size?: number }>;
  title: string;
  detail: string;
  href: string;
  action: string;
};

/** Пункты «Требует внимания» из ответа сервера: только непустые. */
export function attentionItems(data: AdminAttention, now = Date.now()): AttentionItem[] {
  const items: AttentionItem[] = [];
  const w = data.withdrawals;
  if (w.count > 0) {
    const wait = waitingFor(w.oldestAt, now);
    items.push({
      key: 'withdrawals',
      tone: 'accent',
      Icon: Wallet,
      title: `${w.count} ${plural(w.count, 'заявка', 'заявки', 'заявок')} на выплату`,
      detail: `на ${money(w.amountKopecks)}${wait ? `, ${w.count > 1 ? 'старшая ждёт' : 'ждёт'} ${wait}` : ''}`,
      href: '/panel/cabinet',
      action: 'Разобрать',
    });
  }
  if (data.stuckOrders.count > 0) {
    const n = data.stuckOrders.count;
    items.push({
      key: 'orders',
      tone: 'warning',
      Icon: Clock,
      title: `${n} ${plural(n, 'заказ завис', 'заказа зависли', 'заказов зависли')} в ожидании`,
      detail: 'больше 30 минут без ответа ЮKassa',
      href: '/panel/payments',
      action: 'Проверить',
    });
  }
  for (const [key, pool, label, href] of [
    ['stickerPool', data.stickerPool, 'стикеров', '/panel/sticker-pool'],
    ['boxPool', data.boxPool, 'коробок', '/panel/box-pool'],
  ] as const) {
    if (!pool.low) continue;
    items.push({
      key,
      tone: 'warning',
      Icon: Package,
      title: `Заканчиваются номера ${label}`,
      detail: `свободно ${integer.format(pool.available)}, порог ${integer.format(pool.threshold)}`,
      href,
      action: 'Расширить',
    });
  }
  const failed = data.failedDeliveries24h;
  if (failed.count > 0) {
    const parts = [
      failed.byChannel.email ? `почта ${failed.byChannel.email}` : null,
      failed.byChannel.telegram ? `Telegram ${failed.byChannel.telegram}` : null,
      failed.byChannel.pc ? `ПК ${failed.byChannel.pc}` : null,
    ].filter(Boolean);
    items.push({
      key: 'deliveries',
      tone: 'error',
      Icon: MailX,
      title: `${failed.count} ${plural(failed.count, 'сообщение не доставлено', 'сообщения не доставлены', 'сообщений не доставлены')}`,
      detail: `за 24 часа${parts.length ? `: ${parts.join(', ')}` : ''}`,
      href: '/panel/audit?tab=deliveries&status=error',
      action: 'Открыть',
    });
  }
  const expiring = data.restrictionsExpiringToday;
  if (expiring.count > 0) {
    const first = expiring.items[0];
    const single = expiring.count === 1 && first;
    items.push({
      key: 'restrictions',
      tone: 'muted',
      Icon: ShieldOff,
      title: single ? 'Ограничение истекает сегодня' : `${expiring.count} ${plural(expiring.count, 'ограничение истекает', 'ограничения истекают', 'ограничений истекают')} сегодня`,
      detail: single
        ? `${first.label}, снимется в ${formatMskTime(first.until)}`
        : expiring.items.map(item => item.label).slice(0, 3).join(', '),
      href: single ? `/panel/users/${first.userId}` : '/panel/users?filter=restricted',
      action: single ? 'Карточка' : 'Список',
    });
  }
  return items;
}

const TONE_CLASS: Record<AttentionTone, string> = {
  accent: s.ovIconAccent,
  warning: s.ovIconWarning,
  error: s.ovIconError,
  muted: s.ovIconMuted,
};

function AttentionList({ data }: { data: AdminAttention }) {
  const items = attentionItems(data);
  return (
    <section className={s.ovCard} aria-labelledby="ov-attention">
      <div className={s.ovCardHead}>
        <h2 id="ov-attention" className={s.ovTitle}>
          <TriangleAlert size={18} aria-hidden="true" className={s.ovTitleIcon} />
          Требует внимания
          {items.length > 0 && <span className={s.ovCount}>{items.length}</span>}
        </h2>
        <span className={s.mutedNote}>Всё, где нужно ваше решение</span>
      </div>
      {items.length === 0 ? (
        <EmptyBlock title="Всё спокойно" text="Заявок, зависших заказов и ошибок доставки нет." />
      ) : (
        <div className={s.ovList}>
          {items.map(item => (
            <Link key={item.key} to={item.href} className={s.ovRow}>
              <span className={`${s.ovIcon} ${TONE_CLASS[item.tone]}`}>
                <item.Icon size={18} />
              </span>
              <span className={s.ovRowText}>
                <b>{item.title}</b>
                <span className={s.ovSep}> · </span>
                <span className={s.ovDetail}>{item.detail}</span>
              </span>
              <span className={s.ovRowAction}>
                {item.action}
                <ArrowRight size={15} aria-hidden="true" />
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

/** Столбики регистраций: последний (сегодня / эта неделя) — акцентом. */
function RegistrationBars({ points }: { points: { day: string; count: number }[] }) {
  const max = Math.max(1, ...points.map(point => point.count));
  return (
    <div className={s.ovBars} role="img" aria-label={`Регистрации: всего ${points.reduce((sum, p) => sum + p.count, 0)} за период`}>
      {points.map((point, index) => (
        <div
          key={point.day}
          className={`${s.ovBar} ${index === points.length - 1 ? s.ovBarLast : ''}`}
          style={{ height: `${Math.max(4, Math.round((point.count / max) * 100))}%` }}
          title={`${point.day}: ${point.count} ${plural(point.count, 'регистрация', 'регистрации', 'регистраций')}`}
        />
      ))}
    </div>
  );
}

function MoneyCard({ title, value, note, accent }: { title: string; value: ReactNode; note: ReactNode; accent?: boolean }) {
  return (
    <section className={`${s.ovMoney} ${accent ? s.ovMoneyAccent : ''}`}>
      <div className={s.ovMoneyTitle}>{title}</div>
      <div className={accent ? s.todayValue : s.ovMoneyValue}>{value}</div>
      <div className={s.mutedNote}>{note}</div>
    </section>
  );
}

/** Сравнение с вчера: «+22%»; без вчерашней выручки процента нет. */
function delta(today: number, yesterday: number): { text: string; up: boolean } | null {
  if (!yesterday) return null;
  const pct = Math.round(((today - yesterday) / yesterday) * 100);
  return { text: `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}%`, up: pct >= 0 };
}

function Collapsible({ title, note, children }: { title: string; note: string; children: (open: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={s.ovCard}>
      <button type="button" className={s.ovCollapse} aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span>
          <b>{title}</b>
          <span className={s.mutedInline}> · {note}</span>
        </span>
        <span className={s.ovRowAction}>{open ? 'Свернуть' : 'Показать'}</span>
      </button>
      {open && <div className={s.ovCollapseBody}>{children(open)}</div>}
    </section>
  );
}

function FreeArchive({ enabled }: { enabled: boolean }) {
  const free = useAdminFreeGenerations({ enabled });
  return (
    <DataState query={free} empty={null}>
      {data => {
        const conversion = data.conversion.freeVisitors
          ? Math.round((data.conversion.converted / data.conversion.freeVisitors) * 100)
          : 0;
        return (
          <div className="stack">
            <div className={s.ovTiles}>
              <div className={s.ovTile}><div>Выдано всего</div><b>{integer.format(data.totals.codes)}</b></div>
              <div className={s.ovTile}><div>Уникальных IP</div><b>{integer.format(data.totals.visitors)}</b></div>
              <div className={s.ovTile}>
                <div>Перешли в платные</div>
                <b>{conversion}%</b>
              </div>
              <div className={s.ovTile}>
                <div>Последняя выдача</div>
                <b>{data.totals.lastAt ? new Date(data.totals.lastAt).toLocaleDateString('ru-RU') : '—'}</b>
              </div>
            </div>
            <p className={s.mutedNote}>
              Бесплатная первая генерация отменена, новых записей не будет. Пока она действовала, квота считалась
              отдельно на каждую пару «категория × режим», поэтому с одного IP кодов могло быть до четырёх.
              Уникальность — по IP, а не по людям.
            </p>
          </div>
        );
      }}
    </DataState>
  );
}

function VisitsArchive({ enabled }: { enabled: boolean }) {
  const stats = useAdminStats({ enabled });
  return (
    <DataState query={stats} empty={null}>
      {data => (
        <div className="stack">
          <div className={s.ovTiles}>
            <div className={s.ovTile}><div>Визитов всего</div><b>{integer.format(data.totals.siteVisits)}</b></div>
            <div className={s.ovTile}><div>Уникальных посетителей</div><b>{integer.format(data.totals.uniqueVisitors)}</b></div>
            <div className={s.ovTile}><div>Запусков программы</div><b>{integer.format(data.totals.appLaunches)}</b></div>
          </div>
          {data.days.length > 0 && (
            <Table>
              <thead>
                <tr><th>День</th><th>Визиты</th><th>Уникальные</th><th>Запуски</th></tr>
              </thead>
              <tbody>
                {data.days.slice(0, 30).map(day => (
                  <tr key={day.day}>
                    <td>{day.day}</td><td>{day.siteVisits}</td><td>{day.uniqueVisitors}</td><td>{day.appLaunches}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      )}
    </DataState>
  );
}

const weekday = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'long', day: 'numeric', month: 'long' });

function updatedLabel(updatedAt: number): string {
  if (!updatedAt) return '';
  const minutes = Math.floor((Date.now() - updatedAt) / 60_000);
  if (minutes < 1) return 'данные обновлены только что';
  return `данные обновлены ${minutes} мин назад`;
}

export function AdminOverviewPage() {
  const attention = useAdminAttention();
  const summary = useAdminSummary();
  const recent = useAdminAudit({ limit: 4 });
  const [scale, setScale] = useState<'days' | 'weeks'>('days');

  const registrations = useMemo(() => {
    if (!summary.data) return [];
    return scale === 'days'
      ? fillDailySeries(summary.data.registrations.days, 30)
      : summary.data.registrations.weeks.slice(-12).map(point => ({ day: point.week, count: point.count }));
  }, [summary.data, scale]);

  const today = weekday.format(new Date());
  const recentItems = recent.data?.pages[0]?.items.slice(0, 4) ?? [];

  return (
    <div className="page stack-lg">
      <p className={s.pageSub}>
        {today.charAt(0).toUpperCase() + today.slice(1)}
        {attention.dataUpdatedAt ? ` · ${updatedLabel(attention.dataUpdatedAt)}` : ''}
      </p>

      <DataState
        query={attention}
        empty={null}
        skeleton={
          <section className={s.ovCard}>
            <div className={s.ovCardHead}>
              <h2 className={s.ovTitle}>Требует внимания</h2>
            </div>
            <div className={s.ovList}>
              {[0, 1, 2].map(i => (
                <div key={i} className={s.ovRow}>
                  <Skeleton width="36px" height={36} />
                  <Skeleton width="60%" height={16} />
                </div>
              ))}
            </div>
          </section>
        }
      >
        {data => <AttentionList data={data} />}
      </DataState>

      {summary.isError && <ErrorBlock error={summary.error} onRetry={summary.refetch} />}

      <div className={s.ovMoneyGrid}>
        {summary.isPending ? (
          <>
            <Skeleton height={132} />
            <Skeleton height={132} />
          </>
        ) : summary.data ? (
          <>
            <MoneyCard
              accent
              title="Заработок за сегодня"
              value={money(summary.data.revenue.todayKopecks ?? 0)}
              note={
                <>
                  {integer.format(summary.data.revenue.todayOrders ?? 0)}{' '}
                  {plural(summary.data.revenue.todayOrders ?? 0, 'заказ', 'заказа', 'заказов')} с полуночи по Москве · вчера{' '}
                  {money(summary.data.revenue.yesterdayKopecks ?? 0)}{' '}
                  {(() => {
                    const d = delta(summary.data.revenue.todayKopecks ?? 0, summary.data.revenue.yesterdayKopecks ?? 0);
                    return d ? <span className={d.up ? s.deltaUp : s.deltaDown}>{d.text}</span> : null;
                  })()}
                </>
              }
            />
            <MoneyCard
              title="Выручка за 30 дней"
              value={money(summary.data.revenue.last30Kopecks)}
              note={`за всё время ${money(summary.data.revenue.amountKopecks)} · ${integer.format(summary.data.revenue.paidOrders)} ${plural(summary.data.revenue.paidOrders, 'оплаченный заказ', 'оплаченных заказа', 'оплаченных заказов')}`}
            />
          </>
        ) : null}
        {attention.data ? (
          <MoneyCard
            title="Подписки Помощника"
            value={`${integer.format(attention.data.subscriptions.active)} ${plural(attention.data.subscriptions.active, 'активная', 'активных', 'активных')}`}
            note={`${integer.format(attention.data.subscriptions.expiring7)} ${plural(attention.data.subscriptions.expiring7, 'истекает', 'истекают', 'истекают')} за 7 дней · ${integer.format(attention.data.onlinePcs)} ПК в сети`}
          />
        ) : attention.isPending ? (
          <Skeleton height={132} />
        ) : null}
      </div>

      <section className={`${s.ovCard} ${s.ovPadded}`} aria-labelledby="ov-users">
        <div className={s.spread}>
          <h2 id="ov-users" className={s.ovTitle}>Пользователи</h2>
          <Link to="/panel/users" className={s.ovLink}>
            Все пользователи <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
        {summary.isPending ? (
          <Skeleton height={72} />
        ) : summary.data ? (
          <>
            <div className={s.ovTiles}>
              <div className={s.ovTile}><div>Всего аккаунтов</div><b>{integer.format(summary.data.totals.users)}</b></div>
              <div className={s.ovTile}><div>Новых за 30 дней</div><b>{integer.format(summary.data.totals.new30)}</b></div>
              <div className={s.ovTile}><div>Заходили за 30 дней</div><b>{integer.format(summary.data.totals.active30)}</b></div>
              <div className={s.ovTile}><div>С покупками</div><b>{integer.format(summary.data.revenue.payingUsers)}</b></div>
              <Link to="/panel/users?filter=restricted" className={s.ovTile}>
                <div>Ограничены</div>
                <b>{attention.data ? integer.format(attention.data.restrictedTotal) : '—'}</b>
              </Link>
            </div>
            <div className={s.ovChart}>
              <div className={s.spread}>
                <span className={s.ovChartTitle}>Регистрации по {scale === 'days' ? 'дням' : 'неделям'}</span>
                <Segmented
                  label="Период"
                  value={scale}
                  onChange={setScale}
                  options={[
                    { value: 'days', label: '30 дней' },
                    { value: 'weeks', label: 'По неделям' },
                  ]}
                />
              </div>
              <RegistrationBars points={registrations} />
              <div className={s.ovChartAxis}>
                <span>{scale === 'days' ? '30 дней назад' : `${registrations.length} недель назад`}</span>
                <span>
                  всего {integer.format(registrations.reduce((sum, point) => sum + point.count, 0))} ·{' '}
                  {scale === 'days' ? 'сегодня' : 'эта неделя'}
                </span>
              </div>
            </div>
          </>
        ) : null}
      </section>

      <div className={s.ovTwo}>
        <section className={s.ovCard} aria-labelledby="ov-sales">
          <div className={s.ovCardHead}>
            <h2 id="ov-sales" className={s.ovTitle}>Продажи по продуктам</h2>
            {/* admin_user_summary считает byKind за всё время, а не за 30 дней (как в макете) — подписываем честно. */}
            <span className={s.mutedNote}>за всё время</span>
          </div>
          {summary.isPending ? (
            <div className={s.ovPadded}><Skeleton height={120} /></div>
          ) : summary.data && summary.data.revenue.byKind.length > 0 ? (
            <table className={s.ovTable}>
              <thead>
                <tr><th>Продукт</th><th className={s.num}>Заказы</th><th className={s.num}>Выручка</th></tr>
              </thead>
              <tbody>
                {summary.data.revenue.byKind.map(row => (
                  <tr key={row.kind}>
                    <td>{productLabel(row.kind)}</td>
                    <td className={s.num}>{integer.format(row.orders)}</td>
                    <td className={s.num}>{money(row.amountKopecks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : summary.data ? (
            <EmptyBlock title="Оплаченных заказов пока нет" />
          ) : null}
        </section>

        <section className={s.ovCard} aria-labelledby="ov-recent">
          <div className={s.ovCardHead}>
            <h2 id="ov-recent" className={s.ovTitle}>Последние действия</h2>
            <Link to="/panel/audit" className={s.ovLink}>
              Весь журнал <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
          <DataState
            query={{
              data: recent.data ? recentItems : undefined,
              isPending: recent.isPending,
              isError: recent.isError,
              error: recent.error,
              refetch: recent.refetch,
            }}
            isEmpty={items => items.length === 0}
            empty={<EmptyBlock title="Журнал пуст" text="Здесь появятся действия администратора." />}
          >
            {items => (
              <div>
                {items.map(entry => (
                  <AuditEntry key={entry.id} entry={entry} compact />
                ))}
              </div>
            )}
          </DataState>
        </section>
      </div>

      <Collapsible title="Архив: бесплатные генерации" note="функция отключена, только история">
        {open => <FreeArchive enabled={open} />}
      </Collapsible>
      <Collapsible title="Посещения сайта" note="визиты и запуски программы по дням">
        {open => <VisitsArchive enabled={open} />}
      </Collapsible>
    </div>
  );
}
