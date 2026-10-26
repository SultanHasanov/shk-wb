import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const stickers = require('../../server/_stickers.js') as {
  code128Bars: (value: string) => { bars: Array<{module: number; width: number}>; modules: number };
  code128Values: (value: string) => number[];
  encodeWbPayload: (value: string) => string;
  newStickerDesign: (value: string) => Record<string, any>;
  newStickerSvg: (value: string) => Promise<string>;
};
const pdf = require('../../api/stickers/pdf.js') as {
  buildStickerPdf: (rows: Array<{code: string}>, options: Record<string, unknown>) => Promise<Buffer>;
};

describe('Telegram product sticker formats', () => {
  it('builds a compact valid Code 128 sequence for the same product number', () => {
    const value = '56541543944';
    const symbols = stickers.code128Values(value);
    const data = [value.charCodeAt(0) - 32, 99, ...value.slice(1).match(/\d{2}/g)!.map(Number)];
    const expectedChecksum = (104 + data.reduce((sum, symbol, index) => sum + symbol * (index + 1), 0)) % 103;
    expect(symbols).toEqual([104, ...data, expectedChecksum, 106]);
    const barcode = stickers.code128Bars(value);
    expect(barcode.modules).toBeGreaterThan(100);
    expect(barcode.bars.every(bar => bar.width > 0)).toBe(true);
  });

  it('uses the current WB payload in the new label and keeps both number parts', async () => {
    const value = '56541543944';
    const design = stickers.newStickerDesign(value);
    expect(design.payload).toBe(stickers.encodeWbPayload(value));
    expect(design.codeParts).toEqual(['5654154', '3944']);
    expect(design.corners).toHaveLength(3);
    const svg = await stickers.newStickerSvg(value);
    expect(svg).toContain('5654154');
    expect(svg).toContain('3944');
    expect(svg).toContain('width="1200" height="1200"');
  });

  it('creates old and new PDFs from the same allocated numbers', async () => {
    const rows = [{ code: '56541543944' }, { code: '56541543945' }];
    const [oldPdf, newPdf] = await Promise.all([
      pdf.buildStickerPdf(rows, { style: 'old' }),
      pdf.buildStickerPdf(rows, { style: 'new' }),
    ]);
    expect(oldPdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(newPdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(oldPdf.length).toBeGreaterThan(1000);
    expect(newPdf.length).toBeGreaterThan(1000);
    expect(newPdf.equals(oldPdf)).toBe(false);
  });
});
