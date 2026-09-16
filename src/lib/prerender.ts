/**
 * Флаг сборочного пререндера.
 *
 * build-static.mjs открывает собранный сайт в Chromium и сохраняет готовый HTML,
 * чтобы роботу доставался текст, а не пустой <div id="root">. Внутри этого
 * прогона нельзя выполнять побочные эффекты, которые видны снаружи: хит в
 * Метрику и запись визита в Supabase на каждой сборке испортили бы статистику.
 *
 * Флаг выставляется через page.addInitScript() до загрузки бандла.
 */
declare global {
  interface Window {
    __PRERENDER__?: boolean;
  }
}

export function isPrerender(): boolean {
  return typeof window !== 'undefined' && window.__PRERENDER__ === true;
}
