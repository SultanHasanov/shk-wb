import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  DESIGN_HEIGHT,
  parseThermalSize,
  SIZE_ERROR,
  widthWarning,
} from './thermal-print';

/**
 * Термопечать потеряли при переезде на React, хотя лендинги её обещают. Тест
 * держит разметку страницы печати: именно она определяет, попадёт этикетка в
 * размер рулона или уедет за край.
 */
describe('страница печати этикеток', () => {
  const urls = ['/api/stickers/image?code=1', '/api/stickers/image?code=2'];

  it('задаёт размер страницы под этикетку и по одной на страницу', () => {
    const html = buildDocument(urls, { width: 58, height: 40 }, DESIGN_HEIGHT.product);

    expect(html).toContain('@page{size:58mm 40mm;margin:0}');
    expect(html.match(/class="label"/g)).toHaveLength(2);
    expect(html).toContain('page-break-after:always');
  });

  it('поворачивает книжный стикер на альбомной этикетке', () => {
    const landscape = buildDocument(urls, { width: 58, height: 40 }, DESIGN_HEIGHT.product);
    const portrait = buildDocument(urls, { width: 40, height: 58 }, DESIGN_HEIGHT.product);

    expect(landscape).toContain('rotate(90deg)');
    expect(portrait).not.toContain('rotate(90deg)');
  });

  it('оставляет по миллиметру поля с каждой стороны', () => {
    // Термопринтеры печатают впритык к краю, и картинка в упор обрезается.
    expect(buildDocument(urls, { width: 50, height: 30 }, DESIGN_HEIGHT.box)).toContain(
      'width:28mm;height:48mm',
    );
  });

  it('разворачивает относительные адреса в абсолютные', () => {
    // Документ печатается в отдельном iframe: относительный путь там не резолвится.
    expect(buildDocument(urls, { width: 58, height: 40 }, DESIGN_HEIGHT.product)).toContain(
      `${window.location.origin}/api/stickers/image?code=1`,
    );
  });
});

describe('проверка размера этикетки', () => {
  it('принимает пресет и свой размер с запятой', () => {
    expect(parseThermalSize('58x40', '', '')).toEqual({ width: 58, height: 40 });
    expect(parseThermalSize('custom', '50,5', '30')).toEqual({ width: 50.5, height: 30 });
  });

  it('отбивает размеры за пределами возможностей термопринтеров', () => {
    expect(parseThermalSize('custom', '5', '30')).toEqual({ error: SIZE_ERROR });
    expect(parseThermalSize('custom', '200', '30')).toEqual({ error: SIZE_ERROR });
    expect(parseThermalSize('custom', 'абв', '30')).toEqual({ error: SIZE_ERROR });
  });

  it('предупреждает, когда этикетка шире печатающей головки', () => {
    // TDP-225 печатает до 52 мм: 58 мм уедут за край, и человек потратит рулон.
    expect(widthWarning({ width: 58, height: 40 }, 'tdp225')).toContain('52 мм');
    expect(widthWarning({ width: 50, height: 30 }, 'tdp225')).toBe('');
    expect(widthWarning({ width: 100, height: 75 }, 'other')).toBe('');
  });
});
