-- Executed by supabase/tests/run-claim-regression.cjs in a rollback-only transaction.
do $$
declare
  owner_id uuid := '00000000-0000-4000-8000-000000000001';
  other_id uuid := '00000000-0000-4000-8000-000000000002';
  unconfirmed_id uuid := '00000000-0000-4000-8000-000000000003';
  kind text;
  value text;
  result jsonb;
begin
  insert into pg_temp.users values (owner_id, now()), (other_id, now()), (unconfirmed_id, null);
  foreach kind in array array['sticker', 'program', 'cell_print'] loop
    value := case kind when 'sticker' then '123456' when 'program' then 'WBPK-TEST' else 'CP-TEST' end;
    insert into pg_temp.sticker_access_codes values (value, null);
    insert into pg_temp.license_keys values (value, null);
    insert into pg_temp.cell_print_licenses values (value, null);
    -- Two eligible purchases and one order belonging to another account.
    insert into pg_temp.payment_orders
      select gen_random_uuid(), who, gen_random_uuid()::text, 'succeeded', value, value, value
      from unnest(array[null::uuid, owner_id, other_id]) who;
    result := pg_temp.claim_user_asset(owner_id, kind, ' ' || lower(value) || ' ');
    if result->>'claimed' <> 'true' then raise exception 'Claim failed: %', kind; end if;
    if (select count(*) from pg_temp.payment_orders where access_code=value and user_id=owner_id) <> 2 then
      raise exception 'Multiple orders not linked: %', kind;
    end if;
    if (select count(*) from pg_temp.payment_orders where access_code=value and user_id=other_id) <> 1 then
      raise exception 'Foreign order was modified: %', kind;
    end if;
    -- Repeated calls remain valid even when all matching orders are already linked.
    perform pg_temp.claim_user_asset(owner_id, kind, value);
    begin
      perform pg_temp.claim_user_asset(other_id, kind, value);
      raise exception 'Foreign claim unexpectedly succeeded';
    exception when raise_exception then
      if sqlerrm <> 'Asset belongs to another user' then raise; end if;
    end;
  end loop;
  begin
    perform pg_temp.claim_user_asset(unconfirmed_id, 'sticker', '123456');
    raise exception 'Unconfirmed claim unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'User is not confirmed' then raise; end if;
  end;
  begin
    perform pg_temp.claim_user_asset(owner_id, 'sticker', 'missing');
    raise exception 'Missing asset unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Asset not found' then raise; end if;
  end;
  insert into pg_temp.sticker_access_codes values ('654321', null);
  insert into pg_temp.payment_orders values (gen_random_uuid(), null, 'guest-order', 'succeeded', '654321', null, null);
  perform pg_temp.claim_user_asset(owner_id, 'order', 'guest-order');
  if not exists(select 1 from pg_temp.sticker_access_codes where code='654321' and owner_user_id=owner_id) then
    raise exception 'Guest order did not link its asset';
  end if;
  begin
    perform pg_temp.claim_user_asset(other_id, 'order', 'guest-order');
    raise exception 'Foreign order claim unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Asset belongs to another user' then raise; end if;
  end;
  raise notice 'PASS: multiple purchases, repeated claims, ownership, confirmation, missing assets and guest orders';
end;
$$;
