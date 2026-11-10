import { useEffect, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Bot, Cloud, Database, Globe, HardDrive, Monitor, Printer, RefreshCw, Server, Settings2, Webhook } from 'lucide-react';
import { refreshAdminSystem, useAdminSystem } from '../../api/admin';
import type { AdminSystem, SvcStatus } from '../../api/admin';
import { formatMskDateTime } from '../../lib/admin-audit';
import { Badge, Button, Skeleton, useToast } from '../../ui';
import { DataState, StatusDot, errorText } from './kit';
import type { StatusDotProps } from './kit';
import s from '../../layout/AdminShell.module.css';

const STATUS: Record<SvcStatus, { tone: StatusDotProps['tone']; label: string }> = {
  ok: { tone: 'ok', label: 'Работает' },
  warning: { tone: 'warning', label: 'Внимание' },
  down: { tone: 'error', label: 'Не отвечает' },
  unknown: { tone: 'muted', label: 'Нет данных' },
};

const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('ru-RU');

/** «24,8 ГБ», «312 МБ», «182 МБ» — двоичные единицы, как показывает сервер (df, Supabase). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit >= 3 ? decimal.format(value) : integer.format(Math.round(value))} ${units[unit]}`;
}

/** «3 д 4 ч», «5 ч 12 мин», «12 мин», «40 с». */
export function formatDuration(seconds: number): string {
  const sec = Math.max(0, Math.floor(seconds));
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин`;
  return `${sec} с`;
}

/** «3 дня назад», «2 ч назад», «только что». */
function ago(iso: string | null): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const sec = Math.max(0, (Date.now() - time) / 1000);
  if (sec < 60) return 'только что';
  if (sec < 86_400) return `${formatDuration(sec)} назад`;
  const days = Math.floor(sec / 86_400);
  const m10 = days % 10;
  const m100 = days % 100;
  const word = m10 === 1 && m100 !== 11 ? 'день' : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? 'дня' : 'дней';
  return `${days} ${word} назад`;
}

function ServiceCard({
  Icon,
  title,
  extra,
  status,
  value,
  caption,
  note,
}: {
  Icon: ComponentType<{ size?: number }>;
  title: string;
  extra?: ReactNode;
  status: SvcStatus;
  value: ReactNode;
  caption?: string;
  note?: ReactNode;
}) {
  const meta = STATUS[status] ?? STATUS.unknown;
  return (
    <section className={s.sysCard} data-status={status}>
      <div className={s.sysCardHead}>
        <span className={s.sysIcon}>
          <Icon size={18} />
        </span>
        <h2>
          {title}
          {extra && <span className={s.sysExtra}> {extra}</span>}
        </h2>
        <span className={s.sysPill} data-tone={meta.tone}>
          <StatusDot tone={meta.tone} label={meta.label} />
        </span>
      </div>
      <div className={s.sysValue}>
        <b>{value}</b>
        {caption && <span>{caption}</span>}
      </div>
      {note && <div className={s.mutedNote}>{note}</div>}
    </section>
  );
}

function Meter({
  usedPercent,
  markPercent,
  label,
  left,
  mark,
  right,
}: {
  usedPercent: number;
  markPercent: number;
  label: string;
  left: string;
  mark: string;
  right: string;
}) {
  const used = Math.min(100, Math.max(0, usedPercent));
  const at = Math.min(100, Math.max(0, markPercent));
  return (
    <div className={s.sysMeter}>
      <div className={s.sysTrack} role="img" aria-label={label}>
        <div className={`${s.sysFill} ${used >= at ? s.sysFillAlert : ''}`} style={{ width: `${used}%` }} />
        <div className={s.sysMark} style={{ left: `${at}%` }} />
      </div>
      <div className={s.sysScale}>
        <span>{left}</span>
        <span style={{ left: `${at}%` }} className={s.sysScaleMark}>
          {mark}
        </span>
        <span>{right}</span>
      </div>
    </div>
  );
}

function NoData({ title, Icon }: { title: string; Icon: ComponentType<{ size?: number }> }) {
  return <ServiceCard Icon={Icon} title={title} status="unknown" value="—" note="Сервер не смог получить данные этого блока" />;
}

function BotCard({ bot }: { bot: AdminSystem['bot'] }) {
  if (!bot) return <NoData Icon={Bot} title="Telegram-бот" />;
  const alerts = Object.entries(bot.alerts ?? {}).filter(([, alert]) => alert?.active).map(([key]) => key);
  const alertNames: Record<string, string> = { updates: 'апдейты', relay: 'релей', webhook: 'вебхук', 'bot-node': 'узел бота' };
  const windowNote = bot.window
    ? `За окно: ${integer.format(bot.window.total)} апдейтов, медленных ${bot.window.slow}, с ошибкой ${bot.window.failed}, худший ${integer.format(bot.window.worstMs)} мс`
    : null;
  return (
    <ServiceCard
      Icon={Bot}
      title="Telegram-бот"
      status={bot.status}
      value={bot.processesUpdates && bot.lastUpdateAgoSec !== null ? formatDuration(bot.lastUpdateAgoSec) : '—'}
      caption={bot.processesUpdates ? 'последний апдейт' : 'апдейты обрабатывает узел в Германии'}
      note={
        <>
          {windowNote ?? (bot.processesUpdates ? 'Окно апдейтов пока пустое' : 'Окно апдейтов живёт на узле бота')}
          {alerts.length > 0 && (
            <>
              {' · '}
              <span className={s.deltaDown}>тревога: {alerts.map(key => alertNames[key] ?? key).join(', ')}</span>
            </>
          )}
        </>
      }
    />
  );
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function SystemView({ data }: { data: AdminSystem }) {
  const { relay, webhook, botNode, site, egress, disk, database, backups, programs } = data;

  const diskUsed = disk ? disk.totalBytes - disk.freeBytes : 0;
  const diskMark = disk && disk.totalBytes > 0 ? ((disk.totalBytes - disk.alertFreeBytes) / disk.totalBytes) * 100 : 85;
  const diskToMark = disk ? disk.freeBytes - disk.alertFreeBytes : 0;
  const dbPercent = database && database.limitBytes > 0 ? (database.sizeBytes / database.limitBytes) * 100 : 0;
  const dbMark = database && database.limitBytes > 0 ? (database.alertBytes / database.limitBytes) * 100 : 80;

  return (
    <div className="stack-lg">
      <div className={s.sysGrid}>
        <BotCard bot={data.bot} />
        {relay ? (
          <ServiceCard
            Icon={Globe}
            title="Релей"
            extra={<span className={s.auMono}>{hostOf(relay.base) ?? relay.base}</span>}
            status={relay.status}
            value={relay.latencyMs !== null ? `${integer.format(relay.latencyMs)} мс` : '—'}
            caption="отклик"
            note={relay.error ? <span className={s.auMono}>{relay.error}</span> : 'Через него идут Telegram и Supabase'}
          />
        ) : (
          <NoData Icon={Globe} title="Релей" />
        )}
        {webhook ? (
          <ServiceCard
            Icon={Webhook}
            title="Вебхук Telegram"
            status={webhook.status}
            value={integer.format(webhook.pendingUpdates)}
            caption="ожидают доставки"
            note={
              !webhook.url
                ? 'Вебхук не задан'
                : webhook.lastErrorAt
                  ? `Последняя ошибка ${ago(webhook.lastErrorAt)}${webhook.lastErrorMessage ? `: ${webhook.lastErrorMessage}` : ''}`
                  : 'Ошибок доставки нет'
            }
          />
        ) : (
          <NoData Icon={Webhook} title="Вебхук Telegram" />
        )}
        {botNode ? (
          <ServiceCard
            Icon={Server}
            title="Узел бота (Германия)"
            status={botNode.status}
            value={botNode.release ?? (botNode.latencyMs !== null ? `${integer.format(botNode.latencyMs)} мс` : '—')}
            caption={botNode.release ? 'релиз' : 'отклик'}
            note={
              botNode.error ? (
                <span className={s.auMono}>{botNode.error}</span>
              ) : botNode.url ? (
                'Выкладывается отдельно от сайта'
              ) : (
                'BOT_NODE_URL не задан — бот работает в процессе сайта'
              )
            }
          />
        ) : (
          <NoData Icon={Server} title="Узел бота (Германия)" />
        )}
        <ServiceCard
          Icon={Monitor}
          title="Сервер сайта"
          status={site.status}
          value={formatDuration(site.uptimeSec)}
          caption="аптайм"
          note={
            <>
              Релиз <span className={s.auMono}>{site.release ?? '—'}</span>
              {site.role ? ` · роль ${site.role}` : ''}
            </>
          }
        />
        <ServiceCard
          Icon={Cloud}
          title="Трафик Supabase (Egress)"
          status={egress.status}
          value={egress.note ? 'См. примечание' : 'Нет данных'}
          caption={egress.note ? undefined : 'Supabase не отдаёт расход по API'}
          note={egress.note ?? 'Смотрите в панели Supabase → Usage'}
        />
      </div>

      <div className={s.sysTwo}>
        {disk ? (
          <section className={s.sysCard}>
            <div className={s.sysCardHead}>
              <span className={s.sysIcon}><HardDrive size={18} /></span>
              <h2>Диск сервера</h2>
              <Badge tone={disk.status === 'ok' ? 'success' : disk.status === 'unknown' ? 'default' : 'error'}>
                {disk.status === 'ok' ? 'В норме' : STATUS[disk.status].label}
              </Badge>
            </div>
            <div className={s.sysValue}>
              <b>{formatBytes(diskUsed)}</b>
              <span>из {formatBytes(disk.totalBytes)} · {Math.round(disk.usedPercent)}%</span>
            </div>
            <Meter
              usedPercent={disk.usedPercent}
              markPercent={diskMark}
              label={`Занято ${Math.round(disk.usedPercent)}% диска, порог предупреждения ${Math.round(diskMark)}%`}
              left="0"
              mark={`порог ${Math.round(diskMark)}%`}
              right={formatBytes(disk.totalBytes)}
            />
            <div className={s.mutedNote}>
              {diskToMark > 0 ? `До порога ещё ${formatBytes(diskToMark)}` : 'Порог пройден — освободите место'}
              {' · '}свободно {formatBytes(disk.freeBytes)}
            </div>
          </section>
        ) : (
          <NoData Icon={HardDrive} title="Диск сервера" />
        )}
        {database ? (
          <section className={s.sysCard}>
            <div className={s.sysCardHead}>
              <span className={s.sysIcon}><Database size={18} /></span>
              <h2>База данных</h2>
              <Badge tone={database.status === 'ok' ? 'success' : database.status === 'unknown' ? 'default' : 'error'}>
                {database.status === 'ok' ? 'В норме' : STATUS[database.status].label}
              </Badge>
            </div>
            <div className={s.sysValue}>
              <b>{formatBytes(database.sizeBytes)}</b>
              <span>из {formatBytes(database.limitBytes)} · {Math.round(dbPercent)}%</span>
            </div>
            <Meter
              usedPercent={dbPercent}
              markPercent={dbMark}
              label={`Занято ${formatBytes(database.sizeBytes)} из ${formatBytes(database.limitBytes)}, тревога с ${formatBytes(database.alertBytes)}`}
              left="0"
              mark={`${formatBytes(database.alertBytes)} · тревога`}
              right={formatBytes(database.limitBytes)}
            />
            <div className={s.mutedNote}>
              {database.alertBytes > database.sizeBytes
                ? `До тревоги ${formatBytes(database.alertBytes - database.sizeBytes)}`
                : 'Тревога: база подходит к пределу тарифа'}
            </div>
          </section>
        ) : (
          <NoData Icon={Database} title="База данных" />
        )}
      </div>

      <div className={s.sysTwo}>
        {backups ? (
          <section className={`${s.sysCard} ${s.sysFlush}`}>
            <div className={`${s.sysCardHead} ${s.sysPadded}`}>
              <span className={s.sysIcon}><Archive size={18} /></span>
              <h2>Бэкапы</h2>
              <span className={s.sysPill} data-tone={STATUS[backups.status].tone}>
                <StatusDot
                  tone={STATUS[backups.status].tone}
                  label={backups.status === 'ok' ? 'Свежий есть' : backups.lastAt ? 'Давно не было' : 'Нет ни одного'}
                />
              </span>
            </div>
            <div className={`${s.sysValue} ${s.sysPadded}`}>
              <b>Последний</b>
              <span>
                {backups.lastAt
                  ? `${formatMskDateTime(backups.lastAt)} · ${ago(backups.lastAt)}${backups.items[0] ? ` · ${formatBytes(backups.items[0].sizeBytes)}` : ''}`
                  : 'нет файлов'}
              </span>
            </div>
            {backups.items.length > 0 && (
              <table className={s.ovTable}>
                <thead>
                  <tr><th>Дата</th><th className={s.num}>Размер</th><th>Файл</th></tr>
                </thead>
                <tbody>
                  {backups.items.slice(0, 7).map(item => (
                    <tr key={item.name}>
                      <td>{formatMskDateTime(item.modifiedAt)}</td>
                      <td className={s.num}>{formatBytes(item.sizeBytes)}</td>
                      <td className={s.auMono}>{item.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className={`${s.mutedNote} ${s.sysPadded}`}>
              Хранятся 14 последних · папка <span className={s.auMono}>{backups.dir}</span>
            </div>
          </section>
        ) : (
          <NoData Icon={Archive} title="Бэкапы" />
        )}

        <div className="stack">
          <section className={s.sysCard}>
            <h2 className={s.sysPlainTitle}>Программы</h2>
            <div className={s.sysProgram}>
              <span className={s.sysIcon}><Monitor size={18} /></span>
              <span className={s.sysProgramText}>
                <b>Помощник ПВЗ</b>
                {programs.pvzHelper ? (
                  <span>
                    Последняя <span className={s.auMono}>{programs.pvzHelper.latest ?? '—'}</span> · минимальная{' '}
                    <span className={s.auMono}>{programs.pvzHelper.minVersion ?? 'не задана'}</span>
                    {programs.pvzHelper.mandatory ? ' · обязательное обновление' : ''}
                  </span>
                ) : (
                  <span>Нет данных</span>
                )}
              </span>
              {programs.pvzHelper?.devicesBelowMin != null && (
                <Badge tone={programs.pvzHelper.devicesBelowMin > 0 ? 'warning' : 'success'}>
                  {programs.pvzHelper.devicesBelowMin > 0 ? `${programs.pvzHelper.devicesBelowMin} ПК на старых` : 'Все ПК свежие'}
                </Badge>
              )}
            </div>
            <div className={s.sysProgram}>
              <span className={s.sysIcon}><Printer size={18} /></span>
              <span className={s.sysProgramText}>
                <b>ПВЗ Принт</b>
                {programs.cellPrint ? (
                  <span>
                    Последняя <span className={s.auMono}>{programs.cellPrint.latest ?? '—'}</span> ·{' '}
                    {programs.cellPrint.signed ? 'канал обновлений подписан' : 'канал обновлений без подписи'}
                  </span>
                ) : (
                  <span>Нет данных</span>
                )}
              </span>
              {programs.cellPrint && (
                <Badge tone={programs.cellPrint.signed ? 'success' : 'warning'}>{programs.cellPrint.signed ? 'Подписан' : 'Без подписи'}</Badge>
              )}
            </div>
          </section>

          <section className={s.sysCard}>
            <div className={s.sysCardHead}>
              <span className={s.sysIcon}><Settings2 size={18} /></span>
              <h2>Переменные сервера</h2>
              <span className={s.mutedInline}>только чтение</span>
            </div>
            {data.env.length === 0 ? (
              <div className={s.mutedNote}>Нет данных</div>
            ) : (
              <dl className={s.sysEnv}>
                {data.env.map(item => (
                  <div key={item.name}>
                    <dt className={s.auMono}>{item.name}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className={s.mutedNote}>
              Меняются в <span className={s.auMono}>/srv/shk-wb/.env</span>, затем перезапуск
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

const FORCE_COOLDOWN_MS = 10_000;

export function AdminSystemPage() {
  const system = useAdminSystem();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [, tick] = useState(0);

  // Перерисовка раз в 15 с — «обновлено N мин назад» и отсчёт паузы кнопки.
  useEffect(() => {
    const timer = window.setInterval(() => tick(n => n + 1), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = window.setTimeout(() => setCooldownUntil(0), Math.max(0, cooldownUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [cooldownUntil]);

  const refresh = async () => {
    if (refreshing || cooldownUntil > Date.now()) return;
    setRefreshing(true);
    try {
      await refreshAdminSystem(queryClient);
    } catch (error) {
      toast(`Не удалось обновить: ${errorText(error)}`, 'error');
    } finally {
      setRefreshing(false);
      // Сервер пускает force не чаще раза в 10 с — не даём жать зря.
      setCooldownUntil(Date.now() + FORCE_COOLDOWN_MS);
    }
  };

  const generated = system.data?.generatedAt;
  const updated = generated ? ago(generated) : null;

  return (
    <div className="page stack-lg">
      <div className={s.spread}>
        <p className={s.pageSub}>
          Состояние серверов, бота, базы и бэкапов
          {updated ? ` · обновлено ${updated}${system.data?.cached ? ' (из кеша)' : ''}` : ''}
        </p>
        <Button
          variant="secondary"
          className={s.tapButton}
          onClick={() => void refresh()}
          loading={refreshing}
          disabled={cooldownUntil > Date.now()}
        >
          {!refreshing && <RefreshCw size={16} aria-hidden="true" />}
          Обновить
        </Button>
      </div>
      <DataState
        query={system}
        empty={null}
        skeleton={
          <div className={s.sysGrid}>
            {[0, 1, 2, 3, 4, 5].map(i => (
              <Skeleton key={i} height={132} />
            ))}
          </div>
        }
      >
        {data => <SystemView data={data} />}
      </DataState>
    </div>
  );
}
