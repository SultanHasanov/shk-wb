import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handler = require('../../api/cabinet.js') as Handler;
const feedback = require('../../server/_feedback.js');
const sharp = require('sharp');

const SLUG = 'K7M4PX2Q';
const BOARD_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

function response() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string>, headersSent: false };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; res.headersSent = true; return res; };
  res.send = (b: unknown) => { res.body = b; res.headersSent = true; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.end = () => { res.headersSent = true; return res; };
  return res;
}

function req(action: string, { method = 'GET', query = {}, body, auth = false, ip = '203.0.113.7' }: { method?: string; query?: Record<string, string>; body?: unknown; auth?: boolean; ip?: string } = {}) {
  return {
    method,
    query: { action, ...query },
    body,
    headers: { 'x-forwarded-for': ip, ...(auth ? { authorization: 'Bearer tkn' } : {}) },
    socket: { remoteAddress: ip },
  };
}

type Call = { url: string; method: string; body: any };

function board(over: Record<string, unknown> = {}) {
  return {
    id: BOARD_ID, user_id: OWNER, slug: SLUG, label: 'Стол выдачи', place: 'ПВЗ Wildberries', address: 'ул. Ленина, 24',
    headline: 'Как вам наш пункт?', note: '', design: { format: 'a5', theme: 'fuchsia', color: '#cb11ab' },
    notify_telegram: true, notify_email: true, is_active: true, created_at: '2026-11-15T10:00:00Z', updated_at: '2026-11-15T10:00:00Z',
    ...over,
  };
}

function mockServer({ boardRow = board(), boards = [] as unknown[], telegramId = 777 as number | null, email = 'owner@example.ru' } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = String(init.method || 'GET');
    let body: any = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* текст */ } }
    calls.push({ url, method, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.includes('/auth/v1/user')) return json({ id: OWNER, email });
    if (url.includes('/auth/v1/admin/users/')) return json({ id: OWNER, email, email_confirmed_at: '2026-01-01T00:00:00Z' });
    if (url.includes('consume_api_rate_limit')) return json(true);
    if (url.includes('/rest/v1/feedback_boards')) {
      if (method === 'GET' && url.includes('slug=eq.')) return json(boardRow ? [boardRow] : []);
      if (method === 'GET' && url.includes('select=id&')) return json(boards);
      if (method === 'POST') return json([{ ...board(), ...body, id: BOARD_ID }], 201);
      return json(boards);
    }
    if (url.includes('/rest/v1/feedback_entries')) {
      if (method === 'POST') return json([{ id: '33333333-3333-4333-8333-333333333333', ...body, read_at: null, created_at: '2026-11-15T11:00:00Z' }], 201);
      return json([]);
    }
    if (url.includes('/rest/v1/user_telegram_identities')) return json(telegramId ? [{ telegram_user_id: telegramId }] : []);
    if (url.includes('/rest/v1/in_app_notifications')) return json([{ id: 'n1' }], 201);
    if (url.includes('/rest/v1/notification_deliveries')) return json([{ id: 'd1' }], 201);
    if (url.includes('api.resend.com')) return json({ id: 're_1' });
    if (url.includes('/sendMessage') || url.includes('/sendMediaGroup')) return json({ ok: true, result: {} });
    return json({ message: 'unexpected ' + url }, 404);
  }));
  return calls;
}

async function photo(withExif = true) {
  const image = sharp({ create: { width: 64, height: 48, channels: 3, background: '#cb11ab' } });
  return (withExif ? image.withMetadata({ exif: { IFD0: { Make: 'SecretPhone', Model: 'X1' } } }) : image).jpeg().toBuffer();
}

describe('QR-отзывы: публичная страница', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
    process.env.SUPABASE_SECRET_KEY = 'secret';
    process.env.FEEDBACK_SECRET = 'feedback-secret';
    process.env.TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.TELEGRAM_API_BASE = 'https://relay.test';
    process.env.RESEND_API_KEY = 're_key';
    process.env.RESEND_FROM_EMAIL = 'noreply@shk-wb.ru';
    process.env.FEEDBACK_PHOTO_DIR = mkdtempSync(join(tmpdir(), 'fb-test-'));
    feedback._test.forgetAll();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('неверный slug — 404 без похода в базу', async () => {
    const calls = mockServer();
    const res = response();
    await handler(req('feedback-public', { query: { slug: 'bad' } }), res);
    expect(res.statusCode).toBe(404);
    expect(calls.some(c => c.url.includes('feedback_boards'))).toBe(false);
  });

  it('карточка пункта без входа и без лишних полей; второй скан — из кэша', async () => {
    const calls = mockServer();
    const res = response();
    await handler(req('feedback-public', { query: { slug: SLUG.toLowerCase() } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ slug: SLUG, place: 'ПВЗ Wildberries', isActive: true });
    expect(res.body).not.toHaveProperty('user_id');
    expect(res.body).not.toHaveProperty('label');
    await handler(req('feedback-public', { query: { slug: SLUG } }), response());
    expect(calls.filter(c => c.url.includes('feedback_boards')).length).toBe(1);
  });

  it('ловушка для ботов — «успех» без записи', async () => {
    const calls = mockServer();
    const res = response();
    await handler(req('feedback-submit', { method: 'POST', query: { slug: SLUG }, body: { rating: 5, website: 'spam.example' } }), res);
    expect(res.statusCode).toBe(202);
    expect(calls.some(c => c.url.includes('feedback_entries'))).toBe(false);
  });

  it('QR на паузе — 409 PAUSED', async () => {
    mockServer({ boardRow: board({ is_active: false }) });
    const res = response();
    await handler(req('feedback-submit', { method: 'POST', query: { slug: SLUG }, body: { rating: 4 } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('PAUSED');
  });

  it('отзыв без фото: запись без IP, тип по оценке, кабинет + Telegram + почта', async () => {
    const calls = mockServer();
    const res = response();
    await handler(req('feedback-submit', { method: 'POST', query: { slug: SLUG }, body: { rating: 2, comment: 'Долго искали заказ' } }), res);
    expect(res.statusCode).toBe(201);
    const insert = calls.find(c => c.url.includes('feedback_entries') && c.method === 'POST')!;
    expect(insert.body).toEqual({ board_id: BOARD_ID, user_id: OWNER, rating: 2, kind: 'complaint', comment: 'Долго искали заказ', photos: [] });
    expect(JSON.stringify(insert.body)).not.toContain('203.0.113.7');
    const note = calls.find(c => c.url.includes('in_app_notifications'))!;
    expect(note.body).toMatchObject({ user_id: OWNER, kind: 'feedback', dedupe_key: expect.stringMatching(/^feedback:/) });
    const tg = calls.find(c => c.url.includes('/sendMessage'))!;
    expect(tg.url).toBe('https://relay.test/api/sendMessage');
    expect(tg.body.chat_id).toBe(777);
    expect(tg.body.text).toContain('Жалоба');
    expect(tg.body.text).toContain('Долго искали заказ');
    const mail = calls.find(c => c.url.includes('api.resend.com'))!;
    expect(mail.body.to).toEqual(['owner@example.ru']);
    expect(mail.body.html).toContain('Долго искали заказ');
  });

  it('Telegram и почта выключены у QR — уходит только в кабинет', async () => {
    const calls = mockServer({ boardRow: board({ notify_telegram: false, notify_email: false }) });
    const res = response();
    await handler(req('feedback-submit', { method: 'POST', query: { slug: SLUG }, body: { rating: 5 } }), res);
    expect(res.statusCode).toBe(201);
    expect(calls.some(c => c.url.includes('in_app_notifications'))).toBe(true);
    expect(calls.some(c => c.url.includes('/sendMessage'))).toBe(false);
    expect(calls.some(c => c.url.includes('api.resend.com'))).toBe(false);
  });

  it('сбой Telegram не ломает приём отзыва', async () => {
    const calls = mockServer();
    const inner = (globalThis.fetch as any).getMockImplementation();
    (globalThis.fetch as any).mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes('/sendMessage')) throw new Error('relay down');
      return inner(url, init);
    });
    const res = response();
    await handler(req('feedback-submit', { method: 'POST', query: { slug: SLUG }, body: { rating: 5, comment: 'Спасибо' } }), res);
    expect(res.statusCode).toBe(201);
    expect(calls.some(c => c.url.includes('api.resend.com'))).toBe(true);
  });

  it('не фото — 415', async () => {
    mockServer();
    const res = response();
    await handler(req('feedback-upload', { method: 'POST', query: { slug: SLUG }, body: Buffer.from('not an image at all') }), res);
    expect(res.statusCode).toBe(415);
  });

  it('фото: EXIF срезается, отзыв с фото уходит в Telegram альбомом через релей', async () => {
    const calls = mockServer();
    const up = response();
    await handler(req('feedback-upload', { method: 'POST', query: { slug: SLUG }, body: await photo() }), up);
    expect(up.statusCode).toBe(201);
    const { id, token } = up.body;
    const pending = join(process.env.FEEDBACK_PHOTO_DIR!, 'pending', `${id}.jpg`);
    const meta = await sharp(readFileSync(pending)).metadata();
    expect(meta.exif).toBeUndefined();
    expect(readFileSync(pending).includes(Buffer.from('SecretPhone'))).toBe(false);

    const res = response();
    await handler(req('feedback-submit', { method: 'POST', query: { slug: SLUG }, body: { rating: 3, comment: 'Повесьте крючок', photos: [{ id, token }] } }), res);
    expect(res.statusCode).toBe(201);
    expect(existsSync(pending)).toBe(false);
    expect(existsSync(join(process.env.FEEDBACK_PHOTO_DIR!, `${id}.jpg`))).toBe(true);
    const insert = calls.find(c => c.url.includes('feedback_entries') && c.method === 'POST')!;
    expect(insert.body).toMatchObject({ kind: 'idea', photos: [id] });
    const album = calls.find(c => c.url.includes('/sendMediaGroup'))!;
    expect(album.url).toBe('https://relay.test/api/sendMediaGroup');
    expect(album.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String((album.body as FormData).get('media')))[0].caption).toContain('Повесьте крючок');
    // Фото в письме — ссылками на наш сервер, не вложением: с VPS загрузка в Resend замирает на 128 КБ.
    const mail = calls.find(c => c.url.includes('api.resend.com'))!;
    expect(mail.body.attachments).toBeUndefined();
    expect(mail.body.html).toContain(`https://shk-wb.ru/api/feedback/photo/${id}?expires=`);
    expect(JSON.stringify(mail.body).length).toBeLessThan(64 * 1024);
    // Ссылка из письма открывает фото (подпись на 30 дней принимается).
    const link = new URL(mail.body.html.match(/src="([^"]+)"/)[1].replace(/&amp;/g, '&'));
    const view = response();
    await handler(req('feedback-photo', { query: { id, expires: link.searchParams.get('expires')!, token: link.searchParams.get('token')! } }), view);
    expect(view.statusCode).toBe(200);
    expect(view.headers['Content-Type']).toBe('image/jpeg');
  });

  it('чужой токен фото — 400 PHOTO_INVALID', async () => {
    mockServer();
    const res = response();
    await handler(req('feedback-submit', { method: 'POST', query: { slug: SLUG }, body: { rating: 5, photos: [{ id: 'a'.repeat(24), token: 'forged-token-value' }] } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PHOTO_INVALID');
  });

  it('фото для кабинета — только по подписанной ссылке', async () => {
    mockServer();
    const res = response();
    const expires = String(Math.floor(Date.now() / 1000) + 600);
    await handler(req('feedback-photo', { query: { id: 'a'.repeat(24), expires, token: 'wrong' } }), res);
    expect(res.statusCode).toBe(403);
    const ok = response();
    await handler(req('feedback-photo', { query: { id: 'a'.repeat(24), expires, token: feedback._test.sign(`fb-view:${'a'.repeat(24)}:${expires}`) } }), ok);
    expect(ok.statusCode).toBe(404);
  });
});

describe('QR-отзывы: кабинет владельца', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'pub';
    process.env.SUPABASE_SECRET_KEY = 'secret';
    process.env.FEEDBACK_SECRET = 'feedback-secret';
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const input = (design: Record<string, string>) => ({
    label: 'Дверь', place: 'ПВЗ', address: 'ул. Ленина, 24', headline: 'Как вам наш пункт?', note: '',
    design, notifyTelegram: true, notifyEmail: true, isActive: true,
  });

  it('без входа — 401', async () => {
    mockServer();
    const res = response();
    await handler(req('feedback-boards'), res);
    expect(res.statusCode).toBe(401);
  });

  it('слишком светлый свой цвет — 400 COLOR_TOO_LIGHT', async () => {
    mockServer();
    const res = response();
    await handler(req('feedback-boards', { method: 'POST', auth: true, body: input({ format: 'a5', theme: 'custom', color: '#ffd84d' }) }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('COLOR_TOO_LIGHT');
  });

  it('создание: slug из 8 знаков без похожих символов', async () => {
    const calls = mockServer();
    const res = response();
    await handler(req('feedback-boards', { method: 'POST', auth: true, body: input({ format: 'a6', theme: 'lilac', color: '#5b23c9' }) }), res);
    expect(res.statusCode).toBe(201);
    const insert = calls.find(c => c.url.includes('feedback_boards') && c.method === 'POST')!;
    expect(insert.body.slug).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(insert.body.user_id).toBe(OWNER);
    expect(res.body.url).toBe(`https://shk-wb.ru/o/${insert.body.slug}`);
  });

  it('не больше 10 QR на аккаунт', async () => {
    mockServer({ boards: Array.from({ length: 10 }, (_, i) => ({ id: String(i) })) });
    const res = response();
    await handler(req('feedback-boards', { method: 'POST', auth: true, body: input({ format: 'a5', theme: 'fuchsia', color: '#cb11ab' }) }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('BOARD_LIMIT');
  });

  it('чужой QR не изменить', async () => {
    mockServer({ boards: [] });
    const res = response();
    await handler(req('feedback-board', { method: 'PATCH', auth: true, query: { id: BOARD_ID }, body: input({ format: 'a5', theme: 'fuchsia', color: '#cb11ab' }) }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('QR-отзывы: общие правила', () => {
  it('контраст: фирменные цвета проходят, жёлтый — нет', () => {
    expect(feedback.contrastWithWhite('#cb11ab')).toBeGreaterThan(feedback.MIN_CONTRAST);
    expect(feedback.contrastWithWhite('#1d1a29')).toBeGreaterThan(feedback.MIN_CONTRAST);
    expect(feedback.contrastWithWhite('#ffd84d')).toBeLessThan(feedback.MIN_CONTRAST);
  });

  it('тип по оценке', () => {
    expect([1, 2, 3, 4, 5].map(feedback.kindForRating)).toEqual(['complaint', 'complaint', 'idea', 'thanks', 'thanks']);
  });

  it('маршруты есть в vercel.json, /o закрыт от индексации', () => {
    const config = JSON.parse(readFileSync(resolve(__dirname, '../../vercel.json'), 'utf8'));
    const sources = config.rewrites.map((r: { source: string }) => r.source);
    for (const path of ['/o/:slug', '/api/feedback/public/:slug', '/api/feedback/public/:slug/photo', '/api/feedback/public/:slug/submit', '/api/feedback/photo/:id', '/api/cabinet/feedback/boards', '/api/cabinet/feedback/boards/:id', '/api/cabinet/feedback/entries']) {
      expect(sources).toContain(path);
    }
    expect(JSON.stringify(config.headers)).toMatch(/\|r\|o[|)]/);
  });

  it('миграция: RLS и закрытые права', () => {
    const sql = readFileSync(resolve(__dirname, '../../supabase/migrations/20261122_feedback_boards.sql'), 'utf8');
    for (const table of ['feedback_boards', 'feedback_entries']) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${table} from anon, authenticated;`);
    }
    expect(sql).toContain("'pc_reply','feedback'");
    expect(sql.trim().startsWith('--')).toBe(true);
    expect(sql).toMatch(/\bbegin;[\s\S]*commit;\s*$/);
  });
});
