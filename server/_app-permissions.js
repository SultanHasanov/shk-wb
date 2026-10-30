// Доступ сотрудников: что владелец закрывает на конкретном компьютере (кабинет →
// «Доступ сотрудников»). Список закрытого хранится в app_devices.denied и уходит
// программе в подписанной аренде (rights.denied) — правкой файлов на ПК не снять.
// Разделы — те же ключи, что у тарифа (их вычитаем из rights.features), действия — `act.*`.
// Зеркала списка: `src/lib/app-permissions.ts` (кабинет, с шаблонами) и `src/app/nav.ts` программы.

const SECTIONS = [
  { key: 'cells', title: 'Ячейки', hint: 'Список ячеек, все товары, карточка ячейки' },
  { key: 'codeclient', title: 'Код клиента', hint: 'Раздел поиска клиента и QR-кода' },
  { key: 'expensive', title: 'Дорогие товары', hint: 'Дорогие товары и крупные клиенты' },
  { key: 'way', title: 'В пути', hint: 'Что едет в пункт' },
  { key: 'boxes', title: 'Коробки', hint: 'Коробки возвратов и история товара' },
  { key: 'goods', title: 'Товар по ШК', hint: 'Поиск товара по ШК через WB' },
  { key: 'video', title: 'Видео по ШК', hint: 'Архив камер на момент приёмки' },
  { key: 'search', title: 'Клиенты', hint: 'Поиск клиента по телефону' },
  { key: 'dossier', title: 'Досье клиента', hint: 'Вся история покупок клиента' },
  { key: 'reviews', title: 'Отзывы', hint: 'Оценки пункта от клиентов' },
  { key: 'staff', title: 'Сотрудники', hint: 'График, зарплата, список сотрудников' },
  { key: 'stickers', title: 'Стикеры', hint: 'Генерация и печать стикеров' },
  { key: 'cellprint', title: 'Печать ячеек', hint: 'Раздел программы «Печать ячеек»' },
  { key: 'tryon', title: 'Окно примерки', hint: 'Всплывающее окно при клиенте на примерке' },
  { key: 'notes', title: 'Заметки о клиентах', hint: 'Добавлять и удалять заметки' },
  { key: 'telegram', title: 'Telegram', hint: 'Отправка в Telegram-бота' },
  { key: 'settings', title: 'Настройки', hint: 'Пороги, окно примерки, бот, архив' },
];

const ACTIONS = [
  { key: 'act.client_qr', title: 'QR-код клиента', hint: 'Кнопка «QR код клиента» и быстрый QR' },
  { key: 'act.payroll', title: 'Видеть зарплату', hint: 'Вкладка «Зарплата» и ставки сотрудников' },
  { key: 'act.staff_edit', title: 'Менять сотрудников и график', hint: 'Добавлять и удалять сотрудников, ставки, смены' },
  { key: 'act.stickers_generate', title: 'Создавать стикеры', hint: 'Генерация списывает деньги с баланса' },
  { key: 'act.video_settings', title: 'Настройки камер', hint: 'Токен Ivideon и список камер' },
  { key: 'act.load_pc', title: 'Загрузка с другого ПК', hint: 'Загружать данные других пунктов и ПК' },
  { key: 'act.archive_view', title: 'Смотреть архив', hint: 'Историю клиентов старше двух недель' },
  { key: 'act.pay', title: 'Оплаты из программы', hint: 'Покупка тарифа, услуг, пополнение баланса' },
  { key: 'act.account', title: 'Управлять аккаунтом', hint: 'Отключать ПК и пункты, менять пароль, выходить на других ПК' },
];

const KEYS = new Set([...SECTIONS, ...ACTIONS].map(p => p.key));

/** Оставить только известные ключи, без повторов, в порядке справочника. */
function cleanDenied(list) {
  const set = new Set((Array.isArray(list) ? list : []).map(String));
  return [...SECTIONS, ...ACTIONS].map(p => p.key).filter(k => set.has(k));
}

function isDenied(device, key) {
  return Array.isArray(device?.denied) && device.denied.includes(key);
}

module.exports = { SECTIONS, ACTIONS, KEYS, cleanDenied, isDenied };
