const crypto = require('crypto');
const QRCode = require('qrcode');

const VERHOEFF_MUL = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],
  [2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],
  [4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],
  [8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0],
];
const VERHOEFF_PERM = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],
  [5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
  [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];
const VERHOEFF_INV = [0,4,3,2,1,5,6,7,8,9];

function verhoeffDigit(value) {
  let checksum = 0;
  for (let index = 0; index < value.length; index += 1) {
    const digit = value.charCodeAt(value.length - 1 - index) - 48;
    checksum = VERHOEFF_MUL[checksum][VERHOEFF_PERM[(index + 1) % 8][digit]];
  }
  return VERHOEFF_INV[checksum];
}

function encodeWbPayload(code) {
  const normalized = String(code);
  if (!/^\d{1,12}$/.test(normalized)) throw new Error('Invalid sticker code');
  const value = BigInt(normalized);
  if (value > 1099511627775n) throw new Error('Sticker code does not fit into 5 bytes');
  const prefix = normalized.slice(0, -6);
  const suffix = normalized.slice(-6);
  const bytes = Buffer.alloc(6);
  let remainder = value;
  for (let index = 4; index >= 0; index -= 1) {
    bytes[index] = Number(remainder & 255n);
    remainder >>= 8n;
  }
  bytes[5] = (verhoeffDigit(prefix) << 4) | verhoeffDigit(suffix);
  return `*${bytes.toString('base64')}`;
}

function requesterHash(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const source = forwarded || req.socket?.remoteAddress || 'unknown';
  const secret = process.env.STICKER_CLIENT_SECRET;
  if (!secret) throw new Error('STICKER_CLIENT_SECRET is not configured');
  return crypto.createHmac('sha256', secret).update(source).digest('hex');
}

async function qrPng(code, width = 700, margin = 3) {
  return QRCode.toBuffer(encodeWbPayload(code), {
    type: 'png', width, margin, errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
}

async function qrTextPng(value, width = 700, margin = 3) {
  const text=String(value || '');
  if (!/^[A-Z0-9_-]{2,24}$/.test(text)) throw new Error('Invalid QR text');
  return QRCode.toBuffer(text, { type:'png', width, margin, errorCorrectionLevel:'M', color:{dark:'#000000',light:'#ffffff'} });
}

function splitCode(code) {
  const text = String(code);
  return text.length > 7 ? [text.slice(0, -4), text.slice(-4)] : [text, ''];
}

function makeRng(seedText) {
  let seed = 0;
  for (let index = 0; index < seedText.length; index += 1) {
    seed = (Math.imul(seed, 31) + seedText.charCodeAt(index)) >>> 0;
  }
  return function random() {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sideStripes(x, y, width, height, random) {
  const bars = [];
  const cuts = [];
  let position = 0;
  while (position < height - 1) {
    let bar = 1 + Math.floor(random() * 3);
    const gap = 1 + Math.floor(random() * 3);
    if (position + bar > height) bar = height - position;
    bars.push({ x, y: y + position, width, height: bar });
    position += bar + gap;
  }
  for (let cut = y + 42; cut < y + height - 10; cut += 58) {
    cuts.push({ x, y: cut, width, height: 3 });
  }
  return { bars, cuts };
}

function stickerDecorations(code) {
  const payload = encodeWbPayload(code);
  return {
    payload,
    qr: { x: 126, y: 178, size: 348 },
    cornerSize: 104,
    corners: [
      { x: 5, y: 57 },
      { x: 491, y: 57 },
      { x: 5, y: 574 },
      { x: 491, y: 574 },
    ],
    left: sideStripes(5, 174, 104, 382, makeRng(`${code}L`)),
    right: sideStripes(491, 174, 104, 382, makeRng(`${code}R`)),
  };
}

async function stickerSvg(code) {
  const design = stickerDecorations(code);
  const [centerQr, cornerQr] = await Promise.all([
    QRCode.toString(design.payload, { type: 'svg', width: design.qr.size, margin: 0, errorCorrectionLevel: 'M' }),
    QRCode.toString(design.payload, { type: 'svg', width: design.cornerSize, margin: 1, errorCorrectionLevel: 'M' }),
  ]);
  const centerQrBase64 = Buffer.from(centerQr).toString('base64');
  const cornerQrBase64 = Buffer.from(cornerQr).toString('base64');
  const [top, bottom] = splitCode(code);
  const codeMarkup = bottom
    ? `<text x="300" y="610" class="code small">${top}</text><text x="300" y="685" class="code">${bottom}</text>`
    : `<text x="300" y="665" class="code">${top}</text>`;
  const rects = (items, fill) => items.map((item) =>
    `<rect x="${item.x.toFixed(2)}" y="${item.y.toFixed(2)}" width="${item.width.toFixed(2)}" height="${item.height.toFixed(2)}" fill="${fill}"/>`
  ).join('');
  const cornerImages = design.corners.map((corner) =>
    `<image href="data:image/svg+xml;base64,${cornerQrBase64}" x="${corner.x}" y="${corner.y}" width="${design.cornerSize}" height="${design.cornerSize}"/>`
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="740" viewBox="0 0 600 740">
    <rect width="600" height="740" fill="white"/>
    <text x="300" y="151" text-anchor="middle" font-family="Arial,sans-serif" font-size="92" font-weight="800" letter-spacing="-8" fill="#e5007d">wb</text>
    ${cornerImages}
    ${rects(design.left.bars, '#000')}${rects(design.right.bars, '#000')}
    ${rects(design.left.cuts, '#fff')}${rects(design.right.cuts, '#fff')}
    <rect x="118" y="170" width="364" height="364" fill="white"/>
    <image href="data:image/svg+xml;base64,${centerQrBase64}" x="${design.qr.x}" y="${design.qr.y}" width="${design.qr.size}" height="${design.qr.size}"/>
    <style>.code{text-anchor:middle;font-family:Consolas,'Courier New',monospace;font-size:86px;font-weight:800}.small{font-size:62px}</style>
    ${codeMarkup}
  </svg>`;
}

function returnStickerDesign(code) {
  const normalized = String(code);
  if (!/^\d{1,12}$/.test(normalized)) throw new Error('Invalid return sticker code');
  return {
    payload: encodeWbPayload(normalized),
    width: 600,
    height: 900,
    qr: { x: 54, y: 205, size: 492 },
    title: '*B-T*',
    displayCode: `TRBX${normalized}`,
  };
}

async function returnStickerSvg(code) {
  const design = returnStickerDesign(code);
  const qr = await QRCode.toString(design.payload, {
    type: 'svg', width: design.qr.size, margin: 1, errorCorrectionLevel: 'M',
  });
  const qrBase64 = Buffer.from(qr).toString('base64');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${design.width}" height="${design.height}" viewBox="0 0 ${design.width} ${design.height}">
    <rect width="${design.width}" height="${design.height}" rx="20" fill="white"/>
    <text x="300" y="148" text-anchor="middle" font-family="Arial,sans-serif" font-size="82" font-weight="800" letter-spacing="2" fill="#111">${design.title}</text>
    <image href="data:image/svg+xml;base64,${qrBase64}" x="${design.qr.x}" y="${design.qr.y}" width="${design.qr.size}" height="${design.qr.size}" image-rendering="pixelated"/>
    <text x="300" y="820" text-anchor="middle" font-family="Arial,sans-serif" font-size="48" font-weight="800" letter-spacing="1" fill="#111">${design.displayCode}</text>
  </svg>`;
}

async function boxStickerSvg(prefix, code) {
  const safePrefix = String(prefix || '').toUpperCase();
  const normalized = String(code || '');
  if (!/^[A-Z0-9_-]{1,12}$/.test(safePrefix) || !/^\d{1,12}$/.test(normalized)) throw new Error('Invalid box sticker');
  const value = `${safePrefix}${normalized}`;
  const qr = await QRCode.toString(value, { type:'svg', width:492, margin:1, errorCorrectionLevel:'M' });
  const qrBase64 = Buffer.from(qr).toString('base64');
  const fontSize = Math.max(30, Math.min(48, Math.floor(650 / value.length)));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
    <rect width="600" height="900" rx="20" fill="white"/>
    <text x="300" y="148" text-anchor="middle" font-family="Arial,sans-serif" font-size="82" font-weight="800" letter-spacing="2" fill="#111">*B-T*</text>
    <image href="data:image/svg+xml;base64,${qrBase64}" x="54" y="205" width="492" height="492" image-rendering="pixelated"/>
    <text x="300" y="820" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="800" letter-spacing="1" fill="#111">${value}</text>
  </svg>`;
}

module.exports = { boxStickerSvg, encodeWbPayload, qrPng, qrTextPng, requesterHash, returnStickerDesign, returnStickerSvg, splitCode, stickerDecorations, stickerSvg };
