import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { type AdminUserDetail, useAdminUserAction } from '../../../../api/admin';
import { useAccountAction, useAdminUserSection } from '../../../../api/admin-controls';
import type { UserSectionData } from '../../../../api/admin-controls';
import { formatMskDateTime } from '../../../../lib/admin-audit';
import { formatDateMsk } from '../../../../lib/admin-controls';
import { Badge, Button, Card } from '../../../../ui';
import { ConfirmDialog, DataState, EmptyBlock, ResponsiveTable, StatusDot } from '../../kit';
import type { ResponsiveColumn } from '../../kit';
import { useRunner } from '../shared';
import u from '../user.module.css';

type Device = AdminUserDetail['app']['devices'][number];
type Point = NonNullable<AdminUserDetail['app']['points']>[number];
type CellDevice = UserSectionData['cellDevices']['items'][number];
type Usage = UserSectionData['usage']['items'][number];

const tap = { minHeight: 'var(--tap)' } as const;
const ROLE_LABEL = { owner: 'Владелец', work: 'Сотрудник' } as const;

/** «3 ч назад» / «2 дн. назад» / дата. */
function agoLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '—';
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 2) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  if (days < 8) return `${days} дн. назад`;
  return formatDateMsk(iso);
}

function ComputersCard({ detail, onMessageDevice }: { detail: AdminUserDetail; onMessageDevice: (deviceId: string) => void }) {
  const userId = detail.userId;
  const devices = detail.app?.devices ?? [];
  const active = devices.filter(d => !d.revokedAt);
  const limit = detail.app?.limits?.devices;
  const [roleFor, setRoleFor] = useState<Device | null>(null);
  const [role, setRole] = useState<'owner' | 'work'>('work');
  const [revokeFor, setRevokeFor] = useState<Device | null>(null);
  const setDeviceRole = useAccountAction('setDeviceRole');
  const revokeDevice = useAdminUserAction<{ userId: string; id: string; reason?: string }>('revokeAppDevice');
  const run = useRunner();

  const columns: ResponsiveColumn<Device>[] = [
    { key: 'name', header: 'Имя', primary: true, cell: d => d.name || 'ПК' },
    { key: 'role', header: 'Роль', cell: d => (d.role ? ROLE_LABEL[d.role] : '—') },
    { key: 'version', header: 'Версия', cell: d => <span className={u.mono}>{d.appVersion || '—'}</span> },
    {
      key: 'seen',
      header: 'Последний раз',
      cell: d =>
        d.revokedAt ? (
          <Badge tone="error">отвязан {formatDateMsk(d.revokedAt)}</Badge>
        ) : d.online ? (
          <StatusDot tone="ok" label="в сети" />
        ) : (
          <span title={d.lastSeenAt ? formatMskDateTime(d.lastSeenAt) : undefined}>{agoLabel(d.lastSeenAt)}</span>
        ),
    },
  ];

  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>
          Компьютеры{' '}
          <span className={u.cardSub}>
            {active.length} из {limit === null ? '∞' : (limit ?? '—')} по лимиту
          </span>
        </h3>
      </div>
      <ResponsiveTable
        rows={devices}
        columns={columns}
        rowKey={d => d.id}
        empty={<p className={u.muted}>Компьютеров нет — появятся, когда Помощник ПВЗ войдёт в аккаунт.</p>}
        rowActions={d =>
          d.revokedAt ? null : (
            <>
              <Button variant="ghost" size="sm" style={tap} onClick={() => onMessageDevice(d.id)}>
                <MessageSquare size={16} aria-hidden="true" />
                Сообщение
              </Button>
              <Button
                variant="ghost"
                size="sm"
                style={tap}
                onClick={() => {
                  setRole(d.role === 'owner' ? 'work' : 'owner');
                  setRoleFor(d);
                }}
              >
                Роль
              </Button>
              <Button variant="ghost" size="sm" style={tap} onClick={() => setRevokeFor(d)}>
                Отвязать
              </Button>
            </>
          )
        }
      />

      <ConfirmDialog
        open={roleFor !== null}
        onOpenChange={open => !open && setRoleFor(null)}
        title={`Роль ПК «${roleFor?.name ?? ''}»`}
        description="Владелец видит всё; сотрудник — только работу пункта, без денег и настроек аккаунта."
        confirmLabel="Сохранить роль"
        onConfirm={() => (roleFor ? run(setDeviceRole, { userId, deviceId: roleFor.id, role }, `Роль: ${ROLE_LABEL[role]}`) : undefined)}
      >
        <div className={u.seg} role="radiogroup" aria-label="Роль ПК">
          {(['owner', 'work'] as const).map(value => (
            <button key={value} type="button" role="radio" aria-checked={role === value} className={u.segBtn} onClick={() => setRole(value)}>
              {ROLE_LABEL[value]}
            </button>
          ))}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={revokeFor !== null}
        onOpenChange={open => !open && setRevokeFor(null)}
        title={`Отвязать ПК «${revokeFor?.name ?? ''}»?`}
        description="Программа на этом ПК выйдет из аккаунта и забудет ключ устройства. Чтобы вернуть ПК, на нём нужно будет войти заново."
        confirmLabel="Отвязать ПК"
        tone="danger"
        requireReason
        onConfirm={({ reason }) => (revokeFor ? run(revokeDevice, { userId, id: revokeFor.id, reason }, 'Компьютер отвязан') : undefined)}
      />
    </Card>
  );
}

function PointsCard({ detail }: { detail: AdminUserDetail }) {
  const userId = detail.userId;
  const points = detail.app?.points ?? [];
  const active = points.filter(p => !p.revokedAt);
  const limit = detail.app?.limits?.points;
  const [revokeFor, setRevokeFor] = useState<Point | null>(null);
  const revokePoint = useAdminUserAction<{ userId: string; id: string }>('revokeAppPoint');
  const run = useRunner();

  const columns: ResponsiveColumn<Point>[] = [
    {
      key: 'name',
      header: 'Пункт',
      primary: true,
      cell: p => (
        <>
          {p.name || 'Пункт'} <span className={u.muted}>№{p.wbPointId}</span>
        </>
      ),
    },
    { key: 'created', header: 'Подключён', cell: p => formatDateMsk(p.createdAt) },
    { key: 'sync', header: 'Архив обновлён', cell: p => (p.lastSyncAt ? formatDateMsk(p.lastSyncAt) : '—') },
    { key: 'state', header: 'Статус', cell: p => <Badge tone={p.revokedAt ? 'error' : 'success'}>{p.revokedAt ? 'отключён' : 'активен'}</Badge> },
  ];

  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>
          Пункты{' '}
          <span className={u.cardSub}>
            {active.length} из {limit === null ? '∞' : (limit ?? '—')} по лимиту
          </span>
        </h3>
      </div>
      <ResponsiveTable
        rows={points}
        columns={columns}
        rowKey={p => p.id}
        empty={<p className={u.muted}>Пунктов нет — подключатся сами, когда программа войдёт в аккаунт на ПК пункта.</p>}
        rowActions={p =>
          p.revokedAt ? null : (
            <Button variant="ghost" size="sm" style={tap} onClick={() => setRevokeFor(p)}>
              Отключить
            </Button>
          )
        }
      />
      <ConfirmDialog
        open={revokeFor !== null}
        onOpenChange={open => !open && setRevokeFor(null)}
        title={`Отключить пункт №${revokeFor?.wbPointId ?? ''}?`}
        description="Пункт освободит место в лимите. Подключится снова, когда программа войдёт в аккаунт на ПК этого пункта."
        confirmLabel="Отключить пункт"
        tone="danger"
        onConfirm={() => (revokeFor ? run(revokePoint, { userId, id: revokeFor.id }, 'Пункт отключён') : undefined)}
      />
    </Card>
  );
}

function CellDevicesCard({ userId }: { userId: string }) {
  const query = useAdminUserSection(userId, 'cellDevices');
  const columns: ResponsiveColumn<CellDevice>[] = [
    { key: 'name', header: 'Имя', primary: true, cell: d => d.name || 'ПК' },
    { key: 'version', header: 'Версия', cell: d => <span className={u.mono}>{d.appVersion || '—'}</span> },
    { key: 'first', header: 'Впервые', cell: d => formatDateMsk(d.firstSeenAt) },
    { key: 'last', header: 'Последний раз', cell: d => (d.revokedAt ? <Badge tone="error">отвязан</Badge> : agoLabel(d.lastSeenAt)) },
  ];
  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>ПВЗ Принт — компьютеры</h3>
      </div>
      <DataState
        query={query}
        isEmpty={data => data.items.length === 0}
        empty={<EmptyBlock title="Компьютеров ПВЗ Принт нет" text="Появятся, когда программа войдёт в аккаунт." />}
      >
        {data => <ResponsiveTable rows={data.items} columns={columns} rowKey={d => d.id} />}
      </DataState>
    </Card>
  );
}

function UsageCard({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const query = useAdminUserSection(userId, 'usage', open);
  const columns: ResponsiveColumn<Usage>[] = [
    { key: 'at', header: 'Когда', primary: true, cell: x => formatMskDateTime(x.createdAt) },
    { key: 'kind', header: 'Что', cell: x => (x.kind === 'code' ? 'подбор кода' : 'стикеры') },
    { key: 'amount', header: 'Сколько', align: 'end', cell: x => x.amount },
    { key: 'source', header: 'Откуда', cell: x => (x.source === 'pack' ? 'пакет' : 'квота') },
    { key: 'device', header: 'ПК', cell: x => x.deviceName ?? '—' },
  ];
  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>Последние списания подборов</h3>
        <Button variant="ghost" size="sm" style={tap} aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? 'Скрыть' : 'Показать'}
        </Button>
      </div>
      {open && (
        <DataState query={query} isEmpty={data => data.items.length === 0} empty={<EmptyBlock title="Списаний не было" />}>
          {data => <ResponsiveTable rows={data.items} columns={columns} rowKey={x => x.id} />}
        </DataState>
      )}
    </Card>
  );
}

/** Вкладка «ПК и пункты». */
export function DevicesTab({ detail, onMessageDevice }: { detail: AdminUserDetail; onMessageDevice: (deviceId: string) => void }) {
  return (
    <div className={u.tabBody}>
      <ComputersCard detail={detail} onMessageDevice={onMessageDevice} />
      <PointsCard detail={detail} />
      <CellDevicesCard userId={detail.userId} />
      <UsageCard userId={detail.userId} />
    </div>
  );
}
