import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('покупка QR-генерации без авторизации', () => {
  it('фиксирует на сервере режим, количество и цену', () => {
    const payments = read('api/payments.js');
    expect(payments).toContain("['custom', 'batch'].includes(guestGenerationMode)");
    expect(payments).toContain("guestGenerationMode === 'batch' ? 50 : 1");
    expect(payments).toContain("guestGenerationMode === 'batch' ? 20 : 7.5");
  });

  it('разрешает гостю генерацию только по выданному коду доступа', () => {
    const generate = read('api/stickers/generate.js');
    expect(generate).toContain("const accessCode = String(req.body?.accessCode || '')");
    expect(generate).toContain("else if (!accessCode)");
    expect(generate).toContain('accessCode: user ? null : accessCode');
  });

  it('показывает гостю поле для купленного кода', () => {
    const page = read('src/pages/GeneratorPage.tsx');
    expect(page).toContain("!auth.isAuthenticated && <Field label={t('Код доступа'");
    expect(page).not.toContain('false && !bulkCustomMode');
  });
});
