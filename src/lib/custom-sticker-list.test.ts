import { describe, expect, it } from 'vitest';
import { inspectCustomCodes, parseCustomCodes, removeDuplicateCodes } from './custom-sticker-list';

describe('custom sticker list', () => {
  it('parses spaces, lines and tabs', () => {
    expect(parseCustomCodes('11111111111  22222222222\n\t33333333333')).toEqual([
      '11111111111',
      '22222222222',
      '33333333333',
    ]);
  });
  it('marks every duplicate and invalid length', () => {
    expect(inspectCustomCodes(['11111111111', '12', '11111111111'])).toEqual([
      { value: '11111111111', duplicate: true, invalid: false },
      { value: '12', duplicate: false, invalid: true },
      { value: '11111111111', duplicate: true, invalid: false },
    ]);
  });
  it('keeps the first duplicate', () => {
    expect(removeDuplicateCodes(['1', '2', '1', '3', '2'])).toEqual(['1', '2', '3']);
  });
});
