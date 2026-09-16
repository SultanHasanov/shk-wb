import { useEffect } from 'react';

/**
 * Пер-страничные title/description/canonical.
 *
 * Отдельная зависимость (react-helmet-async) здесь не окупается: страниц
 * десяток, а нужно ровно три тега. Раньше их не было вовсе — весь сайт отдавал
 * один <title> из index.html, одинаковый и для оферты, и для генератора.
 *
 * ВАЖНО: это client-side. Поисковый робот, не исполняющий JS, увидит дефолт из
 * index.html — для индексации понадобится пререндер в build-static.mjs.
 */

export const SITE_NAME = 'ШК ВБ';

function upsertMeta(attribute: 'name' | 'property', key: string, content: string) {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attribute, key);
    document.head.appendChild(tag);
  }
  tag.content = content;
}

function upsertCanonical(href: string) {
  let tag = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!tag) {
    tag = document.createElement('link');
    tag.rel = 'canonical';
    document.head.appendChild(tag);
  }
  tag.href = href;
}

export function useDocumentMeta(title: string, description?: string) {
  useEffect(() => {
    // На главной второй раз имя сайта не повторяем
    const full = title === SITE_NAME ? title : `${title} — ${SITE_NAME}`;
    document.title = full;
    upsertMeta('property', 'og:title', full);

    if (description) {
      upsertMeta('name', 'description', description);
      upsertMeta('property', 'og:description', description);
    }

    upsertCanonical(window.location.origin + window.location.pathname);
  }, [title, description]);
}
