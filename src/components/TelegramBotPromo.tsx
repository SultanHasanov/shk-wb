import { ArrowRight } from 'lucide-react';
import { TelegramIcon } from './TelegramIcon';
import { BOT_URL } from '../lib/telegram';
import { type T, useT } from '../i18n';
import s from './TelegramBotPromo.module.css';

const points = (t: T) => [
  t('Товарные стикеры и QR коробок', 'Тауар стикерлері мен қорап QR-кодтары'),
  t('Пачка 50 штук одним PDF', '50 дана бір PDF файлында'),
  t('Готовый PDF прямо в чат', 'Дайын PDF тікелей чатқа'),
  t('Код клиента по ячейке или телефону', 'Ұяшық не телефон бойынша клиент коды'),
];

/**
 * Бот умеет ровно то же, что форма генератора, но про него на сайте не было ни
 * слова: ссылка встречалась только на странице результата оплаты при возврате
 * из Telegram. Блок стоит рядом с формой, где человек уже решает задачу
 * генерации, — там предложение «то же самое, но в телефоне» и уместно.
 */
export function TelegramBotPromo({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const t = useT();
  return (
    <aside className={`${s.promo} ${variant === 'compact' ? s.compact : ''}`}>
      {variant === 'full' && (
        <img
          className={s.avatar}
          src="/images/telegram-bot-avatar-112.webp"
          alt=""
          width={56}
          height={56}
          loading="lazy"
        />
      )}

      <div className={s.body}>
        <h3 className={s.title}>
          <TelegramIcon className={s.ico} />
          {t('Генерируйте ШК прямо в Telegram', 'ШК-ны тікелей Telegram-да генерациялаңыз')}
        </h3>
        <p className={s.text}>
          {t(
            'У генератора есть бот: он собирает возвратные стикеры и QR-коды коробок без сайта — с телефона на выдаче, из того же пула номеров. Он же найдёт код клиента по номеру ячейки или телефону.',
            'Генератордың боты бар: ол қайтару стикерлері мен қорап QR-кодтарын сайтсыз жасайды — беру кезінде телефоннан, сол нөмірлер пулынан. Сондай-ақ ұяшық не телефон нөмірі бойынша клиент кодын табады.',
          )}
        </p>
        <ul className={s.points}>
          {points(t).map(point => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </div>

      <a className={s.cta} href={BOT_URL} target="_blank" rel="noopener noreferrer">
        {t('Открыть бота', 'Ботты ашу')}
        <ArrowRight size={16} aria-hidden="true" />
      </a>
    </aside>
  );
}
