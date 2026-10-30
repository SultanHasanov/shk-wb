import { Link } from 'react-router-dom';
import { ArrowRight, AppWindow, Printer, QrCode } from 'lucide-react';
import { Hero } from '../components/Hero';
import { Section } from '../components/Section';
import { AppPlansTable } from '../components/AppPlansTable';
import { Button, Card, PriceTable } from '../ui';
import type { PriceCell } from '../ui';
import {
  CELL_PRINT_DEVICES,
  CELL_PRINT_DURATIONS,
  getCellPrintPrice,
  CUSTOM_PACK_LIST,
} from '../lib/pricing';
import { useMoney } from '../lib/currency';
import { useDocumentMeta } from '../lib/seo';
import { type T, useLocalePath, useT } from '../i18n';
import s from './landing.module.css';

/** Три продукта с разной моделью оплаты — быстрые ссылки на оформление. */
const products = (t: T) => [
  {
    to: '/#packages',
    Icon: QrCode,
    title: t('Генератор ШК и стикеров', 'ШК мен стикерлер генераторы'),
    text: t('Пакеты генераций с общего баланса. Чем больше пакет — тем ниже цена за код.', 'Ортақ балансынан генерация пакеттері. Пакет неғұрлым үлкен болса, код бағасы соғұрлым төмен.'),
    cta: t('К пакетам', 'Пакеттерге'),
  },
  {
    to: '/program#plans',
    Icon: AppWindow,
    title: t('Помощник ПВЗ', 'ПВЗ көмекшісі'),
    text: t('Подписка на программу: тарифы Базовый, Стандарт и Про.', 'Бағдарламаға жазылым: Базалық, Стандарт және Про тарифтері.'),
    cta: t('О программе', 'Бағдарлама туралы'),
  },
  {
    to: '/cell-print#key',
    Icon: Printer,
    title: t('Печать ячеек', 'Ұяшық басып шығару'),
    text: t('Лицензия на печать номера ячейки. Срок и число ПК — при оформлении.', 'Ұяшық нөмірін басу лицензиясы. Мерзімі мен ДК саны — рәсімдеу кезінде.'),
    cta: t('Выбрать ключ', 'Кілт таңдау'),
  },
];

export function TarifyPage() {
  const t = useT();
  const lp = useLocalePath();
  const { formatTotal, formatPerUnit } = useMoney();
  useDocumentMeta(
    t('Цены на генератор ШК ВБ и программы для ПВЗ', 'Тарифтер мен бағалар'),
    t(
      'Цены на генератор возвратных ШК, подписку «Помощник ПВЗ» и программу «Печать ячеек» для пунктов выдачи Wildberries.',
      'Wildberries беру пункттеріне арналған қайтару ШК генераторы, «ПВЗ көмекшісі» жазылымы және «Ұяшық басып шығару» бағдарламасының бағалары.',
    ),
  );

  return (
    <>
      <Hero
        compact
        eyebrow={t('Тарифы', 'Тарифтер')}
        title={t('Цены на инструменты для ПВЗ', 'ПВЗ құралдарының бағасы')}
        copy={t(
          'Три продукта с разной моделью оплаты: генерации — пакетами, Помощник ПВЗ — подпиской, Печать ячеек — лицензией. Оформление — на странице нужного продукта.',
          'Төлем моделі әртүрлі үш өнім: генерациялар — пакетпен, ПВЗ көмекшісі — жазылыммен, Ұяшық басып шығару — лицензиямен. Рәсімдеу — қажетті өнім бетінде.',
        )}
      />

      <Section>
        <div className="grid grid-3">
          {products(t).map(item => (
            <Card key={item.to}>
              <div className={s.tariffCard}>
                <item.Icon size={24} aria-hidden="true" />
                <h2>{item.title}</h2>
                <p className="muted">{item.text}</p>
                <Link to={lp(item.to)}>
                  <Button variant="secondary">
                    {item.cta}
                    <ArrowRight size={16} />
                  </Button>
                </Link>
              </div>
            </Card>
          ))}
        </div>
      </Section>

      {/* Лесенка генерации: чем больше пакет, тем дешевле код. */}
      <Section
        tone="band"
        eyebrow={t('Генератор', 'Генератор')}
        title={t('Пакеты генераций', 'Генерация пакеттері')}
        lead={t(
          'Пакеты не сгорают по времени и общие для сайта и Telegram-бота. Купить их можно на главной или в боте.',
          'Пакеттердің мерзімі өтпейді әрі сайт пен Telegram-ботқа ортақ. Оларды басты бетте немесе ботта сатып алуға болады.',
        )}
      >
        <div className="grid grid-4">
          {CUSTOM_PACK_LIST.map(pack => (
            <Card key={pack.quantity}>
              <div className={s.ladderCard}>
                <div className="metric">{formatTotal(pack.total)}</div>
                <div className={s.ladderQty}>{t(`${pack.quantity} кодов`, `${pack.quantity} код`)}</div>
                <div className="muted">{t(`${formatPerUnit(pack.perUnit)} за код`, `бір кодқа ${formatPerUnit(pack.perUnit)}`)}</div>
              </div>
            </Card>
          ))}
        </div>
        <div className={s.ladderCta}>
          <Link to={lp('/#packages')}>
            <Button>
              {t('Купить пакет на главной', 'Басты бетте пакет сатып алу')}
              <ArrowRight size={16} />
            </Button>
          </Link>
        </div>
      </Section>

      {/* Тарифы «Помощника ПВЗ» — живые цены с сервера. */}
      <Section
        eyebrow={t('Помощник ПВЗ', 'ПВЗ көмекшісі')}
        title={t('Подписка на программу', 'Бағдарламаға жазылым')}
        lead={t(
          'Лимиты обновляются ежемесячно. Оформление — в кабинете или на странице программы.',
          'Лимиттер ай сайын жаңарады. Рәсімдеу — кабинетте немесе бағдарлама бетінде.',
        )}
      >
        <AppPlansTable variant="full" />
      </Section>

      {/* Матрица «Печати ячеек»: срок × число ПК. */}
      <Section
        tone="band"
        eyebrow={t('Печать ячеек', 'Ұяшық басып шығару')}
        title={t('Лицензия: срок и число компьютеров', 'Лицензия: мерзімі және компьютер саны')}
        lead={t(
          'Цена за один маркетплейс (Wildberries). Комплект WB + Ozon — дешевле на 10%. Оформление — на странице программы.',
          'Бір маркетплейске баға (Wildberries). WB + Ozon жиынтығы — 10% арзан. Рәсімдеу — бағдарлама бетінде.',
        )}
      >
        <PriceTable
          caption={t('Стоимость лицензии «Печати ячеек» за весь срок', '«Ұяшық басып шығару» лицензиясының толық мерзімге бағасы')}
          head={CELL_PRINT_DEVICES.map(n => t(`${n} ПК`, `${n} ДК`))}
          rows={CELL_PRINT_DURATIONS.map(d => ({
            label: t(d.label, d.labelKk),
            cells: CELL_PRINT_DEVICES.map<PriceCell>(n => ({ label: formatTotal(getCellPrintPrice(d.days, n)) })),
          }))}
        />
        <div className={s.ladderCta}>
          <Link to={lp('/cell-print#key')}>
            <Button>
              {t('Выбрать ключ', 'Кілт таңдау')}
              <ArrowRight size={16} />
            </Button>
          </Link>
        </div>
      </Section>
    </>
  );
}
