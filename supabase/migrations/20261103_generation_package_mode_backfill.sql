begin;

-- Пакеты, купленные после перехода на рублёвый баланс, но до появления
-- generation_mode, уже имеют однозначный состав заказа. Старые выданные коды
-- и смешанные исторические пакеты остаются с NULL и совместимы с обоими режимами.
with paid_modes as (
  select
    coalesce(o.renewal_target_key,o.access_code) as code,
    bool_or(o.custom_quantity>0) as has_custom,
    bool_or(o.range_quantity>0) as has_batch
  from public.payment_orders o
  where o.product_kind='stickers'
    and o.status='succeeded'
    and coalesce(o.renewal_target_key,o.access_code) is not null
  group by coalesce(o.renewal_target_key,o.access_code)
), unambiguous as (
  select code,
    case
      when has_custom and not has_batch then 'custom'
      when has_batch and not has_custom then 'batch'
      else null
    end as generation_mode
  from paid_modes
)
update public.sticker_access_codes a
   set generation_mode=u.generation_mode
  from unambiguous u
 where a.code=u.code
   and a.generation_mode is null
   and a.generation_used<a.generation_limit
   and u.generation_mode is not null;

commit;
