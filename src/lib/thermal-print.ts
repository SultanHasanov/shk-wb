/**
 * Печать этикеток по одной на термопринтере.
 *
 * Порт printOnThermalPrinter из js/app.js: при переезде на React термопечать
 * не перенесли вовсе, хотя лендинги её обещают. Серверная часть не нужна —
 * печатаются те же картинки /api/stickers/image, что уже приходят в ответе
 * генератора.
 *
 * Отличие от оригинала одно: документ рендерится в скрытый iframe, а печатью
 * управляет родитель. Старый код открывал попап и дописывал туда
 * <script>window.print()</script>, но попап наследует CSP открывшей страницы, а
 * там нет 'unsafe-inline' для скриптов — автопечать молча не срабатывала.
 * Заодно исчезает блокировщик всплывающих окон.
 */
export const THERMAL_SIZES = [
  { value: '40x30', label: '40 × 30 мм' },
  { value: '50x30', label: '50 × 30 мм' },
  { value: '50x40', label: '50 × 40 мм' },
  { value: '58x40', label: '58 × 40 мм' },
  { value: '75x58', label: '75 × 58 мм' },
  { value: '100x75', label: '100 × 75 мм' },
  { value: 'custom', label: 'Свой размер' },
] as const;

export type ThermalSizeValue = (typeof THERMAL_SIZES)[number]['value'];

/** Предел ширины печати у популярных моделей, мм. 0 — не проверяем. */
export const PRINTER_MODELS = [
  { value: 'tdp225', label: 'TSC TDP-225 — до 52 мм', limit: 52 },
  { value: 'te200', label: 'TSC TE200 — до 108 мм', limit: 108 },
  { value: 'other', label: 'Другой принтер', limit: 0 },
] as const;

export type PrinterModelValue = (typeof PRINTER_MODELS)[number]['value'];

/** Пропорции макета стикера — те же, по которым рисует api/stickers/pdf.js. */
const DESIGN_WIDTH = 600;
export const DESIGN_HEIGHT = { product: 740, box: 900 } as const;

export type ThermalSize = { width: number; height: number };

const MIN_WIDTH = 15;
const MAX_WIDTH = 112;
const MIN_HEIGHT = 10;
const MAX_HEIGHT = 300;

export const SIZE_ERROR = `Укажите ширину ${MIN_WIDTH}–${MAX_WIDTH} мм и высоту ${MIN_HEIGHT}–${MAX_HEIGHT} мм.`;

/** Запятая как разделитель: на русской раскладке её набирают чаще точки. */
function parseDecimal(value: string): number {
  return Number(String(value).replace(',', '.'));
}

export function parseThermalSize(
  value: ThermalSizeValue,
  customWidth: string,
  customHeight: string,
): ThermalSize | { error: string } {
  const preset = value === 'custom' ? null : value.split('x');
  const width = preset ? Number(preset[0]) : parseDecimal(customWidth);
  const height = preset ? Number(preset[1]) : parseDecimal(customHeight);

  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < MIN_WIDTH ||
    width > MAX_WIDTH ||
    height < MIN_HEIGHT ||
    height > MAX_HEIGHT
  ) {
    return { error: SIZE_ERROR };
  }
  return { width, height };
}

export function widthWarning(size: ThermalSize, model: PrinterModelValue): string {
  const limit = PRINTER_MODELS.find(item => item.value === model)?.limit ?? 0;
  if (!limit || size.width <= limit) return '';
  return `Ширина этикетки ${size.width} мм превышает предел этой модели (${limit} мм). Выберите меньший размер.`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Экспортируется ради теста: печать проверить в jsdom нельзя, разметку — можно. */
export function buildDocument(
  imageUrls: readonly string[],
  size: ThermalSize,
  designHeight: number,
) {
  const designRatio = DESIGN_WIDTH / designHeight;
  const pageRatio = size.width / size.height;
  // Повернуть, если пропорции этикетки ближе к перевёрнутому стикеру, чем к
  // прямому: альбомная этикетка под книжный стикер и наоборот.
  const rotate =
    Math.abs(Math.log(pageRatio / (1 / designRatio))) < Math.abs(Math.log(pageRatio / designRatio));
  const imageWidth = rotate ? size.height : size.width;
  const imageHeight = rotate ? size.width : size.height;
  // Миллиметр поля с каждой стороны: термопринтеры печатают впритык к краю.
  const safeWidth = Math.max(1, imageWidth - 2);
  const safeHeight = Math.max(1, imageHeight - 2);

  const labels = imageUrls
    .map(
      url =>
        `<section class="label"><img src="${escapeAttribute(new URL(url, window.location.href).href)}" alt="Этикетка"></section>`,
    )
    .join('');

  const style =
    `@page{size:${size.width}mm ${size.height}mm;margin:0}` +
    '*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}' +
    `.label{position:relative;width:${size.width}mm;height:${size.height}mm;overflow:hidden;break-after:page;page-break-after:always}` +
    '.label:last-child{break-after:auto;page-break-after:auto}' +
    `.label img{position:absolute;left:50%;top:50%;width:${safeWidth}mm;height:${safeHeight}mm;object-fit:contain;transform:translate(-50%,-50%)${rotate ? ' rotate(90deg)' : ''};transform-origin:center}`;

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Печать этикеток ${size.width} × ${size.height} мм</title><style>${style}</style></head><body>${labels}</body></html>`;
}

/** Печать пачки этикеток. Резолвится, когда окно печати уже вызвано. */
export async function printLabels(
  imageUrls: readonly string[],
  size: ThermalSize,
  designHeight: number,
): Promise<void> {
  if (!imageUrls.length) return;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(iframe);

  const remove = () => iframe.remove();
  try {
    const frameDocument = iframe.contentDocument;
    const frameWindow = iframe.contentWindow;
    if (!frameDocument || !frameWindow) throw new Error('Не удалось подготовить окно печати.');

    frameDocument.open();
    frameDocument.write(buildDocument(imageUrls, size, designHeight));
    frameDocument.close();

    // Печать до загрузки картинок выдала бы пустые этикетки.
    await Promise.all(
      Array.from(frameDocument.images).map(
        image =>
          new Promise<void>(resolve => {
            if (image.complete) return resolve();
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => resolve(), { once: true });
          }),
      ),
    );

    // Окно печати блокирующее не во всех браузерах, поэтому убираем iframe по
    // afterprint, а таймер оставляем на случай, если событие не придёт.
    frameWindow.addEventListener('afterprint', remove, { once: true });
    setTimeout(remove, 60000);

    frameWindow.focus();
    frameWindow.print();
  } catch (error) {
    remove();
    throw error;
  }
}
