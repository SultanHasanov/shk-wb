begin;

alter table public.cell_print_licenses
  drop constraint if exists cell_print_licenses_device_limit_check;

alter table public.cell_print_licenses
  add constraint cell_print_licenses_device_limit_check
  check (device_limit in (1,2,3,5,10,20));

commit;
