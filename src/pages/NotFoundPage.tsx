import { Link } from 'react-router-dom';
import { ArrowRight, Compass } from 'lucide-react';
import { Button, Card } from '../ui';
import { useDocumentMeta } from '../lib/seo';
import s from './NotFoundPage.module.css';

const LINKS = [
  { to: '/', label: 'Генератор стикеров', text: 'Возвратные ШК и QR-коды коробок онлайн' },
  { to: '/cell-print', label: 'Печать ячеек', text: 'Автопечать этикетки после скана товара' },
  { to: '/program', label: 'Подбор кодов', text: 'Код клиента по номеру ячейки' },
  { to: '/contacts', label: 'Контакты', text: 'Написать в поддержку' },
] as const;

/**
 * Раньше несуществующий адрес молча редиректил на главную: человек не понимал,
 * ошибся он в ссылке или страницу убрали, а поисковик получал 200 вместо 404.
 */
export function NotFoundPage() {
  useDocumentMeta('Страница не найдена');

  return (
    <div className="page">
      <div className={s.wrap}>
        <Compass size={48} className={s.icon} aria-hidden="true" />
        <p className="eyebrow">Ошибка 404</p>
        <h1>Такой страницы нет</h1>
        <p className={s.text}>
          Возможно, адрес набран с опечаткой или страница переехала. Вот что есть на сайте:
        </p>

        <div className={s.links}>
          {LINKS.map(link => (
            <Link key={link.to} to={link.to} className={s.linkCard}>
              <Card interactive>
                <strong className={s.linkTitle}>
                  {link.label}
                  <ArrowRight size={16} aria-hidden="true" />
                </strong>
                <span className={s.linkText}>{link.text}</span>
              </Card>
            </Link>
          ))}
        </div>

        <div className={s.actions}>
          <Link to="/">
            <Button size="lg">Вернуться на главную</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
