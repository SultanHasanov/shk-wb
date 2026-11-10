import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Проверки миграций «Админки на максималках» по исходникам: базу тесты не трогают.
// Главное — права: каждая новая или пересозданная функция работает от имени владельца
// (security definer), поэтому без снятия прав она открыла бы auth.users и деньги любому
// с публичным ключом проекта.

const root = resolve(__dirname, '../..');
const read = (name: string) => readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');

const FILES = [
  '20261115_user_overrides.sql',
  '20261116_user_restrictions.sql',
  '20261117_admin_audit_messaging.sql',
  '20261118_admin_user_directory_v2.sql',
  '20261119_user_restrictions_legacy_bans.sql',
] as const;
const sources = Object.fromEntries(FILES.map((name) => [name, read(name)])) as Record<(typeof FILES)[number], string>;

/** Текст без строчных комментариев `-- …`: закомментированный шаблон не должен влиять на проверки. */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

type FnDef = { file: string; name: string; types: string; header: string; params: string; body: string };

/** Все `create [or replace] function public.<имя>(…) … as $$ … $$` в файле. */
function functionsOf(file: string, sql: string): FnDef[] {
  const out: FnDef[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns\b([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/gi;
  for (const m of sql.matchAll(re)) {
    const params = m[2];
    const types = params
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const tokens = p.split(/\s+/);
        const defaultAt = tokens.findIndex((t) => t.toLowerCase() === 'default');
        return tokens.slice(1, defaultAt === -1 ? undefined : defaultAt).join(' ');
      })
      .join(',');
    out.push({ file, name: m[1], types, header: m[3], params, body: m[4] });
  }
  return out;
}

const normArgs = (s: string) => s.replace(/\s+/g, '').toLowerCase();

const allFunctions = FILES.flatMap((file) => functionsOf(file, stripComments(sources[file])));

describe('миграции админки: общие правила', () => {
  it('каждый файл — одна транзакция', () => {
    for (const file of FILES) {
      const sql = stripComments(sources[file]).trim();
      expect(sql.startsWith('begin;'), file).toBe(true);
      expect(sql.endsWith('commit;'), file).toBe(true);
    }
  });

  it('создаёт все функции из контракта', () => {
    const names = new Set(allFunctions.map((fn) => fn.name));
    for (const name of [
      'app_user_override', 'app_entitlements', 'app_consume',
      'user_controls_snapshot', 'user_restrictions_due',
      'admin_wallet_adjust', 'admin_maintenance', 'admin_user_labels',
      'admin_user_directory', 'admin_user_counts',
    ]) expect(names.has(name), name).toBe(true);
  });

  it('у каждой функции security definer и set search_path', () => {
    for (const fn of allFunctions) {
      expect(fn.header, `${fn.file}: ${fn.name}`).toMatch(/security\s+definer/i);
      expect(fn.header, `${fn.file}: ${fn.name}`).toMatch(/set\s+search_path\s*=\s*public/i);
    }
  });

  it('у каждой функции права сняты со всех и выданы только service_role — по точной сигнатуре', () => {
    for (const fn of allFunctions) {
      const sql = stripComments(sources[fn.file as (typeof FILES)[number]]);
      const revokes = [...sql.matchAll(new RegExp(`revoke all on function public\\.${fn.name}\\(([^)]*)\\) from public, anon, authenticated;`, 'gi'))]
        .map((m) => normArgs(m[1]));
      const grants = [...sql.matchAll(new RegExp(`grant execute on function public\\.${fn.name}\\(([^)]*)\\) to service_role;`, 'gi'))]
        .map((m) => normArgs(m[1]));
      expect(revokes, `${fn.file}: revoke ${fn.name}(${fn.types})`).toContain(normArgs(fn.types));
      expect(grants, `${fn.file}: grant ${fn.name}(${fn.types})`).toContain(normArgs(fn.types));
      // Права не раздаются никому, кроме service_role.
      expect(sql).not.toMatch(new RegExp(`grant[^;]*function public\\.${fn.name}\\([^)]*\\)[^;]*to\\s+(?!service_role)`, 'i'));
    }
  });

  it('у новых таблиц включён RLS, сняты права у anon/authenticated и выданы service_role', () => {
    const tables: Array<[string, string]> = [];
    for (const file of FILES) {
      for (const m of stripComments(sources[file]).matchAll(/create table if not exists public\.(\w+)/gi)) tables.push([file, m[1]]);
    }
    expect(tables.map(([, t]) => t).sort()).toEqual(['user_overrides', 'user_restrictions']);
    for (const [file, table] of tables) {
      const sql = stripComments(sources[file as (typeof FILES)[number]]);
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toContain(`revoke all on table public.${table} from anon, authenticated;`);
      expect(sql).toContain(`grant select, insert, update, delete on table public.${table} to service_role;`);
    }
  });
});

describe('20261115_user_overrides', () => {
  const sql = stripComments(sources['20261115_user_overrides.sql']);
  const ent = allFunctions.find((fn) => fn.name === 'app_entitlements')!;
  const consume = allFunctions.find((fn) => fn.name === 'app_consume')!;

  it('app_entitlements сохраняет все прежние ключи ответа (20261110), включая device_bonus', () => {
    const previous = functionsOf('20261110', read('20261110_app_device_bonus.sql')).find((fn) => fn.name === 'app_entitlements')!;
    const oldKeys = new Set([...previous.body.matchAll(/'([a-z_]+)',/g)].map((m) => m[1]));
    expect(oldKeys.has('device_bonus')).toBe(true);
    expect(oldKeys.size).toBeGreaterThan(10);
    for (const key of oldKeys) expect(ent.body, key).toContain(`'${key}'`);
    expect(ent.body).toContain("'device_bonus'");
  });

  it('app_entitlements отдаёт новые ключи во всех ветках', () => {
    for (const key of ['points_bonus', 'mirror_bonus', 'unlimited', 'unlimited_until', 'codes_base', 'override']) {
      expect(ent.body, key).toContain(`'${key}'`);
    }
    // Три выхода (подписка, ручная квота без подписки, без всего) — все дополняются общими ключами.
    expect(ent.body.match(/\|\|\s*extra/g)?.length).toBe(3);
    expect(ent.body).toMatch(/select \* into ov from public\.user_overrides/);
    expect(ent.body).not.toMatch(/ov\s*:=\s*\(\s*select/i);
    expect(ent.body).toContain("date_trunc('month', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow'");
    // Переходный период: старая надбавка ПК учитывается через greatest.
    expect(ent.body).toMatch(/greatest\([\s\S]*app_device_bonuses/);
  });

  it('app_consume: безлимит не пишет app_usage, ручная квота без подписки — строки quota без подписки', () => {
    expect(consume.types).toBe('uuid,uuid,text,integer,jsonb');
    const unlimitedAt = consume.body.indexOf("jsonb_build_object('source', 'unlimited')");
    expect(unlimitedAt).toBeGreaterThan(-1);
    expect(consume.body.indexOf('pg_advisory_xact_lock')).toBeLessThan(unlimitedAt);
    expect(consume.body.indexOf('insert into public.app_usage')).toBeGreaterThan(unlimitedAt);
    expect(consume.body).toContain("raise exception 'UNSUPPORTED_KIND'");
    expect(consume.body).toContain("raise exception 'INVALID_AMOUNT'");
    expect(consume.body).toContain("raise exception 'LIMIT_EXCEEDED'");
    expect(consume.body).toMatch(/values \(p_user, null, p_device, 'code', 1, 'quota'/);
  });

  it('app_user_override меняет только присланные поля и умеет clear', () => {
    const fn = allFunctions.find((f) => f.name === 'app_user_override')!;
    expect(fn.types).toBe('uuid,jsonb,text');
    for (const key of ['codes_mode', 'codes_monthly', 'codes_until', 'devices_bonus', 'points_bonus', 'mirror_bonus',
      'slots_until', 'unlimited', 'unlimited_until', 'note']) {
      expect(fn.body, key).toContain(`patch ? '${key}'`);
    }
    expect(fn.body).toContain("patch->>'clear'");
    expect(fn.body).toMatch(/for update/);
    expect(fn.body).toContain("jsonb_build_object('before', before_row, 'after', after_row)");
  });

  it('переносит надбавку ПК, а env-безлимит оставляет закомментированным шаблоном', () => {
    expect(sql).toMatch(/insert into public\.user_overrides\(user_id, devices_bonus, note, updated_by\)[\s\S]*from public\.app_device_bonuses/);
    const raw = sources['20261115_user_overrides.sql'];
    expect(raw).toContain("-- values ('<uuid>', true, 'перенос APP_UNLIMITED_USER_IDS', 'migration')");
    expect(sql).not.toContain('<uuid>');
  });
});

describe('20261116_user_restrictions', () => {
  const sql = stripComments(sources['20261116_user_restrictions.sql']);

  it('одно действующее ограничение на пользователя и белый список областей', () => {
    expect(sql).toContain('create unique index if not exists user_restrictions_active_uidx on public.user_restrictions(user_id) where lifted_at is null;');
    expect(sql).toContain("array['all','site','app','cell_print','bot','purchases','withdrawals']::text[]");
  });

  it('снимок отдаёт только действующие ограничения и пустые массивы вместо null', () => {
    const fn = allFunctions.find((f) => f.name === 'user_controls_snapshot')!;
    expect(fn.header).toMatch(/language sql stable/);
    expect(fn.body).toContain('r.lifted_at is null and (r.until is null or r.until > now())');
    expect(fn.body.match(/'\[\]'::jsonb/g)?.length).toBe(2);
    expect(fn.body).toContain('left join public.user_telegram_identities');
  });

  it('просроченные отдаются таймеру с зажатым лимитом', () => {
    const fn = allFunctions.find((f) => f.name === 'user_restrictions_due')!;
    expect(fn.types).toBe('integer');
    expect(fn.body).toContain('until <= now()');
    expect(fn.body).toMatch(/least\(coalesce\(p_limit, 50\), 200\)/);
  });

  it('старые баны здесь не переносит: файл едет в фазе A, пока старая кнопка «Разблокировать» не знает про таблицу', () => {
    expect(sql).not.toMatch(/insert\s+into\s+public\.user_restrictions/);
    expect(sql).not.toContain('Перенесено из старой блокировки');
  });

  it('перенесённый старый бан действует в снимке, только пока стоит сам бан в GoTrue', () => {
    const fn = allFunctions.find((f) => f.name === 'user_controls_snapshot')!;
    expect(fn.body).toMatch(
      /coalesce\(r\.disabled_items->>'legacy', ''\) <> 'true'\s+or exists \(select 1 from auth\.users u where u\.id = r\.user_id and u\.banned_until > now\(\)\)/,
    );
  });

  it('объединение и перепривязка Telegram не сбрасывают ограничение и не теряют ручные лимиты', () => {
    const merge = allFunctions.find((f) => f.name === 'merge_telegram_account')!;
    const relink = allFunctions.find((f) => f.name === 'relink_telegram_identity')!;
    expect(merge.types).toBe('bigint,uuid');
    expect(relink.types).toBe('bigint,uuid');
    for (const fn of [merge, relink]) {
      // ограниченный кабинет (запись или GoTrue-бан) не уходит — api/auth.js отвечает 409 по TELEGRAM_ACCOUNT_NOT_EMPTY
      expect(fn.body).toMatch(/from public\.user_restrictions r\s+where r\.user_id\s*=\s*source_user_id and r\.lifted_at is null/);
      expect(fn.body).toMatch(/u\.id\s*=\s*source_user_id and u\.banned_until > now\(\)/);
      expect(fn.body).toContain("raise exception 'TELEGRAM_ACCOUNT_NOT_EMPTY: SOURCE_ACCOUNT_RESTRICTED'");
    }
    // объединение переносит ручные лимиты и историю ограничений к основному кабинету до удаления технического
    expect(merge.body).toMatch(/update public\.user_overrides set user_id=p_target_user_id/);
    expect(merge.body).toMatch(/delete from public\.user_overrides where user_id=source_user_id/);
    expect(merge.body).toContain('update public.user_restrictions set user_id=p_target_user_id where user_id=source_user_id');
    // прежние переносы на месте
    for (const table of ['payment_orders', 'sticker_access_codes', 'license_keys', 'cell_print_licenses', 'referral_ledger', 'user_telegram_identities']) {
      expect(merge.body).toContain(`update public.${table} set`);
    }
    // перепривязка с удалением технического кабинета не пускает, если вместе с ним удалились бы лимиты или история
    expect(relink.body).toContain('exists (select 1 from public.user_overrides where user_id = source_user_id)');
    expect(relink.body).toContain('exists (select 1 from public.user_restrictions where user_id = source_user_id)');
  });
});

describe('20261119_user_restrictions_legacy_bans', () => {
  const raw = sources['20261119_user_restrictions_legacy_bans.sql'];
  const sql = stripComments(raw);

  it('в заголовке сказано применять после выкладки B3 на оба сервера', () => {
    expect(raw).toMatch(/ПОСЛЕ выкладки B3 на ОБА сервера/);
  });

  it('сначала снимает устаревшие перенесённые записи, у которых GoTrue-бана уже нет', () => {
    const update = sql.indexOf('update public.user_restrictions r');
    const insert = sql.indexOf('insert into public.user_restrictions');
    expect(update).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(update);
    const stmt = sql.slice(update, sql.indexOf(';', update));
    expect(stmt).toContain("r.created_by = 'migration'");
    expect(stmt).toContain("r.disabled_items->>'legacy' = 'true'");
    expect(stmt).toContain('r.lifted_at is null');
    expect(stmt).toMatch(/not exists \(select 1 from auth\.users u where u\.id = r\.user_id and u\.banned_until > now\(\)\)/);
  });

  it('переносит действующие GoTrue-баны как legacy без повторов', () => {
    expect(sql).toContain(`'{"legacy": true}'::jsonb`);
    expect(sql).toMatch(/where u\.banned_until > now\(\)/);
    expect(sql).toMatch(/not exists \(select 1 from public\.user_restrictions r where r\.user_id = u\.id and r\.lifted_at is null\)/);
  });
});

describe('20261117_admin_audit_messaging', () => {
  const sql = stripComments(sources['20261117_admin_audit_messaging.sql']);

  it('проверка created_by сообщений на ПК пускает admin', () => {
    expect(sql).toContain("alter table public.app_device_messages add constraint app_device_messages_created_by_check check (created_by in ('owner','admin'));");
    expect(sql).toMatch(/pg_get_constraintdef\(con\.oid\) ~ '\\mcreated_by\\M'/);
  });

  it('доставки: каналы telegram и pc, статусы not_configured и blocked', () => {
    expect(sql).toContain("check (channel in ('email','telegram','pc'))");
    expect(sql).toContain("check (status in ('pending','sent','failed','skipped','not_configured','blocked'))");
    expect(sql).toContain('admin_action_id bigint references public.admin_actions(id) on delete set null');
  });

  it('журнал получает ключ повтора с уникальным индексом', () => {
    expect(sql).toContain('create unique index if not exists admin_actions_idempotency_uidx on public.admin_actions(idempotency_key) where idempotency_key is not null;');
    for (const col of ['reason', 'before', 'after', 'result', 'user_agent', 'idempotency_key', 'response']) {
      expect(sql).toContain(`add column if not exists ${col} `);
    }
  });

  it('новая перегрузка admin_wallet_adjust без default у p_event_key, старая не трогается', () => {
    const overloads = allFunctions.filter((f) => f.name === 'admin_wallet_adjust');
    expect(overloads).toHaveLength(1);
    expect(overloads[0].types).toBe('uuid,bigint,text,text');
    expect(overloads[0].params).not.toMatch(/default/i);
    expect(overloads[0].body).toContain("'admin:' || p_event_key");
    expect(sql).not.toMatch(/drop function[^;]*admin_wallet_adjust/i);
    expect(sql).not.toMatch(/function public\.admin_wallet_adjust\(uuid,\s*bigint,\s*text\)/i);
  });

  it('подписи пользователей приводят типы явно и ограничены 200 id', () => {
    const fn = allFunctions.find((f) => f.name === 'admin_user_labels')!;
    expect(fn.body).toContain('u.email::text');
    expect(fn.body).toContain('p_ids[1:200]');
    expect(fn.header).toMatch(/set search_path=public,auth/);
  });
});

describe('20261118_admin_user_directory_v2', () => {
  const sql = stripComments(sources['20261118_admin_user_directory_v2.sql']);
  const directory = allFunctions.find((f) => f.name === 'admin_user_directory')!;

  it('пересоздаётся drop + create внутри одной транзакции вместе с правами', () => {
    const begin = sql.indexOf('begin;');
    const drop = sql.indexOf('drop function if exists public.admin_user_directory(text, integer, integer, text, text);');
    const create = sql.indexOf('create function public.admin_user_directory(');
    const revoke = sql.indexOf('revoke all on function public.admin_user_directory(');
    const grant = sql.indexOf('grant execute on function public.admin_user_directory(');
    const commit = sql.lastIndexOf('commit;');
    expect(begin).toBe(0);
    expect(drop).toBeGreaterThan(begin);
    expect(create).toBeGreaterThan(drop);
    expect(revoke).toBeGreaterThan(create);
    expect(grant).toBeGreaterThan(revoke);
    expect(commit).toBeGreaterThan(grant);
  });

  it('не собирает SQL сортировки и фильтра строками', () => {
    expect(sql).not.toMatch(/\|\|\s*p_sort/);
    expect(sql).not.toMatch(/\|\|\s*p_filter/);
    expect(sql).not.toMatch(/execute\s+format\([^)]*p_sort/i);
    expect(sql).not.toMatch(/execute\s+format/i);
  });

  it('сохраняет прежние колонки в прежнем порядке, новые — перед total_count', () => {
    const columnsOf = (header: string) => {
      const list = header.match(/table\s*\(([\s\S]*?)\)\s*language/i)![1];
      return list.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
    };
    const old = functionsOf('20260909', read('20260909_admin_user_directory.sql')).find((f) => f.name === 'admin_user_directory')!;
    const oldCols = columnsOf(old.header);
    const newCols = columnsOf(directory.header);
    expect(newCols.slice(0, oldCols.length - 1)).toEqual(oldCols.slice(0, -1));
    expect(newCols.at(-1)).toBe('total_count');
    for (const col of ['wallet_kopecks', 'app_plan', 'app_ends_at', 'app_paid_until', 'app_device_limit', 'app_addons',
      'device_bonus', 'points_bonus', 'mirror_bonus', 'devices_count', 'points_count', 'last_seen_at',
      'restricted', 'restriction_scopes', 'restriction_until', 'unlimited', 'unlimited_until']) {
      expect(newCols, col).toContain(col);
    }
  });

  it('знает новые фильтры и сортировки', () => {
    for (const filter of ['paying', 'free', 'telegram', 'banned', 'inactive', 'subscribed', 'expiring', 'unlimited', 'restricted']) {
      expect(directory.body, filter).toContain(`when '${filter}' then`);
    }
    expect(directory.body).toContain("when 'telegram' then b.has_telegram");
    for (const sort of ['created_at', 'last_sign_in_at', 'revenue', 'generation_used', 'balance', 'expiring']) {
      expect(directory.body, sort).toContain(`'${sort}'`);
    }
    expect(directory.body).toContain('u.email::text');
  });

  it('счётчики для чипов отдают все ключи', () => {
    const fn = allFunctions.find((f) => f.name === 'admin_user_counts')!;
    for (const key of ['all', 'paying', 'subscribed', 'expiring', 'unlimited', 'restricted', 'telegram', 'inactive', 'new30']) {
      expect(fn.body, key).toContain(`'${key}', count(*)`);
    }
  });

  it('admin_user_summary не трогается', () => {
    for (const file of FILES) expect(stripComments(sources[file])).not.toContain('admin_user_summary');
  });
});
