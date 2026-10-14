import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  type AdminUserRow, useAdminPartnerAction, useAdminPartnerSettings, useAdminPartners, useAdminUsers,
} from '../../api/admin';
import { userLabel } from '../../lib/admin-users';
import { formatRub, poolLeft, type Partner } from '../../lib/partner';
import {
  Alert, Badge, Button, Card, EmptyState, Field, Input, Skeleton, Table, useToast,
} from '../../ui';
import s from '../../layout/AdminShell.module.css';

/**
 * Партнёры: аккаунты сайта, которые сами выпускают коды и ключи из выданного
 * пула и рассчитываются с владельцем в рублях по своей оптовой цене.
 */
export function AdminPartnersPage() {
  const partners = useAdminPartners();
  const navigate = useNavigate();

  return (
    <div className="page stack-lg">
      <RateCard />
      <CreatePartnerCard onCreated={id => navigate(`/panel/partners/${id}`)} />

      {partners.isPending ? (
        <Skeleton height={200} />
      ) : partners.isError ? (
        <Alert tone="error">{partners.error.message}</Alert>
      ) : partners.data.length ? (
        <Table>
          <thead>
            <tr>
              <th>Партнёр</th><th>Аккаунт</th><th>Остаток генераций</th><th>Итераций</th>
              <th>Дней·ПК</th><th>Долг</th><th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {partners.data.map(partner => (
              <tr key={partner.id} className={s.clickable} onClick={() => navigate(`/panel/partners/${partner.id}`)}>
                <td><Link to={`/panel/partners/${partner.id}`}>{partner.name}</Link></td>
                <td>{partner.account || '—'}</td>
                <td>{poolLeft(partner.pool.sticker)} из {partner.pool.sticker.granted}</td>
                <td>{poolLeft(partner.pool.program)} из {partner.pool.program.granted}</td>
                <td>{poolLeft(partner.pool.cell)} из {partner.pool.cell.granted}</td>
                <td><strong>{formatRub(partner.balance.dueRub)}</strong></td>
                <td><Badge tone={partner.active ? 'success' : 'error'}>{partner.active ? 'Активен' : 'Отключён'}</Badge></td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <Card><EmptyState title="Партнёров пока нет" text="Назначьте партнёром зарегистрированный аккаунт выше." /></Card>
      )}
    </div>
  );
}

function RateCard() {
  const toast = useToast();
  const settings = useAdminPartnerSettings();
  const save = useAdminPartnerAction<{ kztPerRub: number }>('settings');
  const [rate, setRate] = useState('');
  useEffect(() => {
    if (settings.data) setRate(String(settings.data.kztPerRub));
  }, [settings.data]);

  return (
    <Card>
      <h3>Курс тенге</h3>
      <p className={s.mutedNote}>
        Сколько тенге за 1 рубль. По нему партнёр видит цену в ₸, а посетители сайта — цены при выборе ₸.
        Долг партнёра за уже выпущенное не пересчитывается: курс фиксируется в момент выпуска.
      </p>
      <form
        className={s.toolbar}
        onSubmit={event => {
          event.preventDefault();
          save.mutate({ kztPerRub: Number(rate.replace(',', '.')) }, {
            onSuccess: () => toast('Курс сохранён', 'success'),
            onError: (error: Error) => toast(error.message, 'error'),
          });
        }}
      >
        <Field label="₸ за 1 ₽">
          <Input value={rate} onChange={e => setRate(e.target.value)} inputMode="decimal" required />
        </Field>
        <Button type="submit" loading={save.isPending}>Сохранить</Button>
      </form>
    </Card>
  );
}

function CreatePartnerCard({ onCreated }: { onCreated: (id: string) => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<AdminUserRow | null>(null);
  const [name, setName] = useState('');
  const users = useAdminUsers({ q: q.trim(), page: 0, pageSize: 5, sort: 'created_at', filter: 'all' });
  const create = useAdminPartnerAction<{ userId: string; name: string }, Partner>('create');

  return (
    <Card>
      <h3>Новый партнёр</h3>
      <p className={s.mutedNote}>
        Партнёр сначала регистрируется на сайте сам (почта или Telegram). Найдите его аккаунт и назначьте
        партнёром — в его личном кабинете появится раздел «Партнёр».
      </p>
      {picked ? (
        <div className="stack">
          <div className={s.row}>
            <Badge tone="accent">{userLabel(picked)}</Badge>
            <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>Другой аккаунт</Button>
          </div>
          <form
            className={s.toolbar}
            onSubmit={event => {
              event.preventDefault();
              create.mutate({ userId: picked.userId, name }, {
                onSuccess: partner => { toast('Партнёр создан', 'success'); onCreated(partner.id); },
                onError: (error: Error) => toast(error.message, 'error'),
              });
            }}
          >
            <Field label="Название (видно только вам)">
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Например, Алматы — Айдар" required maxLength={120} />
            </Field>
            <Button type="submit" loading={create.isPending}>Сделать партнёром</Button>
          </form>
        </div>
      ) : (
        <div className="stack">
          <Field label="Поиск аккаунта: почта, телефон, @telegram">
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="partner@mail.kz" />
          </Field>
          {q.trim().length >= 2 && (
            users.isPending ? <Skeleton height={60} /> : users.isError ? (
              <p className={s.mutedNote}>Не удалось выполнить поиск: {users.error.message}</p>
            ) : users.data?.items.length ? (
              <div className="stack">
                {users.data.items.map(user => (
                  <div key={user.userId} className={s.spread}>
                    <span>{userLabel(user)}</span>
                    <Button size="sm" variant="secondary" onClick={() => { setPicked(user); setName(user.displayName || ''); }}>
                      Выбрать
                    </Button>
                  </div>
                ))}
              </div>
            ) : <p className={s.mutedNote}>Ничего не найдено</p>
          )}
        </div>
      )}
    </Card>
  );
}
