import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { type AdminUsersQuery, useAdminUsers } from '../../api/admin';
import { money } from '../../api/cabinet';
import { shortDate, userLabel } from '../../lib/admin-users';
import {
  Alert, Badge, Card, EmptyState, Field, Input, Pagination, Progress, Segmented, Select, Skeleton, Table,
} from '../../ui';
import s from '../../layout/AdminShell.module.css';

const PAGE_SIZE = 25;

export function AdminUsersPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<AdminUsersQuery>({
    q: '', page: 0, pageSize: PAGE_SIZE, sort: 'created_at', filter: 'all',
  });

  // Запрос на каждое нажатие клавиши бил бы по базе поиском ilike по семи полям.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(current => ({ ...current, q: search, page: 0 })), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const users = useAdminUsers(query);
  const items = users.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((users.data?.total ?? 0) / query.pageSize));

  return (
    <div className="page stack-lg">
      <Card>
        <div className={s.toolbar}>
          <div className={s.grow}>
            <Field label="Поиск" help="Почта, телефон, имя, код доступа, ключ, реферальный код или id">
              <Input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Начните вводить…"
              />
            </Field>
          </div>
          <Field label="Сортировка">
            <Select
              value={query.sort}
              onChange={event =>
                setQuery(current => ({ ...current, sort: event.target.value as AdminUsersQuery['sort'], page: 0 }))
              }
            >
              <option value="created_at">Сначала новые</option>
              <option value="last_sign_in_at">По последнему входу</option>
              <option value="revenue">По выручке</option>
              <option value="generation_used">По генерациям</option>
            </Select>
          </Field>
        </div>

        <div className="section">
          <Segmented
            label="Фильтр пользователей"
            value={query.filter}
            onChange={filter => setQuery(current => ({ ...current, filter, page: 0 }))}
            options={[
              { value: 'all', label: 'Все' },
              { value: 'paying', label: 'С покупками' },
              { value: 'free', label: 'Без покупок' },
              { value: 'telegram', label: 'Telegram' },
              { value: 'inactive', label: 'Неактивные' },
              { value: 'banned', label: 'Заблокированные' },
            ]}
          />
        </div>
      </Card>

      {users.isError && <Alert tone="error">{users.error.message}</Alert>}

      {users.isPending ? (
        <Skeleton height={240} />
      ) : items.length ? (
        <>
          <p className={s.mutedNote}>
            Найдено: {users.data?.total ?? 0}. Показаны {items.length} на странице {query.page + 1} из {pages}.
          </p>
          <Table>
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Регистрация</th>
                <th>Последний вход</th>
                <th>Генерации</th>
                <th>Заказы</th>
                <th>Выручка</th>
                <th>Рефералы</th>
              </tr>
            </thead>
            <tbody>
              {items.map(user => (
                <tr
                  key={user.userId}
                  className={s.clickable}
                  onClick={() => navigate(`/panel/users/${user.userId}`)}
                >
                  <td>
                    <div className={s.row}>
                      <strong>{userLabel(user)}</strong>
                      {user.telegramOnly && <Badge>Telegram</Badge>}
                      {!user.emailConfirmed && !user.telegramOnly && <Badge tone="warning">Не подтверждён</Badge>}
                      {user.banned && <Badge tone="error">Заблокирован</Badge>}
                    </div>
                    {user.phone && <div className={s.mutedNote}>{user.phone}</div>}
                  </td>
                  <td>{shortDate(user.createdAt)}</td>
                  <td>{shortDate(user.lastSignInAt)}</td>
                  <td className={s.actionsCell}>
                    {user.generationLimit ? (
                      <Progress
                        value={user.generationUsed}
                        max={Math.max(1, user.generationLimit)}
                        label={<span>{user.generationUsed} из {user.generationLimit}</span>}
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{user.ordersPaid || '—'}</td>
                  <td>{user.revenueKopecks ? money(user.revenueKopecks) : '—'}</td>
                  <td>
                    {user.referralCode ? (
                      <span className="mono">{user.referralCode}</span>
                    ) : (
                      '—'
                    )}
                    {user.invited > 0 && <div className={s.mutedNote}>приглашено: {user.invited}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination
            page={query.page + 1}
            pages={pages}
            onChange={page => setQuery(current => ({ ...current, page: page - 1 }))}
          />
        </>
      ) : (
        <Card>
          <EmptyState
            icon={<Users />}
            title="Никого не нашлось"
            text={query.q ? 'Попробуйте другой запрос или снимите фильтр.' : 'Пользователей пока нет.'}
          />
        </Card>
      )}
    </div>
  );
}
