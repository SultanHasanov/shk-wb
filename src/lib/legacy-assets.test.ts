import { describe, expect, it } from 'vitest';
import { legacyStickerCodes } from './legacy-assets';

function storage(values: Record<string, string>): Pick<Storage, 'getItem'> {
  return { getItem: key => values[key] ?? null };
}

describe('импорт старых пакетов из браузера', () => {
  it('собирает и дедуплицирует шестизначные коды', () => {
    expect(legacyStickerCodes(storage({
      sticker_access_code: '123456',
      sticker_product_access_code: '123456',
      sticker_box_access_code: '654321',
    }))).toEqual(['123456', '654321']);
  });

  it('читает код из сведений о старой покупке', () => {
    expect(legacyStickerCodes(storage({
      sticker_purchased_package: JSON.stringify({ code: '481902', target: 'product' }),
    }))).toEqual(['481902']);
  });

  it('отбрасывает повреждённые и произвольные значения', () => {
    expect(legacyStickerCodes(storage({
      sticker_access_code: 'https://example.com',
      sticker_product_access_code: '12345',
      sticker_purchased_package: '{broken',
    }))).toEqual([]);
  });
});
