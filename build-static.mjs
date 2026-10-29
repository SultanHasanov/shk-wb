import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { GOOGLE_SITE_VERIFICATION, KZ_PREFIX, ORIGIN, PUBLIC_PAGES, RELEASES, SITE_NAME, buildLlms, buildSitemap, localizeGraph } from './build-seo.mjs';

const output = resolve('dist');

function copyDirectory(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else copyFileSync(from, to);
  }
}
// css/ и js/ нужны не публичным страницам, а админке: admin-enigma/index.html
// подключает ../css/style.css и десяток ../js/*-admin.js.
for (const directory of ['admin-enigma', 'images', 'css', 'js']) {
  if (existsSync(directory)) copyDirectory(directory, resolve(output, directory));
}
// Платные установщики никогда не попадают в публичный dist. Публичным остаётся
// только манифест версии, а бинарники выдаёт авторизованный платёжный API.
if (existsSync('downloads/version.json')) {
  mkdirSync(resolve(output, 'downloads'), { recursive: true });
  copyFileSync('downloads/version.json', resolve(output, 'downloads/version.json'));
}
// offer.html, privacy.html и payment-result.html больше не копируются: это
// маршруты React (/offer, /privacy, /payment-result), а старые файлы перекрыли
// бы их собой — Vercel отдаёт файл раньше, чем применяет rewrite.
// sitemap.xml здесь больше не копируется: он генерируется из PUBLIC_PAGES в
// конце сборки (см. ниже) — так он не разойдётся со списком страниц.
for (const file of ['robots.txt', 'favicon.ico']) {
  if (existsSync(file)) copyFileSync(file, resolve(output, file));
}

/* Файлы подтверждения прав в Вебмастере и Search Console. Имена у каждого
   ресурса свои, поэтому берутся по маске: чтобы подтвердить права заново,
   достаточно положить новый файл в корень проекта.

   Знайте про грабли: cleanUrls отвечает на /googleXXXX.html редиректом 308 на
   /googleXXXX. И Яндекс, и Google по нему проходят — права подтверждены обоими
   способом «файл», — но если однажды проверка сорвётся, причина будет тут.
   Тогда обход такой: класть файл в подпапку и добавить в vercel.json rewrite с
   корневого адреса, чтобы редиректу нечего было перехватывать. */
for (const file of readdirSync('.').filter(name =>
  /^(google[0-9a-z]+|yandex_[0-9a-f]+)\.html$/i.test(name),
)) {
  copyFileSync(file, resolve(output, file));
  console.log(`подтверждение прав: ${file}`);
}

/* ============ Пререндер ============
   Раньше публичным маршрутам доставался голый шаблон Vite: 838 байт с пустым
   <div id="root">. Робот Яндекса JS исполняет ограниченно, поэтому весь текст
   сайта — заголовки, описания, FAQ — для поиска просто исчез. Здесь собранный
   сайт открывается в Chromium, и в файл сохраняется уже отрисованный HTML. */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/**
 * Статика из dist с SPA-фолбэком: любой неизвестный путь отдаёт index.html.
 *
 * Шаблон читается один раз в память. Иначе выходит самоотравление: пререндер «/»
 * перезаписывает dist/index.html, и следующий маршрут стартует уже с чужой
 * разметкой — с чужим JSON-LD, счётчиком и заголовками.
 */
function startStaticServer(root) {
  const shell = readFileSync(resolve(root, 'index.html'));
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const candidate = resolve(root, `.${path}`);
    const isFile =
      candidate.startsWith(root) &&
      candidate !== resolve(root, 'index.html') &&
      existsSync(candidate) &&
      statSync(candidate).isFile();
    response.writeHead(200, {
      'Content-Type': isFile ? (MIME[extname(candidate)] ?? 'application/octet-stream') : MIME['.html'],
    });
    response.end(isFile ? readFileSync(candidate) : shell);
  });
  return new Promise(done => {
    server.listen(0, '127.0.0.1', () =>
      done({ origin: `http://127.0.0.1:${server.address().port}`, server }),
    );
  });
}

/**
 * FAQ-разметка собирается из отрисованного аккордеона (ui/index.tsx рендерит
 * <details><summary>вопрос</summary><div>ответ</div></details>), а не из
 * отдельного списка в коде сборки. Так FAQPage не может разойтись с тем, что
 * видит посетитель, — а расхождение поисковики считают нарушением.
 */
async function extractFaq(page) {
  const items = await page.$$eval('details', nodes =>
    nodes
      .map(node => {
        const summary = node.querySelector('summary');
        const answer = summary?.nextElementSibling;
        return {
          q: (summary?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          a: (answer?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        };
      })
      .filter(item => item.q && item.a),
  );
  if (items.length < 2) return null;
  return {
    '@type': 'FAQPage',
    mainEntity: items.map(item => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Приводит <head> отрисованной страницы к виду, который был у статики.
 *
 * title, description и og:title/og:description берутся из самой страницы —
 * их проставил useDocumentMeta. Всё остальное React не выставляет: canonical он
 * пишет от адреса сборочного сервера (127.0.0.1), поэтому его перезаписываем.
 */
function pageUrl(route, locale) {
  if (locale === 'kk') return `${ORIGIN}${KZ_PREFIX}${route === '/' ? '' : route}`;
  return route === '/' ? `${ORIGIN}/` : `${ORIGIN}${route}`;
}

function injectSeo(html, route, faq, override, locale = 'ru') {
  const page = PUBLIC_PAGES[route];
  const url = pageUrl(route, locale);
  const title = override?.title ?? html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? SITE_NAME;
  const description =
    override?.description ?? html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
  const image = `${ORIGIN}${page.image.path}`;
  const imageType = page.image.path.endsWith('.jpg') || page.image.path.endsWith('.jpeg')
    ? 'image/jpeg'
    : page.image.path.endsWith('.webp') ? 'image/webp' : 'image/png';
  const baseGraph = locale === 'kk' ? localizeGraph(page.graph) : page.graph;
  const graph = faq ? [...baseGraph, faq] : baseGraph;
  // Юридические тексты на казахской версии остаются русскими (официальная
  // редакция одна) — в индекс их не отдаём, чтобы не плодить дубли.
  const indexable = !(locale === 'kk' && page.legal);

  const head = [
    `<link rel="canonical" href="${url}"/>`,
    // Пары языковых версий: без hreflang поиск считает /kz-страницы дублями.
    indexable
      ? [
          `<link rel="alternate" hreflang="ru" href="${pageUrl(route, 'ru')}"/>`,
          `<link rel="alternate" hreflang="kk" href="${pageUrl(route, 'kk')}"/>`,
          `<link rel="alternate" hreflang="x-default" href="${pageUrl(route, 'ru')}"/>`,
        ].join('')
      : '',
    indexable
      ? '<meta name="robots" content="index, follow, max-image-preview:large"/>'
      : '<meta name="robots" content="noindex, follow"/>',
    `<meta property="og:type" content="${page.ogType}"/>`,
    `<meta property="og:locale" content="${locale === 'kk' ? 'kk_KZ' : 'ru_RU'}"/>`,
    `<meta property="og:locale:alternate" content="${locale === 'kk' ? 'ru_RU' : 'kk_KZ'}"/>`,
    `<meta property="og:site_name" content="${escapeAttribute(SITE_NAME)}"/>`,
    `<meta property="og:title" content="${escapeAttribute(title)}"/>`,
    `<meta property="og:description" content="${escapeAttribute(description)}"/>`,
    `<meta property="og:url" content="${url}"/>`,
    `<meta property="og:image" content="${image}"/>`,
    `<meta property="og:image:type" content="${imageType}"/>`,
    `<meta property="og:image:width" content="${page.image.width}"/>`,
    `<meta property="og:image:height" content="${page.image.height}"/>`,
    `<meta property="og:image:alt" content="${escapeAttribute(page.image.alt)}"/>`,
    // Google проверяет только заявленный адрес, но тег ставится на все страницы:
    // так подтверждение переживёт смену главной, к которой привязан ресурс.
    GOOGLE_SITE_VERIFICATION
      ? `<meta name="google-site-verification" content="${escapeAttribute(GOOGLE_SITE_VERIFICATION)}"/>`
      : '',
    '<meta name="twitter:card" content="summary_large_image"/>',
    `<meta name="twitter:image" content="${image}"/>`,
    `<meta name="twitter:image:alt" content="${escapeAttribute(page.image.alt)}"/>`,
    `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': graph,
    })}</script>`,
  ].join('');

  // Пиксель для браузеров без JS: в статике он стоял на каждой странице.
  const pixel =
    '<noscript><div><img src="https://mc.yandex.ru/watch/111723088" style="position:absolute;left:-9999px" alt=""/></div></noscript>';

  return html
    .replace(/<html([^>]*)\slang="[^"]*"/i, `<html$1 lang="${locale === 'kk' ? 'kk' : 'ru'}"`)
    // canonical и og:* уже могли попасть в DOM из useDocumentMeta — снимаем их,
    // чтобы не оставить в файле два разных canonical.
    .replace(/<link rel="canonical"[^>]*>/gi, '')
    .replace(/<meta property="og:(?:title|description)"[^>]*>/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeAttribute(title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*"\s*\/?>/,
      `<meta name="description" content="${escapeAttribute(description)}"/>`,
    )
    .replace('</head>', `${head}</head>`)
    .replace(/(<body[^>]*>)/i, `$1${pixel}`);
}

/**
 * Системные библиотеки Chromium на сборочном образе Vercel (Amazon Linux).
 *
 * Сам браузер туда скачивается postinstall'ом playwright, но стартовать ему
 * нечем: `chrome-headless-shell: error while loading shared libraries:
 * libnspr4.so`. `playwright install --with-deps` тут не помощник — он знает
 * только Ubuntu и Debian, а на Amazon Linux отказывается работать.
 *
 * Ошибки давятся намеренно: если dnf недоступен или прав нет, остаётся
 * аварийный путь ниже, и деплой всё равно доедет.
 */
const CHROMIUM_LIBS = [
  'nss', 'nspr', 'atk', 'at-spi2-atk', 'at-spi2-core', 'cups-libs', 'libdrm',
  'libX11', 'libXcomposite', 'libXdamage', 'libXext', 'libXfixes', 'libXrandr',
  'libxcb', 'libxkbcommon', 'mesa-libgbm', 'pango', 'cairo', 'alsa-lib', 'expat',
];

function installChromiumLibs() {
  if (process.platform !== 'linux') return;
  const packages = CHROMIUM_LIBS.join(' ');
  try {
    execSync(`(dnf install -y ${packages} || yum install -y ${packages}) 2>&1 | tail -3`, {
      stdio: 'inherit',
    });
  } catch {
    console.warn('Системные библиотеки поставить не удалось — пробую запустить как есть.');
  }
}

/**
 * Пререндер требует Chromium, а он может не подняться на сборочной машине.
 * Ронять из-за этого деплой нельзя, поэтому браузер и его библиотеки ставятся
 * по требованию, а при неудаче страницы собираются из пустой оболочки — как до
 * появления пререндера. Разметка при этом остаётся полной, теряется только
 * текст, и об этом надо кричать: молча выкатить восемь пустых страниц мы уже
 * один раз успели.
 */
async function launchChromium() {
  try {
    return await chromium.launch();
  } catch {
    console.warn('Chromium не запустился, доустанавливаю браузер и библиотеки…');
  }
  try {
    installChromiumLibs();
    execSync('npx playwright install chromium', { stdio: 'inherit' });
    return await chromium.launch();
  } catch (error) {
    console.warn(`\n⚠ ПРЕРЕНДЕР НЕ ВЫПОЛНЕН: ${error.message}`);
    console.warn('⚠ Публичные страницы уйдут без текста — поиск увидит пустые оболочки.\n');
    return null;
  }
}

const shellHtml = readFileSync(resolve(output, 'index.html'), 'utf8');

/** Каждая публичная страница снимается дважды: русская и казахская (/kz). */
const LOCALIZED_ROUTES = Object.keys(PUBLIC_PAGES).flatMap(route => [[route, 'ru'], [route, 'kk']]);
const browser = await launchChromium();

// Снимки копятся в памяти и пишутся после обхода: файл, записанный на середине
// цикла, не должен попасться серверу как ответ на следующий маршрут.
const snapshots = [];
// FAQ, снятый с русской версии каждого маршрута, — для llms-full.txt.
const faqByRoute = {};

if (browser) {
  const { origin, server } = await startStaticServer(output);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // Бандл собран в PROD-режиме, поэтому без этого флага каждая сборка стреляла бы
  // хитом в Метрику и записывала визит в Supabase (см. src/lib/prerender.ts).
  await context.addInitScript(() => {
    window.__PRERENDER__ = true;
  });

  const page = await context.newPage();
  // Внешние домены и API в снапшот не нужны: компоненты с данными (объявление,
  // счётчик сгенерированных) при отсутствии ответа не рендерятся вовсе, и в файл
  // попадает только статический текст.
  await page.route('**/*', route => {
    const target = new URL(route.request().url());
    if (target.origin !== origin || target.pathname.startsWith('/api/')) return route.abort();
    return route.continue();
  });

  for (const [route, locale] of LOCALIZED_ROUTES) {
    const address = locale === 'kk' ? `${KZ_PREFIX}${route === '/' ? '' : route}` : route;
    await page.goto(`${origin}${address}`, { waitUntil: 'load' });
    // Ждём именно заголовок страницы, а не любой узел в #root: оболочка с
    // шапкой рендерится сразу, и по '#root > *' снимок мог бы уйти в файл до
    // того, как отрисуется содержимое маршрута.
    await page.waitForSelector('main h1', { timeout: 15000 });
    // Хвост микрозадач react-query и эффектов useDocumentMeta.
    await page.waitForTimeout(300);

    const faq = await extractFaq(page);
    if (locale === 'ru' && faq) faqByRoute[route] = faq;
    const html = injectSeo(await page.content(), route, faq, undefined, locale);
    snapshots.push([address, html]);
  }

  await browser.close();
  server.close();
} else {
  for (const [route, locale] of LOCALIZED_ROUTES) {
    const address = locale === 'kk' ? `${KZ_PREFIX}${route === '/' ? '' : route}` : route;
    snapshots.push([address, injectSeo(shellHtml, route, null, PUBLIC_PAGES[route].fallback, locale)]);
  }
}

for (const [route, html] of snapshots) {
  const file = route === '/' ? 'index.html' : `${route.slice(1)}.html`;
  mkdirSync(dirname(resolve(output, file)), { recursive: true });
  writeFileSync(resolve(output, file), html);
  console.log(`${browser ? 'prerender' : 'оболочка'} ${route} → dist/${file} (${html.length} байт)`);
}

/* ============ sitemap.xml, llms.txt, llms-full.txt ============
   Генерируются из PUBLIC_PAGES (buildSitemap/buildLlms в build-seo.mjs, там же
   их берёт тест seo-build.test.ts), чтобы не вести список страниц руками. */

/** Дата последнего коммита (committer date, YYYY-MM-DD) для lastmod. При
 *  отсутствии git (локальная распаковка без истории) — сегодня. Shallow-клон
 *  даёт дату последнего доступного коммита, этого для lastmod достаточно. */
function lastCommitDate() {
  try {
    return execSync('git log -1 --format=%cs', { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const sitemapDate = lastCommitDate();
writeFileSync(resolve(output, 'sitemap.xml'), buildSitemap(PUBLIC_PAGES, sitemapDate));
writeFileSync(resolve(output, 'llms.txt'), buildLlms(PUBLIC_PAGES, RELEASES, faqByRoute, false));
writeFileSync(resolve(output, 'llms-full.txt'), buildLlms(PUBLIC_PAGES, RELEASES, faqByRoute, true));
console.log(`sitemap.xml, llms.txt, llms-full.txt → dist/ (lastmod ${sitemapDate || 'сегодня'})`);
