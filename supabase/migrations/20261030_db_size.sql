-- Размер базы для предупреждения админу (server/_disk-alert.js): бесплатный Supabase при 500 МБ
-- переводит базу в «только чтение» — так было 24.10. Только для service role.
create or replace function public.app_db_size()
returns bigint language sql stable security definer set search_path=public as $$
  select pg_database_size(current_database());
$$;

revoke all on function public.app_db_size() from public, anon, authenticated;
grant execute on function public.app_db_size() to service_role;
