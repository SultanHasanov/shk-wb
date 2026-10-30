-- Доступ сотрудников: что владелец закрыл на конкретном компьютере (кабинет → «Доступ сотрудников»).
-- denied — ключи разделов и действий (server/_app-permissions.js), уходят программе в подписанной аренде.
-- point_wb — пункт, чья база WB стоит на этом ПК (заголовок X-Point-Wb в /api/app/lease), для группировки в кабинете.
alter table public.app_devices
  add column if not exists denied text[] not null default '{}',
  add column if not exists point_wb text,
  add column if not exists access_updated_at timestamptz;
