import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui';
import { useLocalePath, useT } from '../i18n';
import s from './CookieBanner.module.css';

const KEY = 'cookie-consent';

/**
 * Плашка о cookie. В старом проекте её показывал js/cookie-notice.js, при
 * переезде на React она потерялась вместе со страницей политики cookie.
 *
 * Решение читается в эффекте, а не в useState-инициализаторе: при пререндере
 * localStorage недоступен, и первый рендер должен быть одинаковым на сервере и
 * в браузере.
 */
export function CookieBanner() {
  const [shown, setShown] = useState(false);
  const t = useT();
  const lp = useLocalePath();

  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY)) setShown(true);
    } catch {
      // Приватный режим или заблокированные site data — просто не показываем
    }
  }, []);

  if (!shown) return null;

  function accept() {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // Не смогли запомнить — плашка появится снова, это лучше, чем падение
    }
    setShown(false);
  }

  return (
    <div className={s.banner} role="region" aria-label={t('Уведомление о cookie', 'Cookie туралы хабарлама')}>
      <p className={s.text}>
        {t(
          'Сайт использует cookie и обезличенную аналитику, чтобы запоминать ваши настройки и понимать, какими инструментами пользуются чаще.',
          'Сайт баптауларыңызды есте сақтау және қай құралдар жиі қолданылатынын түсіну үшін cookie мен иесіздендірілген аналитиканы пайдаланады.',
        )}{' '}
        <Link className="accent" to={lp('/cookie')}>
          {t('Подробнее', 'Толығырақ')}
        </Link>
      </p>
      <Button size="sm" onClick={accept}>
        {t('Хорошо', 'Жақсы')}
      </Button>
    </div>
  );
}
