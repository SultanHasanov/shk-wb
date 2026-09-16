import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/**
 * Миграции здесь накатываются руками в SQL-редакторе, автотестом их не прогнать.
 * Этот спек — единственный сторож: он сверяет, что в файле остались решения, на
 * которых держится общий пул, и что старые счётчики никто не начал писать снова.
 */
describe('единый пул генераций', () => {
  const migration = read('supabase/migrations/20260905_unified_generation_pool.sql');
  const generate = read('api/stickers/generate.js');
  const generationService = read('server/_sticker-generation.js');
  const payments = read('api/payments.js');

  it('складывает четыре старых счётчика в один', () => {
    expect(migration).toContain('add column generation_limit');
    expect(migration).toContain('add column generation_used');
    expect(migration).toContain('range_generation_used  + custom_generation_used');
    expect(migration).toContain('box_range_generation_used  + box_custom_generation_used');
    // Повторная вставка файла в редактор не должна удваивать лимиты.
    expect(migration).toContain('20260905_unified_generation_pool has already been applied');
    expect(migration).toContain('where generation_limit = 0 and generation_used = 0');
    expect(migration).toContain('drop constraint if exists sticker_access_codes_code_check');
    expect(migration).toContain("code ~ '^([0-9]{6}|STK-[A-F0-9]{32})$'");
    expect(migration).toContain('set search_path = public, extensions');
  });

  it('списывает из общего счётчика во всех четырёх режимах', () => {
    expect(migration.match(/set generation_used = a\.generation_used \+ p_quantity/g)).toHaveLength(
      2,
    );
    expect(migration.match(/set generation_used = a\.generation_used \+ 1/g)).toHaveLength(2);
    expect(migration.match(/raise exception 'Access code limit exceeded'/g)).toHaveLength(4);
  });

  it('замораживает старые колонки', () => {
    expect(migration).not.toContain('box_range_generation_used =');
    expect(migration).not.toContain('box_custom_generation_used =');
    expect(migration).not.toContain('range_usage_mode =');
    expect(generate).not.toContain('box_range_generation_limit');
  });

  it('отменяет бесплатную первую генерацию', () => {
    const removal = read('supabase/migrations/20260915_remove_free_generation.sql');
    // Все четыре аллокатора требуют код доступа до всякой работы.
    expect(
      removal.match(/if normalized(_access(_code)?)? is null then raise exception 'Sticker access code required'/g),
    ).toHaveLength(4);
    // Признак бесплатной ветки — подсчёт партий с access_code is null — исчез.
    expect(removal).not.toContain('used_free');
    expect(removal).not.toContain('b.access_code is null');
    // Колонка free_remaining ушла из результата, поэтому функции пересозданы.
    expect(removal).not.toContain('free_remaining integer');
    expect(removal.match(/^drop function if exists/gm)).toHaveLength(4);
    expect(generationService).not.toContain('freeRemaining');
  });

  it('пополняет существующий код вместо выдачи нового', () => {
    expect(migration).toContain('generation_limit = generation_limit + units');
    expect(migration).toContain('drop constraint if exists payment_orders_access_code_key');
    expect(migration).toContain(
      "product_kind in ('program_license', 'cell_print_license', 'stickers')",
    );
    // Маркер исполнения: повторный webhook не должен начислить дважды.
    expect(migration).toContain(
      'if order_row.access_code is not null then return order_row.access_code',
    );
    expect(payments).toContain('Активный код для пополнения не найден');
  });

  it('отдаёт клиенту один остаток', () => {
    expect(generationService).toContain('select=generation_limit,generation_used');
    expect(generationService).toContain('remaining: Math.max(0, total - used)');
  });

  it('не позволяет применять привязанный код без аккаунта владельца', () => {
    expect(generate).toContain('assertAccessOwner(accessCode');
    expect(generationService).toContain("select=owner_user_id");
    expect(generationService).toContain('ACCESS_CODE_OWNER_REQUIRED');
  });
});
