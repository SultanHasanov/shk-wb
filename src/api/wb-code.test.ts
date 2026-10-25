import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type WbCode = {
  clientCode: (sid: string, date?: Date) => number;
  qrFromCode: (sid: string, code: number) => { code: number; qrText: string };
  buildClientQr: (sid: string, date?: Date) => { code: number; qrText: string };
  isClientQrText: (text: string) => boolean;
};
type WbCrack = {
  crackMd5: (sid: string, hashes: string[]) => number | null;
  crackClientQr: (sid: string, hashes: string[]) => { code: number; qrText: string } | null;
};

const code = require('../../server/_wb-code.js') as WbCode;
const crack = require('../../server/_wb-crack.js') as WbCrack;

const QR_RE = /^\d+_\d{5}_\d{6}_1$/;

describe('_wb-code', () => {
  it('формула sdbm детерминирована и в диапазоне 0..99999', () => {
    const sid = '191607973';
    const c = code.clientCode(sid);
    expect(c).toBe(code.clientCode(sid));
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThan(100000);
  });

  it('buildClientQr даёт код из формулы и валидный формат QR', () => {
    const q = code.buildClientQr('191607973');
    expect(q.code).toBe(code.clientCode('191607973'));
    expect(QR_RE.test(q.qrText)).toBe(true);
    expect(code.isClientQrText(q.qrText)).toBe(true);
    expect(q.qrText.split('_')[1]).toBe(String(q.code).padStart(5, '0'));
  });
});

describe('_wb-crack (резерв по MD5-хешам)', () => {
  // WB хранит md5(sid_байты ++ код5); порт cracker::find_code_md5.
  const md5For = (sid: string, n: number) =>
    createHash('md5').update(Buffer.from(sid, 'utf8')).update(String(n).padStart(5, '0'), 'utf8').digest('hex');

  it('находит код по совпадающему хешу', () => {
    const sid = '187364521';
    expect(crack.crackMd5(sid, ['deadbeef'.repeat(4), md5For(sid, 4217)])).toBe(4217);
  });

  it('возвращает null, когда совпадений нет или хешей нет', () => {
    expect(crack.crackMd5('187364521', ['a'.repeat(32)])).toBeNull();
    expect(crack.crackMd5('187364521', [])).toBeNull();
    expect(crack.crackMd5('187364521', ['не-hex'])).toBeNull();
  });

  it('crackClientQr собирает валидный QR с подобранным кодом', () => {
    const sid = '187364521';
    const q = crack.crackClientQr(sid, [md5For(sid, 777)]);
    expect(q).not.toBeNull();
    expect(q!.code).toBe(777);
    expect(QR_RE.test(q!.qrText)).toBe(true);
    expect(q!.qrText.split('_')[1]).toBe('00777');
  });
});
