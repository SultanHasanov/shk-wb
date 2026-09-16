import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/** Выбор пользователя в галочке «Запомнить это устройство». */
const REMEMBER_KEY = 'shk-auth-remember';

function quiet(action: () => void) {
  try {
    action();
  } catch {
    // Приватный режим или запрет на site data — вход всё равно должен работать
  }
}

export function isDeviceRemembered(): boolean {
  try {
    return localStorage.getItem(REMEMBER_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * Запоминать устройство — значит держать сессию в localStorage: она переживает
 * закрытие браузера. Без галочки токены уезжают в sessionStorage и умирают
 * вместе со вкладкой — так вход на чужом компьютере не остаётся после ухода.
 */
export function setDeviceRemembered(remember: boolean) {
  quiet(() => {
    localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
    // Уже сохранённые токены переносим сразу, иначе выбор применился бы только
    // со следующего входа.
    const from = remember ? sessionStorage : localStorage;
    const to = remember ? localStorage : sessionStorage;
    for (const key of Object.keys(from)) {
      if (!key.startsWith('sb-')) continue;
      const value = from.getItem(key);
      if (value === null) continue;
      to.setItem(key, value);
      from.removeItem(key);
    }
  });
}

/* Одна запись живёт ровно в одном хранилище: при чтении сначала смотрим
   sessionStorage, чтобы «не запоминать» побеждало старую запись в localStorage. */
const authStorage = {
  getItem(key: string) {
    try {
      return sessionStorage.getItem(key) ?? localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string) {
    quiet(() => {
      if (isDeviceRemembered()) {
        localStorage.setItem(key, value);
        sessionStorage.removeItem(key);
      } else {
        sessionStorage.setItem(key, value);
        localStorage.removeItem(key);
      }
    });
  },
  removeItem(key: string) {
    quiet(() => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
  },
};

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error('Не настроены VITE_SUPABASE_URL и VITE_SUPABASE_PUBLISHABLE_KEY');
  }
  client = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: authStorage,
    },
  });
  return client;
}
