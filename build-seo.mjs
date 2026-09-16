/**
 * Данные разметки для публичных маршрутов.
 *
 * title и description здесь намеренно отсутствуют: их задаёт useDocumentMeta в
 * самих страницах (src/lib/seo.ts), и пререндер снимает их прямо из готового
 * DOM. Дублировать значения в двух местах — верный способ развести их со
 * временем. Здесь только то, чего React не выставляет: og-картинки, тип
 * страницы и микроразметка.
 *
 * Исключение — fallback: он нужен, только если Chromium не удалось запустить и
 * пререндер не состоялся. Тогда в файл идёт пустая оболочка, и заголовок взять
 * неоткуда, а восемь страниц с одинаковым title хуже, чем слегка дублированный
 * текст здесь.
 *
 * Блоки @graph восстановлены из статических страниц, потерянных при переезде на
 * React (index.html до коммита 08f6c8c, program.html, cell-print.html,
 * vozvratnye-stikery-wb.html). FAQPage здесь не описывается: он собирается
 * автоматически из отрендеренного аккордеона, поэтому не может разойтись с тем,
 * что видит посетитель.
 */
export const ORIGIN = 'https://shk-wb.vercel.app';

export const SITE_NAME = 'ШК ВБ';

/**
 * Подтверждение прав в Google Search Console — значение content из мета-тега,
 * который выдаёт способ проверки «Тег HTML».
 *
 * Проверка файлом здесь не годится: cleanUrls в vercel.json отвечает на
 * /googleXXXX.html редиректом 308 на /googleXXXX, а Google ждёт 200 по точному
 * адресу. DNS-запись тоже отпадает — домен vercel.app не наш.
 *
 * Пустая строка — тег не выводится.
 */
export const GOOGLE_SITE_VERIFICATION = '';

const OG_GENERATOR = {
  path: '/images/og-generator-v3.png',
  width: 1728,
  height: 910,
  alt: 'Генератор QR-кодов и стикеров — создание и скачивание готовых стикеров',
};

const OG_CELL_PRINT = {
  path: '/images/screenshot-cell-print.png',
  width: 1835,
  height: 1352,
  alt: 'Окно программы «Печать ячеек» со статистикой и журналом операций',
};

const OG_PROGRAM = {
  path: '/images/screenshot-crack-tool.png',
  width: 1726,
  height: 1256,
  alt: 'Интерфейс программы «Подбор кодов» для ПВЗ',
};

/** Хлебные крошки одинаковы по форме на всех вложенных страницах. */
function breadcrumbs(route, name) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Главная', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name, item: `${ORIGIN}${route}` },
    ],
  };
}

export const PUBLIC_PAGES = {
  '/': {
    fallback: {
      title: 'Генератор возвратных ШК и стикеров Wildberries — ШК ВБ',
      description:
        'Создавайте возвратные стикеры Wildberries и QR-коды коробок онлайн. Готовый PDF для печати, пакеты генераций от 0,27 ₽ за штуку.',
    },
    ogType: 'website',
    image: OG_GENERATOR,
    graph: [
      {
        '@type': 'WebSite',
        '@id': `${ORIGIN}/#website`,
        url: `${ORIGIN}/`,
        name: 'Генератор ШК и возвратных стикеров ВБ',
        inLanguage: 'ru-RU',
      },
      {
        '@type': 'WebApplication',
        '@id': `${ORIGIN}/#generator`,
        name: 'Генератор ШК ВБ и возвратных стикеров',
        url: `${ORIGIN}/`,
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Любая ОС с современным браузером',
        browserRequirements: 'Требуется JavaScript',
        inLanguage: 'ru-RU',
        description:
          'Онлайн-генератор возвратных ШК и стикеров Wildberries с экспортом в PDF и печатью.',
      },
    ],
  },

  '/vozvratnye-stikery-wb': {
    fallback: {
      title: 'Возвратные стикеры ВБ — создать и скачать онлайн — ШК ВБ',
      description:
        'Создайте возвратные стикеры и ШК для коробок Wildberries онлайн. Готовый PDF, предпросмотр и печать на обычном принтере, TSC или NIIMBOT.',
    },
    ogType: 'article',
    image: OG_GENERATOR,
    graph: [
      {
        '@type': 'WebPage',
        '@id': `${ORIGIN}/vozvratnye-stikery-wb#page`,
        url: `${ORIGIN}/vozvratnye-stikery-wb`,
        name: 'Возвратные стикеры ВБ — создать и скачать онлайн',
        description:
          'Инструкция по созданию возвратных ШК и стикеров для коробок Wildberries.',
        inLanguage: 'ru-RU',
      },
      breadcrumbs('/vozvratnye-stikery-wb', 'Возвратные стикеры'),
    ],
  },

  '/qr-korobov-wb': {
    fallback: {
      title: 'ШК коробов WB — генератор QR-кодов возвратных коробок — ШК ВБ',
      description:
        'Генератор QR-кодов для возвратных коробок Wildberries: свой префикс, уникальные номера, готовый PDF и печать на термопринтере. Пакеты от 0,27 ₽ за штуку.',
    },
    ogType: 'article',
    image: OG_GENERATOR,
    graph: [
      {
        '@type': 'WebPage',
        '@id': `${ORIGIN}/qr-korobov-wb#page`,
        url: `${ORIGIN}/qr-korobov-wb`,
        name: 'ШК коробов WB — генератор QR-кодов возвратных коробок',
        description:
          'Как сделать и распечатать QR-коды для возвратных коробок Wildberries.',
        inLanguage: 'ru-RU',
      },
      breadcrumbs('/qr-korobov-wb', 'QR коробов WB'),
    ],
  },

  '/program': {
    fallback: {
      title: 'Подбор кодов — программа для ПВЗ Wildberries на Windows — ШК ВБ',
      description:
        'Программа находит код клиента по номеру ячейки, показывает товары заказа и отзывы ПВЗ. Скачивание бесплатное, списание только за успешный подбор.',
    },
    ogType: 'website',
    image: OG_PROGRAM,
    graph: [
      {
        '@type': 'SoftwareApplication',
        '@id': `${ORIGIN}/program#app`,
        name: 'Подбор кодов',
        url: `${ORIGIN}/program`,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Windows 7, Windows 10, Windows 11',
        // Держать в согласии с downloads/version.json
        softwareVersion: '1.3.3',
        inLanguage: 'ru-RU',
        description:
          'Программа для сотрудников ПВЗ: поиск кода клиента по номеру ячейки, проверка отзывов и просмотр товаров заказа по доступным рабочим данным.',
        screenshot: `${ORIGIN}${OG_PROGRAM.path}`,
        fileSize: '16 MB',
        offers: {
          '@type': 'Offer',
          // Установщик отдаётся бесплатно, платные только итерации подбора
          price: '0',
          priceCurrency: 'RUB',
          availability: 'https://schema.org/InStock',
          url: `${ORIGIN}/program`,
        },
      },
      breadcrumbs('/program', 'Подбор кодов'),
    ],
  },

  '/cell-print': {
    fallback: {
      title: 'Печать ячеек — автопечать этикетки при сканировании в WB_PVZ — ШК ВБ',
      description:
        'Программа для Windows печатает номер ячейки на термопринтере сразу после скана товара в WB_PVZ. Скачивание бесплатно, оплата только за ключ.',
    },
    ogType: 'website',
    image: OG_CELL_PRINT,
    graph: [
      {
        '@type': 'SoftwareApplication',
        '@id': `${ORIGIN}/cell-print#app`,
        name: 'Печать ячеек',
        url: `${ORIGIN}/cell-print`,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Windows 7, Windows 10, Windows 11',
        // Последний релиз: коммит 08f6c8c
        softwareVersion: '1.1.1',
        inLanguage: 'ru-RU',
        description:
          'Программа для ПВЗ: работает в фоне вместе с WB_PVZ, находит ячейку после сканирования товара и отправляет этикетку на термопринтер.',
        screenshot: `${ORIGIN}${OG_CELL_PRINT.path}`,
        offers: {
          // Матрица «срок × устройства» из CELL_PRINT_PRICES: 5 × 6 тарифов
          '@type': 'AggregateOffer',
          priceCurrency: 'RUB',
          lowPrice: '50',
          highPrice: '10000',
          offerCount: '30',
          availability: 'https://schema.org/InStock',
          url: `${ORIGIN}/cell-print`,
        },
      },
      breadcrumbs('/cell-print', 'Печать ячеек'),
    ],
  },

  '/contacts': {
    fallback: {
      title: 'Контакты и поддержка — ШК ВБ',
      description:
        'Напишите нам, если нужна помощь с оплатой, ключом активации или настройкой печати. Отвечаем в течение рабочего дня.',
    },
    ogType: 'website',
    image: OG_GENERATOR,
    graph: [breadcrumbs('/contacts', 'Контакты')],
  },

  '/offer': {
    fallback: {
      title: 'Публичная оферта — ШК ВБ',
      description:
        'Условия договора оказания цифровых услуг: предмет, оплата, получение доступа, временные ключи и возвраты.',
    },
    ogType: 'website',
    image: OG_GENERATOR,
    graph: [breadcrumbs('/offer', 'Публичная оферта')],
  },

  '/privacy': {
    fallback: {
      title: 'Политика конфиденциальности — ШК ВБ',
      description:
        'Какие данные обрабатывает сервис, где они хранятся, кому передаются и как запросить их удаление.',
    },
    ogType: 'website',
    image: OG_GENERATOR,
    graph: [breadcrumbs('/privacy', 'Политика конфиденциальности')],
  },

  '/cookie': {
    fallback: {
      title: 'Политика использования cookie — ШК ВБ',
      description:
        'Какие cookie и данные браузера использует сервис, зачем они нужны и как их отключить.',
    },
    ogType: 'website',
    image: OG_GENERATOR,
    graph: [breadcrumbs('/cookie', 'Использование cookie')],
  },
};
