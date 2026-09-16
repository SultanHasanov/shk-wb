import { ArrowRight } from 'lucide-react';
import { TelegramIcon } from './TelegramIcon';
import { BOT_URL } from '../lib/telegram';
import s from './TelegramBotPromo.module.css';

const POINTS = [
  'Товарные стикеры и QR коробок',
  'До 500 штук за один запрос',
  'Готовый PDF прямо в чат',
] as const;

/**
 * Бот умеет ровно то же, что форма генератора, но про него на сайте не было ни
 * слова: ссылка встречалась только на странице результата оплаты при возврате
 * из Telegram. Блок стоит рядом с формой, где человек уже решает задачу
 * генерации, — там предложение «то же самое, но в телефоне» и уместно.
 */
export function TelegramBotPromo({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  return (
    <aside className={`${s.promo} ${variant === 'compact' ? s.compact : ''}`}>
      {variant === 'full' && (
        <img
          className={s.avatar}
          src="/images/telegram-bot-avatar.png"
          alt=""
          width={56}
          height={56}
          loading="lazy"
        />
      )}

      <div className={s.body}>
        <h3 className={s.title}>
          <TelegramIcon className={s.ico} />
          Генерируйте ШК прямо в Telegram
        </h3>
        <p className={s.text}>
          У генератора есть бот: он собирает возвратные стикеры и QR-коды коробок без сайта — с
          телефона на выдаче, из того же пула номеров.
        </p>
        <ul className={s.points}>
          {POINTS.map(point => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </div>

      <a className={s.cta} href={BOT_URL} target="_blank" rel="noopener noreferrer">
        Открыть бота
        <ArrowRight size={16} aria-hidden="true" />
      </a>
    </aside>
  );
}
