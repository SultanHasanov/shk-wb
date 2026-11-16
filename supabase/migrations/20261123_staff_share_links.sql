-- Ссылка для сотрудников на график пункта (кабинет → «Сотрудники» → «Выгрузить» → «Ссылка для сотрудников»).
-- Сотрудник открывает /grafik/<token> без входа и видит только смены и часы: без ставок, сумм, телефонов
-- и номеров WB. Сам график лежит в app_docs (ключ schedule, область — пункт), здесь только ссылка.
-- У пункта одна действующая ссылка; «выпустить новую» — старая получает revoked_at и сразу перестаёт открываться.
-- Браузер в таблицу не ходит: всё через сервер с service role (server/_staff.js).
begin;

create table if not exists public.staff_share_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  point_id uuid not null references public.app_points(id) on delete cascade,
  token text not null unique check (token ~ '^[A-Za-z0-9]{12,32}$'),
  short_names boolean not null default true,
  show_subs boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index if not exists staff_share_links_point_active_idx on public.staff_share_links(point_id) where revoked_at is null;
create index if not exists staff_share_links_user_idx on public.staff_share_links(user_id);
alter table public.staff_share_links enable row level security;
revoke all on public.staff_share_links from anon, authenticated;

commit;
