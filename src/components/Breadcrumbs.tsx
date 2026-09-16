import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
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
const TITLES: Record<string, string> = {
  'cell-print': 'Печать ячеек',
  program: 'Подбор кодов',
  'vozvratnye-stikery-wb': 'Возвратные стикеры',
  'qr-korobov-wb': 'QR коробов WB',
  contacts: 'Контакты',
  offer: 'Публичная оферта',
  privacy: 'Политика конфиденциальности',
  cookie: 'Использование cookie',
};

export function Breadcrumbs() {
  const { pathname } = useLocation();
  const segment = pathname.replace(/^\/|\/$/g, '');
  const title = TITLES[segment];

  // На главной крошки не нужны, на служебных страницах — не заданы.
  if (!title) return null;

  return (
    <nav className={s.crumbs} aria-label="Хлебные крошки">
      <ol>
        <li>
          <Link to="/">Главная</Link>
          <ChevronRight size={14} aria-hidden="true" />
        </li>
        <li aria-current="page">{title}</li>
      </ol>
    </nav>
  );
}
