import { Link } from 'react-router-dom';
import { ArrowRight, KeyRound, Printer, Tag } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Section } from './Section';
import s from './CrossSell.module.css';

export type CrossSellItem = {
  to: string;
  Icon: LucideIcon;
  title: string;
  text: string;
  more: string;
};

/**
 * Каталог перекрёстных ссылок. Страница берёт отсюда всё, кроме себя самой —
 * раньше список был захардкожен внутри компонента, и cell-print рекламировал
 * бы сам себя, если бы блок туда поставили.
 */
export const CROSS_SELL = {
  generator: {
    to: '/',
    Icon: Tag,
    title: 'Генератор стикеров и возвратных ШК',
    text: 'Онлайн, без установки: возвратные стикеры Wildberries и QR-коды коробок, готовый PDF для печати. Пакеты генераций от 0,27 ₽ за штуку.',
    more: 'Открыть генератор',
  },
  cellPrint: {
    to: '/cell-print',
    Icon: Printer,
    title: 'Печать номера ячейки',
    text: 'Программа перехватывает скан товара и сразу отправляет этикетку с номером ячейки на термопринтер. Работает в фоне на Windows.',
    more: 'Смотреть тарифы',
  },
  program: {
    to: '/program',
    Icon: KeyRound,
    title: 'Подбор кодов',
    text: 'Находит код клиента по номеру ячейки, показывает товары заказа и отзывы. Списание только за успешный подбор.',
    more: 'Смотреть программу',
  },
} as const satisfies Record<string, CrossSellItem>;

/** Аналог .program-band из старого лендинга — перевод на соседние продукты. */
export function CrossSell({
  items,
  title = 'Работаете с кодами на компьютере?',
  lead = 'Кроме генератора у нас есть две программы для рабочего компьютера ПВЗ — они убирают ручные действия между выдачами.',
}: {
  items: readonly CrossSellItem[];
  title?: string;
  lead?: string;
}) {
  return (
    <Section tone="band" eyebrow="Другие инструменты" title={title} lead={lead}>
      <div className={s.cards}>
        {items.map(({ to, Icon, title: cardTitle, text, more }) => (
          <Link key={to} to={to} className={s.card}>
            <Icon size={30} className={s.icon} aria-hidden="true" />
            <h3 className={s.cardTitle}>{cardTitle}</h3>
            <p className={s.cardText}>{text}</p>
            <span className={s.more}>
              {more}
              <ArrowRight size={16} aria-hidden="true" />
            </span>
          </Link>
        ))}
      </div>
    </Section>
  );
}
