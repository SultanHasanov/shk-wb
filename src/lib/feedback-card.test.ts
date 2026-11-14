import { describe, expect, it } from 'vitest';
import { cardSvg, colorReadable, contrastWithWhite, printDocument, qrFragment, wrapLines, DEFAULT_DESIGN } from './feedback-card';
import { draftKey, readDraft, sameValue, writeDraft, clearDraft } from './feedback-draft';

const text = { place: 'ПВЗ Wildberries', address: 'ул. Ленина, 24', headline: 'Как вам наш пункт?', note: 'Анонимно' };
const URL_ = 'https://shk-wb.ru/o/K7M4PX2Q';

describe('карточка с QR', () => {
  it('QR: матрица с коррекцией H, точки и три «глазка»', () => {
    const qr = qrFragment(URL_, '#000');
    expect(qr.size).toBeGreaterThanOrEqual(29);
    expect(qr.svg.match(/stroke-width="1"/g)).toHaveLength(3);
    expect(qr.svg).toContain('stroke-linecap="round"');
  });

  it('пользовательский текст экранируется — в SVG не пролезет разметка', () => {
    const svg = cardSvg({ ...text, place: '<script>alert(1)</script>', headline: 'A & B "C"' }, DEFAULT_DESIGN, URL_);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('A &amp; B');
  });

  it('у каждой карточки свои id градиентов — несколько на одном листе не конфликтуют', () => {
    const doc = printDocument(text, { ...DEFAULT_DESIGN, format: 'a6' }, URL_);
    const ids = [...doc.matchAll(/id="(fbc\d+)b"/g)].map(m => m[1]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(doc).toContain('size:A4 portrait');
  });

  it('A5 печатается по две на альбомном A4, наклейка — четыре', () => {
    expect(printDocument(text, { ...DEFAULT_DESIGN, format: 'a5' }, URL_)).toContain('size:A4 landscape');
    expect(printDocument(text, { ...DEFAULT_DESIGN, format: 'sticker' }, URL_).match(/class="cell"/g)).toHaveLength(4);
  });

  it('свой цвет: тёмный проходит, светлый — нет (та же граница, что на сервере)', () => {
    expect(colorReadable('#cb11ab')).toBe(true);
    expect(colorReadable('#2b6cb0')).toBe(true);
    expect(colorReadable('#ffd84d')).toBe(false);
    expect(colorReadable('#ffffff')).toBe(false);
    expect(contrastWithWhite('nope')).toBe(0);
  });

  it('перенос строк обрезает лишнее многоточием', () => {
    const lines = wrapLines('Очень длинный заголовок карточки, который точно не поместится в две строки шириной сто', 34, 800, 200, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
  });
});

describe('черновик конструктора', () => {
  it('ключ разделяет аккаунты и QR', () => {
    expect(draftKey('u1', null)).not.toBe(draftKey('u2', null));
    expect(draftKey('u1', 'b1')).not.toBe(draftKey('u1', null));
  });

  it('пишет, читает и чистит', () => {
    const key = draftKey('u-test', null);
    writeDraft(key, { place: 'Ленина' });
    expect(readDraft<{ place: string }>(key)?.value.place).toBe('Ленина');
    clearDraft(key);
    expect(readDraft(key)).toBeNull();
  });

  it('старый черновик (больше 30 дней) выбрасывается', () => {
    const key = draftKey('u-old', null);
    window.localStorage.setItem(key, JSON.stringify({ value: { a: 1 }, savedAt: Date.now() - 31 * 86400000 }));
    expect(readDraft(key)).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('сравнение вложенных значений', () => {
    expect(sameValue({ a: 1, d: { x: '1' } }, { a: 1, d: { x: '1' } })).toBe(true);
    expect(sameValue({ a: 1, d: { x: '1' } }, { a: 1, d: { x: '2' } })).toBe(false);
  });
});
