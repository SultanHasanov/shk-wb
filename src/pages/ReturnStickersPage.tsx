import { Link } from 'react-router-dom';
import { ArrowRight, FileText, Package, Printer } from 'lucide-react';
import { Hero } from '../components/Hero';
import { Section } from '../components/Section';
import { Steps } from '../components/Steps';
import { FeatureGrid } from '../components/FeatureGrid';
import { CROSS_SELL, CrossSell } from '../components/CrossSell';
import { Accordion, Button, Card } from '../ui';
import { formatPerUnit, MIN_PER_UNIT } from '../lib/pricing';
import { useDocumentMeta } from '../lib/seo';
import s from './landing.module.css';

const STEPS = [
  {
    title: 'Откройте генератор',
    text: 'Режим «Товары» и массовая генерация выбраны по умолчанию — ничего настраивать не нужно.',
  },
  {
    title: 'Укажите количество',
    text: 'Сервис подготовит уникальные номера ШК и покажет каждый стикер до печати.',
  },
  {
    title: 'Скачайте или распечатайте',
    text: 'Сохраните общий PDF формата A4 либо отправьте этикетки на обычный или термопринтер.',
  },
] as const;

const FEATURES = [
  {
    Icon: Package,
    title: 'Стикеры для возвратных коробок',
    text: 'Генератор создаёт уникальные возвратные ШК для маркировки коробок. Номера выдаются из подготовленного диапазона и не повторяются.',
  },
  {
    Icon: FileText,
    title: 'Готовый PDF для печати',
    text: 'Стикеры объединяются в один документ. Его можно сохранить, передать на другой компьютер или распечатать на листах A4.',
  },
  {
    Icon: Printer,
    title: 'Печать на термопринтере',
    text: 'Доступны популярные размеры этикеток и проверка ширины для моделей TSC. Для совместимых NIIMBOT предусмотрена печать через Bluetooth.',
  },
] as const;

const FAQ = [
  {
    q: 'Как создать возвратный стикер ВБ?',
    a: 'Перейдите в генератор, оставьте выбранным тип «Товары» и режим «Массово», введите нужное количество, укажите код доступа из купленного пакета и нажмите «Сгенерировать».',
  },
  {
    q: 'Можно ли скачать возвратные стикеры?',
    a: 'Да. После генерации появится кнопка скачивания общего PDF, пригодного для сохранения и печати на листах A4.',
  },
  {
    q: 'Можно ли печатать на TSC или NIIMBOT?',
    a: 'Да. Для TSC можно выбрать размер этикетки и отправить результат в системное окно печати. Совместимые NIIMBOT подключаются из браузера по Bluetooth.',
  },
  {
    q: 'Чем возвратный стикер отличается от QR-кода коробки?',
    a: 'Возвратный стикер маркирует конкретный товар, уходящий обратно на склад. QR-код коробки маркирует саму тару, в которой едет партия возвратов. Генератор умеет и то, и другое — переключается типом стикера.',
  },
  {
    q: 'Это официальный сервис Wildberries?',
    a: 'Нет. Это независимый онлайн-инструмент, не являющийся официальным сервисом Wildberries и не связанный с ООО «Вайлдберриз».',
  },
] as const;

export function ReturnStickersPage() {
  useDocumentMeta(
    'Возвратные стикеры ВБ — создать и скачать онлайн',
    'Создайте уникальные возвратные ШК Wildberries онлайн, проверьте готовые этикетки и скачайте одним PDF. Пакеты генераций от 0,27 ₽ за штуку.',
  );

  return (
    <>
      <Hero
        eyebrow="Онлайн, без установки"
        title={
          <>
            Возвратные стикеры для <em>коробок Wildberries</em>
          </>
        }
        copy={
          <>
            Создайте уникальные возвратные ШК ВБ, проверьте готовые этикетки и скачайте одним PDF.
            Генерации покупаются пакетами — <strong>от {formatPerUnit(MIN_PER_UNIT)}</strong> за
            штуку.
          </>
        }
        trust={['Без регистрации', 'Готовый PDF формата A4', 'Уникальные номера ШК']}
      >
        <div className={s.heroActions}>
          <Link to="/">
            <Button size="lg">
              Создать возвратные стикеры
              <ArrowRight size={18} />
            </Button>
          </Link>
          <a href="#how">
            <Button size="lg" variant="secondary">
              Как это работает
            </Button>
          </a>
        </div>
      </Hero>

      <Section id="how" eyebrow="Три шага" title="Как создать и распечатать возвратные стикеры ВБ">
        <Steps steps={STEPS} />
      </Section>

      <Section
        tone="band"
        eyebrow="Что умеет генератор"
        title="Возвратные ШК, PDF и термопечать"
        lead="Один инструмент закрывает весь путь: от подготовки номеров до готового к печати документа."
      >
        <FeatureGrid items={FEATURES} />
      </Section>

      <Section eyebrow="Частые вопросы" title="О возвратных ШК и печати">
        <Accordion items={FAQ} />
      </Section>

      <Section>
        <Card accent>
          <div className={s.cta}>
            <div>
              <h2>Создайте возвратные стикеры онлайн</h2>
              <p className="muted" style={{ margin: 0 }}>
                Регистрация и установка программы не требуются — генератор работает прямо в
                браузере, нужен только код доступа из купленного пакета.
              </p>
            </div>
            <Link to="/">
              <Button size="lg">
                Создать стикер
                <ArrowRight size={18} />
              </Button>
            </Link>
          </div>
        </Card>
      </Section>

      <CrossSell items={[CROSS_SELL.cellPrint, CROSS_SELL.program]} />
    </>
  );
}
