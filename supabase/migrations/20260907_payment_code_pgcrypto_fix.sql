begin;

-- В Supabase расширение pgcrypto установлено в схему extensions. Функция
-- complete_payment_order из 20260905 имела search_path только public, поэтому
-- оплаченный заказ оставался без кода с ошибкой:
--   function gen_random_bytes(integer) does not exist
-- Тело функции менять не требуется: добавляем доверенную системную схему в
-- фиксированный search_path. Повторное выполнение безопасно.
alter function public.complete_payment_order(uuid)
  set search_path = public, extensions;

commit;
