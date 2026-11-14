// Черновик конструктора QR (кабинет → «Отзывы клиентов» → QR-коды). Владелец мог случайно закрыть вкладку,
// обновить страницу или уйти привязывать Telegram — несохранённые правки ждут его в этом браузере.
// Ключ — аккаунт + QR (или «new» для ещё не созданного), чтобы черновики разных QR и людей не смешивались.
// Хранилище может быть недоступно (приватный режим, запрет cookies) — тогда просто работаем без черновика.

const PREFIX = 'shk:feedback-draft:';
const TTL_MS = 30 * 86400000;

export type Draft<T> = { value: T; savedAt: number };

export function draftKey(userId: string, boardId: string | null) {
  return `${PREFIX}${userId}:${boardId ?? 'new'}`;
}

export function readDraft<T>(key: string): Draft<T> | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Draft<T>;
    if (!parsed || typeof parsed.savedAt !== 'number' || !parsed.value) return null;
    if (Date.now() - parsed.savedAt > TTL_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeDraft<T>(key: string, value: T) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ value, savedAt: Date.now() }));
  } catch {
    /* хранилище недоступно — без черновика */
  }
}

export function clearDraft(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* нечего чистить */
  }
}

/** Глубокое сравнение простых значений формы (строки, числа, булевы, вложенные объекты). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(k => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
