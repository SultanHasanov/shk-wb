import { describe, expect, it } from 'vitest';
import { wbBasket, wbImageUrls } from './wb-image';

describe('фото товара WB по артикулу', () => {
  it('выбирает сервер по таблице WB', () => {
    expect(wbBasket(12_345_678)).toBe(1); // vol 123
    expect(wbBasket(14_400_000)).toBe(2); // vol 144 — первая граница
    expect(wbBasket(377_869_894)).toBe(22); // vol 3778
    expect(wbBasket(550_375_444)).toBe(29); // vol 5503
    expect(wbBasket(3_341_300_000)).toBe(71); // vol 33413 — конец таблицы
    expect(wbBasket(3_341_400_000)).toBe(72); // за таблицей — следующий сервер
  });

  it('первым идёт расчётный адрес, дальше соседние серверы', () => {
    const urls = wbImageUrls(377_869_894);
    expect(urls[0]).toBe('https://basket-22.wbbasket.ru/vol3778/part377869/377869894/images/c246x328/1.webp');
    expect(urls.slice(1).map(u => u.slice(15, 17))).toEqual(['23', '21', '24']);
    expect(wbImageUrls(0)).toEqual([]);
  });
});
