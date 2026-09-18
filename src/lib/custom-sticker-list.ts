export type CustomCodeItem = { value: string; duplicate: boolean; invalid: boolean };

export function parseCustomCodes(value: string): string[] {
  return value.trim() ? value.trim().split(/\s+/) : [];
}

export function inspectCustomCodes(codes: string[]): CustomCodeItem[] {
  const counts = new Map<string, number>();
  codes.forEach(code => counts.set(code, (counts.get(code) || 0) + 1));
  return codes.map(value => ({
    value,
    duplicate: (counts.get(value) || 0) > 1,
    invalid: !/^\d{11}$/.test(value),
  }));
}

export function removeDuplicateCodes(codes: string[]): string[] {
  const seen = new Set<string>();
  return codes.filter(code => !seen.has(code) && Boolean(seen.add(code)));
}
