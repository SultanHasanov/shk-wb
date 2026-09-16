import { RefreshCw, Trash2 } from 'lucide-react';
import {
  type AdminCellDevice, type AdminCellLicense, useAdminResource, useAdminResourceMutation,
} from '../../api/admin';
import { shortDate } from '../../lib/admin-users';
import {
  Alert, Badge, Button, Card, Checkbox, Field, Input, Select, Skeleton, Table, Textarea, useToast,
} from '../../ui';
import s from '../../layout/AdminShell.module.css';

const DURATIONS = [3, 7, 30, 90, 180, 365];
const DEVICES = [1, 2, 3, 5, 10, 20];

type Promo = { id: number; code: string; discount: number; scope: string; limit: number; used: number; active: boolean };
type Announcement = { id: number; text: string; url: string | null; level: string; active: boolean };
type Release = { id: string; version: string; minimumVersion: string; downloadUrl: string; notes: string; mandatory: boolean };

/** Все пять подразделов старой вкладки «Печать ячеек» на одной странице. */
export function AdminCellPrintPage() {
  const toast = useToast();
  const licenses = useAdminResource<AdminCellLicense>('cellLicense');
  const licenseMutation = useAdminResourceMutation<{ durationDays: number; deviceLimit: number; note: string }>('cellLicense');
  const activations = useAdminResource<AdminCellDevice>('cellActivation');
  const activationMutation = useAdminResourceMutation<never>('cellActivation');
  const promos = useAdminResource<Promo>('cellPromo');
  const promoMutation = useAdminResourceMutation<{ code: string; discount: number; scope: string; limit: number; active: boolean }>('cellPromo');
  const announcements = useAdminResource<Announcement>('cellAnnouncement');
  const announcementMutation = useAdminResourceMutation<{ text: string; url: string; button: string; level: string; active: boolean }>('cellAnnouncement');
  const releases = useAdminResource<Release>('cellRelease');
  const releaseMutation = useAdminResourceMutation<{ version: string; minimumVersion: string; downloadUrl: string; notes: string; mandatory: boolean }>('cellRelease');
  const release = releases.data?.[0];

  const fail = (error: Error) => toast(error.message, 'error');

  return (
    <div className="page stack-lg">
      <Card>
        <h3>Выдать ключ вручную</h3>
        <form
          className={s.toolbar}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            licenseMutation.create.mutate({
              durationDays: Number(form.get('durationDays')),
              deviceLimit: Number(form.get('deviceLimit')),
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
          <Field label="Пометка"><Input name="note" /></Field>
          <Button type="submit" loading={licenseMutation.create.isPending}>Создать ключ</Button>
        </form>
        {licenseMutation.create.isError && <Alert tone="error">{licenseMutation.create.error.message}</Alert>}
      </Card>

      <section className="stack">
        <h3>Ключи</h3>
        {licenses.isPending ? <Skeleton height={160} /> : licenses.data?.length ? (
          <Table>
            <thead><tr><th>Ключ</th><th>Срок</th><th>Устройства</th><th>Действует до</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {licenses.data.map(license => (
                <tr key={license.id}>
                  <td className="mono">{license.key}</td>
                  <td>{license.durationDays} дн.</td>
                  <td>{license.deviceLimit}</td>
                  <td>{license.expiresAt ? shortDate(license.expiresAt) : 'не активирован'}</td>
                  <td><Badge tone={license.active ? 'success' : 'error'}>{license.active ? 'Активен' : 'Отозван'}</Badge></td>
                  <td>
                    <div className={s.row}>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => {
                          const days = Number(window.prompt('На сколько дней продлить?', '30'));
                          if (Number.isInteger(days) && days > 0) {
                            licenseMutation.update.mutate({ id: license.id, extendDays: days } as never, { onError: fail });
                          }
                        }}
                      >
                        <RefreshCw size={16} />Продлить
                      </Button>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => {
                          const limit = Number(window.prompt('Сколько устройств разрешить? (1, 2, 3, 5, 10, 20)', String(license.deviceLimit)));
                          if (DEVICES.includes(limit)) {
                            licenseMutation.update.mutate({ id: license.id, deviceLimit: limit } as never, { onError: fail });
                          }
                        }}
                      >
                        Устройства
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => licenseMutation.update.mutate({ id: license.id, active: !license.active } as never, { onError: fail })}>
                        {license.active ? 'Отозвать' : 'Вернуть'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <Card>Ключей пока нет.</Card>}
      </section>

      <section className="stack">
        <h3>Активированные устройства</h3>
        {activations.data?.length ? (
          <Table>
            <thead><tr><th>Ключ №</th><th>Устройство</th><th>Первый вход</th><th>Последний</th><th /></tr></thead>
            <tbody>
              {activations.data.map(device => (
                <tr key={device.id}>
                  <td>{device.licenseId}</td>
                  <td className="mono">••••{device.deviceHash.slice(-6)}</td>
                  <td>{shortDate(device.firstSeenAt)}</td>
                  <td>{shortDate(device.lastSeenAt)}</td>
                  <td>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => { if (window.confirm('Освободить устройство?')) activationMutation.remove.mutate(device.id); }}
                    >
                      Освободить
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <Card>Активаций нет.</Card>}
      </section>

      <Card>
        <h3>Промокоды</h3>
        <form
          className={s.toolbar}
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
          <Button type="submit" variant="secondary" loading={promoMutation.create.isPending}>Создать</Button>
        </form>
        {promos.data?.length ? (
          <Table>
            <thead><tr><th>Код</th><th>Скидка</th><th>Область</th><th>Использовано</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {promos.data.map(promo => (
                <tr key={promo.id}>
                  <td className="mono">{promo.code}</td>
                  <td>{promo.discount}%</td>
                  <td>{promo.scope}</td>
                  <td>{promo.used} из {promo.limit}</td>
                  <td><Badge tone={promo.active ? 'success' : 'error'}>{promo.active ? 'Активен' : 'Отключён'}</Badge></td>
                  <td>
                    <Button variant="ghost" size="sm" onClick={() => promoMutation.update.mutate({ id: promo.id, active: !promo.active } as never, { onError: fail })}>
                      {promo.active ? 'Отключить' : 'Включить'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
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
          <div className={s.toolbar}>
            <Field label="Ссылка"><Input name="url" /></Field>
            <Field label="Важность">
              <Select name="level" defaultValue="info">
                <option value="info">Обычное</option>
                <option value="warning">Предупреждение</option>
                <option value="important">Важное</option>
              </Select>
            </Field>
            <Button type="submit" variant="secondary" loading={announcementMutation.create.isPending}>Опубликовать</Button>
          </div>
        </form>
        {announcements.data?.length ? (
          <Table>
            <thead><tr><th>Текст</th><th>Важность</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {announcements.data.map(item => (
                <tr key={item.id}>
                  <td>{item.text}</td>
                  <td>{item.level}</td>
                  <td><Badge tone={item.active ? 'success' : 'error'}>{item.active ? 'Показывается' : 'Скрыто'}</Badge></td>
                  <td>
                    <div className={s.row}>
                      <Button variant="ghost" size="sm" onClick={() => announcementMutation.update.mutate({ id: item.id, active: !item.active } as never, { onError: fail })}>
                        {item.active ? 'Скрыть' : 'Показать'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { if (window.confirm('Удалить объявление?')) announcementMutation.remove.mutate(item.id); }}>
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>

      <Card>
        <h3>Обновление программы</h3>
        <form
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
          <div className={s.toolbar}>
            <Field label="Версия"><Input name="version" defaultValue={release?.version ?? ''} required /></Field>
            <Field label="Минимальная версия"><Input name="minimumVersion" defaultValue={release?.minimumVersion ?? ''} /></Field>
          </div>
          <Field label="Ссылка на установщик"><Input name="downloadUrl" defaultValue={release?.downloadUrl ?? ''} /></Field>
          <Field label="Что нового"><Textarea name="notes" rows={3} defaultValue={release?.notes ?? ''} /></Field>
          <Checkbox name="mandatory" defaultChecked={release?.mandatory}>Обновление обязательное</Checkbox>
          <Button type="submit" variant="secondary" loading={releaseMutation.update.isPending}>Сохранить релиз</Button>
        </form>
      </Card>
    </div>
  );
}
