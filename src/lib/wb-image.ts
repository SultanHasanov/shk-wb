/**
 * Фото товара WB по артикулу (nm): https://basket-NN.wbbasket.ru/vol{nm/100000}/part{nm/1000}/{nm}/images/c246x328/1.webp.
 * Номер сервера NN зависит от vol. Границы — из таблицы baskets_list самой программы WB (снята 21.11.2026, серверы
 * 01–71): BASKET_MAX_VOL[i] — последний vol сервера i+1. WB добавляет серверы по мере роста артикулов, поэтому за
 * таблицей шаг продолжается (768 vol на сервер), а картинка при ошибке пробует соседние серверы (wbImageUrls).
 */
const BASKET_MAX_VOL = [
  143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601, 1655, 1919, 2045, 2189, 2405, 2621, 2837, 3053, 3269, 3485,
  3701, 3917, 4133, 4349, 4565, 4877, 5189, 5501, 5813, 6125, 6437, 6749, 7061, 7373, 7685, 7997, 8309, 8741, 9173, 9605,
  10373, 11141, 11909, 12677, 13445, 14213, 14981, 15749, 16517, 17285, 18053, 18821, 19589, 20357, 21125, 21893, 22661,
  23429, 24197, 24965, 25733, 26501, 27269, 28037, 28805, 29573, 30341, 31109, 31877, 32645, 33413,
];
const STEP_AFTER_TABLE = 768;

export function wbBasket(nm: number): number {
  const vol = Math.floor(nm / 100_000);
  const index = BASKET_MAX_VOL.findIndex(max => vol <= max);
  if (index >= 0) return index + 1;
  const last = BASKET_MAX_VOL[BASKET_MAX_VOL.length - 1];
  return BASKET_MAX_VOL.length + Math.ceil((vol - last) / STEP_AFTER_TABLE);
}

function urlFor(nm: number, basket: number) {
  const host = String(basket).padStart(2, '0');
  return `https://basket-${host}.wbbasket.ru/vol${Math.floor(nm / 100_000)}/part${Math.floor(nm / 1000)}/${nm}/images/c246x328/1.webp`;
}

/** Адреса фото по убыванию вероятности: расчётный сервер, затем соседние (таблица могла сдвинуться). */
export function wbImageUrls(nm: number): string[] {
  if (!Number.isSafeInteger(nm) || nm <= 0) return [];
  const base = wbBasket(nm);
  return [base, base + 1, base - 1, base + 2].filter(n => n >= 1).map(n => urlFor(nm, n));
}
