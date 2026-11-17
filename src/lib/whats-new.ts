/**
 * «Что нового» в личном кабинете: после обновления человек один раз видит окно
 * с коротким описанием, а у изменившегося раздела в меню висит метка «new»,
 * пока он его не откроет.
 *
 * Модуль без React: записи, чтение/запись состояния и чистые функции выбора —
 * чтобы проверять их тестами без рендера. Окно — src/components/WhatsNew.tsx,
 * метки в меню — src/layout/CabinetShell.tsx.
 *
 * Как добавить новость: дописать запись В НАЧАЛО списка WHATS_NEW (новые сверху)
 * с новым id. Старые записи не править и не удалять без нужды: по id браузер
 * помнит, что уже показано.
 */

export interface WhatsNewEntry {
  /** Постоянный идентификатор: по нему браузер помнит показанное. Не менять после выкладки. */
  id: string;
  /** День выкладки, YYYY-MM-DD. */
  date: string;
  title: [ru: string, kz: string];
  /** Пункты простыми словами, без жаргона. */
  items: [ru: string, kz: string][];
  /** Разделы кабинета, которых касается новость: пути меню, например '/cabinet/staff'. */
  sections: string[];
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: '2026-11-phone-files',
    date: '2026-11-17',
    sections: ['/cabinet/access'],
    title: [
      'Файлы с телефона в программе',
      'Бағдарламада телефоннан файлдар',
    ],
    items: [
      [
        'В «Помощнике ПВЗ» 1.16 появился раздел «С телефона»: фото, видео и документы с телефона приходят на компьютер по одноразовому QR.',
        '«Помощник ПВЗ» 1.16 нұсқасында «С телефона» бөлімі пайда болды: телефоннан фото, бейне және құжаттар компьютерге бір реттік QR арқылы келеді.',
      ],
      [
        'В «Доступе сотрудников» можно закрыть приём файлов на компьютере сотрудника — переключатель «Файлы с телефона».',
        '«Қызметкерлерге рұқсат» бөлімінде қызметкер компьютерінде файл қабылдауды жабуға болады — «Файлы с телефона» ауыстырғышы.',
      ],
    ],
  },
  {
    id: '2026-11-staff-quick',
    date: '2026-11-17',
    sections: ['/cabinet/staff'],
    title: [
      'Сотрудники: быстрее ставить смены и считать зарплату',
      'Қызметкерлер: ауысым қою мен жалақы есептеу жылдамырақ болды',
    ],
    items: [
      [
        'Нажмите на день в календаре — рядом откроется список сотрудников. Нажатие на имя ставит смену, повторное — убирает.',
        'Күнтізбеде күнді басыңыз — қасында қызметкерлер тізімі ашылады. Атын бассаңыз, ауысым қойылады, қайта бассаңыз — алынып тасталады.',
      ],
      [
        'Если в день стоит больше людей, чем разрешено в настройках, день помечается, а в панели дня есть кнопки, чтобы это исправить.',
        'Егер бір күнге баптауларда рұқсат етілгеннен көп адам қойылса, күн белгіленеді, ал күн панелінде мұны түзететін батырмалар бар.',
      ],
      [
        'Зарплату можно выплатить за любой открытый месяц: сумма подставляется сама. Кнопка «Выплатить всем» рассчитывает всех сразу.',
        // Раздел «Сотрудники» пока только на русском — название кнопки оставлено как на экране.
        'Жалақыны кез келген ашық ай үшін төлеуге болады: сома өзі қойылады. «Выплатить всем» батырмасы барлығын бірден есептейді.',
      ],
      [
        'Оплаченные смены отмечены в календаре галочкой.',
        'Төленген ауысымдар күнтізбеде құсбелгімен белгіленген.',
      ],
      [
        'Заполнение по шаблону: день начала выбирается прямо в календаре, заполнить можно весь месяц или отдельные недели.',
        'Үлгі бойынша толтыру: басталу күні тікелей күнтізбеден таңдалады, бүкіл айды немесе жеке апталарды толтыруға болады.',
      ],
    ],
  },
];

/** Сколько дней раздел держит метку «new», если его так и не открыли. */
export const NEW_SECTION_DAYS = 14;

export interface WhatsNewState {
  /** id записей, окно с которыми человек уже закрыл. */
  seen: string[];
  /** раздел → id самой свежей записи о нём на момент, когда раздел открыли. */
  opened: Record<string, string>;
}

/** Общий пустой объект: функции ниже состояние не мутируют, а возвращают новое. */
export const EMPTY_WHATS_NEW_STATE: WhatsNewState = { seen: [], opened: {} };

export function whatsNewStorageKey(userId: string) {
  return `cabinet_whats_new_v1_${userId}`;
}

/** Разбор сохранённого: мусор, чужой формат и обрезанный JSON дают пустое состояние, а не исключение. */
export function parseWhatsNewState(raw: string | null | undefined): WhatsNewState {
  if (!raw) return EMPTY_WHATS_NEW_STATE;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_WHATS_NEW_STATE;
    const { seen, opened } = value as { seen?: unknown; opened?: unknown };
    const cleanOpened: Record<string, string> = {};
    if (opened && typeof opened === 'object' && !Array.isArray(opened)) {
      for (const [path, id] of Object.entries(opened)) {
        if (typeof id === 'string') cleanOpened[path] = id;
      }
    }
    return {
      seen: Array.isArray(seen) ? seen.filter((id): id is string => typeof id === 'string') : [],
      opened: cleanOpened,
    };
  } catch {
    return EMPTY_WHATS_NEW_STATE;
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // В приватном окне само обращение к localStorage может бросить исключение.
    return null;
  }
}

export function readWhatsNewState(userId: string, storage: Storage | null = defaultStorage()): WhatsNewState {
  try {
    return parseWhatsNewState(storage?.getItem(whatsNewStorageKey(userId)));
  } catch {
    return EMPTY_WHATS_NEW_STATE;
  }
}

/** false — сохранить не вышло (приватное окно, переполнение): показанное запомнится только до перезагрузки. */
export function writeWhatsNewState(
  userId: string,
  state: WhatsNewState,
  storage: Storage | null = defaultStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(whatsNewStorageKey(userId), JSON.stringify({ seen: state.seen, opened: state.opened }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Прочитать — изменить — записать. Окно и меню правят одну запись независимо,
 * поэтому каждый берёт свежее состояние из хранилища, а не свою копию:
 * иначе «закрыл окно» затирало бы «открыл раздел» и наоборот.
 */
export function updateWhatsNewState(
  userId: string,
  change: (state: WhatsNewState) => WhatsNewState,
  storage: Storage | null = defaultStorage(),
): WhatsNewState {
  const current = readWhatsNewState(userId, storage);
  const next = change(current);
  if (next !== current) writeWhatsNewState(userId, next, storage);
  return next;
}

/** День создания аккаунта (YYYY-MM-DD, UTC) или null, если дата неизвестна или нечитаема. */
function accountDay(userCreatedAt: string | null | undefined): string | null {
  if (!userCreatedAt) return null;
  const time = Date.parse(userCreatedAt);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

/**
 * Записи, которые относятся к этому аккаунту: новости, вышедшие ДО регистрации,
 * отброшены — только что пришедшему человеку всё внове, старые новости ему ни к чему.
 * Дата регистрации неизвестна (null) — показываем всё.
 */
export function entriesForAccount(
  userCreatedAt: string | null | undefined,
  entries: readonly WhatsNewEntry[] = WHATS_NEW,
): WhatsNewEntry[] {
  const created = accountDay(userCreatedAt);
  return created ? entries.filter(entry => entry.date >= created) : [...entries];
}

/** Что показать в окне: записи для этого аккаунта, окно с которыми ещё не закрывали. */
export function unseenEntries(
  state: WhatsNewState,
  userCreatedAt: string | null,
  entries: readonly WhatsNewEntry[] = WHATS_NEW,
): WhatsNewEntry[] {
  return entriesForAccount(userCreatedAt, entries).filter(entry => !state.seen.includes(entry.id));
}

/** Самая свежая запись о разделе (по дате; при равной — та, что выше в списке). */
function latestEntryFor(path: string, entries: readonly WhatsNewEntry[]): WhatsNewEntry | null {
  let latest: WhatsNewEntry | null = null;
  for (const entry of entries) {
    if (!entry.sections.includes(path)) continue;
    if (!latest || entry.date > latest.date) latest = entry;
  }
  return latest;
}

/** Полночь дня записи по местному времени; нечитаемая дата — NaN. */
function entryDayStart(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : Number.NaN;
}

/**
 * Разделы с меткой «new»: о разделе есть запись, которую он ещё не «видел»
 * (после неё раздел не открывали), и ей не больше NEW_SECTION_DAYS дней.
 */
export function newSections(
  state: WhatsNewState,
  now: Date,
  entries: readonly WhatsNewEntry[] = WHATS_NEW,
): Set<string> {
  const result = new Set<string>();
  const limit = NEW_SECTION_DAYS * 24 * 60 * 60 * 1000;
  for (const path of new Set(entries.flatMap(entry => entry.sections))) {
    const latest = latestEntryFor(path, entries);
    if (!latest || state.opened[path] === latest.id) continue;
    const age = now.getTime() - entryDayStart(latest.date);
    // NaN (нечитаемая дата) сравнение не проходит — такую запись меткой не отмечаем.
    if (age <= limit) result.add(path);
  }
  return result;
}

/** Окно закрыли: эти записи больше не показывать. Без изменений возвращает то же состояние. */
export function markSeen(state: WhatsNewState, ids: readonly string[]): WhatsNewState {
  const added = ids.filter(id => !state.seen.includes(id));
  if (!added.length) return state;
  return { ...state, seen: [...state.seen, ...new Set(added)] };
}

/** Раздел открыли: метка снимается до следующей записи о нём. Без изменений возвращает то же состояние. */
export function markOpened(
  state: WhatsNewState,
  path: string,
  entries: readonly WhatsNewEntry[] = WHATS_NEW,
): WhatsNewState {
  const latest = latestEntryFor(path, entries);
  if (!latest || state.opened[path] === latest.id) return state;
  return { ...state, opened: { ...state.opened, [path]: latest.id } };
}

/**
 * Адрес внутри раздела: сам раздел или его вложенная страница (но не «/cabinet/staffing»).
 * exact — для «Обзора» (/cabinet): под ним лежит весь кабинет, поэтому считается только точный адрес.
 */
export function isInSection(pathname: string, section: string, exact = false): boolean {
  return pathname === section || (!exact && pathname.startsWith(`${section}/`));
}
