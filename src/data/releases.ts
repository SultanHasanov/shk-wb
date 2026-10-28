import releases from './releases.json';

/**
 * Актуальные версии настольных программ в одном месте. Раньше номер версии был
 * зашит отдельной константой на каждой странице и устаревал (ProgramPage висел
 * на 1.4.2 при боевой 1.6.6). JSON читают и build-seo.mjs/llms при сборке.
 *
 * Это витринный номер для текста страниц; механизм обновления программ живёт
 * на сервере (latest.json), и downloads/version.json здесь не затрагивается.
 */
export const RELEASES: { pvzHelper: string; cellPrint: string } = releases;
