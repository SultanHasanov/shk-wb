import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { stripLocale, type Text, useLocale, useLocalePath, useT } from '../i18n';
import s from './Breadcrumbs.module.css';

/**
 * Видимые хлебные крошки.
 *
 * BreadcrumbList в JSON-LD уже отдаётся из build-seo.mjs, но разметка без
 * видимого аналога на странице — повод для поиска её проигнорировать. Заодно
 * это второй внутренний путь на главную с каждой страницы.
 *
 * Названия совпадают с теми, что уходят в микроразметку: расхождение между
 * видимой крошкой и структурированной — ошибка в Вебмастере.
 */
const TITLES: Record<string, Text> = {
  'cell-print': { ru: 'Печать ячеек', kk: 'Ұяшық басып шығару' },
  program: { ru: 'Подбор кодов', kk: 'Кодтарды іріктеу' },
  'vozvratnye-stikery-wb': { ru: 'Возвратные стикеры', kk: 'Қайтару стикерлері' },
  'qr-korobov-wb': { ru: 'QR коробов WB', kk: 'WB қорап QR-кодтары' },
  contacts: { ru: 'Контакты', kk: 'Байланыс' },
  offer: { ru: 'Публичная оферта', kk: 'Жария оферта' },
  privacy: { ru: 'Политика конфиденциальности', kk: 'Құпиялылық саясаты' },
  cookie: { ru: 'Использование cookie', kk: 'Cookie пайдалану' },
};

export function Breadcrumbs() {
  const { pathname } = useLocation();
  const t = useT();
  const locale = useLocale();
  const lp = useLocalePath();
  const segment = stripLocale(pathname).replace(/^\/|\/$/g, '');
  const title = TITLES[segment]?.[locale];

  // На главной крошки не нужны, на служебных страницах — не заданы.
  if (!title) return null;

  return (
    <nav className={s.crumbs} aria-label={t('Хлебные крошки', 'Навигация жолы')}>
      <ol>
        <li>
          <Link to={lp('/')}>{t('Главная', 'Басты бет')}</Link>
          <ChevronRight size={14} aria-hidden="true" />
        </li>
        <li aria-current="page">{title}</li>
      </ol>
    </nav>
  );
}
