-- Защита от перебора кодов/ключей: считаем ТОЛЬКО неудачные попытки. Успешные
-- запросы ничего не инкрементят, поэтому легитимный пользователь не блокируется.
-- Инкремент неудач — существующей consume_api_rate_limit; проверка перед обработкой —
-- новой peek_api_rate_limit (читает счётчик окна БЕЗ инкремента). Только добавление.
begin;

create or replace function public.peek_api_rate_limit(
  p_scope text, p_key_hash text, p_limit integer, p_window_seconds integer
) returns boolean language plpgsql security definer set search_path = public as $$
declare current_hits integer;
begin
  if length(p_scope) not between 1 and 80 or length(p_key_hash) <> 64
     or p_limit not between 1 and 10000 or p_window_seconds not between 1 and 86400 then
    raise exception 'Invalid rate limit request';
  end if;
  -- Окно истекло → счётчик считается нулевым (как и при следующем consume).
  select case when window_started_at <= now()-(p_window_seconds||' seconds')::interval then 0 else hits end
    into current_hits from public.api_rate_limits where scope=p_scope and key_hash=p_key_hash;
  return coalesce(current_hits, 0) < p_limit;
end; $$;
revoke all on function public.peek_api_rate_limit(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.peek_api_rate_limit(text,text,integer,integer) to service_role;

commit;
