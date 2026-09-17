import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, Eye, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { UseMutationResult } from '@tanstack/react-query';
import { type AdminUserDetail, useAdminUser, useAdminUserAction } from '../../api/admin';
import { dateTime, money } from '../../api/cabinet';
import { orderStatusLabel, payerLabel, productLabel, shortDate } from '../../lib/admin-users';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Progress,
  Select,
  Skeleton,
  Stat,
  Table,
  Textarea,
  useToast,
} from '../../ui';
import s from '../../layout/AdminShell.module.css';

const CELL_DURATIONS = [3, 7, 30, 90, 180, 365];
const CELL_DEVICES = [1, 2, 3, 5, 10, 20];

export function AdminUserPage() {
  const { userId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const query = useAdminUser(userId);

  const [grantOpen, setGrantOpen] = useState(false);
  const [individualOpen, setIndividualOpen] = useState(false);
  const [cellOpen, setCellOpen] = useState(false);
  const [programOpen, setProgramOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirm, setConfirm] = useState('');

  const grantSticker = useAdminUserAction<{ userId: string; name: string; limit: number }>(
    'grantSticker',
  );
  const createIndividual = useAdminUserAction<{userId:string;title:string;codes:string;totalAmount:number;creditUnits:number}>('createIndividualStickerOrder');
  const topup = useAdminUserAction<{ userId: string; codeId: number; add: number }>('topupSticker');
  const patchCode = useAdminUserAction<{
    userId: string;
    codeId: number;
    limit?: number;
    active?: boolean;
  }>('code', 'PATCH');
  const grantProgram = useAdminUserAction<{
    userId: string;
    key: string;
    limit: number;
    note: string;
  }>('grantProgramKey');
  const grantCell = useAdminUserAction<{
    userId: string;
    durationDays: number;
    deviceLimit: number;
    marketplaceScope: 'wb' | 'ozon' | 'both';
    note: string;
  }>('grantCellLicense');
  const patchCell = useAdminUserAction<{
    userId: string;
    id: number;
    extendDays?: number;
    deviceLimit?: number;
    marketplaceScope?: 'wb' | 'ozon' | 'both';
    active?: boolean;
  }>('cellLicense', 'PATCH');
  const notify = useAdminUserAction<{ userId: string; title: string; body: string }>('notify');
  const profile = useAdminUserAction<{
    userId: string;
    displayName?: string;
    phone?: string;
    payerStatus?: string;
  }>('profile');
  const block = useAdminUserAction<{ userId: string }>('block');
  const unblock = useAdminUserAction<{ userId: string }>('unblock');
  const remove = useAdminUserAction<{ userId: string; confirm: string }>('account', 'DELETE');

  /** Одинаковый хвост у всех действий: тост об успехе, тост об ошибке, закрытие модалки. */
  const run = <TBody,>(
    mutation: UseMutationResult<unknown, Error, TBody, unknown>,
    body: TBody,
    message: string,
    done?: () => void,
  ) =>
    mutation.mutate(body, {
      onSuccess: () => {
        toast(message, 'success');
        done?.();
      },
      onError: error => toast(error.message, 'error'),
    });

  if (query.isPending)
    return (
      <div className="page">
        <Skeleton height={320} />
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <Alert tone="error">{query.error.message}</Alert>
      </div>
    );

  const user: AdminUserDetail = query.data;

  return (
    <div className="page stack-lg">
      <div className={s.row}>
        <Link to="/panel/users">
          <Button variant="ghost" size="sm">
            <ArrowLeft size={16} />К списку
          </Button>
        </Link>
      </div>

      <Card accent>
        <div className={s.spread}>
          <div>
            <h2 style={{ margin: 0 }}>
              {user.email ?? user.telegram?.username ?? user.userId.slice(0, 8)}
            </h2>
            <div className={s.row}>
              {user.telegramOnly && <Badge>Только Telegram</Badge>}
              {user.emailConfirmed && <Badge tone="success">Почта подтверждена</Badge>}
              {user.banned && <Badge tone="error">Заблокирован</Badge>}
              <span className="mono">{user.userId}</span>
            </div>
          </div>
          <div className={s.row}>
            <Link to={`/panel/users/${userId}/preview`} target="_blank" rel="noreferrer">
              <Button variant="secondary">
                <Eye size={16} />
                Предпросмотр кабинета
              </Button>
            </Link>
            {user.banned ? (
              <Button
                variant="secondary"
                loading={unblock.isPending}
                onClick={() => run(unblock, { userId }, 'Пользователь разблокирован')}
              >
                Разблокировать
              </Button>
            ) : (
              <Button
                variant="secondary"
                loading={block.isPending}
                onClick={() => run(block, { userId }, 'Пользователь заблокирован')}
              >
                <Ban size={16} />
                Заблокировать
              </Button>
            )}
          </div>
        </div>

        <div className={`${s.tiles} section`}>
          <Stat value={shortDate(user.createdAt)} label="регистрация" />
          <Stat value={shortDate(user.lastSignInAt)} label="последний вход" />
          <Stat
            value={user.orders.filter(order => order.status === 'succeeded').length}
            label="оплаченных заказов"
          />
          <Stat value={money(user.referral.availableKopecks)} label="реферальный баланс" />
        </div>
      </Card>

      <Card>
        <h3>Профиль</h3>
        <form
          className={s.toolbar}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              profile,
              {
                userId,
                displayName: String(form.get('displayName') || ''),
                phone: String(form.get('phone') || ''),
                payerStatus: String(form.get('payerStatus') || 'individual'),
              },
              'Профиль обновлён',
            );
          }}
        >
          <Field label="Имя">
            <Input name="displayName" defaultValue={user.profile?.display_name ?? ''} />
          </Field>
          <Field label="Телефон">
            <Input name="phone" defaultValue={user.profile?.phone ?? ''} />
          </Field>
          <Field label="Статус плательщика">
            <Select name="payerStatus" defaultValue={user.profile?.payer_status ?? 'individual'}>
              <option value="individual">{payerLabel('individual')}</option>
              <option value="self_employed">{payerLabel('self_employed')}</option>
              <option value="entrepreneur">{payerLabel('entrepreneur')}</option>
            </Select>
          </Field>
          <Button type="submit" variant="secondary" loading={profile.isPending}>
            Сохранить
          </Button>
        </form>
      </Card>

      <Card>
        <div className={s.spread}>
          <h3>Индивидуальные заказы стикеров</h3>
          <Button size="sm" onClick={() => setIndividualOpen(true)}><Plus size={16}/>Создать заказ</Button>
        </div>
        {user.customOrders?.length ? <Table><thead><tr><th>Заказ</th><th>Стикеры</th><th>Зачтено</th><th>К оплате</th><th>Статус</th></tr></thead><tbody>{user.customOrders.map(order=><tr key={order.id}><td>{order.title}</td><td>{order.quantity}</td><td>{order.credited_units} шт.</td><td>{money(Math.round(Number(order.amount_due)*100))}</td><td><Badge tone={order.status==='paid'?'success':'warning'}>{order.status==='paid'?'Оплачен':'Ожидает оплаты'}</Badge></td></tr>)}</tbody></Table>:<p className={s.mutedNote}>Индивидуальных заказов нет.</p>}
      </Card>

      <Card>
        <div className={s.spread}>
          <h3>Коды доступа к генератору</h3>
          <Button size="sm" onClick={() => setGrantOpen(true)}>
            <Plus size={16} />
            Выдать код
          </Button>
        </div>
        {user.codes.length ? (
          <Table>
            <thead>
              <tr>
                <th>Код</th>
                <th>Имя</th>
                <th>Генерации</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {user.codes.map(code => (
                <tr key={code.id}>
                  <td className="mono">{code.code}</td>
                  <td>{code.name || '—'}</td>
                  <td className={s.actionsCell}>
                    <Progress
                      value={code.used}
                      max={Math.max(1, code.limit)}
                      label={
                        <span>
                          {code.used} из {code.limit}
                        </span>
                      }
                    />
                  </td>
                  <td>
                    <Badge tone={code.active ? 'success' : 'error'}>
                      {code.active ? 'Активен' : 'Отключён'}
                    </Badge>
                  </td>
                  <td>
                    <div className={s.row}>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={topup.isPending}
                        onClick={() => {
                          const add = Number(window.prompt('Сколько генераций добавить?', '100'));
                          if (Number.isInteger(add) && add > 0)
                            run(topup, { userId, codeId: code.id, add }, 'Генерации добавлены');
                        }}
                      >
                        <Plus size={16} />
                        Генерации
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          run(
                            patchCode,
                            { userId, codeId: code.id, active: !code.active },
                            code.active ? 'Код отключён' : 'Код включён',
                          )
                        }
                      >
                        {code.active ? 'Отключить' : 'Включить'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            title="Кодов нет"
            text="Выдайте код доступа — он сразу появится у человека в кабинете."
          />
        )}
      </Card>

      <Card>
        <div className={s.spread}>
          <h3>Ключи «Подбора кодов»</h3>
          <Button size="sm" variant="secondary" onClick={() => setProgramOpen(true)}>
            <KeyRound size={16} />
            Выдать ключ
          </Button>
        </div>
        {user.programKeys.length ? (
          <Table>
            <thead>
              <tr>
                <th>Ключ</th>
                <th>Итерации</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {user.programKeys.map(key => (
                <tr key={key.id}>
                  <td className="mono">{key.key}</td>
                  <td>
                    {key.used} из {key.limit}
                  </td>
                  <td>
                    <Badge tone={key.active ? 'success' : 'error'}>
                      {key.active ? 'Активен' : 'Отозван'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className={s.mutedNote}>Ключей нет.</p>
        )}
      </Card>

      <Card>
        <div className={s.spread}>
          <h3>Печать ячеек</h3>
          <Button size="sm" variant="secondary" onClick={() => setCellOpen(true)}>
            <Plus size={16} />
            Выдать ключ
          </Button>
        </div>
        {user.cellLicenses.length ? (
          <Table>
            <thead>
              <tr>
                <th>Ключ</th>
                <th>Права</th><th>Срок</th>
                <th>Устройства</th>
                <th>Действует до</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {user.cellLicenses.map(license => (
                <tr key={license.id}>
                  <td className="mono">{license.key}</td>
                  <td>{{ wb: 'Wildberries', ozon: 'Ozon', both: 'WB + Ozon', legacy_unassigned: 'Не назначен (WB)' }[license.marketplaceScope]}</td>
                  <td>{license.durationDays} дн.</td>
                  <td>
                    {license.devices?.length ?? 0} из {license.deviceLimit}
                  </td>
                  <td>{license.expiresAt ? shortDate(license.expiresAt) : 'не активирован'}</td>
                  <td>
                    <div className={s.row}>
                      <Button variant="ghost" size="sm" onClick={() => {
                        const scope = window.prompt('Права ключа: wb, ozon или both', license.marketplaceScope === 'legacy_unassigned' ? 'wb' : license.marketplaceScope)?.trim().toLowerCase();
                        if (scope === 'wb' || scope === 'ozon' || scope === 'both') run(patchCell, { userId, id: license.id, marketplaceScope: scope }, 'Права изменены');
                      }}>Права</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={patchCell.isPending}
                        onClick={() => {
                          const days = Number(window.prompt('На сколько дней продлить?', '30'));
                          if (Number.isInteger(days) && days > 0)
                            run(
                              patchCell,
                              { userId, id: license.id, extendDays: days },
                              'Ключ продлён',
                            );
                        }}
                      >
                        <RefreshCw size={16} />
                        Продлить
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          run(
                            patchCell,
                            { userId, id: license.id, active: !license.active },
                            license.active ? 'Ключ отозван' : 'Ключ возвращён',
                          )
                        }
                      >
                        {license.active ? 'Отозвать' : 'Вернуть'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className={s.mutedNote}>Лицензий нет.</p>
        )}
      </Card>

      <Card>
        <h3>Заказы</h3>
        {user.orders.length ? (
          <Table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Покупка</th>
                <th>Сумма</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {user.orders.map(order => (
                <tr key={order.id}>
                  <td>{dateTime(order.created_at)}</td>
                  <td>{productLabel(order.product_kind)}</td>
                  <td>{money(Math.round(Number(order.amount) * 100))}</td>
                  <td>{orderStatusLabel(order.status)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className={s.mutedNote}>Покупок не было.</p>
        )}
      </Card>

      <Card>
        <div className={s.spread}>
          <h3>Рефералы и уведомления</h3>
          <Button size="sm" variant="secondary" onClick={() => setNotifyOpen(true)}>
            Написать пользователю
          </Button>
        </div>
        <div className={s.tiles}>
          <Stat value={user.referral.code ?? '—'} label="реферальный код" />
          <Stat value={user.referral.invited} label="приглашено" />
          <Stat value={money(user.referral.earnedKopecks)} label="начислено всего" />
          <Stat value={money(user.referral.paidKopecks)} label="выплачено" />
        </div>
        {(user.referral.referrals || []).length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>Реферал</th>
                <th>Приглашён</th>
                <th>Покупки</th>
                <th>Оплачено</th>
                <th>Возвраты</th>
                <th>Начислено</th>
                <th>Списано</th>
                <th>Итого заработано</th>
              </tr>
            </thead>
            <tbody>
              {(user.referral.referrals || []).map(referral => (
                <tr key={referral.userId}>
                  <td>
                    <div>{referral.displayName || referral.email || 'Без имени'}</div>
                    {referral.displayName && referral.email && (
                      <div className={s.mutedNote}>{referral.email}</div>
                    )}
                    {referral.phone && <div className={s.mutedNote}>{referral.phone}</div>}
                    <div className="mono">{referral.userId}</div>
                  </td>
                  <td>{dateTime(referral.attributedAt)}</td>
                  <td>
                    {referral.orders.length
                      ? referral.orders.map(order => (
                          <div key={order.id} className={s.mutedNote}>
                            {dateTime(order.createdAt)} · {productLabel(order.productKind)} ·{' '}
                            {money(order.amountKopecks)} · {orderStatusLabel(order.status)}
                          </div>
                        ))
                      : 'нет'}
                  </td>
                  <td>{money(referral.paidKopecks)}</td>
                  <td>{money(referral.refundedKopecks)}</td>
                  <td>{money(referral.rewardedKopecks)}</td>
                  <td>{money(referral.reversedKopecks)}</td>
                  <td>{money(referral.earnedKopecks)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {user.notifications.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>Уведомление</th>
                <th>Дата</th>
                <th>Прочитано</th>
              </tr>
            </thead>
            <tbody>
              {user.notifications.slice(0, 8).map(item => (
                <tr key={item.id}>
                  <td>{item.title}</td>
                  <td>{dateTime(item.created_at)}</td>
                  <td>{item.read_at ? 'да' : 'нет'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {user.actions.length > 0 && (
        <Card>
          <h3>Журнал действий администратора</h3>
          <Table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Действие</th>
                <th>Детали</th>
              </tr>
            </thead>
            <tbody>
              {user.actions.map(action => (
                <tr key={action.id}>
                  <td>{dateTime(action.created_at)}</td>
                  <td>{action.action}</td>
                  <td className="mono">{JSON.stringify(action.payload)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <div className={s.danger}>
        <h3>Опасная зона</h3>
        <p className={s.mutedNote}>
          Блокировка обратима: аккаунт остаётся, но вход закрыт и все коды с ключами отключаются.
          Удаление необратимо — профиль, настройки и импортированная история исчезнут, а заказы и
          выданные коды останутся в базе без владельца.
        </p>
        <Button variant="secondary" onClick={() => setDeleteOpen(true)}>
          <Trash2 size={16} />
          Удалить аккаунт
        </Button>
      </div>

      <Modal
        open={grantOpen}
        onOpenChange={setGrantOpen}
        title="Выдать код доступа"
        description="Код сгенерирует сервер и сразу привяжет его к этому пользователю."
      >
        <form
          className="stack"
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              grantSticker,
              {
                userId,
                name: String(form.get('name') || ''),
                limit: Number(form.get('limit') || 0),
              },
              'Код выдан',
              () => setGrantOpen(false),
            );
          }}
        >
          <Field label="Имя пакета">
            <Input name="name" defaultValue="Выдан администратором" required />
          </Field>
          <Field label="Сколько генераций">
            <Input name="limit" type="number" min={1} max={100000} defaultValue={100} required />
          </Field>
          <Button type="submit" loading={grantSticker.isPending}>
            Выдать
          </Button>
        </form>
      </Modal>

      <Modal open={individualOpen} onOpenChange={setIndividualOpen} title="Создать индивидуальный заказ" description="Номера будут закрыты до оплаты. Остаток генераций резервируется сразу.">
        <form className="stack" onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);run(createIndividual,{userId,title:String(form.get('title')||''),codes:String(form.get('codes')||''),totalAmount:Number(form.get('totalAmount')||0),creditUnits:Number(form.get('creditUnits')||0)},'Индивидуальный заказ выставлен',()=>setIndividualOpen(false));}}>
          <Field label="Название"><Input name="title" defaultValue="Индивидуальный заказ стикеров" required/></Field>
          <Field label="Номера" help="По одному в строке. Повторы будут удалены."><Textarea name="codes" rows={10} required/></Field>
          <Field label="Полная стоимость, ₽"><Input name="totalAmount" type="number" min="0" step="0.01" required/></Field>
          <Field label="Зачесть генераций из текущего пакета"><Input name="creditUnits" type="number" min="0" defaultValue="0" required/></Field>
          <Button type="submit" loading={createIndividual.isPending}>Выставить заказ</Button>
        </form>
      </Modal>

      <Modal open={programOpen} onOpenChange={setProgramOpen} title="Выдать ключ «Подбора кодов»">
        <form
          className="stack"
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              grantProgram,
              {
                userId,
                key: String(form.get('key') || ''),
                limit: Number(form.get('limit') || 0),
                note: String(form.get('note') || ''),
              },
              'Ключ выдан',
              () => setProgramOpen(false),
            );
          }}
        >
          <Field label="Ключ" help="6–64 латинские буквы, цифры или дефис">
            <Input name="key" defaultValue="WBPK-" required />
          </Field>
          <Field label="Лимит итераций">
            <Input name="limit" type="number" min={1} defaultValue={1000} required />
          </Field>
          <Field label="Пометка">
            <Input name="note" />
          </Field>
          <Button type="submit" loading={grantProgram.isPending}>
            Выдать
          </Button>
        </form>
      </Modal>

      <Modal open={cellOpen} onOpenChange={setCellOpen} title="Выдать ключ «Печати ячеек»">
        <form
          className="stack"
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              grantCell,
              {
                userId,
                durationDays: Number(form.get('durationDays')),
                deviceLimit: Number(form.get('deviceLimit')),
                marketplaceScope: String(form.get('marketplaceScope') || 'wb') as 'wb' | 'ozon' | 'both',
                note: String(form.get('note') || ''),
              },
              'Ключ выдан',
              () => setCellOpen(false),
            );
          }}
        >
          <Field label="Срок">
            <Select name="durationDays" defaultValue="30">
              {CELL_DURATIONS.map(days => (
                <option key={days} value={days}>
                  {days} дней
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Устройств">
            <Select name="deviceLimit" defaultValue="1">
              {CELL_DEVICES.map(devices => (
                <option key={devices} value={devices}>
                  {devices}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Маркетплейс">
            <Select name="marketplaceScope" defaultValue="wb"><option value="wb">Wildberries</option><option value="ozon">Ozon</option><option value="both">Wildberries + Ozon</option></Select>
          </Field>
          <Field label="Пометка">
            <Input name="note" />
          </Field>
          <Button type="submit" loading={grantCell.isPending}>
            Выдать
          </Button>
        </form>
      </Modal>

      <Modal
        open={notifyOpen}
        onOpenChange={setNotifyOpen}
        title="Сообщение пользователю"
        description="Появится в кабинете и, если есть почта, уйдёт письмом."
      >
        <form
          className="stack"
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              notify,
              {
                userId,
                title: String(form.get('title') || ''),
                body: String(form.get('body') || ''),
              },
              'Отправлено',
              () => setNotifyOpen(false),
            );
          }}
        >
          <Field label="Заголовок">
            <Input name="title" maxLength={160} required />
          </Field>
          <Field label="Текст">
            <Textarea name="body" rows={4} maxLength={2000} required />
          </Field>
          <Button type="submit" loading={notify.isPending}>
            Отправить
          </Button>
        </form>
      </Modal>

      <Modal
        open={deleteOpen}
        onOpenChange={value => {
          setDeleteOpen(value);
          setConfirm('');
        }}
        title="Удалить аккаунт"
        description="Действие необратимо."
      >
        <div className="stack">
          <Alert tone="warning">
            Каскадом удалятся профиль, настройки и импортированная история генераций. Заказы и
            выданные коды останутся в базе, но потеряют владельца.
          </Alert>
          <Field label="Введите почту пользователя для подтверждения" help={user.confirmValue}>
            <Input value={confirm} onChange={event => setConfirm(event.target.value)} />
          </Field>
          <Button
            variant="secondary"
            disabled={confirm.trim() !== user.confirmValue}
            loading={remove.isPending}
            onClick={() =>
              run(remove, { userId, confirm: confirm.trim() }, 'Аккаунт удалён', () =>
                navigate('/panel/users'),
              )
            }
          >
            <Trash2 size={16} />
            Удалить навсегда
          </Button>
        </div>
      </Modal>
    </div>
  );
}
