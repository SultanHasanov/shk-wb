import { Link } from 'react-router-dom';
import { ArrowRight, KeyRound, Printer, Tag } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Section } from './Section';
import { type Text, useLocale, useLocalePath, useT } from '../i18n';
import s from './CrossSell.module.css';

export type CrossSellItem = {
  to: string;
  Icon: LucideIcon;
  title: Text;
  text: Text;
  more: Text;
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
    title: { ru: 'Генератор стикеров и возвратных ШК', kk: 'Стикерлер мен қайтару ШК генераторы' },
    text: {
      ru: 'Онлайн, без установки: возвратные стикеры Wildberries и QR-коды коробок, готовый PDF для печати. Пакеты генераций от 0,27 ₽ за штуку.',
      kk: 'Онлайн, орнатусыз: Wildberries қайтару стикерлері мен қорап QR-кодтары, басып шығаруға дайын PDF. Генерация пакеттері қолжетімді бағамен.',
    },
    more: { ru: 'Открыть генератор', kk: 'Генераторды ашу' },
  },
  cellPrint: {
    to: '/cell-print',
    Icon: Printer,
    title: { ru: 'Печать номера ячейки', kk: 'Ұяшық нөмірін басып шығару' },
    text: {
      ru: 'Программа перехватывает скан товара и сразу отправляет этикетку с номером ячейки на термопринтер. Работает в фоне на Windows.',
      kk: 'Бағдарлама тауар сканын ұстап алып, ұяшық нөмірі бар заттаңбаны бірден термопринтерге жібереді. Windows-та фондық режимде жұмыс істейді.',
    },
    more: { ru: 'Смотреть тарифы', kk: 'Тарифтерді көру' },
  },
  program: {
    to: '/program',
    Icon: KeyRound,
    title: { ru: 'Помощник ПВЗ', kk: 'ПВЗ көмекшісі' },
    text: {
      ru: 'Подбор кода клиента по номеру ячейки, ячейки и товары «В пути», отзывы, досье клиента и стикеры. Тарифы от месяца.',
      kk: 'Ұяшық нөмірі бойынша клиент кодын іріктеу, ұяшықтар мен «Жолдағы» тауарлар, пікірлер, клиент досьесі және стикерлер. Тарифтер бір айдан.',
    },
    more: { ru: 'Смотреть программу', kk: 'Бағдарламаны көру' },
  },
} as const satisfies Record<string, CrossSellItem>;

/** Аналог .program-band из старого лендинга — перевод на соседние продукты. */
export function CrossSell({
  items,
  title,
  lead,
}: {
  items: readonly CrossSellItem[];
  title?: string;
  lead?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const lp = useLocalePath();
  return (
    <Section
      tone="band"
      eyebrow={t('Другие инструменты', 'Басқа құралдар')}
      title={title ?? t('Работаете с кодами на компьютере?', 'Кодтармен компьютерде жұмыс істейсіз бе?')}
      lead={lead ?? t(
        'Кроме генератора у нас есть две программы для рабочего компьютера ПВЗ — они убирают ручные действия между выдачами.',
        'Генератордан бөлек бізде БП жұмыс компьютеріне арналған екі бағдарлама бар — олар беру арасындағы қолмен жасалатын әрекеттерді алып тастайды.',
      )}
    >
      <div className={s.cards}>
        {items.map(({ to, Icon, title: cardTitle, text, more }) => (
          <Link key={to} to={lp(to)} className={s.card}>
            <Icon size={30} className={s.icon} aria-hidden="true" />
            <h3 className={s.cardTitle}>{cardTitle[locale]}</h3>
            <p className={s.cardText}>{text[locale]}</p>
            <span className={s.more}>
              {more[locale]}
              <ArrowRight size={16} aria-hidden="true" />
            </span>
          </Link>
        ))}
      </div>
    </Section>
  );
}
