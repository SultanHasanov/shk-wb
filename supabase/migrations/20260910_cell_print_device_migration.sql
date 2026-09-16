-- Перенос активации на новый отпечаток устройства.
--
-- Раньше отпечаток считался в том числе по MAC-адресу, который выбирает Python
-- (uuid.getnode()). Он меняется, когда меняется набор сетевых адаптеров: VPN,
-- док-станция, виртуальный адаптер. Для ключа с лимитом в одно устройство это
-- означало «Device limit reached» на ровном месте и требование ввести ключ
-- заново через сутки, когда истекало офлайн-разрешение.
--
-- Программа теперь считает отпечаток по MachineGuid Windows и присылает вторым
-- параметром прежний отпечаток. Если по нему уже есть активация — это тот же
-- компьютер, и запись переносится на новый отпечаток вместо занятия второго
-- слота. Третий параметр со значением по умолчанию, поэтому старые версии
-- программы, присылающие два аргумента, продолжают работать без изменений.

drop function if exists public.activate_cell_print_license(text, text);

create or replace function public.activate_cell_print_license(
  p_key text,
  p_device_hash text,
  p_legacy_hash text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare lic public.cell_print_licenses; count_devices integer;
begin
  if p_device_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid device'; end if;
  if p_legacy_hash is not null and p_legacy_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid device'; end if;

  select * into lic from public.cell_print_licenses where key = upper(btrim(p_key)) for update;
  if not found or not lic.active then raise exception 'Invalid license'; end if;

  if lic.activated_at is null then
    update public.cell_print_licenses
       set activated_at = now(), expires_at = now() + make_interval(days => duration_days)
     where id = lic.id
    returning * into lic;
  end if;
  if lic.expires_at <= now() then raise exception 'License expired'; end if;

  if exists (select 1 from public.cell_print_activations
              where license_id = lic.id and device_hash = p_device_hash) then
    update public.cell_print_activations set last_seen_at = now()
     where license_id = lic.id and device_hash = p_device_hash;

  elsif p_legacy_hash is not null and exists (
          select 1 from public.cell_print_activations
           where license_id = lic.id and device_hash = p_legacy_hash) then
    -- Тот же компьютер, просто отпечаток стал считаться иначе.
    update public.cell_print_activations
       set device_hash = p_device_hash, last_seen_at = now()
     where license_id = lic.id and device_hash = p_legacy_hash;

  else
    select count(*) into count_devices from public.cell_print_activations where license_id = lic.id;
    if count_devices >= lic.device_limit then raise exception 'Device limit reached'; end if;
    insert into public.cell_print_activations(license_id, device_hash) values (lic.id, p_device_hash);
  end if;

  select count(*) into count_devices from public.cell_print_activations where license_id = lic.id;
  return jsonb_build_object(
    'active', true, 'expiresAt', lic.expires_at, 'deviceLimit', lic.device_limit,
    'devicesUsed', count_devices, 'serverTime', now());
end;$$;

revoke all on function public.activate_cell_print_license(text, text, text) from public, anon, authenticated;
