// Запуск сайта на обычном VPS вместо Vercel. Повторяет то, что делает
// платформа по vercel.json: redirects → headers → файлы из dist (cleanUrls)
// и функции из api/ → rewrites. Обработчики api/*.js не меняются: Express
// даёт им тот же интерфейс req.query/req.body/res.status().json().send().
const fs = require('fs');
const path = require('path');
const express = require('express');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const apiDir = path.join(root, 'api');
const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const port = Number(process.env.PORT || 3000);

// Индекс скобки, закрывающей ту, что стоит в source[start]; учитывает вложенные
// группы вроде "((?!api/).*)".
function closingParen(source, start) {
  for (let depth = 0, i = start; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return i;
  }
  throw new Error(`Unbalanced parentheses in vercel.json pattern: ${source}`);
}

// Шаблон Vercel (":id", ":path*", ":section(a|b)", "(.*)") → RegExp.
function compile(source) {
  let pattern = '';
  for (let i = 0; i < source.length; ) {
    const param = /^\/:(\w+)/.exec(source.slice(i));
    if (param) {
      const name = param[1];
      i += param[0].length;
      let body = '[^/]+';
      if (source[i] === '(') {
        const end = closingParen(source, i);
        body = source.slice(i + 1, end);
        i = end + 1;
      }
      const star = source[i] === '*';
      if (star) {
        if (body === '[^/]+') body = '.*';
        i += 1;
      }
      pattern += star ? `(?:/(?<${name}>${body}))?` : `/(?<${name}>${body})`;
    } else if (source[i] === '(') {
      const end = closingParen(source, i);
      pattern += source.slice(i, end + 1);
      i = end + 1;
    } else {
      pattern += source[i].replace(/[.+?^${}|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

// Условия "has" из vercel.json. Поддерживается только host — остальные типы
// здесь не используются, и правило с ними не применяется вовсе.
function conditionsMet(rule, req) {
  if (!rule.has) return true;
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  return rule.has.every((condition) => condition.type === 'host' && condition.value.toLowerCase() === host);
}

function substitute(destination, match) {
  return destination.replace(/:(\w+)/g, (whole, name) =>
    // Значения берутся из уже закодированного pathname — повторно не кодируем.
    match.groups && name in match.groups ? match.groups[name] || '' : whole,
  );
}

const redirects = (config.redirects || []).map((rule) => ({ ...rule, re: compile(rule.source) }));
const headers = (config.headers || []).map((rule) => ({ ...rule, re: compile(rule.source) }));
const rewrites = (config.rewrites || []).map((rule) => ({ ...rule, re: compile(rule.source) }));

// Функции грузятся один раз, как тёплый инстанс на Vercel.
const handlers = new Map();
function apiHandler(pathname) {
  if (!pathname.startsWith('/api/')) return null;
  const relative = pathname.slice(5);
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/i.test(relative) || relative.split('/').some((part) => part.startsWith('_'))) return null;
  const file = path.join(apiDir, `${relative}.js`);
  if (!handlers.has(file)) handlers.set(file, fs.existsSync(file) ? require(file) : null);
  return handlers.get(file);
}

function staticFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidates = pathname === '/' ? ['index.html'] : [decoded.slice(1), `${decoded.slice(1)}.html`, `${decoded.slice(1)}/index.html`];
  for (const candidate of candidates) {
    const file = path.join(dist, candidate);
    if (!file.startsWith(dist + path.sep)) return null;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  const url = new URL(req.originalUrl, 'http://localhost');
  let pathname = url.pathname;

  for (const rule of redirects) {
    if (!conditionsMet(rule, req)) continue;
    const match = rule.re.exec(pathname);
    if (match) return res.redirect(rule.permanent ? 308 : 307, substitute(rule.destination, match) + url.search);
  }
  // cleanUrls + trailingSlash:false — канонический адрес без .html и без слэша.
  if (pathname.length > 1 && pathname.endsWith('/')) return res.redirect(308, pathname.replace(/\/+$/, '') + url.search);
  if (pathname.endsWith('.html')) {
    const clean = pathname === '/index.html' ? '/' : pathname.slice(0, -5);
    if (staticFile(pathname)) return res.redirect(308, clean + url.search);
  }

  for (const rule of headers) if (conditionsMet(rule, req) && rule.re.test(pathname)) for (const { key, value } of rule.headers) res.setHeader(key, value);

  // Как на Vercel: сначала файловая система (статика и функции), потом rewrites.
  if (!staticFile(pathname) && !apiHandler(pathname)) {
    for (const rule of rewrites) {
      if (!conditionsMet(rule, req)) continue;
      const match = rule.re.exec(pathname);
      if (!match) continue;
      const target = new URL(substitute(rule.destination, match), 'http://localhost');
      for (const [key, value] of url.searchParams) if (!target.searchParams.has(key)) target.searchParams.append(key, value);
      pathname = target.pathname;
      req.url = pathname + target.search;
      // Express разбирает query до этого middleware — пересобираем после rewrite.
      req.query = Object.fromEntries(target.searchParams);
      break;
    }
  }
  req.resolvedPath = pathname;
  next();
});

// Vercel разбирает тело по Content-Type и держит лимит 4.5 МБ.
const limit = '4.5mb';
app.use(express.json({ limit, type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ limit, extended: true }));
app.use(express.text({ limit, type: 'text/*' }));
app.use(express.raw({ limit, type: 'application/octet-stream' }));
app.use((error, req, res, next) => {
  if (error && (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')) {
    return res.status(error.status || 400).json({ error: 'Invalid request body' });
  }
  next(error);
});

app.use(async (req, res, next) => {
  const handler = apiHandler(req.resolvedPath);
  if (!handler) return next();
  try {
    await handler(req, res);
  } catch (error) {
    console.error(`[api] ${req.method} ${req.resolvedPath}`, error);
    if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const file = staticFile(req.resolvedPath);
  if (!file) return next();
  // Файлы из assets/ собирает Vite с хэшем в имени — их можно кэшировать навсегда.
  const immutable = req.resolvedPath.startsWith('/assets/')
    || (req.resolvedPath.startsWith('/images/') && /\.(?:webp|jpg)$/i.test(req.resolvedPath));
  res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
  res.sendFile(file, { dotfiles: 'deny', lastModified: true, cacheControl: false });
});

app.use((req, res) => res.status(404).type('text/plain').send('404: NOT_FOUND'));

app.listen(port, '127.0.0.1', () => console.log(`shk-wb listening on 127.0.0.1:${port}`));
