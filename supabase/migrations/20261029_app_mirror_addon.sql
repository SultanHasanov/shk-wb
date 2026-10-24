-- Зеркало пункта — платная услуга «Пункт с любого ПК» (пакеты mirror_1 / mirror_3, _app-plans.js).
-- До этого зеркало хранилось для всех пунктов и за полдня 24.10 заполнило диск базы.
-- Логика пакетов — та же, что у devices_*/points_* (app_apply_addon, complete_app_addon_order).

alter table public.app_addons drop constraint if exists app_addons_addon_check;
alter table public.app_addons add constraint app_addons_addon_check
  check (addon in ('archive','devices_1','devices_3','points_1','points_3','mirror_1','mirror_3'));

alter table public.payment_orders drop constraint if exists payment_orders_app_addon_check;
alter table public.payment_orders add constraint payment_orders_app_addon_check
  check (app_addon is null or app_addon in ('archive','devices_1','devices_3','points_1','points_3','mirror_1','mirror_3'));

-- Старое зеркало больше не нужно: оплатившие пункты программа отправит заново целиком
-- (видит пустой mirror_at и сбрасывает своё состояние отправки). mirror_floor поднимаем до
-- текущего seq — ПК, скачавшие старое зеркало, начнут его заново, а не останутся с устаревшим.
truncate table public.app_point_rows;
update public.app_points
   set mirror_at = null, mirror_schema = null,
       mirror_floor = (select last_value from public.app_sync_seq);
