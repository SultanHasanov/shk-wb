import { useCallback, useEffect, useRef, useState } from 'react';

/** Текст ошибки для окна: сообщение сервера (AdminApiError) или запасное. */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Не удалось выполнить действие';
}

/**
 * Общая механика окон подтверждения:
 * - пока промис идёт — pending, повторный вызов игнорируется (двойной клик,
 *   Enter + клик) — иначе деньги или сообщение ушли бы дважды;
 * - ошибка — текст в окне, окно не закрывается;
 * - успех — закрытие.
 * Состояние сбрасывается при каждом открытии.
 */
export function useConfirmAction(open: boolean, onOpenChange: (open: boolean) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (open) {
      setError(null);
      setPending(false);
      busy.current = false;
    }
  }, [open]);

  const run = useCallback(
    async (work: () => Promise<unknown> | void) => {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      setError(null);
      try {
        await work();
        if (mounted.current) onOpenChange(false);
      } catch (err) {
        if (mounted.current) setError(errorText(err));
      } finally {
        busy.current = false;
        if (mounted.current) setPending(false);
      }
    },
    [onOpenChange],
  );

  /** Закрытие крестиком/фоном/Esc, пока запрос идёт, не даём: исход потерялся бы. */
  const guardedOpenChange = useCallback(
    (next: boolean) => {
      if (!next && busy.current) return;
      onOpenChange(next);
    },
    [onOpenChange],
  );

  return { pending, error, run, guardedOpenChange };
}

function randomKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* старый браузер или небезопасный контекст — ниже запасной вариант */
  }
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Новый ключ повтора (контракт 0.3): формат проходит /^[A-Za-z0-9_-]{8,80}$/. */
export function newIdempotencyKey(): string {
  return randomKey();
}

/**
 * Ключ повтора, который создаётся при каждом открытии окна и живёт, пока окно
 * открыто: повторная отправка той же формы после сбоя сети не задвоит действие.
 */
export function useIdempotencyKey(open: boolean): string {
  const [key, setKey] = useState(() => randomKey());
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) setKey(randomKey());
    wasOpen.current = open;
  }, [open]);
  return key;
}
