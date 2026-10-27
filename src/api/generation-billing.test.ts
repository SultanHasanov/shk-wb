import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const billing = require('../../server/_generation-billing.js') as {
  BATCH_QUANTITY: number;
  GENERATION_PRICES: { custom: number; batch: number };
  GENERATION_DISCOUNT_PRICES: { custom: number; batch: number };
};
const generateApi = readFileSync(resolve(process.cwd(), 'api/stickers/generate.js'), 'utf8');
const generationService = readFileSync(resolve(process.cwd(), 'server/_sticker-generation.js'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261101_generation_wallet_tariffs.sql'), 'utf8');

describe('оплата новых генераций', () => {
  it('фиксирует обычные цены и разовую скидку 20%', () => {
    expect(billing.GENERATION_PRICES).toEqual({ custom: 750, batch: 2000 });
    expect(billing.GENERATION_DISCOUNT_PRICES).toEqual({ custom: 600, batch: 1600 });
    expect(billing.BATCH_QUANTITY).toBe(50);
  });

  it('принимает только пачку ровно из 50 кодов', () => {
    expect(generateApi).toContain('Number(req.body?.quantity) !== BATCH_QUANTITY');
    expect(generationService).toContain("quantity !== 50");
    expect(migration).toContain("mode='batch' and quantity=50");
  });

  it('защищает списание от повторов и параллельной генерации', () => {
    expect(migration).toContain('unique(user_id, request_key)');
    expect(migration).toContain('sticker_generation_one_reserved_idx');
    expect(migration).toContain("pg_advisory_xact_lock(hashtext('sticker-generation:'||p_user::text))");
    expect(migration).toContain("'generation-refund:'||c.id::text");
  });

  it('конвертирует оплаченный остаток пропорционально и выдаёт скидку только при остатке больше половины', () => {
    expect(migration).toContain('round(paid::numeric*remaining/bought)');
    expect(migration).toContain('r.large and r.remaining*2>r.bought');
    expect(migration).toContain("'legacy-stickers-conversion:'||r.user_id::text");
  });
});
