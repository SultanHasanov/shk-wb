import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Download, ListFilter, Search, Users } from 'lucide-react';
import {
  adminApi, useAdminUserCounts, useAdminUsers,
  type AdminUserCounts, type AdminUserRow, type AdminUsersFilter, type AdminUsersPage as UsersPageData, type AdminUsersSort,
} from '../../api/admin';
import {
  LEGACY_USER_FILTERS, USER_FILTERS, USER_PAGE_SIZES, USER_SORTS, accountsLabel, filterLabel, formatCount, initials,
  lastActivity, parseUsersParams, rangeLabel, relativeSeen, revenueCell, slotsLabel, tariffCell, userBadges,
  userNameAndContact, usersParamsToSearch, usersToCsv, type UsersListState,
} from '../../lib/admin-users';
import { formatKopecks, mskDayKeyOf } from '../../lib/admin-audit';
import { Badge, Button, Input, Select, Skeleton, useToast } from '../../ui';
import { ChipFilter, DataState, ResponsiveTable, errorText } from './kit';
import type { ResponsiveColumn } from './kit';
import p from './admin-pages.module.css';

/** Ключ, под которым карточка пользователя запоминает последнего открытого (контракт 5.7). */
const LAST_USER_KEY = 'admin.lastUserId';
const SEARCH_DEBOUNCE_MS = 300;
const EXPORT_PAGES = 10;
const EXPORT_PAGE_SIZE = 100;

function readLastUserId(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_USER_KEY);
  } catch {
    // Приватный режим или запрет хранилища — просто без подсветки.
    return null;
  }
}

function usersUrl(state: UsersListState): string {
  return (
    `/api/admin/data?resource=users&action=list&q=${encodeURIComponent(state.q)}&page=${state.page}` +
    `&pageSize=${state.pageSize}&sort=${state.sort}&filter=${state.filter}`
  );
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Цвет кружка с инициалами — от id, чтобы у человека он не менялся между страницами. */
function avatarTone(userId: string): number {
  let sum = 0;
  for (const char of userId) sum = (sum + char.charCodeAt(0)) % 997;
  return sum % 5;
}

const TILES: ReadonlyArray<{ key: keyof AdminUserCounts; label: string; filter: AdminUsersFilter; tone?: 'warning' | 'danger' }> = [
  { key: 'all', label: 'Всего аккаунтов', filter: 'all' },
  { key: 'subscribed', label: 'С подпиской Помощника', filter: 'subscribed' },
  { key: 'expiring', label: 'Истекает за 7 дней', filter: 'expiring', tone: 'warning' },
  { key: 'telegram', label: 'Привязан Telegram', filter: 'telegram' },
  { key: 'restricted', label: 'Ограничены', filter: 'restricted', tone: 'danger' },
];

export function AdminUsersPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => parseUsersParams(params), [params]);

  const update = useCallback(
    (patch: Partial<UsersListState>) =>
      setParams(current => usersParamsToSearch({ ...parseUsersParams(current), ...patch }), { replace: true }),
    [setParams],
  );

  // Поиск: поле живёт своим состоянием, а в адрес (и в запрос) уходит с задержкой —
  // ilike по семи полям на каждую букву был бы прямой нагрузкой на базу.
  const [search, setSearch] = useState(state.q);
  const writtenQ = useRef(state.q);
  useEffect(() => {
    const value = search.trim();
    if (value === writtenQ.current) return;
    const timer = window.setTimeout(() => {
      writtenQ.current = value;
      update({ q: value, page: 0 });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, update]);
  // Запрос пришёл снаружи (поиск в шапке, «назад» в браузере) — показываем его в поле.
  useEffect(() => {
    if (state.q === writtenQ.current) return;
    writtenQ.current = state.q;
    setSearch(state.q);
  }, [state.q]);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [lastUserId] = useState(readLastUserId);
  const [exporting, setExporting] = useState(false);

  const users = useAdminUsers(state);
  const counts = useAdminUserCounts();
  const data = users.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasNext = (state.page + 1) * state.pageSize < total;

  const filterOptions = useMemo(() => {
    const legacy = LEGACY_USER_FILTERS.find(item => item.value === state.filter);
    return legacy ? [...USER_FILTERS, legacy] : USER_FILTERS;
  }, [state.filter]);

  const resetFilters = () => {
    writtenQ.current = '';
    setSearch('');
    setParams(new URLSearchParams(), { replace: true });
  };

  const exportCsv = async () => {
    // До 10 страниц по 100 текущего фильтра — выгрузка на клиенте, отдельной ручки нет.
    setExporting(true);
    try {
      const rows: AdminUserRow[] = [];
      for (let page = 0; page < EXPORT_PAGES; page += 1) {
        const chunk = await adminApi<UsersPageData>(usersUrl({ ...state, page, pageSize: EXPORT_PAGE_SIZE }));
        rows.push(...chunk.items);
        if ((page + 1) * EXPORT_PAGE_SIZE >= chunk.total || chunk.items.length < EXPORT_PAGE_SIZE) break;
      }
      downloadText(`users-${state.filter}-${mskDayKeyOf(new Date())}.csv`, usersToCsv(rows));
      const capped = total > EXPORT_PAGES * EXPORT_PAGE_SIZE;
      toast(
        capped
          ? `Выгружено ${formatCount(rows.length)} из ${formatCount(total)}: за раз — не больше ${EXPORT_PAGES * EXPORT_PAGE_SIZE}`
          : `Выгружено: ${formatCount(rows.length)}`,
        capped ? 'default' : 'success',
      );
    } catch (error) {
      toast(`Не удалось выгрузить: ${errorText(error)}`, 'error');
    } finally {
      setExporting(false);
    }
  };

  const selectedOnPage = Boolean(lastUserId && items.some(row => row.userId === lastUserId));

  const columns: ResponsiveColumn<AdminUserRow>[] = [
    {
      key: 'user',
      header: 'Пользователь',
      primary: true,
      cell: row => <UserCell row={row} />,
    },
    {
      key: 'tariff',
      header: 'Тариф Помощника',
      label: 'Тариф',
      cell: row => {
        const tariff = tariffCell(row);
        return (
          <span className={p.tariff}>
            <span className={tariff.empty ? p.tariffEmpty : undefined}>{tariff.text}</span>
            {tariff.expiring && <span className={p.expiring}>{tariff.expiring}</span>}
          </span>
        );
      },
    },
    {
      key: 'balance',
      header: 'Баланс',
      align: 'end',
      cell: row => {
        const kopecks = row.walletKopecks ?? 0;
        return <span className={`${p.num} ${kopecks ? p.balance : p.balanceZero}`}>{formatKopecks(kopecks)}</span>;
      },
    },
    {
      key: 'slots',
      header: 'ПК / пункты',
      label: 'ПК·пункты',
      cell: row => <span className={p.num}>{slotsLabel(row)}</span>,
    },
    {
      key: 'last',
      header: 'Последний вход',
      label: 'Был(а)',
      cell: row => <span className={p.num}>{relativeSeen(lastActivity(row))}</span>,
    },
    {
      key: 'revenue',
      header: 'Выручка',
      align: 'end',
      hideOnMobile: true,
      cell: row => {
        const revenue = revenueCell(row);
        return (
          <span className={p.num}>
            <b>{revenue.main}</b>
            <span className={p.revenueSub}>{revenue.sub}</span>
          </span>
        );
      },
    },
    {
      key: 'open',
      header: <span className="sr-only">Открыть</span>,
      label: 'Открыть',
      hideOnMobile: true,
      width: '40px',
      cell: () => (
        <span className={p.openCell} aria-hidden="true">
          <ChevronRight size={18} />
        </span>
      ),
    },
  ];

  const subtitle = counts.data
    ? `${accountsLabel(counts.data.all)} · ${formatCount(counts.data.new30)} ${counts.data.new30 === 1 ? 'новый' : 'новых'} за 30 дней`
    : data
      ? accountsLabel(total)
      : '';

  return (
    <div className="page stack-lg">
      <div className={p.pageHead}>
        <p className={p.pageSub}>{subtitle || ' '}</p>
        <Button
          variant="secondary"
          className={p.tap}
          onClick={() => void exportCsv()}
          loading={exporting}
          disabled={!total}
        >
          <Download size={16} aria-hidden="true" />
          Экспорт CSV
        </Button>
      </div>

      <CountTiles counts={counts} active={state.filter} onPick={filter => update({ filter, page: 0 })} />

      <section className={p.panel} aria-label="Поиск и фильтры">
        <div className={p.searchRow}>
          <div className={p.searchField}>
            <label className={p.fieldLabel} htmlFor="admin-users-search">
              Поиск
            </label>
            <div className={p.searchBox}>
              <Search size={18} aria-hidden="true" />
              <Input
                id="admin-users-search"
                type="search"
                value={search}
                autoComplete="off"
                onChange={event => setSearch(event.target.value)}
                placeholder="Почта, телефон, имя, Telegram, ключ, реферальный код, ID"
              />
            </div>
          </div>
          <div className={p.sortField}>
            <label className={p.fieldLabel} htmlFor="admin-users-sort">
              Сортировка
            </label>
            <Select
              id="admin-users-sort"
              className={p.tap}
              value={state.sort}
              onChange={event => update({ sort: event.target.value as AdminUsersSort, page: 0 })}
            >
              {USER_SORTS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              {state.sort === 'generation_used' && <option value="generation_used">По генерациям</option>}
            </Select>
          </div>
        </div>

        <button
          type="button"
          className={p.filterToggle}
          aria-expanded={filtersOpen}
          aria-controls="admin-users-filters"
          data-active={state.filter !== 'all' || filtersOpen}
          onClick={() => setFiltersOpen(open => !open)}
        >
          <ListFilter size={18} aria-hidden="true" />
          <span>Фильтр: {filterLabel(state.filter)}</span>
          <ChevronRight size={18} aria-hidden="true" style={{ transform: filtersOpen ? 'rotate(90deg)' : undefined }} />
        </button>

        <div id="admin-users-filters" className={p.chipsWrap} data-open={filtersOpen}>
          <ChipFilter
            label="Быстрые фильтры"
            value={state.filter}
            options={filterOptions}
            onChange={filter => update({ filter, page: 0 })}
          />
        </div>
      </section>

      <section className="stack" aria-label="Список пользователей">
        <div className={p.listHead}>
          <h2 aria-live="polite">Найдено: {data ? accountsLabel(total) : '…'}</h2>
          {selectedOnPage && (
            <span className={p.legend}>
              <span className={p.legendMark} aria-hidden="true" />
              Выделена последняя открытая карточка
            </span>
          )}
        </div>

        <DataState
          query={users}
          isEmpty={page => page.items.length === 0}
          skeleton={<ListSkeleton />}
          empty={
            <EmptyList
              filtered={state.filter !== 'all' || Boolean(state.q)}
              filter={state.filter}
              onReset={resetFilters}
            />
          }
        >
          {page => (
            <>
              <div aria-busy={users.isPlaceholderData || undefined}>
                <ResponsiveTable
                  rows={page.items}
                  columns={columns}
                  rowKey={row => row.userId}
                  rowHref={row => `/panel/users/${row.userId}`}
                  selectedKey={lastUserId ?? undefined}
                />
              </div>
              <div className={p.pager}>
                <span>{rangeLabel(state.page, state.pageSize, page.items.length, page.total)}</span>
                <div className={p.pagerControls}>
                  <label htmlFor="admin-users-size">На странице</label>
                  <Select
                    id="admin-users-size"
                    value={String(state.pageSize)}
                    onChange={event => update({ pageSize: Number(event.target.value), page: 0 })}
                  >
                    {USER_PAGE_SIZES.map(size => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="secondary"
                    className={p.tap}
                    disabled={state.page === 0}
                    onClick={() => update({ page: Math.max(0, state.page - 1) })}
                  >
                    <ChevronLeft size={16} aria-hidden="true" />
                    Назад
                  </Button>
                  <Button
                    variant="secondary"
                    className={p.tap}
                    disabled={!hasNext}
                    onClick={() => update({ page: state.page + 1 })}
                  >
                    Вперёд
                    <ChevronRight size={16} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </DataState>
      </section>
    </div>
  );
}

function UserCell({ row }: { row: AdminUserRow }) {
  const { name, contact } = userNameAndContact(row);
  const badges = userBadges(row);
  return (
    <span className={p.userCell}>
      <span className={p.avatar} data-tone={avatarTone(row.userId)} aria-hidden="true">
        {initials(name)}
      </span>
      <span className={p.userText}>
        <span className={p.userName}>
          <span className={p.userNameText}>{name}</span>
          {badges.map(badge => (
            <Badge key={badge.label} tone={badge.tone}>
              {badge.label}
            </Badge>
          ))}
        </span>
        {contact && <span className={p.userContact}>{contact}</span>}
      </span>
      <ChevronRight size={18} className={p.cardChevron} aria-hidden="true" />
    </span>
  );
}

function CountTiles({
  counts,
  active,
  onPick,
}: {
  counts: ReturnType<typeof useAdminUserCounts>;
  active: AdminUsersFilter;
  onPick: (filter: AdminUsersFilter) => void;
}) {
  if (counts.isPending) {
    return (
      <div className={p.tiles} aria-busy="true">
        {TILES.map(tile => (
          <Skeleton key={tile.key} height={64} />
        ))}
      </div>
    );
  }
  if (!counts.data) {
    return (
      <div className={p.tilesError} role="alert">
        Не удалось загрузить сводку: {errorText(counts.error)}
        <Button variant="ghost" size="sm" className={p.tap} onClick={() => void counts.refetch()}>
          Повторить
        </Button>
      </div>
    );
  }
  const data = counts.data;
  return (
    <div className={p.tiles}>
      {TILES.map(tile => (
        <button
          key={tile.key}
          type="button"
          className={[p.tile, tile.tone === 'warning' ? p.tileWarning : '', tile.tone === 'danger' ? p.tileDanger : ''].join(' ')}
          aria-pressed={active === tile.filter}
          onClick={() => onPick(tile.filter)}
        >
          <span className={p.tileLabel}>{tile.label}</span>
          <span className={p.tileValue}>{formatCount(data[tile.key] ?? 0)}</span>
        </button>
      ))}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="stack" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} height={52} />
      ))}
    </div>
  );
}

function EmptyList({ filtered, filter, onReset }: { filtered: boolean; filter: AdminUsersFilter; onReset: () => void }) {
  return (
    <div className={p.empty}>
      <span className={p.emptyIcon} aria-hidden="true">
        <Users size={22} />
      </span>
      <strong>{filtered ? 'Никого не нашли' : 'Пользователей пока нет'}</strong>
      {filtered && (
        <>
          <div>
            {filter !== 'all'
              ? `Под фильтр «${filterLabel(filter)}» сейчас никто не подходит. Выберите другой фильтр или очистите поиск.`
              : 'По этому запросу никого нет. Попробуйте почту, телефон или ID целиком.'}
          </div>
          <Button variant="secondary" className={p.tap} onClick={onReset}>
            Сбросить фильтры
          </Button>
        </>
      )}
    </div>
  );
}
