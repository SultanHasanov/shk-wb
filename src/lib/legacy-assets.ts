type ReadableStorage = Pick<Storage, 'getItem'>;

const STICKER_CODE_KEYS = [
  'sticker_product_access_code',
  'sticker_box_access_code',
  'sticker_access_code',
] as const;

function storedValue(storage: ReadableStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function legacyStickerCodes(storage: ReadableStorage): string[] {
  const candidates = STICKER_CODE_KEYS.map(key => storedValue(storage, key));
  const savedPackage = storedValue(storage, 'sticker_purchased_package');

  if (savedPackage) {
    try {
      const parsed: unknown = JSON.parse(savedPackage);
      if (parsed && typeof parsed === 'object' && 'code' in parsed) {
        candidates.push(String((parsed as { code?: unknown }).code ?? ''));
      }
    } catch {
      // A malformed legacy package must not prevent the direct codes from being claimed.
    }
  }

  return [...new Set(candidates.map(value => String(value ?? '').trim().toUpperCase()).filter(value => /^(?:\d{6}|STK-[A-F0-9]{32})$/.test(value)))];
}
