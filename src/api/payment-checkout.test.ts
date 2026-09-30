import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('payment checkout reliability', () => {
  it('reuses a recent pending checkout for the same signed-in customer', () => {
    const source = read('api/payments.js');
    expect(source).toContain('Date.now() - 55 * 60 * 1000');
    expect(source).toContain('&status=eq.pending');
    expect(source).toContain('reused: true');
  });

  it('includes the issued access code in email and Telegram notifications', () => {
    const source = read('server/_payments.js');
    expect(source).toContain("const secret=order.access_code||order.program_license_key||order.cell_print_license_key");
    expect(source).toContain('Код доступа: <code>${order.access_code}</code>');
    expect(read('src/components/PricingPacks.tsx')).toContain('После оплаты отправим сюда код доступа.');
  });
});
