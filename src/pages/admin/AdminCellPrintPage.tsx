import { useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { MarketplaceScopeToggle } from '../../components/MarketplaceScopeToggle';
import type { CellPrintMarketplaceScope } from '../../lib/pricing';
import {
  type AdminCellDevice, type AdminCellLicense, useAdminResource, useAdminResourceMutation,
} from '../../api/admin';
import { shortDate } from '../../lib/admin-users';
import {
  Alert, Badge, Button, Card, Checkbox, Field, Input, Select, Textarea, useToast,
} from '../../ui';
import { ConfirmDialog, DataState, EmptyBlock, NumberDialog, ResponsiveTable } from './kit';
import type { ResponsiveColumn } from './kit';
import { useRemoveWithReason } from './usePageActions';
import s from '../../layout/AdminShell.module.css';
import p from './admin-pages.module.css';

const DURATIONS = [3, 7, 30, 90, 180, 365];
const DEVICES = [1, 2, 3, 5, 10, 20];
type Promo = { id: number; code: string; discount: number; scope: string; limit: number; used: number; active: boolean };
type Announcement = { id: number; text: string; url: string | null; level: string; active: boolean };
type Release = { id: string; version: string; minimumVersion: string; downloadUrl: string; notes: string; mandatory: boolean };

const PROMO_SCOPE: Record<string, string> = { all: 'Всё', program: 'Программа', license: 'Ключ' };
const LEVEL_LABEL: Record<string, string> = { info: 'Обычное', warning: 'Предупреждение', important: 'Важное' };

function addDays(iso: string | null, days: number): string {
  // Неактивированный ключ продлевается длительностью, а не датой — дату показываем только у активного.
  if (!iso) return `${days} дн. к сроку`;
  const base = Math.max(Date.parse(iso), Date.now());
  return shortDate(new Date(base + days * 86_400_000).toISOString());
}

/** Все пять подразделов старой вкладки «Печать ячеек» на одной странице. */
export function AdminCellPrintPage() {
  const toast = useToast();
  const [newMarketplaceScope, setNewMarketplaceScope] = useState<CellPrintMarketplaceScope>('wb');
  const licenses = useAdminResource<AdminCellLicense>('cellLicense');
  const licenseMutation = useAdminResourceMutation<{ durationDays: number; deviceLimit: number; marketplaceScope: string; note: string }>('cellLicense');
  const activations = useAdminResource<AdminCellDevice>('cellActivation');
  const removeActivation = useRemoveWithReason('cellActivation');
  const promos = useAdminResource<Promo>('cellPromo');
  const promoMutation = useAdminResourceMutation<{ code: string; discount: number; scope: string; limit: number; active: boolean }>('cellPromo');
  const announcements = useAdminResource<Announcement>('cellAnnouncement');
  const announcementMutation = useAdminResourceMutation<{ text: string; url: string; button: string; level: string; active: boolean }>('cellAnnouncement');
  const removeAnnouncement = useRemoveWithReason('cellAnnouncement');
  const releases = useAdminResource<Release>('cellRelease');
  const releaseMutation = useAdminResourceMutation<{ version: string; minimumVersion: string; downloadUrl: string; notes: string; mandatory: boolean }>('cellRelease');
  const release = releases.data?.[0];

  const [extendFor, setExtendFor] = useState<AdminCellLicense | null>(null);
  const [devicesFor, setDevicesFor] = useState<AdminCellLicense | null>(null);
  const [deviceLimit, setDeviceLimit] = useState(1);
  const [releaseDevice, setReleaseDevice] = useState<AdminCellDevice | null>(null);
  const [deleteAnnouncement, setDeleteAnnouncement] = useState<Announcement | null>(null);

  useEffect(() => {
    if (devicesFor) setDeviceLimit(devicesFor.deviceLimit);
  }, [devicesFor]);

  const fail = (error: Error) => toast(error.message, 'error');

  const licenseColumns: ResponsiveColumn<AdminCellLicense>[] = [
    { key: 'key', header: 'Ключ', primary: true, cell: license => <span className={p.mono}>{license.key}</span> },
    {
      key: 'scope',
      header: 'Права',
      cell: license => (
        <MarketplaceScopeToggle
          value={license.marketplaceScope === 'legacy_unassigned' ? 'wb' : license.marketplaceScope}
          onChange={marketplaceScope => licenseMutation.update.mutate({ id: license.id, marketplaceScope } as never, { onError: fail })}
          disabled={licenseMutation.update.isPending}
        />
      ),
    },
    { key: 'duration', header: 'Срок', cell: license => `${license.durationDays} дн.` },
    { key: 'devices', header: 'Устройства', cell: license => license.deviceLimit },
    { key: 'expires', header: 'Действует до', cell: license => (license.expiresAt ? shortDate(license.expiresAt) : 'не активирован') },
    {
      key: 'status',
      header: 'Статус',
      cell: license => <Badge tone={license.active ? 'success' : 'error'}>{license.active ? 'Активен' : 'Отозван'}</Badge>,
    },
  ];

  const deviceColumns: ResponsiveColumn<AdminCellDevice>[] = [
    { key: 'device', header: 'Устройство', primary: true, cell: device => <span className={p.mono}>••••{device.deviceHash.slice(-6)}</span> },
    { key: 'license', header: 'Ключ №', cell: device => device.licenseId },
    { key: 'first', header: 'Первый вход', cell: device => shortDate(device.firstSeenAt) },
    { key: 'last', header: 'Последний', cell: device => shortDate(device.lastSeenAt) },
  ];

  const promoColumns: ResponsiveColumn<Promo>[] = [
    { key: 'code', header: 'Код', primary: true, cell: promo => <span className={p.mono}>{promo.code}</span> },
    { key: 'discount', header: 'Скидка', cell: promo => `${promo.discount}%` },
    { key: 'scope', header: 'Область', cell: promo => PROMO_SCOPE[promo.scope] ?? promo.scope },
    { key: 'used', header: 'Использовано', cell: promo => `${promo.used} из ${promo.limit}` },
    {
      key: 'status',
      header: 'Статус',
      cell: promo => <Badge tone={promo.active ? 'success' : 'error'}>{promo.active ? 'Активен' : 'Отключён'}</Badge>,
    },
  ];

  const announcementColumns: ResponsiveColumn<Announcement>[] = [
    { key: 'text', header: 'Текст', primary: true, cell: item => <span className={p.cellText}>{item.text}</span> },
    { key: 'level', header: 'Важность', cell: item => LEVEL_LABEL[item.level] ?? item.level },
    {
      key: 'status',
      header: 'Статус',
      cell: item => <Badge tone={item.active ? 'success' : 'error'}>{item.active ? 'Показывается' : 'Скрыто'}</Badge>,
    },
  ];

  return (
    <div className="page stack-lg">
      <Card>
        <h3>Выдать ключ вручную</h3>
        <form
          className={`${s.toolbar} ${p.formRow}`}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            licenseMutation.create.mutate({
              durationDays: Number(form.get('durationDays')),
              deviceLimit: Number(form.get('deviceLimit')),
              marketplaceScope: newMarketplaceScope,
              note: String(form.get('note') || ''),
            }, { onSuccess: () => toast('Ключ создан', 'success'), onError: fail });
          }}
        >
          <Field label="Срок">
            <Select name="durationDays" defaultValue="30">
              {DURATIONS.map(days => <option key={days} value={days}>{days} дней</option>)}
            </Select>
          </Field>
          <Field label="Устройств">
            <Select name="deviceLimit" defaultValue="1">
              {DEVICES.map(devices => <option key={devices} value={devices}>{devices}</option>)}
            </Select>
          </Field>
          <Field label="Маркетплейс">
            <MarketplaceScopeToggle value={newMarketplaceScope} onChange={setNewMarketplaceScope} />
          </Field>
          <Field label="Пометка"><Input name="note" /></Field>
          <Button type="submit" className={p.tap} loading={licenseMutation.create.isPending}>Создать ключ</Button>
        </form>
        {licenseMutation.create.isError && <Alert tone="error">{licenseMutation.create.error.message}</Alert>}
      </Card>

      <section className="stack">
        <h3>Ключи</h3>
        <DataState
          query={licenses}
          isEmpty={rows => rows.length === 0}
          empty={<EmptyBlock title="Ключей пока нет" text="Создайте ключ выше или дождитесь покупки." />}
        >
          {rows => (
            <ResponsiveTable
              rows={rows}
              columns={licenseColumns}
              rowKey={license => license.id}
              rowActions={license => (
                <>
                  <Button variant="ghost" size="sm" className={p.tap} onClick={() => setExtendFor(license)}>
                    <RefreshCw size={16} />Продлить
                  </Button>
                  <Button variant="ghost" size="sm" className={p.tap} onClick={() => setDevicesFor(license)}>
                    Устройства
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={p.tap}
                    onClick={() => licenseMutation.update.mutate({ id: license.id, active: !license.active } as never, { onError: fail })}
                  >
                    {license.active ? 'Отозвать' : 'Вернуть'}
                  </Button>
                </>
              )}
            />
          )}
        </DataState>
      </section>

      <section className="stack">
        <h3>Активированные устройства</h3>
        <DataState
          query={activations}
          isEmpty={rows => rows.length === 0}
          empty={<EmptyBlock title="Активаций нет" text="Устройства появятся после первого входа по ключу." />}
        >
          {rows => (
            <ResponsiveTable
              rows={rows}
              columns={deviceColumns}
              rowKey={device => device.id}
              rowActions={device => (
                <Button variant="ghost" size="sm" className={p.tap} onClick={() => setReleaseDevice(device)}>
                  Освободить
                </Button>
              )}
            />
          )}
        </DataState>
      </section>

      <Card>
        <h3>Промокоды</h3>
        <form
          className={`${s.toolbar} ${p.formRow}`}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            promoMutation.create.mutate({
              code: String(form.get('code') || '').toUpperCase(),
              discount: Number(form.get('discount') || 0),
              scope: String(form.get('scope') || 'all'),
              limit: Number(form.get('limit') || 1),
              active: true,
            }, { onSuccess: () => toast('Промокод создан', 'success'), onError: fail });
          }}
        >
          <Field label="Код"><Input name="code" required /></Field>
          <Field label="Скидка, %"><Input name="discount" type="number" min={1} max={100} defaultValue={10} /></Field>
          <Field label="Область">
            <Select name="scope" defaultValue="all">
              <option value="all">Всё</option>
              <option value="program">Программа</option>
              <option value="license">Ключ</option>
            </Select>
          </Field>
          <Field label="Лимит"><Input name="limit" type="number" min={1} defaultValue={10} /></Field>
          <Button type="submit" variant="secondary" className={p.tap} loading={promoMutation.create.isPending}>Создать</Button>
        </form>
        <div className="section">
          <DataState
            query={promos}
            isEmpty={rows => rows.length === 0}
            empty={<p className={s.mutedNote}>Промокодов пока нет.</p>}
          >
            {rows => (
              <ResponsiveTable
                rows={rows}
                columns={promoColumns}
                rowKey={promo => promo.id}
                rowActions={promo => (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={p.tap}
                    onClick={() => promoMutation.update.mutate({ id: promo.id, active: !promo.active } as never, { onError: fail })}
                  >
                    {promo.active ? 'Отключить' : 'Включить'}
                  </Button>
                )}
              />
            )}
          </DataState>
        </div>
      </Card>

      <Card>
        <h3>Объявление в программе</h3>
        <form
          className="stack"
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            announcementMutation.create.mutate({
              text: String(form.get('text') || ''),
              url: String(form.get('url') || ''),
              button: 'Подробнее',
              level: String(form.get('level') || 'info'),
              active: true,
            }, { onSuccess: () => toast('Объявление опубликовано', 'success'), onError: fail });
          }}
        >
          <Field label="Текст"><Textarea name="text" rows={3} required /></Field>
          <div className={`${s.toolbar} ${p.formRow}`}>
            <Field label="Ссылка"><Input name="url" /></Field>
            <Field label="Важность">
              <Select name="level" defaultValue="info">
                <option value="info">Обычное</option>
                <option value="warning">Предупреждение</option>
                <option value="important">Важное</option>
              </Select>
            </Field>
            <Button type="submit" variant="secondary" className={p.tap} loading={announcementMutation.create.isPending}>Опубликовать</Button>
          </div>
        </form>
        <div className="section">
          <DataState
            query={announcements}
            isEmpty={rows => rows.length === 0}
            empty={<p className={s.mutedNote}>Объявлений пока нет.</p>}
          >
            {rows => (
              <ResponsiveTable
                rows={rows}
                columns={announcementColumns}
                rowKey={item => item.id}
                rowActions={item => (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={p.tap}
                      onClick={() => announcementMutation.update.mutate({ id: item.id, active: !item.active } as never, { onError: fail })}
                    >
                      {item.active ? 'Скрыть' : 'Показать'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={p.iconButton}
                      aria-label="Удалить объявление"
                      onClick={() => setDeleteAnnouncement(item)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </>
                )}
              />
            )}
          </DataState>
        </div>
      </Card>

      <Card>
        <h3>Обновление программы</h3>
        <form
          // key — чтобы поля подхватили релиз, когда он загрузится
          key={release?.version ?? 'none'}
          className="stack"
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            // Строка релиза одна на всю таблицу, сервер ждёт id=true.
            releaseMutation.update.mutate({
              id: 'true',
              version: String(form.get('version') || ''),
              minimumVersion: String(form.get('minimumVersion') || ''),
              downloadUrl: String(form.get('downloadUrl') || ''),
              notes: String(form.get('notes') || ''),
              mandatory: form.get('mandatory') === 'on',
            } as never, { onSuccess: () => toast('Релиз обновлён', 'success'), onError: fail });
          }}
        >
          <div className={`${s.toolbar} ${p.formRow}`}>
            <Field label="Версия"><Input name="version" defaultValue={release?.version ?? ''} required /></Field>
            <Field label="Минимальная версия"><Input name="minimumVersion" defaultValue={release?.minimumVersion ?? ''} /></Field>
          </div>
          <Field label="Ссылка на установщик"><Input name="downloadUrl" defaultValue={release?.downloadUrl ?? ''} /></Field>
          <Field label="Что нового"><Textarea name="notes" rows={3} defaultValue={release?.notes ?? ''} /></Field>
          <Checkbox name="mandatory" defaultChecked={release?.mandatory}>Обновление обязательное</Checkbox>
          <Button type="submit" variant="secondary" className={p.tap} loading={releaseMutation.update.isPending}>Сохранить релиз</Button>
        </form>
      </Card>

      <NumberDialog
        open={extendFor !== null}
        onOpenChange={open => !open && setExtendFor(null)}
        title={`Продлить ключ ${extendFor?.key ?? ''}`}
        subtitle={extendFor?.expiresAt ? `Сейчас действует до ${shortDate(extendFor.expiresAt)}` : 'Ключ ещё не активирован — дни добавятся к сроку'}
        label="На сколько дней"
        min={1}
        max={3650}
        initial={30}
        presets={[
          { value: 7, label: '7 дней' },
          { value: 30, label: '30 дней' },
          { value: 90, label: '90 дней' },
          { value: 365, label: 'Год' },
        ]}
        preview={days => (
          <span>
            {extendFor?.expiresAt ? 'Новый срок: ' : 'Будет: '}
            <b>{addDays(extendFor?.expiresAt ?? null, days)}</b>
          </span>
        )}
        confirmLabel="Продлить"
        onConfirm={async days => {
          if (!extendFor) return;
          await licenseMutation.update.mutateAsync({ id: extendFor.id, extendDays: days } as never);
          toast('Ключ продлён', 'success');
        }}
      />

      <ConfirmDialog
        open={devicesFor !== null}
        onOpenChange={open => !open && setDevicesFor(null)}
        title={`Устройства ключа ${devicesFor?.key ?? ''}`}
        description={devicesFor ? `Сейчас разрешено: ${devicesFor.deviceLimit}` : undefined}
        confirmLabel="Сохранить"
        onConfirm={async () => {
          if (!devicesFor) return;
          await licenseMutation.update.mutateAsync({ id: devicesFor.id, deviceLimit } as never);
          toast('Лимит устройств сохранён', 'success');
        }}
      >
        <Field label="Сколько устройств разрешить">
          <Select value={String(deviceLimit)} onChange={event => setDeviceLimit(Number(event.target.value))}>
            {DEVICES.map(devices => (
              <option key={devices} value={devices}>
                {devices}
              </option>
            ))}
          </Select>
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={releaseDevice !== null}
        onOpenChange={open => !open && setReleaseDevice(null)}
        title="Освободить устройство?"
        description={
          releaseDevice
            ? `Устройство ••••${releaseDevice.deviceHash.slice(-6)} выйдет из ключа №${releaseDevice.licenseId}, а место освободится для другого ПК.`
            : undefined
        }
        confirmLabel="Освободить"
        tone="danger"
        requireReason
        onConfirm={async ({ reason }) => {
          if (!releaseDevice) return;
          await removeActivation.mutateAsync({ id: releaseDevice.id, reason });
          toast('Устройство освобождено', 'success');
        }}
      />

      <ConfirmDialog
        open={deleteAnnouncement !== null}
        onOpenChange={open => !open && setDeleteAnnouncement(null)}
        title="Удалить объявление?"
        description="Оно пропадёт из программы. Чтобы убрать на время, нажмите «Скрыть»."
        confirmLabel="Удалить"
        tone="danger"
        requireReason
        onConfirm={async ({ reason }) => {
          if (!deleteAnnouncement) return;
          await removeAnnouncement.mutateAsync({ id: deleteAnnouncement.id, reason });
          toast('Объявление удалено', 'success');
        }}
      />
    </div>
  );
}
