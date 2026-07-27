begin;

select setval(
  pg_get_serial_sequence('public.license_keys', 'id'),
  coalesce((select max(id) from public.license_keys), 0) + 1,
  false
);

select setval(
  pg_get_serial_sequence('public.announcements', 'id'),
  coalesce((select max(id) from public.announcements), 0) + 1,
  false
);

commit;
