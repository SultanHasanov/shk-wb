import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Полное слияние Telegram-аккаунта с аккаунтом сайта (20261120_account_merge_full.sql) и общий код вокруг него.
// SQL проверяется по исходнику: базу тесты не трогают. Сценарии на настоящем Postgres (сумма балансов,
// число строк журнала, очередь подписок, повтор вебхука) прогонялись отдельно перед коммитом.

const require = createRequire(import.meta.url);
const root = resolve(__dirname, '../..');
const migrationsDir = resolve(root, 'supabase/migrations');
const FILE = '20261120_account_merge_full.sql';
const raw = readFileSync(resolve(migrationsDir, FILE), 'utf8');
/** Текст без строчных комментариев `-- …`. */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
const sql = stripComments(raw);

type FnDef = { name: string; types: string; header: string; body: string };
function functionsOf(text: string): FnDef[] {
  const out: FnDef[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns\b([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/gi;
  for (const m of text.matchAll(re)) {
    const types = m[2].split(',').map((p) => p.trim()).filter(Boolean).map((p) => p.split(/\s+/)[1]).join(',');
    out.push({ name: m[1], types, header: m[3], body: m[4] });
  }
  return out;
}
const fns = functionsOf(sql);
const fn = (name: string) => {
  const found = fns.find((f) => f.name === name);
  if (!found) throw new Error(`function ${name} not found`);
  return found;
};
const summary = fn('account_merge_summary');
const merge = fn('merge_telegram_account');
const relink = fn('relink_telegram_identity');

describe('20261120_account_merge_full: общие правила', () => {
  it('одна транзакция', () => {
    expect(sql.trim().startsWith('begin;')).toBe(true);
    expect(sql.trim().endsWith('commit;')).toBe(true);
  });

  it('сигнатуры прежние — старый api/auth.js работает с новыми функциями', () => {
    expect(summary.types).toBe('uuid');
    expect(merge.types).toBe('bigint,uuid');
    expect(relink.types).toBe('bigint,uuid');
    expect(summary.header).toMatch(/jsonb/);
    expect(merge.header).toMatch(/jsonb/);
    expect(relink.header).toMatch(/jsonb/);
  });

  it('каждая функция — security definer с закреплённым search_path и только для service_role', () => {
    for (const f of [summary, merge, relink]) {
      expect(f.header, f.name).toMatch(/security definer/);
      expect(f.header, f.name).toMatch(/set search_path = public, auth/);
      expect(sql).toContain(`revoke all on function public.${f.name}(${f.types.replace(',', ', ')}) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${f.name}(${f.types.replace(',', ', ')}) to service_role;`);
    }
  });
});

describe('account_merge_summary', () => {
  it('считает кошелёк, подписки, ПК, пункты, ключи, коды, заказы и отзывы', () => {
    for (const table of [
      'wallet_accounts', 'wallet_ledger', 'payment_orders', 'sticker_access_codes', 'license_keys', 'cell_print_licenses',
      'user_generation_history', 'telegram_generation_requests', 'sticker_generation_charges', 'app_subscriptions',
      'app_addons', 'app_devices', 'cell_print_devices', 'app_points', 'app_docs', 'app_usage', 'bot_review_credits',
      'bot_review_reveals', 'individual_sticker_orders', 'custom_sticker_jobs', 'partners', 'user_oauth_identities',
      'user_overrides', 'app_device_bonuses', 'user_restrictions', 'referral_accounts', 'referral_ledger',
      'referral_withdrawals', 'referral_attributions',
    ]) {
      expect(summary.body, table).toContain(`from public.${table}`);
    }
    for (const key of ['walletKopecks', 'walletOperations', 'subscriptions', 'activeSubscriptions', 'devices', 'points', 'technical', 'restricted', 'empty']) {
      expect(summary.body).toContain(`'${key}'`);
    }
  });

  it('аккаунт с балансом, журналом кошелька, подпиской или ПК пустым не считается', () => {
    const empty = summary.body.slice(summary.body.indexOf("'empty'"));
    for (const part of ['wallet_kopecks = 0', 'wallet_ops = 0', 'subs_n = 0', 'addons_n = 0', 'devices_n = 0', 'paid_orders = 0', 'review_reveals_n = 0']) {
      expect(empty).toContain(part);
    }
  });
});

describe('relink_telegram_identity', () => {
  it('удаляемый технический аккаунт проверяется полной сводкой', () => {
    expect(relink.body).toContain('source_summary := public.account_merge_summary(source_user_id);');
    expect(relink.body).toMatch(/if not coalesce\(\(source_summary->>'empty'\)::boolean, false\) then\s+raise exception 'TELEGRAM_ACCOUNT_NOT_EMPTY';/);
    // сводка нужна только тому, кого удаляют: у аккаунта с почтой переходит лишь связка
    expect(relink.body.indexOf('if source_is_technical then')).toBeLessThan(relink.body.indexOf('account_merge_summary'));
  });

  it('ограниченный аккаунт по-прежнему не перепривязывается', () => {
    expect(relink.body).toMatch(/from public\.user_restrictions r\s+where r\.user_id = source_user_id and r\.lifted_at is null/);
    expect(relink.body).toContain("raise exception 'TELEGRAM_ACCOUNT_NOT_EMPTY: SOURCE_ACCOUNT_RESTRICTED'");
  });

  it('незавершённые заказы переносит, сессию мастера удаляет', () => {
    expect(relink.body).toContain("and status in ('pending', 'canceled');");
    expect(relink.body).toContain('delete from public.telegram_generator_sessions where telegram_user_id = p_telegram_user_id;');
  });
});

describe('merge_telegram_account', () => {
  it('ничего из прежней версии не потеряно', () => {
    const previous = functionsOf(stripComments(readFileSync(resolve(migrationsDir, '20261116_user_restrictions.sql'), 'utf8')))
      .find((f) => f.name === 'merge_telegram_account')!;
    const statements = [...previous.body.matchAll(/(update|delete from|insert into) public\.(\w+)/g)].map((m) => `${m[1]} public.${m[2]}`);
    expect(statements.length).toBeGreaterThan(15);
    for (const statement of new Set(statements)) expect(merge.body, statement).toContain(statement);
    for (const guard of ['TARGET_ACCOUNT_NOT_CONFIRMED', 'TELEGRAM_ACCOUNT_NOT_FOUND', 'TARGET_ACCOUNT_HAS_TELEGRAM',
      'SOURCE_ACCOUNT_NOT_TECHNICAL', 'TELEGRAM_ACCOUNT_NOT_EMPTY: SOURCE_ACCOUNT_RESTRICTED', 'REFERRAL_CODE_ALIAS_CONFLICT']) {
      expect(merge.body).toContain(guard);
    }
  });

  it('кошелёк: строки журнала перевешиваются, балансы складываются, исходный счёт удаляется', () => {
    expect(merge.body).toMatch(/update public\.wallet_ledger\s+set user_id=p_target_user_id/);
    expect(merge.body).toContain('balance_kopecks=public.wallet_accounts.balance_kopecks+excluded.balance_kopecks');
    expect(merge.body).toContain('delete from public.wallet_accounts where user_id=source_user_id;');
    // ключи событий не трогаем — повтор вебхука пополнения остаётся дублем
    expect(merge.body).not.toMatch(/event_key\s*=/);
    expect(merge.body).not.toMatch(/delete from public\.wallet_ledger/);
  });

  it('подписки и услуги при конфликте встают в очередь после последнего отрезка основного', () => {
    expect(merge.body).toMatch(/select max\(ends_at\) into cursor_at from public\.app_subscriptions\s+where user_id=p_target_user_id and not canceled and ends_at > now\(\);/);
    expect(merge.body).toContain('cursor_at := cursor_at + remaining;');
    expect(merge.body).toContain('update public.app_subscriptions set user_id=p_target_user_id where user_id=source_user_id;');
    expect(merge.body).toMatch(/select max\(ends_at\) into cursor_at from public\.app_addons\s+where user_id=p_target_user_id and addon=addon_row\.addon/);
    expect(merge.body).toContain('update public.app_addons set user_id=p_target_user_id where user_id=source_user_id;');
  });

  it('ПК: при совпадении device_hash остаётся строка основного, ссылки переводятся на неё', () => {
    expect(merge.body).toMatch(/join public\.app_devices t on t\.user_id=p_target_user_id and t\.device_hash=s\.device_hash/);
    for (const table of ['app_usage', 'app_code_approvals', 'app_device_messages', 'app_secret_access']) {
      expect(merge.body).toContain(`update public.${table} set device_id=dev.target_id where device_id=dev.source_id;`);
    }
    expect(merge.body).toContain('delete from public.app_devices where id=dev.source_id;');
    expect(merge.body).toMatch(/delete from public\.cell_print_devices s where s\.user_id=source_user_id\s+and exists\(select 1 from public\.cell_print_devices t\s+where t\.user_id=p_target_user_id and t\.device_hash=s\.device_hash\)/);
  });

  it('конфликты без человека не решаются — отказ до любых изменений', () => {
    const firstChange = merge.body.indexOf('update public.referral_accounts');
    for (const code of ['MERGE_BUSY', 'MERGE_POINT_CONFLICT', 'MERGE_CLOUD_DATA', 'MERGE_PARTNER_CONFLICT']) {
      const at = merge.body.indexOf(`raise exception '${code}`);
      expect(at, code).toBeGreaterThan(-1);
      expect(at, code).toBeLessThan(firstChange);
    }
    // бронь генерации у обоих сразу
    expect(merge.body).toMatch(/where user_id=source_user_id and status in \('reserved','consumed'\)\)\s+and exists\(select 1 from public\.sticker_generation_charges\s+where user_id=p_target_user_id and status in \('reserved','consumed'\)\)/);
  });

  it('берёт те же замки, что списания и выдачи, в постоянном порядке', () => {
    for (const key of ['sticker-generation:', 'app_subs:', 'app_addons:', 'bot_review:']) expect(merge.body).toContain(`'${key}'`);
    expect(merge.body).toMatch(/order by k\s+loop\s+perform pg_advisory_xact_lock\(hashtext\(lock_key\)\);/);
    expect(merge.body).toMatch(/from public\.wallet_accounts\s+where user_id in \(source_user_id, p_target_user_id\) order by user_id for update;/);
  });

  it('порядок замков как у оплат и возвратов: заказы → advisory → брони генераций → счета', () => {
    // wallet_pay_order / complete_*_order: заказ → счёт или app_subs:; refund_sticker_generation: бронь → счёт;
    // reserve_sticker_generation: advisory → бронь → счёт. Иначе слияние и оплата зажмут друг друга.
    const orders = merge.body.search(/perform 1 from public\.payment_orders\s+where user_id in \(source_user_id, p_target_user_id\) order by id for update;/);
    const advisory = merge.body.indexOf('perform pg_advisory_xact_lock(hashtext(lock_key));');
    const charges = merge.body.search(/perform 1 from public\.sticker_generation_charges\s+where user_id in \(source_user_id, p_target_user_id\) order by id for update;/);
    const wallets = merge.body.search(/perform 1 from public\.wallet_accounts\s+where user_id in/);
    const firstWrite = merge.body.search(/\b(update|delete from|insert into) public\./);
    expect(orders).toBeGreaterThan(-1);
    expect(charges).toBeGreaterThan(-1);
    expect(orders).toBeLessThan(advisory);
    expect(advisory).toBeLessThan(charges);
    expect(charges).toBeLessThan(wallets);
    expect(wallets).toBeLessThan(firstWrite);
  });

  it('отметка пробного периода «ПВЗ Принт» компьютера бота не уходит каскадом', () => {
    expect(sql).toContain('alter table public.cell_print_trial_claims alter column user_id drop not null;');
    expect(sql.indexOf('alter table public.cell_print_trial_claims')).toBeLessThan(sql.indexOf('create or replace function'));
    expect(merge.body).toMatch(/update public\.cell_print_trial_claims set user_id=p_target_user_id where user_id=source_user_id;\s+else\s+update public\.cell_print_trial_claims set user_id=null where user_id=source_user_id;/);
    // запрет второго пробного держится по компьютеру
    const trial = readFileSync(resolve(migrationsDir, '20261108_cell_print_trial_pause.sql'), 'utf8');
    expect(trial).toContain('where device_hash=p_device_hash or user_id=p_user');
  });

  it('удаляет сессию мастера этого Telegram и отвечает суммами переноса', () => {
    expect(merge.body).toContain('delete from public.telegram_generator_sessions where telegram_user_id=p_telegram_user_id;');
    for (const key of ['movedWalletKopecks', 'movedSubscriptions', 'movedDevices', 'movedOrders', 'deleteSource']) {
      expect(merge.body).toContain(`'${key}'`);
    }
  });

  it('каждая таблица, которая уходит каскадом вместе с пользователем, перенесена или осознанно оставлена', () => {
    // Новая таблица с user_id → auth.users on delete cascade должна попасть в merge_telegram_account
    // (или сюда, с причиной) — иначе после слияния её строки молча удалятся вместе с исходным аккаунтом.
    const LEFT_ON_PURPOSE: Record<string, string> = {
      app_login_requests: 'одноразовый запрос входа программы, живёт 10 минут',
      app_signup_requests: 'одноразовый запрос регистрации из программы',
      app_docs_history: 'старые версии документов зашифрованы ключом исходного user_id',
    };
    const cascade = new Set<string>();
    for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))) {
      const text = stripComments(readFileSync(resolve(migrationsDir, name), 'utf8'));
      for (const m of text.matchAll(/create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
        if (/references auth\.users\(id\) on delete cascade/.test(m[2])) cascade.add(m[1]);
      }
    }
    expect(cascade.size).toBeGreaterThan(30);
    for (const table of cascade) {
      if (LEFT_ON_PURPOSE[table]) continue;
      expect(merge.body, `public.${table} не переносится при слиянии`).toContain(`public.${table}`);
    }
  });

  it('облачные данные «Помощника» не перевешивает: они зашифрованы ключом исходного аккаунта', () => {
    expect(merge.body).not.toMatch(/update public\.app_points set user_id/);
    expect(merge.body).not.toMatch(/update public\.app_docs set user_id/);
    expect(raw).toContain('HKDF(APP_DATA_KEY, user_id)');
  });
});

// ---------------------------------------------------------------------------------------------
// Общий код: server/_telegram-account.js и server/_telegram-identity.js
// ---------------------------------------------------------------------------------------------

type Call = { method: string; path: string; body: any };
type Reply = { __reply: true; status: number; data: unknown };
const reply = (status: number, data: unknown = {}): Reply => ({ __reply: true, status, data });

function backend(route: (call: Call) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const rawUrl = String(url);
    const path = rawUrl.includes('/rest/v1/') ? rawUrl.split('/rest/v1/')[1] : rawUrl.includes('/auth/v1/') ? `auth:${rawUrl.split('/auth/v1/')[1]}` : rawUrl;
    const call: Call = { method: String(init.method || 'GET').toUpperCase(), path: decodeURIComponent(path), body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const out = route(call);
    const r = out && typeof out === 'object' && (out as Reply).__reply ? (out as Reply) : reply(200, out ?? []);
    return { ok: r.status < 400, status: r.status, headers: new Map(), text: async () => JSON.stringify(r.data), json: async () => r.data } as unknown as Response;
  }));
  return calls;
}

const account = require('../../server/_telegram-account.js') as {
  accountHasValuableData: (userId: string) => Promise<boolean>;
  accountMergeSummary: (userId: string) => Promise<Record<string, unknown> | null>;
};
const identity = require('../../server/_telegram-identity.js') as {
  relinkIdentity: (userId: string, telegram: Record<string, unknown>) => Promise<Record<string, unknown>>;
  mergeTelegramAccount: (userId: string, telegram: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const USER = '0e1a5a6c-1111-2222-3333-444455556666';
const SOURCE = '9f9f9f9f-1111-2222-3333-444455556666';
const TELEGRAM = { id: 777001, username: 'pvz', first_name: 'Аня' };

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('accountHasValuableData', () => {
  it('опирается на сводку базы: бонус или подписка от админа — не пустой аккаунт', async () => {
    const calls = backend((call) => (call.path === 'rpc/account_merge_summary' ? { empty: false, walletKopecks: 2500 } : []));
    await expect(account.accountHasValuableData(USER)).resolves.toBe(true);
    expect(calls.map((c) => c.path)).toEqual(['rpc/account_merge_summary']);
    expect(calls[0].body).toEqual({ p_user: USER });
  });

  it('пустая сводка — пустой аккаунт, старые запросы по таблицам не нужны', async () => {
    const calls = backend((call) => (call.path === 'rpc/account_merge_summary' ? { empty: true } : [{ id: 1 }]));
    await expect(account.accountHasValuableData(USER)).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('до применения миграции (функции нет) считает по-старому', async () => {
    const calls = backend((call) => {
      if (call.path === 'rpc/account_merge_summary') return reply(404, { code: 'PGRST202', message: 'Could not find the function' });
      if (call.path.startsWith('payment_orders?')) return [{ id: 'o1' }];
      return [];
    });
    await expect(account.accountHasValuableData(USER)).resolves.toBe(true);
    expect(calls.some((c) => c.path.startsWith('payment_orders?'))).toBe(true);
    await expect(account.accountMergeSummary(USER)).resolves.toBeNull();
  });

  it('сбой базы не превращается в «аккаунт пустой»', async () => {
    backend(() => reply(500, { code: 'XX000', message: 'boom' }));
    await expect(account.accountHasValuableData(USER)).rejects.toThrow();
  });
});

describe('память сервера после слияния', () => {
  const supabase = require('../../server/_supabase.js') as { supabaseFetch: (path: string, options?: Record<string, unknown>) => Promise<unknown> };
  const deviceCache = require('../../server/_app-device-cache.js') as { clearDevices: () => void; forgetUserData: (userId: string | null) => void };

  it('rpc/merge_telegram_account сбрасывает память ПК и тарифов: они переехали к другому аккаунту', async () => {
    const clear = vi.spyOn(deviceCache, 'clearDevices');
    const forget = vi.spyOn(deviceCache, 'forgetUserData');
    backend(() => ({}));
    await supabase.supabaseFetch('rpc/merge_telegram_account', { method: 'POST', body: '{}' });
    expect(clear).toHaveBeenCalled();
    expect(forget).toHaveBeenCalledWith(null);
  });

  it('ручные лимиты rpc/app_user_override тоже сбрасывают память тарифов (в регулярке был символ backspace вместо \\b)', async () => {
    const forget = vi.spyOn(deviceCache, 'forgetUserData');
    backend(() => ({}));
    await supabase.supabaseFetch('rpc/app_user_override', { method: 'POST', body: '{}' });
    expect(forget).toHaveBeenCalledWith(null);
    expect(readFileSync(resolve(root, 'server/_supabase.js'), 'utf8')).not.toContain('\b');
  });

  it('сводка — только чтение, память не трогает', async () => {
    const clear = vi.spyOn(deviceCache, 'clearDevices');
    const forget = vi.spyOn(deviceCache, 'forgetUserData');
    backend(() => ({ empty: true }));
    await supabase.supabaseFetch('rpc/account_merge_summary', { method: 'POST', body: JSON.stringify({ p_user: USER }) });
    expect(clear).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalledWith(null);
  });
});

describe('relinkIdentity / mergeTelegramAccount в server/_telegram-identity.js', () => {
  it('сайт сам не объединяет и не перепривязывает: это делает поддержка через общий модуль', () => {
    const auth = readFileSync(resolve(root, 'api/auth.js'), 'utf8');
    expect(auth).not.toMatch(/async function (relinkIdentity|mergeTelegramAccount)\b/);
    expect(auth).not.toMatch(/merge_telegram_account|relink_telegram_identity|mergeTelegramAccount|relinkIdentity/);
    const link = readFileSync(resolve(root, 'server/_admin-link.js'), 'utf8');
    expect(link).toContain("require('./_telegram-identity')");
    expect(link).toMatch(/identity\.mergeTelegramAccount\(/);
    expect(link).toMatch(/identity\.relinkIdentity\(/);
  });

  it('текст исключения базы доходит до вызывающего — api/auth.js отвечает по нему 409', async () => {
    backend((call) => (call.path === 'rpc/relink_telegram_identity'
      ? reply(400, { code: 'P0001', message: 'TELEGRAM_ACCOUNT_NOT_EMPTY' })
      : []));
    await expect(identity.relinkIdentity(USER, TELEGRAM)).rejects.toThrow('TELEGRAM_ACCOUNT_NOT_EMPTY');
    backend((call) => (call.path === 'rpc/merge_telegram_account'
      ? reply(400, { code: 'P0001', message: 'MERGE_BUSY: GENERATION_IN_PROGRESS' })
      : []));
    await expect(identity.mergeTelegramAccount(USER, TELEGRAM)).rejects.toThrow(/^MERGE_BUSY/);
  });

  it('перепривязка: сохраняет связку и удаляет пустой технический аккаунт', async () => {
    const calls = backend((call) => {
      if (call.path === 'rpc/relink_telegram_identity') return { sourceUserId: SOURCE, deleteSource: true };
      if (call.path === 'rpc/account_merge_summary') return { empty: true };
      if (call.path.startsWith('user_telegram_identities')) return [{ user_id: USER }];
      return {};
    });
    await expect(identity.relinkIdentity(USER, TELEGRAM)).resolves.toEqual({ sourceUserId: SOURCE, deleteSource: true });
    expect(calls[0].body).toEqual({ p_telegram_user_id: 777001, p_target_user_id: USER });
    const save = calls.find((c) => c.method === 'POST' && c.path.startsWith('user_telegram_identities?on_conflict=telegram_user_id'))!;
    expect(save.body).toMatchObject({ user_id: USER, telegram_user_id: 777001, username: 'pvz' });
    expect(calls.find((c) => c.method === 'DELETE')!.path).toBe(`auth:admin/users/${SOURCE}`);
    // перед удалением — свежая сводка исходного аккаунта
    const check = calls.findIndex((c) => c.path === 'rpc/account_merge_summary');
    expect(calls[check].body).toEqual({ p_user: SOURCE });
    expect(check).toBeLessThan(calls.findIndex((c) => c.method === 'DELETE'));
  });

  it('аккаунт с почтой при перепривязке не удаляется', async () => {
    const calls = backend((call) => (call.path === 'rpc/relink_telegram_identity' ? { sourceUserId: SOURCE, deleteSource: false } : [{}]));
    await identity.relinkIdentity(USER, TELEGRAM);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('объединение отдаёт суммы переноса и удаляет исходный аккаунт; сбой удаления не ломает ответ', async () => {
    const answer = { sourceUserId: SOURCE, deleteSource: true, movedWalletKopecks: 51750, movedSubscriptions: 2, movedDevices: 1 };
    const calls = backend((call) => {
      if (call.path === 'rpc/merge_telegram_account') return answer;
      if (call.path === 'rpc/account_merge_summary') return { empty: true };
      if (call.method === 'DELETE') return reply(500, { msg: 'auth down' });
      return [{}];
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(identity.mergeTelegramAccount(USER, TELEGRAM)).resolves.toEqual(answer);
    expect(calls.find((c) => c.method === 'DELETE')!.path).toBe(`auth:admin/users/${SOURCE}`);
  });

  it('исходный аккаунт, в котором после переноса снова что-то появилось, не удаляется', async () => {
    // Начисление, ждавшее замка счёта во время слияния, заново создаёт счёт исходного аккаунта —
    // удаление унесло бы деньги каскадом.
    const answer = { sourceUserId: SOURCE, deleteSource: true, movedWalletKopecks: 0, movedSubscriptions: 0, movedDevices: 0 };
    const calls = backend((call) => {
      if (call.path === 'rpc/merge_telegram_account') return answer;
      if (call.path === 'rpc/account_merge_summary') return { empty: false, walletKopecks: 5000 };
      return [{}];
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(identity.mergeTelegramAccount(USER, TELEGRAM)).resolves.toEqual({ ...answer, sourceKept: true });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('сбой проверки перед удалением — аккаунт остаётся, перепривязка всё равно успешна', async () => {
    const calls = backend((call) => {
      if (call.path === 'rpc/relink_telegram_identity') return { sourceUserId: SOURCE, deleteSource: true };
      if (call.path === 'rpc/account_merge_summary') return reply(500, { code: 'XX000', message: 'boom' });
      return [{}];
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(identity.relinkIdentity(USER, TELEGRAM)).resolves.toMatchObject({ deleteSource: true, sourceKept: true });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('админка «Связать с Telegram»: отказы объединения', () => {
  it('каждый MERGE_* из миграции — 409 с тем же кодом, а не общий 502', () => {
    const link = require('../../server/_admin-link.js') as {
      rpcRefusal: (error: unknown) => (Error & { status: number; code: string }) | null;
    };
    const codes = [...raw.matchAll(/raise exception '(MERGE_[^']*)'/g)].map((m) => m[1]);
    expect(new Set(codes.map((text) => /\bMERGE_[A-Z_]+/.exec(text)![0])))
      .toEqual(new Set(['MERGE_BUSY', 'MERGE_POINT_CONFLICT', 'MERGE_CLOUD_DATA', 'MERGE_PARTNER_CONFLICT']));
    for (const text of codes) {
      const refusal = link.rpcRefusal(new Error(text));
      expect(refusal, text).not.toBeNull();
      expect(refusal!.status).toBe(409);
      expect(refusal!.code).toBe(/\bMERGE_[A-Z_]+/.exec(text)![0]);
    }
  });
});
