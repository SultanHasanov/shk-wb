// @vitest-environment node
// tesseract.js в jsdom решает, что он в браузере, — распознавание проверяем в чистом Node, как на сервере.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const vision = require('../../server/_shk-vision.js') as {
  MAX_IMAGE_BYTES: number;
  extractShkCodes: (text: string, length?: number) => string[];
  imageOf: (message: Record<string, unknown>) => { fileId: string; mime: string } | null;
  recognizeShk: (buffer: Buffer, options?: { length?: number }) => Promise<string[]>;
  stopWorker: () => Promise<void>;
};

const fixture = (name: string) => readFileSync(path.resolve(process.cwd(), 'src/test/fixtures', name));

describe('ШК с фото: разбор сообщения и текста', () => {
  it('берёт самое крупное фото или документ-картинку до 10 МБ', () => {
    expect(vision.imageOf({ photo: [{ file_id: 'small' }, { file_id: 'big' }] })).toEqual({ fileId: 'big', mime: 'image/jpeg' });
    expect(vision.imageOf({ document: { file_id: 'doc', mime_type: 'image/png', file_size: 1000 } })).toEqual({ fileId: 'doc', mime: 'image/png' });
    expect(vision.imageOf({ document: { file_id: 'doc', mime_type: 'image/png', file_size: vision.MAX_IMAGE_BYTES + 1 } })).toBeNull();
    expect(vision.imageOf({ document: { file_id: 'doc', mime_type: 'application/pdf', file_size: 1000 } })).toBeNull();
    expect(vision.imageOf({ text: '12345678901' })).toBeNull();
  });

  it('склеивает «7 + 4» из WB-PVZ и отбрасывает лишний «0» от значка копирования', () => {
    expect(vision.extractShkCodes('4894976 8172')).toEqual(['48949768172']);
    expect(vision.extractShkCodes('4894976 81720\n0500093228775 200008')).toEqual(['48949768172']);
  });

  it('не принимает за ШК баркод, номер ПВЗ, цены, даты, ячейку и версию', () => {
    expect(vision.extractShkCodes('0500093228775\n50160457\n1195\n04112026 8 134025\n71\n3630\n1996')).toEqual([]);
  });

  it('находит несколько ШК по порядку и убирает повторы', () => {
    expect(vision.extractShkCodes('1 47671114039\n05112026 1610\n58899100266\n47671114039')).toEqual(['47671114039', '58899100266']);
  });

  it('для коробок ищет 10 цифр', () => {
    expect(vision.extractShkCodes('ШК 47671114039\n1234567890', 10)).toEqual(['1234567890']);
  });
});

// Реальные примеры, ужатые до 1280 px — как Telegram отдаёт картинку, присланную «как фото».
describe('ШК с фото: распознавание реальных скриншотов', () => {
  afterAll(() => vision.stopWorker());

  it.each([
    ['shk-photo-1.jpg', ['48949768172']], // фото экрана ноутбука, WB-PVZ «Возврат»
    ['shk-photo-2.jpg', ['51665299516']],
    ['shk-shot-3.jpg', ['56723666592']], // WB Point «Подмена»
    ['shk-shot-4.jpg', ['47671114039', '58899100266']], // «Зависшие ШК», два номера
    ['shk-shot-5.jpg', ['47671114039']], // карточка ШК, номер дважды
  ])('%s', async (name, expected) => {
    expect(await vision.recognizeShk(fixture(name))).toEqual(expected);
  }, 90_000);
});
