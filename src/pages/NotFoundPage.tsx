import { Link } from 'react-router-dom';
import { ArrowRight, Compass } from 'lucide-react';
import { Button, Card } from '../ui';
import { useDocumentMeta } from '../lib/seo';
import { type T, useLocalePath, useT } from '../i18n';
import s from './NotFoundPage.module.css';

const links = (t: T) => [
  { to: '/', label: t('Генератор стикеров', 'Стикер генераторы'), text: t('Возвратные ШК и QR-коды коробок онлайн', 'Қайтару ШК мен қорап QR-кодтары онлайн') },
  { to: '/cell-print', label: t('Печать ячеек', 'Ұяшық басып шығару'), text: t('Автопечать этикетки после скана товара', 'Тауарды сканерлегеннен кейін заттаңбаны автоматты басу') },
  { to: '/program', label: t('Подбор кодов', 'Кодтарды іріктеу'), text: t('Код клиента по номеру ячейки', 'Ұяшық нөмірі бойынша клиент коды') },
  { to: '/contacts', label: t('Контакты', 'Байланыс'), text: t('Написать в поддержку', 'Қолдау қызметіне жазу') },
];

/**
 * Раньше несуществующий адрес молча редиректил на главную: человек не понимал,
 * ошибся он в ссылке или страницу убрали, а поисковик получал 200 вместо 404.
 */
export function NotFoundPage() {
  const t = useT();
  const lp = useLocalePath();
  useDocumentMeta(t('Страница не найдена', 'Бет табылмады'));

  return (
    <div className="page">
      <div className={s.wrap}>
        <Compass size={48} className={s.icon} aria-hidden="true" />
        <p className="eyebrow">{t('Ошибка 404', '404 қатесі')}</p>
        <h1>{t('Такой страницы нет', 'Мұндай бет жоқ')}</h1>
        <p className={s.text}>
          {t(
            'Возможно, адрес набран с опечаткой или страница переехала. Вот что есть на сайте:',
            'Мекенжай қатемен терілген немесе бет көшірілген болуы мүмкін. Сайтта мыналар бар:',
          )}
        </p>

        <div className={s.links}>
          {links(t).map(link => (
            <Link key={link.to} to={lp(link.to)} className={s.linkCard}>
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
          <Link to={lp('/')}>
            <Button size="lg">{t('Вернуться на главную', 'Басты бетке оралу')}</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
