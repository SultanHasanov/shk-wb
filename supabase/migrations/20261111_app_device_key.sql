-- Ключ устройства «Помощника ПВЗ» (05.11.2026): ПК ходит в передатчик (relay inbox/put) и за сообщениями
-- владельца без сессии. Выдаётся при входе/регистрации ПК; в базе — sha256 (key_hash), сам ключ только у ПК
-- (DPAPI device-key.bin). Выход из аккаунта строку НЕ отзывает; отзывает «Отключить» в кабинете (revoked_at) —
-- тогда и ключ мёртв. alert_sound — звук окна «сообщение владельца» на этом ПК (меняется в программе и в кабинете).
alter table public.app_devices
  add column if not exists key_hash text,
  add column if not exists key_issued_at timestamptz,
  add column if not exists alert_sound text
    check (alert_sound is null or alert_sound in ('chime','bell','ding','knock','pulse','soft'));
create index if not exists app_devices_hash_key_idx
  on public.app_devices(device_hash) where revoked_at is null and key_hash is not null;
