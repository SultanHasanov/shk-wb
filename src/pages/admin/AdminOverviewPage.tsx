import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Coins, Eye, Gift, Package, Users, Wallet } from 'lucide-react';
import { useAdminFreeGenerations, useAdminStats, useAdminSummary } from '../../api/admin';
import { money } from '../../api/cabinet';
import { fillDailySeries, productLabel } from '../../lib/admin-users';
import { Alert, Button, Card, Segmented, Skeleton, Stat, Table } from '../../ui';
import s from '../../layout/AdminShell.module.css';

/** Спарклайн: точек до 90, отдельная библиотека графиков ради этого не нужна. */
function Sparkline({ points }: { points: { count: number }[] }) {
  const max = Math.max(1, ...points.map(point => point.count));
  const step = points.length > 1 ? 100 / (points.length - 1) : 100;
  const line = points
    .map((point, index) => `${(index * step).toFixed(2)},${(100 - (point.count / max) * 100).toFixed(2)}`)
    .join(' ');

  return (
    <svg className={s.spark} viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="График регистраций">
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** «1 заказ / 2 заказа / 5 заказов» — плашка за сегодня чаще всего показывает единицы. */
function declineOrders(count: number) {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return `${count} заказов`;
  const last = count % 10;
  if (last === 1) return `${count} заказ`;
  if (last >= 2 && last <= 4) return `${count} заказа`;
  return `${count} заказов`;
}

/** Пары «категория × режим» из return_*_batches — у каждой своя бесплатная квота. */
const FREE_KIND_LABELS: Record<string, string> = {
  'product:range': 'Товарные стикеры · пачкой',
  'product:custom': 'Товарные стикеры · по номеру',
  'box:range': 'QR коробок · пачкой',
  'box:custom': 'QR коробок · по номеру',
};

export function AdminOverviewPage() {
  const summary = useAdminSummary();
  const stats = useAdminStats();
  const free = useAdminFreeGenerations();
  const [scale, setScale] = useState<'days' | 'weeks'>('days');

  const conversionPercent = free.data?.conversion.freeVisitors
    ? Math.round((free.data.conversion.converted / free.data.conversion.freeVisitors) * 100)
    : 0;

  const registrations = summary.data
    ? scale === 'days'
      ? fillDailySeries(summary.data.registrations.days, 30)
      : summary.data.registrations.weeks.map(point => ({ day: point.week, count: point.count }))
    : [];

  return (
    <div className="page stack-lg">
      {summary.isError && <Alert tone="error">Не удалось загрузить сводку: {summary.error.message}</Alert>}

      {summary.isPending ? (
        <Skeleton height={120} />
      ) : summary.data ? (
        <Card className={s.today}>
          <div className={s.todayHead}>
            <Wallet size={18} />
            Заработок за сегодня
          </div>
          <div className={s.todayValue}>{money(summary.data.revenue.todayKopecks ?? 0)}</div>
          <p className={s.mutedNote}>
            {declineOrders(summary.data.revenue.todayOrders ?? 0)} с полуночи по Москве
            {' · '}
            вчера {money(summary.data.revenue.yesterdayKopecks ?? 0)}
          </p>
        </Card>
      ) : null}

      <section className="stack">
        <h2>Пользователи</h2>
        {summary.isPending ? (
          <Skeleton height={96} />
        ) : summary.data ? (
          <div className={s.tiles}>
            <Stat value={summary.data.totals.users} label="всего аккаунтов" icon={<Users size={20} />} />
            <Stat value={summary.data.totals.new30} label="новых за 30 дней" />
            <Stat value={summary.data.totals.active30} label="заходили за 30 дней" icon={<Activity size={20} />} />
            <Stat value={summary.data.revenue.payingUsers} label="с покупками" icon={<Coins size={20} />} />
            <Stat value={money(summary.data.revenue.amountKopecks)} label="выручка всего" icon={<Wallet size={20} />} />
            <Stat value={money(summary.data.revenue.last30Kopecks)} label="выручка за 30 дней" />
          </div>
        ) : null}
        <div className={s.row}>
          <Link to="/panel/users">
            <Button variant="secondary" size="sm">Все пользователи</Button>
          </Link>
        </div>
      </section>

      {summary.data && (
        <Card>
          <div className={s.spread}>
            <strong>Регистрации</strong>
            <Segmented
              label="Масштаб графика"
              value={scale}
              onChange={setScale}
              options={[
                { value: 'days', label: '30 дней' },
                { value: 'weeks', label: 'По неделям' },
              ]}
            />
          </div>
          <Sparkline points={registrations} />
          <p className={s.mutedNote}>
            Всего за период: {registrations.reduce((sum, point) => sum + point.count, 0)}
          </p>
        </Card>
      )}

      {summary.data && (
        <section className="stack">
          <h2>Продажи по продуктам</h2>
          {summary.data.revenue.byKind.length ? (
            <Table>
              <thead>
                <tr><th>Продукт</th><th>Заказов</th><th>Выручка</th></tr>
              </thead>
              <tbody>
                {summary.data.revenue.byKind.map(row => (
                  <tr key={row.kind}>
                    <td>{productLabel(row.kind)}</td>
                    <td>{row.orders}</td>
                    <td>{money(row.amountKopecks)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Card>Оплаченных заказов пока нет.</Card>
          )}
        </section>
      )}

      {summary.data && (
        <section className="stack">
          <h2>Генерации и активы</h2>
          <div className={s.tiles}>
            <Stat value={summary.data.generations.used} label="генераций израсходовано" icon={<Package size={20} />} />
            <Stat value={summary.data.generations.limit} label="генераций выдано" />
            <Stat value={summary.data.generations.codes} label="кодов доступа" />
            <Stat value={summary.data.assets.cellActive} label="активных ключей печати ячеек" />
            <Stat value={summary.data.referrals.attributions} label="приглашённых по рефералке" />
            <Stat value={money(summary.data.referrals.availableKopecks)} label="на реферальных балансах" />
          </div>
        </section>
      )}

      <section className="stack">
        <h2>Бесплатные генерации (архив)</h2>
        {free.isError && <Alert tone="error">Не удалось загрузить статистику: {free.error.message}</Alert>}
        {free.isPending ? (
          <Skeleton height={96} />
        ) : free.data ? (
          <>
            <div className={s.tiles}>
              <Stat value={free.data.totals.codes} label="выдано бесплатно всего" icon={<Gift size={20} />} />
              <Stat value={free.data.totals.last24h} label="за сутки" />
              <Stat value={free.data.totals.last7d} label="за 7 дней" />
              <Stat value={free.data.totals.last30d} label="за 30 дней" />
              <Stat value={free.data.totals.visitors} label="уникальных IP" />
              <Stat
                value={`${conversionPercent}%`}
                label={`перешли к покупке (${free.data.conversion.converted} из ${free.data.conversion.freeVisitors})`}
                icon={<Coins size={20} />}
              />
            </div>

            <p className={s.mutedNote}>
              Исторические данные: бесплатная первая генерация отменена, новых записей здесь больше
              не появится. Пока она действовала, квота проверялась отдельно на каждую пару
              «категория × режим», поэтому с одного IP бесплатных кодов могло быть до четырёх.
              Уникальность считается по IP, а не по людям.
            </p>

            {free.data.byKind.length > 0 && (
              <Table>
                <thead>
                  <tr><th>Что генерировали</th><th>Кодов</th><th>Уникальных IP</th></tr>
                </thead>
                <tbody>
                  {free.data.byKind.map(row => (
                    <tr key={`${row.category}:${row.mode}`}>
                      <td>{FREE_KIND_LABELS[`${row.category}:${row.mode}`] ?? `${row.category} · ${row.mode}`}</td>
                      <td>{row.codes}</td>
                      <td>{row.visitors}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}

            {free.data.days.length ? (
              <Table>
                <thead>
                  <tr><th>День</th><th>Бесплатных кодов</th><th>Уникальных IP</th></tr>
                </thead>
                <tbody>
                  {free.data.days.slice(0, 30).map(day => (
                    <tr key={day.day}>
                      <td>{day.day}</td><td>{day.codes}</td><td>{day.visitors}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <Card>Бесплатных генераций пока не было.</Card>
            )}
          </>
        ) : null}
      </section>

      <section className="stack">
        <h2>Посещения сайта</h2>
        {stats.isPending ? (
          <Skeleton height={96} />
        ) : stats.data ? (
          <>
            <div className={s.tiles}>
              <Stat value={stats.data.totals.siteVisits} label="визитов всего" icon={<Eye size={20} />} />
              <Stat value={stats.data.totals.uniqueVisitors} label="уникальных посетителей" />
              <Stat value={stats.data.totals.appLaunches} label="запусков программы" />
            </div>
            <Table>
              <thead>
                <tr><th>День</th><th>Визиты</th><th>Уникальные</th><th>Запуски</th></tr>
              </thead>
              <tbody>
                {stats.data.days.slice(0, 30).map(day => (
                  <tr key={day.day}>
                    <td>{day.day}</td><td>{day.siteVisits}</td>
                    <td>{day.uniqueVisitors}</td><td>{day.appLaunches}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        ) : null}
      </section>
    </div>
  );
}
