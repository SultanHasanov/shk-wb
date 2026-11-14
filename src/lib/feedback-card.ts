// Карточка с QR-кодом для отзывов клиентов (кабинет → «Отзывы клиентов»).
// Одна SVG-вёрстка на всё: превью в кабинете, печать (скрытый iframe, как printLabels в thermal-print.ts)
// и PNG (SVG → canvas). QR рисуем сами из матрицы пакета qrcode: скруглённые точки, мягкие «глазки»,
// градиент и звезда в центре — коррекция H выдерживает закрытый центр.
import QRCode from 'qrcode';

export type FeedbackTheme = 'fuchsia' | 'lilac' | 'coral' | 'graphite' | 'light' | 'custom';
export type FeedbackFormat = 'a5' | 'a6' | 'sticker';
export type FeedbackDesign = { format: FeedbackFormat; theme: FeedbackTheme; color: string };
export type CardText = { place: string; address: string; headline: string; note: string };

export const DEFAULT_HEADLINE = 'Как вам наш пункт?';
export const DEFAULT_NOTE = 'Наведите камеру телефона — это анонимно и займёт минуту';
export const DEFAULT_DESIGN: FeedbackDesign = { format: 'a5', theme: 'fuchsia', color: '#cb11ab' };

type Palette = { bg: [string, string]; ink: string; sub: string; chip: string; blob: string; fg: string; fg2: string; border?: string };

const PALETTES: Record<Exclude<FeedbackTheme, 'custom'>, Palette> = {
  fuchsia: { bg: ['#d316b2', '#8f17c9'], ink: '#ffffff', sub: 'rgba(255,255,255,0.88)', chip: 'rgba(255,255,255,0.18)', blob: 'rgba(255,255,255,0.10)', fg: '#cb11ab', fg2: '#7a1fd6' },
  lilac: { bg: ['#7b3fe4', '#b14ef0'], ink: '#ffffff', sub: 'rgba(255,255,255,0.9)', chip: 'rgba(255,255,255,0.18)', blob: 'rgba(255,255,255,0.10)', fg: '#5b23c9', fg2: '#a23be8' },
  coral: { bg: ['#ff5a6e', '#cb11ab'], ink: '#ffffff', sub: 'rgba(255,255,255,0.92)', chip: 'rgba(255,255,255,0.2)', blob: 'rgba(255,255,255,0.12)', fg: '#d81b5a', fg2: '#a30d89' },
  graphite: { bg: ['#262236', '#15121f'], ink: '#ffffff', sub: '#c9c4d8', chip: 'rgba(203,17,171,0.32)', blob: 'rgba(203,17,171,0.16)', fg: '#1d1a29', fg2: '#5a2a7a' },
  light: { bg: ['#ffffff', '#ffffff'], ink: '#1d1a29', sub: '#5f5a72', chip: '#f6e6f3', blob: 'rgba(203,17,171,0.07)', fg: '#cb11ab', fg2: '#7a1fd6', border: '#e6e2ee' },
};

export const THEME_OPTIONS: ReadonlyArray<{ value: Exclude<FeedbackTheme, 'custom'>; label: string }> = [
  { value: 'fuchsia', label: 'Фуксия' },
  { value: 'lilac', label: 'Сирень' },
  { value: 'coral', label: 'Коралл' },
  { value: 'graphite', label: 'Графит' },
  { value: 'light', label: 'Светлая' },
];

export const FORMAT_OPTIONS: ReadonlyArray<{ value: FeedbackFormat; label: string; hint: string; sheet: string }> = [
  { value: 'a5', label: 'A5', hint: 'на дверь', sheet: '2 карточки на листе A4' },
  { value: 'a6', label: 'A6', hint: 'на стол', sheet: '4 карточки на листе A4' },
  { value: 'sticker', label: 'Наклейка', hint: '10 × 10 см', sheet: '4 наклейки на листе A4' },
];

// ── цвет ──

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

function mix(hex: string, target: [number, number, number], amount: number) {
  const rgb = parseHex(hex) ?? [203, 17, 171];
  return toHex([0, 1, 2].map(i => rgb[i] + (target[i] - rgb[i]) * amount) as [number, number, number]);
}

/** Контраст с белым (WCAG) — та же формула, что на сервере (server/_feedback.js). */
export function contrastWithWhite(hex: string) {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}
export const MIN_CONTRAST = 3;
export const colorReadable = (hex: string) => contrastWithWhite(hex) >= MIN_CONTRAST;

export function palette(design: FeedbackDesign): Palette {
  if (design.theme !== 'custom') return PALETTES[design.theme] ?? PALETTES.fuchsia;
  const base = parseHex(design.color) ? design.color.toLowerCase() : '#cb11ab';
  return {
    bg: [base, mix(base, [0, 0, 0], 0.35)],
    ink: '#ffffff',
    sub: 'rgba(255,255,255,0.88)',
    chip: 'rgba(255,255,255,0.18)',
    blob: 'rgba(255,255,255,0.10)',
    fg: base,
    fg2: mix(base, [0, 0, 0], 0.3),
  };
}

/** Фон шапки страницы клиента — в цвет карточки, которую он только что отсканировал. */
export function themeBackground(design: FeedbackDesign) {
  const p = palette(design);
  if (design.theme === 'light') return 'linear-gradient(160deg, #d316b2 0%, #8f17c9 100%)';
  return `linear-gradient(160deg, ${p.bg[0]} 0%, ${p.bg[1]} 100%)`;
}

// ── QR ──

function esc(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Модули QR как SVG-фрагмент в координатах «модуль = 1» (0..size). Центр очищен под значок —
 * не больше ~8 % площади, коррекция H восстанавливает до 30 %.
 */
export function qrFragment(text: string, paint: string) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'H' });
  const n = qr.modules.size;
  const data = qr.modules.data;
  const finder = (x: number, y: number) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
  const hole = Math.max(5, Math.round(n * 0.26) | 1);
  const c0 = Math.floor((n - hole) / 2);
  const center = (x: number, y: number) => x >= c0 && x < c0 + hole && y >= c0 && y < c0 + hole;
  let dots = '';
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (!data[y * n + x] || finder(x, y) || center(x, y)) continue;
      dots += `M${x + 0.5} ${y + 0.5}h0`;
    }
  }
  const eye = (x: number, y: number) =>
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="2" fill="none" stroke="${paint}" stroke-width="1"/>` +
    `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="1" fill="${paint}"/>`;
  const box = hole - 1.4;
  const bx = c0 + 0.7;
  const cx = c0 + hole / 2;
  const R = box * 0.34;
  const r = R * 0.44;
  const star = Array.from({ length: 10 }, (_, i) => {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 ? r : R;
    return `${(cx + radius * Math.cos(angle)).toFixed(2)},${(cx + 0.1 + radius * Math.sin(angle)).toFixed(2)}`;
  }).join(' ');
  return {
    size: n,
    svg:
      `<path d="${dots}" fill="none" stroke="${paint}" stroke-width="0.84" stroke-linecap="round"/>` +
      eye(0, 0) + eye(n - 7, 0) + eye(0, n - 7) +
      `<rect x="${bx}" y="${bx}" width="${box}" height="${box}" rx="${(box * 0.3).toFixed(2)}" fill="${paint}"/>` +
      `<polygon points="${star}" fill="#ffffff" stroke="#ffffff" stroke-width="0.3" stroke-linejoin="round"/>`,
  };
}

// ── перенос строк (в SVG его нет) ──

let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, size: number, weight: number) {
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      measureCtx = null;
    }
  }
  if (measureCtx) {
    measureCtx.font = `${weight} ${size}px Inter, Arial, sans-serif`;
    const width = measureCtx.measureText(text).width;
    if (width > 0) return width * 1.04; // запас на Arial, если Inter в окне печати не подгрузится
  }
  return text.length * size * (weight >= 700 ? 0.6 : 0.52);
}

export function wrapLines(text: string, size: number, weight: number, maxWidth: number, maxLines: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size, weight) <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[\s.,;:!?…-]+$/, '')}…`;
    return kept;
  }
  return lines;
}

// ── карточка ──

/** Размер листа в мм и вёрстка в px (A6 — та же вёрстка A5, пропорции совпадают). */
export const CARD_SIZE: Record<FeedbackFormat, { w: number; h: number; mmW: number; mmH: number }> = {
  a5: { w: 420, h: 596, mmW: 148, mmH: 210 },
  a6: { w: 420, h: 596, mmW: 105, mmH: 148 },
  sticker: { w: 340, h: 340, mmW: 100, mmH: 100 },
};

let seq = 0;

function textLines(lines: string[], { x, y, size, weight, color, lh }: { x: number; y: number; size: number; weight: number; color: string; lh: number }) {
  return lines
    .map((line, i) => `<text x="${x}" y="${y + i * lh}" text-anchor="middle" font-size="${size}" font-weight="${weight}" fill="${color}">${esc(line)}</text>`)
    .join('');
}

function qrPlate(url: string, p: Palette, gid: string, x: number, y: number, side: number, pad: number) {
  const qr = qrFragment(url, `url(#${gid}q)`);
  const inner = side - pad * 2;
  const k = inner / qr.size;
  return (
    `<rect x="${x}" y="${y}" width="${side}" height="${side}" rx="${side * 0.1}" fill="#ffffff"${p.border ? ` stroke="${p.border}"` : ''}/>` +
    `<g transform="translate(${x + pad} ${y + pad}) scale(${k})">` +
    `<defs><linearGradient id="${gid}q" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${qr.size}" y2="${qr.size}"><stop offset="0" stop-color="${p.fg}"/><stop offset="1" stop-color="${p.fg2}"/></linearGradient></defs>` +
    `${qr.svg}</g>`
  );
}

/** Карточка целиком как строка SVG (все пользовательские тексты экранированы). */
export function cardSvg(text: CardText, design: FeedbackDesign, url: string, { width, height }: { width?: string; height?: string } = {}) {
  const p = palette(design);
  const size = CARD_SIZE[design.format] ?? CARD_SIZE.a5;
  const { w, h } = size;
  const gid = `fbc${(seq += 1)}`;
  const headline = text.headline.trim() || DEFAULT_HEADLINE;
  const note = text.note.trim();
  const where = [text.place.trim(), text.address.trim()];
  const font = "font-family=\"Inter, 'Segoe UI', Arial, sans-serif\"";
  const head =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${width ?? w}" height="${height ?? h}" ${font} role="img" aria-label="${esc(headline)}">` +
    `<defs><linearGradient id="${gid}b" x1="0" y1="0" x2="0.55" y2="1"><stop offset="0" stop-color="${p.bg[0]}"/><stop offset="1" stop-color="${p.bg[1]}"/></linearGradient>` +
    `<clipPath id="${gid}c"><rect width="${w}" height="${h}" rx="${design.format === 'sticker' ? 28 : 22}"/></clipPath></defs>` +
    `<g clip-path="url(#${gid}c)"><rect width="${w}" height="${h}" fill="url(#${gid}b)"/>`;
  const border = p.border ? `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${design.format === 'sticker' ? 27.5 : 21.5}" fill="none" stroke="${p.border}"/>` : '';

  if (design.format === 'sticker') {
    const lines = wrapLines(headline, 22, 800, w - 48, 2);
    const top = lines.length > 1 ? 40 : 46;
    const qrSide = lines.length > 1 ? 196 : 210;
    const qrY = top + (lines.length - 1) * 26 + 18;
    const footer = ['Анонимно · 1 минута', where[0]].filter(Boolean).join(' · ');
    return (
      head +
      `<circle cx="${w - 30}" cy="20" r="70" fill="${p.blob}"/>` +
      textLines(lines, { x: w / 2, y: top, size: 22, weight: 800, color: p.ink, lh: 26 }) +
      qrPlate(url, p, gid, (w - qrSide) / 2, qrY, qrSide, 14) +
      textLines(wrapLines(footer, 12, 600, w - 40, 1), { x: w / 2, y: h - 22, size: 12, weight: 600, color: p.sub, lh: 14 }) +
      `</g>${border}</svg>`
    );
  }

  // A5 / A6: чип, заголовок, подпись, QR, «что можно оставить», пункт и адрес внизу.
  let y = 32;
  const chipText = 'Анонимно · без регистрации';
  const chipW = textWidth(chipText, 12, 600) + 44;
  let body =
    `<circle cx="${w + 10}" cy="-10" r="120" fill="${p.blob}"/><circle cx="-10" cy="${h - 150}" r="72" fill="${p.blob}"/>` +
    `<rect x="${(w - chipW) / 2}" y="${y}" width="${chipW}" height="26" rx="13" fill="${p.chip}"/>` +
    `<g transform="translate(${(w - chipW) / 2 + 14} ${y + 7})" fill="none" stroke="${p.ink}" stroke-width="1.6" stroke-linecap="round"><rect x="1" y="5" width="10" height="7" rx="1.5"/><path d="M3.2 5V3.6a2.8 2.8 0 0 1 5.6 0V5"/></g>` +
    `<text x="${(w - chipW) / 2 + 32}" y="${y + 17.5}" font-size="12" font-weight="600" fill="${p.ink}">${esc(chipText)}</text>`;
  y += 26 + 44;
  const headLines = wrapLines(headline, 34, 800, w - 64, 2);
  body += textLines(headLines, { x: w / 2, y, size: 34, weight: 800, color: p.ink, lh: 38 });
  y += (headLines.length - 1) * 38 + 12;
  const noteLines = note ? wrapLines(note, 15, 400, w - 90, 3) : [];
  if (noteLines.length) {
    y += 22;
    body += textLines(noteLines, { x: w / 2, y, size: 15, weight: 400, color: p.sub, lh: 21 });
    y += (noteLines.length - 1) * 21;
  }
  const footerTop = h - 30 - (where[1] ? 20 : 0);
  const pillsY = footerTop - 64;
  const space = pillsY - 16 - (y + 22);
  const qrSide = Math.max(170, Math.min(240, space));
  const qrY = y + 22 + Math.max(0, (space - qrSide) / 2);
  body += qrPlate(url, p, gid, (w - qrSide) / 2, qrY, qrSide, Math.round(qrSide * 0.07));
  const pills = ['★ Оценка', 'Комментарий', 'Фото'];
  const pillW = pills.map(label => textWidth(label, 12, 600) + 22);
  const total = pillW.reduce((a, b) => a + b, 0) + 6 * (pills.length - 1);
  let px = (w - total) / 2;
  for (let i = 0; i < pills.length; i += 1) {
    body += `<rect x="${px}" y="${pillsY}" width="${pillW[i]}" height="26" rx="13" fill="${p.chip}"/>` +
      `<text x="${px + pillW[i] / 2}" y="${pillsY + 17.5}" text-anchor="middle" font-size="12" font-weight="600" fill="${p.ink}">${esc(pills[i])}</text>`;
    px += pillW[i] + 6;
  }
  if (where[0]) body += textLines(wrapLines(where[0], 15, 700, w - 60, 1), { x: w / 2, y: footerTop, size: 15, weight: 700, color: p.ink, lh: 18 });
  if (where[1]) body += textLines(wrapLines(where[1], 13, 400, w - 60, 1), { x: w / 2, y: footerTop + 20, size: 13, weight: 400, color: p.sub, lh: 16 });
  return `${head}${body}</g>${border}</svg>`;
}

// ── печать и PNG ──

/** Сколько карточек влезает на A4 и как лист повернуть. */
function sheetLayout(format: FeedbackFormat) {
  if (format === 'a5') return { landscape: true, cols: 2, rows: 1 };
  return { landscape: false, cols: 2, rows: 2 };
}

export function printDocument(text: CardText, design: FeedbackDesign, url: string) {
  const size = CARD_SIZE[design.format];
  const { landscape, cols, rows } = sheetLayout(design.format);
  const cards = Array.from({ length: cols * rows }, () =>
    `<div class="cell">${cardSvg(text, design, url, { width: `${size.mmW}mm`, height: `${size.mmH}mm` })}</div>`).join('');
  const style =
    `@page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:0}` +
    '*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}' +
    `.sheet{width:${landscape ? 297 : 210}mm;height:${landscape ? 210 : 297}mm;display:grid;grid-template-columns:repeat(${cols},${size.mmW}mm);grid-template-rows:repeat(${rows},${size.mmH}mm);justify-content:center;align-content:center;gap:${design.format === 'sticker' ? 6 : 0}mm}` +
    '.cell{outline:0.2mm dashed #c9c3d6}svg{display:block}' +
    '@media screen{body{background:#eee}}';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Карточка для отзывов</title><style>${style}</style></head><body><div class="sheet">${cards}</div></body></html>`;
}

/** Печать через скрытый iframe: window.print() в кабинете печатает пустой лист (печатные стили прячут оболочку). */
export async function printCard(text: CardText, design: FeedbackDesign, url: string) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(iframe);
  const remove = () => iframe.remove();
  try {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('Не удалось подготовить окно печати.');
    doc.open();
    doc.write(printDocument(text, design, url));
    doc.close();
    win.addEventListener('afterprint', remove, { once: true });
    setTimeout(remove, 60000);
    win.focus();
    win.print();
  } catch (error) {
    remove();
    throw error;
  }
}

/** PNG в 3× (для A5 — 1260 × 1788 px): SVG → canvas. Шрифт — системный, если Inter недоступен картинке. */
export async function cardPng(text: CardText, design: FeedbackDesign, url: string, scale = 3): Promise<Blob> {
  const size = CARD_SIZE[design.format];
  const svg = cardSvg(text, design, url, { width: String(size.w * scale), height: String(size.h * scale) });
  const blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Не удалось подготовить картинку'));
      img.src = blobUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = size.w * scale;
    canvas.height = size.h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Браузер не умеет сохранять картинку');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Не удалось сохранить PNG'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
