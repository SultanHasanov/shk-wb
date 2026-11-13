// Prints a rollback-only PostgreSQL regression test, using temporary tables.
// Run: node supabase/tests/run-claim-regression.cjs | psql -X -v ON_ERROR_STOP=1 DATABASE
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261121_claim_user_asset_multiple_orders.sql'), 'utf8');
const definition = migration.match(/create or replace function[\s\S]+?end;\$\$;/i)?.[0];
if (!definition) throw new Error('Missing claim_user_asset definition');
// Exercise the shipped function against isolated fixtures, without production data.
const isolated = definition.replaceAll('public.', 'pg_temp.').replaceAll('auth.users', 'pg_temp.users')
  .replace('set search_path=public,auth', 'set search_path=pg_temp');
const fixtures = `
create temp table users (id uuid primary key, email_confirmed_at timestamptz);
create temp table sticker_access_codes (code text primary key, owner_user_id uuid);
create temp table license_keys (key text primary key, owner_user_id uuid);
create temp table cell_print_licenses (key text primary key, owner_user_id uuid);
create temp table payment_orders (
  id uuid primary key, user_id uuid, public_token text unique, status text,
  access_code text, program_license_key text, cell_print_license_key text
);
`;
const checks = fs.readFileSync(path.join(root, 'supabase/tests/claim_user_asset_multiple_orders.sql'), 'utf8');
process.stdout.write('begin;\n' + fixtures + isolated + '\n' + checks + '\nrollback;\n');
