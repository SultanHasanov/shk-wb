import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PAGES, RELEASES, buildLlms, buildSitemap } from '../../build-seo.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('sitemap из PUBLIC_PAGES', () => {
  const xml = buildSitemap(PUBLIC_PAGES, '2026-10-29');

  it('включает /tarify и его казахскую пару', () => {
    expect(xml).toContain('<loc>https://shk-wb.ru/tarify</loc>');
    expect(xml).toContain('<loc>https://shk-wb.ru/kz/tarify</loc>');
  });

  it('у двуязычных страниц есть hreflang-пары', () => {
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="kk" href="https://shk-wb.ru/kz/tarify"/>');
    expect(xml).toContain('hreflang="x-default"');
  });

  it('юридические страницы на казахском не попадают (noindex)', () => {
    expect(xml).toContain('<loc>https://shk-wb.ru/cookie</loc>');
    expect(xml).not.toContain('/kz/cookie');
    expect(xml).not.toContain('/kz/offer');
  });

  it('lastmod берётся из переданной даты', () => {
    expect(xml).toContain('<lastmod>2026-10-29</lastmod>');
  });
});

describe('llms.txt из PUBLIC_PAGES', () => {
  it('содержит версии программ из releases.json и ссылку на sitemap', () => {
    const txt = buildLlms(PUBLIC_PAGES, RELEASES, {}, false);
    expect(txt).toContain(`Помощник ПВЗ ${RELEASES.pvzHelper}`);
    expect(txt).toContain(`Печать ячеек ${RELEASES.cellPrint}`);
    expect(txt).toContain('https://shk-wb.ru/sitemap.xml');
  });

  it('full-версия добавляет собранный FAQ', () => {
    const faq = { '/': { mainEntity: [{ name: 'Как это работает?', acceptedAnswer: { text: 'Очень просто.' } }] } };
    const full = buildLlms(PUBLIC_PAGES, RELEASES, faq, true);
    expect(full).toContain('## Вопросы и ответы');
    expect(full).toContain('### Как это работает?');
    expect(full).toContain('Очень просто.');
  });
});

describe('robots.txt', () => {
  const robots = readFileSync(resolve(root, 'robots.txt'), 'utf8');

  it('явно разрешает ИИ-краулеров', () => {
    for (const bot of ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'YandexAdditional'])
      expect(robots).toContain(`User-agent: ${bot}`);
  });

  it('закрывает приватные разделы и указывает sitemap', () => {
    expect(robots).toContain('Disallow: /cabinet');
    expect(robots).toContain('Disallow: /api/');
    expect(robots).toContain('Disallow: /payment-result');
    expect(robots).toContain('Sitemap: https://shk-wb.ru/sitemap.xml');
  });
});

describe('версии программ в JSON-LD', () => {
  it('SoftwareApplication берёт версию из releases.json', () => {
    expect(PUBLIC_PAGES['/program'].graph[0].softwareVersion).toBe(RELEASES.pvzHelper);
    expect(PUBLIC_PAGES['/cell-print'].graph[0].softwareVersion).toBe(RELEASES.cellPrint);
  });
});
