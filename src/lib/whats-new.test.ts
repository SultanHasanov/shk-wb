import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_WHATS_NEW_STATE,
  WHATS_NEW,
  entriesForAccount,
  isInSection,
  markOpened,
  markSeen,
  newSections,
  parseWhatsNewState,
  readWhatsNewState,
  unseenEntries,
  updateWhatsNewState,
  whatsNewStorageKey,
  writeWhatsNewState,
  type WhatsNewEntry,
} from './whats-new';

const entry = (id: string, date: string, sections: string[]): WhatsNewEntry => ({
  id,
  date,
  sections,
  title: [`Заголовок ${id}`, `Тақырып ${id}`],
  items: [['Пункт', 'Тармақ']],
});

const STAFF = entry('staff-1', '2026-11-17', ['/cabinet/staff']);
const ENTRIES = [STAFF];
const OLD_ACCOUNT = '2026-08-01T10:00:00Z';

beforeEach(() => localStorage.clear());

describe('записи «Что нового»', () => {
  it('у каждой записи свой id, дата YYYY-MM-DD и оба языка; новые сверху', () => {
    expect(new Set(WHATS_NEW.map(e => e.id)).size).toBe(WHATS_NEW.length);
    for (const e of WHATS_NEW) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.title[0]).toBeTruthy();
      expect(e.title[1]).toBeTruthy();
      expect(e.items.length).toBeGreaterThan(0);
      for (const [ru, kz] of e.items) {
        expect(ru).toBeTruthy();
        expect(kz).toBeTruthy();
      }
      for (const path of e.sections) expect(path).toMatch(/^\/cabinet(\/|$)/);
    }
    const dates = WHATS_NEW.map(e => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});

describe('unseenEntries — что показать в окне', () => {
  it('новый аккаунт не видит новость, вышедшую до регистрации', () => {
    expect(unseenEntries(EMPTY_WHATS_NEW_STATE, '2026-11-18T09:00:00Z', ENTRIES)).toEqual([]);
    expect(entriesForAccount('2026-11-18T09:00:00Z', ENTRIES)).toEqual([]);
  });

  it('аккаунт, созданный в день новости или раньше, её видит', () => {
    expect(unseenEntries(EMPTY_WHATS_NEW_STATE, '2026-11-17T23:10:00Z', ENTRIES)).toEqual([STAFF]);
    expect(unseenEntries(EMPTY_WHATS_NEW_STATE, OLD_ACCOUNT, ENTRIES)).toEqual([STAFF]);
  });

  it('дата регистрации неизвестна или нечитаема — показываем', () => {
    expect(unseenEntries(EMPTY_WHATS_NEW_STATE, null, ENTRIES)).toEqual([STAFF]);
    expect(unseenEntries(EMPTY_WHATS_NEW_STATE, 'не дата', ENTRIES)).toEqual([STAFF]);
  });

  it('старый аккаунт видит новость один раз: после закрытия окна её нет', () => {
    const first = unseenEntries(EMPTY_WHATS_NEW_STATE, OLD_ACCOUNT, ENTRIES);
    expect(first).toEqual([STAFF]);
    const seen = markSeen(EMPTY_WHATS_NEW_STATE, first.map(e => e.id));
    expect(unseenEntries(seen, OLD_ACCOUNT, ENTRIES)).toEqual([]);
  });

  it('следующая новость показывается, прочитанная — нет', () => {
    const next = entry('staff-2', '2026-12-01', ['/cabinet/staff']);
    const seen = markSeen(EMPTY_WHATS_NEW_STATE, ['staff-1']);
    expect(unseenEntries(seen, OLD_ACCOUNT, [next, STAFF])).toEqual([next]);
  });

  it('markSeen не дублирует id и не создаёт новое состояние без изменений', () => {
    const seen = markSeen(EMPTY_WHATS_NEW_STATE, ['a', 'a', 'b']);
    expect(seen.seen).toEqual(['a', 'b']);
    expect(markSeen(seen, ['a'])).toBe(seen);
    expect(EMPTY_WHATS_NEW_STATE.seen).toEqual([]);
  });
});

describe('newSections — метка «new» у раздела', () => {
  const day = (d: number, h = 12) => new Date(2026, 10, d, h);

  it('раздел остаётся новым, пока его не открыли, — даже если окно уже закрыто', () => {
    const seen = markSeen(EMPTY_WHATS_NEW_STATE, ['staff-1']);
    expect([...newSections(seen, day(18), ENTRIES)]).toEqual(['/cabinet/staff']);
    expect([...newSections(seen, day(25), ENTRIES)]).toEqual(['/cabinet/staff']);
  });

  it('после открытия раздела метки нет, остальное состояние цело', () => {
    const seen = markSeen(EMPTY_WHATS_NEW_STATE, ['staff-1']);
    const opened = markOpened(seen, '/cabinet/staff', ENTRIES);
    expect(opened.opened).toEqual({ '/cabinet/staff': 'staff-1' });
    expect(opened.seen).toEqual(['staff-1']);
    expect(newSections(opened, day(18), ENTRIES).size).toBe(0);
    expect(markOpened(opened, '/cabinet/staff', ENTRIES)).toBe(opened);
  });

  it('метка гаснет сама через 14 дней', () => {
    // 17 ноября + 14 дней = 1 декабря 00:00 — последний момент с меткой
    expect(newSections(EMPTY_WHATS_NEW_STATE, new Date(2026, 11, 1, 0, 0), ENTRIES).has('/cabinet/staff')).toBe(true);
    expect(newSections(EMPTY_WHATS_NEW_STATE, new Date(2026, 11, 1, 0, 1), ENTRIES).size).toBe(0);
    expect(newSections(EMPTY_WHATS_NEW_STATE, new Date(2027, 0, 15), ENTRIES).size).toBe(0);
  });

  it('новая запись о разделе снова помечает его, хотя прошлую уже открывали', () => {
    const next = entry('staff-2', '2026-12-01', ['/cabinet/staff']);
    const opened = markOpened(EMPTY_WHATS_NEW_STATE, '/cabinet/staff', ENTRIES);
    expect(newSections(opened, new Date(2026, 11, 2), [next, STAFF]).has('/cabinet/staff')).toBe(true);
    const reopened = markOpened(opened, '/cabinet/staff', [next, STAFF]);
    expect(reopened.opened['/cabinet/staff']).toBe('staff-2');
    expect(newSections(reopened, new Date(2026, 11, 2), [next, STAFF]).size).toBe(0);
  });

  it('помечает только разделы из записей; раздел без записи открыть — ничего не меняет', () => {
    const both = entry('two', '2026-11-17', ['/cabinet/staff', '/cabinet/access']);
    expect([...newSections(EMPTY_WHATS_NEW_STATE, day(18), [both])].sort()).toEqual(['/cabinet/access', '/cabinet/staff']);
    const opened = markOpened(EMPTY_WHATS_NEW_STATE, '/cabinet/staff', [both]);
    expect([...newSections(opened, day(18), [both])]).toEqual(['/cabinet/access']);
    expect(markOpened(EMPTY_WHATS_NEW_STATE, '/cabinet/keys', [both])).toBe(EMPTY_WHATS_NEW_STATE);
  });

  it('запись с нечитаемой датой меткой не отмечается', () => {
    expect(newSections(EMPTY_WHATS_NEW_STATE, day(18), [entry('bad', 'вчера', ['/cabinet/staff'])]).size).toBe(0);
  });
});

describe('isInSection', () => {
  it('раздел и его вложенные страницы, но не похожий адрес', () => {
    expect(isInSection('/cabinet/staff', '/cabinet/staff')).toBe(true);
    expect(isInSection('/cabinet/staff/payroll', '/cabinet/staff')).toBe(true);
    expect(isInSection('/cabinet/staffing', '/cabinet/staff')).toBe(false);
    expect(isInSection('/cabinet', '/cabinet/staff')).toBe(false);
  });

  it('exact: «Обзор» не считается открытым на любой странице кабинета', () => {
    expect(isInSection('/cabinet/staff', '/cabinet', true)).toBe(false);
    expect(isInSection('/cabinet', '/cabinet', true)).toBe(true);
  });
});

describe('хранение в localStorage', () => {
  it('ключ содержит id пользователя, запись читается обратно', () => {
    expect(whatsNewStorageKey('u1')).toBe('cabinet_whats_new_v1_u1');
    const state = markOpened(markSeen(EMPTY_WHATS_NEW_STATE, ['staff-1']), '/cabinet/staff', ENTRIES);
    expect(writeWhatsNewState('u1', state)).toBe(true);
    expect(JSON.parse(localStorage.getItem('cabinet_whats_new_v1_u1')!)).toEqual({
      seen: ['staff-1'],
      opened: { '/cabinet/staff': 'staff-1' },
    });
    expect(readWhatsNewState('u1')).toEqual(state);
    // у другого аккаунта в том же браузере своя запись
    expect(readWhatsNewState('u2')).toEqual(EMPTY_WHATS_NEW_STATE);
  });

  it('битый JSON и чужой формат не роняют кабинет — состояние пустое', () => {
    for (const raw of ['{"seen":[', 'null', '42', '"строка"', '[]', '{"seen":"x","opened":[1]}']) {
      localStorage.setItem('cabinet_whats_new_v1_u1', raw);
      expect(readWhatsNewState('u1')).toEqual(EMPTY_WHATS_NEW_STATE);
    }
    expect(parseWhatsNewState('{"seen":["a",1,null],"opened":{"/cabinet/staff":"a","/x":5}}')).toEqual({
      seen: ['a'],
      opened: { '/cabinet/staff': 'a' },
    });
    // после битой записи новость показывается заново, а не теряется
    localStorage.setItem('cabinet_whats_new_v1_u1', '{oops');
    expect(unseenEntries(readWhatsNewState('u1'), OLD_ACCOUNT, ENTRIES)).toEqual([STAFF]);
  });

  it('хранилище бросает исключения (приватное окно) — чтение и запись не падают', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;
    expect(readWhatsNewState('u1', broken)).toEqual(EMPTY_WHATS_NEW_STATE);
    expect(writeWhatsNewState('u1', EMPTY_WHATS_NEW_STATE, broken)).toBe(false);
    expect(updateWhatsNewState('u1', s => markSeen(s, ['staff-1']), broken).seen).toEqual(['staff-1']);
    expect(writeWhatsNewState('u1', EMPTY_WHATS_NEW_STATE, null)).toBe(false);
  });

  it('updateWhatsNewState берёт свежую запись: «закрыл окно» и «открыл раздел» не затирают друг друга', () => {
    updateWhatsNewState('u1', s => markSeen(s, ['staff-1']));
    updateWhatsNewState('u1', s => markOpened(s, '/cabinet/staff', ENTRIES));
    expect(readWhatsNewState('u1')).toEqual({ seen: ['staff-1'], opened: { '/cabinet/staff': 'staff-1' } });
  });
});
