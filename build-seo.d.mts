// Типы для build-seo.mjs: файл не входит в tsconfig (include=src), поэтому при
// импорте из теста (src/api/seo-build.test.ts) tsc -b требует объявления, иначе
// TS7016 валит сборку. Описываем только то, что импортирует тест.
export const PUBLIC_PAGES: Record<
  string,
  {
    fallback: { title: string; description: string };
    legal?: boolean;
    graph: Array<Record<string, unknown>>;
    [key: string]: unknown;
  }
>;
export const RELEASES: { pvzHelper: string; cellPrint: string };
export function buildSitemap(pages: typeof PUBLIC_PAGES, lastmod?: string | null): string;
export function buildLlms(
  pages: typeof PUBLIC_PAGES,
  releases: { pvzHelper: string; cellPrint: string },
  faqByRoute: Record<string, { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> }> | null,
  full: boolean,
): string;
