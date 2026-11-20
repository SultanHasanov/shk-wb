import { describe, expect, it } from 'vitest';
import { isValidBoxPrefix, splitBoxInput } from './box-prefix';

describe('box prefix input', () => {
  it('keeps an ordinary prefix as is', () => {
    expect(splitBoxInput('trbx')).toEqual({ prefix: 'TRBX', digits: '' });
    expect(splitBoxInput('TRBX4080')).toEqual({ prefix: 'TRBX4080', digits: '' });
  });

  it('splits a whole box number typed into the prefix field', () => {
    expect(splitBoxInput('TRBX4080972201')).toEqual({ prefix: 'TRBX', digits: '4080972201' });
    expect(splitBoxInput(' trbx 5084-472379 ')).toEqual({ prefix: 'TRBX5084-', digits: '472379' });
  });

  it('treats bare digits as the number, not the prefix', () => {
    expect(splitBoxInput('5084472379')).toEqual({ prefix: '', digits: '5084472379' });
  });

  it('never produces a prefix the server would reject', () => {
    for (const raw of ['TRBX408097220', 'ABCDEFGHIJKLMNOP', 'тест!TRBX', 'TR BX']) {
      const { prefix } = splitBoxInput(raw);
      expect(prefix.length).toBeLessThanOrEqual(12);
      if (prefix) expect(isValidBoxPrefix(prefix)).toBe(true);
    }
  });
});
