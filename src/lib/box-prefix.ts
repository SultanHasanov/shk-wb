/** Префикс номера коробки — те же правила, что на сервере (server/_sticker-generation.js normalizePrefix). */
export const BOX_PREFIX_MAX = 12;

export function isValidBoxPrefix(value: string): boolean {
  return /^[A-Z0-9_-]{1,12}$/.test(value);
}

/**
 * Разбор того, что ввели в «Префикс» или «Номер коробки». Люди путают поля и вписывают
 * в префикс весь номер (TRBX4080972201) — раньше это давало «Invalid box sticker» и 502.
 * Буквы спереди остаются префиксом, хвост из 5+ цифр считается номером коробки.
 */
export function splitBoxInput(raw: string): { prefix: string; digits: string } {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const m = clean.match(/^(.*?[A-Z_-])(\d{5,})$/) ?? clean.match(/^()(\d{5,})$/);
  if (m) return { prefix: m[1].slice(0, BOX_PREFIX_MAX), digits: m[2] };
  return { prefix: clean.slice(0, BOX_PREFIX_MAX), digits: '' };
}
