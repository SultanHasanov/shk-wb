// QR-коды для анонимных отзывов клиентов пункта (кабинет → «Отзывы клиентов», миграция 20261122_feedback_boards.sql).
//
// Владелец создаёт QR (feedback_boards) и печатает карточку. Клиент без входа открывает /o/<slug>: оценка,
// комментарий, до 3 фото. Фото грузятся заранее, по одному (POST octet-stream — multipart сервер не разбирает),
// перекодируются sharp'ом (EXIF с геометкой и моделью телефона срезается) и ждут в pending/ до отправки отзыва.
// Отзыв приходит владельцу в кабинет (in_app_notifications kind=feedback), в Telegram и на почту.
//
// Анонимность: в отзыве нет ни IP, ни User-Agent, ни контактов. Лимиты частоты держат только sha256 ключа
// (server/_rate-limit.js). Все обработчики отвечают сами — api/cabinet.js только передаёт им запрос.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { z } = require('zod');
const { supabaseFetch } = require('./_supabase');
const { clientAddress, enforceRateLimit } = require('./_rate-limit');

const MAX_BOARDS = 10;
const MAX_PHOTOS = 3;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const PHOTO_SIDE = 1600;
const PENDING_TTL_MS = 24 * 3600 * 1000;
const VIEW_URL_TTL_S = 6 * 3600;
// Ссылки на фото в письме живут дольше: письмо открывают и через неделю.
const MAIL_URL_TTL_S = 30 * 86400;
const PUBLIC_CACHE_MS = 60 * 1000;
const SLUG_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SLUG_RE = /^[A-Z0-9]{8}$/;
const PHOTO_ID_RE = /^[0-9a-f]{24}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOARD_SELECT = 'id,user_id,slug,label,place,address,headline,note,design,notify_telegram,notify_email,is_active,created_at,updated_at';
const ENTRY_SELECT = 'id,board_id,rating,kind,comment,photos,read_at,created_at';

const THEMES = ['fuchsia', 'lilac', 'coral', 'graphite', 'light', 'custom'];
const FORMATS = ['a5', 'a6', 'sticker'];
const KINDS = ['thanks', 'idea', 'complaint'];
const KIND_TITLES = { thanks: 'Благодарность', idea: 'Предложение', complaint: 'Жалоба' };

// ── общие мелочи ──

function q(value) { return encodeURIComponent(String(value)); }

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function publicUrl(pathname) {
  const origin = String(process.env.PUBLIC_APP_URL || 'https://shk-wb.ru').replace(/\/$/, '');
  return `${origin}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function secret() {
  const value = process.env.FEEDBACK_SECRET || process.env.STICKER_CLIENT_SECRET || process.env.SUPABASE_SECRET_KEY;
  if (!value) throw new Error('FEEDBACK_SECRET is not configured');
  return value;
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newSlug() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const byte of bytes) out += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
  return out;
}

function kindForRating(rating) {
  return rating <= 2 ? 'complaint' : rating === 3 ? 'idea' : 'thanks';
}

/** Контраст цвета модулей QR с белой подложкой (WCAG). Ниже 3:1 телефоны считывают код плохо. */
function contrastWithWhite(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const channel = shift => {
    const c = ((n >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return 1.05 / (lum + 0.05);
}
const MIN_CONTRAST = 3;

// ── каталог фото ──

/** Каталог фото: FEEDBACK_PHOTO_DIR, на VPS по умолчанию /srv/shk-wb/feedback-photos (вне релиза, в бэкапе). */
function photoDir() {
  if (process.env.FEEDBACK_PHOTO_DIR) return process.env.FEEDBACK_PHOTO_DIR;
  if (fs.existsSync('/srv/shk-wb')) return '/srv/shk-wb/feedback-photos';
  return path.join(os.tmpdir(), 'shk-feedback-photos');
}
function storedPath(id) { return path.join(photoDir(), `${id}.jpg`); }
function pendingPath(id) { return path.join(photoDir(), 'pending', `${id}.jpg`); }

let lastSweep = 0;
/** Неотправленные фото старше суток удаляем по ходу дела, не чаще раза в час. */
async function sweepPending() {
  if (Date.now() - lastSweep < 3600 * 1000) return;
  lastSweep = Date.now();
  const dir = path.join(photoDir(), 'pending');
  const names = await fs.promises.readdir(dir).catch(() => []);
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > PENDING_TTL_MS) await fs.promises.unlink(file).catch(() => {});
  }
}

async function removePhotos(ids) {
  for (const id of ids || []) if (PHOTO_ID_RE.test(String(id))) await fs.promises.unlink(storedPath(id)).catch(() => {});
}

function photoViewUrl(id, ttl = VIEW_URL_TTL_S) {
  const expires = Math.floor(Date.now() / 1000) + ttl;
  return `/api/feedback/photo/${id}?expires=${expires}&token=${q(sign(`fb-view:${id}:${expires}`))}`;
}

// ── отображение строк ──

function normalizeDesign(raw) {
  const design = raw && typeof raw === 'object' ? raw : {};
  return {
    format: FORMATS.includes(design.format) ? design.format : 'a5',
    theme: THEMES.includes(design.theme) ? design.theme : 'fuchsia',
    color: /^#[0-9a-f]{6}$/i.test(String(design.color || '')) ? String(design.color).toLowerCase() : '#cb11ab',
  };
}

function mapBoard(row, stats) {
  return {
    id: row.id,
    slug: row.slug,
    url: publicUrl(`/o/${row.slug}`),
    label: row.label,
    place: row.place,
    address: row.address,
    headline: row.headline,
    note: row.note,
    design: normalizeDesign(row.design),
    notifyTelegram: row.notify_telegram,
    notifyEmail: row.notify_email,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats: stats || { total30: 0, unread: 0 },
  };
}

function mapEntry(row) {
  const photos = Array.isArray(row.photos) ? row.photos.filter(id => PHOTO_ID_RE.test(String(id))) : [];
  return {
    id: row.id,
    boardId: row.board_id,
    rating: row.rating,
    kind: row.kind,
    comment: row.comment,
    photos: photos.map(id => ({ id, url: photoViewUrl(id) })),
    isRead: Boolean(row.read_at),
    createdAt: row.created_at,
  };
}

// ── публичная карточка: кэш в памяти, каждый скан QR не должен ходить в Supabase (Egress) ──

const publicCache = new Map();

function forgetPublic(slug) { publicCache.delete(slug); }

async function loadBoardBySlug(slug) {
  const rows = await supabaseFetch(`feedback_boards?slug=eq.${q(slug)}&select=${BOARD_SELECT}&limit=1`);
  return rows[0] || null;
}

async function publicBoard(slug) {
  const hit = publicCache.get(slug);
  if (hit && Date.now() - hit.at < PUBLIC_CACHE_MS) return hit.value;
  const row = await loadBoardBySlug(slug);
  const value = row ? {
    slug: row.slug,
    place: row.place,
    address: row.address,
    headline: row.headline,
    isActive: row.is_active,
    design: normalizeDesign(row.design),
  } : null;
  publicCache.set(slug, { at: Date.now(), value });
  if (publicCache.size > 2000) publicCache.delete(publicCache.keys().next().value);
  return value;
}

// ── входные данные ──

const DesignInput = z.object({
  format: z.enum(FORMATS),
  theme: z.enum(THEMES),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).strict();

const BoardInput = z.object({
  label: z.string().trim().max(60),
  place: z.string().trim().max(80),
  address: z.string().trim().max(120),
  headline: z.string().trim().max(60),
  note: z.string().trim().max(140),
  design: DesignInput,
  notifyTelegram: z.boolean(),
  notifyEmail: z.boolean(),
  isActive: z.boolean(),
}).strict();

const SubmitInput = z.object({
  rating: z.number().int().min(1).max(5),
  kind: z.enum(KINDS).optional(),
  comment: z.string().max(1000).optional().default(''),
  photos: z.array(z.object({ id: z.string().regex(PHOTO_ID_RE), token: z.string().min(10).max(100) }).strict()).max(MAX_PHOTOS).optional().default([]),
  website: z.string().optional(),
}).strict();

function bad(res, parsed) {
  return res.status(400).json({ error: 'Некорректные данные', code: 'VALIDATION_ERROR', details: parsed.error.flatten() });
}

function boardRow(data) {
  return {
    label: data.label,
    place: data.place,
    address: data.address,
    headline: data.headline,
    note: data.note,
    design: { ...data.design, color: data.design.color.toLowerCase() },
    notify_telegram: data.notifyTelegram,
    notify_email: data.notifyEmail,
    is_active: data.isActive,
  };
}

function checkColor(res, design) {
  if (design.theme !== 'custom' || contrastWithWhite(design.color) >= MIN_CONTRAST) return true;
  res.status(400).json({ error: 'Цвет слишком светлый — QR-код перестанет считываться. Выберите цвет темнее.', code: 'COLOR_TOO_LIGHT' });
  return false;
}

// ── уведомления владельцу ──

function starsText(rating) { return '★'.repeat(rating) + '☆'.repeat(5 - rating); }

function boardName(board) { return board.label || board.place || 'QR-код'; }

async function ownerTelegram(userId) {
  const rows = await supabaseFetch(`user_telegram_identities?user_id=eq.${q(userId)}&select=telegram_user_id&order=updated_at.desc&limit=1`);
  const id = Number(rows[0]?.telegram_user_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Загрузка файлов в Telegram. С VPS api.telegram.org недоступен — идём через релей TELEGRAM_API_BASE
 * (он пропускает multipart, docs/telegram-bot.md «ШК с фото»). telegramUpload в _telegram-api.js
 * ходит напрямую и с VPS не работает, а его правка требует выкладки узла бота — поэтому свой вызов здесь.
 */
async function telegramMultipart(method, form) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const relay = String(process.env.TELEGRAM_API_BASE || '').trim().replace(/\/$/, '');
  const url = relay ? `${relay}/api/${method}` : `https://api.telegram.org/bot${token}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: relay ? { Authorization: `Bearer ${token}` } : {},
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    const error = new Error(data.description || `Telegram API error (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data.result;
}

function telegramText(board, entry, { maxComment = 1000 } = {}) {
  const comment = entry.comment.length > maxComment ? `${entry.comment.slice(0, maxComment)}… (полностью — в кабинете)` : entry.comment;
  return [
    `💬 <b>Новый отзыв</b> · ${escapeHtml(boardName(board))}`,
    `${starsText(entry.rating)} · <b>${KIND_TITLES[entry.kind]}</b>`,
    comment ? `«${escapeHtml(comment)}»` : '<i>Без комментария — только оценка</i>',
    [board.place, board.address].filter(Boolean).length ? `<i>${escapeHtml([board.place, board.address].filter(Boolean).join(', '))}</i>` : '',
  ].filter(Boolean).join('\n');
}

async function notifyTelegram(board, entry, photoBuffers) {
  const chatId = await ownerTelegram(board.user_id);
  if (!chatId) return 'not_linked';
  if (photoBuffers.length) {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('media', JSON.stringify(photoBuffers.map((_, i) => ({
      type: 'photo',
      media: `attach://p${i}`,
      ...(i === 0 ? { caption: telegramText(board, entry, { maxComment: 700 }), parse_mode: 'HTML' } : {}),
    }))));
    photoBuffers.forEach((buffer, i) => form.set(`p${i}`, new Blob([buffer], { type: 'image/jpeg' }), `photo-${i + 1}.jpg`));
    try {
      await telegramMultipart('sendMediaGroup', form);
      return 'sent';
    } catch (error) {
      // Фото не ушли (релей, размер) — текст важнее, отправляем его с пометкой.
      console.warn('feedback: telegram photos failed', error.message);
    }
  }
  const { sendMessage } = require('./_telegram-api');
  const { noticeMarkup } = require('./_bot-notice');
  const extra = photoBuffers.length ? `\n📷 Фото: ${photoBuffers.length} — смотрите в кабинете` : '';
  await sendMessage(chatId, telegramText(board, entry) + extra, {
    reply_markup: noticeMarkup({ inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'menu:home' }]] }),
  });
  return 'sent';
}

function emailHtml(board, entry, photoUrls) {
  const accent = '#cb11ab';
  const stars = `<span style="color:#e8a100">${'★'.repeat(entry.rating)}</span><span style="color:#dcd7e4">${'★'.repeat(5 - entry.rating)}</span>`;
  const where = [board.place, board.address].filter(Boolean).join(' · ');
  const photos = photoUrls.map((url, i) => `<a href="${escapeHtml(url)}"><img src="${escapeHtml(url)}" alt="Фото ${i + 1}" width="160" style="border-radius:10px;margin:0 8px 8px 0;max-width:160px;border:0"></a>`).join('');
  return `<!doctype html><html lang="ru"><body style="margin:0;background:#f6f5f9;font-family:Arial,Helvetica,sans-serif;color:#1d1a29">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ebe8f0">
<tr><td style="height:6px;background:${accent}"></td></tr>
<tr><td style="padding:24px 26px">
<div style="font-size:13px;color:#5f5a72">${escapeHtml(where || 'Ваш пункт')} · QR «${escapeHtml(boardName(board))}»</div>
<div style="font-size:24px;letter-spacing:2px;margin:12px 0 4px">${stars}</div>
<div style="font-size:13px;font-weight:bold;color:#5f5a72;margin-bottom:12px">${KIND_TITLES[entry.kind]}</div>
<div style="font-size:16px;line-height:1.55;white-space:pre-wrap">${entry.comment ? escapeHtml(entry.comment) : '<i style="color:#6f6a82">Без комментария — только оценка</i>'}</div>
${photos ? `<div style="margin-top:16px">${photos}</div>` : ''}
<div style="margin-top:20px"><a href="${publicUrl('/cabinet/feedback')}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">Открыть в кабинете</a></div>
<div style="margin-top:20px;padding-top:12px;border-top:1px solid #f0edf4;font-size:12px;line-height:1.5;color:#6f6a82">Отзыв анонимный — ответить на письмо нельзя. Письма по этому QR отключаются в кабинете: Отзывы клиентов → QR-коды.</div>
</td></tr></table></td></tr></table></body></html>`;
}

/**
 * Письмо владельцу. Фото — ссылками на наш сервер, НЕ вложениями: с VPS в РФ загрузка в api.resend.com
 * замирает на 128 КБ (15.11.2026: письмо с одним фото 110 КБ упало «fetch failed», текстовые уходят).
 * Почтовик сам подтягивает картинки с shk-wb.ru — входящие соединения к VPS не режутся.
 */
async function notifyEmail(board, entry, photoIds) {
  const { getAuthUser } = require('./_user-auth');
  const { sendEmail } = require('./_notifications');
  const user = await getAuthUser(board.user_id);
  const email = String(user?.email || '');
  if (!email || /@users[.]invalid$/i.test(email) || !user?.email_confirmed_at) return 'no_email';
  const urls = photoIds.map(id => publicUrl(photoViewUrl(id, MAIL_URL_TTL_S)));
  const subject = `Новый отзыв ${starsText(entry.rating)} — ${boardName(board)}`.slice(0, 200);
  const text = [
    `${KIND_TITLES[entry.kind]} · оценка ${entry.rating} из 5`,
    entry.comment || 'Без комментария — только оценка',
    urls.length ? `Фото:\n${urls.join('\n')}` : '',
    `Все отзывы: ${publicUrl('/cabinet/feedback')}`,
  ].filter(Boolean).join('\n\n');
  const result = await sendEmail({
    userId: board.user_id,
    to: email,
    subject,
    text,
    html: emailHtml(board, entry, urls),
    dedupeKey: `email:feedback:${entry.id}`,
  });
  return result.status;
}

/** Повторить письмо по отзыву, если прошлая попытка упала (разово с сервера). */
async function retryEmail(entryId) {
  if (!UUID_RE.test(String(entryId || ''))) throw new Error('bad entry id');
  const entry = (await supabaseFetch(`feedback_entries?id=eq.${q(entryId)}&select=${ENTRY_SELECT}&limit=1`))[0];
  if (!entry) throw new Error('entry not found');
  const board = (await supabaseFetch(`feedback_boards?id=eq.${q(entry.board_id)}&select=${BOARD_SELECT}&limit=1`))[0];
  if (!board) throw new Error('board not found');
  // Строка доставки держит dedupe_key — неудачную убираем, удачную не трогаем (письмо не задвоится).
  await supabaseFetch(`notification_deliveries?dedupe_key=eq.${q(`email:feedback:${entry.id}`)}&status=eq.failed`, { method: 'DELETE' });
  const ids = (Array.isArray(entry.photos) ? entry.photos : []).filter(id => PHOTO_ID_RE.test(String(id)));
  return notifyEmail(board, entry, ids);
}

/** Все три канала; сбой одного не мешает остальным и не ломает приём отзыва. */
async function notifyOwner(board, entry) {
  const { createNotification } = require('./_notifications');
  const buffers = [];
  for (const id of entry.photos || []) {
    const buffer = await fs.promises.readFile(storedPath(id)).catch(() => null);
    if (buffer) buffers.push(buffer);
  }
  const result = { cabinet: 'skipped', telegram: 'off', email: 'off' };
  try {
    await createNotification({
      userId: board.user_id,
      kind: 'feedback',
      title: `Новый отзыв ${starsText(entry.rating)} — ${boardName(board)}`.slice(0, 160),
      body: `${KIND_TITLES[entry.kind]}${entry.comment ? `: ${entry.comment}` : ''}`.slice(0, 2000),
      link: '/cabinet/feedback',
      dedupeKey: `feedback:${entry.id}`,
      email: null,
    });
    result.cabinet = 'sent';
  } catch (error) {
    result.cabinet = 'failed';
    console.warn('feedback: cabinet notification failed', error.message);
  }
  if (board.notify_telegram) {
    result.telegram = await notifyTelegram(board, entry, buffers).catch(error => {
      console.warn('feedback: telegram failed', error.message);
      return 'failed';
    });
  }
  if (board.notify_email) {
    const ids = (entry.photos || []).filter(id => PHOTO_ID_RE.test(String(id)));
    result.email = await notifyEmail(board, entry, ids).catch(error => {
      console.warn('feedback: email failed', error.message);
      return 'failed';
    });
  }
  return result;
}

// ── публичные обработчики (без входа) ──

async function handlePublicBoard(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const slug = String(req.query.slug || '').toUpperCase();
  if (!SLUG_RE.test(slug)) return res.status(404).json({ error: 'QR-код не найден', code: 'NOT_FOUND' });
  if (!await enforceRateLimit(req, res, { scope: 'feedback-view', limit: 120, windowSeconds: 600 })) return;
  const board = await publicBoard(slug);
  if (!board) return res.status(404).json({ error: 'QR-код не найден', code: 'NOT_FOUND' });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(board);
}

async function handleUpload(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const slug = String(req.query.slug || '').toUpperCase();
  if (!SLUG_RE.test(slug)) return res.status(404).json({ error: 'QR-код не найден', code: 'NOT_FOUND' });
  if (!await enforceRateLimit(req, res, { scope: 'feedback-photo', limit: 20, windowSeconds: 3600 })) return;
  const input = Buffer.isBuffer(req.body) ? req.body : null;
  if (!input || !input.length) return res.status(400).json({ error: 'Нет файла', code: 'NO_FILE' });
  if (input.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'Фото слишком большое', code: 'TOO_LARGE' });
  const board = await publicBoard(slug);
  if (!board) return res.status(404).json({ error: 'QR-код не найден', code: 'NOT_FOUND' });
  if (!board.isActive) return res.status(409).json({ error: 'Приём отзывов приостановлен', code: 'PAUSED' });
  let jpeg;
  try {
    const sharp = require('sharp');
    // rotate() — по EXIF-ориентации; jpeg() без withMetadata() — EXIF (геометка, модель телефона) не попадает в файл.
    jpeg = await sharp(input, { failOn: 'error', limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: PHOTO_SIDE, height: PHOTO_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch {
    return res.status(415).json({ error: 'Это не похоже на фото. Подойдут JPG, PNG, HEIC и WebP.', code: 'NOT_IMAGE' });
  }
  const id = crypto.randomBytes(12).toString('hex');
  await fs.promises.mkdir(path.dirname(pendingPath(id)), { recursive: true });
  await fs.promises.writeFile(pendingPath(id), jpeg);
  sweepPending().catch(() => {});
  return res.status(201).json({ id, token: sign(`fb-photo:${slug}:${id}`) });
}

async function handleSubmit(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const slug = String(req.query.slug || '').toUpperCase();
  if (!SLUG_RE.test(slug)) return res.status(404).json({ error: 'QR-код не найден', code: 'NOT_FOUND' });
  // Ловушка для ботов — как в api/support.js: молча «успех».
  if (String(req.body?.website || '').trim()) return res.status(202).json({ ok: true });
  if (!await enforceRateLimit(req, res, { scope: 'feedback-submit', limit: 5, windowSeconds: 3600, key: `${clientAddress(req)}:${slug}` })) return;
  if (!await enforceRateLimit(req, res, { scope: 'feedback-board-day', limit: 300, windowSeconds: 86400, key: slug })) return;
  const parsed = SubmitInput.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  const data = parsed.data;
  const board = await loadBoardBySlug(slug);
  if (!board) return res.status(404).json({ error: 'QR-код не найден', code: 'NOT_FOUND' });
  if (!board.is_active) return res.status(409).json({ error: 'Приём отзывов приостановлен', code: 'PAUSED' });
  const ids = [];
  for (const photo of data.photos) {
    if (!safeEqual(photo.token, sign(`fb-photo:${slug}:${photo.id}`))) return res.status(400).json({ error: 'Фото не найдено — добавьте его ещё раз', code: 'PHOTO_INVALID' });
    if (!fs.existsSync(pendingPath(photo.id))) return res.status(400).json({ error: 'Фото устарело — добавьте его ещё раз', code: 'PHOTO_EXPIRED' });
    if (!ids.includes(photo.id)) ids.push(photo.id);
  }
  const comment = data.comment.trim();
  const rows = await supabaseFetch(`feedback_entries?select=${ENTRY_SELECT}`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      board_id: board.id,
      user_id: board.user_id,
      rating: data.rating,
      kind: data.kind || kindForRating(data.rating),
      comment,
      photos: ids,
    }),
  });
  const entry = rows[0];
  for (const id of ids) await fs.promises.rename(pendingPath(id), storedPath(id)).catch(error => console.warn('feedback: photo move failed', error.message));
  await notifyOwner(board, entry).catch(error => console.warn('feedback: notify failed', error.message));
  return res.status(201).json({ ok: true });
}

/** Фото для кабинета владельца — по подписанной ссылке (её отдаёт список отзывов): <img> не шлёт токен входа. */
async function handlePhoto(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const id = String(req.query.id || '');
  const expires = Number(req.query.expires || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!PHOTO_ID_RE.test(id) || !Number.isInteger(expires) || expires < now || expires > now + MAIL_URL_TTL_S + 60) return res.status(403).end();
  if (!safeEqual(String(req.query.token || ''), sign(`fb-view:${id}:${expires}`))) return res.status(403).end();
  const buffer = await fs.promises.readFile(storedPath(id)).catch(() => null);
  if (!buffer) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.status(200).send(buffer);
}

const PUBLIC_ACTIONS = {
  'feedback-public': handlePublicBoard,
  'feedback-upload': handleUpload,
  'feedback-submit': handleSubmit,
  'feedback-photo': handlePhoto,
};

function isPublicAction(action) { return Object.prototype.hasOwnProperty.call(PUBLIC_ACTIONS, action); }

async function handlePublic(req, res, action) {
  try {
    return await PUBLIC_ACTIONS[action](req, res);
  } catch (error) {
    console.error(`feedback ${action}`, error.message);
    if (!res.headersSent) return res.status(502).json({ error: 'Не удалось связаться с сервером. Попробуйте ещё раз.', code: 'SERVER_ERROR' });
  }
}

// ── кабинет владельца ──

async function boardsWithStats(userId) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const [boards, recent, unread] = await Promise.all([
    supabaseFetch(`feedback_boards?user_id=eq.${q(userId)}&select=${BOARD_SELECT}&order=created_at.asc`),
    supabaseFetch(`feedback_entries?user_id=eq.${q(userId)}&created_at=gte.${q(since)}&select=board_id,rating,kind&limit=5000`),
    supabaseFetch(`feedback_entries?user_id=eq.${q(userId)}&read_at=is.null&select=board_id&limit=5000`),
  ]);
  const per = new Map(boards.map(b => [b.id, { total30: 0, unread: 0 }]));
  const summary = { count30: 0, avg30: null, unread: unread.length, kinds30: { thanks: 0, idea: 0, complaint: 0 }, ratings30: [0, 0, 0, 0, 0] };
  let sum = 0;
  for (const row of recent) {
    summary.count30 += 1;
    sum += row.rating;
    summary.ratings30[row.rating - 1] += 1;
    if (summary.kinds30[row.kind] !== undefined) summary.kinds30[row.kind] += 1;
    const s = per.get(row.board_id);
    if (s) s.total30 += 1;
  }
  for (const row of unread) {
    const s = per.get(row.board_id);
    if (s) s.unread += 1;
  }
  if (summary.count30) summary.avg30 = Math.round((sum / summary.count30) * 10) / 10;
  return { items: boards.map(b => mapBoard(b, per.get(b.id))), summary, limit: MAX_BOARDS };
}

async function ownBoard(userId, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const rows = await supabaseFetch(`feedback_boards?id=eq.${q(id)}&user_id=eq.${q(userId)}&select=${BOARD_SELECT}&limit=1`);
  return rows[0] || null;
}

async function createBoard(req, res, userId) {
  const parsed = BoardInput.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  if (!checkColor(res, parsed.data.design)) return;
  const existing = await supabaseFetch(`feedback_boards?user_id=eq.${q(userId)}&select=id&limit=${MAX_BOARDS + 1}`);
  if (existing.length >= MAX_BOARDS) return res.status(409).json({ error: `Можно создать до ${MAX_BOARDS} QR-кодов. Удалите ненужный.`, code: 'BOARD_LIMIT' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const rows = await supabaseFetch(`feedback_boards?select=${BOARD_SELECT}`, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ ...boardRow(parsed.data), user_id: userId, slug: newSlug() }),
      });
      return res.status(201).json(mapBoard(rows[0]));
    } catch (error) {
      // Совпал slug (unique) — пробуем другой; иные ошибки — наверх.
      if (error.status !== 409) throw error;
    }
  }
  throw new Error('feedback: slug collision');
}

async function updateBoard(req, res, userId, id) {
  const board = await ownBoard(userId, id);
  if (!board) return res.status(404).json({ error: 'QR-код не найден', code: 'NOT_FOUND' });
  const parsed = BoardInput.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed);
  if (!checkColor(res, parsed.data.design)) return;
  const rows = await supabaseFetch(`feedback_boards?id=eq.${q(board.id)}&user_id=eq.${q(userId)}&select=${BOARD_SELECT}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...boardRow(parsed.data), updated_at: new Date().toISOString() }),
  });
  forgetPublic(board.slug);
  return res.status(200).json(mapBoard(rows[0] || board));
}

async function deleteBoard(res, userId, id) {
  const board = await ownBoard(userId, id);
  if (!board) return res.status(404).json({ error: 'QR-код не найден', code: 'NOT_FOUND' });
  const entries = await supabaseFetch(`feedback_entries?board_id=eq.${q(board.id)}&select=photos&limit=10000`);
  await supabaseFetch(`feedback_boards?id=eq.${q(board.id)}&user_id=eq.${q(userId)}`, { method: 'DELETE' });
  forgetPublic(board.slug);
  await removePhotos(entries.flatMap(e => (Array.isArray(e.photos) ? e.photos : [])));
  return res.status(204).end();
}

const FILTERS = { all: '', new: '&read_at=is.null', thanks: '&kind=eq.thanks', idea: '&kind=eq.idea', complaint: '&kind=eq.complaint' };

async function listEntries(req, res, userId) {
  const filter = FILTERS[String(req.query.filter || 'all')] ?? '';
  const board = String(req.query.board || '');
  const boardFilter = UUID_RE.test(board) ? `&board_id=eq.${q(board)}` : '';
  const before = String(req.query.before || '');
  const beforeFilter = before && !Number.isNaN(Date.parse(before)) ? `&created_at=lt.${q(new Date(before).toISOString())}` : '';
  const pageSize = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const rows = await supabaseFetch(`feedback_entries?user_id=eq.${q(userId)}${filter}${boardFilter}${beforeFilter}&select=${ENTRY_SELECT}&order=created_at.desc&limit=${pageSize}`);
  return res.status(200).json({
    items: rows.map(mapEntry),
    nextCursor: rows.length === pageSize ? rows[rows.length - 1].created_at : null,
  });
}

async function markRead(req, res, userId) {
  const now = new Date().toISOString();
  const body = req.body || {};
  let where;
  if (body.all === true) {
    const board = String(body.boardId || '');
    where = `feedback_entries?user_id=eq.${q(userId)}&read_at=is.null${UUID_RE.test(board) ? `&board_id=eq.${q(board)}` : ''}`;
  } else if (UUID_RE.test(String(body.id || ''))) {
    where = `feedback_entries?id=eq.${q(body.id)}&user_id=eq.${q(userId)}&read_at=is.null`;
  } else {
    return res.status(400).json({ error: 'Некорректные данные', code: 'VALIDATION_ERROR' });
  }
  const rows = await supabaseFetch(`${where}&select=id`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ read_at: now }) });
  // Колокольчик кабинета: те же отзывы там — уведомления feedback:<id>.
  const keys = rows.map(r => `feedback:${r.id}`);
  for (let i = 0; i < keys.length; i += 100) {
    const list = keys.slice(i, i + 100).map(k => `"${k}"`).join(',');
    await supabaseFetch(`in_app_notifications?user_id=eq.${q(userId)}&read_at=is.null&dedupe_key=in.(${q(list)})`, { method: 'PATCH', body: JSON.stringify({ read_at: now }) })
      .catch(error => console.warn('feedback: notification read failed', error.message));
  }
  return res.status(200).json({ updated: rows.length });
}

async function deleteEntry(req, res, userId) {
  const id = String(req.query.id || '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Некорректные данные', code: 'VALIDATION_ERROR' });
  const rows = await supabaseFetch(`feedback_entries?id=eq.${q(id)}&user_id=eq.${q(userId)}&select=photos`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  if (!rows.length) return res.status(404).json({ error: 'Отзыв не найден', code: 'NOT_FOUND' });
  await removePhotos(rows[0].photos);
  return res.status(204).end();
}

/** /api/cabinet/feedback/* — после requireUser в api/cabinet.js. Ошибки базы — наверх, их отвечает кабинет. */
async function handleOwner(req, res, user, action) {
  if (!await enforceRateLimit(req, res, { scope: 'feedback-owner', limit: 300, windowSeconds: 600, key: user.id })) return;
  if (action === 'feedback-boards') {
    if (req.method === 'GET') return res.status(200).json(await boardsWithStats(user.id));
    if (req.method === 'POST') return createBoard(req, res, user.id);
  }
  if (action === 'feedback-board') {
    if (req.method === 'PATCH') return updateBoard(req, res, user.id, req.query.id);
    if (req.method === 'DELETE') return deleteBoard(res, user.id, req.query.id);
  }
  if (action === 'feedback-entries') {
    if (req.method === 'GET') return listEntries(req, res, user.id);
    if (req.method === 'PATCH') return markRead(req, res, user.id);
    if (req.method === 'DELETE') return deleteEntry(req, res, user.id);
  }
  return res.status(404).json({ error: 'Метод не найден', code: 'NOT_FOUND' });
}

/** Счётчик непрочитанных для меню кабинета (bootstrap). */
async function unreadCount(userId) {
  const rows = await supabaseFetch(`feedback_entries?user_id=eq.${q(userId)}&read_at=is.null&select=id&limit=100`);
  return rows.length;
}

module.exports = {
  MAX_BOARDS,
  MIN_CONTRAST,
  contrastWithWhite,
  handleOwner,
  handlePublic,
  isPublicAction,
  kindForRating,
  newSlug,
  notifyOwner,
  photoDir,
  retryEmail,
  unreadCount,
  _test: { forgetAll: () => publicCache.clear(), sign },
};
