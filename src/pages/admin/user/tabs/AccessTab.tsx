import { useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, Link2, Plus, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import {
  type AdminAccessCode,
  type AdminCellLicense,
  type AdminProgramKey,
  type AdminUserDetail,
  useAdminAppCodeViaBot,
  useAdminUserAction,
} from '../../../../api/admin';
import { useAppPlans } from '../../../../api/app';
import { MarketplaceScopeToggle } from '../../../../components/MarketplaceScopeToggle';
import { formatDateMsk, int, rub } from '../../../../lib/admin-controls';
import { Badge, Button, Card, Field, Input, Progress, Select, Switch } from '../../../../ui';
import { ConfirmDialog, NumberDialog, ResponsiveTable } from '../../kit';
import type { ResponsiveColumn } from '../../kit';
import {
  GrantCellLicenseModal,
  GrantProgramKeyModal,
  GrantStickerModal,
  GrantSubscriptionModal,
  IndividualOrderModal,
} from '../modals/GrantModals';
import { APP_TERMS, CELL_DEVICES, PLAN_LABEL, daysLeft, periodState, sourceLabel, useQuickRunner, useRunner } from '../shared';
import u from '../user.module.css';

type Sub = AdminUserDetail['app']['subscriptions'][number];
type Addon = NonNullable<AdminUserDetail['app']['addons']>[number];

const tap = { minHeight: 'var(--tap)' } as const;

function untilText(until: string | null | undefined): string {
  return until ? `до ${formatDateMsk(until).slice(0, 5)}` : 'бессрочно';
}

/** «3 по тарифу + 2 вручную до 10.12» */
function slotNote(base: number, total: number | null, until: string | null | undefined): string {
  if (total === null) return 'без лимита';
  const bonus = total - base;
  return bonus > 0 ? `${base} по тарифу + ${bonus} вручную ${untilText(until)}` : 'по тарифу';
}

/* ============ Подписка ============ */

function SubscriptionCard({ detail, onLimits }: { detail: AdminUserDetail; onLimits: () => void }) {
  const userId = detail.userId;
  const ent = detail.app?.entitlements;
  const limits = detail.app?.limits;
  const subs = detail.app?.subscriptions ?? [];
  const current = subs.find(sub => periodState(sub).active) ?? null;
  const ov = detail.overrides;
  const unlimited = Boolean(detail.unlimited?.active);
  const [grantOpen, setGrantOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [revoke, setRevoke] = useState<Sub | null>(null);
  const grantApp = useAdminUserAction<{ userId: string; plan: string; months: number; reason?: string }>('grantAppSubscription');
  const revokeApp = useAdminUserAction<{ userId: string; id: string; reason?: string }>('revokeAppSubscription');
  const run = useRunner();

  const planName = PLAN_LABEL[ent?.plan ?? ''] ?? 'без тарифа';
  const left = daysLeft(ent?.ends_at);
  const activeDevices = (detail.app?.devices ?? []).filter(d => !d.revokedAt).length;
  const activePoints = (detail.app?.points ?? []).filter(p => !p.revokedAt).length;

  let codesNote = 'по тарифу';
  if (unlimited) codesNote = 'безлимит';
  else if (ov?.codes?.active) {
    codesNote =
      ov.codes.mode === 'add'
        ? `${int(limits?.base.codes ?? 0)} по тарифу + ${int(ov.codes.monthly)} вручную ${untilText(ov.codes.until)}`
        : `задано вручную ${untilText(ov.codes.until)}`;
  }
  const slotsUntil = ov?.slots?.active ? ov.slots.until : null;

  const columns: ResponsiveColumn<Sub>[] = [
    { key: 'plan', header: 'Тариф', primary: true, cell: sub => PLAN_LABEL[sub.plan] ?? sub.plan },
    { key: 'period', header: 'Период', cell: sub => `${formatDateMsk(sub.startsAt)} — ${formatDateMsk(sub.endsAt)}` },
    {
      key: 'source',
      header: 'Откуда',
      cell: sub => <Badge tone={sub.source === 'admin' ? 'warning' : 'default'}>{sourceLabel(sub.source)}</Badge>,
    },
    { key: 'limits', header: 'Лимиты', cell: sub => `${sub.codes} подб.${sub.stickers ? ` · ${sub.stickers} стик.` : ''} · ${sub.deviceLimit} ПК` },
    {
      key: 'state',
      header: 'Статус',
      cell: sub => {
        const state = periodState(sub);
        return <Badge tone={state.tone}>{state.label}</Badge>;
      },
    },
  ];

  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>
          Помощник ПВЗ — подписка
          {current ? <Badge tone="success">Активна</Badge> : <Badge>Нет подписки</Badge>}
        </h3>
        <div className={u.cardActions}>
          <Button size="sm" onClick={() => setGrantOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            Выдать подписку
          </Button>
          {current && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setExtendOpen(true)}>
                <RefreshCw size={16} aria-hidden="true" />
                Продлить
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRevoke(current)}>
                Отозвать
              </Button>
            </>
          )}
        </div>
      </div>

      <dl className={u.kv}>
        <div>
          <dt>Тариф</dt>
          <dd>{planName}</dd>
        </div>
        <div>
          <dt>Действует до</dt>
          <dd>{ent?.ends_at ? `${formatDateMsk(ent.ends_at)}${left !== null ? ` · ${left} дн.` : ''}` : '—'}</dd>
        </div>
        <div>
          <dt>Подборы в месяц</dt>
          <dd>{unlimited ? 'без лимита' : limits ? `${int(limits.codesUsed)} / ${int(limits.codesLimit)}` : '—'}</dd>
          <span className={u.kvNote}>{codesNote}</span>
        </div>
        <div>
          <dt>ПК</dt>
          <dd>
            {activeDevices} / {limits ? (limits.devices === null ? '∞' : limits.devices) : '—'}
          </dd>
          {limits && <span className={u.kvNote}>{slotNote(limits.base.devices, limits.devices, slotsUntil)}</span>}
        </div>
        <div>
          <dt>Пункты</dt>
          <dd>
            {activePoints} / {limits ? (limits.points === null ? '∞' : limits.points) : '—'}
          </dd>
          {limits && <span className={u.kvNote}>{slotNote(limits.base.points, limits.points, slotsUntil)}</span>}
        </div>
        <div>
          <dt>Пакеты подборов (ключи)</dt>
          <dd>{int(Number(ent?.packs_left ?? 0))}</dd>
        </div>
      </dl>

      <ManualLimits detail={detail} onLimits={onLimits} />

      <h4 style={{ margin: 'var(--sp-4) 0 var(--sp-2)' }}>История подписок</h4>
      <ResponsiveTable
        rows={subs}
        columns={columns}
        rowKey={sub => sub.id}
        empty={<p className={u.muted}>Подписок нет.</p>}
        rowActions={sub => {
          const state = periodState(sub);
          return state.active || state.future ? (
            <Button variant="ghost" size="sm" style={tap} aria-label="Отозвать подписку" onClick={() => setRevoke(sub)}>
              <Trash2 size={16} aria-hidden="true" />
            </Button>
          ) : null;
        }}
      />

      <GrantSubscriptionModal open={grantOpen} onOpenChange={setGrantOpen} userId={userId} initialPlan={ent?.plan} />
      <NumberDialog
        open={extendOpen}
        onOpenChange={setExtendOpen}
        title="Продлить подписку"
        subtitle={`Тариф «${planName}» продлится как при покупке`}
        label="Месяцев"
        min={1}
        max={12}
        initial={1}
        presets={APP_TERMS.map(m => ({ value: m, label: `${m} мес.` }))}
        confirmLabel="Продлить"
        onConfirm={months => {
          if (!(APP_TERMS as readonly number[]).includes(months)) throw new Error('Срок: 1, 3, 6 или 12 месяцев');
          return run(grantApp, { userId, plan: current?.plan ?? ent?.plan ?? 'standard', months }, 'Подписка продлена');
        }}
      />
      <ConfirmDialog
        open={revoke !== null}
        onOpenChange={open => !open && setRevoke(null)}
        title="Отозвать подписку?"
        description={
          revoke
            ? `${PLAN_LABEL[revoke.plan] ?? revoke.plan}, ${formatDateMsk(revoke.startsAt)} — ${formatDateMsk(revoke.endsAt)}. Подборы и права в Помощнике по этой подписке закончатся сразу.`
            : undefined
        }
        confirmLabel="Отозвать"
        tone="danger"
        requireReason
        onConfirm={({ reason }) => (revoke ? run(revokeApp, { userId, id: revoke.id, reason }, 'Подписка отозвана') : undefined)}
      />
    </Card>
  );
}

/* ============ Ручные лимиты ============ */

function ManualLimits({ detail, onLimits }: { detail: AdminUserDetail; onLimits: () => void }) {
  const ov = detail.overrides;
  const legacy = Number(detail.legacyDeviceBonus) || 0;
  const items: Array<{ title: string; sub: string; on: boolean }> = [];
  if (ov?.codes) {
    items.push({
      title: ov.codes.mode === 'add' ? `+${int(ov.codes.monthly)} подборов в месяц` : `Ровно ${int(ov.codes.monthly)} подборов в месяц`,
      sub: ov.codes.active ? untilText(ov.codes.until) : 'срок истёк',
      on: ov.codes.active,
    });
  }
  if (ov?.slots) {
    const parts = [
      ov.slots.devices ? `+${ov.slots.devices} ПК` : null,
      ov.slots.points ? `+${ov.slots.points} пункт.` : null,
      ov.slots.mirror ? `+${ov.slots.mirror} зерк.` : null,
    ].filter(Boolean);
    if (parts.length) items.push({ title: parts.join(', '), sub: ov.slots.active ? untilText(ov.slots.until) : 'срок истёк', on: ov.slots.active });
  }
  if (legacy > 0 && !(ov?.slots?.active && ov.slots.devices >= legacy)) {
    items.push({ title: `+${legacy} ПК (старая надбавка)`, sub: 'бессрочно', on: true });
  }
  const unlimitedOn = Boolean(ov?.unlimited?.active && ov.unlimited.enabled);
  items.push({
    title: 'Безлимит',
    sub:
      detail.unlimited?.source === 'env'
        ? 'включён в настройках сервера (владелец)'
        : unlimitedOn
          ? `включён ${untilText(ov?.unlimited?.until)}`
          : ov?.unlimited?.enabled
            ? 'срок истёк'
            : 'выключен',
    on: unlimitedOn || detail.unlimited?.source === 'env',
  });

  return (
    <div className={u.box} style={{ marginTop: 'var(--sp-3)' }}>
      <div className={u.boxHead}>
        <h3>
          Ручные лимиты <span className={u.cardSub}>сверх тарифа</span>
        </h3>
        <Button size="sm" variant="secondary" style={tap} onClick={onLimits}>
          <SlidersHorizontal size={16} aria-hidden="true" />
          Изменить лимиты
        </Button>
      </div>
      <div className={u.overrideGrid}>
        {items.map(item => (
          <div key={item.title} className={`${u.overrideItem} ${item.on ? u.overrideOn : ''}`}>
            <strong>{item.title}</strong>
            <span>{item.sub}</span>
          </div>
        ))}
      </div>
      {ov?.note && (
        <p className={u.muted}>
          Заметка: «{ov.note}» · изменено {formatDateMsk(ov.updatedAt)}
        </p>
      )}
    </div>
  );
}

/* ============ Услуги и пакеты ============ */

function AddonsCard({ detail }: { detail: AdminUserDetail }) {
  const userId = detail.userId;
  const appPlans = useAppPlans();
  const addonList = appPlans.data?.addons ?? [];
  const [addonId, setAddonId] = useState('archive');
  const [addonMonths, setAddonMonths] = useState(6);
  const [revoke, setRevoke] = useState<Addon | null>(null);
  const grantAddon = useAdminUserAction<{ userId: string; addon: string; months: number }>('grantAppAddon');
  const revokeAddon = useAdminUserAction<{ userId: string; id: string; reason?: string }>('revokeAppAddon');
  const quick = useQuickRunner();
  const run = useRunner();
  const addonTerms = Object.keys(addonList.find(a => a.id === addonId)?.prices ?? { 6: 0, 12: 0 })
    .map(Number)
    .sort((a, b) => a - b);
  const addons = detail.app?.addons ?? [];

  const columns: ResponsiveColumn<Addon>[] = [
    { key: 'title', header: 'Услуга', primary: true, cell: a => a.title },
    { key: 'period', header: 'Период', cell: a => `${formatDateMsk(a.startsAt)} — ${formatDateMsk(a.endsAt)}` },
    { key: 'source', header: 'Откуда', cell: a => <Badge tone={a.source === 'admin' ? 'warning' : 'default'}>{sourceLabel(a.source)}</Badge> },
    {
      key: 'state',
      header: 'Статус',
      cell: a => {
        const state = periodState(a);
        return <Badge tone={state.tone}>{state.label}</Badge>;
      },
    },
  ];

  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>Услуги и пакеты</h3>
      </div>
      <div className={u.toolbar}>
        <Field label="Что">
          <Select
            value={addonId}
            onChange={event => {
              const next = event.target.value;
              setAddonId(next);
              const terms = Object.keys(addonList.find(a => a.id === next)?.prices ?? {}).map(Number);
              if (terms.length && !terms.includes(addonMonths)) setAddonMonths(Math.min(...terms));
            }}
          >
            {(addonList.length ? addonList : [{ id: 'archive', title: 'Архив клиентов' }]).map(a => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Срок">
          <Select value={String(addonMonths)} onChange={event => setAddonMonths(Number(event.target.value))}>
            {addonTerms.map(m => (
              <option key={m} value={String(m)}>
                {m} мес.
              </option>
            ))}
          </Select>
        </Field>
        <Button loading={grantAddon.isPending} onClick={() => quick(grantAddon, { userId, addon: addonId, months: addonMonths }, 'Подключено')}>
          <Plus size={16} aria-hidden="true" />
          Подключить
        </Button>
      </div>
      <p className={u.muted} style={{ margin: 'var(--sp-2) 0 var(--sp-3)' }}>
        Архив работает вместе с тарифом Стандарт или Про; отзыв закрывает доступ, сам архив (на ПК и в облаке) не удаляется. Пакеты
        добавляют компьютеры и пункты к лимиту тарифа.
      </p>
      <ResponsiveTable
        rows={addons}
        columns={columns}
        rowKey={a => a.id}
        empty={<p className={u.muted}>Услуг нет.</p>}
        rowActions={a => {
          const state = periodState(a);
          return state.active || state.future ? (
            <Button variant="ghost" size="sm" style={tap} aria-label={`Отключить «${a.title}»`} onClick={() => setRevoke(a)}>
              <Trash2 size={16} aria-hidden="true" />
            </Button>
          ) : null;
        }}
      />
      <ConfirmDialog
        open={revoke !== null}
        onOpenChange={open => !open && setRevoke(null)}
        title={`Отключить «${revoke?.title ?? ''}»?`}
        description="Доступ к услуге закроется сразу. Данные (архив на ПК и в облаке) не удаляются."
        confirmLabel="Отключить"
        tone="danger"
        onConfirm={() => (revoke ? run(revokeAddon, { userId, id: revoke.id }, 'Услуга отозвана') : undefined)}
      />
    </Card>
  );
}

/* ============ Коды генератора ============ */

function StickerCodesCard({ detail }: { detail: AdminUserDetail }) {
  const userId = detail.userId;
  const [grantOpen, setGrantOpen] = useState(false);
  const [individualOpen, setIndividualOpen] = useState(false);
  const [topupFor, setTopupFor] = useState<AdminAccessCode | null>(null);
  const topup = useAdminUserAction<{ userId: string; codeId: number; add: number }>('topupSticker');
  const patchCode = useAdminUserAction<{ userId: string; codeId: number; limit?: number; active?: boolean }>('code', 'PATCH');
  const run = useRunner();
  const quick = useQuickRunner();

  const columns: ResponsiveColumn<AdminAccessCode>[] = [
    { key: 'code', header: 'Код', primary: true, cell: code => <span className={u.mono}>{code.code}</span> },
    { key: 'name', header: 'Имя', cell: code => code.name || '—' },
    {
      key: 'gen',
      header: 'Генерации',
      cell: code => (
        <Progress
          value={code.used}
          max={Math.max(1, code.limit)}
          label={
            <span>
              {code.used} из {code.limit}
            </span>
          }
        />
      ),
    },
    {
      key: 'state',
      header: 'Статус',
      cell: code => (
        <Badge tone={code.active ? (code.used >= code.limit ? 'warning' : 'success') : 'error'}>
          {code.active ? (code.used >= code.limit ? 'исчерпан' : 'активен') : 'отключён'}
        </Badge>
      ),
    },
  ];

  const custom = detail.customOrders ?? [];

  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>Коды генератора стикеров</h3>
        <div className={u.cardActions}>
          <Button size="sm" onClick={() => setGrantOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            Выдать код
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setIndividualOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            Индивидуальный заказ
          </Button>
        </div>
      </div>
      <ResponsiveTable
        rows={detail.codes ?? []}
        columns={columns}
        rowKey={code => code.id}
        empty={<p className={u.muted}>Кодов нет. Выдайте код доступа — он сразу появится у человека в кабинете.</p>}
        rowActions={code => (
          <>
            <Button variant="ghost" size="sm" style={tap} onClick={() => setTopupFor(code)}>
              <Plus size={16} aria-hidden="true" />
              Генерации
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={tap}
              onClick={() => quick(patchCode, { userId, codeId: code.id, active: !code.active }, code.active ? 'Код отключён' : 'Код включён')}
            >
              {code.active ? 'Отключить' : 'Включить'}
            </Button>
          </>
        )}
      />

      {custom.length > 0 && (
        <>
          <h4 style={{ margin: 'var(--sp-4) 0 var(--sp-2)' }}>Индивидуальные заказы</h4>
          <ResponsiveTable
            rows={custom}
            rowKey={order => order.id}
            columns={[
              { key: 'title', header: 'Заказ', primary: true, cell: order => order.title },
              { key: 'qty', header: 'Стикеры', cell: order => order.quantity },
              { key: 'credit', header: 'Зачтено', cell: order => `${order.credited_units} шт.` },
              { key: 'due', header: 'К оплате', align: 'end', cell: order => rub(Math.round(Number(order.amount_due) * 100)) },
              {
                key: 'status',
                header: 'Статус',
                cell: order => <Badge tone={order.status === 'paid' ? 'success' : 'warning'}>{order.status === 'paid' ? 'Оплачен' : 'Ожидает оплаты'}</Badge>,
              },
            ]}
          />
        </>
      )}

      <GrantStickerModal open={grantOpen} onOpenChange={setGrantOpen} userId={userId} />
      <IndividualOrderModal open={individualOpen} onOpenChange={setIndividualOpen} userId={userId} />
      <NumberDialog
        open={topupFor !== null}
        onOpenChange={open => !open && setTopupFor(null)}
        title="Добавить генерации"
        subtitle={topupFor ? `Код ${topupFor.code}: осталось ${Math.max(0, topupFor.limit - topupFor.used)} из ${topupFor.limit}` : undefined}
        label="Сколько генераций добавить"
        min={1}
        max={100000}
        initial={100}
        presets={[
          { value: 50, label: '+50' },
          { value: 100, label: '+100' },
          { value: 500, label: '+500' },
        ]}
        preview={value => (topupFor ? <>Станет: <b>{int(Math.max(0, topupFor.limit - topupFor.used) + value)}</b> генераций</> : null)}
        confirmLabel="Добавить"
        onConfirm={add => (topupFor ? run(topup, { userId, codeId: topupFor.id, add }, 'Генерации добавлены') : undefined)}
      />
    </Card>
  );
}

/* ============ Ключи подборов ============ */

function ProgramKeysCard({ detail }: { detail: AdminUserDetail }) {
  const userId = detail.userId;
  const [grantOpen, setGrantOpen] = useState(false);
  const [limitFor, setLimitFor] = useState<AdminProgramKey | null>(null);
  const patchKey = useAdminUserAction<{ userId: string; id: number; limit?: number; active?: boolean }>('programKey', 'PATCH');
  const run = useRunner();
  const quick = useQuickRunner();

  const columns: ResponsiveColumn<AdminProgramKey>[] = [
    { key: 'key', header: 'Ключ', primary: true, cell: key => <span className={u.mono}>{key.key}</span> },
    { key: 'usage', header: 'Подборы', cell: key => `${int(key.used)} из ${int(key.limit)}` },
    { key: 'note', header: 'Пометка', hideOnMobile: true, cell: key => key.note || '—' },
    { key: 'state', header: 'Статус', cell: key => <Badge tone={key.active ? 'success' : 'error'}>{key.active ? 'активен' : 'отозван'}</Badge> },
  ];

  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>Ключи подборов (пакеты)</h3>
        <Button size="sm" variant="secondary" onClick={() => setGrantOpen(true)}>
          <KeyRound size={16} aria-hidden="true" />
          Выдать ключ
        </Button>
      </div>
      <ResponsiveTable
        rows={detail.programKeys ?? []}
        columns={columns}
        rowKey={key => key.id}
        empty={<p className={u.muted}>Ключей нет.</p>}
        rowActions={key => (
          <>
            <Button variant="ghost" size="sm" style={tap} onClick={() => setLimitFor(key)}>
              Лимит
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={tap}
              onClick={() => quick(patchKey, { userId, id: key.id, active: !key.active }, key.active ? 'Ключ отозван' : 'Ключ возвращён')}
            >
              {key.active ? 'Отозвать' : 'Вернуть'}
            </Button>
          </>
        )}
      />
      <GrantProgramKeyModal open={grantOpen} onOpenChange={setGrantOpen} userId={userId} />
      <NumberDialog
        open={limitFor !== null}
        onOpenChange={open => !open && setLimitFor(null)}
        title="Лимит ключа подборов"
        subtitle={limitFor ? `Ключ ${limitFor.key}: использовано ${int(limitFor.used)}` : undefined}
        label="Подборов всего"
        min={Math.max(1, limitFor?.used ?? 1)}
        max={1_000_000}
        initial={limitFor?.limit}
        confirmLabel="Сохранить"
        onConfirm={limit => (limitFor ? run(patchKey, { userId, id: limitFor.id, limit }, 'Лимит ключа изменён') : undefined)}
      />
    </Card>
  );
}

/* ============ ПВЗ Принт ============ */

function CellPrintCard({ detail }: { detail: AdminUserDetail }) {
  const userId = detail.userId;
  const [grantOpen, setGrantOpen] = useState(false);
  const [extendFor, setExtendFor] = useState<AdminCellLicense | null>(null);
  const [devicesFor, setDevicesFor] = useState<AdminCellLicense | null>(null);
  const patchCell = useAdminUserAction<{
    userId: string;
    id: number;
    extendDays?: number;
    deviceLimit?: number;
    marketplaceScope?: 'wb' | 'ozon' | 'both';
    active?: boolean;
  }>('cellLicense', 'PATCH');
  const run = useRunner();
  const quick = useQuickRunner();

  const columns: ResponsiveColumn<AdminCellLicense>[] = [
    { key: 'key', header: 'Ключ', primary: true, cell: l => <span className={u.mono}>{l.key}</span> },
    { key: 'until', header: 'До', cell: l => (l.expiresAt ? formatDateMsk(l.expiresAt) : `не активирован · ${l.durationDays} дн.`) },
    { key: 'devices', header: 'Устройств', cell: l => `${l.devices?.length ?? 0} / ${l.deviceLimit}` },
    {
      key: 'scope',
      header: 'Маркетплейс',
      cell: l => (
        <MarketplaceScopeToggle
          value={l.marketplaceScope === 'legacy_unassigned' ? 'wb' : l.marketplaceScope}
          onChange={marketplaceScope => quick(patchCell, { userId, id: l.id, marketplaceScope }, 'Права изменены')}
          disabled={patchCell.isPending}
        />
      ),
    },
    { key: 'state', header: 'Статус', cell: l => <Badge tone={l.active ? 'success' : 'error'}>{l.active ? 'активна' : 'отозвана'}</Badge> },
  ];

  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>ПВЗ Принт — лицензии</h3>
        <Button size="sm" variant="secondary" onClick={() => setGrantOpen(true)}>
          <Plus size={16} aria-hidden="true" />
          Выдать ключ
        </Button>
      </div>
      <ResponsiveTable
        rows={detail.cellLicenses ?? []}
        columns={columns}
        rowKey={l => l.id}
        empty={<p className={u.muted}>Лицензий нет.</p>}
        rowActions={l => (
          <>
            <Button variant="ghost" size="sm" style={tap} onClick={() => setExtendFor(l)}>
              <RefreshCw size={16} aria-hidden="true" />
              Продлить
            </Button>
            <Button variant="ghost" size="sm" style={tap} onClick={() => setDevicesFor(l)}>
              Устройства
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={tap}
              onClick={() => quick(patchCell, { userId, id: l.id, active: !l.active }, l.active ? 'Ключ отозван' : 'Ключ возвращён')}
            >
              {l.active ? 'Отозвать' : 'Вернуть'}
            </Button>
          </>
        )}
      />
      <GrantCellLicenseModal open={grantOpen} onOpenChange={setGrantOpen} userId={userId} />
      <NumberDialog
        open={extendFor !== null}
        onOpenChange={open => !open && setExtendFor(null)}
        title="Продлить лицензию"
        subtitle={extendFor ? `Ключ ${extendFor.key}${extendFor.expiresAt ? `, сейчас до ${formatDateMsk(extendFor.expiresAt)}` : ', ещё не активирован'}` : undefined}
        label="На сколько дней"
        min={1}
        max={3650}
        initial={30}
        presets={[
          { value: 7, label: '7 дн.' },
          { value: 30, label: '30 дн.' },
          { value: 90, label: '90 дн.' },
          { value: 365, label: '365 дн.' },
        ]}
        preview={days =>
          extendFor?.expiresAt ? (
            <>
              Новый срок: <b>{formatDateMsk(new Date(Math.max(Date.parse(extendFor.expiresAt), Date.now()) + days * 86_400_000).toISOString())}</b>
            </>
          ) : (
            <>
              Срок ключа станет <b>{extendFor ? extendFor.durationDays + days : days}</b> дн.
            </>
          )
        }
        confirmLabel="Продлить"
        onConfirm={days => (extendFor ? run(patchCell, { userId, id: extendFor.id, extendDays: days }, 'Ключ продлён') : undefined)}
      />
      <NumberDialog
        open={devicesFor !== null}
        onOpenChange={open => !open && setDevicesFor(null)}
        title="Число устройств"
        subtitle={devicesFor ? `Ключ ${devicesFor.key}: активирован на ${devicesFor.devices?.length ?? 0}` : undefined}
        label="Устройств"
        min={1}
        max={20}
        initial={devicesFor?.deviceLimit}
        presets={CELL_DEVICES.map(n => ({ value: n, label: String(n) }))}
        confirmLabel="Сохранить"
        onConfirm={deviceLimit => {
          if (!(CELL_DEVICES as readonly number[]).includes(deviceLimit)) throw new Error('Число устройств: 1, 2, 3, 5, 10 или 20');
          return devicesFor ? run(patchCell, { userId, id: devicesFor.id, deviceLimit }, 'Число устройств изменено') : undefined;
        }}
      />
    </Card>
  );
}

/* ============ Привязка актива и код клиента ============ */

function AttachCard({ userId }: { userId: string }) {
  const attach = useAdminUserAction<{ userId: string; kind: string; value: string }>('attach');
  const quick = useQuickRunner();
  const [formKey, setFormKey] = useState(0);
  return (
    <Card>
      <div className={u.cardHead}>
        <h3 className={u.cardTitle}>
          Привязать купленное <span className={u.cardSub}>если человек купил без входа, а потом завёл аккаунт</span>
        </h3>
      </div>
      <form
        key={formKey}
        className={u.toolbar}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const value = String(form.get('value') || '').trim();
          if (!value) return;
          quick(attach, { userId, kind: String(form.get('kind') || 'sticker'), value }, 'Привязано к аккаунту');
          setFormKey(key => key + 1);
        }}
      >
        <Field label="Что">
          <Select name="kind" defaultValue="sticker">
            <option value="sticker">Код генератора</option>
            <option value="program">Ключ подборов</option>
            <option value="cell_print">Ключ ПВЗ Принт</option>
          </Select>
        </Field>
        <Field label="Код или ключ">
          <Input name="value" required pattern="[A-Za-z0-9\-]{4,64}" autoComplete="off" />
        </Field>
        <Button type="submit" variant="secondary" loading={attach.isPending}>
          <Link2 size={16} aria-hidden="true" />
          Привязать
        </Button>
      </form>
    </Card>
  );
}

function CodeViaBotCard({ detail }: { detail: AdminUserDetail }) {
  const codeViaBotUser = useAdminUserAction<{ userId: string; enabled: boolean }>('appCodeViaBot');
  const codeViaBotGlobal = useAdminAppCodeViaBot();
  const quick = useQuickRunner();
  return (
    <Card>
      <h3 className={u.cardTitle} style={{ marginBottom: 'var(--sp-3)' }}>
        Помощник ПВЗ — код клиента
      </h3>
      <Switch
        checked={detail.profile?.app_code_via_bot_off !== true}
        disabled={codeViaBotUser.isPending}
        onChange={event =>
          quick(
            codeViaBotUser,
            { userId: detail.userId, enabled: event.target.checked },
            event.target.checked
              ? 'Код клиента этому аккаунту — через подтверждение в боте (как у всех)'
              : 'Код клиента этому аккаунту выдаётся напрямую, без бота',
          )
        }
        description={
          codeViaBotGlobal.data?.enabled === false
            ? 'Сейчас общий переключатель «Код клиента только через Telegram-бот» (раздел «Программа») выключен — код у всех выдаётся напрямую. Это исключение сработает, когда общий переключатель включат.'
            : 'Выключите для владельца без Telegram: при включённом общем переключателе его компьютеры получают код напрямую, без подтверждения в боте. Программа узнаёт об этом сама при следующем запросе, обновление не нужно.'
        }
      >
        Подтверждение кода клиента через Telegram-бот
      </Switch>
    </Card>
  );
}

/** Вкладка «Доступы и лимиты»: всё, что у человека есть, и всё, что можно выдать. */
export function AccessTab({ detail, onLimits }: { detail: AdminUserDetail; onLimits: () => void }) {
  return (
    <div className={u.tabBody}>
      <SubscriptionCard detail={detail} onLimits={onLimits} />
      <AddonsCard detail={detail} />
      <StickerCodesCard detail={detail} />
      <ProgramKeysCard detail={detail} />
      <CellPrintCard detail={detail} />
      <CodeViaBotCard detail={detail} />
      <AttachCard userId={detail.userId} />
    </div>
  );
}
