import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  type AdminPartnerRow, type AdminUserRow, useAdminPartnerAction, useAdminPartnerSettings, useAdminPartners, useAdminUsers,
} from '../../api/admin';
import { userLabel } from '../../lib/admin-users';
import { formatRub, poolLeft, type Partner } from '../../lib/partner';
import {
  Badge, Button, Card, Field, Input, Skeleton, useToast,
} from '../../ui';
import { DataState, EmptyBlock, ResponsiveTable } from './kit';
import type { ResponsiveColumn } from './kit';
import s from '../../layout/AdminShell.module.css';
import p from './admin-pages.module.css';

const partnerColumns: ResponsiveColumn<AdminPartnerRow>[] = [
  { key: 'name', header: 'Партнёр', primary: true, cell: partner => partner.name },
  { key: 'account', header: 'Аккаунт', cell: partner => partner.account || '—' },
  {
    key: 'sticker',
    header: 'Остаток генераций',
    label: 'Генерации',
    cell: partner => `${poolLeft(partner.pool.sticker)} из ${partner.pool.sticker.granted}`,
  },
  { key: 'program', header: 'Итераций', cell: partner => `${poolLeft(partner.pool.program)} из ${partner.pool.program.granted}` },
  { key: 'cell', header: 'Дней·ПК', cell: partner => `${poolLeft(partner.pool.cell)} из ${partner.pool.cell.granted}` },
  { key: 'due', header: 'Долг', align: 'end', cell: partner => <strong className={p.num}>{formatRub(partner.balance.dueRub)}</strong> },
  {
    key: 'status',
    header: 'Статус',
    cell: partner => <Badge tone={partner.active ? 'success' : 'error'}>{partner.active ? 'Активен' : 'Отключён'}</Badge>,
  },
];

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

      <DataState
        query={partners}
        isEmpty={rows => rows.length === 0}
        empty={<EmptyBlock title="Партнёров пока нет" text="Назначьте партнёром зарегистрированный аккаунт выше." />}
      >
        {rows => (
          <ResponsiveTable
            rows={rows}
            columns={partnerColumns}
            rowKey={partner => partner.id}
            rowHref={partner => `/panel/partners/${partner.id}`}
          />
        )}
      </DataState>
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
        className={`${s.toolbar} ${p.formRow}`}
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
        <Button type="submit" className={p.tap} loading={save.isPending}>Сохранить</Button>
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
            <Button variant="ghost" size="sm" className={p.tap} onClick={() => setPicked(null)}>Другой аккаунт</Button>
          </div>
          <form
            className={`${s.toolbar} ${p.formRow}`}
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
            <Button type="submit" className={p.tap} loading={create.isPending}>Сделать партнёром</Button>
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
                    <Button size="sm" variant="secondary" className={p.tap} onClick={() => { setPicked(user); setName(user.displayName || ''); }}>
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
