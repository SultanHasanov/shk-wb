// Релей Telegram Bot API для сервера shk-wb.ru. С VPS в РФ api.telegram.org и адреса Vercel
// недоступны (с 20.10.2026 заблокирован и прежний релей tg-relay-three.vercel.app), а Supabase
// доступен. Протокол тот же, что у старого релея (server/_telegram-api.js, TELEGRAM_API_BASE):
//   POST <base>/api/<метод>   Authorization: Bearer <токен бота>, тело JSON или multipart → api.telegram.org
//   GET  <base>/media?url=…   картинки и PDF стикеров shk-wb.ru для sendPhoto/sendDocument
//   GET  <base>/file?path=…   файл из сообщения (фото с ШК), Bearer-токен бота
// Деплой: npx supabase functions deploy tg-relay --no-verify-jwt (Telegram забирает media без JWT).
// Секрет ALLOWED_BOT_IDS — id ботов через запятую (часть токена до «:»), чужие токены не пропускаем.

const allowedBots = new Set(
  String(Deno.env.get('ALLOWED_BOT_IDS') || '').split(',').map(id => id.trim()).filter(Boolean),
);

const MEDIA_PATHS = new Set(['/api/stickers/image', '/api/stickers/pdf']);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function allowedToken(req: Request) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token) && allowedBots.has(token.split(':')[0]) ? token : null;
}

async function relayMethod(req: Request, method: string) {
  const token = allowedToken(req);
  if (!token) {
    return json(401, { ok: false, description: 'Bot is not allowed' });
  }
  // JSON — как раньше; multipart/form-data (загрузка фото/файла) пропускаем как есть, с исходным Content-Type.
  const contentType = req.headers.get('content-type') || 'application/json';
  const multipart = contentType.startsWith('multipart/form-data');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': multipart ? contentType : 'application/json' },
    body: multipart ? await req.arrayBuffer() : (await req.text() || '{}'),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('content-type') || 'application/json' },
  });
}

async function relayMedia(url: URL) {
  let target: URL;
  try {
    target = new URL(url.searchParams.get('url') || '');
  } catch {
    return json(400, { error: 'Bad url' });
  }
  if (target.protocol !== 'https:' || target.hostname !== 'shk-wb.ru' || !MEDIA_PATHS.has(target.pathname)) {
    return json(403, { error: 'Url is not allowed' });
  }
  const response = await fetch(target.toString());
  const headers = new Headers();
  for (const name of ['content-type', 'content-disposition', 'content-length', 'cache-control']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

// Файл из сообщения (фото с ШК): GET <base>/file?path=<file_path из getFile>, Bearer-токен бота.
async function relayFile(req: Request, url: URL) {
  const token = allowedToken(req);
  if (!token) return json(401, { ok: false, description: 'Bot is not allowed' });
  const filePath = url.searchParams.get('path') || '';
  if (!/^[A-Za-z0-9_./-]{1,256}$/.test(filePath) || filePath.includes('..')) return json(400, { error: 'Bad path' });
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const headers = new Headers();
  for (const name of ['content-type', 'content-length']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

Deno.serve(async req => {
  const url = new URL(req.url);
  const method = /\/api\/([A-Za-z]{2,64})$/.exec(url.pathname)?.[1];
  if (method && req.method === 'POST') return relayMethod(req, method);
  if (/\/file$/.test(url.pathname) && req.method === 'GET') return relayFile(req, url);
  if (/\/media$/.test(url.pathname) && req.method === 'GET') return relayMedia(url);
  return json(404, { error: 'Not found' });
});
