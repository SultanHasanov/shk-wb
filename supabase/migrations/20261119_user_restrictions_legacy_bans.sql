begin;

-- Перенос старых блокировок (GoTrue banned_until) в user_restrictions.
--
-- ПОРЯДОК ВЫПУСКА: применять ПОСЛЕ выкладки B3 на ОБА сервера (сайт и узел бота), а не в фазе A вместе
-- с 20261116. Пока работает старый сервер, его кнопка «Разблокировать» снимает только GoTrue-бан и
-- включает коды, а про user_restrictions не знает: перенесённая заранее строка осталась бы действующей и
-- после B3 закрыла бы разблокированному человеку сайт, программу, бота и покупки (403 ACCOUNT_RESTRICTED).
-- Сервер B3 снимает такие строки сам (unblockCompat → liftRestriction), а до переноса разблокирует
-- старый бан без строки так же, как старая кнопка.
--
-- Повторный запуск безопасен: уже перенесённых второй раз не переносит, устаревшие — снимает.

-- 1. Устаревшие перенесённые записи (если файл всё же применили раньше B3, а бан потом сняли старой
--    кнопкой): GoTrue уже не банит — отмечаем снятыми. Коды не трогаем: старая кнопка включила их сама,
--    а выключенное после этого вручную должно остаться выключенным.
update public.user_restrictions r
   set lifted_at = now(),
       lifted_by = 'migration',
       lifted_reason = 'Снято старой кнопкой «Разблокировать»',
       updated_at = now()
 where r.created_by = 'migration'
   and r.disabled_items->>'legacy' = 'true'
   and r.lifted_at is null
   and not exists (select 1 from auth.users u where u.id = r.user_id and u.banned_until > now());

-- 2. Перенос. Бессрочный старый бан — это ban_duration 876000h, то есть ~100 лет: всё дальше 50 лет
--    считаем «навсегда» (until null). legacy: при снятии возвращаем всё выключенное у владельца, как
--    делал старый unblock.
insert into public.user_restrictions(user_id, scopes, reason, until, disabled_items, created_by)
select u.id, array['all'], 'Перенесено из старой блокировки',
       case when u.banned_until > now() + interval '50 years' then null else u.banned_until end,
       '{"legacy": true}'::jsonb, 'migration'
  from auth.users u
 where u.banned_until > now()
   and not exists (select 1 from public.user_restrictions r where r.user_id = u.id and r.lifted_at is null);

commit;
